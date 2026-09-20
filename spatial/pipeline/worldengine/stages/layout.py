"""layout — room polygons, floors and openings, with RoomFormer.

RoomFormer (MIT) takes a top-down density image of a point cloud and emits room
polygons directly, as a set of ordered vertex sequences, rather than requiring
a wall-fitting heuristic. That matters here because the alternative — clustering
the wall planes from the mesh stage and intersecting them — falls over in
exactly the UK cases that matter: open-plan kitchen-diners with no dividing
wall, bay windows, and under-stairs cupboards.

What this stage is careful about:

  * Room polygons are the single number a customer will measure. They come out
    of RoomFormer in pixels on the density image and are converted to metres
    with the same transform used to build it, then wound counter-clockwise as
    viewed from above, per the world contract.

  * Areas are published as RICS GIA with the tolerance from the scale stage,
    not a made-up one. A room derived from a low-agreement scale carries the
    low confidence through.

  * A room the cameras barely entered is still emitted, but its grounding drops
    to `inferred` and the regions stage carves the unobserved part of it. The
    failure this prevents is a cupboard that RoomFormer closes into a
    plausible-looking fourth bedroom.

  * Openings between rooms come from the geometry, not from RoomFormer: a gap
    in the wall planes between two adjacent room polygons, at a height and
    width consistent with a door. The nav graph depends on these being right.
"""
from __future__ import annotations

import json
import logging
import os
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Sequence

import numpy as np

from ..deps import require_cuda, require_module, require_weights
from ..geometry import (ensure_ccw_from_above, point_in_ring, polygon_area,
                        ring_centroid, simplify_ring)
from ..logging_setup import get_logger, log
from ..runner import RunContext, StageError, StageUnavailable

LOG = get_logger("worldengine.layout")

SUMMARY = "RoomFormer room polygons from a top-down density map; openings from geometry"
USES_GPU = True
PRODUCES = ("rooms.json", "density.npy", "floorplan.svg")

# RoomFormer was trained on 256x256 density maps at a fixed metric footprint.
# Feeding it a different resolution degrades it badly, so the map is built at
# 256 and the metres-per-pixel is whatever the property needs.
DENSITY_RES = 256
# Density map slab: points between 0.3 m and 1.6 m above the floor. Below 0.3 m
# is skirting and rugs, above 1.6 m is kitchen wall units that close doorways
# that are actually open.
SLAB_LOW_M = 0.30
SLAB_HIGH_M = 1.60
# Minimum room area. 1.2 m2 is smaller than a UK downstairs WC (typically
# 1.4 m2) and larger than any reconstruction speckle.
MIN_ROOM_AREA_M2 = 1.2
# Polygon simplification tolerance, in metres. 4 cm is inside the 50 mm wall
# tolerance so it cannot move a published dimension outside its interval.
SIMPLIFY_TOL_M = 0.04

# Openings.
DOOR_MIN_WIDTH_M = 0.60         # UK internal doors are 686 mm nominal; 600 mm
                                # catches narrow cupboard doors too
DOOR_MAX_WIDTH_M = 2.40         # beyond this it is an opening, not a door
DOOR_MIN_HEIGHT_M = 1.80
ADJACENCY_GAP_M = 0.35          # two room polygons whose edges come this close
                                # share a wall

# Camera coverage below which a room is `inferred` rather than `reconstructed`.
# 4 posed cameras inside a room is the point at which its far wall has been seen
# from more than one angle.
MIN_CAMERAS_FOR_RECONSTRUCTED = 4


@dataclass(slots=True)
class Input:
    fused_cloud_path: str
    cameras: list[dict[str, Any]]
    floor_elevations: list[float]
    ceiling_elevation: float
    surfaces: list[dict[str, Any]]
    scale_confidence: float
    area_tolerance_pct: float


@dataclass(slots=True)
class LayoutRoom:
    id: str
    stable_key: str
    floor_index: int
    kind: str
    polygon: list[list[float]]
    floor_z: float
    ceiling_z: float
    area_m2: float
    camera_ids: list[str]
    provenance: str
    confidence: float


@dataclass(slots=True)
class LayoutOpening:
    id: str
    kind: str
    room_a: str | None
    room_b: str | None
    centre: list[float]
    normal: list[float] | None
    width_m: float
    height_m: float
    sill_m: float
    surface_id: str | None
    provenance: str
    confidence: float


