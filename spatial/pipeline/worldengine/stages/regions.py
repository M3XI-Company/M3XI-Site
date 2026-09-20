"""regions — what the cameras never saw.

This is the stage that stops the product lying. A reconstruction fills gaps: the
TSDF closes a surface behind a wardrobe, RoomFormer closes a polygon across a
doorway it only glimpsed, and the result looks exactly like a room somebody
walked into. If that is published without qualification then a buyer is being
shown a room that does not exist as depicted, which under the DMCC Act 2024 is
a misleading representation and is directly enforceable.

So the carve: a voxel grid over the reconstructed volume, and for every voxel,
the question "did any camera actually see this?". A voxel is `observed` when it
falls inside some camera's frustum AND the rendered depth along that ray puts
the surface at or behind the voxel — i.e. nothing occluded it. Everything else
inside the building envelope is emitted as an explicit unobserved Region with
provenance `inferred`, and anything the pipeline filled in with no support at
all is `generated`.

The carve is plain geometry, so it is implemented in numpy and runs correctly
on any machine; torch is used when present purely for speed. That is not a
fallback in the sense this pipeline forbids — there is no model here and no
approximation, only the same arithmetic on different hardware.
"""
from __future__ import annotations

import json
import logging
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Iterable, Sequence

import numpy as np

from ..geometry import points_in_ring, world_pose_to_cv_extrinsics
from ..logging_setup import get_logger, log
from ..runner import RunContext, StageError

LOG = get_logger("worldengine.regions")

SUMMARY = "Frustum/visibility carve over the reconstructed volume; emit unobserved volumes"
# No GPU: the carve is projection arithmetic over depth maps that already
# exist on disk, and numpy does 16 million point projections in a couple of
# seconds. Claiming a GPU here would bill for an idle device.
USES_GPU = False
PRODUCES = ("regions.json", "occupancy.npz")

# Voxel size for the carve. 0.15 m is coarse enough that a 70 m2 flat with a
# 2.6 m ceiling is ~54k voxels (fast, and small enough to ship the occupancy
# grid in the export bundle) and fine enough to resolve the gap behind a
# wardrobe, which is the thing this exists to find.
VOXEL_M = 0.15
# Depth tolerance when testing occlusion. 0.12 m absorbs the splat's own depth
# error without letting a voxel 40 cm behind a wall count as seen.
DEPTH_TOL_M = 0.12
# A voxel needs this many camera observations to count as observed. One camera
# at a grazing angle is not observation, it is a coincidence.
MIN_OBSERVATIONS = 2
# Unobserved voxels are merged into boxes for the world document; isolated ones
# below this volume are noise rather than a hidden cupboard.
MIN_REGION_VOLUME_M3 = 0.08
# A room with more than this fraction unobserved is not a room the tour can
# honestly show; it is flagged and the quality gate counts it.
ROOM_UNOBSERVED_WARN = 0.35


@dataclass(slots=True)
class Input:
    rooms: list[dict[str, Any]]
    cameras: list[dict[str, Any]]
    depth_dir: str
    fused_cloud_path: str
    floor_elevations: list[float]
    ceiling_elevation: float
    scale_factor: float
    voxel_m: float = VOXEL_M


@dataclass(slots=True)
class RegionBox:
    id: str
    provenance: str
    min: list[float]
    max: list[float]
    room_id: str | None
    reason: str
    confidence: float


@dataclass(slots=True)
class Output:
    regions: list[RegionBox]
    regions_path: str
    occupancy_path: str
    voxel_m: float
    observed_voxels: int
    interior_voxels: int
    unobserved_fraction: float
    per_room_unobserved: dict[str, float]
    warnings: list[str] = field(default_factory=list)


def build_input(ctx: RunContext, upstream: dict[str, Any]) -> Input:
    mesh = upstream.get("mesh") or {}
    graph = upstream.get("graph") or {}
    lay = ctx.store.load("layout") or {}
    pose = ctx.store.load("pose") or {}
    scale = ctx.store.load("scale") or {}
    if not lay.get("rooms"):
        raise StageError("regions requires the layout stage artefact")
    if not pose.get("cameras"):
        raise StageError("regions requires the pose stage artefact")
    return Input(
        rooms=list(lay["rooms"]), cameras=list(pose["cameras"]),
        depth_dir=str(pose["depth_dir"]),
        fused_cloud_path=str(mesh.get("fused_cloud_path", "")),
        floor_elevations=list(mesh.get("floor_elevations", [0.0])),
        ceiling_elevation=float(mesh.get("ceiling_elevation", 2.4)),
        scale_factor=float(scale.get("scale_factor", 1.0)),
        voxel_m=float(ctx.param("region_voxel_m", VOXEL_M)),
    )


