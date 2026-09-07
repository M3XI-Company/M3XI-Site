#!/usr/bin/env python3
"""
m3xi local worker
=================

A single-file render box that drains the Studio's job queue (Supabase table
``m3ix_jobs``) using open-weight models on a local GPU.

Loop:
    1. heartbeat  -> upsert a row in ``m3ix_workers`` every HEARTBEAT_SECONDS
    2. claim      -> POST /rest/v1/rpc/m3ix_claim_job (service role only)
    3. render     -> BACKEND = diffusers | comfy | mock
    4. upload     -> storage bucket ``videos`` at local/<job_id>.<ext>
    5. finish     -> PATCH job status=done, output={url, seconds, model}
       on error   -> PATCH job status=failed, error=<text>, and insert ONE
                     refund row in ``m3ix_credit_ledger`` (idempotent).

Only ``requests`` is required to run the mock backend. torch/diffusers are
imported lazily inside the diffusers backend so a machine without a GPU can
still test the queue end to end with BACKEND=mock.

Configuration comes from environment variables or a ``.env`` file next to
this script (see ``.env.example``).
"""

from __future__ import annotations

import json
import os
import signal
import socket
import sys
import tempfile
import time
import traceback
from pathlib import Path
from typing import Any, Optional

import requests

# ---------------------------------------------------------------------------
# Render constants - lower these for 12-16 GB cards (see README)
# ---------------------------------------------------------------------------
FPS = 16                         # Wan2.2 TI2V is trained at 16 fps
FRAMES_PER_SECOND_OF_VIDEO = 16  # frames = seconds * this + 1
MAX_FRAMES = 81                  # 5 s @ 16 fps. Set to 49 or 33 on small cards.
NUM_INFERENCE_STEPS = 30
GUIDANCE_SCALE = 5.0
# Output resolution per aspect (width, height). Wan2.2-5B wants multiples of 32.
# For 12-16 GB cards try (832, 480) / (480, 832) / (640, 640).
RESOLUTIONS = {
    "16:9": (1280, 704),
    "9:16": (704, 1280),
    "1:1": (960, 960),
}
IMAGE_RESOLUTIONS = {
    "16:9": (1344, 768),
    "9:16": (768, 1344),
    "1:1": (1024, 1024),
}
IMAGE_MODEL = "black-forest-labs/FLUX.1-schnell"
IMAGE_STEPS = 4

HEARTBEAT_SECONDS = 30
IDLE_POLL_SECONDS = 5       # how long to sleep when the queue is empty
HTTP_TIMEOUT = 60
UPLOAD_TIMEOUT = 600


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
def load_dotenv(path: Path) -> None:
    """Minimal .env loader: KEY=VALUE lines, '#' comments, optional quotes.
    Real environment variables always win over the file."""
    if not path.exists():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


class Config:
    def __init__(self) -> None:
        load_dotenv(Path(__file__).resolve().parent / ".env")
        self.supabase_url = os.environ.get("SUPABASE_URL", "").rstrip("/")
        self.service_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
        self.worker_name = os.environ.get("WORKER_NAME") or socket.gethostname()
        self.kinds = [k.strip() for k in os.environ.get("WORKER_KINDS", "video").split(",") if k.strip()]
        self.model = os.environ.get("MODEL", "Wan-AI/Wan2.2-TI2V-5B-Diffusers")
        self.backend = os.environ.get("BACKEND", "diffusers").lower()
        self.gpu = os.environ.get("GPU_NAME", "")  # optional override for the heartbeat
        self.comfy_url = os.environ.get("COMFY_URL", "http://127.0.0.1:8188")
        self.comfy_workflow = os.environ.get("COMFY_WORKFLOW", "")

        if not self.supabase_url or not self.service_key:
            sys.exit("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required (env or worker/.env)")
        if self.backend not in ("diffusers", "comfy", "mock"):
            sys.exit(f"BACKEND must be diffusers, comfy or mock (got {self.backend!r})")


def log(msg: str) -> None:
    print(time.strftime("%Y-%m-%d %H:%M:%S"), msg, flush=True)


