"""Checkpointed intermediate artefacts.

A run of this pipeline is 35 GPU-minutes. If the splat stage dies at minute 25
because the pod lost its network, restarting from ingest throws away a pound of
compute and twenty minutes of wall clock. So every stage writes its output to
the run directory and records a fingerprint; a re-run with the same inputs and
the same stage code reloads instead of recomputing.

The fingerprint deliberately includes the stage's own source hash. Changing a
threshold in frames.py must invalidate the frame set, or you spend an afternoon
debugging a cached answer from code you have already deleted.

Layout on disk:

    <run_dir>/
      run.json                 run manifest: stages, status, costs
      artefacts/<stage>.json   the stage's Output, serialised
      artefacts/<stage>.ok     fingerprint sentinel
      data/<stage>/...         the stage's bulk payload (frames, ply, npz)
      logs/<stage>.log
"""
from __future__ import annotations

import hashlib
import inspect
import json
import os
import shutil
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable


def sha256_file(path: str | Path, chunk: int = 1 << 20) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        while True:
            b = fh.read(chunk)
            if not b:
                break
            h.update(b)
    return h.hexdigest()


def stable_hash(obj: Any) -> str:
    """Hash of a JSON-able object with deterministic key ordering. Floats are
    rounded to 9 significant places first: a fingerprint that changes because
    a float came back from a different BLAS build is a fingerprint that never
    hits cache."""
    def norm(o: Any) -> Any:
        if isinstance(o, float):
            return round(o, 9)
        if isinstance(o, dict):
            return {k: norm(o[k]) for k in sorted(o)}
        if isinstance(o, (list, tuple)):
            return [norm(v) for v in o]
        if isinstance(o, Path):
            return str(o)
        return o
    return hashlib.sha256(
        json.dumps(norm(obj), sort_keys=True, separators=(",", ":"), default=str).encode()
    ).hexdigest()


def source_hash(fn: Callable[..., Any]) -> str:
    """Hash of a stage function's source, so editing the stage busts its cache."""
    try:
        src = inspect.getsource(inspect.getmodule(fn) or fn)
    except (OSError, TypeError):
        src = getattr(fn, "__qualname__", repr(fn))
    return hashlib.sha256(src.encode()).hexdigest()[:16]


def atomic_write_text(path: str | Path, text: str) -> None:
    """Write-then-rename. A half-written checkpoint that a resume trusts is
    worse than no checkpoint at all."""
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(p.parent), suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(text)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, p)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def atomic_write_json(path: str | Path, obj: Any) -> None:
    atomic_write_text(path, json.dumps(obj, indent=2, default=str, sort_keys=False))


@dataclass(slots=True)
class ArtifactStore:
    run_dir: Path

    def __post_init__(self) -> None:
        self.run_dir = Path(self.run_dir)
        for sub in ("artefacts", "data", "logs"):
            (self.run_dir / sub).mkdir(parents=True, exist_ok=True)

    # -- paths ------------------------------------------------------------
    def artefact_path(self, stage: str) -> Path:
        return self.run_dir / "artefacts" / f"{stage}.json"

    def sentinel_path(self, stage: str) -> Path:
        return self.run_dir / "artefacts" / f"{stage}.ok"

    def data_dir(self, stage: str) -> Path:
        d = self.run_dir / "data" / stage
        d.mkdir(parents=True, exist_ok=True)
        return d

    # -- checkpointing ----------------------------------------------------
    def cached_fingerprint(self, stage: str) -> str | None:
        p = self.sentinel_path(stage)
        if not p.exists():
            return None
        try:
            return json.loads(p.read_text())["fingerprint"]
        except (ValueError, KeyError, OSError):
            return None

    def load(self, stage: str) -> dict[str, Any] | None:
        p = self.artefact_path(stage)
        if not p.exists():
            return None
        try:
            return json.loads(p.read_text())
        except ValueError:
            return None

    def save(self, stage: str, payload: dict[str, Any], fingerprint: str,
             cost: dict[str, Any] | None = None) -> None:
        atomic_write_json(self.artefact_path(stage), payload)
        # Sentinel is written last: if the process dies between the two, the
        # next run sees no sentinel and recomputes rather than loading a
        # truncated artefact.
        atomic_write_json(self.sentinel_path(stage),
                          {"fingerprint": fingerprint, "cost": cost or {}})

    def invalidate(self, stage: str, *, drop_data: bool = True) -> None:
        for p in (self.artefact_path(stage), self.sentinel_path(stage)):
            if p.exists():
                p.unlink()
        if drop_data:
            d = self.run_dir / "data" / stage
            if d.exists():
                shutil.rmtree(d)
