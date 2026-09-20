"""pose — camera poses and a dense point cloud, from redacted frames only.

Two passes, because neither alone is good enough for a metric product:

  1. MapAnything (facebook/map-anything-apache, Apache-2.0) in one feed-forward
     pass over the whole frame set. It returns per-view pointmaps, metric depth,
     intrinsics and camera poses in a common frame. This is what makes the
     pipeline work on a handheld walkthrough at all: classical SfM initialised
     from nothing regularly fails on a UK flat's textureless magnolia hallways,
     and MapAnything does not need to bootstrap from matches.

  2. COLMAP 4.0 (GLOMAP's global mapper is merged into it) refinement, seeded
     with MapAnything's poses as a prior model, using ALIKED keypoints matched
     with LightGlue. MapAnything's poses are good to roughly a degree; bundle
     adjustment over real correspondences takes that to a few tenths, which is
     what keeps a 4 m wall from being 4.1 m.

     ALIKED + LightGlue rather than the usual SuperPoint + SuperGlue because
     Magic Leap's SuperPoint and SuperGlue weights are research-only. ALIKED and
     LightGlue are both usable commercially, which is the whole reason they are
     in the stack.

This stage reads frames from the redact stage's output. It cannot read the raw
frames: it never sees the path to them.

Nothing here has a CPU fallback. A pose graph "estimated" without the models is
not a worse pose graph, it is a fabrication, and every stage after it would
inherit the fabrication silently.
"""
from __future__ import annotations

import json
import logging
import shutil
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Sequence

import numpy as np

from ..deps import require_binary, require_cuda, require_module, require_weights
from ..geometry import cv_extrinsics_to_world_pose, quat_angle_between
from ..logging_setup import get_logger, log
from ..runner import RunContext, StageError, StageUnavailable

LOG = get_logger("worldengine.pose")

SUMMARY = "MapAnything feed-forward poses, refined by COLMAP/GLOMAP with ALIKED+LightGlue"
USES_GPU = True
PRODUCES = ("poses.json", "points.npz", "colmap/", "depth/*.npz")

# MapAnything processes the set in overlapping chunks; 32 views at 518px fits
# comfortably in 48 GB with bf16 autocast and leaves room for the COLMAP
# database build to overlap. Larger chunks improve global consistency slightly
# and cost VRAM quadratically in the attention.
MAPANYTHING_CHUNK = 32
MAPANYTHING_OVERLAP = 8
MAPANYTHING_RESOLUTION = 518

# LightGlue matching is O(n^2) in frames if done exhaustively. A walkthrough is
# a sequence, so match each frame against its temporal neighbours plus a set of
# global candidates from MapAnything pose proximity: that finds loop closures
# (walking back through the hall) without paying for 300^2 pairs.
SEQUENTIAL_WINDOW = 12
LOOP_CANDIDATES = 8
LOOP_MAX_ANGLE_RAD = 1.05        # ~60 degrees; beyond this ALIKED rarely matches
LOOP_MAX_DISTANCE_M = 4.0

# A refined pose that moved more than this from its MapAnything prior means the
# bundle adjuster latched onto a different solution, most often a mirror. The
# frame is flagged rather than dropped, and the regions stage treats it as
# suspect.
POSE_DRIFT_WARN_M = 0.35
POSE_DRIFT_WARN_RAD = 0.175      # 10 degrees

MIN_REGISTERED_FRACTION = 0.85   # below this the pose graph is not trustworthy


@dataclass(slots=True)
class Input:
    frames: list[dict[str, Any]]
    capture_id: str
    device_hint: dict[str, Any] = field(default_factory=dict)
    refine: bool = True
    chunk: int = MAPANYTHING_CHUNK
    resolution: int = MAPANYTHING_RESOLUTION


@dataclass(slots=True)
class PosedCamera:
    frame_id: str
    path: str
    source_index: int
    t_ms: int
    position: list[float]
    orientation: list[float]        # [x, y, z, w], world frame
    fx: float
    fy: float
    cx: float
    cy: float
    width: int
    height: int
    pose_confidence: float
    sharpness: float
    registered: bool
    drift_m: float = 0.0
    drift_rad: float = 0.0


