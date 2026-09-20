"""The DAG runner: topology, the privacy ordering gate, checkpointing, resume,
invalidation and cost accounting."""
from __future__ import annotations

import json
import sys
import types
from dataclasses import dataclass
from pathlib import Path

import pytest

from worldengine import runner as R
from worldengine.artifacts import ArtifactStore, stable_hash
from worldengine.costs import CostLedger, usd_for


# --- topology ---------------------------------------------------------------

def test_real_dag_is_acyclic_and_ordered():
    order = R.topological_order(R.STAGE_DEPS)
    assert len(order) == len(R.STAGE_DEPS)
    pos = {n: i for i, n in enumerate(order)}
    for node, parents in R.STAGE_DEPS.items():
        for p in parents:
            assert pos[p] < pos[node], f"{p} must run before {node}"


def test_topological_order_is_deterministic():
    a = R.topological_order(R.STAGE_DEPS)
    b = R.topological_order(dict(reversed(list(R.STAGE_DEPS.items()))))
    assert a == b


def test_cycle_is_rejected():
    with pytest.raises(R.DagError, match="cycle"):
        R.topological_order({"a": ("b",), "b": ("a",)})


def test_unknown_dependency_is_rejected():
    with pytest.raises(R.DagError, match="unknown stage"):
        R.topological_order({"a": ("nope",)})


def test_subgraph_takes_ancestors_only():
    sub = R.subgraph(R.STAGE_DEPS, ["scale"])
    assert set(sub) == {"ingest", "frames", "redact", "pose", "scale"}
    assert "splat" not in sub


# --- the privacy ordering gate ---------------------------------------------

def test_every_pixel_consumer_is_downstream_of_redact():
    R.validate_privacy_ordering(R.STAGE_DEPS)      # must not raise
    order = R.topological_order(R.STAGE_DEPS)
    assert order.index("redact") < min(order.index(s) for s in R.PIXEL_CONSUMERS)


def test_privacy_ordering_violation_stops_the_run():
    bad = dict(R.STAGE_DEPS)
    bad["pose"] = ("frames",)          # bypass redaction
    with pytest.raises(R.DagError, match="privacy ordering violated"):
        R.validate_privacy_ordering(bad)


def test_privacy_ordering_violation_is_caught_at_construction():
    bad = dict(R.STAGE_DEPS)
    bad["splat"] = ("frames",)
    ctx = R.make_context("/tmp/we-privacy-test", run_id="t", world_id="w")
    with pytest.raises(R.DagError, match="privacy ordering"):
        R.DagRunner(ctx, bad)


def test_subgraph_without_pixel_stages_is_allowed():
    R.validate_privacy_ordering(R.subgraph(R.STAGE_DEPS, ["frames"]))


# --- a synthetic DAG we can actually execute -------------------------------

CALLS: dict[str, int] = {}


def _install_fake_stages(monkeypatch, deps, *, failing=None, unavailable=None):
    """Register importable stage modules for a synthetic graph."""
    CALLS.clear()

    def make(name):
        mod = types.ModuleType(f"worldengine.stages.{name}")
        mod.SUMMARY = f"fake {name}"
        mod.USES_GPU = name in ("b",)
        mod.PRODUCES = (f"{name}.bin",)

        @dataclass(slots=True)
        class Input:
            stage: str
            salt: int
            upstream: dict

        def build_input(ctx, upstream):
            # Real stages read their dependencies' outputs here, which is what
            # makes a changed upstream artefact change this stage's
            # fingerprint. The fake does the same so the chaining is tested.
            return Input(stage=name, salt=int(ctx.param("salt", 0)),
                         upstream={k: v for k, v in upstream.items() if v})

        def run(inp, ctx):
            CALLS[name] = CALLS.get(name, 0) + 1
            if failing and name in failing:
                raise RuntimeError(f"{name} exploded")
            if unavailable and name in unavailable:
                raise R.StageUnavailable(f"{name} needs a GPU")
            (ctx.data_dir() / f"{name}.bin").write_text(name)
            # run_id makes the output differ between runs, which is what a real
            # non-deterministic stage does and what the chaining tests need.
            return {"stage": name, "value": ctx.run_id,
                    "upstream": sorted(k for k, v in ctx.upstream.items() if v)}

        mod.build_input = build_input
        mod.run = run
        return mod

    for name in deps:
        monkeypatch.setitem(sys.modules, f"worldengine.stages.{name}", make(name))
    monkeypatch.setattr(R, "STAGE_DEPS", deps, raising=False)
    monkeypatch.setitem(R.ESTIMATED_GPU_SECONDS, "b", 10.0)


