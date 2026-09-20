"""Coordinate frames, quaternions and XZ rings.

The world frame, restated from types.ts so this file can be read alone:

    right-handed, +Y up, origin at the property's ground datum
    (the lowest reconstructed floor plane of the lowest floor).
    Quaternions are [x, y, z, w]. Angles in radians, lengths in metres.

Everything upstream disagrees with that, which is the entire reason this
module exists:

    COLMAP / OpenCV camera:  +X right, +Y DOWN, +Z forward (into the scene),
                             and COLMAP stores world-from-camera as (R|t) with
                             R, t mapping world -> camera.
    MapAnything / MoGe:      OpenCV camera convention, camera-from-world
                             extrinsics, +Y down.
    three.js / the viewer:   +Y up, right-handed, -Z forward. Same handedness
                             as us, so only the camera basis differs.

Getting one of these wrong produces a world that is internally consistent and
globally upside down, which passes every test that does not check a real
conversion. Hence the explicit tests in tests/test_geometry.py.
"""
from __future__ import annotations

import math
from typing import Iterable, Sequence

import numpy as np

# Rotation taking an OpenCV camera basis (+X right, +Y down, +Z forward) to the
# world-viewer camera basis (+X right, +Y up, -Z forward). It is a 180 degree
# turn about X: y -> -y, z -> -z. Same handedness, so det = +1.
CV_TO_GL = np.array([[1.0, 0.0, 0.0],
                     [0.0, -1.0, 0.0],
                     [0.0, 0.0, -1.0]], dtype=np.float64)


# ---------------------------------------------------------------------------
# Quaternions, [x, y, z, w]
# ---------------------------------------------------------------------------

def quat_normalise(q: Sequence[float]) -> tuple[float, float, float, float]:
    x, y, z, w = (float(v) for v in q)
    n = math.sqrt(x * x + y * y + z * z + w * w)
    if n < 1e-12:
        raise ValueError("cannot normalise a zero quaternion")
    # Canonical sign: w >= 0. q and -q are the same rotation, but the world
    # document is diffed and hashed across versions, so a stable sign matters.
    if w < 0:
        x, y, z, w = -x, -y, -z, -w
    return (x / n, y / n, z / n, w / n)


def mat3_to_quat(m: np.ndarray) -> tuple[float, float, float, float]:
    """Rotation matrix -> [x, y, z, w]. Shepperd's method, branch on trace."""
    m = np.asarray(m, dtype=np.float64)
    if m.shape != (3, 3):
        raise ValueError(f"expected 3x3, got {m.shape}")
    t = float(m[0, 0] + m[1, 1] + m[2, 2])
    if t > 0.0:
        s = math.sqrt(t + 1.0) * 2.0
        w = 0.25 * s
        x = (m[2, 1] - m[1, 2]) / s
        y = (m[0, 2] - m[2, 0]) / s
        z = (m[1, 0] - m[0, 1]) / s
    elif m[0, 0] > m[1, 1] and m[0, 0] > m[2, 2]:
        s = math.sqrt(1.0 + m[0, 0] - m[1, 1] - m[2, 2]) * 2.0
        w = (m[2, 1] - m[1, 2]) / s
        x = 0.25 * s
        y = (m[0, 1] + m[1, 0]) / s
        z = (m[0, 2] + m[2, 0]) / s
    elif m[1, 1] > m[2, 2]:
        s = math.sqrt(1.0 + m[1, 1] - m[0, 0] - m[2, 2]) * 2.0
        w = (m[0, 2] - m[2, 0]) / s
        x = (m[0, 1] + m[1, 0]) / s
        y = 0.25 * s
        z = (m[1, 2] + m[2, 1]) / s
    else:
        s = math.sqrt(1.0 + m[2, 2] - m[0, 0] - m[1, 1]) * 2.0
        w = (m[1, 0] - m[0, 1]) / s
        x = (m[0, 2] + m[2, 0]) / s
        y = (m[1, 2] + m[2, 1]) / s
        z = 0.25 * s
    return quat_normalise((x, y, z, w))