# ---------------------------------------------------------------------------
# Supabase REST client (PostgREST + Storage)
# ---------------------------------------------------------------------------
class Supabase:
    def __init__(self, cfg: Config) -> None:
        self.url = cfg.supabase_url
        self.key = cfg.service_key
        self.s = requests.Session()
        self.s.headers.update({
            "apikey": self.key,
            "Authorization": f"Bearer {self.key}",
        })

    # -- generic helpers ---------------------------------------------------
    def _rest(self, method: str, path: str, *, params: Optional[dict] = None,
              body: Any = None, prefer: Optional[str] = None) -> Any:
        headers = {"Content-Type": "application/json"}
        if prefer:
            headers["Prefer"] = prefer
        r = self.s.request(
            method, f"{self.url}/rest/v1/{path}",
            params=params, headers=headers,
            data=json.dumps(body) if body is not None else None,
            timeout=HTTP_TIMEOUT,
        )
        if not r.ok:
            raise RuntimeError(f"{method} {path} -> {r.status_code}: {r.text[:500]}")
        if r.status_code == 204 or not r.text:
            return None
        return r.json()

    # -- workers -----------------------------------------------------------
    def heartbeat(self, name: str, gpu: str, kinds: list[str]) -> None:
        """Upsert this worker's row. jobs_done is left alone on conflict
        because we only send the columns we want merged."""
        self._rest(
            "POST", "m3ix_workers",
            params={"on_conflict": "name"},
            body={"name": name, "gpu": gpu, "kinds": kinds,
                  "last_seen": now_iso()},
            prefer="resolution=merge-duplicates,return=minimal",
        )

    def increment_jobs_done(self, name: str) -> None:
        rows = self._rest("GET", "m3ix_workers",
                          params={"name": f"eq.{name}", "select": "jobs_done"})
        current = (rows[0].get("jobs_done") or 0) if rows else 0
        self._rest("PATCH", "m3ix_workers",
                   params={"name": f"eq.{name}"},
                   body={"jobs_done": current + 1},
                   prefer="return=minimal")

    # -- jobs --------------------------------------------------------------
    def claim_job(self, worker: str, kinds: list[str]) -> Optional[dict]:
        rows = self._rest("POST", "rpc/m3ix_claim_job",
                          body={"p_worker": worker, "p_kinds": kinds})
        if not rows:
            return None
        return rows[0] if isinstance(rows, list) else rows

    def finish_job(self, job_id: str, output: dict) -> None:
        self._rest("PATCH", "m3ix_jobs",
                   params={"id": f"eq.{job_id}"},
                   body={"status": "done", "output": output,
                         "finished_at": now_iso(), "error": None},
                   prefer="return=minimal")

    def fail_job(self, job_id: str, error: str) -> None:
        self._rest("PATCH", "m3ix_jobs",
                   params={"id": f"eq.{job_id}"},
                   body={"status": "failed", "error": error[:2000],
                         "finished_at": now_iso()},
                   prefer="return=minimal")

    def refund_once(self, job: dict) -> None:
        """Insert a refund ledger row for this job unless one already exists."""
        job_id = job["id"]
        credits = job.get("credits")
        if not credits or float(credits) <= 0:
            log(f"[{job_id}] no credits recorded on job, skipping refund")
            return
        existing = self._rest("GET", "m3ix_credit_ledger",
                              params={"ref": f"eq.{job_id}", "reason": "eq.refund",
                                      "select": "ref", "limit": "1"})
        if existing:
            log(f"[{job_id}] refund already recorded")
            return
        self._rest("POST", "m3ix_credit_ledger",
                   body={"user_id": job["user_id"], "delta": float(credits),
                         "reason": "refund", "ref": job_id},
                   prefer="return=minimal")
        log(f"[{job_id}] refunded {credits} credits")

    # -- storage -----------------------------------------------------------
    def upload(self, local_path: Path, bucket: str, dest: str, content_type: str) -> str:
        with open(local_path, "rb") as fh:
            r = self.s.post(
                f"{self.url}/storage/v1/object/{bucket}/{dest}",
                headers={"Content-Type": content_type, "x-upsert": "true"},
                data=fh, timeout=UPLOAD_TIMEOUT,
            )
        if not r.ok:
            raise RuntimeError(f"upload {dest} -> {r.status_code}: {r.text[:500]}")
        return f"{self.url}/storage/v1/object/public/{bucket}/{dest}"


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