FAKE = {"a": (), "b": ("a",), "c": ("a",), "d": ("b", "c")}


def test_runner_executes_in_order_and_checkpoints(tmp_path, monkeypatch):
    _install_fake_stages(monkeypatch, FAKE)
    ctx = R.make_context(tmp_path, run_id="r1", world_id="w1")
    res = R.DagRunner(ctx, FAKE).run()
    assert res.ok
    assert CALLS == {"a": 1, "b": 1, "c": 1, "d": 1}
    assert res.outputs["d"]["upstream"] == ["b", "c"]
    for name in FAKE:
        assert ctx.store.artefact_path(name).exists()
        assert ctx.store.sentinel_path(name).exists()
    manifest = json.loads((Path(tmp_path) / "run.json").read_text())
    assert manifest["ok"] is True
    assert set(manifest["stages"]) == set(FAKE)


def test_resume_reloads_instead_of_recomputing(tmp_path, monkeypatch):
    _install_fake_stages(monkeypatch, FAKE)
    ctx1 = R.make_context(tmp_path, run_id="r1", world_id="w1")
    R.DagRunner(ctx1, FAKE).run()
    assert sum(CALLS.values()) == 4

    ctx2 = R.make_context(tmp_path, run_id="r2", world_id="w1")
    res = R.DagRunner(ctx2, FAKE).run()
    assert res.ok
    assert sum(CALLS.values()) == 4, "nothing should have re-run"
    assert all(r.status == "cached" for r in res.records.values())
    assert res.ledger.total_gpu_seconds == 0.0


def test_failed_run_resumes_from_the_failing_stage(tmp_path, monkeypatch):
    """The whole point of checkpointing: a 25-minute run that dies at splat
    must not re-decode the video."""
    _install_fake_stages(monkeypatch, FAKE, failing={"d"})
    ctx = R.make_context(tmp_path, run_id="r1", world_id="w1")
    res = R.DagRunner(ctx, FAKE).run()
    assert not res.ok and res.failed_stage == "d"
    assert CALLS == {"a": 1, "b": 1, "c": 1, "d": 1}

    _install_fake_stages(monkeypatch, FAKE)          # d now succeeds
    CALLS.clear()
    ctx2 = R.make_context(tmp_path, run_id="r2", world_id="w1")
    res2 = R.DagRunner(ctx2, FAKE).run()
    assert res2.ok
    assert CALLS == {"d": 1}, "only the failed stage should re-run"
    assert res2.records["a"].status == "cached"


def test_changing_params_invalidates_the_affected_stages(tmp_path, monkeypatch):
    _install_fake_stages(monkeypatch, FAKE)
    ctx = R.make_context(tmp_path, run_id="r1", world_id="w1", params={"salt": 1})
    R.DagRunner(ctx, FAKE).run()
    CALLS.clear()
    ctx2 = R.make_context(tmp_path, run_id="r2", world_id="w1", params={"salt": 2})
    res = R.DagRunner(ctx2, FAKE).run()
    assert res.ok
    assert CALLS == {"a": 1, "b": 1, "c": 1, "d": 1}, "a salt change busts everything"


