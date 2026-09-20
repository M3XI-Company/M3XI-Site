"""Coordinate frames. The tests that catch an upside-down world."""
from __future__ import annotations

import math

import numpy as np
import pytest

from worldengine import geometry as g


def test_quat_roundtrip_random():
    rng = np.random.default_rng(7)
    for _ in range(200):
        q = rng.normal(size=4)
        q /= np.linalg.norm(q)
        m = g.quat_to_mat3(q)
        assert np.allclose(m @ m.T, np.eye(3), atol=1e-9)
        assert np.isclose(np.linalg.det(m), 1.0, atol=1e-9)
        back = g.quat_to_mat3(g.mat3_to_quat(m))
        assert np.allclose(m, back, atol=1e-8)


def test_quat_canonical_sign():
    q = g.quat_normalise((0.1, 0.2, 0.3, -0.9))
    assert q[3] >= 0.0
    # q and -q are the same rotation, so the matrices must match.
    a = g.quat_to_mat3((0.1, 0.2, 0.3, 0.9))
    b = g.quat_to_mat3((-0.1, -0.2, -0.3, -0.9))
    assert np.allclose(a, b, atol=1e-9)


def test_quat_mul_matches_matrix_product():
    rng = np.random.default_rng(3)
    for _ in range(50):
        a = rng.normal(size=4); a /= np.linalg.norm(a)
        b = rng.normal(size=4); b /= np.linalg.norm(b)
        assert np.allclose(g.quat_to_mat3(g.quat_mul(a, b)),
                           g.quat_to_mat3(a) @ g.quat_to_mat3(b), atol=1e-8)


def test_quat_angle_between():
    ang = math.radians(37.0)
    a = (0.0, 0.0, 0.0, 1.0)
    b = (0.0, math.sin(ang / 2), 0.0, math.cos(ang / 2))
    assert math.isclose(g.quat_angle_between(a, b), ang, abs_tol=1e-9)


def test_cv_extrinsics_roundtrip():
    rng = np.random.default_rng(11)
    for _ in range(100):
        q = rng.normal(size=4); q /= np.linalg.norm(q)
        R = g.quat_to_mat3(q)
        t = rng.normal(size=3)
        pos, quat = g.cv_extrinsics_to_world_pose(R, t)
        R2, t2 = g.world_pose_to_cv_extrinsics(pos, quat)
        assert np.allclose(R, R2, atol=1e-8)
        assert np.allclose(t, t2, atol=1e-8)


def test_identity_cv_extrinsics_views_along_world_plus_z_and_is_upside_down():
    """An OpenCV camera with identity rotation looks along world +Z, and its
    image-down axis is world +Y — so in a +Y-up world it is upside down. Both
    facts must survive the conversion, because getting either wrong produces a
    world that renders and is inverted."""
    pos, quat = g.cv_extrinsics_to_world_pose(np.eye(3), np.zeros(3))
    assert np.allclose(pos, [0, 0, 0], atol=1e-12)
    assert np.allclose(g.camera_forward(quat), [0, 0, 1], atol=1e-9)
    basis = g.quat_to_mat3(quat)
    assert np.allclose(basis @ [1, 0, 0], [1, 0, 0], atol=1e-9)    # right stays right
    assert np.allclose(basis @ [0, 1, 0], [0, -1, 0], atol=1e-9)   # camera up is world down


def test_upright_camera_in_y_up_world_has_identity_orientation():
    """A camera that is actually upright in a +Y-up world: its OpenCV
    image-down axis points at world -Y and it looks along world -Z. That is
    exactly CV_TO_GL as the world-from-camera rotation, and it must come back
    as the identity orientation looking down -Z."""
    r_wc = g.CV_TO_GL
    r_cw = r_wc.T
    pos, quat = g.cv_extrinsics_to_world_pose(r_cw, np.zeros(3))
    assert np.allclose(g.quat_to_mat3(quat), np.eye(3), atol=1e-9)
    assert np.allclose(g.camera_forward(quat), [0, 0, -1], atol=1e-9)


