"""scale — fix metric scale, and cross-check it against a second estimator.

MapAnything and MoGe-2 both emit metric depth from monocular input. They are
independently trained on different data with different architectures, so their
agreement is genuine evidence and their disagreement is genuine warning. This
stage measures the agreement and lets it set the confidence of every dimension
the product will ever show.

The rule that matters: when they disagree beyond tolerance, the pipeline does
NOT average them. Averaging two estimates that disagree by 12% produces a
number that is wrong by 6% and carries no signal that anything went wrong. What
happens instead is that one estimator is chosen on stated grounds, the
confidence is downgraded, the world is flagged for review, and the flag
propagates into the quality gate.

Which one is chosen when they disagree: MoGe-2. MapAnything's metric head
aggregates across views, so a sequence with a short baseline or a dominant
mirror can drag the whole reconstruction's scale with it, and that is precisely
the situation in which the two disagree. MoGe-2 estimates per-image from
monocular cues (which is a weaker estimator on average and a more independent
one here). This is a defensible default, not a proof; the flag exists because
it is a default.

WHAT THE TOLERANCES ARE BASED ON. Indoor monocular metric depth is realistically
good to 2-5% on a clean capture. That is the number the published benchmarks
support and the number the measurement policy in contract.py is written
against; it is why the product quotes 5% on areas and 50 mm on wall lengths
rather than something tighter that would look better. Mirrors and glazing make
it worse: both estimators see through them, both put geometry behind them, and
they can do so consistently enough to agree with each other while both being
wrong. That is why mask_depth_for_scale drops saturated and out-of-range pixels
before anything is compared.
"""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Sequence

import numpy as np

from ..deps import require_cuda, require_module, require_weights
from ..logging_setup import get_logger, log
from ..reflective import mask_depth_for_scale
from ..runner import RunContext, StageError

LOG = get_logger("worldengine.scale")

SUMMARY = "MoGe-2 metric depth cross-checked against MapAnything; sets scale confidence"
USES_GPU = True
PRODUCES = ("scale.json", "moge/*.npz")

# Tolerances, in relative terms on the linear scale factor.
#
# AGREE_GOOD 3%: inside the 2-5% band that indoor monocular metric depth
# actually achieves, so two independent estimators landing this close is
# evidence the capture is clean.
AGREE_GOOD = 0.03
# AGREE_REVIEW 8%: the point at which a 4.00 m wall could be quoted as 4.32 m.
# That is outside the 5% area tolerance the product publishes, so it must not
# publish itself.
AGREE_REVIEW = 0.08
# Beyond REVIEW, the estimators are telling different stories about the same
# building and the scale is not usable for measurement at all.

# Number of frames sampled for MoGe. The estimate is a median over frames, and
# the standard error of a median falls as 1/sqrt(n): 60 frames puts the
# sampling noise an order of magnitude below the 3% agreement threshold, and
# more frames buy nothing but GPU seconds.
SAMPLE_FRAMES = 60
# Minimum co-valid pixels in a frame for its ratio to count. Below this the
# per-frame median is noise.
MIN_VALID_PIXELS = 5000


@dataclass(slots=True)
class Input:
    cameras: list[dict[str, Any]]
    depth_dir: str
    mapanything_scale_factor: float
    sample_frames: int = SAMPLE_FRAMES


@dataclass(slots=True)
class Output:
    source: str
    scale_factor: float             # multiply MapAnything-frame geometry by this
    agreement: float                # 0..1, for WorldDocument.scale.agreement
    relative_disagreement: float    # |exp(median log ratio) - 1|
    spread: float                   # robust spread of per-frame log ratios
    frames_used: int
    provenance: str
    confidence: float
    needs_review: bool
    per_frame_ratio_path: str
    warnings: list[str] = field(default_factory=list)


def build_input(ctx: RunContext, upstream: dict[str, Any]) -> Input:
    pose = upstream.get("pose") or {}
    if not pose.get("cameras"):
        raise StageError("scale requires the pose stage output")
    return Input(
        cameras=list(pose["cameras"]),
        depth_dir=str(pose["depth_dir"]),
        mapanything_scale_factor=float(pose.get("mapanything_scale_factor", 1.0)),
        sample_frames=int(ctx.param("scale_sample_frames", SAMPLE_FRAMES)),
    )


# ---------------------------------------------------------------------------
# Pure statistics — the part that decides publication, tested without a GPU
# ---------------------------------------------------------------------------

def robust_log_ratio(a: np.ndarray, b: np.ndarray, mask: np.ndarray) -> float | None:
    """Median log(a/b) over the masked pixels, or None if there are too few.

    Log ratio rather than ratio because scale error is multiplicative: a depth
    that is 10% too large and one that is 10% too small should be symmetric
    about zero, and in the linear ratio they are not (1.1 vs 0.909).
    """
    m = np.asarray(mask, dtype=bool)
    if int(m.sum()) < MIN_VALID_PIXELS:
        return None
    x = np.asarray(a, dtype=np.float64)[m]
    y = np.asarray(b, dtype=np.float64)[m]
    ok = (x > 1e-4) & (y > 1e-4)
    if int(ok.sum()) < MIN_VALID_PIXELS:
        return None
    return float(np.median(np.log(x[ok]) - np.log(y[ok])))


