"""The RunPod worker's transport.

The pod's entire secret inventory is WV_WORKER_SECRET plus the wv-jobs URL, and
these tests are what keeps it that way: they assert the shape of every call, the
absence of any Supabase credential path, and the behaviour when the secret is
wrong or the lease has moved on.

The HTTP layer is replaced with a recorder that mimics wv-jobs' contract —
including its 401 and 409 responses — so the worker's logic is exercised rather
than PostgREST or Deno.
"""
from __future__ import annotations

import json
import threading
import time
import urllib.error
from io import BytesIO
from pathlib import Path

import pytest

from worldengine import worker as W
from worldengine.costs import CostLedger
from tests.fixtures import artefacts

SECRET = "s" * 48
WORKER_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
JOB_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
WORLD_ID = "55555555-5555-4555-8555-555555555555"
PROPERTY_ID = "33333333-3333-4333-8333-333333333333"
URL = "https://edge.test/functions/v1/wv-jobs"


class FakeJobs(W.JobsClient):
    """Records actions instead of making them. Mirrors wv-jobs' responses."""

    def __init__(self, **over):
        super().__init__(url=URL, secret=SECRET, worker_id=WORKER_ID)
        self.calls: list[tuple[str, dict]] = []
        self.queue: list[dict] = []
        self.uploaded: list[tuple[str, str]] = []
        self.lease_lost_on: set[str] = set()
        self.unauthorised = False
        self.ingested: list[dict] = []
        self.refuse_commit = False
        self.__dict__.update(over)

    def call(self, action, payload=None):
        body = {"action": action, "workerId": self.worker_id, **(payload or {})}
        self.calls.append((action, body))
        if self.unauthorised:
            raise W.JobsError(f"{action}: wv-jobs rejected the worker secret.")
        if action in self.lease_lost_on:
            raise W.NotOurJob(f"{action}: Not your job.")
        if action == "claim":
            return {"job": self.queue.pop(0)} if self.queue else {"job": None}
        if action == "heartbeat":
            return {"ok": True, "leaseUntil": "2026-09-19T12:15:00Z"}
        if action == "upload-urls":
            return {"bucket": "wv-assets", "expiresIn": 900, "files": [
                {"name": f["name"], "storagePath": f"{WORLD_ID}/{f['name']}",
                 "uploadUrl": f"https://storage.test/upload/{f['name']}?token=t"}
                for f in payload["files"]]}
        if action == "redactions":
            return {"ok": True, "inserted": len(payload.get("rows", []))}
        if action == "ingest-world":
            section = payload.get("section")
            self.ingested.append(payload)
            if self.refuse_commit and section == "commit":
                raise W.IngestRefused(
                    "ingest-world: The world in the database does not match the "
                    "world that was built: 1 missing rooms")
            if section == "commit":
                return {"ok": True, "verdict": "pass",
                        "document": {"storagePath": f"{WORLD_ID}/world.json",
                                     "bytes": 1234, "checksum": "d" * 64}}
            return {"ok": True, "section": section,
                    "written": len(payload.get("rows", []) or [])}
        if action == "complete":
            return {"ok": True, "verdict": (payload.get("quality") or {}).get("verdict")}
        if action == "fail":
            return {"ok": True, "requeued": True}
        raise AssertionError(f"unexpected action {action}")

    def action(self, name):
        return [b for a, b in self.calls if a == name]


@pytest.fixture
def no_real_uploads(monkeypatch):
    """Replaces put_bytes. NOT autouse: the put_bytes tests below exercise the
    real function and must not be shadowed by their own stub."""
    sent: list[tuple[str, str, str]] = []

    def fake_put(url, path, content_type):
        sent.append((url, Path(path).name, content_type))
    monkeypatch.setattr(W, "put_bytes", fake_put)
    return sent


# ---------------------------------------------------------------------------
# Credentials
# ---------------------------------------------------------------------------