def quat_to_mat3(q: Sequence[float]) -> np.ndarray:
    x, y, z, w = quat_normalise(q)
    xx, yy, zz = x * x, y * y, z * z
    xy, xz, yz = x * y, x * z, y * z
    wx, wy, wz = w * x, w * y, w * z
    return np.array([
        [1 - 2 * (yy + zz), 2 * (xy - wz), 2 * (xz + wy)],
        [2 * (xy + wz), 1 - 2 * (xx + zz), 2 * (yz - wx)],
        [2 * (xz - wy), 2 * (yz + wx), 1 - 2 * (xx + yy)],
    ], dtype=np.float64)


def quat_mul(a: Sequence[float], b: Sequence[float]) -> tuple[float, float, float, float]:
    ax, ay, az, aw = a
    bx, by, bz, bw = b
    return quat_normalise((
        aw * bx + ax * bw + ay * bz - az * by,
        aw * by - ax * bz + ay * bw + az * bx,
        aw * bz + ax * by - ay * bx + az * bw,
        aw * bw - ax * bx - ay * by - az * bz,
    ))


def quat_angle_between(a: Sequence[float], b: Sequence[float]) -> float:
    """Geodesic angle in radians between two orientations."""
    an = quat_normalise(a)
    bn = quat_normalise(b)
    d = abs(sum(u * v for u, v in zip(an, bn)))
    return 2.0 * math.acos(min(1.0, max(-1.0, d)))


# ---------------------------------------------------------------------------
# Camera extrinsics
# ---------------------------------------------------------------------------

def cv_extrinsics_to_world_pose(
    r_cw: np.ndarray, t_cw: np.ndarray
) -> tuple[tuple[float, float, float], tuple[float, float, float, float]]:
    """COLMAP/OpenCV camera-from-world (R, t) -> world position + orientation.

    COLMAP stores, per image, a quaternion and translation such that
        x_cam = R_cw @ x_world + t_cw
    with the camera looking down +Z and +Y pointing down in the image.

    Camera centre in world coordinates is C = -R_cw^T @ t_cw.
    The camera's world-space basis is R_wc = R_cw^T, whose columns are the
    camera's right / down / forward axes expressed in world coordinates. We
    want right / up / backward (the +Y-up convention the viewer uses), so we
    post-multiply by CV_TO_GL.
    """
    r_cw = np.asarray(r_cw, dtype=np.float64).reshape(3, 3)
    t_cw = np.asarray(t_cw, dtype=np.float64).reshape(3)
    r_wc = r_cw.T
    centre = -r_wc @ t_cw
    basis = r_wc @ CV_TO_GL
    return (float(centre[0]), float(centre[1]), float(centre[2])), mat3_to_quat(basis)


def world_pose_to_cv_extrinsics(
    position: Sequence[float], orientation: Sequence[float]
) -> tuple[np.ndarray, np.ndarray]:
    """Inverse of cv_extrinsics_to_world_pose. Used when handing our poses
    back to COLMAP as priors and when rendering with gsplat."""
    basis = quat_to_mat3(orientation)
    r_wc = basis @ CV_TO_GL.T            # CV_TO_GL is its own inverse, kept explicit
    r_cw = r_wc.T
    c = np.asarray(position, dtype=np.float64).reshape(3)
    t_cw = -r_cw @ c
    return r_cw, t_cw


def camera_forward(orientation: Sequence[float]) -> np.ndarray:
    """Unit view direction in world space. Our camera basis looks down -Z."""
    return quat_to_mat3(orientation) @ np.array([0.0, 0.0, -1.0])


# ---------------------------------------------------------------------------
# XZ rings
# ---------------------------------------------------------------------------

