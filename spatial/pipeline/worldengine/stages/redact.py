"""redact — find and destroy PII in the frames, before anything else sees them.

This stage runs between `frames` and `pose`. That ordering is the entire point
and the runner enforces it structurally (see runner.validate_privacy_ordering):
every pixel-consuming stage reads Output.frames from HERE, not from the frames
stage, so an unredacted pixel has no path into a splat, a mesh, a cover image
or an export bundle. Blurring a published splat afterwards does not work —
gaussians are a 3D representation and a face baked into them can be recovered
from a viewpoint the blur never considered.

Why it exists, concretely. A published UK property tour exposed a dividend
cheque, an insurance policy, a stairlift invoice and an inhaler — four separate
disclosures about one household's finances and health, from one video. A study
of 44 US virtual tours found names, medication labels and card details across
them. None of that requires an attacker; it requires a buyer with a pause
button.

What is detected, with what, and under what licence:

  faces                    YuNet (cv2.FaceDetectorYN), MIT, opencv_zoo weights.
                           Chosen over the usual SCRFD/RetinaFace because the
                           InsightFace model zoo is non-commercial and this is
                           a commercial product.
  documents, correspondence
                           docTR text detection (db_resnet50), Apache-2.0, run
                           as a *density* detector: we do not read the text, we
                           find regions where text is dense enough to be a
                           document rather than a book spine or a kitchen
                           label.
  screens, framed photos, medication, number plates, people
                           OWLv2 (google/owlv2-base-patch16-ensemble),
                           Apache-2.0, open-vocabulary text-prompted detection.
                           Deliberately NOT YOLO-World, which is GPL-3.0 and
                           would contaminate the product.
  mask refinement          SAM 3.1, prompted with the boxes above, so the
                           inpaint follows the object rather than a rectangle.
                           Optional; without it the box is used directly.

Inpainting. The default is destructive, not generative: dilate the mask,
Telea-inpaint from the surrounding texture, then blur the filled region and
feather it back in. Two reasons. First, a generative inpainter fabricates
plausible content, and a fabricated letter on a fabricated desk is arguably a
worse artefact in a property listing than a smudge. Second, the obvious
high-quality choice — LaMa — ships its `big-lama` weights under
CC BY-NC-SA 4.0, which is non-commercial. The Apache-2.0 on the LaMa *code* is
not the licence that matters. A neural inpainter can be enabled with
`params.redact_inpainter`, and the stage records which was used, but nothing
non-commercial is wired in by default.

Everything detected is written to redactions.json with bbox, detector, score
and kind, for the operator review queue (wv_redaction), whether or not it was
applied.
"""
from __future__ import annotations

import json
import logging
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Iterable, Sequence

import numpy as np

from ..deps import require_cuda, require_module, require_weights
from ..logging_setup import get_logger, log
from ..runner import RunContext, StageError

LOG = get_logger("worldengine.redact")

SUMMARY = "Detect and inpaint faces, documents, screens, photos, medication, plates"
USES_GPU = True
PRODUCES = ("frames/*.jpg", "redactions.json", "masks/*.png")

# Prompts for the open-vocabulary detector. Written as noun phrases because
# OWLv2's text encoder is trained on caption-like strings; "a document" scores
# noticeably better than "document".
OWL_PROMPTS: dict[str, tuple[str, ...]] = {
    "document": ("a printed letter", "a document on a table", "a bill or invoice",
                 "an envelope", "a certificate in a frame"),
    "correspondence": ("a pile of post", "a greetings card on a shelf",
                       "a postcard", "a handwritten note"),
    "screen": ("a television screen", "a computer monitor", "a laptop screen",
               "a mobile phone screen", "a tablet screen"),
    "photo": ("a framed photograph of a person", "a photograph on a wall",
              "a family photo in a picture frame"),
    "medication": ("a box of medicine", "a pill bottle", "a blister pack of tablets",
                   "an asthma inhaler", "a prescription label"),
    "plate": ("a vehicle number plate", "a car licence plate"),
    "person": ("a person", "a face of a person"),
    "window": ("a window", "a glass window pane", "a patio door"),
}