def test_the_pod_needs_only_the_secret_the_url_and_its_id(monkeypatch):
    monkeypatch.setenv("WV_JOBS_URL", URL)
    monkeypatch.setenv("WV_WORKER_SECRET", SECRET)
    monkeypatch.setenv("WV_WORKER_ID", WORKER_ID)
    c = W.JobsClient.from_env()
    assert c.url == URL and c.secret == SECRET and c.worker_id == WORKER_ID


@pytest.mark.parametrize("missing", ["WV_JOBS_URL", "WV_WORKER_SECRET", "WV_WORKER_ID"])
def test_missing_config_fails_at_startup_with_a_usable_message(monkeypatch, missing):
    for k, v in (("WV_JOBS_URL", URL), ("WV_WORKER_SECRET", SECRET),
                 ("WV_WORKER_ID", WORKER_ID)):
        monkeypatch.setenv(k, v)
    monkeypatch.delenv(missing, raising=False)
    with pytest.raises(W.JobsError) as exc:
        W.JobsClient.from_env()
    assert missing in str(exc.value)
    assert "does NOT take a Supabase key" in str(exc.value)


def test_a_short_secret_is_refused_before_the_first_401(monkeypatch):
    monkeypatch.setenv("WV_JOBS_URL", URL)
    monkeypatch.setenv("WV_WORKER_SECRET", "tooshort")
    monkeypatch.setenv("WV_WORKER_ID", WORKER_ID)
    with pytest.raises(W.JobsError, match="at least 32 characters"):
        W.JobsClient.from_env()


def test_there_is_no_supabase_credential_path_left_in_the_worker():
    """The point of the whole change: not that the key is unused, that it
    cannot be used."""
    src = Path(W.__file__).read_text()
    for forbidden in ("SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_URL", "service_role",
                      "apikey", "/rest/v1/", "SupabaseClient"):
        assert forbidden not in src, forbidden


def test_every_call_presents_the_secret_header(monkeypatch):
    seen: dict[str, object] = {}

    class FakeResp:
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def read(self): return b'{"job": null}'

    def fake_urlopen(req, timeout=None):
        seen["headers"] = dict(req.headers)
        seen["url"] = req.full_url
        seen["body"] = json.loads(req.data)
        return FakeResp()

    monkeypatch.setattr(W.urllib.request, "urlopen", fake_urlopen)
    W.JobsClient(url=URL, secret=SECRET, worker_id=WORKER_ID).claim(["splat"])
    # urllib title-cases header names.
    assert seen["headers"]["X-wv-worker-secret"] == SECRET
    assert "Authorization" not in seen["headers"]
    assert "Apikey" not in seen["headers"]
    assert seen["url"] == URL
    assert seen["body"]["workerId"] == WORKER_ID
    assert seen["body"]["action"] == "claim"


def test_a_wrong_secret_surfaces_as_a_clear_error(monkeypatch):
    def fake_urlopen(req, timeout=None):
        raise urllib.error.HTTPError(URL, 401, "Unauthorized", {},
                                     BytesIO(b'{"error":"Unauthorised."}'))
    monkeypatch.setattr(W.urllib.request, "urlopen", fake_urlopen)
    c = W.JobsClient(url=URL, secret="x" * 48, worker_id=WORKER_ID)
    with pytest.raises(W.JobsError, match="rejected the worker secret"):
        c.claim(["splat"])


def test_a_missing_secret_header_is_a_401_not_a_silent_empty_queue(monkeypatch):
    """A 401 must never look like 'no work available', or a misconfigured pod
    sits in a poll loop looking healthy."""
    def fake_urlopen(req, timeout=None):
        raise urllib.error.HTTPError(URL, 401, "Unauthorized", {}, BytesIO(b"{}"))
    monkeypatch.setattr(W.urllib.request, "urlopen", fake_urlopen)
    c = W.JobsClient(url=URL, secret="y" * 48, worker_id=WORKER_ID)
    with pytest.raises(W.JobsError):
        c.claim(["splat"])


