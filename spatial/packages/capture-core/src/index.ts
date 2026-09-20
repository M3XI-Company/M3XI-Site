/**
 * @m3xi/capture-core — the analysis library a capture app drives.
 *
 * Pixels and numbers in, judgements out. No DOM, no network, no canvas, no
 * WebGL, and one dependency (`@m3xi/world-core`, for `RoomKind` alone). That is
 * not minimalism for its own sake: it is what lets the whole of this package
 * run in a worker thread off the render path, and run under vitest in Node
 * where the properties that matter can be tested against synthetic frames whose
 * sharpness and contrast are controlled independently. A blur metric that can
 * only be exercised by pointing a real phone at a real wall is a blur metric
 * nobody will ever prove is right.
 *
 * WHAT A BROWSER CANNOT DO, AND WHAT THIS PACKAGE THEREFORE DOES NOT PRETEND:
 *
 *   no position   `DeviceMotionEvent` gives linear acceleration, and
 *                 integrating it twice is metres out inside three seconds.
 *                 There is no visual-inertial odometry, no ARKit, no ARCore.
 *                 So there is no self-filling floorplan anywhere in here. The
 *                 coverage model is a yaw dial and a set of rooms the operator
 *                 taps, and `RoomCoverage` has no position field to misuse.
 *
 *   no depth      which is why `reflective.ts` computes the glazing evidence in
 *                 full and NONE of the mirror evidence, and says so in as many
 *                 words instead of inventing a mirror score.
 *
 *   no raw frames and no encoder feedback. Nothing here asks MediaRecorder what
 *                 it did with a frame, because MediaRecorder will not say.
 *
 *   no reliable background execution on iOS, which is why every stateful object
 *                 in here is fed frame by frame from the foreground and none of
 *                 them assumes a timer it did not see.
 *
 * And when a device is too slow, the analysis RATE comes down, never the
 * resolution — `SCORE_LONG_EDGE` is load-bearing, because variance of the
 * Laplacian is resolution-dependent and scoring at 640 px silently changes what
 * `BLUR_ABS_FLOOR` means. The shortfall is then reported as a fraction the
 * operator can see, in `guidance.ts` and again in `verdict.ts`.
 */

export * from './types.js';
export * from './thresholds.js';
export * from './image.js';
export * from './blur.js';
export * from './exposure.js';
export * from './reflective.js';
export * from './motion.js';
export * from './overlap.js';
export * from './frame.js';
export * from './pace.js';
export * from './coverage.js';
export * from './guidance.js';
export * from './route.js';
export * from './verdict.js';
export * from './session.js';
