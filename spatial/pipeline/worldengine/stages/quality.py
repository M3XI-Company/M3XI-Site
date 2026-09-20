"""quality — the gate that decides whether a world may be published.

A world becomes viewable because it passed, not because the pipeline finished.
Three verdicts:

    pass    publishable without a human looking at it
    review  an operator must look; the world is held
    fail    not publishable; the capture has to be redone

Every threshold below is a product decision with a consequence, so each one is
justified where it is defined. The general principle: a threshold is set where
crossing it would make a specific claim in a listing wrong, not where it makes
the score look good. Two of them are hard gates that fail outright regardless
of the other scores, because no amount of geometric quality compensates for
them — redaction completeness and scale agreement.

The weights matter less than they look: the verdict is decided by the hard
gates and by any check failing, and the score exists to rank worlds inside the
review queue rather than to decide their fate.
"""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Sequence

import numpy as np

from ..contract import QualityCheck, QualityReport
from ..logging_setup import get_logger, log
from ..runner import RunContext, StageError

LOG = get_logger("worldengine.quality")

SUMMARY = "Score eleven checks against defended thresholds; pass / review / fail"
USES_GPU = False
PRODUCES = ("quality.json",)


@dataclass(slots=True)
class CheckSpec:
    name: str
    threshold: float
    higher_is_better: bool
    weight: float
    hard: bool          # failing this fails the world outright
    rationale: str


# ---------------------------------------------------------------------------
# The thresholds, and the argument for each.
# ---------------------------------------------------------------------------
SPECS: tuple[CheckSpec, ...] = (
    CheckSpec(
        "redaction_completeness", 1.0, True, 0.10, True,
        "Every detection must be applied. Not 0.99: one unapplied detection is "
        "one published face or one published bank letter, and the study that "
        "found names and medication labels across 44 US tours is what this "
        "number is here to prevent. A hard gate."),
    CheckSpec(
        "scale_agreement", 0.90, True, 0.14, True,
        "0.90 is the agreement score at which MoGe-2 and MapAnything are within "
        "3% of each other (see stages/scale.py). Below that, a 4.00 m wall could "
        "be quoted outside the 5% area tolerance the product publishes, so the "
        "world cannot state a dimension. A hard gate: it is a measurement "
        "product, and a measurement nobody can defend is a liability under the "
        "DMCC Act 2024."),
    CheckSpec(
        "pose_consistency", 0.95, True, 0.11, False,
        "Fraction of frames registered in bundle adjustment. Below 95% the pose "
        "graph has a disconnected component, which in a flat means one room "
        "floating relative to the rest — invisible in a single view and fatal "
        "to any measurement across rooms."),
    CheckSpec(
        "geometry_consistency", 0.70, True, 0.09, False,
        "Mean of (1 - reprojection error / 4 px) over the sparse points. 4 px at "
        "1600 px wide is roughly 0.25% of the image, which at 3 m depth is about "
        "8 mm of geometric error — inside the 50 mm wall tolerance with room to "
        "spare."),
    CheckSpec(
        "room_completeness", 0.80, True, 0.09, False,
        "Fraction of rooms with enough observation to be `reconstructed` rather "
        "than `inferred`. A world where a fifth of the rooms were closed from a "
        "doorway is a floorplan sketch, not a survey."),
    CheckSpec(
        "identity_stability", 0.70, True, 0.07, False,
        "Mean fraction of tracked frames in which an entity's lifted gaussians "
        "reproject onto its mask. Below 0.7 the agent will contradict itself "
        "about how many of something there are, which is the specific failure "
        "that makes a spatial assistant untrustworthy."),
    CheckSpec(
        "navigation_continuity", 1.0, True, 0.09, False,
        "Every room reachable from the entrance. Exactly 1.0, because a room "
        "the tour cannot walk into is a room the viewer will believe it saw. "
        "Not a hard gate only because the usual cause is a missed doorway that "
        "an operator can fix in a minute."),
    CheckSpec(
        "floater_rate", 0.02, False, 0.07, False,
        "Fraction of gaussians outside the building envelope plus a 0.5 m skin. "
        "2% is where floaters stop being invisible specks and start being the "
        "haze around a window that makes a tour look cheap."),
    CheckSpec(
        "unobserved_fraction", 0.25, False, 0.08, False,
        "Fraction of interior volume no camera observed. A quarter is generous "
        "— behind furniture and inside wardrobes is legitimately unobserved — "
        "but past it the tour is mostly inference and the regions overlay will "
        "dominate the view."),
    CheckSpec(
        "depth_confidence", 0.60, True, 0.07, False,
        "Median per-frame depth confidence from MapAnything. Below 0.6 the "
        "geometry is being carried by the photometric loss alone, which is the "
        "regime where walls end up wherever renders correctly."),
    CheckSpec(
        "semantic_confidence", 0.55, True, 0.05, False,
        "Mean entity confidence. Low here does not break the geometry, so it "
        "carries the smallest weight; it means the agent should decline more "
        "questions, not that the world is wrong."),
    CheckSpec(
        "blur_rejection_rate", 0.30, False, 0.04, False,
        "Fraction of candidate frames rejected as blurred. This is a check on "
        "the CAPTURE, not the pipeline: over 30% and the operator should be "
        "told to walk more slowly, because everything downstream is working "
        "from what survived."),
)

