"""Redaction planning and pixel destruction.

The detectors need a GPU and weights; the planning logic and the inpainting do
not, and they are where the privacy guarantees actually live.
"""
from __future__ import annotations

import numpy as np
import pytest

from worldengine.stages import redact as RD


def test_iou_and_containment():
    a = (0, 0, 10, 10)
    assert RD.iou(a, a) == pytest.approx(1.0)
    assert RD.iou(a, (20, 20, 5, 5)) == 0.0
    assert RD.iou(a, (5, 0, 10, 10)) == pytest.approx(50 / 150)
    assert RD.contained_fraction((2, 2, 4, 4), a) == pytest.approx(1.0)
    assert RD.contained_fraction((8, 8, 4, 4), a) == pytest.approx(0.25)


def test_nms_removes_duplicate_prompts_firing_on_one_object():
    boxes = [(0, 0, 10, 10), (1, 1, 10, 10), (50, 50, 10, 10)]
    scores = [0.9, 0.8, 0.7]
    keep = RD.nms(boxes, scores, 0.5)
    assert keep == [0, 2]


def test_cluster_text_boxes_finds_a_document_not_a_label():
    # A paragraph: 12 words on 3 lines, tightly spaced.
    words = []
    for line in range(3):
        for col in range(4):
            words.append((100 + col * 30, 200 + line * 16, 26, 12))
    clusters = RD.cluster_text_boxes(words)
    assert len(clusters) == 1
    x, y, w, h = clusters[0]
    assert x == pytest.approx(100) and y == pytest.approx(200)
    assert w > 100 and h > 30


def test_cluster_text_boxes_ignores_a_lone_label():
    """One or two words on a tin is not correspondence, and redacting every
    label in a kitchen would gut the reconstruction."""
    assert RD.cluster_text_boxes([(10, 10, 40, 12), (60, 10, 30, 12)]) == []


def test_cluster_text_boxes_separates_distant_groups():
    left = [(0 + c * 30, r * 16, 26, 12) for r in range(3) for c in range(3)]
    right = [(900 + c * 30, r * 16, 26, 12) for r in range(3) for c in range(3)]
    clusters = RD.cluster_text_boxes(left + right)
    assert len(clusters) == 2


def test_people_through_windows_only_fires_when_the_person_is_in_the_window():
    def det(kind, bbox):
        return RD.Detection(frame_id="f", kind=kind, bbox=bbox,
                            detector="owlv2", score=0.5)
    window = det("window", (100, 100, 200, 300))
    inside = det("person", (150, 150, 60, 200))
    outside = det("person", (500, 150, 60, 200))
    out = RD.people_through_windows([inside, outside], [window])
    assert len(out) == 1
    assert out[0].kind == "person_through_window"
    assert out[0].bbox == inside.bbox


def test_build_mask_dilates_beyond_the_box():
    d = RD.Detection(frame_id="f", kind="face", bbox=(100, 100, 50, 50),
                     detector="yunet", score=0.9)
    mask = RD.build_mask((400, 400), [d])
    assert mask[125, 125] == 255
    # Dilation is at least MASK_DILATE_MIN_PX, so just outside the box is
    # covered too: PII leaks at the edges.
    assert mask[100 - 3, 100 - 3] == 255
    assert mask[50, 50] == 0


def test_build_mask_clips_at_the_image_edge():
    d = RD.Detection(frame_id="f", kind="face", bbox=(-20, -20, 60, 60),
                     detector="yunet", score=0.9)
    mask = RD.build_mask((100, 100), [d])
    assert mask.shape == (100, 100)
    assert mask[0, 0] == 255


