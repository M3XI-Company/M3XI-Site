# Capture

The app an operator holds in their hand, standing in a stranger's home, with
one chance at the property.

Everything here exists to answer one question before they walk out of the front
door: **will this walkthrough reconstruct?** If it will not, they find out
thirty-five GPU-minutes and about $0.74 later, by which time they have left and
the vendor has gone out. Getting back in is days, sometimes a week, sometimes
never.

It drives `@m3xi/capture-core`, which does all the judging. This app owns the
camera, the worker, the recorder, the screens and the upload, and it has no
opinions about blur, motion or coverage that the library does not have.

---

## Running it

```
npx vite            # dev server on :5185, bound to 0.0.0.0
npx vite build      # production build into dist/
```

The site's own build already has an entry for `spatial/apps/capture/index.html`
in the root `vite.config.js`, along with the `@m3xi/capture-core` alias and
`worker: { format: 'es' }`. The local `vite.config.ts` repeats those three
settings so a dev server resolves things the way the deployed build does.

### It has to be https, on a real phone

`getUserMedia` and `DeviceOrientationEvent.requestPermission` both refuse
outside a secure context, and `localhost` only counts as one on the machine
itself. Testing this app means a phone, which means a tunnel:

```
npx vite
# in another shell, expose it over https and open that URL on the phone
```

Nothing important about this app can be judged from a desktop browser. The
camera is a fake pattern, `MediaRecorder` behaves differently, the pace
controller never has to adapt, and iOS backgrounding cannot be reproduced at
all.

### Configuration

Set on the host page, or at build time:

```js
window.__M3XI_CAPTURE__ = {
  supabaseUrl: 'https://<ref>.supabase.co',
  supabaseAnonKey: '<anon key>',
  // Optional. Derived from supabaseUrl when it has the standard shape.
  uploadEndpoint: 'https://<ref>.storage.supabase.co/storage/v1/upload/resumable',
};
```

or `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` /
`VITE_SUPABASE_UPLOAD_ENDPOINT`.

There is **no fixture backend**. The console has one and it makes sense there;
here every screen leads to a real upload into a real bucket and a real row, and
a pretend backend would let somebody walk a property, see a tick, and have sent
nothing anywhere. With no project configured the app says so on the first
screen and refuses to start.

---

## Shape

```
src/
  main.ts          the sequence: sign in, pick, plan, walk, verdict, upload
  config.ts        runtime config; no fixture mode
  state.ts         the wizard, in memory (see below)
  plan.ts          rooms the operator declares            [tested]
  frames.ts        frame pacing, and the resolution rule  [tested]
  display.ts       FrameResult -> what the screen shows   [tested]
  chunks.ts        byte ranges over a recording in pieces [tested]
  orientation.ts   the compass, and its sign convention   [tested]
  camera.ts        getUserMedia, rVFC loop, worker feed
  recorder.ts      MediaRecorder with a timeslice
  store.ts         IndexedDB: chunks, manifests, uploads
  api/
    supabase.ts    a small honest copy of the console's client
    worlds.ts      property and world picking, under RLS  [tested]
    captures.ts    object paths and register_capture      [tested]
    tus.ts         TUS 1.0.0 by hand                      [tested]
    upload.ts      the resumable upload loop              [tested]
    retry.ts       what to do when a request fails        [tested]
  worker/
    protocol.ts    the page/worker contract               [tested]
    analysis.worker.ts   toGray, downscale, session.onFrame
  screens/         signin, pick, plan, live, verdict, upload
  ui/              dom helpers and the stylesheet
e2e/
  a11y.e2e.mjs     the same audit the console runs, at phone size
```

Tests live beside the code and run from `spatial/`:

```
npx vitest run --no-file-parallelism
```

(The default parallelism hangs in this workspace.) They run in a **node**
environment, which is a constraint worth having: the parts that must be right —
the TUS offset arithmetic, resume after a partial upload, the retry rule, the
pacing decision, the mapping from a `FrameResult` to what the screen shows — are
separated from the DOM so they can be tested without one.

---

## The decisions worth knowing before changing anything

**The rate comes down; the resolution never does.** `SCORE_LONG_EDGE` is 960 px
and variance of the Laplacian is resolution-dependent, so scoring a smaller
frame silently changes what `BLUR_ABS_FLOOR` means. `captureResolution` in
`frames.ts` takes the load situation as an argument and ignores it, and the
test says so in as many words.

**Analysis runs in a worker, and the buffer is transferred.** A 1080p RGBA frame
is 8.3 MB; copying one ten times a second is 83 MB/s of allocation, and the
resulting collector pauses look to `PaceController` like a slow device — so the
app would throttle itself because of its own garbage.

**There is no floorplan and there never will be.** A browser has no position.
`DeviceMotionEvent` gives linear acceleration and integrating it twice is metres
out inside three seconds. The model of where the operator is, is the chip they
last tapped.

**The dial is absent, not zero.** No orientation means no dial and a sentence
saying the device does not report one. A dial stuck at north is a measurement
that is not being made, drawn as though it were.

**The confidence strip is computed from the measurement, never from the cue.**
A green light built from a third of the frames is a lie; the blur rule is a
comparison against a rolling median and a median over a sample is a different
statistic.

**There is no routing.** The app is served at `/capture` and `/capture/` only —
`/capture/*` stays on the filesystem for the PWA shell — and the steps are not
addressable anyway. Step four is "you are recording a stranger's living room".
What survives a reload is the recording (IndexedDB, written every four seconds),
the upload offset (IndexedDB, written after every chunk) and the session
(localStorage).

**`duplicate: true` from `register_capture` is success.** The server is
deliberately idempotent so a retry from a doorstep cannot make a second row, and
a client that called the second answer a failure would send somebody back into
the property for nothing.

**Nothing is deleted without being asked**, including after a successful upload.
"Successful" is a claim this app makes; the video is the only thing that cannot
be made again.

---

## What cannot be verified without a phone

Written down rather than assumed, because every one of these is a place where a
desktop browser will happily tell you the wrong thing:

- **Camera behaviour.** Whether a given handset actually gives 4K with
  `facingMode: environment`, what it does to the frame rate in a dim hallway,
  and whether `requestVideoFrameCallback` keeps up under load.
- **iOS backgrounding.** The claim that locking the phone or switching apps ends
  the recording is the documented behaviour and the reason `BACKGROUND_WARNING`
  exists. Confirming it means locking an actual iPhone mid-walk and checking
  that `onInterrupted` fires and the chunks already written are intact.
- **Real throughput.** Whether 6 MB chunks over one bar of signal finish a 2 GB
  upload in a tolerable time, and whether the 24-hour upload URL ever expires in
  practice.
- **The analysis budget.** `elapsedMs` per frame on real hardware, and whether
  `PaceController` settles or oscillates.

The way to verify each of them is a walk: a real property, a real phone, and the
go/no-go screen read against what the pipeline says afterwards.
