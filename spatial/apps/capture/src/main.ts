/**
 * The capture app, wired up.
 *
 * Reads as a sequence because the operator's afternoon is a sequence: sign in
 * outside the property, pick it, list the rooms, walk it, read the go/no-go in
 * the hall, send it from the car. Every step below is one of those, and the
 * only state that survives a reload is the state that matters — the recording,
 * the upload offset and the session, all of which live in storage rather than
 * in this file.
 *
 * WHAT THIS FILE IS CAREFUL ABOUT.
 *
 *   The wake lock. A phone that dims and locks stops the recording, and no web
 *   page can record in the background. `navigator.wakeLock` is requested
 *   before the walk and re-requested when the page becomes visible again,
 *   because the lock is released on visibility change and is NOT automatically
 *   restored.
 *
 *   `beforeunload`. Only while there is something unsent. A dialog on every
 *   navigation trains people to dismiss it; a dialog at the one moment leaving
 *   costs an appointment is worth having.
 *
 *   Nothing is deleted without being asked. A recording stays on the phone
 *   until the operator says otherwise, including after a successful upload,
 *   because "successful" is a claim this app makes and the video is the only
 *   thing that cannot be made again.
 */

import './ui/styles.css';

import {
  VERDICT_MIN_ANALYSED_FRACTION,
  type CoverageSnapshot, type DeclaredSurface, type FrameResult, type Orientation,
  type VerdictInput, type VerdictReport,
} from '@m3xi/capture-core';

import { CAPTURE_BUCKET, isConfigured, readConfig } from './config.js';
import { SupabaseClient, credentialsFor } from './api/supabase.js';
import { TransportError } from './api/retry.js';
import { loadChoices } from './api/worlds.js';
import {
  captureObjectName, captureObjectPath, extensionForMime, registerCapture,
  type DeviceDescriptor,
} from './api/captures.js';
import { uploadRecording } from './api/upload.js';
import { CaptureStore, availableBytes, requestPersistence, uploadSourceFor, type CaptureManifest } from './store.js';
import { AnalysisLoop, openCamera, type CameraHandles } from './camera.js';
import { BACKGROUND_WARNING, Recording, chooseMimeType } from './recorder.js';
import { OrientationWatch, requestOrientation } from './orientation.js';
import { liveView, roomChips, overrunning } from './display.js';
import { defaultRooms, type DraftRoom } from './plan.js';
import { Store, initialState } from './state.js';
import { announcer, button, clear, el, note } from './ui/dom.js';
import { renderSignIn } from './screens/signin.js';
import { renderPick } from './screens/pick.js';
import { renderPlan, toPlannedRooms } from './screens/plan.js';
import { renderLive } from './screens/live.js';
import { renderVerdict } from './screens/verdict.js';
import { renderUpload } from './screens/upload.js';

const mount = document.getElementById('capture');
if (!mount) throw new Error('The capture app has no element to mount into.');

const voice = announcer();
document.body.appendChild(voice.node);

const config = readConfig();
const store = new Store(initialState());

/** Set while a walk is in progress or a recording is unsent. */
let unsentReason: string | null = null;

/** The resumable upload endpoint, set once the config is known to be complete. */
let uploadEndpoint = '';

window.addEventListener('beforeunload', (event: BeforeUnloadEvent) => {
  if (unsentReason === null) return;
  event.preventDefault();
  // Browsers no longer show custom text, but returnValue is still what makes
  // the dialog appear at all.
  event.returnValue = unsentReason;
});

/**
 * Register the installable shell's service worker.
 *
 * Scope `/capture/` explicitly, and the script is at `/capture/sw.js`, which is
 * inside it — so no `Service-Worker-Allowed` header and no change to
 * vercel.json is needed. A worker served from `/sw.js` would have been able to
 * control the whole of m3xi.com, which is not something a camera app should be
 * able to do. See public/capture/README.md, which owns those files.
 *
 * A failure is logged and swallowed. The shell is what makes the app
 * INSTALLABLE and openable without a network; it is not what makes it work,
 * and an operator standing at a front door should not be stopped by a cache
 * that could not register. What they would lose is the offline launch, and
 * they are about to be online enough to sign in anyway.
 */
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/capture/sw.js', { scope: '/capture/' })
    .catch((err: unknown) => {
      console.error('[capture] service worker registration failed', err);
    });
}

