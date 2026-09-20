"""frames — decode, score and select the frames the whole reconstruction rests on.

CPU only, and the highest-return stage in the pipeline. Five to ten motion-blurred
frames in a set of three hundred is enough to measurably degrade a splat: the
blurred views are still photometrically consistent with a *wrong* geometry, so
the optimiser happily grows floaters to explain them, and bundle adjustment
pulls neighbouring poses toward the smear. Rejecting them costs nothing and is
worth more than any amount of extra training iterations.

Two independent signals, because either alone is fooled:

  1. Variance of the Laplacian, normalised by image contrast.
     Raw VoL is the standard blur metric but it scales with scene contrast, so
     a sharp photo of a white wall scores lower than a blurry photo of a
     bookcase. Dividing by the intensity variance removes most of that. We keep
     the raw value too because that is what wv_camera.sharpness stores and what
     operators have intuition for.

  2. Motion consistency via sparse Lucas-Kanade flow between consecutive
     candidates. Two things fall out of it: the median flow magnitude (which is
     both a motion-blur proxy and the overlap estimate the selector needs), and
     the fraction of tracks consistent with a single homography. A frame during
     a fast pan has coherent large flow; a frame with rolling-shutter jelly or
     a smeared exposure has incoherent flow and a low inlier ratio, and VoL
     alone will not catch it.

Selection then walks the candidates at a target rate, rejecting blurred ones and
spacing the keepers so that consecutive frames overlap by roughly 60-80% — the
band where ALIKED+LightGlue matching is dense and the baseline is still long
enough to triangulate. Too much overlap wastes GPU on redundant views; too
little and the pose graph comes apart.
"""
from __future__ import annotations

import logging
import math
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable, Sequence

import numpy as np

from ..logging_setup import get_logger, log
from ..runner import RunContext, StageError

LOG = get_logger("worldengine.frames")

SUMMARY = "Decode at 2-3 fps, score blur and motion, select 200-400 usable frames"
USES_GPU = False
PRODUCES = ("frames/*.jpg", "scores.json")

# --- thresholds, and why -----------------------------------------------------
#
# TARGET_FPS: the brief's 2-3 fps. At a walking pace of ~0.7 m/s, 2.5 fps puts
# candidates ~28 cm apart, which at a typical 2.5 m room depth is well inside
# the overlap band. We decode at CANDIDATE_FPS (higher) so the selector has
# alternatives when a candidate is blurred.
TARGET_FPS = 2.5
CANDIDATE_FPS = 7.5

# BLUR_REL_FACTOR: a frame is rejected when its normalised sharpness falls
# below this fraction of the rolling median of its neighbourhood. Relative,
# not absolute, because absolute VoL thresholds do not transfer between a
# sunlit bay window and an unlit hallway in the same flat. 0.55 was chosen so
# that a frame must be clearly worse than its neighbours, not merely below
# average: with a symmetric score distribution, ~0.55x the local median
# corresponds to roughly the worst decile.
BLUR_REL_FACTOR = 0.55
# ...and an absolute floor as a backstop, for the case where an entire window
# of frames is blurred (a whole fast pan) and the rolling median is itself low.
BLUR_ABS_FLOOR = 0.0020
BLUR_WINDOW = 31                # frames, ~4 s at CANDIDATE_FPS

# MIN_TRACK_INLIER_RATIO: fraction of LK tracks consistent with one homography.
# Rolling-shutter jelly and long-exposure smear both break a single-homography
# fit even when the Laplacian looks acceptable. 0.55 is comfortably above the
# ~0.3 you get from a genuinely broken frame and below the ~0.8 of a clean pan.
MIN_TRACK_INLIER_RATIO = 0.55
# MAX_FLOW_FRACTION: median flow larger than this fraction of the image
# diagonal between consecutive *candidates* means the camera swung fast enough
# that the frame is almost certainly motion blurred at phone shutter speeds.
MAX_FLOW_FRACTION = 0.16

# OVERLAP band. Displacement between kept frames, as a fraction of image width.
# ~0.30 of the width corresponds to roughly 70% overlap for a forward-facing
# translating camera, which is the middle of the band LightGlue likes.
TARGET_DISPLACEMENT_FRAC = 0.30
MIN_DISPLACEMENT_FRAC = 0.10    # below this the frame is redundant
MAX_DISPLACEMENT_FRAC = 0.55    # above this the pose graph starts to fracture

