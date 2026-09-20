/**
 * The camera, and the loop that feeds the analyser.
 *
 * WHAT IS ASKED OF getUserMedia, AND WHY.
 *   `facingMode: { ideal: 'environment' }` — ideal rather than exact. On a
 *   laptop or a tablet with one camera, `exact` fails the whole request and
 *   the operator gets a permission error instead of a preview; `ideal` gets
 *   the rear camera where there is one and something usable where there is
 *   not.
 *   `width/height: { ideal: 3840 x 2160 }` — the pipeline refuses anything
 *   under 1080 on the SHORT edge (ingest.py MIN_SHORT_EDGE) and pose error
 *   roughly doubles below it, so the app asks for the most the device will
 *   give and reports what it actually got. A constraint that FAILS would be
 *   worse than one that is not met: a phone that cannot do 4K would refuse
 *   rather than hand back 1080.
 *   No `frameRate` constraint. Asking for 60 on a phone in a dim hallway gets
 *   a camera that raises ISO to hold the rate, and noise is the one thing
 *   variance-of-the-Laplacian mistakes for detail.
 *
 * WHY THE PIXELS ARE PULLED WITH requestVideoFrameCallback WHERE IT EXISTS.
 * A timer fires on the page's schedule and the camera delivers on its own, so
 * a timer-driven grab regularly reads the same decoded frame twice — and two
 * identical frames measure as zero motion, which the analyser reads as an
 * operator standing still. `requestVideoFrameCallback` fires once per decoded
 * frame, so every grab is a frame that was not grabbed before. Firefox and
 * older WebKit do not have it, and there the timer is the honest fallback with
 * its limitation written down rather than hidden.
 *
 * WHY THE BUFFER IS TRANSFERRED. A 1080p RGBA frame is 8.3 MB. Copying one ten
 * times a second is 83 MB/s of allocation, and the resulting collector pauses
 * appear to `PaceController` as a device that has slowed down — so the app
 * would throttle its own analysis because of its own garbage. `getImageData`
 * hands back a fresh buffer each call, which is exactly what a transfer needs.
 */

import { FramePacer, captureResolution } from './frames.js';
import { decodeFromWorker, isStaleResult, type FromWorker, type ToWorker } from './worker/protocol.js';

/** What `getUserMedia` actually gave, as opposed to what was asked for. */
export interface CameraFacts {
  readonly width: number;
  readonly height: number;
  /** The track's own reported rate. Advisory: see `FramePacer`. */
  readonly fps: number;
  readonly deviceLabel: string;
}

export interface CameraHandles {
  readonly stream: MediaStream;
  readonly video: HTMLVideoElement;
  readonly facts: CameraFacts;
}

/**
 * Open the rear camera at the best resolution the device will give.
 *
 * Every failure mode gets its own sentence, because "NotAllowedError" on a
 * phone screen in somebody's hallway is not something an operator can act on
 * and "the camera is already in use by another app" is.
 */
export async function openCamera(): Promise<CameraHandles> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error(
      'This browser will not give the page a camera. On iPhone this usually means the page is '
      + 'not on https, or it is open inside another app rather than in Safari.');
  }
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 3840 },
        height: { ideal: 2160 },
      },
      // The pipeline does not use the audio, and an operator narrating a
      // stranger's home records their voice and whoever else is in it. Off.
      audio: false,
    });
  } catch (err) {
    throw new Error(describeCameraError(err));
  }

  const track = stream.getVideoTracks()[0];
  if (!track) {
    stream.getTracks().forEach((t) => t.stop());
    throw new Error('The camera opened but produced no video track.');
  }
  const settings = track.getSettings();

  const video = document.createElement('video');
  video.className = 'c-preview';
  video.playsInline = true;
  video.muted = true;
  video.setAttribute('aria-hidden', 'true');
  video.srcObject = stream;
  await video.play();

  return {
    stream,
    video,
    facts: {
      // The track's settings can lag the first decoded frame, so the video
      // element's own dimensions win where it has them: those are the size of
      // the pixels that will actually be analysed and recorded.
      width: video.videoWidth || settings.width || 0,
      height: video.videoHeight || settings.height || 0,
      fps: settings.frameRate ?? 0,
      deviceLabel: track.label,
    },
  };
}

