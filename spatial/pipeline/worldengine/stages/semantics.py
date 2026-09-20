"""semantics — entities, tracked through the video and lifted onto the gaussians.

SAM 3.1 with text-prompt concepts, run as a video predictor so one sofa keeps
one mask id across the frames it appears in, then lifted into 3D through the
identity head the splat stage trained. The lift is what turns "a sofa in
fourteen frames" into "one sofa at these coordinates", which is the whole
difference between a tagged video and a spatial world.

The lifting method is Gaussian Grouping's, reimplemented on gsplat. The
original implementation sits on the Inria rasteriser and is therefore
research-only; the idea (a per-gaussian identity feature, rasterised alongside
colour and supervised by 2D masks) is not encumbered, so it is rebuilt here.
See stages/splat.py for the head itself.

Identity stability across frames is a published quality check, so it is
measured here rather than asserted: for each tracked object, the fraction of
frames in which the lifted 3D cluster reprojects onto the tracked 2D mask.
"""
from __future__ import annotations

import json
import logging
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Sequence

import numpy as np

from ..deps import require_cuda, require_module, require_weights
from ..geometry import point_in_ring, world_pose_to_cv_extrinsics
from ..logging_setup import get_logger, log
from ..runner import RunContext, StageError

LOG = get_logger("worldengine.semantics")

SUMMARY = "SAM 3.1 text-prompt concepts tracked through video, lifted to gaussians"
USES_GPU = True
PRODUCES = ("entities.json", "masks.npz")

# The concept list. Chosen for UK residential property and for what a buyer
# actually asks about: "is there a dishwasher", "does the bedroom fit a double",
# "is that a combi boiler". Prompts are singular nouns because SAM 3's concept
# head is trained on noun phrases.
CONCEPTS: dict[str, str] = {
    "sofa": "furniture", "armchair": "furniture", "dining table": "furniture",
    "dining chair": "furniture", "coffee table": "furniture", "bed": "furniture",
    "wardrobe": "furniture", "chest of drawers": "furniture", "bookshelf": "furniture",
    "desk": "furniture", "television": "appliance", "fridge freezer": "appliance",
    "washing machine": "appliance", "dishwasher": "appliance", "oven": "appliance",
    "hob": "appliance", "extractor hood": "appliance", "microwave": "appliance",
    "kitchen sink": "fixture", "bathroom basin": "fixture", "toilet": "fixture",
    "bathtub": "fixture", "shower enclosure": "fixture", "radiator": "fixture",
    "boiler": "fixture", "fireplace": "fixture", "staircase": "structure",
    "kitchen worktop": "fitting", "kitchen cabinet": "fitting",
    "curtain": "fitting", "blind": "fitting", "ceiling light": "fitting",
    "door": "structure", "window": "structure",
}

# SAM detection threshold. 0.45 keeps recall high on partly occluded furniture
# while staying above the level at which SAM starts proposing wall patches as
# objects.
CONCEPT_THRESHOLD = 0.45
# A track must survive this many frames to become an entity. Three frames of a
# walkthrough at 2.5 fps is over a second of continuous observation, which is
# enough to rule out a single-frame false positive without losing a fridge
# glimpsed through a doorway.
MIN_TRACK_FRAMES = 3
# Gaussians assigned to an entity by identity-feature similarity.
IDENTITY_SIM_THRESHOLD = 0.60
MIN_GAUSSIANS_PER_ENTITY = 40
# An entity whose gaussian cluster spans more than this is a lift failure
# (usually the identity head latched onto a wall texture), not a sofa.
MAX_ENTITY_EXTENT_M = 4.5


@dataclass(slots=True)
class Input:
    frames: list[dict[str, Any]]
    cameras: list[dict[str, Any]]
    ply_path: str
    identity_path: str
    rooms: list[dict[str, Any]]
    concepts: dict[str, str] = field(default_factory=lambda: dict(CONCEPTS))


@dataclass(slots=True)
class SemEntity:
    id: str
    stable_key: str
    label: str
    category: str
    room_id: str | None
    centroid: list[float]
    aabb_min: list[float]
    aabb_max: list[float]
    observed_in: list[str]
    gaussian_count: int
    identity_stability: float
    confidence: float
    provenance: str


@dataclass(slots=True)
class Output:
    entities: list[SemEntity]
    entities_path: str
    room_labels: dict[str, list[str]]
    track_count: int
    mean_identity_stability: float
    concepts_used: list[str]
    warnings: list[str] = field(default_factory=list)


def build_input(ctx: RunContext, upstream: dict[str, Any]) -> Input:
    sp = upstream.get("splat") or {}
    lay = upstream.get("layout") or {}
    if not sp.get("identity_path"):
        raise StageError("semantics requires the splat stage output")
    if not lay.get("rooms"):
        raise StageError("semantics requires the layout stage output")
    red = ctx.store.load("redact") or {}
    pose = ctx.store.load("pose") or {}
    if not red.get("frames"):
        raise StageError("semantics requires the redact stage artefact — it must "
                         "never read unredacted frames")
    return Input(
        frames=list(red["frames"]), cameras=list(pose["cameras"]),
        ply_path=str(sp["ply_path"]), identity_path=str(sp["identity_path"]),
        rooms=list(lay["rooms"]),
        concepts=dict(ctx.param("concepts", CONCEPTS)),
    )