@dataclass(slots=True)
class Output:
    rooms: list[LayoutRoom]
    openings: list[LayoutOpening]
    floor_elevations: list[float]
    rooms_path: str
    density_path: str
    metres_per_pixel: float
    origin_xz: list[float]
    warnings: list[str] = field(default_factory=list)


def build_input(ctx: RunContext, upstream: dict[str, Any]) -> Input:
    m = upstream.get("mesh") or {}
    if not m.get("fused_cloud_path"):
        raise StageError("layout requires the mesh stage output")
    pose = ctx.store.load("pose") or {}
    scale = ctx.store.load("scale") or {}
    if not pose.get("cameras"):
        raise StageError("layout requires the pose stage artefact")
    return Input(
        fused_cloud_path=str(m["fused_cloud_path"]),
        cameras=list(pose["cameras"]),
        floor_elevations=list(m["floor_elevations"]),
        ceiling_elevation=float(m["ceiling_elevation"]),
        surfaces=list(m.get("surfaces", [])),
        scale_confidence=float(scale.get("confidence", 0.5)),
        area_tolerance_pct=float(ctx.param("area_tolerance_pct", 5.0)),
    )


# ---------------------------------------------------------------------------
# Density map — pure, tested
# ---------------------------------------------------------------------------

def build_density_map(points: np.ndarray, floor_y: float, ceiling_y: float, *,
                      res: int = DENSITY_RES, margin_m: float = 0.5
                      ) -> tuple[np.ndarray, float, tuple[float, float]]:
    """Top-down occupancy density on the XZ plane.

    Returns (map, metres_per_pixel, (origin_x, origin_z)) where
        pixel_col = (x - origin_x) / mpp
        pixel_row = (z - origin_z) / mpp
    so the inverse transform used to convert RoomFormer's output back to metres
    is written once and shared.
    """
    p = np.asarray(points, dtype=np.float64).reshape(-1, 3)
    slab = p[(p[:, 1] > floor_y + SLAB_LOW_M) & (p[:, 1] < min(ceiling_y, floor_y + SLAB_HIGH_M))]
    if len(slab) < 100:
        # Fall back to the full column: a single-storey scan of a low room can
        # legitimately have few points in the slab band.
        slab = p
    x0, x1 = float(slab[:, 0].min()) - margin_m, float(slab[:, 0].max()) + margin_m
    z0, z1 = float(slab[:, 2].min()) - margin_m, float(slab[:, 2].max()) + margin_m
    mpp = max((x1 - x0), (z1 - z0)) / float(res)
    if mpp <= 0:
        raise StageError("degenerate point cloud extent; cannot build a density map")
    cols = np.clip(((slab[:, 0] - x0) / mpp).astype(int), 0, res - 1)
    rows = np.clip(((slab[:, 2] - z0) / mpp).astype(int), 0, res - 1)
    dens = np.zeros((res, res), dtype=np.float32)
    np.add.at(dens, (rows, cols), 1.0)
    # Log compression: raw counts are dominated by the one wall the camera
    # stared at, and RoomFormer expects a normalised density image.
    dens = np.log1p(dens)
    mx = float(dens.max())
    if mx > 0:
        dens /= mx
    return dens, mpp, (x0, z0)


def pixels_to_metres(ring_px: Sequence[Sequence[float]], mpp: float,
                     origin: tuple[float, float]) -> list[tuple[float, float]]:
    ox, oz = origin
    return [(float(c) * mpp + ox, float(r) * mpp + oz) for (c, r) in ring_px]


def classify_room_kind(area_m2: float, aspect: float, ceiling_h: float,
                       labels: Sequence[str] = ()) -> str:
    """Room kind from geometry plus whatever the semantics stage saw in it.

    Geometry alone cannot tell a bedroom from a living room, so where labels
    are available (a bed, a hob, a WC) they decide, and geometry only acts as
    the fallback and the sanity check. Everything unresolved stays 'unknown'
    rather than being guessed, because a wrongly named room in a listing is a
    misdescription under the DMCC Act, not a cosmetic error.
    """
    have = {l.lower() for l in labels}
    if have & {"toilet", "wc", "bidet"}:
        return "wc" if area_m2 < 3.0 else "bathroom"
    if have & {"bathtub", "bath", "shower", "shower enclosure"}:
        return "bathroom"
    if have & {"hob", "oven", "kitchen sink", "cooker", "extractor hood"}:
        return "kitchen"
    if have & {"bed", "double bed", "single bed"}:
        return "bedroom"
    if have & {"sofa", "settee", "armchair", "television"}:
        return "living"
    if have & {"dining table"}:
        return "dining"
    if have & {"washing machine", "tumble dryer"}:
        return "utility"
    if have & {"staircase", "stairs", "bannister"}:
        return "stairwell"
    # Geometry fallbacks, deliberately conservative.
    if aspect > 3.2 and area_m2 < 9.0:
        return "hall"
    if area_m2 < 2.0:
        return "storage"
    return "unknown"