@dataclass(slots=True)
class Output:
    cameras: list[PosedCamera]
    point_cloud_path: str
    depth_dir: str
    colmap_dir: str
    registered_count: int
    registered_fraction: float
    mean_reprojection_error_px: float
    median_pose_drift_m: float
    scale_is_metric: bool
    mapanything_scale_factor: float
    point_count: int
    warnings: list[str] = field(default_factory=list)


def build_input(ctx: RunContext, upstream: dict[str, Any]) -> Input:
    red = upstream.get("redact") or {}
    if not red.get("frames"):
        raise StageError("pose requires the redact stage output — it must never "
                         "read unredacted frames")
    return Input(
        frames=list(red["frames"]),
        capture_id=str(ctx.param("capture_id", ctx.run_id)),
        device_hint=dict(ctx.param("device", {}) or {}),
        refine=bool(ctx.param("pose_refine", True)),
        chunk=int(ctx.param("pose_chunk", MAPANYTHING_CHUNK)),
        resolution=int(ctx.param("pose_resolution", MAPANYTHING_RESOLUTION)),
    )


# ---------------------------------------------------------------------------
# Pair selection — pure, and tested
# ---------------------------------------------------------------------------

def sequential_pairs(n: int, window: int = SEQUENTIAL_WINDOW) -> list[tuple[int, int]]:
    return [(i, j) for i in range(n) for j in range(i + 1, min(n, i + window + 1))]


def loop_pairs(positions: np.ndarray, forwards: np.ndarray, *,
               window: int = SEQUENTIAL_WINDOW,
               k: int = LOOP_CANDIDATES,
               max_distance: float = LOOP_MAX_DISTANCE_M,
               max_angle: float = LOOP_MAX_ANGLE_RAD) -> list[tuple[int, int]]:
    """Non-sequential pairs that are close in space AND looking a similar way.

    Distance alone is not enough: two frames a metre apart on opposite sides of
    a wall share no content, and matching them wastes GPU and invites false
    matches through a doorway. Requiring the view directions to agree within
    max_angle is what makes this cheap and safe.
    """
    n = len(positions)
    out: set[tuple[int, int]] = set()
    for i in range(n):
        d = np.linalg.norm(positions - positions[i], axis=1)
        cos = np.clip(forwards @ forwards[i], -1.0, 1.0)
        ang = np.arccos(cos)
        cand = [j for j in range(n)
                if abs(j - i) > window and d[j] <= max_distance and ang[j] <= max_angle]
        cand.sort(key=lambda j: d[j])
        for j in cand[:k]:
            out.add((min(i, j), max(i, j)))
    return sorted(out)


def pose_drift(a_pos: Sequence[float], a_quat: Sequence[float],
               b_pos: Sequence[float], b_quat: Sequence[float]) -> tuple[float, float]:
    return (float(np.linalg.norm(np.asarray(a_pos) - np.asarray(b_pos))),
            quat_angle_between(a_quat, b_quat))


# ---------------------------------------------------------------------------
# MapAnything
# ---------------------------------------------------------------------------

