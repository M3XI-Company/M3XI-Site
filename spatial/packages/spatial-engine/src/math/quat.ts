import type { Quat, Vec3 } from '@m3xi/world-core';
import { cross, normalise } from './vec3.js';

/**
 * Quaternions in the contract's [x, y, z, w] order, right-handed, +Y up.
 * A quaternion here always means "rotation from local frame to world frame".
 */

export const QUAT_IDENTITY: Quat = [0, 0, 0, 1];

export function quatNormalise(q: Quat): Quat {
  const l2 = q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3];
  // A degenerate quaternion means "no usable rotation", and identity is the only
  // answer that cannot make a downstream transform worse.
  if (!Number.isFinite(l2) || l2 <= 1e-20) return QUAT_IDENTITY;
  const inv = 1 / Math.sqrt(l2);
  return [q[0] * inv, q[1] * inv, q[2] * inv, q[3] * inv];
}

export function quatConjugate(q: Quat): Quat {
  return [-q[0], -q[1], -q[2], q[3]];
}

/** Hamilton product: the rotation `a` applied after `b`. */
export function quatMul(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

export function quatFromAxisAngle(axis: Vec3, angleRad: number): Quat {
  const n = normalise(axis);
  const h = angleRad * 0.5;
  const s = Math.sin(h);
  return [n[0] * s, n[1] * s, n[2] * s, Math.cos(h)];
}

/** Rotation about +Y by `angleRad`. The only rotation most furniture has. */
export function quatFromYaw(angleRad: number): Quat {
  const h = angleRad * 0.5;
  return [0, Math.sin(h), 0, Math.cos(h)];
}

/**
 * v' = v + 2 * (q_xyz x (q_xyz x v + w v)).
 * The expanded form avoids building a matrix for a single vector.
 */
export function rotate(q: Quat, v: Vec3): Vec3 {
  const qx = q[0], qy = q[1], qz = q[2], qw = q[3];
  const tx = qy * v[2] - qz * v[1] + qw * v[0];
  const ty = qz * v[0] - qx * v[2] + qw * v[1];
  const tz = qx * v[1] - qy * v[0] + qw * v[2];
  return [
    v[0] + 2 * (qy * tz - qz * ty),
    v[1] + 2 * (qz * tx - qx * tz),
    v[2] + 2 * (qx * ty - qy * tx),
  ];
}

export function rotateInverse(q: Quat, v: Vec3): Vec3 {
  return rotate(quatConjugate(quatNormalise(q)), v);
}

/** The three world-space axes of the local frame, as columns of the rotation. */
export function quatAxes(q: Quat): [Vec3, Vec3, Vec3] {
  const n = quatNormalise(q);
  return [rotate(n, [1, 0, 0]), rotate(n, [0, 1, 0]), rotate(n, [0, 0, 1])];
}

/**
 * Camera forward. Cameras in this system follow the three.js convention the
 * contract's Mat4 note points at: the camera looks down its own -Z.
 */
export function forwardOf(q: Quat): Vec3 {
  return rotate(quatNormalise(q), [0, 0, -1]);
}

export function upOf(q: Quat): Vec3 {
  return rotate(quatNormalise(q), [0, 1, 0]);
}

/** Right-handed right vector: forward x up. */
export function rightOf(q: Quat): Vec3 {
  return cross(forwardOf(q), upOf(q));
}

/** Smallest angle in radians between two orientations. */
export function quatAngleBetween(a: Quat, b: Quat): number {
  const na = quatNormalise(a);
  const nb = quatNormalise(b);
  let d = Math.abs(na[0] * nb[0] + na[1] * nb[1] + na[2] * nb[2] + na[3] * nb[3]);
  d = d > 1 ? 1 : d;
  return 2 * Math.acos(d);
}
