"""Dependency preflight.

Every GPU stage calls require_* at the top of run(). If a model, a weight file,
a CLI binary or the GPU itself is missing, the stage raises StageUnavailable
with a message that says exactly what is missing and how to get it, and the run
fails.

It is worth being blunt about why this module exists. The tempting failure mode
for a reconstruction pipeline is the graceful fallback: no MapAnything, so
estimate poses from a constant-velocity prior; no RoomFormer, so fit a
rectangle to the point cloud. Both produce a WorldDocument that validates, that
renders, and that is wrong in ways nobody notices until a buyer measures a
room. There are no fallbacks in this package. A stage either runs its real
model or stops the run.
"""
from __future__ import annotations

import importlib
import os
import shutil
from pathlib import Path
from typing import Any, Sequence

from .runner import StageUnavailable

# Where model weights live in the RunPod image. Baked into the Dockerfile so a
# cold start does not pay for a HuggingFace download on the clock.
MODEL_ROOT = Path(os.environ.get("WORLDENGINE_MODEL_ROOT", "/opt/models"))

_INSTALL_HINTS = {
    "torch": "pip install torch --index-url https://download.pytorch.org/whl/cu124",
    "mapanything": "pip install 'mapanything @ git+https://github.com/facebookresearch/map-anything'",
    "moge": "pip install 'moge @ git+https://github.com/microsoft/MoGe'",
    "gsplat": "pip install gsplat==1.5.3",
    "lightglue": "pip install 'lightglue @ git+https://github.com/cvg/LightGlue'",
    "pycolmap": "pip install pycolmap==3.11.1",
    "open3d": "pip install open3d==0.19.0",
    "transformers": "pip install transformers==4.57.1",
    "doctr": "pip install 'python-doctr[torch]==0.11.0'",
    "sam3": "pip install 'sam3 @ git+https://github.com/facebookresearch/sam3'",
    "roomformer": "see README: RoomFormer is vendored at $WORLDENGINE_ROOMFORMER_ROOT",
    "cv2": "pip install opencv-python-headless==4.11.0.86",
    "av": "pip install av==14.0.1",
}


def require_module(name: str, *, why: str) -> Any:
    try:
        return importlib.import_module(name)
    except ImportError as exc:
        hint = _INSTALL_HINTS.get(name.split(".")[0], f"pip install {name}")
        raise StageUnavailable(
            f"{why}: python module {name!r} is not importable ({exc}). "
            f"Install it with: {hint}. This pipeline does not substitute an "
            f"approximation when a model is missing."
        ) from exc


def require_binary(name: str, *, why: str) -> str:
    path = shutil.which(name)
    if not path:
        raise StageUnavailable(
            f"{why}: executable {name!r} is not on PATH. The RunPod image in "
            f"Dockerfile installs it; a local run needs it installed manually."
        )
    return path


def require_cuda(*, why: str, min_vram_gb: float = 0.0) -> Any:
    torch = require_module("torch", why=why)
    if not torch.cuda.is_available():
        raise StageUnavailable(
            f"{why}: no CUDA device visible to torch. This stage does not have "
            f"a CPU path — running it on CPU would take hours and the result "
            f"would be silently different. Run it on the L40S image."
        )
    if min_vram_gb > 0:
        total = torch.cuda.get_device_properties(0).total_memory / (1024 ** 3)
        if total < min_vram_gb:
            raise StageUnavailable(
                f"{why}: GPU has {total:.1f} GB VRAM, this stage needs at least "
                f"{min_vram_gb:.1f} GB. Reduce --splat-cap / --frame-batch, or "
                f"use a larger GPU."
            )
    return torch


def require_weights(relative: str, *, why: str, source: str) -> Path:
    """Resolve a weight file under MODEL_ROOT, or explain where to get it."""
    p = MODEL_ROOT / relative
    if not p.exists():
        raise StageUnavailable(
            f"{why}: weights not found at {p}. Fetch from {source} into "
            f"{MODEL_ROOT} (the Dockerfile does this at build time so cold "
            f"starts do not pay for it)."
        )
    return p


def require_files(paths: Sequence[str | Path], *, why: str) -> list[Path]:
    missing = [str(p) for p in paths if not Path(p).exists()]
    if missing:
        raise StageUnavailable(
            f"{why}: {len(missing)} required input file(s) missing, first few: "
            f"{missing[:3]}"
        )
    return [Path(p) for p in paths]


def cuda_available() -> bool:
    """For --dry-run reporting only. Never used to pick a code path."""
    try:
        import torch  # noqa: PLC0415
        return bool(torch.cuda.is_available())
    except Exception:
        return False


def device_report() -> dict[str, Any]:
    out: dict[str, Any] = {"cuda": False, "modelRoot": str(MODEL_ROOT),
                           "modelRootExists": MODEL_ROOT.exists()}
    try:
        import torch  # noqa: PLC0415
        out["torch"] = torch.__version__
        out["cuda"] = bool(torch.cuda.is_available())
        if out["cuda"]:
            props = torch.cuda.get_device_properties(0)
            out["device"] = props.name
            out["vramGb"] = round(props.total_memory / (1024 ** 3), 1)
            out["capability"] = f"{props.major}.{props.minor}"
    except Exception as exc:                            # noqa: BLE001
        out["torch"] = f"unavailable: {exc}"
    for mod in ("mapanything", "moge", "gsplat", "lightglue", "pycolmap",
                "open3d", "transformers", "doctr", "sam3", "cv2", "av"):
        try:
            m = importlib.import_module(mod)
            out[mod] = getattr(m, "__version__", "present")
        except Exception:
            out[mod] = None
    for exe in ("ffmpeg", "ffprobe", "colmap", "glomap", "gs-mesh"):
        out[exe] = shutil.which(exe)
    return out