if (!isConfigured(config)) {
  // No fixture backend, on purpose: see config.ts. Every screen in this app
  // leads to a real upload, and a pretend one would let an operator walk a
  // property, see a tick, and have sent nothing anywhere.
  clear(mount);
  mount.appendChild(el('h1', {}, 'This app is not configured'));
  mount.appendChild(note('act',
    'No Supabase project is set for this deployment, so there is nowhere to send a walkthrough '
    + 'and nothing to file it against. Nothing here will work until that is fixed — do not go to '
    + 'a property with this build.', 'Stop'));
} else {
  // Narrowed once, here, so nothing further down has to assert it. `isConfigured`
  // is a type guard precisely so the endpoint is a string from this line on.
  uploadEndpoint = config.uploadEndpoint;
  void boot(new SupabaseClient(config.supabaseUrl, config.supabaseAnonKey));
}

async function boot(client: SupabaseClient): Promise<void> {
  let captureStore: CaptureStore;
  try {
    captureStore = await CaptureStore.open();
  } catch (err) {
    clear(mount!);
    mount!.appendChild(el('h1', {}, 'This phone cannot store a walkthrough'));
    mount!.appendChild(note('act', err instanceof Error ? err.message : String(err), 'Stop'));
    return;
  }

  const restored = client.restore();
  if (restored) store.set({ step: 'pick', email: restored.email });
  else store.set({ step: 'signin' });

  await showCurrent(client, captureStore);
}

// ---------------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------------

async function showCurrent(client: SupabaseClient, captureStore: CaptureStore): Promise<void> {
  const state = store.current;
  if (state.step === 'signin') return showSignIn(client, captureStore);
  if (state.step === 'pick') return showPick(client, captureStore);
  return undefined;
}

function swap(node: HTMLElement, live = false): void {
  clear(mount!);
  mount!.classList.toggle('is-live', live);
  mount!.appendChild(node);
}

function showSignIn(client: SupabaseClient, captureStore: CaptureStore): void {
  const screen = renderSignIn({
    initialProblem: store.current.problem,
    onSubmit: async (email, password) => {
      const session = await client.signIn(email, password);
      store.set({ step: 'pick', email: session.email, problem: null });
      await showPick(client, captureStore);
    },
  });
  swap(screen.root);
  screen.focus();
}

async function showPick(client: SupabaseClient, captureStore: CaptureStore): Promise<void> {
  swap(el('div', {}, el('h1', {}, 'Loading your properties'),
    el('p', { class: 'c-muted' }, 'This needs a connection. It is the only step that does.')));

  let choices: Awaited<ReturnType<typeof loadChoices>>;
  try {
    choices = await loadChoices(client);
  } catch (err) {
    if (err instanceof TransportError && err.status === 401) {
      store.set({ step: 'signin', problem: 'Your session has expired. Sign in again.' });
      showSignIn(client, captureStore);
      return;
    }
    const retry = el('div', {}, el('h1', {}, 'Could not load your properties'),
      note('act', err instanceof Error ? err.message : String(err), 'No list'),
      el('div', { class: 'c-actions' }, button({
        label: 'Try again', emphasis: 'primary', onClick: () => { void showPick(client, captureStore); },
      })));
    swap(retry);
    return;
  }

  // Anything recorded and not yet filed. Shown first, and loudly.
  const unfinished = (await captureStore.manifests()).filter((m) => m.registeredCaptureId === null);
  unsentReason = unfinished.length > 0
    ? 'A walkthrough on this phone has not been sent yet.'
    : null;
  store.set({ unfinished });

  const screen = renderPick({
    choices: choices.choices,
    truncated: choices.truncated,
    unfinished,
    email: store.current.email ?? '',
    onChoose: (property, world) => {
      store.set({ step: 'plan', chosen: { property, world }, rooms: defaultRooms() });
      showPlan(client, captureStore);
    },
    onResume: (manifest) => { void showUpload(client, captureStore, manifest); },
    onDiscard: (manifest) => {
      const ok = window.confirm(
        `Delete the walkthrough of ${manifest.propertyTitle}? It has not been sent, and it cannot `
        + 'be recovered. The only way to get it back is another appointment.');
      if (!ok) return;
      void captureStore.deleteCapture(manifest.captureId).then(() => showPick(client, captureStore));
    },
    onSignOut: () => {
      void client.signOut().then(() => {
        store.set({ step: 'signin', email: null, problem: null });
        showSignIn(client, captureStore);
      });
    },
  });
  swap(screen.root);
  screen.focus();
}

