import type { Vec3 } from '@m3xi/world-core';
import type { CameraConstraint } from '../nav/constraints.js';
import { lerpAngle } from '../nav/path.js';
import type { BlockReason, CameraPose } from '../types.js';

/**
 * MOVEMENT, INCLUDING FROM THE KEYBOARD
 * =====================================
 *
 * WCAG 2.2 AA means every control is operable from the keyboard, and in a
 * walkthrough "every control" includes walking. So the keyboard is not a
 * fallback path bolted on after the mouse: it is the primary implementation,
 * and the pointer feeds the same intent struct.
 *
 * Deliberate choices:
 *   - Pointer lock is offered, never required. It traps the cursor, breaks
 *     Escape for some assistive tooling and is hostile on a trackpad. Drag to
 *     look works everywhere and is what most visitors try first anyway.
 *   - Arrow left/right TURN rather than strafe. A keyboard-only user navigating
 *     a corridor needs to change facing far more often than they need to
 *     sidestep, and strafing is on A/D for anyone who wants it.
 *   - No field-of-view zoom on scroll. Changing the FOV changes the apparent
 *     size of every room, in a product whose whole claim is that sizes are
 *     honest. Scroll moves the camera instead.
 *   - Under `prefers-reduced-motion` the smoothing is switched off entirely:
 *     movement becomes step-wise, which is the behaviour people who get motion
 *     sick from first-person cameras actually need.
 */

export interface ControlIntent {
  /** -1..1, positive is forward. */
  forward: number;
  /** -1..1, positive is right. */
  strafe: number;
  /** Radians per second, positive turns left. */
  turn: number;
  /** Radians per second, positive looks up. */
  look: number;
  fast: boolean;
}

export interface ControlsOptions {
  readonly reducedMotion: boolean;
  /** Metres per second. 1.35 is a brisk indoor walk. */
  readonly walkSpeed?: number;
  readonly runMultiplier?: number;
  readonly turnRate?: number;
  readonly onBlocked?: (reason: BlockReason, blockedBy: string | undefined) => void;
  readonly onMoved?: (pose: CameraPose, roomChanged: boolean) => void;
  /** A click or Enter on the canvas, with the pick ray in NDC. */
  readonly onPick?: (ndcX: number, ndcY: number) => void;
  readonly onCommand?: (command: ControlCommand) => void;
}

export type ControlCommand =
  | 'next-viewpoint' | 'previous-viewpoint' | 'return-to-entrance'
  | 'measure-here' | 'help' | 'level-horizon';

const DEFAULTS = { walkSpeed: 1.35, runMultiplier: 1.9, turnRate: 2.1 } as const;
/** Repeating "blocked by a wall" every frame is unusable; once a second is not. */
const BLOCK_ANNOUNCE_INTERVAL_MS = 1200;
const MAX_PITCH = Math.PI / 2 - 0.05;

export class Controls {
  private readonly intent: ControlIntent = { forward: 0, strafe: 0, turn: 0, look: 0, fast: false };
  private readonly keys = new Set<string>();
  private pose: CameraPose;
  private smoothed = { forward: 0, strafe: 0 };
  private readonly touch = { forward: 0, strafe: 0, turn: 0 };
  private lastBlockAt = 0;
  private lastRoomId: string | undefined;
  private dragging = false;
  private lastPointer: { x: number; y: number } | undefined;
  private pointerMoved = false;
  private detachers: Array<() => void> = [];
  private readonly opts: Required<Omit<ControlsOptions, 'onBlocked' | 'onMoved' | 'onPick' | 'onCommand'>>
    & Pick<ControlsOptions, 'onBlocked' | 'onMoved' | 'onPick' | 'onCommand'>;

  constructor(
    private readonly element: HTMLElement,
    private readonly constraint: CameraConstraint,
    initial: CameraPose,
    options: ControlsOptions,
  ) {
    this.opts = { ...DEFAULTS, ...stripUndefined(options) } as typeof this.opts;
    this.pose = initial;
    this.lastRoomId = constraint.world.roomAt(initial.position)?.id;
    this.attach();
  }

  get currentPose(): CameraPose { return this.pose; }

  /**
   * On-screen movement, for touch and for anyone who cannot hold two keys at
   * once. It is the same intent the keyboard produces, so there is exactly one
   * movement code path and the on-screen pad obeys every constraint the
   * keyboard does.
   */
  setTouchIntent(forward: number, strafe: number, turn = 0): void {
    this.touch.forward = clamp(forward, -1, 1);
    this.touch.strafe = clamp(strafe, -1, 1);
    this.touch.turn = clamp(turn, -1, 1);
  }

