"""The DAG runner.

Stages declare their dependencies; the runner topologically sorts them, skips
any whose checkpoint is still valid, runs the rest, measures GPU seconds and
cost per stage, and writes a run manifest after every stage so a crash resumes
rather than restarts.

Two invariants the runner enforces rather than trusts:

  * redact runs before pose, splat and semantics. Not as a convention: the
    dependency edges make it structurally impossible for the splat trainer to
    see an unredacted frame, because the only path to frame pixels for those
    stages is through redact's output manifest. See validate_privacy_ordering.
  * No stage is allowed to return a result it did not compute. Stages raise
    StageUnavailable when a model or GPU is missing, and the runner turns that
    into a failed run, never into a default.
"""
from __future__ import annotations

import importlib
import json
import logging
import platform
import time
import traceback
from dataclasses import asdict, dataclass, field, is_dataclass
from pathlib import Path
from typing import Any, Callable, Iterable, Sequence

from .artifacts import ArtifactStore, atomic_write_json, source_hash, stable_hash
from .costs import ESTIMATED_GPU_SECONDS, CostLedger, GpuTimer
from .logging_setup import get_logger, log, log_context

LOG = get_logger("worldengine.runner")

# Canonical stage order and dependency edges. This *is* the pipeline.
#
# redact depends on frames and everything pixel-consuming depends on redact,
# which is what makes "PII never enters the splat" a property of the graph
# rather than a promise in a docstring.
STAGE_DEPS: dict[str, tuple[str, ...]] = {
    "ingest":    (),
    "frames":    ("ingest",),
    "redact":    ("frames",),
    "pose":      ("redact",),
    "scale":     ("pose",),
    "splat":     ("scale",),
    "mesh":      ("splat",),
    "layout":    ("mesh",),
    "semantics": ("splat", "layout"),
    "graph":     ("layout", "semantics"),
    "regions":   ("mesh", "graph"),
    "package":   ("splat", "mesh", "layout", "regions"),
    "quality":   ("package", "graph", "scale", "redact", "frames"),
}

# Stages that actually hold the GPU. Kept in step with each module's own
# USES_GPU flag by tests/test_integration.py, because a stage that claims
# the GPU without using it bills for an idle device and one that uses it
# without claiming it makes the cost report wrong.
GPU_STAGES = frozenset({"redact", "pose", "scale", "splat", "mesh",
                        "layout", "semantics"})

# Stages downstream of redact that touch frame pixels. Used by the privacy
# assertion below; kept explicit so adding a new pixel-consuming stage and
# forgetting to gate it fails a test rather than leaking.
PIXEL_CONSUMERS = frozenset({"pose", "scale", "splat", "mesh", "semantics"})


class StageError(RuntimeError):
    """A stage ran and failed."""


class StageUnavailable(StageError):
    """A stage could not run because a model, weight file or GPU is missing.

    This exists so that "we cannot do this here" never turns into "here is a
    plausible answer". Raised by every GPU stage's dependency preflight.
    """


class DagError(ValueError):
    """The graph itself is wrong: a cycle, or an edge to a stage that is not
    in the run."""


def topological_order(deps: dict[str, tuple[str, ...]]) -> list[str]:
    """Kahn's algorithm with deterministic tie-breaking (alphabetical), so two
    runs of the same DAG produce the same order and therefore the same logs."""
    indeg = {n: 0 for n in deps}
    for node, parents in deps.items():
        for p in parents:
            if p not in deps:
                raise DagError(f"stage {node!r} depends on unknown stage {p!r}")
            indeg[node] += 1
    ready = sorted(n for n, d in indeg.items() if d == 0)
    order: list[str] = []
    while ready:
        n = ready.pop(0)
        order.append(n)
        newly: list[str] = []
        for m, parents in deps.items():
            if n in parents:
                indeg[m] -= 1
                if indeg[m] == 0:
                    newly.append(m)
        ready = sorted(ready + newly)
    if len(order) != len(deps):
        stuck = sorted(set(deps) - set(order))
        raise DagError(f"cycle in stage graph involving {stuck}")
    return order