# ---------------------------------------------------------------------------
# The carve — pure numpy, tested against synthetic cameras
# ---------------------------------------------------------------------------

def voxel_grid(bounds_min: Sequence[float], bounds_max: Sequence[float],
               voxel: float) -> tuple[np.ndarray, tuple[int, int, int]]:
    """Voxel centres and the grid shape, in (nx, ny, nz) order."""
    mn = np.asarray(bounds_min, dtype=np.float64)
    mx = np.asarray(bounds_max, dtype=np.float64)
    dims = np.maximum(1, np.ceil((mx - mn) / voxel).astype(int))
    axes = [mn[i] + (np.arange(dims[i]) + 0.5) * voxel for i in range(3)]
    gx, gy, gz = np.meshgrid(*axes, indexing="ij")
    centres = np.stack([gx.ravel(), gy.ravel(), gz.ravel()], axis=1)
    return centres, (int(dims[0]), int(dims[1]), int(dims[2]))


def carve_one_camera(centres: np.ndarray, camera: dict[str, Any],
                     depth: np.ndarray | None, *, tol: float = DEPTH_TOL_M,
                     max_range: float = 12.0) -> np.ndarray:
    """Boolean mask of voxels this camera actually observed.

    A voxel is observed when it projects inside the image, lies in front of the
    camera within max_range, and the measured depth at that pixel is at least
    the voxel's own depth minus `tol`. If the measured depth is shorter, some
    surface occluded the voxel and the camera did not see it.

    With no depth map the test degenerates to frustum membership, which
    over-claims observation. That is why depth is required by the caller and
    this signature makes the degenerate case explicit rather than silent.
    """
    R_cw, t_cw = world_pose_to_cv_extrinsics(camera["position"], camera["orientation"])
    p_cam = centres @ R_cw.T + t_cw
    z = p_cam[:, 2]
    front = (z > 0.05) & (z < max_range)
    u = np.full(len(centres), -1.0)
    v = np.full(len(centres), -1.0)
    u[front] = camera["fx"] * p_cam[front, 0] / z[front] + camera["cx"]
    v[front] = camera["fy"] * p_cam[front, 1] / z[front] + camera["cy"]
    w, h = int(camera["width"]), int(camera["height"])
    inside = front & (u >= 0) & (u < w) & (v >= 0) & (v < h)
    if depth is None:
        return inside
    dh, dw = depth.shape[:2]
    cols = np.clip((u * dw / w).astype(np.int32), 0, dw - 1)
    rows = np.clip((v * dh / h).astype(np.int32), 0, dh - 1)
    measured = depth[rows, cols]
    valid = np.isfinite(measured) & (measured > 0.05)
    return inside & valid & (z <= measured + tol)


def carve(centres: np.ndarray, cameras: Sequence[dict[str, Any]],
          depths: Sequence[np.ndarray | None], *,
          min_observations: int = MIN_OBSERVATIONS,
          tol: float = DEPTH_TOL_M) -> np.ndarray:
    """Observation count per voxel, thresholded into an observed mask."""
    if len(cameras) != len(depths):
        raise ValueError("cameras and depths must be the same length")
    counts = np.zeros(len(centres), dtype=np.int32)
    for cam, d in zip(cameras, depths):
        counts += carve_one_camera(centres, cam, d, tol=tol).astype(np.int32)
    return counts >= min_observations


def interior_mask(centres: np.ndarray, rooms: Sequence[dict[str, Any]]) -> np.ndarray:
    """Voxels inside some room's extruded polygon. The carve is only meaningful
    inside the building: unobserved space in the garden is not a hidden room."""
    out = np.zeros(len(centres), dtype=bool)
    for r in rooms:
        band = (~out & (centres[:, 1] >= r["floor_z"])
                & (centres[:, 1] <= r["ceiling_z"]))
        if not band.any():
            continue
        out[band] = points_in_ring(centres[band][:, [0, 2]], r["polygon"])
    return out