function showPlan(client: SupabaseClient, captureStore: CaptureStore): void {
  const chosen = store.current.chosen;
  if (!chosen) { void showPick(client, captureStore); return; }
  const screen = renderPlan({
    propertyTitle: chosen.property.title,
    worldVersion: chosen.world.version,
    rooms: store.current.rooms,
    onRoomsChange: (rooms: readonly DraftRoom[]) => {
      store.set({ rooms });
      showPlan(client, captureStore);
    },
    onStart: () => { void startWalk(client, captureStore); },
    onBack: () => {
      store.set({ step: 'pick', chosen: null });
      void showPick(client, captureStore);
    },
  });
  swap(screen.root);
  screen.focus();
}

// ---------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------

/**
 * Keep the screen awake for the duration.
 *
 * The lock is released by the browser on a visibility change and is not
 * restored, so the listener re-takes it. Failure is silent here and only here:
 * an operator who has been warned about backgrounding in words does not also
 * need a technical message about a lock they cannot do anything about.
 */
function keepAwake(): () => void {
  type WakeLock = { release(): Promise<void> };
  type WakeLockApi = { request(type: 'screen'): Promise<WakeLock> };
  const api = (navigator as Navigator & { wakeLock?: WakeLockApi }).wakeLock;
  if (!api) return () => undefined;
  let held: WakeLock | null = null;
  const take = (): void => { void api.request('screen').then((lock) => { held = lock; }).catch(() => undefined); };
  const onVisible = (): void => { if (document.visibilityState === 'visible') take(); };
  take();
  document.addEventListener('visibilitychange', onVisible);
  return () => {
    document.removeEventListener('visibilitychange', onVisible);
    void held?.release().catch(() => undefined);
  };
}