# Per-kind score thresholds. Asymmetric on purpose: missing a medication box is
# a privacy failure, over-redacting a kitchen appliance is a cosmetic one, so
# the PII classes sit lower. Calibrated against OWLv2's typical operating range
# where 0.10-0.15 is the usable floor for indoor clutter.
OWL_THRESHOLDS: dict[str, float] = {
    "document": 0.12, "correspondence": 0.14, "screen": 0.18, "photo": 0.16,
    "medication": 0.10, "plate": 0.12, "person": 0.22, "window": 0.25,
}

# Faces: YuNet's own score. 0.6 is its recommended default; below ~0.5 it
# starts firing on patterned cushions, and a redacted cushion in every frame
# costs reconstruction quality.
FACE_SCORE_THRESHOLD = 0.60

# docTR: a region is treated as a document when text words cover enough of it.
# A single word is a label on a tin; a paragraph is correspondence.
TEXT_MIN_WORDS = 6
TEXT_MIN_DENSITY = 0.020        # fraction of the cluster box covered by word boxes

# A person is only PII-through-a-window if they are actually in the window.
PERSON_WINDOW_IOU = 0.35

# Mask dilation, as a fraction of the box's short side. PII leaks at the edges:
# the top of a letterhead, the corner of a face. 8% is enough to cover detector
# jitter between adjacent frames without eating the surrounding wall.
MASK_DILATE_FRAC = 0.08
MASK_DILATE_MIN_PX = 6

# Kinds where a plausible inpaint is unacceptable and the region is destroyed
# outright (strong blur over a flat fill) rather than reconstructed.
DESTROY_KINDS = frozenset({"face", "document", "correspondence", "medication",
                           "plate", "screen"})

REDACTION_KINDS = ("face", "document", "correspondence", "screen", "photo",
                   "medication", "plate", "person_through_window")


@dataclass(slots=True)
class Detection:
    frame_id: str
    kind: str
    bbox: tuple[float, float, float, float]   # x, y, w, h in image pixels
    detector: str
    score: float
    prompt: str = ""
    applied: bool = False
    mask_path: str | None = None

    def to_json(self) -> dict[str, Any]:
        return {"frameId": self.frame_id, "kind": self.kind,
                "bbox": [round(float(v), 2) for v in self.bbox],
                "detector": self.detector, "score": round(float(self.score), 4),
                "prompt": self.prompt, "applied": self.applied,
                "maskPath": self.mask_path}


@dataclass(slots=True)
class Input:
    frames: list[dict[str, Any]]
    capture_id: str
    inpainter: str = "telea"          # telea | none
    use_sam_refinement: bool = True
    batch_size: int = 8
    enabled_kinds: tuple[str, ...] = REDACTION_KINDS


@dataclass(slots=True)
class RedactedFrame:
    frame_id: str
    path: str
    source_index: int
    t_ms: int
    sharpness: float
    width: int
    height: int
    redaction_count: int


@dataclass(slots=True)
class Output:
    frames: list[RedactedFrame]
    detections_path: str
    detection_count: int
    applied_count: int
    frames_with_redactions: int
    counts_by_kind: dict[str, int]
    detectors: dict[str, str]
    inpainter: str
    completeness: float
    warnings: list[str] = field(default_factory=list)


def build_input(ctx: RunContext, upstream: dict[str, Any]) -> Input:
    fr = upstream.get("frames") or {}
    if not fr.get("frames"):
        raise StageError("redact requires the frames stage output")
    kinds = ctx.param("redact_kinds")
    return Input(
        frames=list(fr["frames"]),
        capture_id=str(ctx.param("capture_id", ctx.run_id)),
        inpainter=str(ctx.param("redact_inpainter", "telea")),
        use_sam_refinement=bool(ctx.param("redact_sam_refinement", True)),
        batch_size=int(ctx.param("redact_batch_size", 8)),
        enabled_kinds=tuple(kinds) if kinds else REDACTION_KINDS,
    )


