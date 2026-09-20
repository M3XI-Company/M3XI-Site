"""The quality gate. These tests are about publication decisions, not maths."""
from __future__ import annotations

import pytest

from worldengine.stages import quality as Q


GOOD = {
    "redaction_completeness": 1.0, "scale_agreement": 0.95,
    "pose_consistency": 1.0, "geometry_consistency": 0.85,
    "room_completeness": 1.0, "identity_stability": 0.85,
    "navigation_continuity": 1.0, "floater_rate": 0.01,
    "unobserved_fraction": 0.12, "depth_confidence": 0.8,
    "semantic_confidence": 0.75, "blur_rejection_rate": 0.06,
}


def test_a_clean_world_passes():
    r = Q.evaluate(GOOD)
    assert r.verdict == "pass"
    assert r.score > 0.9
    assert all(c.pass_ for c in r.checks)
    assert len(r.checks) == len(Q.SPECS) == 12


def test_unapplied_redaction_fails_outright_however_good_the_rest_is():
    """One unapplied detection is one published face. Hard gate."""
    r = Q.evaluate({**GOOD, "redaction_completeness": 0.999})
    assert r.verdict == "fail"
    assert not next(c for c in r.checks if c.name == "redaction_completeness").pass_


def test_scale_disagreement_fails_outright():
    r = Q.evaluate({**GOOD, "scale_agreement": 0.6})
    assert r.verdict == "fail"


def test_a_single_soft_failure_routes_to_review_not_fail():
    r = Q.evaluate({**GOOD, "identity_stability": 0.5})
    assert r.verdict == "review"
    assert r.score > Q.FAIL_SCORE


def test_an_unreachable_room_routes_to_review():
    r = Q.evaluate({**GOOD, "navigation_continuity": 0.5})
    assert r.verdict == "review"


def test_many_soft_failures_fall_below_the_fail_score():
    bad = {**GOOD, "pose_consistency": 0.3, "geometry_consistency": 0.1,
           "room_completeness": 0.2, "identity_stability": 0.1,
           "navigation_continuity": 0.2, "unobserved_fraction": 0.9,
           "depth_confidence": 0.1, "semantic_confidence": 0.1,
           "floater_rate": 0.4}
    r = Q.evaluate(bad)
    assert r.verdict == "fail"
    assert r.score < Q.FAIL_SCORE


def test_missing_values_are_treated_as_not_passed():
    r = Q.evaluate({})
    assert r.verdict == "fail"
    assert not any(c.pass_ for c in r.checks)


def test_exceeding_one_threshold_cannot_offset_failing_another():
    """Normalisation is clipped at 1.0: a superb unredacted world is not a
    good world."""
    generous = {k: (v * 2 if k not in ("floater_rate", "unobserved_fraction",
                                       "blur_rejection_rate") else v * 0.1)
                for k, v in GOOD.items()}
    generous["redaction_completeness"] = 0.0
    r = Q.evaluate(generous)
    assert r.verdict == "fail"
    assert r.score <= 1.0


def test_lower_is_better_checks_invert_correctly():
    assert Q.score_check(next(s for s in Q.SPECS if s.name == "floater_rate"),
                         0.01).pass_
    assert not Q.score_check(next(s for s in Q.SPECS if s.name == "floater_rate"),
                             0.05).pass_
    spec = next(s for s in Q.SPECS if s.name == "unobserved_fraction")
    assert Q.normalised(spec, 0.10) == 1.0
    assert Q.normalised(spec, 0.25) == 1.0
    assert Q.normalised(spec, 0.50) < 1.0
    assert Q.normalised(spec, 1.0) == 0.0


def test_normalised_is_monotonic_for_higher_is_better():
    spec = next(s for s in Q.SPECS if s.name == "depth_confidence")
    vals = [Q.normalised(spec, v) for v in (0.0, 0.2, 0.4, 0.6, 0.9)]
    assert vals == sorted(vals)
    assert vals[-1] == 1.0


def test_every_spec_has_a_written_justification():
    """The brief asks for defensible thresholds with the argument written down.
    This test is the enforcement."""
    for spec in Q.SPECS:
        assert len(spec.rationale) > 80, spec.name
        assert spec.weight > 0
    assert abs(sum(s.weight for s in Q.SPECS) - 1.0) < 1e-9


def test_report_serialises_into_the_contract_shape():
    r = Q.evaluate(GOOD)
    j = r.to_json()
    assert set(j) == {"checks", "score", "verdict", "createdAt"}
    c = j["checks"][0]
    assert set(c) >= {"name", "value", "threshold", "higherIsBetter", "pass"}
    assert j["createdAt"].endswith("Z")


def test_floater_rate_from_the_shell_chunk():
    assert Q.floater_rate([0, 0, 0], [1, 1, 1], [], 100_000, 1_000) == 0.01
    assert Q.floater_rate([0, 0, 0], [1, 1, 1], [], 0, 0) == 1.0


def test_hard_gates_are_exactly_the_two_we_intend():
    assert {s.name for s in Q.SPECS if s.hard} == {"redaction_completeness",
                                                   "scale_agreement"}