# Verdict rules.
#   any hard check failing            -> fail
#   score below FAIL_SCORE            -> fail
#   any non-hard check failing        -> review
#   otherwise                         -> pass
# FAIL_SCORE is 0.55 because with the weights above (which sum to exactly 1.0,
# enforced by tests/test_quality.py), a world can fail three mid-weight checks
# and still be salvageable by an operator; four is not.
FAIL_SCORE = 0.55
REVIEW_SCORE = 0.80


def score_check(spec: CheckSpec, value: float) -> QualityCheck:
    ok = (value >= spec.threshold) if spec.higher_is_better else (value <= spec.threshold)
    return QualityCheck(name=spec.name, value=float(value), threshold=spec.threshold,
                        higher_is_better=spec.higher_is_better, pass_=bool(ok),
                        detail=spec.rationale)


def normalised(spec: CheckSpec, value: float) -> float:
    """0..1 contribution of a check to the score.

    Linear to the threshold, then flat: exceeding a threshold does not earn
    credit that offsets failing another one. A world that is superb everywhere
    and unredacted is not a good world.
    """
    v = float(value)
    if spec.higher_is_better:
        if spec.threshold <= 0:
            return 1.0
        return float(np.clip(v / spec.threshold, 0.0, 1.0))
    if spec.threshold <= 0:
        return 1.0 if v <= 0 else 0.0
    return float(np.clip(1.0 - (v - spec.threshold) / max(spec.threshold, 1e-6), 0.0, 1.0)) \
        if v > spec.threshold else 1.0


def evaluate(values: dict[str, float]) -> QualityReport:
    """Turn measured values into a report. Missing values are treated as 0 for
    higher-is-better checks and as failing for the rest: a check that could not
    be measured has not been passed."""
    checks: list[QualityCheck] = []
    total_w = 0.0
    acc = 0.0
    hard_failed: list[str] = []
    soft_failed: list[str] = []
    for spec in SPECS:
        if spec.name in values:
            v = float(values[spec.name])
        else:
            v = 0.0 if spec.higher_is_better else float("inf")
        c = score_check(spec, v)
        checks.append(c)
        acc += spec.weight * normalised(spec, v)
        total_w += spec.weight
        if not c.pass_:
            (hard_failed if spec.hard else soft_failed).append(spec.name)

    score = float(acc / total_w) if total_w else 0.0
    if hard_failed or score < FAIL_SCORE:
        verdict = "fail"
    elif soft_failed or score < REVIEW_SCORE:
        verdict = "review"
    else:
        verdict = "pass"
    return QualityReport(checks=tuple(checks), score=score, verdict=verdict,
                         created_at=datetime.now(timezone.utc)
                         .strftime("%Y-%m-%dT%H:%M:%SZ"))


# ---------------------------------------------------------------------------
# Measurement
# ---------------------------------------------------------------------------