def signed_area_xz(ring: Iterable[Sequence[float]]) -> float:
    """Shoelace over (x, z). Sign convention derived, not guessed:

    Viewed from above the viewer sits at +Y looking along d = (0, -1, 0) with
    screen-right r = (1, 0, 0). Screen-up is u = r x d = (0, 0, -1), so a point
    with larger Z draws LOWER on screen. Screen coordinates are therefore
    (s_x, s_y) = (x, -z), and a ring that is counter-clockwise on screen has
    positive shoelace in (s_x, s_y), i.e. NEGATIVE shoelace in (x, z).

    So: counter-clockwise viewed from above  <=>  signed_area_xz(ring) < 0.
    """
    pts = [(float(p[0]), float(p[1])) for p in ring]
    n = len(pts)
    if n < 3:
        return 0.0
    acc = 0.0
    for i in range(n):
        x0, z0 = pts[i]
        x1, z1 = pts[(i + 1) % n]
        acc += x0 * z1 - x1 * z0
    return 0.5 * acc


def is_ccw_from_above(ring: Iterable[Sequence[float]]) -> bool:
    return signed_area_xz(ring) < 0.0


def ensure_ccw_from_above(ring: Sequence[Sequence[float]]) -> list[tuple[float, float]]:
    pts = [(float(p[0]), float(p[1])) for p in ring]
    return pts if is_ccw_from_above(pts) else list(reversed(pts))


def polygon_area(ring: Iterable[Sequence[float]]) -> float:
    """Unsigned area in m^2."""
    return abs(signed_area_xz(ring))


def polygon_perimeter(ring: Sequence[Sequence[float]]) -> float:
    n = len(ring)
    if n < 2:
        return 0.0
    return sum(
        math.dist(ring[i], ring[(i + 1) % n]) for i in range(n)
    )


def point_in_ring(pt: Sequence[float], ring: Sequence[Sequence[float]]) -> bool:
    """Crossing-number test on the XZ plane. Boundary counts as inside for the
    lower/left edges only; rooms tile the floor and a point must land in
    exactly one of them."""
    x, z = float(pt[0]), float(pt[1])
    inside = False
    n = len(ring)
    for i in range(n):
        x0, z0 = float(ring[i][0]), float(ring[i][1])
        x1, z1 = float(ring[(i + 1) % n][0]), float(ring[(i + 1) % n][1])
        if (z0 > z) != (z1 > z):
            t = (z - z0) / (z1 - z0)
            if x < x0 + t * (x1 - x0):
                inside = not inside
    return inside


def points_in_ring(points_xz: np.ndarray, ring: Sequence[Sequence[float]]) -> np.ndarray:
    """Vectorised crossing-number test for many points against one ring.

    Same predicate as point_in_ring, evaluated for an (N, 2) array at once.
    This exists because the scalar version was being called once per gaussian
    when chunking a million-gaussian splat by room, and once per voxel in the
    visibility carve: a Python loop over a million points takes minutes, and
    this takes a few tens of milliseconds.
    """
    p = np.asarray(points_xz, dtype=np.float64).reshape(-1, 2)
    r = np.asarray(ring, dtype=np.float64).reshape(-1, 2)
    if len(r) < 3 or len(p) == 0:
        return np.zeros(len(p), dtype=bool)
    x, z = p[:, 0], p[:, 1]
    inside = np.zeros(len(p), dtype=bool)
    x0, z0 = r[:, 0], r[:, 1]
    x1, z1 = np.roll(x0, -1), np.roll(z0, -1)
    for i in range(len(r)):
        straddles = (z0[i] > z) != (z1[i] > z)
        if not straddles.any():
            continue
        dz = z1[i] - z0[i]
        with np.errstate(divide="ignore", invalid="ignore"):
            tv = np.where(dz != 0.0, (z - z0[i]) / dz, 0.0)
        crosses = straddles & (x < x0[i] + tv * (x1[i] - x0[i]))
        inside ^= crosses
    return inside