# ---------------------------------------------------------------------------
# Pure geometry and planning. Tested without any model.
# ---------------------------------------------------------------------------

def iou(a: Sequence[float], b: Sequence[float]) -> float:
    ax, ay, aw, ah = a
    bx, by, bw, bh = b
    x0, y0 = max(ax, bx), max(ay, by)
    x1, y1 = min(ax + aw, bx + bw), min(ay + ah, by + bh)
    if x1 <= x0 or y1 <= y0:
        return 0.0
    inter = (x1 - x0) * (y1 - y0)
    return inter / (aw * ah + bw * bh - inter + 1e-9)


def contained_fraction(inner: Sequence[float], outer: Sequence[float]) -> float:
    """Fraction of `inner`'s area that lies inside `outer`."""
    ax, ay, aw, ah = inner
    bx, by, bw, bh = outer
    x0, y0 = max(ax, bx), max(ay, by)
    x1, y1 = min(ax + aw, bx + bw), min(ay + ah, by + bh)
    if x1 <= x0 or y1 <= y0:
        return 0.0
    return ((x1 - x0) * (y1 - y0)) / (aw * ah + 1e-9)


def nms(boxes: Sequence[Sequence[float]], scores: Sequence[float],
        threshold: float = 0.5) -> list[int]:
    order = sorted(range(len(boxes)), key=lambda i: -scores[i])
    keep: list[int] = []
    while order:
        i = order.pop(0)
        keep.append(i)
        order = [j for j in order if iou(boxes[i], boxes[j]) < threshold]
    return keep


def cluster_text_boxes(word_boxes: Sequence[Sequence[float]], *,
                       gap_frac: float = 1.2) -> list[tuple[float, float, float, float]]:
    """Group word boxes into document-sized clusters.

    Single-link clustering where two words join if their gap is under
    `gap_frac` times the taller word's height. That ratio is what separates
    lines of a letter (gaps well under one line height) from unrelated labels
    on opposite sides of a worktop.
    """
    n = len(word_boxes)
    if n == 0:
        return []
    parent = list(range(n))

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    def union(i: int, j: int) -> None:
        ri, rj = find(i), find(j)
        if ri != rj:
            parent[rj] = ri

    for i in range(n):
        xi, yi, wi, hi = word_boxes[i]
        for j in range(i + 1, n):
            xj, yj, wj, hj = word_boxes[j]
            gap_x = max(0.0, max(xi, xj) - min(xi + wi, xj + wj))
            gap_y = max(0.0, max(yi, yj) - min(yi + hi, yj + hj))
            lim = gap_frac * max(hi, hj)
            if gap_x <= lim and gap_y <= lim:
                union(i, j)

    groups: dict[int, list[int]] = {}
    for i in range(n):
        groups.setdefault(find(i), []).append(i)

    out: list[tuple[float, float, float, float]] = []
    for members in groups.values():
        if len(members) < TEXT_MIN_WORDS:
            continue
        xs0 = min(word_boxes[i][0] for i in members)
        ys0 = min(word_boxes[i][1] for i in members)
        xs1 = max(word_boxes[i][0] + word_boxes[i][2] for i in members)
        ys1 = max(word_boxes[i][1] + word_boxes[i][3] for i in members)
        area = max(1e-6, (xs1 - xs0) * (ys1 - ys0))
        covered = sum(word_boxes[i][2] * word_boxes[i][3] for i in members)
        if covered / area < TEXT_MIN_DENSITY:
            continue
        out.append((xs0, ys0, xs1 - xs0, ys1 - ys0))
    return out