def test_a_409_becomes_NotOurJob(monkeypatch):
    def fake_urlopen(req, timeout=None):
        raise urllib.error.HTTPError(URL, 409, "Conflict", {},
                                     BytesIO(b'{"error":"Not your job."}'))
    monkeypatch.setattr(W.urllib.request, "urlopen", fake_urlopen)
    c = W.JobsClient(url=URL, secret=SECRET, worker_id=WORKER_ID)
    with pytest.raises(W.NotOurJob):
        c.heartbeat(JOB_ID)


def test_an_unreachable_function_says_so(monkeypatch):
    def fake_urlopen(req, timeout=None):
        raise urllib.error.URLError("connection refused")
    monkeypatch.setattr(W.urllib.request, "urlopen", fake_urlopen)
    c = W.JobsClient(url=URL, secret=SECRET, worker_id=WORKER_ID)
    with pytest.raises(W.JobsError, match="could not reach wv-jobs"):
        c.claim(["splat"])


# ---------------------------------------------------------------------------
# Leasing
# ---------------------------------------------------------------------------

def test_claim_returns_none_on_an_empty_queue():
    assert FakeJobs().claim(["splat"]) is None


def test_claim_sends_the_lease_and_the_requested_stages():
    c = FakeJobs()
    c.queue.append({"id": JOB_ID, "worldId": WORLD_ID, "stage": "splat"})
    job = c.claim(["splat", "mesh"])
    assert job["id"] == JOB_ID
    body = c.action("claim")[0]
    assert body["stages"] == ["splat", "mesh"]
    assert body["leaseSeconds"] == W.LEASE_SECONDS


def test_heartbeat_extends_the_lease_on_a_background_thread():
    c = FakeJobs()
    hb = W.Heartbeat(c, JOB_ID, interval=0.02)
    hb.start()
    time.sleep(0.12)
    hb.stop()
    beats = c.action("heartbeat")
    assert len(beats) >= 2
    assert beats[0]["jobId"] == JOB_ID
    assert beats[0]["leaseSeconds"] == W.LEASE_SECONDS
    assert not hb.lost.is_set()


def test_heartbeat_survives_a_transient_failure():
    """A 15-minute splat must not die because one HTTPS request timed out."""
    class Flaky(FakeJobs):
        def call(self, action, payload=None):
            raise W.JobsError("boom")
    hb = W.Heartbeat(Flaky(), JOB_ID, interval=0.02)
    hb.start()
    time.sleep(0.08)
    hb.stop()
    assert not hb.lost.is_set()


def test_heartbeat_stops_and_flags_when_the_lease_is_lost():
    """409 means another pod holds the job. Continuing to write would have two
    GPUs reconstructing the same property into the same rows."""
    c = FakeJobs(lease_lost_on={"heartbeat"})
    hb = W.Heartbeat(c, JOB_ID, interval=0.02)
    hb.start()
    time.sleep(0.12)
    hb.stop()
    assert hb.lost.is_set()
    assert len(c.action("heartbeat")) == 1, "it must stop after being fenced"


def test_a_worker_heartbeating_a_job_it_does_not_hold_is_refused():
    c = FakeJobs(lease_lost_on={"heartbeat"})
    with pytest.raises(W.NotOurJob):
        c.heartbeat(JOB_ID)


# ---------------------------------------------------------------------------
# Assets
# ---------------------------------------------------------------------------

def test_object_name_is_content_addressed_and_carries_no_worker_choice():
    p = Path("/tmp/whatever.spz")
    assert W.object_name(p, "ab" + "c" * 62) == "ab/ab" + "c" * 62 + ".spz"
    with pytest.raises(W.JobsError, match="short checksum"):
        W.object_name(p, "ab")