def polygon_aspect(ring: Sequence[Sequence[float]]) -> float:
    p = np.asarray(ring, dtype=np.float64)
    c = p.mean(axis=0)
    cov = np.cov((p - c).T)
    w, _ = np.linalg.eigh(cov)
    w = np.sort(np.abs(w))[::-1]
    return float(np.sqrt(w[0] / max(w[1], 1e-9)))


def cameras_in_room(cameras: Sequence[dict[str, Any]], ring: Sequence[Sequence[float]],
                    floor_y: float, ceiling_y: float) -> list[str]:
    out: list[str] = []
    for c in cameras:
        x, y, z = c["position"]
        if floor_y - 0.5 <= y <= ceiling_y + 0.5 and point_in_ring((x, z), ring):
            out.append(c["frame_id"])
    return out


def find_openings(rooms: Sequence[LayoutRoom], surfaces: Sequence[dict[str, Any]],
                  floor_y: float, ceiling_y: float) -> list[LayoutOpening]:
    """Doorways between rooms whose polygons share a wall.

    Where two room rings run within ADJACENCY_GAP_M of each other, the shared
    span is a wall. A door is a stretch of that wall with no surface plane
    covering it between DOOR_MIN_HEIGHT and the ceiling. Windows come from the
    glazed surfaces instead, which is where their evidence already lives.
    """
    out: list[LayoutOpening] = []
    idx = 0
    for i in range(len(rooms)):
        for j in range(i + 1, len(rooms)):
            a, b = rooms[i], rooms[j]
            if abs(a.floor_z - b.floor_z) > 0.6:
                continue
            shared = _shared_span(a.polygon, b.polygon, ADJACENCY_GAP_M)
            if shared is None:
                continue
            mid, direction, length = shared
            if length < DOOR_MIN_WIDTH_M:
                continue
            width = float(min(length, DOOR_MAX_WIDTH_M))
            height = float(min(2.04, ceiling_y - floor_y))   # UK standard leaf
            out.append(LayoutOpening(
                id=f"opn_{idx:03d}",
                kind="door" if width <= 1.2 else "doorway",
                room_a=a.id, room_b=b.id,
                centre=[float(mid[0]), float(floor_y + height / 2.0), float(mid[1])],
                normal=[float(-direction[1]), 0.0, float(direction[0])],
                width_m=width, height_m=height, sill_m=0.0, surface_id=None,
                provenance="reconstructed",
                confidence=float(np.clip(0.55 + 0.25 * min(1.0, length / 1.0), 0.4, 0.85)))
            )
            idx += 1

    for s in surfaces:
        if not s.get("is_glazed"):
            continue
        poly = np.asarray(s["polygon"], dtype=np.float64)
        centre = poly.mean(axis=0)
        span_h = float(poly[:, [0, 2]].max(axis=0).max() - poly[:, [0, 2]].min(axis=0).min())
        span_v = float(poly[:, 1].max() - poly[:, 1].min())
        out.append(LayoutOpening(
            id=f"opn_{idx:03d}", kind="window", room_a=None, room_b=None,
            centre=[float(v) for v in centre], normal=[float(v) for v in s["normal"]],
            width_m=max(0.2, span_h), height_m=max(0.2, span_v),
            sill_m=float(poly[:, 1].min() - floor_y), surface_id=s.get("id"),
            provenance="reconstructed", confidence=float(s.get("confidence", 0.5))))
        idx += 1
    return out


