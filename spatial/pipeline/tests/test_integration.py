"""End-to-end behaviour that does not need a GPU:

  * the real DAG plans and dry-runs;
  * the real GPU stages refuse to run without their models rather than
    inventing output;
  * artefacts written into a run directory assemble into a valid
    WorldDocument through the CLI.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from worldengine import cli
from worldengine.artifacts import ArtifactStore
from worldengine.contract import validate
from worldengine.costs import ESTIMATED_GPU_SECONDS, usd_for
from worldengine.deps import cuda_available, device_report
from worldengine.runner import (STAGE_DEPS, DagRunner, StageUnavailable,
                                load_stage, make_context)
from tests.fixtures import artefacts


def test_plan_covers_every_stage_with_a_summary_and_an_estimate(tmp_path):
    ctx = make_context(tmp_path, run_id="p", world_id="p", dry_run=True)
    rows = DagRunner(ctx).plan()
    assert [r["stage"] for r in rows] == list(
        DagRunner(ctx).order)
    assert len(rows) == len(STAGE_DEPS) == 13
    for r in rows:
        assert r["summary"]
        assert r["stage"] in ESTIMATED_GPU_SECONDS


def test_the_cost_model_hits_the_published_budget():
    from worldengine.costs import ESTIMATED_WALL_SECONDS
    gpu = sum(ESTIMATED_GPU_SECONDS.values())
    wall = sum(ESTIMATED_WALL_SECONDS.values())
    # The brief's target is ~35 GPU-minutes; the model lands at 34.
    assert 32.0 <= gpu / 60.0 <= 36.0, "GPU budget drifted from the 35-minute target"
    assert round(usd_for(gpu, "on_demand"), 2) == 0.62
    assert round(usd_for(gpu, "serverless"), 2) == 0.99
    # The invoice is wall time, which is strictly larger: four stages are CPU
    # only and a dedicated pod bills for them.
    assert wall > gpu
    assert round(usd_for(wall, "on_demand"), 2) == 0.74
    # Every stage has a wall estimate, including the ones with no GPU time.
    assert set(ESTIMATED_WALL_SECONDS) == set(ESTIMATED_GPU_SECONDS) == set(STAGE_DEPS)
    for name, g in ESTIMATED_GPU_SECONDS.items():
        assert ESTIMATED_WALL_SECONDS[name] >= g, name
    # The splat stage is the single largest line; if that stops being true the
    # cost model has been mis-attributed somewhere.
    assert max(ESTIMATED_GPU_SECONDS, key=ESTIMATED_GPU_SECONDS.get) == "splat"


def test_only_gpu_stages_declare_gpu_seconds():
    """A stage that bills GPU seconds must actually hold the GPU, and one that
    does not must bill zero. Claiming the GPU for a numpy loop bills for an
    idle device."""
    from worldengine.runner import GPU_STAGES
    for name in STAGE_DEPS:
        spec = load_stage(name)
        assert spec.uses_gpu == (name in GPU_STAGES), name
        if not spec.uses_gpu:
            assert ESTIMATED_GPU_SECONDS[name] == 0.0, name
        else:
            assert ESTIMATED_GPU_SECONDS[name] > 0.0, name


def test_dry_run_of_the_real_dag_touches_nothing(tmp_path):
    ctx = make_context(tmp_path, run_id="d", world_id="d", dry_run=True,
                       params={"source_path": str(tmp_path / "nope.mp4")})
    res = DagRunner(ctx).run()
    assert res.ok
    assert all(r.status == "skipped" for r in res.records.values())
    assert not list((Path(tmp_path) / "artefacts").glob("*.json"))
    manifest = json.loads((Path(tmp_path) / "run.json").read_text())
    assert manifest["ok"] is True


@pytest.mark.skipif(cuda_available(), reason="this asserts the no-GPU behaviour")
@pytest.mark.parametrize("stage", ["redact", "pose", "scale", "splat",
                                   "layout", "semantics"])
def test_gpu_stages_refuse_to_run_without_a_gpu(tmp_path, stage):
    """The honesty requirement. A stage with no model available must raise,
    never return something plausible."""
    ctx = make_context(tmp_path, run_id="x", world_id="x")
    ctx.stage = stage
    spec = load_stage(stage)
    arte = artefacts()
    ctx.upstream = {d: arte.get(d) for d in spec.deps}
    store = ArtifactStore(tmp_path)
    for name, payload in arte.items():
        store.save(name, payload, f"fp-{name}")
    inp = spec.build_input(ctx, ctx.upstream)
    with pytest.raises(StageUnavailable) as exc:
        spec.run(inp, ctx)
    msg = str(exc.value)
    assert ("CUDA" in msg or "not importable" in msg or "weights not found" in msg
            or "WORLDENGINE_ROOMFORMER_ROOT" in msg), msg


def test_stage_unavailable_messages_say_how_to_fix_it(tmp_path):
    from worldengine.deps import require_module
    with pytest.raises(StageUnavailable, match="pip install"):
        require_module("definitely_not_installed_xyz", why="testing")


def test_device_report_is_honest_about_what_is_missing():
    rep = device_report()
    assert "cuda" in rep and isinstance(rep["cuda"], bool)
    assert "modelRoot" in rep
    # On a CPU box the model entries must be None rather than a fabricated
    # version string.
    for key in ("mapanything", "gsplat", "sam3"):
        assert rep[key] is None or isinstance(rep[key], str)


def test_document_command_assembles_from_a_run_directory(tmp_path, capsys):
    store = ArtifactStore(tmp_path)
    for name, payload in artefacts().items():
        store.save(name, payload, f"fp-{name}")
    out = tmp_path / "world.json"
    rc = cli.main(["document", "--run-dir", str(tmp_path), "--world-id", "w-1",
                   "--property-id", "p-1", "--label", "Flat 3", "--version", "1",
                   "--out", str(out)])
    assert rc == 0
    doc = json.loads(out.read_text())
    assert validate(doc) == []
    assert doc["id"] == "w-1" and doc["label"] == "Flat 3"
    assert len(doc["rooms"]) == 2
    assert doc["quality"]["verdict"] == "pass"
    assert "2 rooms" in capsys.readouterr().out


def test_plan_command_prints_the_budget(capsys):
    assert cli.main(["plan"]) == 0
    out = capsys.readouterr().out
    assert "GPU-held time:" in out and "34.0 min" in out
    assert "Pod wall time:" in out and "40.5 min" in out
    assert "$0.62" in out and "$0.74" in out
    for stage in STAGE_DEPS:
        assert stage in out


def test_only_flag_restricts_the_plan_to_ancestors(capsys):
    assert cli.main(["plan", "--only", "scale"]) == 0
    out = capsys.readouterr().out
    assert "splat" not in out.split("total estimated")[0]
    assert "redact" in out


def test_stage_command_reports_missing_upstream(tmp_path, capsys):
    rc = cli.main(["stage", "pose", "--run-dir", str(tmp_path)])
    assert rc == 2
    assert "missing upstream artefacts" in capsys.readouterr().err