  setPose(pose: CameraPose): void {
    this.pose = { ...pose, pitch: clamp(pose.pitch, -MAX_PITCH, MAX_PITCH) };
    this.lastRoomId = this.constraint.world.roomAt(pose.position)?.id;
  }

  /** True while the user is actively driving; suppresses auto-hiding chrome. */
  get isActive(): boolean {
    return this.keys.size > 0 || this.dragging
      || this.touch.forward !== 0 || this.touch.strafe !== 0 || this.touch.turn !== 0;
  }

  // -------------------------------------------------------------------------

  private attach(): void {
    const el = this.element;
    const on = <K extends keyof HTMLElementEventMap>(
      target: HTMLElement | Window, type: K, handler: (e: HTMLElementEventMap[K]) => void,
      opts?: AddEventListenerOptions,
    ): void => {
      target.addEventListener(type as string, handler as EventListener, opts);
      this.detachers.push(() => target.removeEventListener(type as string, handler as EventListener, opts));
    };

    on(el, 'keydown', (e) => this.onKeyDown(e));
    on(el, 'keyup', (e) => this.onKeyUp(e));
    on(el, 'blur', () => this.keys.clear());
    on(el, 'pointerdown', (e) => this.onPointerDown(e));
    on(el, 'pointermove', (e) => this.onPointerMove(e));
    on(el, 'pointerup', (e) => this.onPointerUp(e));
    on(el, 'pointercancel', () => { this.dragging = false; });
    on(el, 'wheel', (e) => this.onWheel(e), { passive: false });
    on(el, 'contextmenu', (e) => e.preventDefault());
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const handled = this.handleCommandKey(key, e);
    if (handled) { e.preventDefault(); return; }
    if (!MOVEMENT_KEYS.has(key)) return;
    e.preventDefault();
    this.keys.add(key);
  }

  private onKeyUp(e: KeyboardEvent): void {
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    this.keys.delete(key);
  }

  private handleCommandKey(key: string, e: KeyboardEvent): boolean {
    switch (key) {
      case 'v':
        this.opts.onCommand?.(e.shiftKey ? 'previous-viewpoint' : 'next-viewpoint');
        return true;
      case 'r': this.opts.onCommand?.('return-to-entrance'); return true;
      case 'm': this.opts.onCommand?.('measure-here'); return true;
      case 'home': this.opts.onCommand?.('level-horizon'); return true;
      case '?': this.opts.onCommand?.('help'); return true;
      case 'Enter': case ' ':
        // Enter and Space are the keyboard equivalent of clicking the
        // crosshair, which is how a keyboard user measures and inspects.
        this.opts.onPick?.(0, 0);
        return true;
      default: return false;
    }
  }

  private onPointerDown(e: PointerEvent): void {
    if (e.pointerType === 'touch' && e.isPrimary === false) return;
    this.element.focus({ preventScroll: true });
    this.dragging = true;
    this.pointerMoved = false;
    this.lastPointer = { x: e.clientX, y: e.clientY };
    this.element.setPointerCapture?.(e.pointerId);
  }

  private onPointerMove(e: PointerEvent): void {
    if (!this.dragging || !this.lastPointer) return;
    const dx = e.clientX - this.lastPointer.x;
    const dy = e.clientY - this.lastPointer.y;
    this.lastPointer = { x: e.clientX, y: e.clientY };
    if (Math.abs(dx) + Math.abs(dy) > 3) this.pointerMoved = true;

    const rect = this.element.getBoundingClientRect();
    // A full drag across the viewport turns about 180 degrees, which is the
    // ratio that feels like turning your head rather than spinning.
    const yawPerPx = Math.PI / Math.max(320, rect.width);
    const pitchPerPx = Math.PI / Math.max(320, rect.height);
    this.pose = {
      position: this.pose.position,
      yaw: this.pose.yaw - dx * yawPerPx,
      pitch: clamp(this.pose.pitch - dy * pitchPerPx, -MAX_PITCH, MAX_PITCH),
    };
  }

  private onPointerUp(e: PointerEvent): void {
    this.dragging = false;
    this.element.releasePointerCapture?.(e.pointerId);
    if (this.pointerMoved) return;
    const rect = this.element.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    this.opts.onPick?.(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -(((e.clientY - rect.top) / rect.height) * 2 - 1),
    );
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const step = clamp(-e.deltaY / 400, -0.5, 0.5);
    this.step(forwardVector(this.pose.yaw), step);
  }

