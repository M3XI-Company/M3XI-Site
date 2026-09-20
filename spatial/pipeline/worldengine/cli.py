"""worldengine CLI — run the DAG locally, inspect the plan, assemble a document.

    worldengine plan                        print the DAG and the cost model
    worldengine run --source walk.mp4 ...   run the pipeline
    worldengine run --dry-run ...           plan + expected artefacts + estimate
    worldengine stage frames --run-dir ...  run one stage against existing artefacts
    worldengine doctor                      what is installed, what is missing
    worldengine document --run-dir ...      assemble and validate the WorldDocument
                                            (a build artefact; the world is the
                                             rows the worker ingests from it)
"""
from __future__ import annotations

import argparse
import json
import sys
import uuid
from pathlib import Path
from typing import Any

from .artifacts import ArtifactStore
from .costs import (ESTIMATED_GPU_SECONDS, ESTIMATED_WALL_SECONDS,
                    estimated_total_gpu_seconds,
                    estimated_total_wall_seconds, usd_for)
from .deps import device_report
from .document import build_and_validate
from .handoff import RAW_DOCUMENT_OBJECT_NAME, summarise
from .logging_setup import configure
from .runner import STAGE_DEPS, DagRunner, load_stage, make_context, subgraph


def _params(args: argparse.Namespace) -> dict[str, Any]:
    p: dict[str, Any] = {}
    if args.params:
        p.update(json.loads(Path(args.params).read_text()
                            if Path(args.params).exists() else args.params))
    if getattr(args, "source", None):
        p["source_path"] = str(Path(args.source).resolve())
    for key in ("label", "property_id", "version", "slug"):
        v = getattr(args, key, None)
        if v is not None:
            p[key] = v
    return p


def cmd_plan(args: argparse.Namespace) -> int:
    deps = subgraph(STAGE_DEPS, args.only) if args.only else dict(STAGE_DEPS)
    ctx = make_context(args.run_dir or "/tmp/worldengine-plan",
                       run_id="plan", world_id="plan", dry_run=True)
    rows = DagRunner(ctx, deps).plan()
    width = max(len(r["stage"]) for r in rows)
    names = [r["stage"] for r in rows]
    print(f"{'stage'.ljust(width)}  gpu  gpu_s  wall_s  depends on")
    for r in rows:
        print(f"{r['stage'].ljust(width)}  {'Y' if r['usesGpu'] else '-'}  "
              f"{r['estimateGpuSeconds']:5.0f}  "
              f"{ESTIMATED_WALL_SECONDS.get(r['stage'], 0.0):6.0f}  "
              f"{', '.join(r['dependsOn']) or '-'}")
        print(f"{' ' * width}                  {r['summary']}")
    gpu = estimated_total_gpu_seconds(names)
    wall = estimated_total_wall_seconds(names)
    print(f"\nGPU-held time:  {gpu/60:5.1f} min   "
          f"on-demand ${usd_for(gpu, 'on_demand'):.2f}   "
          f"serverless ${usd_for(gpu, 'serverless'):.2f}")
    print(f"Pod wall time:  {wall/60:5.1f} min   "
          f"on-demand ${usd_for(wall, 'on_demand'):.2f}   "
          f"serverless ${usd_for(wall, 'serverless'):.2f}")
    print("\nThe pod wall figure is what the invoice says: RunPod bills a "
          "dedicated pod for its whole lifetime, not for GPU utilisation, and "
          "four stages here are CPU-only. Both are estimates from costs.py; the "
          "runner measures the real numbers and writes them to run.json.")
    return 0


def cmd_doctor(args: argparse.Namespace) -> int:
    rep = device_report()
    print(json.dumps(rep, indent=2))
    missing = [k for k, v in rep.items() if v is None]
    if missing:
        print(f"\nmissing: {', '.join(missing)}", file=sys.stderr)
        print("GPU stages will raise StageUnavailable rather than approximate.",
              file=sys.stderr)
    return 0


def cmd_run(args: argparse.Namespace) -> int:
    configure(args.log_level)
    deps = subgraph(STAGE_DEPS, args.only) if args.only else dict(STAGE_DEPS)
    ctx = make_context(args.run_dir, run_id=args.run_id or uuid.uuid4().hex,
                       world_id=args.world_id or uuid.uuid4().hex,
                       params=_params(args), dry_run=args.dry_run,
                       billing_mode=args.billing_mode)
    result = DagRunner(ctx, deps, force=args.force or ()).run()
    print(json.dumps(result.to_json(), indent=2))
    return 0 if result.ok else 1