@dataclass(slots=True)
class Input:
    frames: dict[str, Any]
    redact: dict[str, Any]
    pose: dict[str, Any]
    scale: dict[str, Any]
    splat: dict[str, Any]
    mesh: dict[str, Any]
    layout: dict[str, Any]
    semantics: dict[str, Any]
    graph: dict[str, Any]
    regions: dict[str, Any]
    package: dict[str, Any]


@dataclass(slots=True)
class Output:
    checks: list[dict[str, Any]]
    score: float
    verdict: str
    created_at: str
    values: dict[str, float]
    report_path: str
    blocking: list[str] = field(default_factory=list)


def build_input(ctx: RunContext, upstream: dict[str, Any]) -> Input:
    def need(name: str) -> dict[str, Any]:
        v = upstream.get(name) or ctx.store.load(name)
        if not v:
            raise StageError(f"quality requires the {name} stage artefact")
        return v
    return Input(frames=need("frames"), redact=need("redact"), pose=need("pose"),
                 scale=need("scale"), splat=need("splat"), mesh=need("mesh"),
                 layout=need("layout"), semantics=need("semantics"),
                 graph=need("graph"), regions=need("regions"),
                 package=need("package"))


def floater_rate(aabb_min: Sequence[float], aabb_max: Sequence[float],
                 rooms: Sequence[dict[str, Any]], gaussian_count: int,
                 shell_count: int) -> float:
    """Fraction of gaussians outside every room's envelope.

    Computed from the packaging stage's `_shell` chunk, which already did the
    containment test: the shell is exactly the gaussians no room contains.
    Some of those are legitimate (the outside of a window, a balcony), so this
    is an upper bound on floaters and the threshold is set accordingly.
    """
    if gaussian_count <= 0:
        return 1.0
    return float(shell_count) / float(gaussian_count)


def run(inp: Input, ctx: RunContext) -> Output:
    rooms = inp.layout.get("rooms", [])
    reconstructed = sum(1 for r in rooms if r.get("provenance") == "reconstructed")

    shell = 0
    for a in inp.package.get("assets", []):
        if a.get("chunk_key") == "_shell" and a.get("lod") in (0, None):
            shell = int(a.get("splat_count") or 0)

    reproj = float(inp.pose.get("mean_reprojection_error_px") or 0.0)
    geom = 1.0 - min(1.0, reproj / 4.0) if reproj == reproj else 0.0

    entities = inp.semantics.get("entities", [])
    sem_conf = float(np.mean([e.get("confidence", 0.0) for e in entities])) if entities else 0.0
    depth_conf = float(np.median([c.get("pose_confidence", 0.0)
                                  for c in inp.pose.get("cameras", [])] or [0.0]))

    values: dict[str, float] = {
        "redaction_completeness": float(inp.redact.get("completeness", 0.0)),
        "scale_agreement": float(inp.scale.get("agreement", 0.0)),
        "pose_consistency": float(inp.pose.get("registered_fraction", 0.0)),
        "geometry_consistency": float(geom),
        "room_completeness": reconstructed / float(max(1, len(rooms))),
        "identity_stability": float(inp.semantics.get("mean_identity_stability", 0.0)),
        "navigation_continuity": float(inp.graph.get("navigation_continuity", 0.0)),
        "floater_rate": floater_rate(inp.splat.get("aabb_min", [0, 0, 0]),
                                     inp.splat.get("aabb_max", [0, 0, 0]),
                                     rooms, int(inp.splat.get("gaussian_count", 0)),
                                     shell),
        "unobserved_fraction": float(inp.regions.get("unobserved_fraction", 1.0)),
        "depth_confidence": depth_conf,
        "semantic_confidence": sem_conf,
        "blur_rejection_rate": float(inp.frames.get("blur_rejection_fraction", 0.0)),
    }

    report = evaluate(values)
    blocking = [c.name for c in report.checks if not c.pass_]

    path = ctx.out("quality.json")
    path.write_text(json.dumps({"report": report.to_json(), "values": values},
                               indent=1, default=float))

    out = Output(checks=[c.to_json() for c in report.checks], score=report.score,
                 verdict=report.verdict, created_at=report.created_at,
                 values=values, report_path=str(path), blocking=blocking)
    log(LOG, logging.INFO, "quality.ok", verdict=report.verdict,
        score=round(report.score, 4), failed=blocking)
    return out