MIN_FRAMES = 200
MAX_FRAMES = 400
# Below this the capture cannot support a reconstruction at all. It is a hard
# error rather than a warning because everything downstream would "succeed".
ABSOLUTE_MIN_FRAMES = 60

# Working resolution for scoring only. Blur measurement at 4K costs 8x as much
# and measures sensor noise; 960px on the long edge is where VoL stabilises.
SCORE_LONG_EDGE = 960
# Resolution written for the reconstruction. 1600px long edge is the sweet spot
# for gsplat on an L40S: above it VRAM and step time rise faster than PSNR.
OUTPUT_LONG_EDGE = 1600


@dataclass(slots=True)
class FrameScore:
    index: int                  # index into the decoded candidate sequence
    source_index: int           # frame index in the source video
    t_ms: int
    vol: float                  # raw variance of Laplacian
    vol_norm: float             # contrast-normalised
    flow_px: float              # median LK flow from the previous candidate
    flow_inlier_ratio: float
    rejected_blur: bool = False
    rejected_motion: bool = False
    selected: bool = False
    reason: str = ""


@dataclass(slots=True)
class Input:
    video_path: str
    capture_id: str
    duration_s: float
    fps: float
    width: int
    height: int
    target_fps: float = TARGET_FPS
    candidate_fps: float = CANDIDATE_FPS
    max_frames: int = MAX_FRAMES
    min_frames: int = MIN_FRAMES
    output_long_edge: int = OUTPUT_LONG_EDGE


@dataclass(slots=True)
class SelectedFrame:
    frame_id: str
    path: str
    source_index: int
    t_ms: int
    sharpness: float
    sharpness_norm: float
    width: int
    height: int


@dataclass(slots=True)
class Output:
    frames: list[SelectedFrame]
    candidate_count: int
    selected_count: int
    rejected_blur_count: int
    rejected_motion_count: int
    rejected_redundant_count: int
    blur_rejection_fraction: float
    median_sharpness: float
    median_displacement_frac: float
    scores_path: str
    warnings: list[str] = field(default_factory=list)


def build_input(ctx: RunContext, upstream: dict[str, Any]) -> Input:
    ing = upstream.get("ingest") or {}
    if not ing:
        raise StageError("frames requires the ingest stage output")
    return Input(
        video_path=ing["video_path"],
        capture_id=ing["capture_id"],
        duration_s=float(ing["duration_s"]),
        fps=float(ing["fps"]),
        width=int(ing["width"]),
        height=int(ing["height"]),
        target_fps=float(ctx.param("target_fps", TARGET_FPS)),
        candidate_fps=float(ctx.param("candidate_fps", CANDIDATE_FPS)),
        max_frames=int(ctx.param("max_frames", MAX_FRAMES)),
        min_frames=int(ctx.param("min_frames", MIN_FRAMES)),
        output_long_edge=int(ctx.param("output_long_edge", OUTPUT_LONG_EDGE)),
    )


# ---------------------------------------------------------------------------
# Pure scoring functions. No video, no files — these are what the tests drive.
# ---------------------------------------------------------------------------

def laplacian_variance(gray: np.ndarray) -> float:
    """Variance of the 4-neighbour Laplacian. Implemented directly rather than
    via cv2 so the scoring maths is identical on any machine and testable
    without an OpenCV build."""
    g = np.asarray(gray, dtype=np.float64)
    if g.ndim != 2:
        raise ValueError(f"expected a 2D grayscale image, got shape {g.shape}")
    if g.shape[0] < 3 or g.shape[1] < 3:
        return 0.0
    lap = (-4.0 * g[1:-1, 1:-1] + g[:-2, 1:-1] + g[2:, 1:-1]
           + g[1:-1, :-2] + g[1:-1, 2:])
    return float(lap.var())


def contrast_normalised_sharpness(gray: np.ndarray) -> tuple[float, float]:
    """(raw VoL, VoL normalised by intensity variance).

    The Laplacian is a linear operator, so scaling image contrast by k scales
    VoL by k^2 and the intensity variance by k^2 as well. Their ratio is
    therefore contrast-invariant, which is what lets one threshold work in a
    dark hallway and a bright bay window.
    """
    g = np.asarray(gray, dtype=np.float64)
    vol = laplacian_variance(g)
    var = float(g.var())
    return vol, vol / (var + 1e-6)