def room_of_voxels(centres: np.ndarray, rooms: Sequence[dict[str, Any]]) -> np.ndarray:
    """Index of the containing room per voxel, -1 for none. First room wins,
    which matters only where two room polygons overlap — itself a layout bug
    the quality gate should have caught."""
    out = np.full(len(centres), -1, dtype=np.int32)
    for k, r in enumerate(rooms):
        band = ((out < 0) & (centres[:, 1] >= r["floor_z"])
                & (centres[:, 1] <= r["ceiling_z"]))
        if not band.any():
            continue
        idx = np.nonzero(band)[0]
        hit = points_in_ring(centres[idx][:, [0, 2]], r["polygon"])
        out[idx[hit]] = k
    return out


def merge_to_boxes(centres: np.ndarray, mask: np.ndarray, shape: tuple[int, int, int],
                   voxel: float, *, min_volume: float = MIN_REGION_VOLUME_M3
                   ) -> list[tuple[list[float], list[float], int]]:
    """Connected components of the masked voxels, as AABBs with voxel counts.

    6-connected flood fill on the grid. Boxes rather than exact hulls because
    the world contract's Region carries an Aabb, and because the viewer's job
    is to shade a volume, not to trace its outline.
    """
    nx, ny, nz = shape
    grid = mask.reshape(nx, ny, nz)
    seen = np.zeros_like(grid, dtype=bool)
    boxes: list[tuple[list[float], list[float], int]] = []
    idxs = np.argwhere(grid)
    for start in idxs:
        si, sj, sk = (int(v) for v in start)
        if seen[si, sj, sk]:
            continue
        stack = [(si, sj, sk)]
        seen[si, sj, sk] = True
        cells: list[tuple[int, int, int]] = []
        while stack:
            i, j, k = stack.pop()
            cells.append((i, j, k))
            for di, dj, dk in ((1, 0, 0), (-1, 0, 0), (0, 1, 0),
                               (0, -1, 0), (0, 0, 1), (0, 0, -1)):
                a, b, c = i + di, j + dj, k + dk
                if 0 <= a < nx and 0 <= b < ny and 0 <= c < nz \
                        and grid[a, b, c] and not seen[a, b, c]:
                    seen[a, b, c] = True
                    stack.append((a, b, c))
        if len(cells) * voxel ** 3 < min_volume:
            continue
        flat = np.array([i * ny * nz + j * nz + k for i, j, k in cells])
        pts = centres[flat]
        boxes.append(([float(v) for v in pts.min(axis=0) - voxel / 2.0],
                      [float(v) for v in pts.max(axis=0) + voxel / 2.0],
                      len(cells)))
    return boxes


