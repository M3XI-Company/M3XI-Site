"""Metric scale cross-checking: the statistics that decide whether a dimension
can be quoted at all."""
from __future__ import annotations

import math

import numpy as np
import pytest

from worldengine.stages import scale as S
from worldengine.reflective import mask_depth_for_scale


def test_robust_log_ratio_recovers_a_known_factor():
    rng = np.random.default_rng(0)
    base = rng.uniform(1.0, 6.0, (200, 200)).astype(np.float32)
    mask = np.ones((200, 200), bool)
    r = S.robust_log_ratio(base * 1.07, base, mask)
    assert math.isclose(math.exp(r), 1.07, rel_tol=1e-6)


def test_robust_log_ratio_ignores_a_minority_of_wild_pixels():
    """A mirror in part of the frame must not move the estimate."""
    rng = np.random.default_rng(1)
    base = rng.uniform(1.0, 6.0, (300, 300)).astype(np.float32)
    other = base * 1.03
    other[:60, :] = 40.0          # 20% of pixels see through a mirror
    r = S.robust_log_ratio(other, base, np.ones((300, 300), bool))
    assert abs(math.exp(r) - 1.03) < 0.02


def test_robust_log_ratio_needs_enough_valid_pixels():
    a = np.ones((100, 100), np.float32)
    small = np.zeros((100, 100), bool)
    small[:10, :10] = True
    assert S.robust_log_ratio(a, a, small) is None


def test_robust_spread_is_mad_based():
    assert S.robust_spread([1.0]) == 0.0
    vals = [0.0] * 50 + [10.0]     # one outlier
    assert S.robust_spread(vals) < 0.001
    assert S.robust_spread(list(np.random.default_rng(0).normal(0, 1, 5000))) \
        == pytest.approx(1.0, abs=0.05)


def test_agreement_score_knots_land_on_the_published_thresholds():
    assert S.agreement_score(0.0) == pytest.approx(1.0)
    assert S.agreement_score(S.AGREE_GOOD) == pytest.approx(0.9)
    assert S.agreement_score(S.AGREE_REVIEW) == pytest.approx(0.5)
    assert S.agreement_score(0.24) < 0.25
    # Monotone decreasing, so the number orders worlds in the review queue.
    xs = [0.0, 0.01, 0.03, 0.05, 0.08, 0.12, 0.3]
    ys = [S.agreement_score(x) for x in xs]
    assert ys == sorted(ys, reverse=True)


def test_agreement_score_matches_the_quality_gate_threshold():
    """The gate demands agreement >= 0.90, which must correspond exactly to the
    3% band. If these drift apart the gate stops meaning what it says."""
    from worldengine.stages.quality import SPECS
    gate = next(s for s in SPECS if s.name == "scale_agreement").threshold
    assert S.agreement_score(S.AGREE_GOOD) == pytest.approx(gate)
    assert S.agreement_score(S.AGREE_GOOD + 0.001) < gate


def test_agreement_decision_keeps_full_confidence():
    d = S.decide_scale([math.log(1.01)] * 40, 1.0)
    assert d["needs_review"] is False
    assert d["confidence"] > 0.8
    assert d["agreement"] > 0.9
    assert "agreed" in d["source"]
    assert math.isclose(d["scale_factor"], 1.01, rel_tol=1e-9)


def test_moderate_disagreement_routes_to_review_and_does_not_average():
    """5% apart: MoGe is adopted outright. The returned factor must be MoGe's,
    not the midpoint — averaging would produce a number wrong by 2.5% carrying
    no signal that anything went wrong."""
    d = S.decide_scale([math.log(1.05)] * 40, 1.0)
    assert d["needs_review"] is True
    assert math.isclose(d["scale_factor"], 1.05, rel_tol=1e-9)
    assert not math.isclose(d["scale_factor"], 1.025, rel_tol=1e-3)
    assert 0.4 <= d["confidence"] <= 0.65
    assert "outside the 3% agreement band" in d["note"]


def test_severe_disagreement_collapses_confidence_and_says_why():
    d = S.decide_scale([math.log(1.22)] * 40, 1.0)
    assert d["needs_review"] is True
    assert d["confidence"] <= 0.25
    assert d["agreement"] < 0.5
    assert "not fit to quote" in d["note"]
    assert "mirror" in d["note"]


def test_disagreement_is_symmetric_in_log_space():
    up = S.decide_scale([math.log(1.10)] * 20, 1.0)
    down = S.decide_scale([math.log(1 / 1.10)] * 20, 1.0)
    assert up["confidence"] == down["confidence"]
    assert up["agreement"] == pytest.approx(down["agreement"], abs=0.02)


def test_no_usable_frames_is_an_error_not_a_default():
    with pytest.raises(Exception, match="unusable for measurement"):
        S.decide_scale([], 1.0)


def test_published_tolerances_reflect_measured_reality():
    """The 5% area tolerance the contract publishes must be no tighter than the
    scale agreement band the pipeline can actually certify."""
    from worldengine.contract import DEFAULT_MEASUREMENT_POLICY as P
    assert P.area_tolerance_pct >= S.AGREE_GOOD * 100
    assert P.area_tolerance_pct <= S.AGREE_REVIEW * 100


def test_mask_drops_saturated_and_out_of_range_depth():
    depth = np.full((10, 10), 3.0, np.float32)
    depth[0, 0] = 0.0            # invalid
    depth[0, 1] = 40.0           # beyond indoor range
    depth[0, 2] = np.nan
    rgb = np.full((10, 10, 3), 128, np.uint8)
    rgb[1, 0] = 255              # blown-out window
    rgb[1, 1] = 0                # crushed black
    m = mask_depth_for_scale(depth, rgb)
    assert not m[0, 0] and not m[0, 1] and not m[0, 2]
    assert not m[1, 0] and not m[1, 1]
    assert m[5, 5]