def subgraph(deps: dict[str, tuple[str, ...]], targets: Sequence[str]) -> dict[str, tuple[str, ...]]:
    """All ancestors of `targets`, inclusive. Used by --only and by resume."""
    keep: set[str] = set()
    stack = list(targets)
    while stack:
        n = stack.pop()
        if n in keep:
            continue
        if n not in deps:
            raise DagError(f"unknown stage {n!r}")
        keep.add(n)
        stack.extend(deps[n])
    return {n: tuple(p for p in deps[n]) for n in keep}


def validate_privacy_ordering(deps: dict[str, tuple[str, ...]]) -> None:
    """Assert that every pixel-consuming stage is downstream of redact.

    This is the ordering requirement in requirement 2 of the brief, expressed
    as a graph reachability check. It runs at the start of every run, not just
    in tests, because a graph edit that inverts it must stop the pipeline
    rather than ship an unredacted splat.
    """
    if "redact" not in deps:
        return  # a --only subgraph that excludes pixel stages entirely
    reach: dict[str, set[str]] = {}

    def ancestors(n: str) -> set[str]:
        if n in reach:
            return reach[n]
        reach[n] = set()          # cycle guard; topological_order catches real cycles
        out: set[str] = set()
        for p in deps.get(n, ()):
            out.add(p)
            out |= ancestors(p)
        reach[n] = out
        return out

    offenders = [s for s in sorted(PIXEL_CONSUMERS & set(deps))
                 if "redact" not in ancestors(s)]
    if offenders:
        raise DagError(
            "privacy ordering violated: "
            f"{offenders} read frame pixels but are not downstream of 'redact'. "
            "Redaction must happen before any stage that can bake a pixel into "
            "a published artefact."
        )


# ---------------------------------------------------------------------------
# Stage protocol
# ---------------------------------------------------------------------------

@dataclass(slots=True)
class StageSpec:
    name: str
    deps: tuple[str, ...]
    run: Callable[[Any, "RunContext"], Any]
    build_input: Callable[["RunContext", dict[str, Any]], Any]
    uses_gpu: bool
    summary: str
    produces: tuple[str, ...] = ()


def load_stage(name: str, deps: dict[str, tuple[str, ...]] | None = None) -> StageSpec:
    """Import worldengine.stages.<name> and build its spec.

    `deps` defaults to the canonical graph; the runner passes its own so that a
    subgraph, or a test graph, resolves against the edges actually in use.

    Each stage module must expose:
        SUMMARY: str
        USES_GPU: bool
        PRODUCES: tuple[str, ...]        artefact filenames, for --dry-run
        build_input(ctx, upstream) -> Input dataclass
        run(inp, ctx) -> Output dataclass
    """
    mod = importlib.import_module(f".stages.{name}", package=__package__)
    for attr in ("SUMMARY", "USES_GPU", "build_input", "run"):
        if not hasattr(mod, attr):
            raise DagError(f"stage module {name!r} is missing {attr}")
    return StageSpec(
        name=name,
        deps=(deps or STAGE_DEPS)[name],
        run=mod.run,
        build_input=mod.build_input,
        uses_gpu=bool(mod.USES_GPU),
        summary=str(mod.SUMMARY),
        produces=tuple(getattr(mod, "PRODUCES", ())),
    )


def to_jsonable(obj: Any) -> Any:
    if is_dataclass(obj) and not isinstance(obj, type):
        return {k: to_jsonable(v) for k, v in asdict(obj).items()}
    if isinstance(obj, Path):
        return str(obj)
    if isinstance(obj, dict):
        return {k: to_jsonable(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple, set)):
        return [to_jsonable(v) for v in obj]
    return obj


# ---------------------------------------------------------------------------
# Run context
# ---------------------------------------------------------------------------

@dataclass(slots=True)
class RunContext:
    """Everything a stage is allowed to know about the run.

    A stage reads its inputs from `upstream` (the outputs of its declared
    dependencies) and writes bulk data under `store.data_dir(stage)`. It never
    reaches for another stage's directory directly; if it needs something, the
    dependency edge and the Output dataclass are how it gets it.
    """
    run_id: str
    world_id: str
    run_dir: Path
    store: ArtifactStore
    params: dict[str, Any] = field(default_factory=dict)
    ledger: CostLedger = field(default_factory=CostLedger)
    dry_run: bool = False
    stage: str = ""
    upstream: dict[str, Any] = field(default_factory=dict)

    def param(self, key: str, default: Any = None) -> Any:
        return self.params.get(key, default)

    def data_dir(self, stage: str | None = None) -> Path:
        return self.store.data_dir(stage or self.stage)

    def out(self, name: str, stage: str | None = None) -> Path:
        return self.data_dir(stage) / name