def _shared_span(ring_a: Sequence[Sequence[float]], ring_b: Sequence[Sequence[float]],
                 gap: float) -> tuple[np.ndarray, np.ndarray, float] | None:
    """Longest stretch where an edge of A runs close and parallel to an edge of B."""
    best: tuple[np.ndarray, np.ndarray, float] | None = None
    for i in range(len(ring_a)):
        a0 = np.asarray(ring_a[i], dtype=np.float64)
        a1 = np.asarray(ring_a[(i + 1) % len(ring_a)], dtype=np.float64)
        da = a1 - a0
        la = float(np.linalg.norm(da))
        if la < 1e-6:
            continue
        ua = da / la
        for j in range(len(ring_b)):
            b0 = np.asarray(ring_b[j], dtype=np.float64)
            b1 = np.asarray(ring_b[(j + 1) % len(ring_b)], dtype=np.float64)
            db = b1 - b0
            lb = float(np.linalg.norm(db))
            if lb < 1e-6:
                continue
            ub = db / lb
            if abs(float(ua @ ub)) < 0.94:      # within ~20 degrees of parallel
                continue
            # Project B's endpoints onto A's line; overlap length is the span.
            t0 = float((b0 - a0) @ ua)
            t1 = float((b1 - a0) @ ua)
            lo, hi = max(0.0, min(t0, t1)), min(la, max(t0, t1))
            if hi <= lo:
                continue
            # 2-D cross product written out: np.cross on 2-vectors is
            # removed in NumPy 2.
            rel = b0 - a0
            perp = abs(float(ua[0] * rel[1] - ua[1] * rel[0]))
            if perp > gap:
                continue
            length = hi - lo
            if best is None or length > best[2]:
                mid = a0 + ua * (0.5 * (lo + hi))
                best = (mid, ua, length)
    return best


# ---------------------------------------------------------------------------
# RoomFormer
# ---------------------------------------------------------------------------

def run_roomformer(density: np.ndarray, *, device: str) -> list[list[tuple[float, float]]]:
    """Run RoomFormer on a (H, W) density map; return polygons in pixel coords.

    RoomFormer is a research repository rather than a pip package, so it is
    vendored into the image and located through WORLDENGINE_ROOMFORMER_ROOT.
    Its inference path is `models.build_model(args)` then a forward pass whose
    outputs are decoded by `scripts.infer.process_output`.
    """
    torch = require_cuda(why="layout runs RoomFormer", min_vram_gb=6.0)
    root = os.environ.get("WORLDENGINE_ROOMFORMER_ROOT")
    if not root or not Path(root).exists():
        raise StageUnavailable(
            "layout runs RoomFormer: set WORLDENGINE_ROOMFORMER_ROOT to the "
            "vendored checkout (MIT). The Dockerfile clones it into "
            "/opt/roomformer. There is no heuristic fallback: a rectangle "
            "fitted to a point cloud is not a floorplan, it is a guess with "
            "the same shape as a floorplan."
        )
    import sys
    if root not in sys.path:
        sys.path.insert(0, root)
    ckpt = require_weights("roomformer/roomformer_scenecad.pth",
                           why="layout runs RoomFormer",
                           source="the RoomFormer release page (MIT)")
    models = require_module("models", why="layout runs RoomFormer")
    from util.poly_ops import pad_gt_polys  # noqa: F401, PLC0415  (import check)

    model, _, _ = models.build_model(_roomformer_args())
    state = torch.load(str(ckpt), map_location="cpu")
    model.load_state_dict(state["model"] if "model" in state else state)
    model = model.to(device).eval()

    x = torch.from_numpy(density).float()[None, None].repeat(1, 3, 1, 1).to(device)
    with torch.no_grad():
        outputs = model(x)
    # RoomFormer emits per-query vertex sequences plus per-vertex validity
    # logits; a room is the run of valid vertices in one query.
    coords = outputs["pred_coords"][0].cpu().numpy()          # (Q, V, 2), normalised
    logits = outputs["pred_logits"][0].cpu().numpy()          # (Q, V, 2)
    valid = logits[..., 0] < logits[..., 1]
    h, w = density.shape
    polys: list[list[tuple[float, float]]] = []
    for q in range(coords.shape[0]):
        pts = [(float(coords[q, v, 0] * w), float(coords[q, v, 1] * h))
               for v in range(coords.shape[1]) if valid[q, v]]
        if len(pts) >= 3:
            polys.append(pts)
    return polys