def run_mapanything(frames: Sequence[dict[str, Any]], *, device: str, chunk: int,
                    overlap: int, resolution: int, out_dir: Path) -> dict[str, Any]:
    """One feed-forward pass, chunked, returning poses, intrinsics and depth.

    MapAnything's `infer` takes a list of view dicts and returns, per view:
        pts3d                 (B, H, W, 3)  points in the common world frame
        pts3d_cam             (B, H, W, 3)  points in the view's camera frame
        depth_z               (B, H, W, 1)  metric z depth
        intrinsics            (B, 3, 3)     pinhole K for the processed size
        camera_poses          (B, 4, 4)     camera-to-world, OpenCV basis
        mask                  (B, H, W, 1)  valid pixels
        conf                  (B, H, W)     per-pixel confidence
        metric_scaling_factor (B,)          scale applied to reach metres
    """
    torch = require_cuda(why="pose runs MapAnything", min_vram_gb=20.0)
    ma = require_module("mapanything.models", why="pose runs MapAnything")
    require_weights("map-anything-apache", why="pose runs MapAnything",
                    source="facebook/map-anything-apache (Apache-2.0)")
    import cv2

    model = ma.MapAnything.from_pretrained("facebook/map-anything-apache").to(device)
    model.eval()

    chunks: list[tuple[int, int]] = []
    start = 0
    n = len(frames)
    step = max(1, chunk - overlap)
    while start < n:
        chunks.append((start, min(n, start + chunk)))
        if start + chunk >= n:
            break
        start += step

    poses = np.zeros((n, 4, 4), dtype=np.float64)
    intr = np.zeros((n, 3, 3), dtype=np.float64)
    conf = np.zeros(n, dtype=np.float64)
    seen = np.zeros(n, dtype=bool)
    scales: list[float] = []
    cloud: list[np.ndarray] = []
    colours: list[np.ndarray] = []
    depth_dir = out_dir / "depth"
    depth_dir.mkdir(parents=True, exist_ok=True)

    for (lo, hi) in chunks:
        views = []
        for meta in frames[lo:hi]:
            bgr = cv2.imread(meta["path"], cv2.IMREAD_COLOR)
            if bgr is None:
                raise StageError(f"could not read redacted frame {meta['path']}")
            rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
            h, w = rgb.shape[:2]
            s = resolution / float(max(h, w))
            rs = cv2.resize(rgb, (int(round(w * s)) // 14 * 14,
                                  int(round(h * s)) // 14 * 14),
                            interpolation=cv2.INTER_AREA)
            t = torch.from_numpy(rs).permute(2, 0, 1).float().div_(255.0)
            views.append({"img": t.unsqueeze(0).to(device)})

        with torch.no_grad(), torch.autocast("cuda", dtype=torch.bfloat16):
            preds = model.infer(views, memory_efficient_inference=True,
                                use_amp=True, amp_dtype="bf16",
                                apply_mask=True, mask_edges=True,
                                apply_confidence_mask=True,
                                confidence_percentile=10)

        for k, pred in enumerate(preds):
            idx = lo + k
            # Chunks overlap; the first pass over a frame wins, so the chunk
            # that had the most context on both sides is not overwritten by a
            # later chunk that only saw it at its edge.
            if seen[idx]:
                continue
            seen[idx] = True
            poses[idx] = np.asarray(pred["camera_poses"][0].float().cpu())
            intr[idx] = np.asarray(pred["intrinsics"][0].float().cpu())
            c = np.asarray(pred["conf"][0].float().cpu())
            conf[idx] = float(np.median(c))
            scales.append(float(np.asarray(pred["metric_scaling_factor"][0].cpu())))

            pts = np.asarray(pred["pts3d"][0].float().cpu()).reshape(-1, 3)
            msk = np.asarray(pred["mask"][0].float().cpu()).reshape(-1) > 0.5
            depth = np.asarray(pred["depth_z"][0].float().cpu()).squeeze(-1)
            np.savez_compressed(depth_dir / f"{frames[idx]['frame_id']}.npz",
                                depth=depth.astype(np.float32),
                                conf=c.astype(np.float32),
                                K=intr[idx].astype(np.float32))
            # Subsample the pointmap: 300 frames x 518x518 is 80M points and
            # COLMAP does not need them; every 16th valid pixel is plenty for
            # a scale reference and a visibility carve.
            keep = np.nonzero(msk)[0][::16]
            cloud.append(pts[keep].astype(np.float32))
            img_small = np.asarray(views[k]["img"][0].permute(1, 2, 0).cpu())
            colours.append((img_small.reshape(-1, 3)[keep] * 255).astype(np.uint8))

    if not seen.all():
        raise StageError(f"MapAnything returned no prediction for "
                         f"{int((~seen).sum())} of {n} frames")

    return {
        "poses": poses, "intrinsics": intr, "conf": conf,
        "metric_scale": float(np.median(scales)) if scales else 1.0,
        "points": np.concatenate(cloud, axis=0) if cloud else np.zeros((0, 3), np.float32),
        "colours": np.concatenate(colours, axis=0) if colours else np.zeros((0, 3), np.uint8),
        "depth_dir": str(depth_dir),
    }


# ---------------------------------------------------------------------------
# COLMAP refinement
# ---------------------------------------------------------------------------

def write_colmap_prior(model_dir: Path, frames: Sequence[dict[str, Any]],
                       poses: np.ndarray, intrinsics: np.ndarray,
                       sizes: Sequence[tuple[int, int]]) -> None:
    """Write cameras.txt / images.txt / points3D.txt so COLMAP can triangulate
    against MapAnything's poses instead of re-running incremental SfM.

    COLMAP images.txt stores camera-FROM-world as QW QX QY QZ TX TY TZ, with
    the quaternion in [w, x, y, z]. MapAnything gives camera-TO-world 4x4. The
    inversion and the quaternion reordering are both done here, once.
    """
    from ..geometry import mat3_to_quat
    model_dir.mkdir(parents=True, exist_ok=True)

    with open(model_dir / "cameras.txt", "w") as fh:
        fh.write("# Camera list\n")
        for i, (K, (w, h)) in enumerate(zip(intrinsics, sizes), start=1):
            fh.write(f"{i} PINHOLE {w} {h} {K[0,0]:.8f} {K[1,1]:.8f} "
                     f"{K[0,2]:.8f} {K[1,2]:.8f}\n")

    with open(model_dir / "images.txt", "w") as fh:
        fh.write("# Image list\n")
        for i, (meta, T) in enumerate(zip(frames, poses), start=1):
            R_wc = np.asarray(T[:3, :3], dtype=np.float64)
            c = np.asarray(T[:3, 3], dtype=np.float64)
            R_cw = R_wc.T
            t_cw = -R_cw @ c
            qx, qy, qz, qw = mat3_to_quat(R_cw)
            fh.write(f"{i} {qw:.10f} {qx:.10f} {qy:.10f} {qz:.10f} "
                     f"{t_cw[0]:.8f} {t_cw[1]:.8f} {t_cw[2]:.8f} {i} "
                     f"{Path(meta['path']).name}\n\n")

    (model_dir / "points3D.txt").write_text("# Empty; point_triangulator fills it\n")


def extract_and_match(db_path: Path, frames: Sequence[dict[str, Any]],
                      pairs: Sequence[tuple[int, int]], *, device: str) -> None:
    """ALIKED keypoints + LightGlue matches, written into a COLMAP database."""
    torch = require_cuda(why="pose refinement extracts ALIKED features")
    lg = require_module("lightglue", why="pose refinement uses ALIKED + LightGlue")
    pycolmap = require_module("pycolmap", why="pose refinement writes a COLMAP database")
    from lightglue.utils import load_image, rbd  # noqa: PLC0415
    import cv2

    extractor = lg.ALIKED(max_num_keypoints=4096).eval().to(device)
    matcher = lg.LightGlue(features="aliked").eval().to(device)

    db = pycolmap.Database(str(db_path))
    feats: list[dict[str, Any]] = []
    image_ids: list[int] = []
    for i, meta in enumerate(frames, start=1):
        img = load_image(meta["path"]).to(device)
        with torch.no_grad():
            f = rbd(extractor.extract(img))
        feats.append(f)
        kp = f["keypoints"].cpu().numpy().astype(np.float64)
        desc = f["descriptors"].cpu().numpy().astype(np.float32)
        image_ids.append(i)
        db.write_keypoints(i, kp)
        db.write_descriptors(i, desc)

    for (i, j) in pairs:
        with torch.no_grad():
            m = rbd(matcher({"image0": feats[i], "image1": feats[j]}))
        matches = m["matches"].cpu().numpy().astype(np.uint32)
        if len(matches) < 16:
            # Fewer than ~16 correspondences cannot constrain a two-view
            # geometry; writing them only adds outliers to the bundle.
            continue
        db.write_matches(image_ids[i], image_ids[j], matches)
    db.close()


def refine_with_colmap(work: Path, image_dir: Path, frames: Sequence[dict[str, Any]],
                       poses: np.ndarray, intrinsics: np.ndarray,
                       sizes: Sequence[tuple[int, int]],
                       pairs: Sequence[tuple[int, int]], *, device: str) -> Path:
    colmap = require_binary("colmap", why="pose refinement runs COLMAP 4.0")
    work.mkdir(parents=True, exist_ok=True)
    db = work / "database.db"
    if db.exists():
        db.unlink()
    require_module("pycolmap", why="pose refinement writes a COLMAP database")

    # COLMAP wants the images registered in its database before features go in.
    subprocess.run([colmap, "database_creator", "--database_path", str(db)],
                   check=True, capture_output=True)
    extract_and_match(db, frames, pairs, device=device)

    prior = work / "prior"
    write_colmap_prior(prior, frames, poses, intrinsics, sizes)

    tri = work / "triangulated"
    tri.mkdir(parents=True, exist_ok=True)
    _run([colmap, "point_triangulator",
          "--database_path", str(db),
          "--image_path", str(image_dir),
          "--input_path", str(prior),
          "--output_path", str(tri),
          "--Mapper.ba_refine_focal_length", "1",
          "--Mapper.ba_refine_principal_point", "0",
          # Principal point stays fixed: a phone's optical centre is within a
          # few pixels of the sensor centre, and letting BA chase it on a
          # low-parallax indoor sequence trades a real parameter for noise.
          "--Mapper.filter_max_reproj_error", "4"], "point_triangulator")

    refined = work / "refined"
    refined.mkdir(parents=True, exist_ok=True)
    _run([colmap, "bundle_adjuster",
          "--input_path", str(tri), "--output_path", str(refined),
          "--BundleAdjustment.refine_focal_length", "1",
          "--BundleAdjustment.refine_principal_point", "0",
          "--BundleAdjustment.refine_extra_params", "0",
          "--BundleAdjustment.max_num_iterations", "100"], "bundle_adjuster")
    return refined


def _run(cmd: list[str], what: str) -> None:
    p = subprocess.run(cmd, capture_output=True, text=True, check=False)
    if p.returncode != 0:
        raise StageError(f"COLMAP {what} failed (exit {p.returncode}):\n"
                         f"{p.stderr.strip()[-1500:]}")


def read_colmap_model(model_dir: Path) -> tuple[dict[str, Any], float]:
    """Read a COLMAP sparse model (binary or text) via pycolmap."""
    pycolmap = require_module("pycolmap", why="pose reads the refined COLMAP model")
    rec = pycolmap.Reconstruction(str(model_dir))
    out: dict[str, Any] = {}
    errs: list[float] = []
    for image in rec.images.values():
        cam = rec.cameras[image.camera_id]
        R_cw = image.cam_from_world.rotation.matrix()
        t_cw = image.cam_from_world.translation
        pos, quat = cv_extrinsics_to_world_pose(R_cw, t_cw)
        params = cam.params
        fx, fy = float(params[0]), float(params[1] if len(params) > 2 else params[0])
        cx, cy = float(params[-2]), float(params[-1])
        out[Path(image.name).stem] = {
            "position": list(pos), "orientation": list(quat),
            "fx": fx, "fy": fy, "cx": cx, "cy": cy,
            "width": int(cam.width), "height": int(cam.height),
            "points": int(image.num_points3D),
        }
    for p3 in rec.points3D.values():
        errs.append(float(p3.error))
    return out, (float(np.mean(errs)) if errs else float("nan"))


# ---------------------------------------------------------------------------
# Stage entry point
# ---------------------------------------------------------------------------

def run(inp: Input, ctx: RunContext) -> Output:
    device = "cuda"
    require_cuda(why="pose runs MapAnything and ALIKED", min_vram_gb=20.0)
    out_dir = ctx.data_dir()

    ma = run_mapanything(inp.frames, device=device, chunk=inp.chunk,
                         overlap=MAPANYTHING_OVERLAP, resolution=inp.resolution,
                         out_dir=out_dir)

    poses = ma["poses"]
    positions = poses[:, :3, 3]
    forwards = np.stack([poses[i, :3, :3] @ np.array([0.0, 0.0, 1.0])
                         for i in range(len(poses))])
    forwards /= np.maximum(np.linalg.norm(forwards, axis=1, keepdims=True), 1e-9)

    sizes = [(int(f["width"]), int(f["height"])) for f in inp.frames]
    # MapAnything's K is for its processed resolution; rescale to the frame we
    # actually hand to COLMAP and to gsplat, or every reprojection is wrong by
    # the resize factor.
    K = ma["intrinsics"].copy()
    for i, (w, h) in enumerate(sizes):
        sx = w / (2.0 * K[i, 0, 2]) if K[i, 0, 2] > 0 else 1.0
        sy = h / (2.0 * K[i, 1, 2]) if K[i, 1, 2] > 0 else 1.0
        K[i, 0, 0] *= sx; K[i, 0, 2] *= sx
        K[i, 1, 1] *= sy; K[i, 1, 2] *= sy

    warnings: list[str] = []
    refined: dict[str, Any] = {}
    reproj = float("nan")
    colmap_dir = out_dir / "colmap"
    if inp.refine:
        pairs = sorted(set(sequential_pairs(len(inp.frames))) |
                       set(loop_pairs(positions, forwards)))
        log(LOG, logging.INFO, "pose.pairs", count=len(pairs), frames=len(inp.frames))
        image_dir = Path(inp.frames[0]["path"]).parent
        model = refine_with_colmap(colmap_dir, image_dir, inp.frames, poses, K,
                                   sizes, pairs, device=device)
        refined, reproj = read_colmap_model(model)

    cameras: list[PosedCamera] = []
    drifts: list[float] = []
    for i, meta in enumerate(inp.frames):
        fid = meta["frame_id"]
        prior_pos, prior_quat = cv_extrinsics_to_world_pose(
            poses[i, :3, :3].T, -poses[i, :3, :3].T @ poses[i, :3, 3])
        r = refined.get(fid)
        if r is None:
            pos, quat = prior_pos, prior_quat
            fx, fy, cx, cy = (float(K[i, 0, 0]), float(K[i, 1, 1]),
                              float(K[i, 0, 2]), float(K[i, 1, 2]))
            registered = not inp.refine
            drift_m = drift_r = 0.0
            # Confidence is halved for a frame COLMAP refused to register: the
            # MapAnything prior is all we have and nothing corroborated it.
            pconf = float(ma["conf"][i]) * (1.0 if registered else 0.5)
        else:
            pos, quat = tuple(r["position"]), tuple(r["orientation"])
            fx, fy, cx, cy = r["fx"], r["fy"], r["cx"], r["cy"]
            registered = True
            drift_m, drift_r = pose_drift(prior_pos, prior_quat, pos, quat)
            drifts.append(drift_m)
            pconf = float(ma["conf"][i])
            if drift_m > POSE_DRIFT_WARN_M or drift_r > POSE_DRIFT_WARN_RAD:
                pconf *= 0.5
                warnings.append(
                    f"{fid}: refined pose moved {drift_m*100:.0f} cm / "
                    f"{np.degrees(drift_r):.1f} deg from the MapAnything prior; "
                    "usually a mirror or a repeated texture")
        cameras.append(PosedCamera(
            frame_id=fid, path=meta["path"], source_index=int(meta["source_index"]),
            t_ms=int(meta["t_ms"]),
            position=[float(v) for v in pos], orientation=[float(v) for v in quat],
            fx=float(fx), fy=float(fy), cx=float(cx), cy=float(cy),
            width=int(meta["width"]), height=int(meta["height"]),
            pose_confidence=float(np.clip(pconf, 0.0, 1.0)),
            sharpness=float(meta["sharpness"]), registered=registered,
            drift_m=float(drift_m), drift_rad=float(drift_r)))

    reg = sum(1 for c in cameras if c.registered)
    frac = reg / float(len(cameras))
    if frac < MIN_REGISTERED_FRACTION:
        raise StageError(
            f"only {reg}/{len(cameras)} frames ({frac:.0%}) registered in bundle "
            f"adjustment, below the {MIN_REGISTERED_FRACTION:.0%} floor. The pose "
            "graph is not connected enough to build a world from."
        )

    cloud_path = ctx.out("points.npz")
    np.savez_compressed(cloud_path, points=ma["points"], colours=ma["colours"])

    out = Output(
        cameras=cameras,
        point_cloud_path=str(cloud_path),
        depth_dir=ma["depth_dir"],
        colmap_dir=str(colmap_dir) if inp.refine else "",
        registered_count=reg,
        registered_fraction=frac,
        mean_reprojection_error_px=float(reproj),
        median_pose_drift_m=float(np.median(drifts)) if drifts else 0.0,
        # MapAnything emits metric depth, so the reconstruction starts metric.
        # The scale stage is what decides whether we believe it.
        scale_is_metric=True,
        mapanything_scale_factor=float(ma["metric_scale"]),
        point_count=int(ma["points"].shape[0]),
        warnings=warnings[:50],
    )
    log(LOG, logging.INFO, "pose.ok", registered=reg, frames=len(cameras),
        reprojection_px=round(float(reproj), 3) if reproj == reproj else None,
        points=out.point_count)
    return out