@dataclass(slots=True)
class StageRecord:
    stage: str
    status: str                      # ok | cached | failed | skipped
    fingerprint: str = ""
    error: str | None = None
    started_at: float = 0.0
    finished_at: float = 0.0
    cost: dict[str, Any] = field(default_factory=dict)


@dataclass(slots=True)
class RunResult:
    run_id: str
    world_id: str
    ok: bool
    records: dict[str, StageRecord]
    outputs: dict[str, Any]
    ledger: CostLedger
    failed_stage: str | None = None
    error: str | None = None

    def to_json(self) -> dict[str, Any]:
        return {
            "runId": self.run_id,
            "worldId": self.world_id,
            "ok": self.ok,
            "failedStage": self.failed_stage,
            "error": self.error,
            "stages": {k: {"status": v.status, "fingerprint": v.fingerprint,
                           "error": v.error,
                           "wallSeconds": round(v.finished_at - v.started_at, 3),
                           "cost": v.cost}
                       for k, v in self.records.items()},
            "costs": self.ledger.to_json(),
            "estimateGpuSeconds": {k: ESTIMATED_GPU_SECONDS.get(k, 0.0)
                                   for k in self.records},
        }


class DagRunner:
    def __init__(self, ctx: RunContext, deps: dict[str, tuple[str, ...]] | None = None,
                 *, force: Iterable[str] = ()) -> None:
        self.ctx = ctx
        self.deps = dict(deps or STAGE_DEPS)
        self.force = set(force)
        validate_privacy_ordering(self.deps)
        self.order = topological_order(self.deps)

    # -- planning ---------------------------------------------------------
    def plan(self) -> list[dict[str, Any]]:
        rows = []
        for name in self.order:
            spec = load_stage(name, self.deps)
            rows.append({
                "stage": name,
                "dependsOn": list(spec.deps),
                "usesGpu": spec.uses_gpu,
                "summary": spec.summary,
                "produces": list(spec.produces),
                "estimateGpuSeconds": ESTIMATED_GPU_SECONDS.get(name, 0.0),
                "cached": self.ctx.store.cached_fingerprint(name) is not None,
            })
        return rows

    # -- execution --------------------------------------------------------
    def run(self) -> RunResult:
        records: dict[str, StageRecord] = {}
        outputs: dict[str, Any] = {}
        result = RunResult(run_id=self.ctx.run_id, world_id=self.ctx.world_id,
                           ok=True, records=records, outputs=outputs,
                           ledger=self.ctx.ledger)

        with log_context(run_id=self.ctx.run_id, world_id=self.ctx.world_id):
            log(LOG, logging.INFO, "run.start",
                stages=self.order, dry_run=self.ctx.dry_run,
                host=platform.node(),
                estimate_gpu_seconds=sum(
                    ESTIMATED_GPU_SECONDS.get(s, 0.0) for s in self.order))

            for name in self.order:
                rec = self._run_one(name, outputs)
                records[name] = rec
                self._write_manifest(result)
                if rec.status == "failed":
                    result.ok = False
                    result.failed_stage = name
                    result.error = rec.error
                    log(LOG, logging.ERROR, "run.failed", stage=name, error=rec.error)
                    self._write_manifest(result)
                    return result

            log(LOG, logging.INFO, "run.done",
                gpu_seconds=round(self.ctx.ledger.total_gpu_seconds, 1),
                usd=round(self.ctx.ledger.total_usd, 4),
                wall_seconds=round(self.ctx.ledger.total_wall_seconds, 1))
            self._write_manifest(result)
            return result

    def _run_one(self, name: str, outputs: dict[str, Any]) -> StageRecord:
        spec = load_stage(name, self.deps)
        ctx = self.ctx
        ctx.stage = name
        ctx.upstream = {d: outputs.get(d) for d in spec.deps}

        rec = StageRecord(stage=name, status="ok", started_at=time.time())
        with log_context(stage=name):
            if ctx.dry_run:
                # Deliberately before build_input: in a dry run the upstream
                # artefacts do not exist, so building this stage's input would
                # fail for every stage but the first. A dry run reports the
                # graph, the artefacts and the estimate; it does not pretend to
                # have inputs it has not computed.
                rec.status = "skipped"
                rec.finished_at = time.time()
                log(LOG, logging.INFO, "stage.dry_run",
                    produces=list(spec.produces),
                    depends_on=list(spec.deps),
                    uses_gpu=spec.uses_gpu,
                    estimate_gpu_seconds=ESTIMATED_GPU_SECONDS.get(name, 0.0))
                return rec
            try:
                inp = spec.build_input(ctx, ctx.upstream)
            except Exception as exc:                      # noqa: BLE001
                rec.status = "failed"
                rec.error = f"{type(exc).__name__}: {exc}"
                rec.finished_at = time.time()
                log(LOG, logging.ERROR, "stage.input_failed", error=rec.error,
                    trace=traceback.format_exc(limit=8))
                return rec

            fingerprint = stable_hash({
                "input": to_jsonable(inp),
                "code": source_hash(spec.run),
                # Upstream fingerprints chain, so invalidating pose invalidates
                # everything that read it without us tracking that by hand.
                "deps": {d: ctx.store.cached_fingerprint(d) for d in spec.deps},
            })
            rec.fingerprint = fingerprint

            cached = ctx.store.cached_fingerprint(name)
            if name not in self.force and cached == fingerprint:
                payload = ctx.store.load(name)
                if payload is not None:
                    outputs[name] = payload
                    rec.status = "cached"
                    rec.finished_at = time.time()
                    sc = ctx.ledger.record(name, 0.0, 0.0, from_cache=True)
                    rec.cost = sc.to_json()
                    log(LOG, logging.INFO, "stage.cached", fingerprint=fingerprint[:12])
                    return rec
            if cached is not None and cached != fingerprint:
                log(LOG, logging.INFO, "stage.invalidated",
                    was=cached[:12], now=fingerprint[:12])
                ctx.store.invalidate(name)

            log(LOG, logging.INFO, "stage.start", uses_gpu=spec.uses_gpu)
            timer = GpuTimer(billable=spec.uses_gpu)
            try:
                with timer:
                    out = spec.run(inp, ctx)
                payload = to_jsonable(out)
                sc = ctx.ledger.record(name, timer.wall_seconds, timer.gpu_seconds,
                                       timer.peak_vram_bytes)
                rec.cost = sc.to_json()
                ctx.store.save(name, payload, fingerprint, rec.cost)
                outputs[name] = payload
                rec.finished_at = time.time()
                log(LOG, logging.INFO, "stage.done", **rec.cost)
                return rec
            except StageUnavailable as exc:
                rec.status = "failed"
                rec.error = f"StageUnavailable: {exc}"
                rec.finished_at = time.time()
                ctx.ledger.record(name, timer.wall_seconds, timer.gpu_seconds,
                                  timer.peak_vram_bytes)
                log(LOG, logging.ERROR, "stage.unavailable", error=str(exc))
                return rec
            except Exception as exc:                      # noqa: BLE001
                rec.status = "failed"
                rec.error = f"{type(exc).__name__}: {exc}"
                rec.finished_at = time.time()
                ctx.ledger.record(name, timer.wall_seconds, timer.gpu_seconds,
                                  timer.peak_vram_bytes)
                log(LOG, logging.ERROR, "stage.failed", error=rec.error,
                    trace=traceback.format_exc(limit=12))
                return rec

    def _write_manifest(self, result: RunResult) -> None:
        atomic_write_json(self.ctx.run_dir / "run.json", result.to_json())


def make_context(run_dir: str | Path, *, run_id: str, world_id: str,
                 params: dict[str, Any] | None = None,
                 dry_run: bool = False,
                 billing_mode: str | None = None) -> RunContext:
    rd = Path(run_dir)
    store = ArtifactStore(rd)
    ledger = CostLedger(billing_mode=billing_mode) if billing_mode else CostLedger()
    return RunContext(run_id=run_id, world_id=world_id, run_dir=rd, store=store,
                      params=dict(params or {}), ledger=ledger, dry_run=dry_run)