def test_object_name_never_contains_a_world_prefix():
    """The prefix is the edge function's business. A worker that could name it
    could write into another tenant's world."""
    name = W.object_name(Path("x.ply"), "de" + "f" * 62)
    assert not name.startswith("/") and ".." not in name
    assert WORLD_ID not in name


def test_upload_requests_signed_urls_and_puts_to_them(tmp_path, no_real_uploads):
    c = FakeJobs()
    p = tmp_path / "world.spz"
    p.write_bytes(b"x" * 32)
    pkg = {"assets": [{"path": str(p), "role": "splat", "format": "spz",
                       "checksum": "ab" + "1" * 62, "bytes": 32,
                       "chunk_key": None, "lod": None, "splat_count": 10}]}
    rows = W.upload_assets(c, JOB_ID, pkg)

    req = c.action("upload-urls")[0]
    assert req["jobId"] == JOB_ID
    assert req["files"] == [{"name": "ab/ab" + "1" * 62 + ".spz"}]
    # The bytes went to the signed URL, with no credential attached.
    assert len(no_real_uploads) == 1
    assert no_real_uploads[0][0].startswith("https://storage.test/upload/")
    assert rows[0]["role"] == "splat"
    assert rows[0]["name"] == "ab/ab" + "1" * 62 + ".spz"
    assert rows[0]["storagePath"] == f"{WORLD_ID}/ab/ab" + "1" * 62 + ".spz"


def test_uploads_are_batched_to_the_api_limit(tmp_path, no_real_uploads):
    c = FakeJobs()
    assets = []
    for i in range(W.MAX_UPLOAD_FILES + 5):
        p = tmp_path / f"a{i}.spz"
        p.write_bytes(b"y")
        assets.append({"path": str(p), "role": "splat_chunk", "format": "spz",
                       "checksum": f"{i:064x}", "bytes": 1})
    W.upload_assets(c, JOB_ID, {"assets": assets})
    reqs = c.action("upload-urls")
    assert len(reqs) == 2
    assert len(reqs[0]["files"]) == W.MAX_UPLOAD_FILES
    assert len(no_real_uploads) == W.MAX_UPLOAD_FILES + 5


def test_upload_fails_loudly_on_a_missing_file(tmp_path):
    with pytest.raises(W.JobsError, match="missing on disk"):
        W.upload_assets(FakeJobs(), JOB_ID,
                        {"assets": [{"path": str(tmp_path / "nope.spz"),
                                     "role": "splat", "format": "spz"}]})


def test_upload_fails_loudly_when_no_url_is_issued(tmp_path):
    class NoUrls(FakeJobs):
        def call(self, action, payload=None):
            if action == "upload-urls":
                self.calls.append((action, payload))
                return {"files": []}
            return super().call(action, payload)
    p = tmp_path / "a.spz"
    p.write_bytes(b"z")
    with pytest.raises(W.JobsError, match="no upload url"):
        W.upload_assets(NoUrls(), JOB_ID,
                        {"assets": [{"path": str(p), "role": "splat",
                                     "format": "spz", "checksum": "ab" + "2" * 62}]})


def test_put_bytes_does_not_retry_a_permanent_rejection(tmp_path, monkeypatch):
    p = tmp_path / "a.spz"
    p.write_bytes(b"q")
    tries = []

    def fake_urlopen(req, timeout=None):
        tries.append(1)
        raise urllib.error.HTTPError(req.full_url, 403, "Forbidden", {},
                                     BytesIO(b"expired"))
    monkeypatch.setattr(W.urllib.request, "urlopen", fake_urlopen)
    with pytest.raises(W.JobsError, match="rejected"):
        W.put_bytes("https://storage.test/x", p, "application/octet-stream")
    assert len(tries) == 1, "a 403 will not get better; the URL has a clock on it"


