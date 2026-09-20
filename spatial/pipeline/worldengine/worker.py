"""worker — the RunPod-facing entry point.

Leases a job from the `wv-jobs` edge function, runs the DAG, uploads the
packaged assets through short-lived signed URLs, and reports the outcome back
through the same function. Long jobs heartbeat their lease.

THE POD HOLDS ONE SECRET. `WV_WORKER_SECRET`, plus the function URL and its own
pre-registered worker id. It has no Supabase service-role key, no storage
credential and no PostgREST access, and there is no code path here that can use
one. That is deliberate and it is the reason this module looks the way it does.

A service-role key bypasses RLS across every table in the project — billing,
leads, AI turns, other tenants' properties — not merely the `wv_` ones. These
GPU boxes are rented by the minute from a third party, they are recycled
between customers, and their filesystem and environment are not ours to
guarantee. A key that powerful should not be on one. So every write a worker
needs goes through an action on `wv-jobs`, which checks the lease and reads the
tenant key from the job row rather than from anything the worker sent.

What that costs us, stated plainly: the worker can no longer register itself.
Worker identity is provisioned out of band (a row in `wv_worker`) and supplied
as `WV_WORKER_ID`. That is a real operational step, and it is the point — if a
worker could mint its own identity with the shared secret, the queue would not
be auditable.

Everything here is idempotent. RunPod pods are preempted; a job that was half
done must be safe to pick up again, which is why the run directory is keyed by
world id and version rather than by pod, why the artefact store resumes, and
why asset object names are content checksums.
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import signal
import socket
import sys
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable, Sequence

from .artifacts import sha256_file
from .document import build_and_validate
from .handoff import (RAW_DOCUMENT_CHUNK_KEY, RAW_DOCUMENT_OBJECT_NAME,
                      HandoffError, deliver, summarise)
from .logging_setup import configure, get_logger, log, log_context
from .runner import STAGE_DEPS, DagRunner, RunResult, make_context, subgraph

LOG = get_logger("worldengine.worker")

# Lease length. Long enough that the splat stage (~15 min) does not need many
# heartbeats, short enough that a dead pod's job returns to the queue before an
# operator notices. Heartbeats go out at a third of this.
LEASE_SECONDS = 900
HEARTBEAT_SECONDS = 300

# Batch limits, matching the caps the wv-jobs handler enforces. Exceeding them
# is a 400, so they are mirrored here rather than discovered at run time.
MAX_UPLOAD_FILES = 64
MAX_REDACTION_ROWS = 500
MAX_ASSET_ROWS = 256

# One upload attempt can stall on a bad RunPod network path. Three tries with a
# short backoff covers a transient reset without turning a broken upload into a
# fifteen-minute hang that outlives the signed URL.
UPLOAD_ATTEMPTS = 3
UPLOAD_TIMEOUT_S = 300

CONTENT_TYPES = {".spz": "application/octet-stream", ".ply": "application/octet-stream",
                 ".sog": "application/octet-stream", ".json": "application/json",
                 ".webp": "image/webp", ".svg": "image/svg+xml",
                 ".glb": "model/gltf-binary", ".npz": "application/octet-stream"}


class JobsError(RuntimeError):
    """The worker API refused or failed. Never swallowed into a default."""


class NotOurJob(JobsError):
    """409 from wv-jobs: the lease has moved on. Stop, do not keep writing."""


class IngestRefused(JobsError):
    """422 from wv-jobs: the world was rejected, and retrying will not help.

    Kept apart from NotOurJob because the two demand opposite behaviour. A 409
    means another pod owns this world and this one must go quiet. A 422 means
    the world we built does not match the world the database now holds -- a
    missing room, a dropped surface, an endpoint that did not resolve -- and
    that has to be reported loudly and NOT retried, because the run directory
    resumes from the same checkpoints and would produce the same document
    three times before a human ever heard about it.
    """


@dataclass(slots=True)
class JobsClient:
    """The worker's entire view of the outside world.

    Deliberately not the Supabase SDK and deliberately not PostgREST: this
    speaks to exactly one endpoint with exactly one credential, and that
    narrowness is the security property. If a future change needs a second
    endpoint here, that is the moment to ask whether it belongs on the pod.
    """
    url: str
    secret: str
    worker_id: str
    timeout: float = 60.0

    @classmethod
    def from_env(cls) -> "JobsClient":
        url = os.environ.get("WV_JOBS_URL")
        secret = os.environ.get("WV_WORKER_SECRET")
        worker_id = os.environ.get("WV_WORKER_ID")
        missing = [n for n, v in (("WV_JOBS_URL", url), ("WV_WORKER_SECRET", secret),
                                  ("WV_WORKER_ID", worker_id)) if not v]
        if missing:
            raise JobsError(
                f"missing required environment: {', '.join(missing)}. The worker "
                "talks only to the wv-jobs edge function and needs its URL, the "
                "shared secret and its own pre-registered worker id. It does NOT "
                "take a Supabase key; if you are looking for where to put one, "
                "there is no longer anywhere."
            )
        # The edge function fails closed below 32 characters, so catching it
        # here turns a silent 401 loop into one clear message at startup.
        if len(secret or "") < 32:
            raise JobsError("WV_WORKER_SECRET must be at least 32 characters; "
                            "wv-jobs rejects anything shorter and will 401 every "
                            "claim.")
        return cls(url=str(url).rstrip("/"), secret=str(secret), worker_id=str(worker_id))

    def call(self, action: str, payload: dict[str, Any] | None = None) -> Any:
        body = {"action": action, "workerId": self.worker_id, **(payload or {})}
        req = urllib.request.Request(
            self.url, method="POST", data=json.dumps(body).encode(),
            headers={"content-type": "application/json",
                     "x-wv-worker-secret": self.secret})
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                raw = resp.read()
                return json.loads(raw) if raw else None
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", "replace")[:400]
            if exc.code == 409:
                raise NotOurJob(f"{action}: {detail}") from exc
            if exc.code == 422:
                raise IngestRefused(f"{action}: {detail}") from exc
            if exc.code == 401:
                raise JobsError(
                    f"{action}: wv-jobs rejected the worker secret. Check "
                    f"WV_WORKER_SECRET matches the function's configured value "
                    f"({detail})") from exc
            raise JobsError(f"{action} -> {exc.code}: {detail}") from exc
        except urllib.error.URLError as exc:
            raise JobsError(f"{action}: could not reach wv-jobs at {self.url} "
                            f"({exc.reason})") from exc

    # -- actions ----------------------------------------------------------
    def claim(self, stages: Sequence[str]) -> dict[str, Any] | None:
        out = self.call("claim", {"stages": list(stages),
                                  "leaseSeconds": LEASE_SECONDS})
        job = (out or {}).get("job")
        return job if isinstance(job, dict) else None

    def heartbeat(self, job_id: str) -> bool:
        out = self.call("heartbeat", {"jobId": job_id, "leaseSeconds": LEASE_SECONDS})
        return bool((out or {}).get("ok"))

    def upload_urls(self, job_id: str, names: Sequence[str]) -> dict[str, dict[str, str]]:
        out = self.call("upload-urls", {"jobId": job_id,
                                        "files": [{"name": n} for n in names]})
        files = (out or {}).get("files") or []
        return {f["name"]: f for f in files}

    def redactions(self, job_id: str, rows: Sequence[dict[str, Any]]) -> int:
        out = self.call("redactions", {"jobId": job_id, "rows": list(rows)})
        return int((out or {}).get("inserted", 0))

    def ingest(self, job_id: str, body: dict[str, Any]) -> dict[str, Any]:
        """One section of the world. See handoff.py for what a section is."""
        return self.call("ingest-world", {"jobId": job_id, **body}) or {}

    def complete(self, job_id: str, **payload: Any) -> dict[str, Any]:
        return self.call("complete", {"jobId": job_id, **payload}) or {}

    def fail(self, job_id: str, error: str, *, retryable: bool = True) -> dict[str, Any]:
        return self.call("fail", {"jobId": job_id, "error": error[:2000],
                                  "retryable": retryable}) or {}


@dataclass(slots=True)
class Heartbeat:
    """Extends the lease on a background thread while the DAG runs."""
    client: JobsClient
    job_id: str
    interval: float = HEARTBEAT_SECONDS
    _stop: threading.Event = field(default_factory=threading.Event)
    _thread: threading.Thread | None = None
    lost: threading.Event = field(default_factory=threading.Event)

    def start(self) -> None:
        def loop() -> None:
            while not self._stop.wait(self.interval):
                try:
                    self.client.heartbeat(self.job_id)
                    log(LOG, logging.DEBUG, "worker.heartbeat", job_id=self.job_id)
                except NotOurJob as exc:
                    # Fenced: the lease was reclaimed and another pod may
                    # already be running this world. Record it so the run's
                    # write-back does not fight with the new holder.
                    self.lost.set()
                    log(LOG, logging.ERROR, "worker.lease_lost", error=str(exc))
                    return
                except JobsError as exc:
                    # A failed heartbeat is not fatal on its own: the lease has
                    # slack, and killing a 15-minute splat because one HTTPS
                    # request timed out would be worse than the risk.
                    log(LOG, logging.WARNING, "worker.heartbeat_failed", error=str(exc))
        self._thread = threading.Thread(target=loop, daemon=True, name="wv-heartbeat")
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=5)


# ---------------------------------------------------------------------------
# Assets
# ---------------------------------------------------------------------------

def object_name(path: Path, checksum: str) -> str:
    """World-relative object name for a packaged asset.

    Content-addressed: `<first two hex>/<checksum><ext>`. Two properties follow
    from that and both matter. A re-run that produced byte-identical assets
    (SPZ encoding is deterministic — see formats/spz.py) writes the same
    objects, so a preempted upload resumes instead of duplicating storage. And
    the name contains nothing the worker chose freely, so there is nothing for
    a path-traversal check to catch later — though wv-jobs checks anyway.

    The world prefix is NOT added here. The edge function prepends it from the
    job row; a worker that could name its own prefix could write into another
    tenant's world.
    """
    if len(checksum) < 8:
        raise JobsError(f"refusing to name an object from a short checksum: {checksum!r}")
    return f"{checksum[:2]}/{checksum}{path.suffix}"


def put_bytes(url: str, path: Path, content_type: str) -> None:
    """PUT one file to a signed upload URL. No credentials attached: the URL
    is the credential, it is scoped to one object, and it expires."""
    data = path.read_bytes()
    last: Exception | None = None
    for attempt in range(1, UPLOAD_ATTEMPTS + 1):
        req = urllib.request.Request(
            url, method="PUT", data=data,
            headers={"content-type": content_type, "x-upsert": "true",
                     "cache-control": "public, max-age=31536000, immutable"})
        try:
            with urllib.request.urlopen(req, timeout=UPLOAD_TIMEOUT_S) as resp:
                resp.read()
            return
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError) as exc:
            last = exc
            detail = ""
            if isinstance(exc, urllib.error.HTTPError):
                detail = exc.read().decode("utf-8", "replace")[:200]
                # A 4xx other than 408/429 will not get better by retrying, and
                # the signed URL has a clock running.
                if exc.code not in (408, 429) and 400 <= exc.code < 500:
                    raise JobsError(f"upload of {path.name} rejected "
                                    f"({exc.code}): {detail}") from exc
            log(LOG, logging.WARNING, "worker.upload_retry", file=path.name,
                attempt=attempt, error=f"{exc}{detail}")
            time.sleep(min(8.0, 2.0 ** attempt))
    raise JobsError(f"upload of {path.name} failed after {UPLOAD_ATTEMPTS} "
                    f"attempts: {last}")


def _chunks(seq: Sequence[Any], size: int) -> Iterable[Sequence[Any]]:
    for i in range(0, len(seq), size):
        yield seq[i:i + size]


def upload_assets(client: JobsClient, job_id: str,
                  package_out: dict[str, Any]) -> list[dict[str, Any]]:
    """Upload every packaged asset and return the rows for `complete`.

    Returns one dict per asset carrying the world-relative `name`, so the edge
    function can build both the storage path and the wv_asset row from the job
    it already trusts.
    """
    assets = list(package_out.get("assets") or [])
    if len(assets) > MAX_ASSET_ROWS:
        raise JobsError(f"{len(assets)} assets exceeds the {MAX_ASSET_ROWS} the "
                        "worker API accepts in one completion")

    prepared: list[dict[str, Any]] = []
    for a in assets:
        p = Path(a["path"])
        if not p.exists():
            raise JobsError(f"packaged asset missing on disk: {p}")
        checksum = a.get("checksum") or sha256_file(p)
        prepared.append({"local": p, "checksum": checksum,
                         "name": object_name(p, checksum), "asset": a})

    for batch in _chunks(prepared, MAX_UPLOAD_FILES):
        urls = client.upload_urls(job_id, [item["name"] for item in batch])
        for item in batch:
            got = urls.get(item["name"])
            if not got or not got.get("uploadUrl"):
                raise JobsError(f"wv-jobs issued no upload url for {item['name']}")
            p: Path = item["local"]
            put_bytes(got["uploadUrl"], p,
                      CONTENT_TYPES.get(p.suffix, "application/octet-stream"))
            item["storagePath"] = got.get("storagePath", "")

    rows: list[dict[str, Any]] = []
    for item in prepared:
        a = item["asset"]
        rows.append({"role": a["role"], "format": a["format"], "name": item["name"],
                     "bytes": a.get("bytes"), "checksum": item["checksum"],
                     "lod": a.get("lod"), "chunkKey": a.get("chunk_key"),
                     "splatCount": a.get("splat_count"), "meta": a.get("meta") or {},
                     "storagePath": item.get("storagePath", "")})
    log(LOG, logging.INFO, "worker.assets_uploaded", count=len(rows))
    return rows


def upload_build_document(client: JobsClient, job_id: str, path: Path) -> str:
    """Upload the document this build assembled, as a BUILD ARTEFACT.

    It is deliberately not called world.json. The world.json a viewer loads is
    rendered from the rows by the edge function, after the ingest has proved
    that the rows say what this file says; if the two ever shared a name,
    somebody would eventually point a reader at this one and be served a world
    that no operator correction had ever reached.

    It is uploaded BEFORE the ingest because the commit step downloads it and
    diffs it against the rendered document. That is what makes the check
    single-implementation: one language compares the two, rather than the pod
    and the edge function each hashing a document and hoping they agree about
    float formatting.
    """
    urls = client.upload_urls(job_id, [RAW_DOCUMENT_OBJECT_NAME])
    got = urls.get(RAW_DOCUMENT_OBJECT_NAME)
    if not got or not got.get("uploadUrl"):
        raise JobsError(f"wv-jobs issued no upload url for {RAW_DOCUMENT_OBJECT_NAME}")
    put_bytes(got["uploadUrl"], path, "application/json")
    return str(got.get("storagePath", ""))


def send_redactions(client: JobsClient, job_id: str, redact_out: dict[str, Any]) -> int:
    """Every detection goes to wv_redaction for operator review, applied or not.

    This is the audit trail. If someone later asks "did you look for medication
    packaging in this tour", the answer is a row per detection with the
    detector name and the score, not a shrug. Batched because a 300-frame
    walkthrough can produce a few thousand rows.
    """
    raw = redact_out.get("detections_path") or ""
    if not raw:
        return 0
    path = Path(raw)
    if not path.is_file():
        return 0
    dets = json.loads(path.read_text())
    rows = [{"kind": d["kind"], "bbox": d["bbox"], "detector": d["detector"],
             "score": d.get("score"), "applied": bool(d.get("applied"))}
            for d in dets]
    sent = 0
    for batch in _chunks(rows, MAX_REDACTION_ROWS):
        sent += client.redactions(job_id, batch)
    return sent


# ---------------------------------------------------------------------------
# Running a job
# ---------------------------------------------------------------------------

def asset_urls_for_document(world_id: str, rows: Sequence[dict[str, Any]],
                            package_out: dict[str, Any]) -> dict[str, str]:
    """Map each local asset path to the durable reference the viewer resolves.

    `asset://<worldId>/<storagePath>` is exactly what
    _wv_shared/worldDocument.ts builds when it rebuilds the document from rows,
    so the copy the pipeline uploads and the copy the edge function serves
    describe the same world. A signed URL must never go in here: it expires,
    and an export bundle has to still work in a year.
    """
    by_name = {r["name"]: r for r in rows}
    out: dict[str, str] = {}
    for a, r in zip(package_out.get("assets") or [], rows):
        storage = r.get("storagePath") or f"{world_id}/{r['name']}"
        out[a["path"]] = f"asset://{world_id}/{storage}"
        by_name.setdefault(r["name"], r)
    return out


def world_identity(job: dict[str, Any]) -> dict[str, Any]:
    """Who this world belongs to, preferring the server's answer to the job's.

    `claim` returns the world row's property id, version, slug and label. Those
    are facts about the tenant, and the pod is not entitled to an opinion about
    them: a document stamped with a property id the pod chose would disagree
    with the database about whose property it is, and the ingest would reject
    every build. `params` remains the fallback so `worldengine run` still works
    on a laptop with no queue behind it.
    """
    world = job.get("world")
    return dict(world) if isinstance(world, dict) else {}


def run_job(client: JobsClient, job: dict[str, Any], *, root: Path,
            dry_run: bool = False) -> RunResult:
    world_id = str(job["worldId"])
    job_id = str(job["id"])
    params = dict(job.get("params") or {})
    world = world_identity(job)
    # Run directory keyed by world and version, never by pod: that is what
    # makes a preempted job resume instead of restarting.
    run_dir = root / world_id / str(params.get("version", 1))
    ctx = make_context(run_dir, run_id=job_id, world_id=world_id,
                       params=params, dry_run=dry_run,
                       billing_mode=os.environ.get("WORLDENGINE_BILLING_MODE"))

    target = job.get("stage") or "quality"
    deps = dict(STAGE_DEPS) if target == "all" else subgraph(STAGE_DEPS, [target])

    hb = Heartbeat(client, job_id)
    hb.start()
    error: str | None = None
    retryable = True
    result: RunResult
    try:
        result = DagRunner(ctx, deps).run()

        if result.ok and not dry_run:
            if hb.lost.is_set():
                # Another pod holds this job now. Uploading and completing
                # would race it, and the loser would overwrite the winner's
                # world row.
                raise NotOurJob("lease was lost during the run; not writing back")
            arte = {name: ctx.store.load(name) for name in deps}

            if arte.get("redact"):
                sent = send_redactions(client, job_id, arte["redact"])
                log(LOG, logging.INFO, "worker.redactions_recorded", count=sent)

            asset_rows: list[dict[str, Any]] = []
            urls: dict[str, str] = {}
            if arte.get("package"):
                asset_rows = upload_assets(client, job_id, arte["package"])
                urls = asset_urls_for_document(world_id, asset_rows, arte["package"])

            verdict: str | None = None
            ingested = False
            if arte.get("quality"):
                # The contract validation stays exactly where it was: a
                # malformed document is refused here, in the process that built
                # it, and never reaches a table. build_and_validate has no
                # non-strict mode on purpose.
                document = build_and_validate(
                    world_id=world_id,
                    property_id=str(world.get("propertyId")
                                    or params.get("property_id", world_id)),
                    version=int(world.get("version") or params.get("version", 1)),
                    label=str(world.get("label")
                              or params.get("label", "Untitled world")),
                    artefacts=arte, asset_urls=urls,
                    slug=world.get("slug") or params.get("slug"))

                # The build artefact, under a name nobody will mistake for the
                # world: the world is what the database holds, and world.json
                # is rendered from it after this has been checked against it.
                doc_path = run_dir / RAW_DOCUMENT_OBJECT_NAME
                doc_path.parent.mkdir(parents=True, exist_ok=True)
                doc_path.write_text(json.dumps(document, indent=2))
                doc_storage = upload_build_document(client, job_id, doc_path)
                asset_rows.append({
                    "role": "export_bundle", "format": "json",
                    "name": RAW_DOCUMENT_OBJECT_NAME,
                    "bytes": doc_path.stat().st_size,
                    "checksum": sha256_file(doc_path),
                    "chunkKey": RAW_DOCUMENT_CHUNK_KEY,
                    "meta": {"purpose": "the document this build assembled, kept "
                                        "for diffing against the rows",
                             "storagePath": doc_storage}})

                log(LOG, logging.INFO, "worker.handoff_start", **summarise(document))
                out = deliver(client, job_id, document, asset_rows)
                verdict = out.get("verdict")
                ingested = True

            # `complete` closes the job. When the hand-off ran it has already
            # written the assets, the quality row and the publication decision,
            # so passing them again would insert a second verdict; when it did
            # not -- a job targeting a single stage -- the assets still need
            # recording and this is the only place left to do it.
            done = client.complete(
                job_id,
                gpuSeconds=round(ctx.ledger.total_gpu_seconds, 2),
                costUsd=round(ctx.ledger.total_usd, 5),
                result={"stages": result.to_json()["stages"],
                        "costs": ctx.ledger.to_json()},
                assets=[] if ingested else asset_rows)
            log(LOG, logging.INFO, "worker.completed",
                verdict=verdict or done.get("verdict"),
                assets=len(asset_rows), ingested=ingested)
        elif result.ok and dry_run:
            log(LOG, logging.INFO, "worker.dry_run_complete")
        else:
            error = result.error or "run failed"
    except NotOurJob as exc:
        error = f"NotOurJob: {exc}"
        log(LOG, logging.ERROR, "worker.lease_lost", error=error)
        # Deliberately no `fail` call: the job belongs to someone else now and
        # reporting a failure on it would requeue work that is already running.
        return RunResult(run_id=job_id, world_id=world_id, ok=False, records={},
                         outputs={}, ledger=ctx.ledger, error=error)
    except (IngestRefused, HandoffError) as exc:
        # The reconstruction succeeded and the hand-off did not. Running the
        # DAG again would resume from the same checkpoints and build the same
        # document, so a retry buys nothing but two more attempts' worth of
        # delay before anyone is told. Fail it outright.
        error = f"{type(exc).__name__}: {exc}"
        retryable = False
        log(LOG, logging.ERROR, "worker.handoff_refused", error=error)
        result = RunResult(run_id=job_id, world_id=world_id, ok=False, records={},
                           outputs={}, ledger=ctx.ledger, error=error)
    except Exception as exc:                            # noqa: BLE001
        error = f"{type(exc).__name__}: {exc}"
        log(LOG, logging.ERROR, "worker.job_failed", error=error, exc_info=True)
        result = RunResult(run_id=job_id, world_id=world_id, ok=False, records={},
                           outputs={}, ledger=ctx.ledger, error=error)
    finally:
        hb.stop()

    if error is not None and not dry_run:
        # StageUnavailable means a model or a GPU is missing on THIS pod, which
        # another pod may well have, so that is retryable. A refused hand-off
        # is not: see the except clause above.
        try:
            client.fail(job_id, error, retryable=retryable)
        except NotOurJob:
            log(LOG, logging.WARNING, "worker.fail_not_ours", job_id=job_id)
        result.ok = False
        result.error = error
    return result


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="worldengine-worker",
                                 description="Lease and run World Viewer jobs")
    ap.add_argument("--root", default=os.environ.get("WORLDENGINE_RUN_ROOT", "/workspace/runs"))
    ap.add_argument("--once", action="store_true", help="claim at most one job then exit")
    ap.add_argument("--poll", type=float, default=10.0, help="seconds between claims")
    ap.add_argument("--idle-exit", type=float, default=0.0,
                    help="exit after this many idle seconds (0 = never); set it "
                         "on serverless so an empty queue stops the meter")
    ap.add_argument("--stages", nargs="*", default=None,
                    help="stages this pod will claim; defaults to all")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args(argv)

    configure()
    client = JobsClient.from_env()
    root = Path(args.root)
    root.mkdir(parents=True, exist_ok=True)
    stages = args.stages or list(STAGE_DEPS)

    stop = threading.Event()

    def handle(signum: int, _frame: Any) -> None:
        # RunPod sends SIGTERM before preemption. Finish the current stage,
        # which will checkpoint, and let the lease expire so the queue
        # re-offers the job to a pod that can resume from the artefacts.
        log(LOG, logging.WARNING, "worker.signal", signal=signum)
        stop.set()
    signal.signal(signal.SIGTERM, handle)
    signal.signal(signal.SIGINT, handle)

    log(LOG, logging.INFO, "worker.start", worker_id=client.worker_id,
        host=socket.gethostname(), root=str(root), stages=stages,
        jobs_url=client.url, dry_run=args.dry_run)

    idle_since = time.time()
    while not stop.is_set():
        try:
            job = client.claim(stages)
        except JobsError as exc:
            # A queue we cannot reach is not an empty queue. Back off and say
            # so rather than spinning silently.
            log(LOG, logging.ERROR, "worker.claim_failed", error=str(exc))
            if args.once:
                return 1
            stop.wait(max(args.poll, 30.0))
            continue
        if job is None:
            if args.once:
                log(LOG, logging.INFO, "worker.no_job")
                return 0
            if args.idle_exit and (time.time() - idle_since) > args.idle_exit:
                log(LOG, logging.INFO, "worker.idle_exit")
                return 0
            stop.wait(args.poll)
            continue
        idle_since = time.time()
        with log_context(job_id=str(job["id"]), world_id=str(job["worldId"])):
            log(LOG, logging.INFO, "worker.claimed", stage=job.get("stage"),
                attempt=job.get("attempt"))
            result = run_job(client, job, root=root, dry_run=args.dry_run)
            log(LOG, logging.INFO, "worker.finished", ok=result.ok,
                gpu_seconds=round(result.ledger.total_gpu_seconds, 1),
                usd=round(result.ledger.total_usd, 4))
        if args.once:
            return 0 if result.ok else 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
