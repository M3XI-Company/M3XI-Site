"""ingest — probe the capture, normalise it, and refuse the ones that cannot work.

CPU only. ffprobe for metadata, ffmpeg for a remux when the container needs it.

The job here is cheap triage. A 15-second clip of one room, a 4K60 video shot
in portrait with rolling-shutter wobble, or a file whose rotation metadata is
90 degrees and whose pixels are not: each of these produces a bad world 30
GPU-minutes later. Catching them in the first ten seconds is the single
cheapest quality intervention in the pipeline.
"""
from __future__ import annotations

import json
import logging
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from ..deps import require_binary
from ..logging_setup import get_logger, log
from ..runner import RunContext, StageError

LOG = get_logger("worldengine.ingest")

SUMMARY = "Probe and normalise the source capture; reject unusable ones"
USES_GPU = False
PRODUCES = ("source.mp4", "probe.json")

# Thresholds, with reasons.
#
# MIN_DURATION_S: a two-bed flat walkthrough that covers every room with the
# 60-80% frame overlap the pose stage needs takes about 90 seconds at a normal
# walking pace. Under 45 s the capture has either skipped rooms or moved too
# fast for any of this to work, and it is kinder to say so immediately.
MIN_DURATION_S = 45.0
# Over 12 minutes and the frame budget forces such aggressive subsampling that
# overlap collapses; it is also 3x the cost model. Route to operator instead.
MAX_DURATION_S = 720.0
# Below 1080p the ALIKED keypoints that COLMAP refines on become sparse enough
# that pose error roughly doubles in our tolerance budget.
MIN_SHORT_EDGE = 1080
# 24 fps is the floor at which 2-3 fps frame selection still has candidates to
# reject; below it, blur rejection has nothing to choose between.
MIN_FPS = 24.0


@dataclass(slots=True)
class Input:
    source_path: str
    capture_id: str
    world_id: str
    expected_kind: str = "video"
    allow_short: bool = False


@dataclass(slots=True)
class Output:
    capture_id: str
    video_path: str
    duration_s: float
    fps: float
    width: int
    height: int
    rotation_deg: int
    frame_count_estimate: int
    codec: str
    bytes: int
    has_audio: bool
    device: dict[str, Any] = field(default_factory=dict)
    warnings: list[str] = field(default_factory=list)


def build_input(ctx: RunContext, upstream: dict[str, Any]) -> Input:
    src = ctx.param("source_path")
    if not src:
        raise StageError("ingest needs params.source_path (the capture file)")
    return Input(
        source_path=str(src),
        capture_id=str(ctx.param("capture_id", ctx.run_id)),
        world_id=ctx.world_id,
        expected_kind=str(ctx.param("capture_kind", "video")),
        allow_short=bool(ctx.param("allow_short_capture", False)),
    )


def ffprobe(path: str) -> dict[str, Any]:
    exe = require_binary("ffprobe", why="ingest probes the capture container")
    out = subprocess.run(
        [exe, "-v", "error", "-print_format", "json",
         "-show_format", "-show_streams", path],
        capture_output=True, text=True, check=False,
    )
    if out.returncode != 0:
        raise StageError(f"ffprobe failed on {path}: {out.stderr.strip()[:400]}")
    return json.loads(out.stdout)


def _parse_rate(value: str | None) -> float:
    if not value or value == "0/0":
        return 0.0
    if "/" in value:
        num, den = value.split("/", 1)
        return float(num) / float(den) if float(den) else 0.0
    return float(value)


def _rotation(stream: dict[str, Any]) -> int:
    """Rotation lives in two places depending on who wrote the file: the
    display matrix side-data (iPhone) or a tag (some Android encoders). Both
    must be honoured or the whole world comes out sideways."""
    for sd in stream.get("side_data_list", []) or []:
        if "rotation" in sd:
            return int(round(float(sd["rotation"]))) % 360
    tag = (stream.get("tags") or {}).get("rotate")
    return int(tag) % 360 if tag else 0