# ---------------------------------------------------------------------------
# Pure helpers — tested
# ---------------------------------------------------------------------------

def assign_room(centroid: Sequence[float], rooms: Sequence[dict[str, Any]]) -> str | None:
    """Room whose XZ ring contains the centroid, on the nearest floor."""
    x, y, z = (float(v) for v in centroid)
    best: tuple[float, str] | None = None
    for r in rooms:
        if not (r["floor_z"] - 0.6 <= y <= r["ceiling_z"] + 0.6):
            continue
        if point_in_ring((x, z), r["polygon"]):
            dy = abs(y - r["floor_z"])
            if best is None or dy < best[0]:
                best = (dy, r["id"])
    return best[1] if best else None


def cluster_by_identity(features: np.ndarray, query: np.ndarray, *,
                        threshold: float = IDENTITY_SIM_THRESHOLD) -> np.ndarray:
    """Gaussians whose identity feature matches a query, by cosine similarity.

    Cosine rather than Euclidean because the head is trained with a contrastive
    objective on directions, so magnitude carries no instance information.
    """
    f = np.asarray(features, dtype=np.float32)
    q = np.asarray(query, dtype=np.float32).reshape(-1)
    fn = f / np.maximum(np.linalg.norm(f, axis=1, keepdims=True), 1e-9)
    qn = q / max(float(np.linalg.norm(q)), 1e-9)
    return (fn @ qn) >= threshold


def identity_stability(reprojected_hits: Sequence[bool]) -> float:
    """Fraction of tracked frames where the lifted cluster lands on the mask.

    This is the world contract's "one sofa is one sofa across fifteen frames",
    measured. An entity that scores low is one where either the track or the
    lift broke, and its confidence is reduced accordingly rather than the
    entity being silently kept at full confidence.
    """
    if not reprojected_hits:
        return 0.0
    return float(np.mean([1.0 if h else 0.0 for h in reprojected_hits]))


def project_points(points: np.ndarray, camera: dict[str, Any]) -> tuple[np.ndarray, np.ndarray]:
    """World points -> pixel coordinates and a visibility mask for one camera."""
    R_cw, t_cw = world_pose_to_cv_extrinsics(camera["position"], camera["orientation"])
    p_cam = (np.asarray(points, dtype=np.float64) @ R_cw.T) + t_cw
    z = p_cam[:, 2]
    ok = z > 1e-3
    u = np.full(len(p_cam), -1.0)
    v = np.full(len(p_cam), -1.0)
    u[ok] = camera["fx"] * p_cam[ok, 0] / z[ok] + camera["cx"]
    v[ok] = camera["fy"] * p_cam[ok, 1] / z[ok] + camera["cy"]
    inside = ok & (u >= 0) & (u < camera["width"]) & (v >= 0) & (v < camera["height"])
    return np.stack([u, v], axis=1), inside