def robust_spread(values: Sequence[float]) -> float:
    """Median absolute deviation scaled to a standard-deviation equivalent.

    1.4826 is the consistency constant that makes the MAD an unbiased estimator
    of sigma for a normal distribution. MAD rather than std because a single
    frame that caught a mirror full-frame would otherwise dominate.
    """
    if len(values) < 2:
        return 0.0
    v = np.asarray(values, dtype=np.float64)
    return float(1.4826 * np.median(np.abs(v - np.median(v))))


def agreement_score(relative_disagreement: float) -> float:
    """Map |ratio - 1| onto 0..1 for WorldDocument.scale.agreement.

    Piecewise-linear with knots at the two published thresholds, so the number
    in the document means something specific: >= 0.9 is inside the 3% band,
    0.5-0.9 is between 3% and 8% and therefore under review, below 0.5 means
    the two estimators disagree beyond anything the product can quote.
    """
    r = abs(float(relative_disagreement))
    if r <= AGREE_GOOD:
        return float(1.0 - 0.10 * (r / AGREE_GOOD))
    if r <= AGREE_REVIEW:
        return float(0.9 - 0.40 * ((r - AGREE_GOOD) / (AGREE_REVIEW - AGREE_GOOD)))
    # Beyond review: decay toward 0 with a 16% half-life, so 24% disagreement
    # scores ~0.18 rather than clipping to 0 and losing the ordering.
    return float(0.5 * np.exp(-(r - AGREE_REVIEW) / 0.16))


def decide_scale(log_ratios: Sequence[float], mapanything_scale: float) -> dict[str, Any]:
    """Turn per-frame log ratios into a scale decision.

    log_ratio = log(moge_depth / mapanything_depth), so exp(median) is the
    factor that takes MapAnything's world into MoGe's.
    """
    if not log_ratios:
        raise StageError("no frame produced enough co-valid depth pixels to "
                         "cross-check metric scale; the capture is unusable for "
                         "measurement")
    centre = float(np.median(log_ratios))
    spread = robust_spread(log_ratios)
    ratio = float(np.exp(centre))
    # Symmetric relative disagreement. |ratio - 1| is NOT symmetric: MoGe
    # reading 10% high gives 0.100 and MoGe reading 10% low gives 0.091, so the
    # same magnitude of error would land on different sides of a threshold
    # depending on which estimator happened to be the larger one. Taking the
    # magnitude in log space first removes that.
    disagreement = abs(float(np.expm1(abs(centre))))
    agree = agreement_score(disagreement)

    if disagreement <= AGREE_GOOD:
        # They agree. Keep MapAnything's frame (the pose graph is already in
        # it) and correct by the small residual, which is measurement, not
        # averaging: the correction is the cross-check's own estimate.
        source = "mapanything+moge2:agreed"
        scale = ratio
        provenance = "inferred"
        confidence = float(np.clip(0.92 - disagreement / AGREE_GOOD * 0.07, 0.8, 0.95))
        review = False
        note = ""
    elif disagreement <= AGREE_REVIEW:
        source = "moge2:disagreement-within-review-band"
        scale = ratio
        provenance = "inferred"
        confidence = float(np.clip(0.65 - (disagreement - AGREE_GOOD)
                                   / (AGREE_REVIEW - AGREE_GOOD) * 0.20, 0.4, 0.65))
        review = True
        note = (f"estimators differ by {disagreement:.1%}, outside the {AGREE_GOOD:.0%} "
                f"agreement band; MoGe-2 adopted and the world routed to review")
    else:
        source = "moge2:estimators-disagree"
        scale = ratio
        provenance = "inferred"
        confidence = 0.25
        review = True
        note = (f"estimators differ by {disagreement:.1%}, beyond the "
                f"{AGREE_REVIEW:.0%} review threshold. Dimensions from this world "
                "are not fit to quote. Common causes: a large mirror, a glazed "
                "wall, or a capture that never showed a full room.")

    return {"source": source, "scale_factor": scale, "agreement": agree,
            "relative_disagreement": disagreement, "spread": spread,
            "provenance": provenance, "confidence": confidence,
            "needs_review": review, "note": note, "centre_log_ratio": centre}


# ---------------------------------------------------------------------------
# MoGe-2
# ---------------------------------------------------------------------------

