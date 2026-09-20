/**
 * MediaRecorder, writing to disk as it goes.
 *
 * THE TIMESLICE IS THE POINT. `recorder.start(RECORD_SLICE_MS)` makes
 * `dataavailable` fire every few seconds with a self-contained piece, and each
 * piece is written to IndexedDB before the next one arrives. Without a
 * timeslice, MediaRecorder holds the entire recording in memory and hands it
 * over at `stop()` — so a phone that is locked, backgrounded, or killed by the
 * operating system during a five-minute walk loses the whole thing. With one,
 * it loses at most the last slice.
 *
 * FOUR SECONDS, AND WHY NOT ONE OR THIRTY. Each piece is an IndexedDB write of
 * several megabytes, and at one second that is a write every second competing
 * with the analyser for the same phone. At thirty, a kill costs half a minute
 * of a room. Four is about 6 MB at a phone's usual bitrate, which is also the
 * chunk the uploader sends — so the pieces line up with the PATCHes and most
 * slices are read back exactly once, whole.
 *
 * WHAT THIS CANNOT DO, AND SAYS SO. On iOS, a Safari tab that is backgrounded
 * or a phone that is locked STOPS the capture: the page is suspended, the
 * camera track ends, and MediaRecorder stops receiving frames. There is no API
 * that changes this — no background mode exists for a web page, and a service
 * worker cannot hold a MediaStream. So the app warns before recording starts,
 * in words, and `onInterrupted` fires the moment the track ends so the screen
 * can say what happened rather than showing a timer that has quietly stopped.
 *
 * THE CODEC IS WHATEVER THE DEVICE HAS. `isTypeSupported` is consulted in
 * preference order and the winner is recorded in the manifest, because the
 * object's file extension and the `contentType` sent to storage both have to
 * match what was actually produced. Safari gives mp4 and Chrome gives webm;
 * guessing either would mislabel half the captures.
 */

import { extensionForMime } from './api/captures.js';

/** Milliseconds per piece. See the header for why four seconds. */
export const RECORD_SLICE_MS = 4000;

/**
 * Bitrate asked for.
 *
 * 24 Mbit/s is high for a phone and deliberately so: the pipeline's first
 * stage measures blur with variance of the Laplacian, and compression
 * artefacts at a low bitrate destroy exactly the high-frequency detail that
 * measurement depends on. A walkthrough compressed to 6 Mbit/s reads as
 * blurred to `mark_blur` even when the camera was in focus, which would tell
 * an operator to walk slower for a problem walking slower cannot fix. At 24
 * Mbit/s a five-minute walk is about 900 MB, well inside the bucket's 5 GiB.
 *
 * It is a REQUEST. Browsers clamp it and some ignore it entirely, which is why
 * the actual file size is measured rather than predicted.
 */
export const VIDEO_BITS_PER_SECOND = 24_000_000;

/**
 * Container and codec preferences, best first.
 *
 * VP9 before VP8 because at the same bitrate it keeps more of the detail the
 * blur measurement reads. H.264 in mp4 is Safari's only option and is last
 * only because it is not offered anywhere the others are.
 */
const MIME_PREFERENCES: readonly string[] = [
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
  'video/mp4;codecs=h264',
  'video/mp4',
];

export function chooseMimeType(): string | null {
  if (typeof MediaRecorder === 'undefined') return null;
  for (const candidate of MIME_PREFERENCES) {
    if (MediaRecorder.isTypeSupported(candidate)) return candidate;
  }
  // An empty string means "the browser picks", which MediaRecorder accepts.
  // Returning null instead, because a recording whose container this app
  // cannot name is a recording it cannot give the right file extension, and
  // ingest can sniff a container but cannot un-see a wrong suffix.
  return null;
}

export interface RecorderEvents {
  /** A piece arrived. Awaited, so the write happens before the next one. */
  readonly onChunk: (index: number, blob: Blob) => Promise<void>;
  /** The camera track ended on its own: backgrounded, locked, or unplugged. */
  readonly onInterrupted: (reason: string) => void;
  readonly onFailure: (message: string) => void;
}

export interface RecorderFacts {
  readonly mimeType: string;
  readonly extension: string;
}

/**
 * A recording in progress.
 *
 * Deliberately has no pause. MediaRecorder's `pause()` produces a file with a
 * timeline discontinuity in it, and the pipeline's pose stage reads the
 * sequence as a continuous camera path — a jump cut in the middle of a hallway
 * is a pose graph that fractures there. An operator who needs to stop should
 * stop, and walk the room again.
 */