def run(inp: Input, ctx: RunContext) -> Output:
    torch = require_cuda(why="semantics runs SAM 3.1 video tracking", min_vram_gb=16.0)
    sam3 = require_module("sam3", why="semantics runs SAM 3.1")
    ckpt = require_weights("sam3/sam3.1_hiera_large.pt",
                           why="semantics runs SAM 3.1",
                           source="facebook/sam3 model card")
    from ..formats.ply import read_ply

    device = "cuda"
    predictor = sam3.SAM3VideoPredictor.from_pretrained(str(ckpt)).to(device)
    frame_paths = [f["path"] for f in inp.frames]
    frame_ids = [f["frame_id"] for f in inp.frames]

    state = predictor.init_state(frame_paths=frame_paths)
    # One propagate pass per concept. SAM 3's concept head takes a text prompt
    # and returns tracked instances with stable object ids across the sequence.
    tracks: dict[tuple[str, int], dict[str, Any]] = {}
    for concept in inp.concepts:
        predictor.reset_state(state)
        predictor.add_text_prompt(state, text=concept, threshold=CONCEPT_THRESHOLD)
        for frame_idx, obj_ids, mask_logits in predictor.propagate_in_video(state):
            for k, oid in enumerate(obj_ids):
                m = (mask_logits[k] > 0).squeeze().cpu().numpy()
                if not m.any():
                    continue
                key = (concept, int(oid))
                t = tracks.setdefault(key, {"concept": concept, "frames": [],
                                            "masks": {}, "areas": []})
                t["frames"].append(frame_idx)
                t["masks"][frame_idx] = m
                t["areas"].append(float(m.mean()))

    tracks = {k: v for k, v in tracks.items() if len(v["frames"]) >= MIN_TRACK_FRAMES}
    if not tracks:
        raise StageError("SAM 3.1 produced no tracks meeting the minimum length; "
                         "either the concept list does not match this property or "
                         "the frame set is unusable")

    cloud = read_ply(inp.ply_path)
    features = np.load(inp.identity_path)
    if features.shape[0] != cloud.count:
        raise StageError(f"identity head has {features.shape[0]} rows but the "
                         f"splat has {cloud.count} gaussians; the two artefacts "
                         "are from different runs")
    cams_by_id = {c["frame_id"]: c for c in inp.cameras}

    entities: list[SemEntity] = []
    stabilities: list[float] = []
    warnings: list[str] = []
    for n, ((concept, oid), t) in enumerate(sorted(tracks.items())):
        # Query feature: mean identity feature of the gaussians that project
        # inside the track's mask, over the frames where the track is largest.
        best_frames = sorted(t["frames"], key=lambda f: -t["areas"][t["frames"].index(f)])[:5]
        acc: list[np.ndarray] = []
        for fi in best_frames:
            cam = cams_by_id.get(frame_ids[fi])
            if cam is None:
                continue
            uv, vis = project_points(cloud.means, cam)
            mask = t["masks"][fi]
            mh, mw = mask.shape
            sx = mw / float(cam["width"])
            sy = mh / float(cam["height"])
            cols = np.clip((uv[:, 0] * sx).astype(int), 0, mw - 1)
            rows = np.clip((uv[:, 1] * sy).astype(int), 0, mh - 1)
            hit = vis & mask[rows, cols]
            if hit.sum() >= MIN_GAUSSIANS_PER_ENTITY:
                acc.append(features[hit].mean(axis=0))
        if not acc:
            continue
        query = np.mean(acc, axis=0)
        sel = cluster_by_identity(features, query)
        if int(sel.sum()) < MIN_GAUSSIANS_PER_ENTITY:
            continue
        pts = cloud.means[sel]
        mn, mx = pts.min(axis=0), pts.max(axis=0)
        extent = float(np.max(mx - mn))
        if extent > MAX_ENTITY_EXTENT_M:
            warnings.append(f"{concept}#{oid}: lifted cluster spans {extent:.1f} m, "
                            "which is a lift failure rather than an object; dropped")
            continue
        centroid = pts.mean(axis=0)

        hits: list[bool] = []
        for fi in t["frames"]:
            cam = cams_by_id.get(frame_ids[fi])
            if cam is None:
                continue
            uv, vis = project_points(pts, cam)
            mask = t["masks"][fi]
            mh, mw = mask.shape
            cols = np.clip((uv[:, 0] * mw / cam["width"]).astype(int), 0, mw - 1)
            rows = np.clip((uv[:, 1] * mh / cam["height"]).astype(int), 0, mh - 1)
            inside = vis & mask[rows, cols]
            # "Lands on the mask" = at least half the visible cluster is inside.
            hits.append(bool(vis.sum() > 0 and inside.sum() >= 0.5 * vis.sum()))
        stab = identity_stability(hits)
        stabilities.append(stab)

        room_id = assign_room(centroid, inp.rooms)
        observed = [frame_ids[fi] for fi in sorted(t["frames"])]
        entities.append(SemEntity(
            id=f"ent_{n:04d}",
            stable_key=f"{concept}@{centroid[0]:.1f},{centroid[1]:.1f},{centroid[2]:.1f}",
            label=concept, category=inp.concepts.get(concept, "other"),
            room_id=room_id,
            centroid=[float(v) for v in centroid],
            aabb_min=[float(v) for v in mn], aabb_max=[float(v) for v in mx],
            observed_in=observed, gaussian_count=int(sel.sum()),
            identity_stability=float(stab),
            # Confidence is the product of track length evidence and identity
            # stability, capped: semantics is `inferred` by definition in this
            # contract, so it never claims more than 0.85.
            confidence=float(np.clip(0.5 * stab + 0.35 * min(1.0, len(observed) / 10.0)
                                     + 0.15, 0.1, 0.85)),
            provenance="inferred"))

    room_labels: dict[str, list[str]] = {}
    for e in entities:
        if e.room_id:
            room_labels.setdefault(e.room_id, []).append(e.label)

    path = ctx.out("entities.json")
    path.write_text(json.dumps([asdict(e) for e in entities], indent=1, default=float))

    mean_stab = float(np.mean(stabilities)) if stabilities else 0.0
    if mean_stab < 0.7:
        warnings.append(f"mean identity stability {mean_stab:.2f} is low; entity "
                        "identity across frames is not reliable in this world")

    out = Output(entities=entities, entities_path=str(path), room_labels=room_labels,
                 track_count=len(tracks), mean_identity_stability=mean_stab,
                 concepts_used=sorted(inp.concepts), warnings=warnings)
    log(LOG, logging.INFO, "semantics.ok", entities=len(entities),
        tracks=len(tracks), identity_stability=round(mean_stab, 3))
    return out