def rolling_median(values: Sequence[float], window: int) -> list[float]:
    """Centred rolling median with edge clamping. O(n*w) — n is a few hundred."""
    n = len(values)
    if n == 0:
        return []
    half = max(1, window // 2)
    arr = np.asarray(values, dtype=np.float64)
    return [float(np.median(arr[max(0, i - half): min(n, i + half + 1)])) for i in range(n)]


def mark_blur(scores: Sequence[FrameScore], *,
              rel_factor: float = BLUR_REL_FACTOR,
              abs_floor: float = BLUR_ABS_FLOOR,
              window: int = BLUR_WINDOW) -> int:
    """Flag blurred candidates in place. Returns how many were rejected."""
    med = rolling_median([s.vol_norm for s in scores], window)
    rejected = 0
    for s, m in zip(scores, med):
        if s.vol_norm < abs_floor:
            s.rejected_blur = True
            s.reason = f"vol_norm {s.vol_norm:.5f} below absolute floor {abs_floor}"
        elif s.vol_norm < rel_factor * m:
            s.rejected_blur = True
            s.reason = (f"vol_norm {s.vol_norm:.5f} below {rel_factor:.2f}x local "
                        f"median {m:.5f}")
        if s.rejected_blur:
            rejected += 1
    return rejected


def mark_motion(scores: Sequence[FrameScore], diagonal_px: float, *,
                min_inlier: float = MIN_TRACK_INLIER_RATIO,
                max_flow_frac: float = MAX_FLOW_FRACTION) -> int:
    """Flag candidates whose inter-frame motion says the exposure is smeared."""
    rejected = 0
    for s in scores:
        if s.index == 0:
            continue                     # no predecessor, nothing to measure
        if s.flow_inlier_ratio < min_inlier:
            s.rejected_motion = True
            s.reason = (f"only {s.flow_inlier_ratio:.2f} of tracks fit one "
                        f"homography (min {min_inlier})")
        elif s.flow_px > max_flow_frac * diagonal_px:
            s.rejected_motion = True
            s.reason = (f"median flow {s.flow_px:.1f}px exceeds "
                        f"{max_flow_frac:.2f} of the {diagonal_px:.0f}px diagonal")
        if s.rejected_motion:
            rejected += 1
    return rejected


def select_by_overlap(scores: Sequence[FrameScore], width_px: float, *,
                      target_frac: float = TARGET_DISPLACEMENT_FRAC,
                      min_frac: float = MIN_DISPLACEMENT_FRAC,
                      max_frames: int = MAX_FRAMES,
                      min_frames: int = MIN_FRAMES) -> tuple[list[FrameScore], int]:
    """Greedy selection keeping consecutive keepers in the overlap band.

    Walks candidates in order accumulating flow since the last keeper, and
    keeps a candidate once the accumulated displacement reaches the target. A
    candidate that blur or motion rejected is skipped but its flow still
    counts, so the spacing is measured along the real camera path rather than
    along the surviving frames.

    If that yields fewer than `min_frames`, the target spacing is backed off
    towards `min_frac` and the walk repeated. The back-off STOPS at min_frac:
    below it, consecutive frames overlap by so much that the extra views carry
    no new information, and adding them would buy nothing but GPU seconds. A
    capture that cannot reach min_frames at min_frac is simply a short capture,
    and run() reports that rather than padding the set.

    Returns (kept, redundant_count).
    """
    def walk(target_px: float, min_px: float) -> tuple[list[FrameScore], int]:
        for s in scores:
            s.selected = False
        kept: list[FrameScore] = []
        redundant = 0
        accum = 0.0
        for s in scores:
            accum += max(0.0, s.flow_px)
            if s.rejected_blur or s.rejected_motion:
                continue
            if not kept:
                s.selected = True
                kept.append(s)
                accum = 0.0
                continue
            if accum < min_px:
                redundant += 1
                continue
            if accum >= target_px:
                s.selected = True
                kept.append(s)
                accum = 0.0
        return kept, redundant

    min_px = min_frac * width_px
    target_px = target_frac * width_px
    kept, redundant = walk(target_px, min_px)
    # Back off geometrically rather than in one jump: each halving roughly
    # doubles the frame count, so at most three steps separate the target
    # spacing from the redundancy floor.
    while len(kept) < min_frames and target_px > min_px * 1.001:
        target_px = max(min_px, target_px * 0.5)
        kept, redundant = walk(target_px, min_px)

    if len(kept) > max_frames:
        # Keep the sharpest within an even temporal spread rather than simply
        # truncating, which would drop whole rooms from the end of the walk.
        stride = len(kept) / float(max_frames)
        picked: list[FrameScore] = []
        for i in range(max_frames):
            lo = int(i * stride)
            hi = max(lo + 1, int((i + 1) * stride))
            picked.append(max(kept[lo:hi], key=lambda s: s.vol_norm))
        chosen = {id(s) for s in picked}
        for s in kept:
            if id(s) not in chosen:
                s.selected = False
        kept = picked
    return kept, redundant


def score_sequence(grays: Sequence[np.ndarray], *, t_ms: Sequence[int],
                   source_indices: Sequence[int],
                   flow_fn: Any = None) -> list[FrameScore]:
    """Score a decoded candidate sequence. `flow_fn(prev, cur) -> (median_px,
    inlier_ratio)` is injected so tests can drive it without OpenCV."""
    if not (len(grays) == len(t_ms) == len(source_indices)):
        raise ValueError("grays, t_ms and source_indices must be the same length")
    fn = flow_fn or lk_flow
    out: list[FrameScore] = []
    prev: np.ndarray | None = None
    for i, g in enumerate(grays):
        vol, vol_norm = contrast_normalised_sharpness(g)
        if prev is None:
            flow_px, inlier = 0.0, 1.0
        else:
            flow_px, inlier = fn(prev, g)
        out.append(FrameScore(index=i, source_index=int(source_indices[i]),
                              t_ms=int(t_ms[i]), vol=vol, vol_norm=vol_norm,
                              flow_px=float(flow_px), flow_inlier_ratio=float(inlier)))
        prev = g
    return out


def lk_flow(prev: np.ndarray, cur: np.ndarray) -> tuple[float, float]:
    """Median sparse flow magnitude in pixels, and the fraction of tracks
    consistent with a single homography.

    Shi-Tomasi corners + pyramidal Lucas-Kanade. RANSAC homography rather than
    an affine fit because a phone walking through a doorway produces real
    perspective change that an affine model would mistake for incoherence.
    """
    import cv2  # local import: scoring maths above must work without OpenCV

    p0 = cv2.goodFeaturesToTrack(prev.astype(np.uint8), maxCorners=400,
                                 qualityLevel=0.01, minDistance=12, blockSize=7)
    if p0 is None or len(p0) < 12:
        # Featureless view (a blank wall filling frame). No evidence either
        # way, so return a neutral inlier ratio and let blur scoring decide.
        return 0.0, 1.0
    p1, st, _ = cv2.calcOpticalFlowPyrLK(
        prev.astype(np.uint8), cur.astype(np.uint8), p0, None,
        winSize=(21, 21), maxLevel=3,
        criteria=(cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 30, 0.01))
    if p1 is None or st is None:
        return 0.0, 0.0
    ok = st.reshape(-1).astype(bool)
    a, b = p0.reshape(-1, 2)[ok], p1.reshape(-1, 2)[ok]
    if len(a) < 12:
        return 0.0, 0.0
    flow = float(np.median(np.linalg.norm(b - a, axis=1)))
    h, mask = cv2.findHomography(a, b, cv2.RANSAC, 3.0, maxIters=2000)
    inlier = float(mask.mean()) if mask is not None else 0.0
    return flow, inlier


# ---------------------------------------------------------------------------
# Decoding and the stage entry point
# ---------------------------------------------------------------------------

def _resize_long_edge(img: np.ndarray, long_edge: int) -> np.ndarray:
    import cv2
    h, w = img.shape[:2]
    scale = long_edge / float(max(h, w))
    if scale >= 1.0:
        return img
    return cv2.resize(img, (int(round(w * scale)), int(round(h * scale))),
                      interpolation=cv2.INTER_AREA)


def run(inp: Input, ctx: RunContext) -> Output:
    import cv2

    cap = cv2.VideoCapture(inp.video_path)
    if not cap.isOpened():
        raise StageError(f"could not open {inp.video_path} for decoding")
    src_fps = cap.get(cv2.CAP_PROP_FPS) or inp.fps
    if src_fps <= 0:
        raise StageError("source frame rate is unknown; cannot subsample")
    stride = max(1, int(round(src_fps / inp.candidate_fps)))

    grays: list[np.ndarray] = []
    colours: list[np.ndarray] = []
    t_ms: list[int] = []
    src_idx: list[int] = []
    i = 0
    while True:
        ok = cap.grab()
        if not ok:
            break
        if i % stride == 0:
            ok, frame = cap.retrieve()
            if ok and frame is not None:
                small = _resize_long_edge(frame, SCORE_LONG_EDGE)
                grays.append(cv2.cvtColor(small, cv2.COLOR_BGR2GRAY))
                colours.append(frame)
                t_ms.append(int(round(i * 1000.0 / src_fps)))
                src_idx.append(i)
        i += 1
    cap.release()

    if len(grays) < ABSOLUTE_MIN_FRAMES:
        raise StageError(
            f"only {len(grays)} candidate frames decoded from {inp.video_path}; "
            f"below the absolute minimum of {ABSOLUTE_MIN_FRAMES}. This capture "
            "cannot support a reconstruction."
        )

    scores = score_sequence(grays, t_ms=t_ms, source_indices=src_idx)
    gh, gw = grays[0].shape[:2]
    diagonal = math.hypot(gw, gh)
    n_blur = mark_blur(scores)
    n_motion = mark_motion(scores, diagonal)
    kept, n_redundant = select_by_overlap(scores, float(gw), max_frames=inp.max_frames,
                                          min_frames=inp.min_frames)

    if len(kept) < ABSOLUTE_MIN_FRAMES:
        raise StageError(
            f"after blur and motion rejection only {len(kept)} frames survive "
            f"({n_blur} blurred, {n_motion} motion-inconsistent of "
            f"{len(scores)} candidates). The capture is too shaky to reconstruct."
        )

    warnings: list[str] = []
    blur_frac = n_blur / float(len(scores))
    # 25% is where a capture stops being "a few bad frames" and starts being a
    # systematically shaky walkthrough; the world still builds but an operator
    # should see it.
    if blur_frac > 0.25:
        warnings.append(f"{blur_frac:.0%} of candidate frames rejected as blurred; "
                        "capture technique is the limiting factor here")
    if len(kept) < inp.min_frames:
        warnings.append(f"only {len(kept)} frames selected, below the {inp.min_frames} "
                        "target; expect weaker coverage and wider unobserved regions")

    out_dir = ctx.data_dir() / "frames"
    out_dir.mkdir(parents=True, exist_ok=True)
    selected: list[SelectedFrame] = []
    for s in kept:
        img = _resize_long_edge(colours[s.index], inp.output_long_edge)
        fid = f"f{s.source_index:07d}"
        path = out_dir / f"{fid}.jpg"
        # JPEG quality 95: at 92 and below, blocking artefacts start showing up
        # as high-frequency detail that the splat faithfully reproduces.
        if not cv2.imwrite(str(path), img, [int(cv2.IMWRITE_JPEG_QUALITY), 95]):
            raise StageError(f"failed to write frame {path}")
        h, w = img.shape[:2]
        selected.append(SelectedFrame(frame_id=fid, path=str(path),
                                      source_index=s.source_index, t_ms=s.t_ms,
                                      sharpness=s.vol, sharpness_norm=s.vol_norm,
                                      width=w, height=h))

    import json
    scores_path = ctx.out("scores.json")
    scores_path.write_text(json.dumps(
        [{"index": s.index, "sourceIndex": s.source_index, "tMs": s.t_ms,
          "vol": round(s.vol, 4), "volNorm": round(s.vol_norm, 6),
          "flowPx": round(s.flow_px, 3), "flowInlierRatio": round(s.flow_inlier_ratio, 4),
          "rejectedBlur": s.rejected_blur, "rejectedMotion": s.rejected_motion,
          "selected": s.selected, "reason": s.reason} for s in scores], indent=1))

    disp = [s.flow_px / float(gw) for s in scores if s.index > 0]
    out = Output(
        frames=selected,
        candidate_count=len(scores),
        selected_count=len(selected),
        rejected_blur_count=n_blur,
        rejected_motion_count=n_motion,
        rejected_redundant_count=n_redundant,
        blur_rejection_fraction=blur_frac,
        median_sharpness=float(np.median([s.vol for s in scores])),
        median_displacement_frac=float(np.median(disp)) if disp else 0.0,
        scores_path=str(scores_path),
        warnings=warnings,
    )
    log(LOG, logging.INFO, "frames.ok", candidates=len(scores), selected=len(selected),
        rejected_blur=n_blur, rejected_motion=n_motion, redundant=n_redundant,
        blur_fraction=round(blur_frac, 4))
    return out