def people_through_windows(people: Sequence[Detection],
                           windows: Sequence[Detection]) -> list[Detection]:
    """A person detection that sits inside a window detection is a neighbour or
    a passer-by, visible from a property they do not live in. That is a
    different disclosure from the homeowner walking through their own hallway
    and it is redacted as its own kind so operators can see it separately."""
    out: list[Detection] = []
    for p in people:
        for w in windows:
            if contained_fraction(p.bbox, w.bbox) >= PERSON_WINDOW_IOU:
                out.append(Detection(frame_id=p.frame_id, kind="person_through_window",
                                     bbox=p.bbox, detector=p.detector, score=p.score,
                                     prompt=p.prompt))
                break
    return out


def build_mask(shape: tuple[int, int], dets: Iterable[Detection]) -> np.ndarray:
    """Binary uint8 mask, with each box dilated by MASK_DILATE_FRAC."""
    h, w = shape
    mask = np.zeros((h, w), dtype=np.uint8)
    for d in dets:
        x, y, bw, bh = d.bbox
        pad = max(MASK_DILATE_MIN_PX, MASK_DILATE_FRAC * min(bw, bh))
        x0 = int(max(0, np.floor(x - pad)))
        y0 = int(max(0, np.floor(y - pad)))
        x1 = int(min(w, np.ceil(x + bw + pad)))
        y1 = int(min(h, np.ceil(y + bh + pad)))
        if x1 > x0 and y1 > y0:
            mask[y0:y1, x0:x1] = 255
    return mask