def run(inp: Input, ctx: RunContext) -> Output:
    if not inp.rooms:
        raise StageError("regions has no rooms to carve inside")

    xs = [p[0] for r in inp.rooms for p in r["polygon"]]
    zs = [p[1] for r in inp.rooms for p in r["polygon"]]
    y0 = min(float(r["floor_z"]) for r in inp.rooms)
    y1 = max(float(r["ceiling_z"]) for r in inp.rooms)
    centres, shape = voxel_grid([min(xs), y0, min(zs)], [max(xs), y1, max(zs)],
                                inp.voxel_m)
    log(LOG, logging.INFO, "regions.grid", voxels=int(len(centres)), shape=list(shape))

    depth_dir = Path(inp.depth_dir)
    depths: list[np.ndarray | None] = []
    cams: list[dict[str, Any]] = []
    for c in inp.cameras:
        p = depth_dir / f"{c['frame_id']}.npz"
        if not p.exists():
            continue
        # Depth was written in MapAnything's frame; the world was scaled to
        # metres in the splat stage, so the depth has to follow.
        depths.append(np.load(p)["depth"].astype(np.float32) * inp.scale_factor)
        cams.append(c)
    if not cams:
        raise StageError(
            f"no depth maps found in {depth_dir}; the visibility carve cannot "
            "be done from frusta alone without claiming that every voxel in "
            "view was observed, which is exactly the lie this stage exists to "
            "prevent."
        )

    observed = carve(centres, cams, depths)
    inside = interior_mask(centres, inp.rooms)
    room_idx = room_of_voxels(centres, inp.rooms)

    unobserved = inside & ~observed
    interior_n = int(inside.sum())
    observed_n = int((inside & observed).sum())
    frac = 1.0 - (observed_n / float(max(1, interior_n)))

    per_room: dict[str, float] = {}
    for k, r in enumerate(inp.rooms):
        sel = room_idx == k
        n = int(sel.sum())
        per_room[r["id"]] = float(1.0 - (int((sel & observed).sum()) / max(1, n)))

    regions: list[RegionBox] = []
    for i, (mn, mx, count) in enumerate(merge_to_boxes(centres, unobserved, shape,
                                                       inp.voxel_m)):
        centre = [(a + b) / 2.0 for a, b in zip(mn, mx)]
        k = int(room_idx[int(np.argmin(np.linalg.norm(centres - np.array(centre), axis=1)))])
        rid = inp.rooms[k]["id"] if 0 <= k < len(inp.rooms) else None
        regions.append(RegionBox(
            id=f"reg_{i:04d}", provenance="inferred", min=mn, max=mx, room_id=rid,
            reason=f"no camera observed this volume ({count} voxels at "
                   f"{inp.voxel_m:.2f} m); geometry here is filled, not measured",
            # Confidence here is confidence in the *claim of unobservedness*,
            # which is high: it is a counting argument over real depth maps.
            confidence=0.9))

    # Rooms whose polygon exists but which no camera ever entered are the
    # dangerous case: RoomFormer closed them from a doorway. They are recorded
    # as whole-room generated volumes so the viewer can grey them out and the
    # agent can refuse to answer inside them.
    for k, r in enumerate(inp.rooms):
        if r.get("provenance") == "inferred" and not r.get("camera_ids"):
            xs_r = [p[0] for p in r["polygon"]]
            zs_r = [p[1] for p in r["polygon"]]
            regions.append(RegionBox(
                id=f"reg_gen_{k:03d}", provenance="generated",
                min=[min(xs_r), float(r["floor_z"]), min(zs_r)],
                max=[max(xs_r), float(r["ceiling_z"]), max(zs_r)],
                room_id=r["id"],
                reason="no camera entered this room; its extent was closed by the "
                       "layout model and nothing observed supports it",
                confidence=0.5))

    # And the observed interior, recorded positively, so a viewer can shade
    # what IS supported rather than only what is not.
    obs_boxes = merge_to_boxes(centres, inside & observed, shape, inp.voxel_m,
                               min_volume=0.5)
    for i, (mn, mx, count) in enumerate(obs_boxes):
        regions.append(RegionBox(id=f"reg_obs_{i:04d}", provenance="observed",
                                 min=mn, max=mx, room_id=None,
                                 reason=f"observed by at least {MIN_OBSERVATIONS} "
                                        f"cameras ({count} voxels)",
                                 confidence=0.95))

    occ_path = ctx.out("occupancy.npz")
    np.savez_compressed(occ_path, observed=observed.reshape(shape),
                        interior=inside.reshape(shape),
                        voxel=inp.voxel_m,
                        origin=np.array([min(xs), y0, min(zs)], dtype=np.float32))
    reg_path = ctx.out("regions.json")
    reg_path.write_text(json.dumps([asdict(r) for r in regions], indent=1, default=float))

    warnings: list[str] = []
    bad = {k: v for k, v in per_room.items() if v > ROOM_UNOBSERVED_WARN}
    if bad:
        warnings.append(f"{len(bad)} room(s) over {ROOM_UNOBSERVED_WARN:.0%} "
                        f"unobserved: {sorted(bad)[:5]}")

    out = Output(regions=regions, regions_path=str(reg_path),
                 occupancy_path=str(occ_path), voxel_m=inp.voxel_m,
                 observed_voxels=observed_n, interior_voxels=interior_n,
                 unobserved_fraction=float(frac), per_room_unobserved=per_room,
                 warnings=warnings)
    log(LOG, logging.INFO, "regions.ok", interior=interior_n, observed=observed_n,
        unobserved_fraction=round(frac, 4), regions=len(regions))
    return out