def test_camera_position_is_the_centre_not_the_translation():
    R = g.quat_to_mat3((0, math.sin(math.pi / 4), 0, math.cos(math.pi / 4)))
    c = np.array([2.0, 1.5, -3.0])
    t = -R @ c
    pos, _ = g.cv_extrinsics_to_world_pose(R, t)
    assert np.allclose(pos, c, atol=1e-9)


def test_ring_winding_convention_is_derived_not_guessed():
    """CCW viewed from above <=> negative shoelace in (x, z).

    Concretely: standing above looking down, with +X to the right, +Z draws
    downward. Going (0,0) -> (1,0) -> (1,1) -> (0,1) is right, then DOWN the
    screen, then left, then up: that is clockwise on screen.
    """
    clockwise_on_screen = [(0, 0), (1, 0), (1, 1), (0, 1)]
    assert g.signed_area_xz(clockwise_on_screen) > 0
    assert not g.is_ccw_from_above(clockwise_on_screen)
    assert g.is_ccw_from_above(list(reversed(clockwise_on_screen)))


def test_ensure_ccw_is_idempotent_and_preserves_area():
    ring = [(0, 0), (4, 0), (4, 3), (0, 3)]
    once = g.ensure_ccw_from_above(ring)
    twice = g.ensure_ccw_from_above(once)
    assert once == twice
    assert g.is_ccw_from_above(once)
    assert math.isclose(g.polygon_area(once), 12.0)


def test_polygon_area_and_centroid():
    ring = [(0, 0), (0, 3), (4, 3), (4, 0)]
    assert math.isclose(g.polygon_area(ring), 12.0)
    cx, cz = g.ring_centroid(ring)
    assert math.isclose(cx, 2.0, abs_tol=1e-9)
    assert math.isclose(cz, 1.5, abs_tol=1e-9)
    assert math.isclose(g.polygon_perimeter(ring), 14.0)


def test_point_in_ring_l_shape():
    l_shape = [(0, 0), (0, 4), (2, 4), (2, 2), (4, 2), (4, 0)]
    assert g.point_in_ring((1, 1), l_shape)
    assert g.point_in_ring((3, 1), l_shape)
    assert not g.point_in_ring((3, 3), l_shape)     # the notch
    assert not g.point_in_ring((-1, 1), l_shape)


def test_simplify_ring_keeps_shape_within_tolerance():
    # A rectangle with 40 collinear points per edge must collapse to 4 corners.
    ring = []
    for t in np.linspace(0, 1, 40, endpoint=False):
        ring.append((4 * t, 0.0))
    for t in np.linspace(0, 1, 40, endpoint=False):
        ring.append((4.0, 3 * t))
    for t in np.linspace(0, 1, 40, endpoint=False):
        ring.append((4 - 4 * t, 3.0))
    for t in np.linspace(0, 1, 40, endpoint=False):
        ring.append((0.0, 3 - 3 * t))
    out = g.simplify_ring(ring, 0.05)
    assert len(out) <= 6
    assert abs(g.polygon_area(out) - 12.0) < 0.05


def test_frustum_corners_respect_intrinsics():
    corners = g.frustum_corners((0, 0, 0), (0, 0, 0, 1),
                                fx=500, fy=500, cx=320, cy=240,
                                width=640, height=480, near=1.0, far=5.0)
    assert corners.shape == (8, 3)
    # Near plane corners are 1 m in front, i.e. at z = -1 in our frame.
    assert np.allclose(corners[:4, 2], -1.0, atol=1e-9)
    assert np.allclose(corners[4:, 2], -5.0, atol=1e-9)
    # Pixel (0,0) is up-left: negative x, positive y in a +Y-up world.
    assert corners[0][0] < 0 and corners[0][1] > 0


def test_aabb_helpers():
    pts = np.array([[0, 0, 0], [1, 2, 3], [-1, 0.5, 2]])
    mn, mx = g.aabb_of(pts)
    assert mn == [-1.0, 0.0, 0.0] and mx == [1.0, 2.0, 3.0]
    assert math.isclose(g.aabb_volume(mn, mx), 2 * 2 * 3)
    assert g.aabb_intersect(mn, mx, [0, 0, 0], [0.5, 0.5, 0.5])
    assert not g.aabb_intersect(mn, mx, [5, 5, 5], [6, 6, 6])