def ring_centroid(ring: Sequence[Sequence[float]]) -> tuple[float, float]:
    a = signed_area_xz(ring)
    if abs(a) < 1e-9:
        xs = [float(p[0]) for p in ring]
        zs = [float(p[1]) for p in ring]
        return (sum(xs) / len(xs), sum(zs) / len(zs))
    cx = cz = 0.0
    n = len(ring)
    for i in range(n):
        x0, z0 = float(ring[i][0]), float(ring[i][1])
        x1, z1 = float(ring[(i + 1) % n][0]), float(ring[(i + 1) % n][1])
        cross = x0 * z1 - x1 * z0
        cx += (x0 + x1) * cross
        cz += (z0 + z1) * cross
    return (cx / (6.0 * a), cz / (6.0 * a))


def simplify_ring(ring: Sequence[Sequence[float]], tol: float = 0.05) -> list[tuple[float, float]]:
    """Douglas-Peucker on a closed ring. tol in metres; 50 mm is below the
    wall tolerance we publish (see contract.MEASUREMENT_POLICY) so it cannot
    move a stated dimension outside its declared interval."""
    pts = [(float(p[0]), float(p[1])) for p in ring]
    if len(pts) <= 3:
        return pts

    def _dp(seq: list[tuple[float, float]]) -> list[tuple[float, float]]:
        if len(seq) < 3:
            return seq
        a, b = seq[0], seq[-1]
        ax, az = a
        bx, bz = b
        dx, dz = bx - ax, bz - az
        den = math.hypot(dx, dz)
        worst_i, worst_d = 0, -1.0
        for i in range(1, len(seq) - 1):
            px, pz = seq[i]
            if den < 1e-12:
                d = math.hypot(px - ax, pz - az)
            else:
                d = abs(dx * (az - pz) - (ax - px) * dz) / den
            if d > worst_d:
                worst_i, worst_d = i, d
        if worst_d <= tol:
            return [a, b]
        left = _dp(seq[: worst_i + 1])
        right = _dp(seq[worst_i:])
        return left[:-1] + right

    # Split the ring at its two extreme points so Douglas-Peucker has endpoints.
    i0 = min(range(len(pts)), key=lambda i: pts[i])
    rot = pts[i0:] + pts[:i0]
    i1 = max(range(len(rot)), key=lambda i: rot[i])
    out = _dp(rot[: i1 + 1])[:-1] + _dp(rot[i1:] + [rot[0]])[:-1]
    return out if len(out) >= 3 else pts


# ---------------------------------------------------------------------------
# Frusta and AABBs
# ---------------------------------------------------------------------------

def frustum_corners(
    position: Sequence[float],
    orientation: Sequence[float],
    fx: float, fy: float, cx: float, cy: float,
    width: int, height: int,
    near: float, far: float,
) -> np.ndarray:
    """8 world-space corners of the view frustum, near plane first.

    Pixel rays are built in the OpenCV camera frame (where the model's
    intrinsics live) and then rotated into world space, so cx/cy offsets and
    non-square pixels are honoured rather than assumed away.
    """
    basis = quat_to_mat3(orientation) @ CV_TO_GL.T   # world <- cv-camera
    c = np.asarray(position, dtype=np.float64)
    corners = []
    for depth in (near, far):
        for (u, v) in ((0, 0), (width, 0), (width, height), (0, height)):
            d_cv = np.array([(u - cx) / fx, (v - cy) / fy, 1.0]) * depth
            corners.append(c + basis @ d_cv)
    return np.asarray(corners)


def aabb_of(points: np.ndarray) -> tuple[list[float], list[float]]:
    p = np.asarray(points, dtype=np.float64).reshape(-1, 3)
    return ([float(v) for v in p.min(axis=0)], [float(v) for v in p.max(axis=0)])


def aabb_volume(mn: Sequence[float], mx: Sequence[float]) -> float:
    return max(0.0, float(mx[0] - mn[0])) * max(0.0, float(mx[1] - mn[1])) * max(0.0, float(mx[2] - mn[2]))


def aabb_intersect(a_min, a_max, b_min, b_max) -> bool:
    return all(a_min[i] <= b_max[i] and b_min[i] <= a_max[i] for i in range(3))