def _textured(h=200, w=200, seed=1):
    rng = np.random.default_rng(seed)
    yy, xx = np.mgrid[0:h, 0:w]
    base = (((xx // 4) + (yy // 4)) % 2) * 200
    img = np.stack([base, base, base], axis=2).astype(np.float32)
    return np.clip(img + rng.normal(0, 10, img.shape), 0, 255).astype(np.uint8)


def test_redact_image_destroys_high_frequency_content_in_the_masked_region():
    pytest.importorskip("cv2")
    img = _textured()
    mask = np.zeros((200, 200), np.uint8)
    mask[60:140, 60:140] = 255
    out = RD.redact_image(img, mask, destroy=True)

    def detail(a):
        g = a[:, :, 0].astype(np.float64)
        lap = (-4 * g[1:-1, 1:-1] + g[:-2, 1:-1] + g[2:, 1:-1]
               + g[1:-1, :-2] + g[1:-1, 2:])
        return lap[70:130, 70:130].var()

    assert detail(out) < 0.02 * detail(img)


def test_redact_image_leaves_the_rest_of_the_frame_alone():
    pytest.importorskip("cv2")
    img = _textured()
    mask = np.zeros((200, 200), np.uint8)
    mask[60:140, 60:140] = 255
    out = RD.redact_image(img, mask, destroy=True)
    # Outside the mask and outside the feather band, pixels are untouched.
    assert np.array_equal(out[:20, :20], img[:20, :20])
    assert np.array_equal(out[180:, 180:], img[180:, 180:])


def test_redact_image_is_a_no_op_on_an_empty_mask():
    img = _textured()
    out = RD.redact_image(img, np.zeros((200, 200), np.uint8), destroy=True)
    assert np.array_equal(out, img)


def test_redact_image_feathers_rather_than_leaving_a_hard_edge():
    """A hard rectangle edge is exactly the structure a splat trainer will
    reconstruct as a floating slab, so the replacement is alpha-blended over a
    band around the mask rather than composited at the mask boundary."""
    pytest.importorskip("cv2")
    img = _textured(500, 500)
    mask = np.zeros((500, 500), np.uint8)
    mask[150:350, 150:350] = 255
    out = RD.redact_image(img, mask, destroy=True)
    feather = max(5, (500 // 50) | 1)

    just_outside = np.abs(out[250, 150 - 2].astype(int)
                          - img[250, 150 - 2].astype(int)).max()
    well_outside = np.abs(out[250, 150 - 4 * feather].astype(int)
                          - img[250, 150 - 4 * feather].astype(int)).max()
    assert just_outside > 0, "the blend must extend past the mask boundary"
    assert well_outside == 0, "and must not reach the rest of the frame"


def test_redact_image_rejects_an_unknown_inpainter():
    img = _textured()
    mask = np.zeros((200, 200), np.uint8)
    mask[10:20, 10:20] = 255
    with pytest.raises(Exception, match="big-lama is CC BY-NC-SA"):
        RD.redact_image(img, mask, destroy=False, inpainter="lama")


def test_redact_image_validates_shapes():
    with pytest.raises(ValueError, match="HxWx3"):
        RD.redact_image(np.zeros((10, 10), np.uint8), np.zeros((10, 10), np.uint8),
                        destroy=True)
    with pytest.raises(ValueError, match="same size"):
        RD.redact_image(np.zeros((10, 10, 3), np.uint8),
                        np.zeros((5, 5), np.uint8), destroy=True)


def test_destroy_kinds_cover_every_class_where_invention_would_be_worse():
    assert RD.DESTROY_KINDS == {"face", "document", "correspondence",
                                "medication", "plate", "screen"}
    # Framed photographs are furniture as much as PII, so they are inpainted
    # rather than obliterated; everything else in the list is destroyed.
    assert "photo" not in RD.DESTROY_KINDS
    assert set(RD.DESTROY_KINDS) <= set(RD.REDACTION_KINDS)


def test_thresholds_are_lower_for_the_classes_that_matter_most():
    """Missing a medication box is a privacy failure; over-redacting a TV is
    cosmetic. The thresholds must reflect that asymmetry."""
    assert RD.OWL_THRESHOLDS["medication"] < RD.OWL_THRESHOLDS["screen"]
    assert RD.OWL_THRESHOLDS["document"] < RD.OWL_THRESHOLDS["person"]
    assert all(0.0 < v < 0.5 for v in RD.OWL_THRESHOLDS.values())