async function startWalk(client: SupabaseClient, captureStore: CaptureStore): Promise<void> {
  const chosen = store.current.chosen;
  if (!chosen) return;
  const rooms = store.current.rooms;

  const mimeType = chooseMimeType();
  if (mimeType === null) {
    store.set({ problem: null });
    swap(el('div', {}, el('h1', {}, 'This browser cannot record video'),
      note('act',
        'MediaRecorder is not available, or offers no container this app can name. Use Safari on '
        + 'iPhone or Chrome on Android. Do not walk the property on this device.', 'Stop'),
      el('div', { class: 'c-actions' }, button({
        label: 'Back', onClick: () => showPlan(client, captureStore),
      }))));
    return;
  }

  // The orientation permission must be asked for from inside the gesture that
  // got here. A refusal is a state, not a failure: the walk is valid without a
  // compass and the verdict says which measurement is missing.
  const orientationState = await requestOrientation();

  let camera: CameraHandles;
  try {
    camera = await openCamera();
  } catch (err) {
    swap(el('div', {}, el('h1', {}, 'The camera did not open'),
      note('act', err instanceof Error ? err.message : String(err), 'Stop'),
      el('div', { class: 'c-actions' }, button({
        label: 'Try again', emphasis: 'primary', onClick: () => { void startWalk(client, captureStore); },
      }), button({ label: 'Back', onClick: () => showPlan(client, captureStore) }))));
    return;
  }

  await requestPersistence();
  const free = await availableBytes();
  const releaseWake = keepAwake();

  const captureId = `cap-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const startedAtWall = Date.now();
  const startedAtClock = performance.now();

  const manifest: CaptureManifest = {
    captureId,
    worldId: chosen.world.worldId,
    propertyTitle: chosen.property.title,
    worldVersion: chosen.world.version,
    mimeType,
    startedAt: startedAtWall,
    durationS: null,
    recordedWidth: camera.facts.width,
    recordedHeight: camera.facts.height,
    recordedFps: camera.facts.fps,
    rooms: rooms.map((r) => ({ ...r })),
    registeredCaptureId: null,
  };
  await captureStore.putManifest(manifest);
  unsentReason = 'A walkthrough is being recorded and has not been sent.';

  const worker = new Worker(new URL('./worker/analysis.worker.ts', import.meta.url), {
    type: 'module',
  });

  let coverage: CoverageSnapshot | null = null;
  let lastResult: FrameResult | null = null;
  let verdictSeen: { input: VerdictInput; report: VerdictReport } | null = null;
  let orientationSample: Orientation | null = null;
  let currentRoom: string | null = null;
  let finished = false;

  const screen = renderLive({
    announce: (text) => voice.say(text),
    onDeclare: (kind: DeclaredSurface) => {
      if (currentRoom === null) {
        screen.showProblem('Tap the room you are in first, so the mirror is filed against it.');
        return;
      }
      loop.send({
        type: 'surface',
        kind,
        roomId: currentRoom,
        tMs: performance.now() - startedAtClock,
        by: store.current.email ?? 'unknown',
      });
    },
    onEnterRoom: (roomId) => {
      currentRoom = roomId;
      loop.send({ type: 'room', roomId, tMs: performance.now() - startedAtClock });
      const name = rooms.find((r) => r.id === roomId)?.name ?? roomId;
      voice.say(`In ${name}.`);
    },
    onFinish: () => { void finish(); },
  });

  const loop = new AnalysisLoop(camera.video, worker, {
    onMessage: (message) => {
      if (message.type === 'ready') { loop.start(); return; }
      if (message.type === 'error') {
        screen.showProblem(message.message);
        if (message.fatal) loop.stop();
        return;
      }
      if (message.type === 'coverage') {
        const input = message.input as VerdictInput;
        verdictSeen = { input, report: message.report as VerdictReport };
        // The chips and the dial read the snapshot, so it is taken when the
        // answer arrives rather than a second later on the next tick.
        coverage = input.coverage;
        paint();
        return;
      }
      lastResult = message.result;
      paint();
    },
    onFailure: (text) => screen.showProblem(text),
  }, startedAtClock);

  const orientation = new OrientationWatch(startedAtClock, (sample) => {
    orientationSample = sample;
    loop.send({ type: 'orientation', orientation: sample });
  });
  if (orientationState === 'granted') orientation.start();

  const recording = new Recording(camera.stream, mimeType, {
    onChunk: (index, blob) => captureStore.appendChunk(captureId, index, blob),
    onInterrupted: (reason) => {
      screen.showProblem(reason);
      voice.say('Recording stopped.');
      void finish();
    },
    onFailure: (text) => screen.showProblem(text),
  });

  loop.send({
    type: 'start',
    rooms: toPlannedRooms(rooms).map((r) => ({ ...r })),
    analysisHz: 10,
  });

  swap(screen.root, true);
  screen.mountPreview(camera.video);
  if (orientationState !== 'granted') {
    screen.showProblem(orientationState === 'denied'
      ? 'Compass access was refused, so walking and turning cannot be told apart. The walk is '
        + 'still valid; the final check will say that one measurement is missing.'
      : 'This device reports no compass, so walking and turning cannot be told apart.');
  }
  if (free !== null && free < 1_500_000_000) {
    screen.showProblem(
      `Only ${Math.round(free / 1_000_000)} MB of space is free on this phone. A five-minute walk `
      + 'needs about a gigabyte. Free some space before filming a large property.');
  }
  recording.start(performance.now());
  voice.say(BACKGROUND_WARNING);

  /** Repaint the live screen from the last frame. */
  function paint(): void {
    if (lastResult === null) return;
    const room = coverage?.rooms.find((r) => r.roomId === currentRoom) ?? null;
    const view = liveView(lastResult, orientation.hasSample ? orientationSample : null, room, {
      minAnalysedFraction: VERDICT_MIN_ANALYSED_FRACTION,
    });
    screen.update(
      view,
      roomChips(toPlannedRooms(rooms), coverage, currentRoom),
      recording.elapsedS(performance.now()),
    );
    // The session's own degraded flag does not include the RGBA-to-grey pass
    // the worker does before analysing (see worker/analysis.worker.ts), so the
    // measured round trip is checked independently and reported when it
    // disagrees. The operator is told something true either way.
    if (!view.degraded && overrunning(loop.medianElapsedMs, loop.targetIntervalMs)) {
      screen.showProblem(
        `Each frame is taking ${Math.round(loop.medianElapsedMs)} ms to check against a budget of `
        + `${Math.round(loop.targetIntervalMs)} ms. Walk slower: the guidance is thinner than the `
        + 'banner above says.');
    }
  }

  /**
   * A coverage refresh, once a second.
   *
   * The room chips and the yaw dial come from a `CoverageSnapshot`, which
   * `FrameResult` does not carry. Asking the worker for it on every frame
   * would serialise the whole coverage model ten times a second for a display
   * that changes once every few seconds.
   */
  const coverageTimer = setInterval(() => {
    if (finished) return;
    loop.send({
      type: 'verdict',
      recording: {
        width: camera.facts.width, height: camera.facts.height, fps: camera.facts.fps || 30,
      },
    });
  }, 1000);

  async function finish(): Promise<void> {
    if (finished) return;
    finished = true;
    clearInterval(coverageTimer);
    orientation.stop();
    releaseWake();

    swap(el('div', {}, el('h1', {}, 'Finishing'),
      el('p', {}, 'Saving the last few seconds. Do not close this.')));

    try {
      await recording.stop(performance.now());
    } catch (err) {
      screen.showProblem(err instanceof Error ? err.message : String(err));
    }

    // Ask for the final verdict AFTER the recorder has stopped, so the
    // duration the verdict is computed against is the duration that was
    // actually recorded.
    loop.send({
      type: 'verdict',
      recording: {
        width: camera.facts.width, height: camera.facts.height, fps: camera.facts.fps || 30,
      },
    });
    await new Promise<void>((resolve) => { setTimeout(resolve, 400); });

    loop.dispose();
    camera.stream.getTracks().forEach((track) => track.stop());

    const durationS = recording.elapsedS(performance.now());
    const finalManifest: CaptureManifest = { ...manifest, durationS };
    await captureStore.putManifest(finalManifest);

    if (verdictSeen === null) {
      // No verdict is a state to report, not one to invent a green tick for.
      swap(el('div', {}, el('h1', {}, 'The check did not finish'),
        note('act',
          'The analyser did not return a verdict, so there is nothing to tell you about the '
          + 'quality of this walk. The recording itself is saved and can still be sent.', 'No verdict'),
        el('div', { class: 'c-actions' },
          button({
            label: 'Send it anyway', emphasis: 'primary',
            onClick: () => { void showUpload(client, captureStore, finalManifest); },
          }))));
      return;
    }

    const outcome = verdictSeen;
    store.set({ step: 'verdict', manifest: finalManifest, verdict: outcome });
    showVerdict(client, captureStore, finalManifest, outcome.input, outcome.report,
      orientation.hasSample, loop);
  }
}

function showVerdict(
  client: SupabaseClient, captureStore: CaptureStore, manifest: CaptureManifest,
  input: VerdictInput, report: VerdictReport, hadOrientation: boolean, loop: AnalysisLoop,
): void {
  lastWalkFacts = {
    hadOrientation,
    analysisHz: loop.targetIntervalMs > 0 ? 1000 / loop.targetIntervalMs : 0,
    analysedFraction: input.analysis.fraction,
    frameCount: report.predictedFrames,
  };
  const screen = renderVerdict({
    report,
    input,
    onUpload: () => { void showUpload(client, captureStore, manifest); },
    onWalkAgain: () => {
      // The existing recording is KEPT. Two walkthroughs of one property are
      // two captures against the same world and the pipeline is happy with
      // both; throwing the first away to make room for a second would discard
      // the only footage of the rooms that were fine.
      store.set({ step: 'plan' });
      showPlan(client, captureStore);
    },
    onDiscard: () => {
      const ok = window.confirm(
        'Delete this recording? It has not been sent and cannot be recovered.');
      if (!ok) return;
      void captureStore.deleteCapture(manifest.captureId).then(() => {
        unsentReason = null;
        store.set({ step: 'pick' });
        void showPick(client, captureStore);
      });
    },
  });
  swap(screen.root);
  screen.focus();
}

/** Facts about the walk that only the live screen knew, kept for registration. */
let lastWalkFacts: {
  hadOrientation: boolean; analysisHz: number; analysedFraction: number; frameCount: number;
} | null = null;

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

async function showUpload(
  client: SupabaseClient, captureStore: CaptureStore, manifest: CaptureManifest,
): Promise<void> {
  const cancelled = { aborted: false };
  let ledgerBytes = 0;

  const screen = renderUpload({
    propertyTitle: manifest.propertyTitle,
    worldVersion: manifest.worldVersion,
    totalBytes: 0,
    onCancel: () => {
      cancelled.aborted = true;
      store.set({ step: 'pick' });
      void showPick(client, captureStore);
    },
    onRetry: () => { void showUpload(client, captureStore, manifest); },
    onFinish: () => {
      store.set({ step: 'pick' });
      void showPick(client, captureStore);
    },
    onDiscard: () => {
      const ok = window.confirm(
        'Delete the local copy? The walkthrough is on the server and filed; this only removes it '
        + 'from the phone.');
      if (!ok) return;
      void captureStore.deleteCapture(manifest.captureId).then(() => {
        unsentReason = null;
        store.set({ step: 'pick' });
        void showPick(client, captureStore);
      });
    },
  });
  swap(screen.root);
  screen.focus();
  screen.phase('preparing');

  try {
    const ledger = await captureStore.ledger(manifest.captureId);
    ledgerBytes = ledger.totalBytes;
    if (ledgerBytes === 0) throw new Error('There is nothing recorded for this walkthrough.');
    screen.progress(0, ledgerBytes, 0);

    const capturedAt = new Date(manifest.startedAt);
    const name = captureObjectName(capturedAt, extensionForMime(manifest.mimeType));
    const objectPath = captureObjectPath(manifest.worldId, name);
    const source = uploadSourceFor(captureStore, manifest.captureId, ledger);

    screen.phase('sending');
    await uploadRecording({
      target: {
        endpoint: uploadEndpoint,
        bucket: CAPTURE_BUCKET,
        objectPath,
        contentType: manifest.mimeType,
        worldId: manifest.worldId,
      },
      source,
      credentials: credentialsFor(client),
      deps: { fetch: (url, init) => fetch(url, init), persistence: captureStore.uploads() },
      refreshAuth: () => client.refreshNow(),
      signal: cancelled,
      onProgress: (p) => screen.progress(p.offset, p.bytes, p.chunksLeft),
      onRetry: (ctx) => screen.retrying(ctx.delayMs, ctx.error.message),
    });

    screen.phase('registering');
    const facts = lastWalkFacts;
    const device: DeviceDescriptor = {
      userAgent: navigator.userAgent,
      platform: typeof navigator.platform === 'string' ? navigator.platform : null,
      recordedWidth: manifest.recordedWidth,
      recordedHeight: manifest.recordedHeight,
      recordedFps: manifest.recordedFps,
      mimeType: manifest.mimeType,
      hadOrientation: facts?.hadOrientation ?? false,
      analysisHz: facts?.analysisHz ?? 0,
      analysedFraction: facts?.analysedFraction ?? 0,
    };
    const registered = await registerCapture(client, {
      worldId: manifest.worldId,
      storagePath: objectPath,
      bytes: ledgerBytes,
      durationS: manifest.durationS ?? 0,
      frameCount: facts?.frameCount ?? 0,
      device,
      capturedAt,
    });

    await captureStore.putManifest({ ...manifest, registeredCaptureId: registered.captureId });
    unsentReason = null;
    screen.succeeded(registered.captureId, registered.duplicate);
    voice.say('The walkthrough is filed. It is safe to leave.');
  } catch (err) {
    if (cancelled.aborted) return;
    const message = err instanceof Error ? err.message : String(err);
    screen.phase('failed');
    screen.failed(
      `${message} The recording is still on this phone and nothing sent so far has been lost — `
      + 'trying again continues from where it stopped.');
  }
}