  // -------------------------------------------------------------------------

  /** Advance one frame. `dt` in seconds. */
  update(dt: number): CameraPose {
    const step = Math.min(dt, 0.1);
    this.readKeys();

    const targetForward = this.intent.forward;
    const targetStrafe = this.intent.strafe;
    // Reduced motion gets no acceleration ramp: the camera is either moving or
    // it is not, which removes the drifting sensation that triggers nausea.
    const blend = this.opts.reducedMotion ? 1 : Math.min(1, step * 12);
    this.smoothed.forward += (targetForward - this.smoothed.forward) * blend;
    this.smoothed.strafe += (targetStrafe - this.smoothed.strafe) * blend;
    if (Math.abs(this.smoothed.forward) < 1e-3) this.smoothed.forward = 0;
    if (Math.abs(this.smoothed.strafe) < 1e-3) this.smoothed.strafe = 0;

    if (this.intent.turn !== 0) {
      this.pose = {
        ...this.pose,
        yaw: this.pose.yaw + this.intent.turn * this.opts.turnRate * step,
      };
    }
    if (this.intent.look !== 0) {
      this.pose = {
        ...this.pose,
        pitch: clamp(this.pose.pitch + this.intent.look * this.opts.turnRate * step, -MAX_PITCH, MAX_PITCH),
      };
    }

    if (this.smoothed.forward !== 0 || this.smoothed.strafe !== 0) {
      const speed = this.opts.walkSpeed * (this.intent.fast ? this.opts.runMultiplier : 1) * step;
      const fwd = forwardVector(this.pose.yaw);
      const right = rightVector(this.pose.yaw);
      const delta: Vec3 = [
        fwd[0] * this.smoothed.forward * speed + right[0] * this.smoothed.strafe * speed,
        0,
        fwd[2] * this.smoothed.forward * speed + right[2] * this.smoothed.strafe * speed,
      ];
      this.applyMove(delta);
    }
    return this.pose;
  }

  private step(direction: Vec3, metres: number): void {
    this.applyMove([direction[0] * metres, 0, direction[2] * metres]);
  }

  private applyMove(delta: Vec3): void {
    const result = this.constraint.move(this.pose.position, delta);
    if (result.moved) {
      this.pose = { ...this.pose, position: result.position };
      const roomChanged = result.roomId !== this.lastRoomId;
      this.lastRoomId = result.roomId;
      this.opts.onMoved?.(this.pose, roomChanged);
      return;
    }
    if (!result.blocked || !result.reason) return;
    const now = Date.now();
    if (now - this.lastBlockAt < BLOCK_ANNOUNCE_INTERVAL_MS) return;
    this.lastBlockAt = now;
    this.opts.onBlocked?.(result.reason, result.blockedBy);
  }

  private readKeys(): void {
    const k = this.keys;
    const down = (...names: string[]): boolean => names.some((n) => k.has(n));
    this.intent.forward = clamp((down('w', 'ArrowUp') ? 1 : 0) - (down('s', 'ArrowDown') ? 1 : 0) + this.touch.forward, -1, 1);
    this.intent.strafe = clamp((down('d') ? 1 : 0) - (down('a') ? 1 : 0) + this.touch.strafe, -1, 1);
    this.intent.turn = clamp((down('ArrowLeft', 'q') ? 1 : 0) - (down('ArrowRight', 'e') ? 1 : 0) + this.touch.turn, -1, 1);
    this.intent.look = (down('PageUp') ? 1 : 0) - (down('PageDown') ? 1 : 0);
    this.intent.fast = k.has('Shift');
  }

  /** Smoothly turn to a yaw over a few frames, used after an agent lookAt. */
  turnTo(yaw: number, pitch: number, t: number): void {
    this.pose = {
      position: this.pose.position,
      yaw: lerpAngle(this.pose.yaw, yaw, t),
      pitch: this.pose.pitch + (clamp(pitch, -MAX_PITCH, MAX_PITCH) - this.pose.pitch) * t,
    };
  }

  dispose(): void {
    for (const d of this.detachers) d();
    this.detachers = [];
    this.keys.clear();
  }
}

const MOVEMENT_KEYS = new Set([
  'w', 'a', 's', 'd', 'q', 'e', 'Shift',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown',
]);

export function forwardVector(yaw: number): Vec3 {
  return [-Math.sin(yaw), 0, -Math.cos(yaw)];
}

export function rightVector(yaw: number): Vec3 {
  return [Math.cos(yaw), 0, -Math.sin(yaw)];
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out as Partial<T>;
}