def test_upstream_invalidation_chains_downstream(tmp_path, monkeypatch):
    _install_fake_stages(monkeypatch, FAKE)
    ctx = R.make_context(tmp_path, run_id="r1", world_id="w1")
    R.DagRunner(ctx, FAKE).run()
    CALLS.clear()
    ctx.store.invalidate("b")
    ctx2 = R.make_context(tmp_path, run_id="r2", world_id="w1")
    res = R.DagRunner(ctx2, FAKE).run()
    assert res.ok
    # b re-runs and produces a different output, so d's input changed and d
    # must re-run. c is untouched.
    assert set(CALLS) == {"b", "d"}, CALLS
    assert res.records["c"].status == "cached"


def test_a_rerun_producing_identical_output_leaves_downstream_cached(tmp_path,
                                                                     monkeypatch):
    """Checkpointing is content-addressed, not timestamp-addressed. If a stage
    re-runs and produces exactly what it produced before, its dependents are
    still valid and must not burn GPU re-deriving the same answer."""
    deterministic = {"a": (), "b": ("a",)}

    def make(name):
        mod = types.ModuleType(f"worldengine.stages.{name}")
        mod.SUMMARY = f"det {name}"
        mod.USES_GPU = False
        mod.PRODUCES = ()

        @dataclass(slots=True)
        class Input:
            stage: str
            upstream: dict

        def build_input(ctx, upstream):
            return Input(stage=name, upstream={k: v for k, v in upstream.items() if v})

        def run(inp, ctx):
            CALLS[name] = CALLS.get(name, 0) + 1
            return {"stage": name, "constant": 42}

        mod.build_input = build_input
        mod.run = run
        return mod

    CALLS.clear()
    for n in deterministic:
        monkeypatch.setitem(sys.modules, f"worldengine.stages.{n}", make(n))
    ctx = R.make_context(tmp_path, run_id="r1", world_id="w1")
    R.DagRunner(ctx, deterministic).run()
    assert CALLS == {"a": 1, "b": 1}
    CALLS.clear()
    ctx.store.invalidate("a")
    res = R.DagRunner(R.make_context(tmp_path, run_id="r2", world_id="w1"),
                      deterministic).run()
    assert res.ok
    assert CALLS == {"a": 1}, "b's inputs are unchanged, so b stays cached"
    assert res.records["b"].status == "cached"


def test_force_reruns_a_named_stage(tmp_path, monkeypatch):
    _install_fake_stages(monkeypatch, FAKE)
    ctx = R.make_context(tmp_path, run_id="r1", world_id="w1")
    R.DagRunner(ctx, FAKE).run()
    CALLS.clear()
    ctx2 = R.make_context(tmp_path, run_id="r2", world_id="w1")
    res = R.DagRunner(ctx2, FAKE, force=["c"]).run()
    assert res.ok
    assert set(CALLS) == {"c", "d"}


def test_stage_unavailable_fails_the_run_and_does_not_produce_output(tmp_path, monkeypatch):
    """The honesty requirement, enforced: a missing model stops the run rather
    than yielding a plausible artefact."""
    _install_fake_stages(monkeypatch, FAKE, unavailable={"b"})
    ctx = R.make_context(tmp_path, run_id="r1", world_id="w1")
    res = R.DagRunner(ctx, FAKE).run()
    assert not res.ok
    assert res.failed_stage == "b"
    assert "StageUnavailable" in (res.error or "")
    assert not ctx.store.artefact_path("b").exists()
    assert "d" not in res.outputs


def test_dry_run_plans_without_executing(tmp_path, monkeypatch):
    _install_fake_stages(monkeypatch, FAKE)
    ctx = R.make_context(tmp_path, run_id="r1", world_id="w1", dry_run=True)
    runner = R.DagRunner(ctx, FAKE)
    plan = runner.plan()
    assert [p["stage"] for p in plan] == ["a", "b", "c", "d"]
    assert plan[1]["usesGpu"] is True
    res = runner.run()
    assert res.ok
    assert CALLS == {}, "dry run must not execute a stage"
    assert all(r.status == "skipped" for r in res.records.values())
    assert not ctx.store.artefact_path("a").exists()