def test_put_bytes_retries_a_transient_failure(tmp_path, monkeypatch):
    p = tmp_path / "a.spz"
    p.write_bytes(b"q")
    calls = []

    class Ok:
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def read(self): return b""

    def fake_urlopen(req, timeout=None):
        calls.append(1)
        if len(calls) < 2:
            raise urllib.error.URLError("reset")
        return Ok()
    monkeypatch.setattr(W.urllib.request, "urlopen", fake_urlopen)
    monkeypatch.setattr(W.time, "sleep", lambda s: None)
    W.put_bytes("https://storage.test/x", p, "application/octet-stream")
    assert len(calls) == 2


def test_put_bytes_sends_no_credential(tmp_path, monkeypatch):
    p = tmp_path / "a.spz"
    p.write_bytes(b"q")
    seen = {}

    class Ok:
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def read(self): return b""

    def fake_urlopen(req, timeout=None):
        seen.update(dict(req.headers))
        seen["method"] = req.get_method()
        return Ok()
    monkeypatch.setattr(W.urllib.request, "urlopen", fake_urlopen)
    W.put_bytes("https://storage.test/x?token=t", p, "application/json")
    assert seen["method"] == "PUT"
    assert "Authorization" not in seen and "Apikey" not in seen
    assert "X-wv-worker-secret" not in seen
    assert seen["Content-type"] == "application/json"


# ---------------------------------------------------------------------------
# Redactions
# ---------------------------------------------------------------------------

def test_every_detection_is_sent_for_operator_review(tmp_path):
    c = FakeJobs()
    p = tmp_path / "redactions.json"
    p.write_text(json.dumps([
        {"kind": "medication", "bbox": [1, 2, 3, 4], "detector": "owlv2",
         "score": 0.31, "applied": True},
        {"kind": "face", "bbox": [5, 6, 7, 8], "detector": "yunet",
         "score": 0.88, "applied": False}]))
    assert W.send_redactions(c, JOB_ID, {"detections_path": str(p)}) == 2
    rows = c.action("redactions")[0]["rows"]
    assert {r["kind"] for r in rows} == {"medication", "face"}
    assert rows[1]["applied"] is False
    # The world id is never sent: wv-jobs takes it from the job row.
    assert "worldId" not in c.action("redactions")[0]


def test_redactions_are_batched(tmp_path):
    c = FakeJobs()
    p = tmp_path / "redactions.json"
    p.write_text(json.dumps([{"kind": "face", "bbox": [0, 0, 1, 1],
                              "detector": "yunet", "score": 0.9, "applied": True}]
                            * (W.MAX_REDACTION_ROWS + 10)))
    sent = W.send_redactions(c, JOB_ID, {"detections_path": str(p)})
    assert sent == W.MAX_REDACTION_ROWS + 10
    assert len(c.action("redactions")) == 2


def test_send_redactions_is_a_no_op_when_the_stage_did_not_run():
    c = FakeJobs()
    assert W.send_redactions(c, JOB_ID, {}) == 0
    assert W.send_redactions(c, JOB_ID, {"detections_path": ""}) == 0
    assert c.calls == []


# ---------------------------------------------------------------------------
# Document references
# ---------------------------------------------------------------------------

def test_document_asset_urls_are_durable_not_signed():
    """A signed URL expires; an export bundle has to work in a year. The
    document carries the same asset:// reference wv-view rebuilds."""
    rows = [{"name": "ab/abc.spz", "storagePath": f"{WORLD_ID}/ab/abc.spz"}]
    pkg = {"assets": [{"path": "/tmp/world.spz"}]}
    urls = W.asset_urls_for_document(WORLD_ID, rows, pkg)
    assert urls["/tmp/world.spz"] == f"asset://{WORLD_ID}/{WORLD_ID}/ab/abc.spz"
    assert "token" not in urls["/tmp/world.spz"]
    assert "https://" not in urls["/tmp/world.spz"]


# ---------------------------------------------------------------------------
# Running a job end to end
# ---------------------------------------------------------------------------