function describeCameraError(err: unknown): string {
  const name = err instanceof Error ? err.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'The camera was refused. Allow camera access for this site in the browser settings, '
      + 'then reload — on iPhone that is aA in the address bar, then Website Settings.';
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return 'No camera on this device could be opened for the walkthrough.';
  }
  if (name === 'NotReadableError' || name === 'AbortError') {
    return 'The camera is already in use. Close the other app that has it and try again.';
  }
  return err instanceof Error && err.message
    ? `The camera could not be opened: ${err.message}`
    : 'The camera could not be opened.';
}

/**
 * `requestVideoFrameCallback` is declared as a REQUIRED member of
 * HTMLVideoElement by the DOM lib, and it is absent on Firefox and on older
 * WebKit. Re-declaring it as optional is not possible without conflicting with
 * that declaration, so the presence check is a `typeof` at every use site
 * instead — which is what actually runs on the device anyway.
 */
export interface LoopEvents {
  readonly onMessage: (message: FromWorker) => void;
  /** Raised when the loop itself cannot continue. Never swallowed. */
  readonly onFailure: (message: string) => void;
}

/**
 * Pulls frames, converts them, and hands them to the worker.
 *
 * Owns the pacer, the canvas and the sequence number; owns neither the worker
 * nor the camera, because both outlive a paused loop.
 */
export class AnalysisLoop {
  readonly pacer = new FramePacer();
  private readonly video: HTMLVideoElement;
  private readonly worker: Worker;
  private readonly events: LoopEvents;
  private readonly startedAt: number;
  private canvas: HTMLCanvasElement | OffscreenCanvas | null = null;
  private ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null = null;
  private running = false;
  private rvfcHandle: number | null = null;
  private timerHandle: ReturnType<typeof setTimeout> | null = null;
  private seq = 0;
  private lastAppliedSeq = -1;
  private intervalMs = 100;
  private busy = false;
  private readonly elapsed: number[] = [];
  /** When each in-flight frame was grabbed, so the round trip can be timed. */
  private readonly pendingStartedAt = new Map<number, number>();

  constructor(video: HTMLVideoElement, worker: Worker, events: LoopEvents, startedAt: number) {
    this.video = video;
    this.worker = worker;
    this.events = events;
    this.startedAt = startedAt;
    this.worker.addEventListener('message', this.receive);
    this.worker.addEventListener('error', this.workerBroke);
  }

  /** True when this device has per-decoded-frame callbacks. */
  get hasFrameCallback(): boolean {
    return typeof this.video.requestVideoFrameCallback === 'function';
  }

  /** Median of the last twenty whole-frame costs, worker round trip included. */
  get medianElapsedMs(): number {
    if (this.elapsed.length === 0) return 0;
    const sorted = this.elapsed.slice().sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  }

  get targetIntervalMs(): number { return this.intervalMs; }

  send(message: ToWorker, transfer?: Transferable[]): void {
    this.worker.postMessage(message, transfer ?? []);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule();
  }

  stop(): void {
    this.running = false;
    if (this.rvfcHandle !== null && typeof this.video.cancelVideoFrameCallback === 'function') {
      this.video.cancelVideoFrameCallback(this.rvfcHandle);
    }
    this.rvfcHandle = null;
    if (this.timerHandle !== null) clearTimeout(this.timerHandle);
    this.timerHandle = null;
  }

  dispose(): void {
    this.stop();
    this.worker.removeEventListener('message', this.receive);
    this.worker.removeEventListener('error', this.workerBroke);
    this.worker.terminate();
  }

  private schedule(): void {
    if (!this.running) return;
    if (typeof this.video.requestVideoFrameCallback === 'function') {
      this.rvfcHandle = this.video.requestVideoFrameCallback((now) => {
        this.rvfcHandle = null;
        this.pacer.observeCallback(now);
        void this.tick(now);
        this.schedule();
      });
      return;
    }
    // Timer fallback. No `observeCallback`, deliberately: there is no camera
    // cadence being measured here, so the pacer's lead tolerance stays at zero
    // and the loop simply waits out the interval.
    const delay = this.pacer.nextDelayMs(this.clock(), this.intervalMs);
    this.timerHandle = setTimeout(() => {
      this.timerHandle = null;
      void this.tick(this.clock());
      this.schedule();
    }, delay);
  }