def redact_image(img: np.ndarray, mask: np.ndarray, *, destroy: bool,
                 inpainter: str = "telea") -> np.ndarray:
    """Remove the masked content from `img`.

    destroy=True is used for the kinds where reconstructing plausible content
    would be a lie (faces, documents, medication, plates, screens): the region
    is replaced with a heavily blurred version of its surroundings, so no
    high-frequency content survives and nothing is invented. destroy=False
    (framed photographs, which are furniture as much as PII) uses Telea
    inpainting alone, which keeps the wall looking like a wall.

    The result is feathered at the mask edge, because a hard rectangle edge is
    exactly the kind of high-contrast structure a splat trainer will happily
    reconstruct as a floating slab.
    """
    import cv2

    if img.ndim != 3 or img.shape[2] != 3:
        raise ValueError(f"expected an HxWx3 BGR image, got {img.shape}")
    if mask.shape[:2] != img.shape[:2]:
        raise ValueError("mask and image must be the same size")
    if not mask.any():
        return img

    if inpainter == "none":
        filled = img.copy()
        # Flat fill with the local mean: no texture, no information.
        mean = cv2.blur(img, (99, 99))
        filled[mask > 0] = mean[mask > 0]
    elif inpainter == "telea":
        filled = cv2.inpaint(img, mask, 5, cv2.INPAINT_TELEA)
    else:
        raise StageError(
            f"unknown inpainter {inpainter!r}. Only 'telea' and 'none' are "
            "wired in; a neural inpainter must be added deliberately and its "
            "weight licence checked first (big-lama is CC BY-NC-SA and cannot "
            "be used here)."
        )

    if destroy:
        # Blur the *filled* image, so the blur has no original pixels to work
        # from. Kernel scales with the region so a full-frame document is as
        # thoroughly destroyed as a small one.
        ys, xs = np.nonzero(mask)
        span = max(int(xs.max() - xs.min()), int(ys.max() - ys.min()), 1)
        k = max(31, (span // 4) | 1)
        filled = cv2.GaussianBlur(filled, (k, k), 0)

    # Feather: 1 inside the mask, falling to 0 over ~2% of the short edge.
    feather = max(5, (min(img.shape[:2]) // 50) | 1)
    alpha = cv2.GaussianBlur(mask.astype(np.float32) / 255.0, (feather, feather), 0)
    alpha = np.clip(alpha, 0.0, 1.0)[:, :, None]
    return (img.astype(np.float32) * (1.0 - alpha)
            + filled.astype(np.float32) * alpha).astype(np.uint8)


# ---------------------------------------------------------------------------
# Detectors
# ---------------------------------------------------------------------------

class FaceDetector:
    """YuNet, MIT-licensed, shipped in opencv_zoo. Runs on CPU fast enough that
    it is not worth the GPU round-trip for a 1600px frame."""

    def __init__(self) -> None:
        import cv2
        weights = require_weights(
            "yunet/face_detection_yunet_2023mar.onnx",
            why="redact detects faces",
            source="https://github.com/opencv/opencv_zoo (MIT)")
        self.model = cv2.FaceDetectorYN.create(
            str(weights), "", (320, 320),
            score_threshold=FACE_SCORE_THRESHOLD, nms_threshold=0.3, top_k=500)
        self.name = "yunet-2023mar"

    def detect(self, img: np.ndarray, frame_id: str) -> list[Detection]:
        h, w = img.shape[:2]
        self.model.setInputSize((w, h))
        _, faces = self.model.detect(img)
        out: list[Detection] = []
        for f in (faces if faces is not None else []):
            x, y, bw, bh = (float(v) for v in f[:4])
            out.append(Detection(frame_id=frame_id, kind="face",
                                 bbox=(x, y, bw, bh), detector=self.name,
                                 score=float(f[-1])))
        return out


class OpenVocabDetector:
    """OWLv2, Apache-2.0. One forward pass per frame over all prompts."""

    def __init__(self, device: str, prompts: dict[str, tuple[str, ...]]) -> None:
        tf = require_module("transformers", why="redact runs open-vocabulary detection")
        torch = require_module("torch", why="redact runs open-vocabulary detection")
        path = require_weights("owlv2-base-patch16-ensemble",
                               why="redact runs open-vocabulary detection",
                               source="google/owlv2-base-patch16-ensemble (Apache-2.0)")
        self.processor = tf.Owlv2Processor.from_pretrained(str(path))
        self.model = tf.Owlv2ForObjectDetection.from_pretrained(str(path)).to(device).eval()
        self.torch = torch
        self.device = device
        self.prompts = prompts
        self.flat: list[str] = []
        self.kind_of: list[str] = []
        for kind, texts in prompts.items():
            for t in texts:
                self.flat.append(t)
                self.kind_of.append(kind)
        self.name = "owlv2-base-patch16-ensemble"

    def detect(self, img_rgb: np.ndarray, frame_id: str) -> list[Detection]:
        torch = self.torch
        inputs = self.processor(text=[self.flat], images=img_rgb,
                                return_tensors="pt").to(self.device)
        with torch.no_grad():
            outputs = self.model(**inputs)
        h, w = img_rgb.shape[:2]
        results = self.processor.post_process_grounded_object_detection(
            outputs=outputs, target_sizes=torch.tensor([[h, w]], device=self.device),
            threshold=min(OWL_THRESHOLDS.values()))[0]
        out: list[Detection] = []
        for box, score, label in zip(results["boxes"].tolist(),
                                     results["scores"].tolist(),
                                     results["labels"].tolist()):
            kind = self.kind_of[int(label)]
            if score < OWL_THRESHOLDS[kind]:
                continue
            x0, y0, x1, y1 = box
            out.append(Detection(frame_id=frame_id, kind=kind,
                                 bbox=(x0, y0, x1 - x0, y1 - y0),
                                 detector=self.name, score=float(score),
                                 prompt=self.flat[int(label)]))
        return out


class TextDetector:
    """docTR db_resnet50, Apache-2.0. Detection only — the pipeline never reads
    the text. Knowing where a document is is enough to remove it, and OCRing a
    stranger's correspondence to decide whether to remove it would be the same
    privacy violation we are here to prevent."""

    def __init__(self, device: str) -> None:
        doctr = require_module("doctr", why="redact finds documents by text density")
        from doctr.models import detection_predictor  # noqa: PLC0415
        self.predictor = detection_predictor(arch="db_resnet50", pretrained=True,
                                             assume_straight_pages=True)
        self.predictor = self.predictor.to(device) if hasattr(self.predictor, "to") \
            else self.predictor
        self.name = "doctr-db_resnet50"

    def detect(self, img_rgb: np.ndarray, frame_id: str) -> list[Detection]:
        h, w = img_rgb.shape[:2]
        res = self.predictor([img_rgb])
        # docTR returns relative [x0, y0, x1, y1, score] per page.
        words: list[tuple[float, float, float, float]] = []
        for page in res:
            arr = page["words"] if isinstance(page, dict) else page
            for row in np.asarray(arr).reshape(-1, 5):
                x0, y0, x1, y1 = row[0] * w, row[1] * h, row[2] * w, row[3] * h
                words.append((float(x0), float(y0), float(x1 - x0), float(y1 - y0)))
        return [Detection(frame_id=frame_id, kind="document", bbox=b,
                          detector=self.name, score=0.9, prompt="text-density")
                for b in cluster_text_boxes(words)]


def refine_with_sam(sam: Any, img_rgb: np.ndarray, dets: Sequence[Detection],
                    shape: tuple[int, int]) -> np.ndarray | None:
    """Turn boxes into instance masks with SAM 3.1 so the inpaint follows the
    object outline. Returns a combined uint8 mask or None if SAM is not loaded."""
    if sam is None or not dets:
        return None
    boxes = np.array([[d.bbox[0], d.bbox[1], d.bbox[0] + d.bbox[2],
                       d.bbox[1] + d.bbox[3]] for d in dets], dtype=np.float32)
    sam.set_image(img_rgb)
    masks, _, _ = sam.predict(box=boxes, multimask_output=False)
    m = np.asarray(masks).reshape(-1, *shape)
    return (m.any(axis=0) * 255).astype(np.uint8)


# ---------------------------------------------------------------------------
# Stage entry point
# ---------------------------------------------------------------------------

def run(inp: Input, ctx: RunContext) -> Output:
    import cv2

    torch = require_cuda(why="redact runs OWLv2 and SAM over every frame",
                         min_vram_gb=8.0)
    device = "cuda"

    prompts = {k: v for k, v in OWL_PROMPTS.items()
               if k in inp.enabled_kinds or k in ("person", "window")}
    face_det = FaceDetector() if "face" in inp.enabled_kinds else None
    owl = OpenVocabDetector(device, prompts) if prompts else None
    text_det = TextDetector(device) if "document" in inp.enabled_kinds else None

    sam = None
    if inp.use_sam_refinement:
        sam3 = require_module("sam3", why="redact refines redaction masks with SAM 3.1")
        ckpt = require_weights("sam3/sam3.1_hiera_large.pt",
                               why="redact refines redaction masks with SAM 3.1",
                               source="facebook/sam3 model card")
        sam = sam3.SAM3ImagePredictor.from_pretrained(str(ckpt)).to(device)

    out_dir = ctx.data_dir() / "frames"
    mask_dir = ctx.data_dir() / "masks"
    out_dir.mkdir(parents=True, exist_ok=True)
    mask_dir.mkdir(parents=True, exist_ok=True)

    all_dets: list[Detection] = []
    frames: list[RedactedFrame] = []
    counts: dict[str, int] = {k: 0 for k in REDACTION_KINDS}
    applied = 0
    frames_touched = 0

    for meta in inp.frames:
        fid = meta["frame_id"]
        img = cv2.imread(meta["path"], cv2.IMREAD_COLOR)
        if img is None:
            raise StageError(f"could not read frame {meta['path']}")
        rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
        h, w = img.shape[:2]

        dets: list[Detection] = []
        if face_det is not None:
            dets += face_det.detect(img, fid)
        owl_dets = owl.detect(rgb, fid) if owl is not None else []
        if text_det is not None:
            dets += text_det.detect(rgb, fid)

        people = [d for d in owl_dets if d.kind == "person"]
        windows = [d for d in owl_dets if d.kind == "window"]
        # 'person' and 'window' are scaffolding, not redaction kinds: a
        # homeowner walking through their own hallway is not PII by itself,
        # their face is (handled by YuNet), and a neighbour framed in a window
        # is (handled here).
        dets += [d for d in owl_dets if d.kind in REDACTION_KINDS and d.kind != "person"]
        dets += people_through_windows(people, windows)
        dets = [d for d in dets if d.kind in inp.enabled_kinds]

        # Per-kind NMS: overlapping prompts ("a printed letter" and "a bill or
        # invoice") routinely fire on the same object.
        deduped: list[Detection] = []
        for kind in {d.kind for d in dets}:
            group = [d for d in dets if d.kind == kind]
            keep = nms([d.bbox for d in group], [d.score for d in group], 0.5)
            deduped += [group[i] for i in keep]
        dets = deduped

        dst = out_dir / f"{fid}.jpg"
        if dets:
            frames_touched += 1
            destroy = [d for d in dets if d.kind in DESTROY_KINDS]
            keep_texture = [d for d in dets if d.kind not in DESTROY_KINDS]
            result = img
            for group, hard in ((destroy, True), (keep_texture, False)):
                if not group:
                    continue
                mask = refine_with_sam(sam, rgb, group, (h, w))
                if mask is None:
                    mask = build_mask((h, w), group)
                else:
                    # SAM masks hug the object; still dilate so the edge of a
                    # letter or a face does not survive at the boundary.
                    mask = cv2.dilate(mask, np.ones((9, 9), np.uint8), iterations=2)
                result = redact_image(result, mask, destroy=hard,
                                      inpainter=inp.inpainter)
                mp = mask_dir / f"{fid}_{'hard' if hard else 'soft'}.png"
                cv2.imwrite(str(mp), mask)
                for d in group:
                    d.applied = True
                    d.mask_path = str(mp)
                    applied += 1
            if not cv2.imwrite(str(dst), result, [int(cv2.IMWRITE_JPEG_QUALITY), 95]):
                raise StageError(f"failed to write redacted frame {dst}")
        else:
            # No detections: copy through unchanged, but through this stage's
            # directory, so downstream code has exactly one source of frames.
            if not cv2.imwrite(str(dst), img, [int(cv2.IMWRITE_JPEG_QUALITY), 95]):
                raise StageError(f"failed to write frame {dst}")

        for d in dets:
            counts[d.kind] = counts.get(d.kind, 0) + 1
        all_dets += dets
        frames.append(RedactedFrame(
            frame_id=fid, path=str(dst), source_index=int(meta["source_index"]),
            t_ms=int(meta["t_ms"]), sharpness=float(meta["sharpness"]),
            width=w, height=h, redaction_count=len(dets)))

    det_path = ctx.out("redactions.json")
    det_path.write_text(json.dumps([d.to_json() for d in all_dets], indent=1))

    completeness = (applied / len(all_dets)) if all_dets else 1.0
    warnings: list[str] = []
    if completeness < 1.0:
        warnings.append(f"{len(all_dets) - applied} detections were recorded but not "
                        "applied; the quality gate will block publication")
    if sam is None:
        warnings.append("SAM refinement disabled; redaction masks are rectangles, "
                        "which over-redacts and can cost reconstruction detail")

    out = Output(
        frames=frames,
        detections_path=str(det_path),
        detection_count=len(all_dets),
        applied_count=applied,
        frames_with_redactions=frames_touched,
        counts_by_kind=counts,
        detectors={"face": face_det.name if face_det else "",
                   "openVocab": owl.name if owl else "",
                   "text": text_det.name if text_det else "",
                   "maskRefinement": "sam3.1" if sam else "box"},
        inpainter=inp.inpainter,
        completeness=completeness,
        warnings=warnings,
    )
    log(LOG, logging.INFO, "redact.ok", detections=len(all_dets), applied=applied,
        frames_with_redactions=frames_touched, counts=counts)
    return out