def _seed(run_root: Path, world_id: str) -> None:
    from worldengine.artifacts import ArtifactStore
    store = ArtifactStore(run_root / world_id / "1")
    for name, payload in artefacts().items():
        store.save(name, payload, f"fp-{name}")


def test_a_completed_run_uploads_then_reports(tmp_path, monkeypatch, no_real_uploads):
    """The happy path: redactions, assets, document, then one complete call
    carrying the quality verdict and the measured cost."""
    _seed(tmp_path, WORLD_ID)
    for a in artefacts()["package"]["assets"]:
        p = Path(a["path"])
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(b"data")
    det = Path("/tmp/redactions.json")
    det.write_text(json.dumps([{"kind": "face", "bbox": [1, 2, 3, 4],
                                "detector": "yunet", "score": 0.9, "applied": True}]))

    c = FakeJobs()
    monkeypatch.setattr(W, "DagRunner", _StubRunner)
    job = {"id": JOB_ID, "worldId": WORLD_ID, "stage": "quality",
           "params": {"version": 1, "label": "Flat 3", "property_id": "prp-1"},
           "world": {"id": WORLD_ID, "propertyId": PROPERTY_ID, "version": 1,
                     "label": "Flat 3, Alpha Court", "slug": "flat-3"}}
    result = W.run_job(c, job, root=tmp_path)

    assert result.ok
    # Assets first, then the build artefact, then the world itself, then the
    # job is closed. The hand-off is what writes the rows; `complete` only
    # records what the run cost.
    order = [a for i, (a, _) in enumerate(c.calls)
             if i == 0 or c.calls[i - 1][0] != a]        # runs collapsed
    assert order == ["redactions", "upload-urls", "ingest-world", "complete"]
    sections = [b["section"] for b in c.ingested]
    assert sections[0] == "header" and sections[-1] == "commit"
    assert sections.index("rooms") < sections.index("surfaces")
    assert sections.index("nav-nodes") < sections.index("nav-edges")

    # The assembled document is a BUILD artefact under a name nobody will
    # mistake for the world, and it is uploaded before the ingest because the
    # commit diffs the rows against it.
    raw = tmp_path / WORLD_ID / "1" / "build" / "world.raw.json"
    doc = json.loads(raw.read_text())
    assert doc["quality"]["verdict"] == "pass"
    assert not (tmp_path / WORLD_ID / "1" / "world.json").exists()
    assets = [b for b in c.ingested if b["section"] == "assets"][0]["rows"]
    raw_row = [a for a in assets if a["name"] == "build/world.raw.json"][0]
    assert raw_row["chunkKey"] == "world-raw"

    # The world's identity comes from the claim, not from the pod's params.
    assert doc["propertyId"] == PROPERTY_ID
    assert doc["label"] == "Flat 3, Alpha Court"

    done = c.action("complete")[0]
    # The hand-off wrote the assets and the verdict; sending them again here
    # would give the world a second quality row.
    assert done["assets"] == []
    assert "quality" not in done and "scale" not in done


def test_a_refused_handoff_fails_the_job_and_is_not_retried(tmp_path, monkeypatch,
                                                            no_real_uploads):
    """A world that does not match what was built must not publish, and must
    not be retried: the run resumes from the same checkpoints and would build
    the same document again."""
    _seed(tmp_path, WORLD_ID)
    for a in artefacts()["package"]["assets"]:
        p = Path(a["path"])
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(b"data")
    Path("/tmp/redactions.json").write_text("[]")

    c = FakeJobs()
    c.refuse_commit = True
    monkeypatch.setattr(W, "DagRunner", _StubRunner)
    result = W.run_job(c, {"id": JOB_ID, "worldId": WORLD_ID, "stage": "quality",
                           "params": {"version": 1}}, root=tmp_path)

    assert not result.ok
    assert "IngestRefused" in (result.error or "")
    assert "missing rooms" in (result.error or "")
    assert [a for a, _ in c.calls][-1] == "fail"
    assert c.action("fail")[0]["retryable"] is False
    # The job never completed, so nothing published.
    assert c.action("complete") == []