export class Recording {
  private readonly recorder: MediaRecorder;
  private readonly events: RecorderEvents;
  private readonly track: MediaStreamTrack;
  private index = 0;
  private stopped = false;
  private startedAtMs = 0;
  private endedAtMs = 0;
  /**
   * Writes are chained rather than fired in parallel.
   *
   * Two IndexedDB puts of several megabytes racing each other on a phone that
   * is also running the analyser is how a write gets abandoned mid-transaction,
   * and a missing piece is a hole in the video. The chain costs nothing: the
   * slices arrive four seconds apart.
   */
  private writes: Promise<void> = Promise.resolve();
  private writeFailed: Error | null = null;

  readonly facts: RecorderFacts;

  constructor(stream: MediaStream, mimeType: string, events: RecorderEvents) {
    this.events = events;
    const track = stream.getVideoTracks()[0];
    if (!track) throw new Error('There is no camera track to record.');
    this.track = track;
    this.facts = { mimeType, extension: extensionForMime(mimeType) };
    this.recorder = new MediaRecorder(stream, {
      mimeType,
      videoBitsPerSecond: VIDEO_BITS_PER_SECOND,
    });
    this.recorder.ondataavailable = this.onData;
    this.recorder.onerror = (event: Event) => {
      const err = (event as Event & { error?: DOMException }).error;
      this.events.onFailure(
        `The recorder stopped: ${err?.message ?? 'no reason given'}. Anything already recorded is `
        + 'still saved on this phone.');
    };
    this.track.addEventListener('ended', this.onTrackEnded);
  }

  get pieces(): number { return this.index; }
  get isRecording(): boolean { return this.recorder.state === 'recording'; }

  /** Seconds since start, from a monotonic clock rather than a frame count. */
  elapsedS(nowMs: number): number {
    if (this.startedAtMs === 0) return 0;
    const end = this.endedAtMs > 0 ? this.endedAtMs : nowMs;
    return Math.max(0, (end - this.startedAtMs) / 1000);
  }

  start(nowMs: number): void {
    this.startedAtMs = nowMs;
    this.recorder.start(RECORD_SLICE_MS);
  }

  /**
   * Stop, and wait for every piece to be on disk.
   *
   * Resolving before the last write lands would let the verdict screen appear
   * over a recording that is one slice short, and the shortfall would not be
   * discovered until the ledger refused to build.
   */
  async stop(nowMs: number): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.endedAtMs = nowMs;
    this.track.removeEventListener('ended', this.onTrackEnded);
    const finished = new Promise<void>((resolve) => {
      this.recorder.onstop = () => resolve();
    });
    if (this.recorder.state !== 'inactive') this.recorder.stop();
    await finished;
    await this.writes;
    if (this.writeFailed) throw this.writeFailed;
  }

  private readonly onData = (event: BlobEvent): void => {
    if (event.data.size === 0) return;
    const index = this.index;
    this.index += 1;
    const blob = event.data;
    this.writes = this.writes.then(async () => {
      try {
        await this.events.onChunk(index, blob);
      } catch (err) {
        // Recorded and then not saved is the worst of the failure modes,
        // because the timer on screen keeps counting. It is raised
        // immediately, and remembered so `stop` cannot report success.
        const error = err instanceof Error ? err : new Error(String(err));
        this.writeFailed ??= error;
        this.events.onFailure(
          `A piece of the recording could not be saved on this phone: ${error.message}. Stop and `
          + 'check the storage on the device before walking any further.');
      }
    });
  };

  private readonly onTrackEnded = (): void => {
    this.events.onInterrupted(
      'The camera stopped. On iPhone this happens when the screen locks or you switch to another '
      + 'app: the page is suspended and recording cannot continue in the background. Everything '
      + 'up to this point has been saved.');
  };
}

/**
 * The warning shown before recording starts.
 *
 * Kept here, next to the limitation it describes, so the two cannot drift
 * apart. It is shown to everyone rather than only to iOS: a Chrome tab that is
 * backgrounded on Android throttles timers and can have its camera revoked
 * too, and an operator who has learnt "do not leave the app" on one phone
 * should not have to relearn it on another.
 */
export const BACKGROUND_WARNING =
  'Keep this screen on and stay in this app. If the phone locks or you switch to another app, '
  + 'recording stops — on iPhone it always does, and there is no way for a web page to keep the '
  + 'camera running in the background. Everything recorded up to that point is saved, but the '
  + 'rest of the property is not.';
