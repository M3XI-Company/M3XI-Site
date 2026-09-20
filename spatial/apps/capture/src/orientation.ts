/**
 * The compass, where there is one.
 *
 * `capture-core` uses orientation for exactly two things and both of them
 * matter: separating walking from turning (`translationWidths`, and the
 * `capture.translation_share` finding — a property shot as a panorama from the
 * middle of each room sails through frame selection and then comes apart in
 * pose), and the yaw coverage dial. Neither is faked when the device gives
 * nothing: `RoomCoverage.translationWidths` is null without a gyro and
 * `verdictFigures` says "not measured" in as many words.
 *
 * THE SIGN CONVENTION, WHICH IS THE WHOLE FILE.
 * `Orientation.yaw` is radians and "yaw increases clockwise viewed from
 * above". DeviceOrientationEvent's `alpha` is the opposite: it is the rotation
 * about the z-axis measured COUNTER-clockwise from the frame's zero, 0 to 360
 * degrees. So a physical quarter-turn to the right DECREASES alpha and must
 * INCREASE yaw, and the conversion is `360 - alpha`. Get this backwards and
 * `yawRate` still reports the right magnitude — so the "turning too fast" cue
 * still works and nothing looks broken — while `FovEstimator` correlates the
 * gyro against pixel flow with the wrong sign, fails to find an agreement, and
 * silently falls back to FALLBACK_HFOV_RAD for the whole capture. That is a
 * bug that cannot be seen from the outside, which is why it is written down
 * here rather than left as a minus sign.
 *
 * `webkitCompassHeading` on iOS is already degrees CLOCKWISE from magnetic
 * north, so it is used directly where it exists and is also the only thing on
 * that platform that makes the reading absolute.
 *
 * iOS ALSO REQUIRES A GESTURE. `DeviceOrientationEvent.requestPermission` must
 * be called from a user activation, and it rejects outside a secure context.
 * So it is requested from the tap that starts the walk, and a refusal is a
 * state the screen shows rather than an error — the capture is perfectly valid
 * without a compass, it is just missing one measurement, and the verdict says
 * which.
 */

import type { Orientation } from '@m3xi/capture-core';

const DEG = Math.PI / 180;

interface OrientationEventLike {
  readonly alpha: number | null;
  readonly beta: number | null;
  readonly gamma: number | null;
  readonly absolute?: boolean;
  /** iOS only: degrees clockwise from magnetic north. */
  readonly webkitCompassHeading?: number;
}

/**
 * One sample, or null when the event carried nothing usable.
 *
 * Null rather than zeros. A device that fires the event with null angles —
 * which desktop browsers and some Android tablets do — would otherwise feed
 * the session a stream of perfect north readings, and `yawCoverage` would
 * report that the operator faced one direction for the entire walk.
 */
export function orientationFrom(event: OrientationEventLike, tMs: number): Orientation | null {
  const heading = typeof event.webkitCompassHeading === 'number'
    && Number.isFinite(event.webkitCompassHeading)
    ? event.webkitCompassHeading
    : null;

  if (heading === null && (event.alpha === null || !Number.isFinite(event.alpha))) return null;

  // See the header: alpha counts counter-clockwise, yaw counts clockwise.
  const yawDeg = heading ?? (360 - (event.alpha ?? 0));
  return {
    yaw: normalise(yawDeg * DEG),
    pitch: (event.beta ?? 0) * DEG,
    roll: (event.gamma ?? 0) * DEG,
    absolute: heading !== null || event.absolute === true,
    tMs,
  };
}

/** Into [0, 2pi). The bins in `CoverageModel` are indexed off this range. */
export function normalise(radians: number): number {
  const twoPi = Math.PI * 2;
  const wrapped = radians % twoPi;
  return wrapped < 0 ? wrapped + twoPi : wrapped;
}

type PermissionApi = { requestPermission?: () => Promise<'granted' | 'denied' | 'default'> };

export type OrientationAvailability = 'granted' | 'denied' | 'unsupported';

/**
 * Ask for the compass. Must be called from inside a user gesture on iOS.
 *
 * A rejection is reported as 'denied' rather than thrown: this is a
 * measurement the capture can do without, and a thrown error here would stop a
 * walk that is perfectly able to proceed.
 */
export async function requestOrientation(): Promise<OrientationAvailability> {
  if (typeof DeviceOrientationEvent === 'undefined') return 'unsupported';
  const api = DeviceOrientationEvent as unknown as PermissionApi;
  if (typeof api.requestPermission !== 'function') {
    // Android and desktop: no gate. Whether any sample actually arrives is a
    // separate question, answered by `OrientationWatch.hasSample`.
    return 'granted';
  }
  try {
    return (await api.requestPermission()) === 'granted' ? 'granted' : 'denied';
  } catch {
    return 'denied';
  }
}

/**
 * Listens, converts, and remembers whether anything ever arrived.
 *
 * `hasSample` is what the live screen uses to decide whether to draw a dial at
 * all — permission being granted is not the same as the hardware reporting
 * anything, and plenty of devices grant and then stay silent.
 */
export class OrientationWatch {
  private latest: Orientation | null = null;
  private readonly startedAt: number;
  private readonly onSample: (o: Orientation) => void;
  private listening = false;

  constructor(startedAt: number, onSample: (o: Orientation) => void) {
    this.startedAt = startedAt;
    this.onSample = onSample;
  }

  get current(): Orientation | null { return this.latest; }
  get hasSample(): boolean { return this.latest !== null; }

  start(): void {
    if (this.listening) return;
    this.listening = true;
    window.addEventListener('deviceorientation', this.handle);
  }

  stop(): void {
    if (!this.listening) return;
    this.listening = false;
    window.removeEventListener('deviceorientation', this.handle);
  }

  private readonly handle = (event: DeviceOrientationEvent): void => {
    const sample = orientationFrom(
      event as unknown as OrientationEventLike,
      Math.max(0, performance.now() - this.startedAt),
    );
    if (sample === null) return;
    this.latest = sample;
    this.onSample(sample);
  };
}