def cmd_stage(args: argparse.Namespace) -> int:
    """Run one stage against whatever is already in the run directory.

    This is what makes each stage independently runnable: iterate on the
    redaction thresholds without re-decoding the video, or re-run the quality
    gate after editing a threshold without re-training a splat.
    """
    configure(args.log_level)
    ctx = make_context(args.run_dir, run_id=args.run_id or "stage",
                       world_id=args.world_id or "stage", params=_params(args))
    spec = load_stage(args.stage)
    ctx.stage = args.stage
    ctx.upstream = {d: ctx.store.load(d) for d in spec.deps}
    missing = [d for d, v in ctx.upstream.items() if v is None]
    if missing:
        print(f"missing upstream artefacts: {missing}", file=sys.stderr)
        return 2
    if args.force:
        ctx.store.invalidate(args.stage)
    runner = DagRunner(ctx, subgraph(STAGE_DEPS, [args.stage]), force=[args.stage])
    rec = runner._run_one(args.stage, dict(ctx.upstream))   # noqa: SLF001
    print(json.dumps({"stage": rec.stage, "status": rec.status,
                      "error": rec.error, "cost": rec.cost}, indent=2))
    return 0 if rec.status in ("ok", "cached") else 1


def cmd_document(args: argparse.Namespace) -> int:
    """Assemble the document this run builds — as a BUILD ARTEFACT.

    It is written to build/world.raw.json, not world.json, and the name is the
    point. The world a viewer loads is rendered from the database rows after
    the hand-off has proved they say what this file says; a file called
    world.json sitting in a run directory would eventually be served to
    somebody, and it is a world no operator correction has ever reached.
    """
    configure(args.log_level)
    store = ArtifactStore(Path(args.run_dir))
    arte = {name: store.load(name) for name in STAGE_DEPS}
    arte = {k: v for k, v in arte.items() if v is not None}
    doc = build_and_validate(
        world_id=args.world_id or "world", property_id=args.property_id or "property",
        version=int(args.version or 1), label=args.label or "Untitled world",
        artefacts=arte, slug=args.slug)
    out = Path(args.out) if args.out else Path(args.run_dir) / RAW_DOCUMENT_OBJECT_NAME
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(doc, indent=2))
    counts = summarise(doc)
    print(f"wrote {out} — {counts['rooms']} rooms, {counts['entities']} entities, "
          f"{counts['regions']} regions, verdict {doc['quality']['verdict']}")
    print("This is the build artefact. The world is what `ingest-world` writes "
          "into the database from it.")
    return 0


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(prog="worldengine")
    ap.add_argument("--log-level", default="INFO")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("plan", help="print the DAG and cost model")
    p.add_argument("--only", nargs="*")
    p.add_argument("--run-dir")
    p.set_defaults(fn=cmd_plan)

    p = sub.add_parser("doctor", help="report installed models and devices")
    p.set_defaults(fn=cmd_doctor)

    p = sub.add_parser("run", help="run the pipeline")
    p.add_argument("--run-dir", required=True)
    p.add_argument("--source")
    p.add_argument("--world-id")
    p.add_argument("--run-id")
    p.add_argument("--property-id")
    p.add_argument("--label")
    p.add_argument("--slug")
    p.add_argument("--version", type=int)
    p.add_argument("--params", help="JSON string or path to a JSON file")
    p.add_argument("--only", nargs="*")
    p.add_argument("--force", nargs="*")
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--billing-mode", choices=("on_demand", "serverless"))
    p.set_defaults(fn=cmd_run)

    p = sub.add_parser("stage", help="run a single stage")
    p.add_argument("stage", choices=sorted(STAGE_DEPS))
    p.add_argument("--run-dir", required=True)
    p.add_argument("--world-id")
    p.add_argument("--run-id")
    p.add_argument("--source")
    p.add_argument("--params")
    p.add_argument("--force", action="store_true")
    p.set_defaults(fn=cmd_stage)

    p = sub.add_parser("document", help="assemble and validate the WorldDocument")
    p.add_argument("--run-dir", required=True)
    p.add_argument("--world-id")
    p.add_argument("--property-id")
    p.add_argument("--label")
    p.add_argument("--slug")
    p.add_argument("--version", type=int)
    p.add_argument("--out")
    p.set_defaults(fn=cmd_document)
    return ap


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return int(args.fn(args))


if __name__ == "__main__":
    sys.exit(main())