def test_a_failed_run_reports_fail_and_never_completes(tmp_path, monkeypatch):
    _seed(tmp_path, WORLD_ID)
    c = FakeJobs()
    monkeypatch.setattr(W, "DagRunner", _failing_runner("StageUnavailable: no MapAnything"))
    result = W.run_job(c, {"id": JOB_ID, "worldId": WORLD_ID, "stage": "pose"},
                       root=tmp_path)
    assert not result.ok
    assert [a for a, _ in c.calls] == ["fail"]
    assert "MapAnything" in c.action("fail")[0]["error"]
    assert c.action("fail")[0]["retryable"] is True


def test_a_lost_lease_stops_the_write_back_entirely(tmp_path, monkeypatch,
                                                    no_real_uploads):
    """If the lease went to another pod mid-run, uploading and completing would
    race it and the loser would overwrite the winner's world row."""
    _seed(tmp_path, WORLD_ID)

    class LostRunner(_StubRunner):
        def run(self):
            _CURRENT_HEARTBEAT[0].lost.set()
            return super().run()

    monkeypatch.setattr(W, "DagRunner", LostRunner)
    c = FakeJobs()
    result = W.run_job(c, {"id": JOB_ID, "worldId": WORLD_ID, "stage": "quality",
                           "params": {"version": 1}}, root=tmp_path)
    assert not result.ok
    assert "NotOurJob" in (result.error or "")
    # Neither completed nor failed: the job is somebody else's now.
    assert [a for a, _ in c.calls] == []


def test_dry_run_reports_nothing_back(tmp_path, monkeypatch):
    _seed(tmp_path, WORLD_ID)
    monkeypatch.setattr(W, "DagRunner", _StubRunner)
    c = FakeJobs()
    result = W.run_job(c, {"id": JOB_ID, "worldId": WORLD_ID, "stage": "quality",
                           "params": {"version": 1}}, root=tmp_path, dry_run=True)
    assert result.ok
    assert c.calls == []


def test_main_backs_off_rather_than_spinning_when_the_queue_is_unreachable(monkeypatch):
    monkeypatch.setenv("WV_JOBS_URL", URL)
    monkeypatch.setenv("WV_WORKER_SECRET", SECRET)
    monkeypatch.setenv("WV_WORKER_ID", WORKER_ID)

    class Broken(W.JobsClient):
        @classmethod
        def from_env(cls):
            return cls(url=URL, secret=SECRET, worker_id=WORKER_ID)

        def claim(self, stages):
            raise W.JobsError("could not reach wv-jobs")

    monkeypatch.setattr(W, "JobsClient", Broken)
    assert W.main(["--once", "--root", "/tmp/we-root"]) == 1


# --- stubs ------------------------------------------------------------------

_CURRENT_HEARTBEAT: list = [None]
_real_heartbeat_start = W.Heartbeat.start


def _track_start(self):
    _CURRENT_HEARTBEAT[0] = self
    _real_heartbeat_start(self)


W.Heartbeat.start = _track_start


class _StubRunner:
    """Stands in for DagRunner: the DAG itself is tested in test_runner.py."""

    def __init__(self, ctx, deps=None, force=()):
        self.ctx = ctx
        self.deps = deps or {}

    def run(self):
        from worldengine.runner import RunResult
        self.ctx.ledger.record("splat", 900.0, 900.0)
        return RunResult(run_id=self.ctx.run_id, world_id=self.ctx.world_id,
                         ok=True, records={}, outputs={}, ledger=self.ctx.ledger)


def _failing_runner(message: str):
    class Failing(_StubRunner):
        def run(self):
            from worldengine.runner import RunResult
            return RunResult(run_id=self.ctx.run_id, world_id=self.ctx.world_id,
                             ok=False, records={}, outputs={},
                             ledger=self.ctx.ledger, error=message)
    return Failing
