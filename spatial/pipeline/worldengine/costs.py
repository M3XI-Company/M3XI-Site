"""Cost accounting.

Rates below are the RunPod L40S rates this pipeline was budgeted against.
They are configuration, not physics: RunPod changes pricing, and a pipeline
that hard-codes a price silently reports the wrong number for months. Override
with WORLDENGINE_USD_PER_GPU_HOUR / WORLDENGINE_BILLING_MODE.

    on_demand   1.10 USD/GPU-hour   secure-cloud L40S, 48 GB
    serverless  1.75 USD/GPU-hour   active-worker rate

The 35 GPU-minute target for a 2-bed flat therefore costs
    35/60 * 1.10 = 0.6417  ->  ~0.64 USD on-demand
    35/60 * 1.75 = 1.0208  ->  ~1.02 USD serverless
which is where the headline numbers in the brief come from. RunPod's
*flex* serverless rate is roughly 2x the active-worker rate; if you run flex,
set the env var, do not adjust the story.

GPU seconds are measured, not estimated: a stage that holds the GPU is timed
on the wall clock from the moment it moves a tensor to device, and CUDA is
synchronised before the timer stops so asynchronous kernels are not billed to
the next stage.
"""
from __future__ import annotations

import os
import time
from dataclasses import dataclass, field
from typing import Any, Iterable

BILLING_RATES_USD_PER_HOUR = {"on_demand": 1.10, "serverless": 1.75}


def usd_per_gpu_hour(mode: str | None = None) -> float:
    override = os.environ.get("WORLDENGINE_USD_PER_GPU_HOUR")
    if override:
        return float(override)
    m = (mode or os.environ.get("WORLDENGINE_BILLING_MODE") or "on_demand").lower()
    if m not in BILLING_RATES_USD_PER_HOUR:
        raise ValueError(f"unknown billing mode {m!r}; expected one of "
                         f"{sorted(BILLING_RATES_USD_PER_HOUR)}")
    return BILLING_RATES_USD_PER_HOUR[m]


def usd_for(gpu_seconds: float, mode: str | None = None) -> float:
    return float(gpu_seconds) / 3600.0 * usd_per_gpu_hour(mode)


@dataclass(slots=True)
class StageCost:
    stage: str
    wall_seconds: float = 0.0
    gpu_seconds: float = 0.0
    peak_vram_bytes: int = 0
    usd: float = 0.0
    from_cache: bool = False

    def to_json(self) -> dict[str, Any]:
        return {
            "stage": self.stage,
            "wallSeconds": round(self.wall_seconds, 3),
            "gpuSeconds": round(self.gpu_seconds, 3),
            "peakVramMb": round(self.peak_vram_bytes / (1024 * 1024), 1),
            "usd": round(self.usd, 5),
            "fromCache": self.from_cache,
        }


@dataclass(slots=True)
class CostLedger:
    billing_mode: str = field(default_factory=lambda: os.environ.get(
        "WORLDENGINE_BILLING_MODE", "on_demand"))
    stages: dict[str, StageCost] = field(default_factory=dict)

    def record(self, stage: str, wall_seconds: float, gpu_seconds: float,
               peak_vram_bytes: int = 0, from_cache: bool = False) -> StageCost:
        sc = StageCost(
            stage=stage,
            wall_seconds=float(wall_seconds),
            gpu_seconds=float(gpu_seconds),
            peak_vram_bytes=int(peak_vram_bytes),
            usd=usd_for(gpu_seconds, self.billing_mode),
            from_cache=from_cache,
        )
        self.stages[stage] = sc
        return sc

    @property
    def total_gpu_seconds(self) -> float:
        return sum(s.gpu_seconds for s in self.stages.values())

    @property
    def total_wall_seconds(self) -> float:
        return sum(s.wall_seconds for s in self.stages.values())

    @property
    def total_usd(self) -> float:
        return sum(s.usd for s in self.stages.values())

    @property
    def peak_vram_bytes(self) -> int:
        return max((s.peak_vram_bytes for s in self.stages.values()), default=0)

    def to_json(self) -> dict[str, Any]:
        return {
            "billingMode": self.billing_mode,
            "usdPerGpuHour": usd_per_gpu_hour(self.billing_mode),
            "totalGpuSeconds": round(self.total_gpu_seconds, 2),
            "totalWallSeconds": round(self.total_wall_seconds, 2),
            "totalUsd": round(self.total_usd, 5),
            "peakVramMb": round(self.peak_vram_bytes / (1024 * 1024), 1),
            "stages": [self.stages[k].to_json() for k in sorted(self.stages)],
        }