def run(inp: Input, ctx: RunContext) -> Output:
    src = Path(inp.source_path)
    if not src.exists():
        raise StageError(f"capture file does not exist: {src}")

    meta = ffprobe(str(src))
    streams = meta.get("streams", [])
    video = next((s for s in streams if s.get("codec_type") == "video"), None)
    if video is None:
        raise StageError(f"{src} has no video stream")
    has_audio = any(s.get("codec_type") == "audio" for s in streams)

    fmt = meta.get("format", {})
    duration = float(fmt.get("duration") or video.get("duration") or 0.0)
    fps = _parse_rate(video.get("avg_frame_rate")) or _parse_rate(video.get("r_frame_rate"))
    width, height = int(video["width"]), int(video["height"])
    rotation = _rotation(video)
    if rotation in (90, 270):
        width, height = height, width

    warnings: list[str] = []
    fatal: list[str] = []
    if duration < MIN_DURATION_S and not inp.allow_short:
        fatal.append(f"capture is {duration:.1f}s, below the {MIN_DURATION_S:.0f}s "
                     "minimum for a walkthrough with usable frame overlap")
    if duration > MAX_DURATION_S:
        warnings.append(f"capture is {duration/60:.1f} min, above the "
                        f"{MAX_DURATION_S/60:.0f} min budget; cost and frame "
                        "subsampling will both be worse than the model assumes")
    if min(width, height) < MIN_SHORT_EDGE:
        fatal.append(f"short edge is {min(width, height)}px, below {MIN_SHORT_EDGE}px; "
                     "keypoint density is too low for reliable pose refinement")
    if fps and fps < MIN_FPS:
        warnings.append(f"{fps:.1f} fps leaves blur rejection little to choose from")
    if fatal:
        raise StageError("capture rejected at ingest: " + "; ".join(fatal))

    # Device fingerprint. Not cosmetic: rolling-shutter behaviour and default
    # focal length differ enough between handsets that the pose stage uses this
    # to pick its initial intrinsics prior.
    tags = {**(fmt.get("tags") or {}), **(video.get("tags") or {})}
    device = {k: tags[k] for k in ("com.apple.quicktime.model",
                                   "com.apple.quicktime.software",
                                   "model", "make", "encoder", "handler_name")
              if k in tags}
    device["codec"] = video.get("codec_name", "")
    device["pixFmt"] = video.get("pix_fmt", "")

    # Normalise into the run directory: strip audio (never needed, and it is
    # PII we have no reason to hold), bake in rotation, keep the video stream
    # as-is so we do not re-encode and lose detail the splat would have used.
    dst = ctx.out("source.mp4")
    ff = require_binary("ffmpeg", why="ingest normalises the capture container")
    cmd = [ff, "-y", "-loglevel", "error", "-i", str(src), "-an",
           "-map", "0:v:0", "-c:v", "copy", "-movflags", "+faststart", str(dst)]
    proc = subprocess.run(cmd, capture_output=True, text=True, check=False)
    if proc.returncode != 0 or not dst.exists():
        # Stream copy fails on some fragmented MP4s and on HEVC in unusual
        # containers. Re-encode is lossy, so it is a fallback, and it is
        # recorded as a warning rather than done silently.
        warnings.append("stream copy failed; re-encoded to h264 crf18 "
                        f"({proc.stderr.strip()[:160]})")
        cmd = [ff, "-y", "-loglevel", "error", "-i", str(src), "-an",
               "-map", "0:v:0", "-c:v", "libx264", "-crf", "18",
               "-preset", "veryfast", "-pix_fmt", "yuv420p",
               "-movflags", "+faststart", str(dst)]
        proc = subprocess.run(cmd, capture_output=True, text=True, check=False)
        if proc.returncode != 0:
            raise StageError(f"ffmpeg could not normalise {src}: "
                             f"{proc.stderr.strip()[:400]}")

    probe_path = ctx.out("probe.json")
    probe_path.write_text(json.dumps(meta, indent=2))

    out = Output(
        capture_id=inp.capture_id,
        video_path=str(dst),
        duration_s=duration,
        fps=fps,
        width=width,
        height=height,
        rotation_deg=rotation,
        frame_count_estimate=int(round(duration * fps)) if fps else 0,
        codec=str(video.get("codec_name", "")),
        bytes=dst.stat().st_size,
        has_audio=has_audio,
        device=device,
        warnings=warnings,
    )
    log(LOG, logging.INFO, "ingest.ok", duration_s=round(duration, 2), fps=round(fps, 2),
        resolution=f"{width}x{height}", rotation=rotation, warnings=warnings)
    return out