def run_moge(frames: Sequence[dict[str, Any]], *, device: str, out_dir: Path
             ) -> dict[str, np.ndarray]:
    """MoGe-2 per-frame metric depth.

    `MoGeModel.infer(image)` returns a dict with `points` (H, W, 3) in the
    camera frame, `depth` (H, W) metric, `mask` (H, W) valid, `normal` when the
    -normal checkpoint is used, and `intrinsics` (3, 3) normalised.
    """
    torch = require_cuda(why="scale runs MoGe-2", min_vram_gb=8.0)
    moge_v2 = require_module("moge.model.v2", why="scale runs MoGe-2")
    require_weights("moge-2-vitl-normal", why="scale runs MoGe-2",
                    source="Ruicheng/moge-2-vitl-normal (MIT)")
    import cv2

    model = moge_v2.MoGeModel.from_pretrained("Ruicheng/moge-2-vitl-normal").to(device).eval()
    out: dict[str, np.ndarray] = {}
    out_dir.mkdir(parents=True, exist_ok=True)
    for meta in frames:
        bgr = cv2.imread(meta["path"], cv2.IMREAD_COLOR)
        if bgr is None:
            raise StageError(f"could not read frame {meta['path']}")
        rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
        t = torch.from_numpy(rgb).permute(2, 0, 1).float().div_(255.0).to(device)
        with torch.no_grad():
            pred = model.infer(t)
        depth = pred["depth"].float().cpu().numpy()
        valid = pred["mask"].cpu().numpy().astype(bool)
        np.savez_compressed(out_dir / f"{meta['frame_id']}.npz",
                            depth=depth.astype(np.float32), mask=valid)
        out[meta["frame_id"]] = depth
    return out


def run(inp: Input, ctx: RunContext) -> Output:
    import cv2
    device = "cuda"
    require_cuda(why="scale runs MoGe-2", min_vram_gb=8.0)

    # Even temporal spread rather than the first N: scale is a property of the
    # whole building and the last room deserves a vote.
    cams = inp.cameras
    step = max(1, len(cams) // max(1, inp.sample_frames))
    sample = cams[::step][: inp.sample_frames]

    moge_dir = ctx.data_dir() / "moge"
    moge_depths = run_moge(sample, device=device, out_dir=moge_dir)

    depth_dir = Path(inp.depth_dir)
    log_ratios: list[float] = []
    per_frame: list[dict[str, Any]] = []
    for meta in sample:
        fid = meta["frame_id"]
        npz = depth_dir / f"{fid}.npz"
        if not npz.exists():
            continue
        ma = np.load(npz)["depth"]
        mg = moge_depths[fid]
        if ma.shape != mg.shape:
            # MapAnything runs at its own resolution; compare on MoGe's grid.
            ma = cv2.resize(ma, (mg.shape[1], mg.shape[0]),
                            interpolation=cv2.INTER_NEAREST)
        bgr = cv2.imread(meta["path"], cv2.IMREAD_COLOR)
        rgb = cv2.cvtColor(cv2.resize(bgr, (mg.shape[1], mg.shape[0])),
                           cv2.COLOR_BGR2RGB)
        mask = mask_depth_for_scale(mg, rgb) & mask_depth_for_scale(ma, rgb)
        r = robust_log_ratio(mg, ma, mask)
        if r is not None:
            log_ratios.append(r)
            per_frame.append({"frameId": fid, "logRatio": round(r, 6),
                              "validPixels": int(mask.sum())})

    decision = decide_scale(log_ratios, inp.mapanything_scale_factor)
    spread = decision["spread"]
    warnings: list[str] = []
    if decision["note"]:
        warnings.append(decision["note"])
    # A wide spread with a tight centre means the estimators agree on average
    # while disagreeing violently frame to frame, which is the signature of a
    # mirror seen in some views and not others.
    if spread > 0.06:
        warnings.append(
            f"per-frame scale ratios have a robust spread of {spread:.1%}; the "
            "estimators agree on average but not frame to frame, which usually "
            "means a reflective surface is in part of the capture")
    if len(log_ratios) < max(10, inp.sample_frames // 4):
        warnings.append(f"only {len(log_ratios)} of {len(sample)} sampled frames "
                        "produced enough co-valid depth to compare")

    path = ctx.out("scale.json")
    path.write_text(json.dumps({"decision": {k: v for k, v in decision.items()},
                                "perFrame": per_frame}, indent=1))

    out = Output(
        source=decision["source"],
        scale_factor=float(decision["scale_factor"]),
        agreement=float(decision["agreement"]),
        relative_disagreement=float(decision["relative_disagreement"]),
        spread=float(spread),
        frames_used=len(log_ratios),
        provenance=str(decision["provenance"]),
        confidence=float(decision["confidence"]),
        needs_review=bool(decision["needs_review"]),
        per_frame_ratio_path=str(path),
        warnings=warnings,
    )
    log(LOG, logging.INFO, "scale.ok", scale_factor=round(out.scale_factor, 5),
        agreement=round(out.agreement, 4),
        disagreement_pct=round(out.relative_disagreement * 100, 2),
        frames=out.frames_used, review=out.needs_review)
    return out