def test_cost_ledger_records_per_stage_and_totals(tmp_path, monkeypatch):
    _install_fake_stages(monkeypatch, FAKE)
    ctx = R.make_context(tmp_path, run_id="r1", world_id="w1",
                         billing_mode="on_demand")
    res = R.DagRunner(ctx, FAKE).run()
    j = res.ledger.to_json()
    assert set(s["stage"] for s in j["stages"]) == set(FAKE)
    assert j["billingMode"] == "on_demand"
    assert all(s["wallSeconds"] >= 0 for s in j["stages"])
    # No CUDA here, so GPU seconds are genuinely zero rather than invented.
    assert j["totalGpuSeconds"] == 0.0
    assert j["totalUsd"] == 0.0


def test_cost_arithmetic_matches_the_published_targets():
    total = 35 * 60.0
    assert round(usd_for(total, "on_demand"), 2) == 0.64
    assert round(usd_for(total, "serverless"), 2) == 1.02
    led = CostLedger(billing_mode="on_demand")
    led.record("splat", wall_seconds=900.0, gpu_seconds=900.0, peak_vram_bytes=2 << 30)
    led.record("pose", wall_seconds=300.0, gpu_seconds=300.0)
    assert round(led.total_gpu_seconds) == 1200
    assert round(led.total_usd, 4) == round(1200 / 3600 * 1.10, 4)
    assert led.peak_vram_bytes == 2 << 30


def test_cost_override_from_env(monkeypatch):
    monkeypatch.setenv("WORLDENGINE_USD_PER_GPU_HOUR", "2.00")
    assert round(usd_for(3600.0), 4) == 2.0


def test_unknown_billing_mode_is_rejected(monkeypatch):
    monkeypatch.delenv("WORLDENGINE_USD_PER_GPU_HOUR", raising=False)
    with pytest.raises(ValueError, match="unknown billing mode"):
        usd_for(10.0, "free")


# --- artefact store ---------------------------------------------------------

def test_atomic_save_writes_sentinel_last(tmp_path):
    store = ArtifactStore(tmp_path)
    assert store.cached_fingerprint("x") is None
    store.save("x", {"a": 1}, "fp1", {"usd": 0.1})
    assert store.cached_fingerprint("x") == "fp1"
    assert store.load("x") == {"a": 1}
    store.invalidate("x")
    assert store.cached_fingerprint("x") is None
    assert store.load("x") is None


def test_corrupt_sentinel_is_treated_as_no_checkpoint(tmp_path):
    store = ArtifactStore(tmp_path)
    store.save("x", {"a": 1}, "fp1")
    store.sentinel_path("x").write_text("{not json")
    assert store.cached_fingerprint("x") is None


def test_stable_hash_is_order_and_float_noise_insensitive():
    a = stable_hash({"b": 1, "a": [1.0000000001, 2]})
    b = stable_hash({"a": [1.0, 2], "b": 1})
    assert a == b
    assert stable_hash({"a": 1}) != stable_hash({"a": 2})


def test_load_stage_rejects_an_incomplete_module(monkeypatch):
    mod = types.ModuleType("worldengine.stages.broken")
    mod.SUMMARY = "x"
    mod.USES_GPU = False
    monkeypatch.setitem(sys.modules, "worldengine.stages.broken", mod)
    with pytest.raises(R.DagError, match="missing build_input"):
        R.load_stage("broken", {"broken": ()})


def test_every_real_stage_module_satisfies_the_protocol():
    for name in R.STAGE_DEPS:
        spec = R.load_stage(name)
        assert spec.summary and callable(spec.run) and callable(spec.build_input)
        assert isinstance(spec.uses_gpu, bool)
        assert spec.deps == R.STAGE_DEPS[name]
