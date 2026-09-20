"""Frame selection and blur scoring, on synthetic images.

Blur rejection is the highest-ROI thing in the pipeline, so it gets the most
direct tests: synthesise sharp and blurred frames with known properties and
check that the scorer separates them, that the threshold is contrast-invariant,
and that the selector keeps overlap in band.
"""
from __future__ import annotations

import math

import numpy as np
import pytest

from worldengine.stages import frames as F


def sharp_image(h=240, w=320, seed=0) -> np.ndarray:
    """Broadband texture: checkerboard plus noise, which has energy at every
    spatial frequency, like a real bookcase."""
    rng = np.random.default_rng(seed)
    yy, xx = np.mgrid[0:h, 0:w]
    checker = (((xx // 8) + (yy // 8)) % 2) * 160.0 + 40.0
    return np.clip(checker + rng.normal(0, 12, (h, w)), 0, 255)


def box_blur(img: np.ndarray, k: int) -> np.ndarray:
    """Separable box blur, which is what motion blur looks like to first order."""
    pad = k // 2
    out = np.pad(img, pad, mode="edge")
    cs = np.cumsum(np.cumsum(out, axis=0), axis=1)
    cs = np.pad(cs, ((1, 0), (1, 0)))
    h, w = img.shape
    return (cs[k:k + h, k:k + w] - cs[0:h, k:k + w]
            - cs[k:k + h, 0:w] + cs[0:h, 0:w]) / float(k * k)


def test_laplacian_variance_falls_with_blur():
    img = sharp_image()
    scores = [F.laplacian_variance(img)]
    for k in (3, 5, 9, 15):
        scores.append(F.laplacian_variance(box_blur(img, k)))
    assert all(a > b for a, b in zip(scores, scores[1:])), scores
    assert scores[0] > 20 * scores[-1]


def test_contrast_normalisation_makes_the_score_contrast_invariant():
    """A dark hallway and a bright bay window must score the same sharpness.
    This is the property that lets ONE threshold work across a whole flat."""
    img = sharp_image()
    dim = img * 0.25 + 30.0
    _, s_bright = F.contrast_normalised_sharpness(img)
    _, s_dim = F.contrast_normalised_sharpness(dim)
    assert abs(s_bright - s_dim) / s_bright < 0.05
    # The raw variance of Laplacian is NOT invariant, which is why we normalise.
    raw_bright = F.laplacian_variance(img)
    raw_dim = F.laplacian_variance(dim)
    assert raw_dim < 0.1 * raw_bright


def test_laplacian_variance_rejects_non_2d():
    with pytest.raises(ValueError):
        F.laplacian_variance(np.zeros((4, 4, 3)))
    assert F.laplacian_variance(np.zeros((2, 2))) == 0.0


def test_rolling_median_is_centred_and_clamps_edges():
    vals = [1.0, 2.0, 3.0, 100.0, 5.0, 6.0, 7.0]
    med = F.rolling_median(vals, 5)
    assert len(med) == len(vals)
    assert med[3] == 5.0            # the spike does not move its own median
    assert med[0] == 2.0            # clamped window [1,2,3]
    assert F.rolling_median([], 5) == []


def _scores(vol_norms, flows=None, inliers=None):
    n = len(vol_norms)
    flows = flows if flows is not None else [10.0] * n
    inliers = inliers if inliers is not None else [0.9] * n
    return [F.FrameScore(index=i, source_index=i * 3, t_ms=i * 400,
                         vol=vol_norms[i] * 1000, vol_norm=vol_norms[i],
                         flow_px=flows[i], flow_inlier_ratio=inliers[i])
            for i in range(n)]


def test_mark_blur_rejects_the_locally_bad_frames_only():
    base = [0.05] * 60
    for i in (7, 23, 41):
        base[i] = 0.01           # 0.2x the local median -> rejected
    scores = _scores(base)
    n = F.mark_blur(scores)
    assert n == 3
    assert {s.index for s in scores if s.rejected_blur} == {7, 23, 41}
    assert "local median" in scores[7].reason


def test_mark_blur_is_relative_so_a_uniformly_dim_capture_is_not_all_rejected():
    """Every frame at 0.006 — soft but consistent. A relative threshold keeps
    them; an absolute one would throw away the whole capture."""
    scores = _scores([0.006] * 80)
    assert F.mark_blur(scores) == 0


def test_mark_blur_absolute_floor_catches_a_whole_bad_window():
    """A fast pan where EVERY candidate is smeared: the rolling median is also
    low, so only the absolute floor saves us."""
    scores = _scores([0.0004] * 40)
    assert F.mark_blur(scores) == 40
    assert "absolute floor" in scores[0].reason


def test_mark_motion_rejects_incoherent_tracks_and_huge_flow():
    diag = math.hypot(960, 540)
    scores = _scores([0.05] * 6,
                     flows=[0, 10, 10, 0.4 * diag, 10, 10],
                     inliers=[1.0, 0.9, 0.2, 0.9, 0.9, 0.9])
    n = F.mark_motion(scores, diag)
    assert n == 2
    assert scores[2].rejected_motion and "homography" in scores[2].reason
    assert scores[3].rejected_motion and "median flow" in scores[3].reason
    assert not scores[0].rejected_motion      # index 0 has no predecessor


def test_select_by_overlap_spaces_frames_in_the_target_band():
    width = 960.0
    # 30 px of flow per candidate; target displacement is 0.30 * 960 = 288 px,
    # so a keeper roughly every 10 candidates. 3000 candidates is long enough
    # that the target spacing already clears the frame floor, so no back-off.
    scores = _scores([0.05] * 3000, flows=[30.0] * 3000)
    kept, redundant = F.select_by_overlap(scores, width, max_frames=4000)
    gaps = [b.index - a.index for a, b in zip(kept, kept[1:])]
    assert kept[0].index == 0
    assert len(kept) >= F.MIN_FRAMES
    assert all(9 <= gu <= 11 for gu in gaps), gaps[:10]
    assert redundant > 0


def test_select_by_overlap_skips_blurred_and_keeps_the_next_sharp_one():
    scores = _scores([0.05] * 100, flows=[100.0] * 100)   # keeper every ~3
    for s in scores:
        if s.index in (3, 4, 5):
            s.rejected_blur = True
    kept, _ = F.select_by_overlap(scores, 960.0)
    idx = [s.index for s in kept]
    assert not ({3, 4, 5} & set(idx))
    assert 6 in idx      # the gap is bridged rather than left open


def test_select_by_overlap_backs_off_spacing_to_reach_the_frame_floor():
    """Target spacing gives 166 frames, under the 200 floor. One halving of the
    target must bring it over without going below the redundancy floor."""
    scores = _scores([0.05] * 800, flows=[60.0] * 800)
    kept, _ = F.select_by_overlap(scores, 960.0, max_frames=4000)
    assert len(kept) >= F.MIN_FRAMES
    gaps = [b.index - a.index for a, b in zip(kept, kept[1:])]
    # 0.10 * 960 = 96 px is the redundancy floor: 60 px per candidate means
    # consecutive keepers must still be at least 2 candidates apart.
    assert min(gaps) >= 2


def test_select_by_overlap_does_not_pad_a_short_slow_capture():
    """Almost no camera motion across 260 candidates. Padding the set to the
    frame floor would add 200 near-identical views: pure cost, no information.
    The selector must return the few genuinely distinct frames and let run()
    report the shortfall."""
    scores = _scores([0.05] * 260, flows=[1.0] * 260)
    kept, _ = F.select_by_overlap(scores, 960.0)
    assert len(kept) < 10
    gaps = [b.index - a.index for a, b in zip(kept, kept[1:])]
    assert all(gu >= 90 for gu in gaps)     # 96 px floor at 1 px per candidate


def test_select_by_overlap_caps_and_keeps_the_sharpest_across_the_whole_walk():
    vols = [0.05] * 900
    # Make the last 100 candidates the sharpest; a naive truncation would drop
    # them entirely, which in a walkthrough means dropping the last room.
    for i in range(800, 900):
        vols[i] = 0.2
    scores = _scores(vols, flows=[400.0] * 900)
    kept, _ = F.select_by_overlap(scores, 960.0, max_frames=200)
    assert len(kept) == 200
    assert max(s.index for s in kept) >= 850


def test_score_sequence_uses_injected_flow_and_reports_first_frame_neutral():
    grays = [sharp_image(seed=i) for i in range(5)]
    calls = []

    def fake_flow(a, b):
        calls.append((a.shape, b.shape))
        return 12.5, 0.77

    out = F.score_sequence(grays, t_ms=[0, 400, 800, 1200, 1600],
                           source_indices=[0, 3, 6, 9, 12], flow_fn=fake_flow)
    assert len(out) == 5 and len(calls) == 4
    assert out[0].flow_px == 0.0 and out[0].flow_inlier_ratio == 1.0
    assert out[1].flow_px == 12.5 and out[1].flow_inlier_ratio == 0.77
    assert out[2].source_index == 6 and out[2].t_ms == 800
    assert all(s.vol > 0 for s in out)


def test_score_sequence_rejects_mismatched_lengths():
    with pytest.raises(ValueError):
        F.score_sequence([sharp_image()], t_ms=[0, 1], source_indices=[0])


def test_end_to_end_rejection_fraction_on_a_synthetic_walkthrough():
    """300 candidates, 18 of them blurred (6%). The reported fraction must be
    the real one — the brief asks the stage to report what it rejects."""
    rng = np.random.default_rng(5)
    vols = list(rng.normal(0.05, 0.004, 300))
    bad = sorted(rng.choice(300, 18, replace=False).tolist())
    for i in bad:
        vols[i] = 0.012
    scores = _scores([max(v, 0.001) for v in vols], flows=[30.0] * 300)
    n_blur = F.mark_blur(scores)
    frac = n_blur / len(scores)
    assert n_blur == 18, sorted(s.index for s in scores if s.rejected_blur)
    assert abs(frac - 0.06) < 1e-9
    kept, _ = F.select_by_overlap(scores, 960.0)
    assert not any(s.rejected_blur for s in kept)


def test_lk_flow_on_a_known_translation():
    """The real OpenCV path: shift a textured image by 7 px and check the flow
    comes back as 7 px with a high inlier ratio."""
    cv2 = pytest.importorskip("cv2")
    img = sharp_image(240, 320, seed=2).astype(np.uint8)
    shifted = np.roll(img, 7, axis=1)
    flow, inlier = F.lk_flow(img, shifted)
    assert abs(flow - 7.0) < 1.0
    assert inlier > 0.8