# ---------------------------------------------------------------------------
# Job input helpers
# ---------------------------------------------------------------------------
def parse_input(job: dict) -> dict:
    """Normalise the job's input jsonb into a plain dict with defaults."""
    inp = job.get("input") or {}
    if isinstance(inp, str):
        inp = json.loads(inp)
    prompt = (inp.get("prompt") or "").strip()
    if not prompt:
        raise ValueError("job has an empty prompt")
    duration = int(inp.get("duration") or 5)
    if duration not in (5, 10):
        duration = 5
    aspect = inp.get("aspect") or "16:9"
    if aspect not in RESOLUTIONS:
        aspect = "16:9"
    return {
        "prompt": prompt,
        "image_url": inp.get("image_url") or None,
        "duration": duration,
        "aspect": aspect,
    }


def frames_for(duration: int) -> int:
    """Wan needs 4k+1 frames. Cap by MAX_FRAMES so small cards survive."""
    n = duration * FRAMES_PER_SECOND_OF_VIDEO + 1
    n = min(n, MAX_FRAMES)
    return ((n - 1) // 4) * 4 + 1


def download_image(url: str, dest_dir: Path):
    """Fetch the conditioning image for image-to-video. Returns a PIL image."""
    from PIL import Image  # PIL ships with diffusers/torchvision
    r = requests.get(url, timeout=HTTP_TIMEOUT)
    r.raise_for_status()
    p = dest_dir / "input_image"
    p.write_bytes(r.content)
    return Image.open(p).convert("RGB")


# ---------------------------------------------------------------------------
# Backends - each exposes render(kind, params, out_dir) -> (path, model_name)
# ---------------------------------------------------------------------------
class MockBackend:
    """No GPU required: sleeps 3 s and writes a tiny placeholder file."""
    name = "mock"

    def gpu_label(self) -> str:
        return "mock"

    def render(self, kind: str, params: dict, out_dir: Path) -> tuple[Path, str]:
        time.sleep(3)
        if kind == "image":
            out = out_dir / "out.png"
            # 1x1 transparent PNG
            out.write_bytes(bytes.fromhex(
                "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489"
                "0000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082"))
        else:
            out = out_dir / "out.mp4"
            # Not a decodable video, just bytes with an MP4 'ftyp' box so the
            # upload/URL/status plumbing can be exercised end to end.
            out.write_bytes(b"\x00\x00\x00\x18ftypisom\x00\x00\x02\x00isomiso2mp41"
                            + b"mock render: " + params["prompt"].encode("utf-8")[:200])
        return out, "mock"


class DiffusersBackend:
    """Wan2.2-TI2V-5B for video (T2V and I2V), FLUX.1-schnell for images.
    Pipelines are loaded on first use and kept in memory."""
    name = "diffusers"

    def __init__(self, model: str) -> None:
        self.model = model
        self._t2v = None
        self._i2v = None
        self._t2i = None

    def gpu_label(self) -> str:
        try:
            import torch
            if torch.cuda.is_available():
                return torch.cuda.get_device_name(0)
        except Exception:
            pass
        return "cpu"

    # -- lazy loaders ------------------------------------------------------
    def _load_video(self, image_to_video: bool):
        import torch
        from diffusers import AutoencoderKLWan, WanImageToVideoPipeline, WanPipeline

        cache = "_i2v" if image_to_video else "_t2v"
        if getattr(self, cache) is not None:
            return getattr(self, cache)
        log(f"loading {self.model} ({'I2V' if image_to_video else 'T2V'}) ...")
        # The Wan2.2 VAE is kept in fp32 for quality; everything else in bf16.
        vae = AutoencoderKLWan.from_pretrained(self.model, subfolder="vae", torch_dtype=torch.float32)
        cls = WanImageToVideoPipeline if image_to_video else WanPipeline
        pipe = cls.from_pretrained(self.model, vae=vae, torch_dtype=torch.bfloat16)
        pipe.enable_model_cpu_offload()   # fits 24 GB; CPU RAM absorbs the rest
        setattr(self, cache, pipe)
        return pipe

    def _load_image(self):
        import torch
        from diffusers import FluxPipeline

        if self._t2i is None:
            log(f"loading {IMAGE_MODEL} ...")
            self._t2i = FluxPipeline.from_pretrained(IMAGE_MODEL, torch_dtype=torch.bfloat16)
            self._t2i.enable_model_cpu_offload()
        return self._t2i

    # -- render ------------------------------------------------------------
    def render(self, kind: str, params: dict, out_dir: Path) -> tuple[Path, str]:
        import torch

        if kind == "image":
            pipe = self._load_image()
            w, h = IMAGE_RESOLUTIONS[params["aspect"]]
            image = pipe(
                params["prompt"], width=w, height=h,
                num_inference_steps=IMAGE_STEPS, guidance_scale=0.0,
                max_sequence_length=256,
            ).images[0]
            out = out_dir / "out.png"
            image.save(out)
            torch.cuda.empty_cache()
            return out, IMAGE_MODEL

        from diffusers.utils import export_to_video

        w, h = RESOLUTIONS[params["aspect"]]
        n_frames = frames_for(params["duration"])
        kwargs = dict(
            prompt=params["prompt"],
            negative_prompt=NEGATIVE_PROMPT,
            height=h, width=w, num_frames=n_frames,
            num_inference_steps=NUM_INFERENCE_STEPS,
            guidance_scale=GUIDANCE_SCALE,
        )
        if params["image_url"]:
            pipe = self._load_video(image_to_video=True)
            img = download_image(params["image_url"], out_dir)
            # Resize to the target grid so the latent shapes line up.
            kwargs["image"] = img.resize((w, h))
        else:
            pipe = self._load_video(image_to_video=False)

        log(f"rendering {n_frames} frames @ {w}x{h}, {NUM_INFERENCE_STEPS} steps")
        frames = pipe(**kwargs).frames[0]
        out = out_dir / "out.mp4"
        export_to_video(frames, str(out), fps=FPS)
        torch.cuda.empty_cache()
        return out, self.model


# Standard Wan negative prompt (from the model card), keeps output clean.
NEGATIVE_PROMPT = (
    "色调艳丽，过曝，静态，细节模糊不清，字幕，风格，作品，画作，画面，静止，整体发灰，"
    "最差质量，低质量，JPEG压缩残留，丑陋的，残缺的，多余的手指，画得不好的手部，画得不好的脸部，"
    "畸形的，毁容的，形态畸形的肢体，手指融合，静止不动的画面，杂乱的背景，三条腿，背景人很多，倒着走"
)


class ComfyBackend:
    """Submit a prompt to a locally running ComfyUI (COMFY_URL) using a saved
    API-format workflow JSON (COMFY_WORKFLOW). The workflow must contain a node
    whose title is 'PROMPT' (CLIPTextEncode) and end in a SaveVideo/SaveImage
    node. This is a thin hook; adapt it to your own workflow."""
    name = "comfy"

    def __init__(self, url: str, workflow_path: str) -> None:
        self.url = url.rstrip("/")
        if not workflow_path or not Path(workflow_path).exists():
            sys.exit("BACKEND=comfy needs COMFY_WORKFLOW pointing at an API-format workflow JSON")
        self.workflow = json.loads(Path(workflow_path).read_text(encoding="utf-8"))

    def gpu_label(self) -> str:
        try:
            r = requests.get(f"{self.url}/system_stats", timeout=5)
            return r.json()["devices"][0]["name"]
        except Exception:
            return "comfy"

    def render(self, kind: str, params: dict, out_dir: Path) -> tuple[Path, str]:
        wf = json.loads(json.dumps(self.workflow))  # deep copy
        for node in wf.values():
            if node.get("_meta", {}).get("title") == "PROMPT":
                node["inputs"]["text"] = params["prompt"]
        r = requests.post(f"{self.url}/prompt", json={"prompt": wf}, timeout=HTTP_TIMEOUT)
        r.raise_for_status()
        pid = r.json()["prompt_id"]
        while True:
            time.sleep(5)
            h = requests.get(f"{self.url}/history/{pid}", timeout=HTTP_TIMEOUT).json()
            if pid in h:
                break
        outputs = h[pid]["outputs"]
        for node_out in outputs.values():
            for key in ("gifs", "videos", "images"):
                for f in node_out.get(key, []):
                    fr = requests.get(f"{self.url}/view",
                                      params={"filename": f["filename"],
                                              "subfolder": f.get("subfolder", ""),
                                              "type": f.get("type", "output")},
                                      timeout=UPLOAD_TIMEOUT)
                    fr.raise_for_status()
                    out = out_dir / ("out.png" if kind == "image" else "out.mp4")
                    out.write_bytes(fr.content)
                    return out, "comfy"
        raise RuntimeError("ComfyUI produced no output file")


def make_backend(cfg: Config):
    if cfg.backend == "mock":
        return MockBackend()
    if cfg.backend == "comfy":
        return ComfyBackend(cfg.comfy_url, cfg.comfy_workflow)
    return DiffusersBackend(cfg.model)


# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------
def process(job: dict, sb: Supabase, backend, cfg: Config) -> None:
    job_id = job["id"]
    kind = job.get("kind") or "video"
    log(f"[{job_id}] claimed ({kind})")
    started = time.time()
    try:
        params = parse_input(job)
        with tempfile.TemporaryDirectory(prefix="m3xi-") as tmp:
            out_path, model_name = backend.render(kind, params, Path(tmp))
            ext = "png" if kind == "image" else "mp4"
            ctype = "image/png" if kind == "image" else "video/mp4"
            url = sb.upload(out_path, "videos", f"local/{job_id}.{ext}", ctype)
        seconds = round(time.time() - started, 1)
        sb.finish_job(job_id, {"url": url, "seconds": seconds, "model": model_name,
                               "worker": cfg.worker_name})
        sb.increment_jobs_done(cfg.worker_name)
        log(f"[{job_id}] done in {seconds}s -> {url}")
    except Exception as e:  # noqa: BLE001 - anything means the job failed
        err = f"{type(e).__name__}: {e}"
        log(f"[{job_id}] FAILED {err}")
        traceback.print_exc()
        try:
            sb.fail_job(job_id, err)
        except Exception as e2:
            log(f"[{job_id}] could not mark failed: {e2}")
        try:
            sb.refund_once(job)
        except Exception as e3:
            log(f"[{job_id}] could not refund: {e3}")


def main() -> None:
    cfg = Config()
    sb = Supabase(cfg)
    backend = make_backend(cfg)
    gpu = cfg.gpu or backend.gpu_label()
    log(f"worker {cfg.worker_name!r} backend={cfg.backend} gpu={gpu!r} kinds={cfg.kinds}")

    running = True

    def stop(*_: Any) -> None:
        nonlocal running
        log("stopping after current job ...")
        running = False

    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)

    last_beat = 0.0
    while running:
        try:
            if time.time() - last_beat >= HEARTBEAT_SECONDS:
                sb.heartbeat(cfg.worker_name, gpu, cfg.kinds)
                last_beat = time.time()
            job = sb.claim_job(cfg.worker_name, cfg.kinds)
            if job:
                process(job, sb, backend, cfg)
                sb.heartbeat(cfg.worker_name, gpu, cfg.kinds)
                last_beat = time.time()
            else:
                time.sleep(IDLE_POLL_SECONDS)
        except requests.RequestException as e:
            # Network hiccup talking to Supabase: back off and retry.
            log(f"network error: {e}; retrying in 15s")
            time.sleep(15)
        except Exception as e:  # noqa: BLE001
            log(f"loop error: {e}")
            traceback.print_exc()
            time.sleep(15)
    log("bye")


if __name__ == "__main__":
    main()
