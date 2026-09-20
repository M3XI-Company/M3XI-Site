"""The visibility carve — the stage that stops the product lying.

These tests build synthetic rooms and synthetic cameras with exact depth maps,
so the expected answer is known by construction rather than by inspection.
"""
from __future__ import annotations

import math

import numpy as np
import pytest

from worldengine.geometry import world_pose_to_cv_extrinsics
from worldengine.stages import regions as RG


def cam(pos, quat=(0.0, 0.0, 0.0, 1.0), fx=400.0, w=640, h=480) -> dict:
    return {"frame_id": "c", "position": list(pos), "orientation": list(quat),
            "fx": fx, "fy": fx, "cx": w / 2, "cy": h / 2, "width": w, "height": h}


def exact_depth(camera: dict, world_fn) -> np.ndarray:
    """Render an exact z-depth map for a scene described by `world_fn(dirs)`."""
    w, h = camera["width"], camera["height"]
    yy, xx = np.mgrid[0:h, 0:w]
    x = (xx - camera["cx"]) / camera["fx"]
    y = (yy - camera["cy"]) / camera["fy"]
    return world_fn(x, y)


def test_voxel_grid_covers_the_bounds():
    centres, shape = RG.voxel_grid([0, 0, 0], [1.0, 0.5, 2.0], 0.25)
    assert shape == (4, 2, 8)
    assert centres.shape == (64, 3)
    assert centres[:, 0].min() == pytest.approx(0.125)
    assert centres[:, 2].max() == pytest.approx(1.875)


def test_frustum_only_carve_sees_everything_in_view():
    """With no depth map the test degenerates to frustum membership. That
    over-claims, which is exactly why run() refuses to proceed without depth."""
    centres, _ = RG.voxel_grid([-1, -1, -5], [1, 1, -1], 0.25)
    c = cam((0, 0, 0))
    seen = RG.carve_one_camera(centres, c, None)
    assert seen.any()
    # Everything in front and inside the image must be marked seen.
    assert seen.mean() > 0.9


def test_depth_carve_excludes_what_is_behind_a_wall():
    """A wall at 3 m in front of the camera. Voxels nearer than the wall are
    observed; voxels behind it are not, even though they are in the frustum.
    This is the occlusion test that makes 'unobserved' mean something."""
    c = cam((0, 0, 0))
    depth = np.full((c["height"], c["width"]), 3.0, dtype=np.float32)
    centres, _ = RG.voxel_grid([-0.5, -0.5, -5.0], [0.5, 0.5, -1.0], 0.25)
    seen = RG.carve_one_camera(centres, c, depth)
    # Our camera looks down -Z, so a voxel at z = -2 is 2 m in front.
    near = centres[:, 2] > -3.0 + RG.DEPTH_TOL_M
    far = centres[:, 2] < -3.0 - RG.DEPTH_TOL_M
    assert seen[near].all()
    assert not seen[far].any()


def test_carve_requires_multiple_observations():
    c = cam((0, 0, 0))
    depth = np.full((c["height"], c["width"]), 10.0, dtype=np.float32)
    centres, _ = RG.voxel_grid([-0.5, -0.5, -3.0], [0.5, 0.5, -1.0], 0.25)
    once = RG.carve(centres, [c], [depth], min_observations=2)
    twice = RG.carve(centres, [c, c], [depth, depth], min_observations=2)
    assert not once.any(), "one camera is a coincidence, not an observation"
    assert twice.any()


def test_carve_rejects_mismatched_inputs():
    with pytest.raises(ValueError):
        RG.carve(np.zeros((2, 3)), [cam((0, 0, 0))], [])


def test_interior_mask_follows_the_room_polygon_and_height_band():
    room = {"id": "r", "polygon": [(0, 0), (0, 3), (4, 3), (4, 0)],
            "floor_z": 0.0, "ceiling_z": 2.4}
    centres = np.array([[2.0, 1.0, 1.5],     # inside
                        [5.0, 1.0, 1.5],     # outside in XZ
                        [2.0, 3.0, 1.5],     # above the ceiling
                        [2.0, -0.5, 1.5]])   # below the floor
    m = RG.interior_mask(centres, [room])
    assert list(m) == [True, False, False, False]