  private clock(): number {
    return typeof performance === 'object' ? performance.now() : Date.now();
  }

  private async tick(nowMs: number): Promise<void> {
    if (!this.running || this.busy) return;
    if (this.pacer.decide(nowMs, this.intervalMs).kind !== 'analyse') return;

    const source = { width: this.video.videoWidth, height: this.video.videoHeight };
    if (source.width === 0 || source.height === 0) return;
    // Source resolution, always. See frames.ts: the rate comes down when a
    // device is slow and the resolution does not.
    const size = captureResolution(source, {
      degraded: false, medianCostMs: this.medianElapsedMs,
    });

    this.busy = true;
    this.pacer.markDispatched(nowMs);
    const startedAt = this.clock();
    try {
      const pixels = await this.grab(size.width, size.height);
      this.seq += 1;
      this.send({
        type: 'frame',
        seq: this.seq,
        rgba: pixels.data,
        width: pixels.width,
        height: pixels.height,
        tMs: Math.max(0, nowMs - this.startedAt),
      }, [pixels.data.buffer]);
      this.pendingStartedAt.set(this.seq, startedAt);
    } catch (err) {
      // The frame could not be read. The analyser is not holding it, so the
      // in-flight count has to come back down or the loop stops for good.
      this.pacer.completed();
      this.events.onFailure(err instanceof Error ? err.message : String(err));
    } finally {
      this.busy = false;
    }
  }

  /**
   * One frame's pixels, as a fresh transferable buffer.
   *
   * `createImageBitmap` takes a snapshot of the frame that is on screen NOW.
   * Drawing the `<video>` element straight to the canvas would read whatever
   * frame had been decoded by the time the draw happened, which on a busy
   * thread is not the frame the callback was about.
   */
  private async grab(width: number, height: number): Promise<ImageData> {
    const ctx = this.context(width, height);
    const bitmap = await createImageBitmap(this.video);
    try {
      ctx.drawImage(bitmap as unknown as CanvasImageSource, 0, 0, width, height);
    } finally {
      bitmap.close();
    }
    return ctx.getImageData(0, 0, width, height);
  }

  private context(
    width: number, height: number,
  ): CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D {
    const existing = this.canvas;
    if (existing === null || existing.width !== width || existing.height !== height) {
      this.canvas = typeof OffscreenCanvas === 'function'
        ? new OffscreenCanvas(width, height)
        : Object.assign(document.createElement('canvas'), { width, height });
      // `willReadFrequently` moves the backing store to software on Chromium,
      // which is what this canvas wants: every single frame drawn here is read
      // straight back out, and a GPU-backed canvas pays a readback each time.
      const ctx = (this.canvas as HTMLCanvasElement).getContext('2d', { willReadFrequently: true });
      if (!ctx) throw new Error('This browser would not give the page a 2D canvas to read frames with.');
      this.ctx = ctx as CanvasRenderingContext2D;
    }
    if (this.ctx === null) throw new Error('The frame canvas is not available.');
    return this.ctx;
  }

  private readonly receive = (event: MessageEvent<unknown>): void => {
    const message = decodeFromWorker(event.data);
    if (message === null) {
      this.events.onFailure('The analyser sent a message this version of the app cannot read.');
      return;
    }
    if (message.type === 'result') {
      this.pacer.completed();
      this.intervalMs = message.intervalMs;
      const startedAt = this.pendingStartedAt.get(message.seq);
      this.pendingStartedAt.delete(message.seq);
      if (startedAt !== undefined) {
        this.elapsed.push(this.clock() - startedAt);
        if (this.elapsed.length > 20) this.elapsed.shift();
      }
      if (isStaleResult(message.seq, this.lastAppliedSeq)) return;
      this.lastAppliedSeq = message.seq;
    }
    if (message.type === 'error') this.pacer.completed();
    this.events.onMessage(message);
  };

  private readonly workerBroke = (event: ErrorEvent): void => {
    this.stop();
    this.events.onFailure(
      `The analyser stopped: ${event.message || 'no reason given'}. The recording is still `
      + 'running and is still being saved, but there is no guidance until you restart.');
  };
}