class GpuTimer:
    """Times a GPU-holding block and reads peak allocator usage.

    Falls back to wall time with zero GPU seconds when torch/CUDA is absent,
    which is correct: on a CPU box no GPU was billed. It does NOT invent a
    number, and the caller can tell the difference because gpu_seconds is 0.
    """

    def __init__(self, *, billable: bool = True) -> None:
        self.billable = billable
        self.wall_seconds = 0.0
        self.gpu_seconds = 0.0
        self.peak_vram_bytes = 0
        self._t0 = 0.0
        self._torch: Any = None

    def __enter__(self) -> "GpuTimer":
        try:
            import torch  # noqa: PLC0415
            if torch.cuda.is_available():
                self._torch = torch
                torch.cuda.synchronize()
                torch.cuda.reset_peak_memory_stats()
        except Exception:
            self._torch = None
        self._t0 = time.perf_counter()
        return self

    def __exit__(self, *exc: Any) -> None:
        if self._torch is not None:
            # Without this the next stage is billed for this stage's kernels.
            self._torch.cuda.synchronize()
            self.peak_vram_bytes = int(self._torch.cuda.max_memory_allocated())
        self.wall_seconds = time.perf_counter() - self._t0
        self.gpu_seconds = self.wall_seconds if (self.billable and self._torch is not None) else 0.0


# Budget the DAG was designed against, for --dry-run and for the "did this run
# cost what we said it would" check in the README. Numbers are per stage, for a
# 2-bed UK flat: ~4 minutes of 1080p60 phone video, ~300 selected frames at
# 1600x900, on a single L40S. See README.md for how each was derived.
#
# TWO NUMBERS, NOT ONE, and the difference is money.
#
#   ESTIMATED_GPU_SECONDS  seconds a stage holds the GPU. This is what the
#                          brief's "35 GPU-minutes" means and what the ledger
#                          bills, and it is what you compare against when
#                          deciding whether a model swap paid for itself.
#
#   ESTIMATED_WALL_SECONDS total pod time including the CPU-only stages. RunPod
#                          bills a dedicated pod for its whole lifetime, not for
#                          GPU utilisation, so THIS is what actually appears on
#                          the invoice. Reporting only the GPU figure would
#                          understate the true cost of a run by about 18%.
#
# Both are estimates until measured on a real L40S. The runner measures the
# real numbers and writes them to run.json, and `worldengine plan` prints the
# estimate so the two can be compared.
ESTIMATED_GPU_SECONDS: dict[str, float] = {
    "ingest": 0.0,      # ffmpeg demux, CPU
    "frames": 0.0,      # decode + Laplacian + LK flow, CPU
    "redact": 240.0,    # OWLv2 + YuNet + docTR + SAM 3.1 over ~300 frames
    "pose": 300.0,      # MapAnything forward + ALIKED/LightGlue + COLMAP BA
    "scale": 90.0,      # MoGe-2 over a 60-frame subsample
    "splat": 900.0,     # gsplat MCMC, 30k iters, up to 1M gaussians
    "mesh": 150.0,      # depth/normal render + Open3D TSDF fusion
    "layout": 30.0,     # RoomFormer forward on one density map
    "semantics": 330.0, # SAM 3.1 video tracking + identity-head lifting
    "graph": 0.0,       # CPU
    "regions": 0.0,     # CPU: numpy projection over cached depth maps
    "package": 0.0,     # SPZ/SOG encode, CPU
    "quality": 0.0,     # CPU
}
# 2040 GPU-seconds = 34.0 GPU-minutes.

ESTIMATED_WALL_SECONDS: dict[str, float] = {
    "ingest": 20.0,     # ffprobe + stream copy of a 4-minute 1080p file
    "frames": 165.0,    # full decode at 7.5 fps candidates + LK per pair
    "redact": 250.0,
    "pose": 310.0,      # COLMAP's bundle adjuster is CPU-bound inside this
    "scale": 95.0,
    "splat": 905.0,
    "mesh": 155.0,      # TSDF integration is CPU; only the render is GPU
    "layout": 35.0,
    "semantics": 335.0,
    "graph": 25.0,      # nav grid and scene graph over ~1100 nodes
    "regions": 70.0,    # dominated by reading 300 depth archives
    "package": 60.0,    # SPZ encode + gzip of ~1M gaussians, plus chunking
    "quality": 5.0,
}
# 2430 wall-seconds = 40.5 minutes on a dedicated pod.


def estimated_total_gpu_seconds(stages: Iterable[str] | None = None) -> float:
    names = list(stages) if stages is not None else list(ESTIMATED_GPU_SECONDS)
    return sum(ESTIMATED_GPU_SECONDS.get(n, 0.0) for n in names)


def estimated_total_wall_seconds(stages: Iterable[str] | None = None) -> float:
    names = list(stages) if stages is not None else list(ESTIMATED_WALL_SECONDS)
    return sum(ESTIMATED_WALL_SECONDS.get(n, 0.0) for n in names)