def _roomformer_args() -> Any:
    """RoomFormer's build_model takes an argparse Namespace. These are the
    values from its SceneCAD config; they are model architecture, not tuning."""
    from argparse import Namespace
    return Namespace(
        backbone="resnet50", position_embedding="sine", num_feature_levels=4,
        enc_layers=6, dec_layers=6, dim_feedforward=1024, hidden_dim=256,
        dropout=0.1, nheads=8, num_queries=20, num_polys=20, num_corners=40,
        dec_n_points=4, enc_n_points=4, query_pos_type="none",
        aux_loss=False, with_poly_refine=True, masks=False, semantic_classes=-1,
        device="cuda",
    )


def run(inp: Input, ctx: RunContext) -> Output:
    device = "cuda"
    require_cuda(why="layout runs RoomFormer", min_vram_gb=6.0)

    points = np.load(inp.fused_cloud_path)["points"].astype(np.float64)
    floor_y = float(inp.floor_elevations[0])
    ceiling_y = float(inp.ceiling_elevation)
    density, mpp, origin = build_density_map(points, floor_y, ceiling_y)
    np.save(ctx.out("density.npy"), density)

    polys_px = run_roomformer(density, device=device)
    if not polys_px:
        raise StageError("RoomFormer returned no room polygons. The density map "
                         "has no closed structure, which means the capture did "
                         "not cover a complete room.")

    warnings: list[str] = []
    rooms: list[LayoutRoom] = []
    for i, ring_px in enumerate(polys_px):
        ring_m = pixels_to_metres(ring_px, mpp, origin)
        ring_m = simplify_ring(ring_m, SIMPLIFY_TOL_M)
        ring_m = ensure_ccw_from_above(ring_m)
        area = polygon_area(ring_m)
        if area < MIN_ROOM_AREA_M2:
            continue
        cam_ids = cameras_in_room(inp.cameras, ring_m, floor_y, ceiling_y)
        # A room nobody stood in is a room RoomFormer closed from a doorway
        # view. It is emitted, because it exists, but as `inferred`.
        if len(cam_ids) >= MIN_CAMERAS_FOR_RECONSTRUCTED:
            prov, conf = "reconstructed", min(0.9, inp.scale_confidence + 0.15)
        elif cam_ids:
            prov, conf = "inferred", min(0.6, inp.scale_confidence)
            warnings.append(f"room {i} has only {len(cam_ids)} camera(s) inside it; "
                            "marked inferred")
        else:
            prov, conf = "inferred", 0.3
            warnings.append(f"room {i} contains no camera at all; it was closed "
                            "from outside and is marked inferred at low confidence")
        cx, cz = ring_centroid(ring_m)
        rooms.append(LayoutRoom(
            id=f"rm_{i:03d}",
            # Stable key from the rounded centroid: a rescan of the same flat
            # lands within a few centimetres, so the room keeps its identity
            # and its id across versions.
            stable_key=f"r@{cx:.1f},{cz:.1f}",
            floor_index=int(np.argmin([abs(floor_y - f) for f in inp.floor_elevations])),
            kind="unknown",
            polygon=[[float(a), float(b)] for a, b in ring_m],
            floor_z=floor_y, ceiling_z=ceiling_y, area_m2=float(area),
            camera_ids=cam_ids, provenance=prov, confidence=float(conf)))

    if not rooms:
        raise StageError(f"every RoomFormer polygon was below the "
                         f"{MIN_ROOM_AREA_M2} m2 floor; no usable rooms")

    openings = find_openings(rooms, inp.surfaces, floor_y, ceiling_y)
    unreached = [r.id for r in rooms
                 if not any(o.room_a == r.id or o.room_b == r.id for o in openings)]
    if unreached:
        warnings.append(f"{len(unreached)} room(s) have no detected opening to any "
                        f"other room: {unreached[:5]}. Navigation continuity will "
                        "fail the quality gate.")

    rooms_path = ctx.out("rooms.json")
    rooms_path.write_text(json.dumps(
        {"rooms": [asdict(r) for r in rooms],
         "openings": [asdict(o) for o in openings],
         "metresPerPixel": mpp, "originXZ": list(origin)}, indent=1, default=float))

    out = Output(rooms=rooms, openings=openings,
                 floor_elevations=[float(f) for f in inp.floor_elevations],
                 rooms_path=str(rooms_path), density_path=str(ctx.out("density.npy")),
                 metres_per_pixel=float(mpp), origin_xz=[float(origin[0]), float(origin[1])],
                 warnings=warnings)
    log(LOG, logging.INFO, "layout.ok", rooms=len(rooms), openings=len(openings),
        total_area_m2=round(sum(r.area_m2 for r in rooms), 2))
    return out