def test_room_of_voxels_assigns_each_voxel_to_one_room():
    a = {"id": "a", "polygon": [(0, 0), (0, 3), (4, 3), (4, 0)],
         "floor_z": 0.0, "ceiling_z": 2.4}
    b = {"id": "b", "polygon": [(4, 0), (4, 3), (7, 3), (7, 0)],
         "floor_z": 0.0, "ceiling_z": 2.4}
    centres = np.array([[1.0, 1.0, 1.0], [5.5, 1.0, 1.0], [9.0, 1.0, 1.0]])
    idx = RG.room_of_voxels(centres, [a, b])
    assert list(idx) == [0, 1, -1]


def test_merge_to_boxes_finds_separate_components():
    centres, shape = RG.voxel_grid([0, 0, 0], [1.0, 0.5, 1.0], 0.25)
    nx, ny, nz = shape
    grid = np.zeros(shape, dtype=bool)
    grid[0:2, :, 0:2] = True        # one blob in a corner
    grid[3, :, 3] = True            # a single isolated voxel, too small
    boxes = RG.merge_to_boxes(centres, grid.reshape(-1), shape, 0.25,
                              min_volume=0.05)
    assert len(boxes) == 1
    mn, mx, count = boxes[0]
    assert count == 2 * ny * 2
    assert mn[0] == pytest.approx(0.0) and mx[0] == pytest.approx(0.5)


def test_merge_to_boxes_drops_noise_below_the_volume_floor():
    centres, shape = RG.voxel_grid([0, 0, 0], [1, 1, 1], 0.25)
    grid = np.zeros(shape, dtype=bool)
    grid[1, 1, 1] = True            # 0.015 m3, below the 0.08 m3 floor
    assert RG.merge_to_boxes(centres, grid.reshape(-1), shape, 0.25) == []


def test_a_room_the_cameras_never_entered_is_carved_as_unobserved():
    """The scenario the whole stage exists for: two rooms, cameras only in one.
    The second room must come out almost entirely unobserved."""
    living = {"id": "rm_0", "polygon": [(0, 0), (0, 3), (4, 3), (4, 0)],
              "floor_z": 0.0, "ceiling_z": 2.4}
    hidden = {"id": "rm_1", "polygon": [(4, 0), (4, 3), (7, 3), (7, 0)],
              "floor_z": 0.0, "ceiling_z": 2.4}
    centres, shape = RG.voxel_grid([0, 0, 0], [7, 2.4, 3], 0.25)

    # Four cameras spread around the living room, each seeing 3.5 m of depth,
    # which reaches the dividing wall at x = 4 but not beyond it.
    cams, depths = [], []
    for (x, z) in ((1.0, 1.0), (1.0, 2.0), (3.0, 1.0), (3.0, 2.0)):
        # Look along +X (towards the wall): a -90 degree turn about Y from the
        # default -Z view direction.
        s = math.sin(-math.pi / 4)
        c = math.cos(-math.pi / 4)
        cm = cam((x, 1.2, z), quat=(0.0, s, 0.0, c), fx=200.0, w=640, h=480)
        cams.append(cm)
        depths.append(np.full((480, 640), 4.0 - x, dtype=np.float32))

    observed = RG.carve(centres, cams, depths, min_observations=2)
    idx = RG.room_of_voxels(centres, [living, hidden])
    living_seen = observed[idx == 0].mean()
    hidden_seen = observed[idx == 1].mean()
    assert living_seen > 0.25
    assert hidden_seen == 0.0, "nothing past the wall may count as observed"


def test_depth_scaling_matters():
    """Depth comes from MapAnything's frame and must be multiplied by the metric
    scale factor before the carve, or every occlusion test is wrong by that
    factor. This checks the carve is sensitive to it."""
    c = cam((0, 0, 0))
    centres, _ = RG.voxel_grid([-0.5, -0.5, -5.0], [0.5, 0.5, -1.0], 0.25)
    raw = np.full((c["height"], c["width"]), 2.0, dtype=np.float32)
    unscaled = RG.carve_one_camera(centres, c, raw)
    scaled = RG.carve_one_camera(centres, c, raw * 2.0)
    assert scaled.sum() > unscaled.sum()
