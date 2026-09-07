# m3xi local worker

A render box for the Studio. It sits on a PC with an NVIDIA GPU, watches the
Studio's job queue in Supabase, renders queued videos and images with
open-weight models (Wan2.2 for video, FLUX.1-schnell for images), uploads the
result, and marks the job done. Those jobs then cost electricity instead of
provider fees. If a render fails, the job is marked failed and the user's
credits are refunded automatically.

Everything is in one file: `worker.py`.

## Install (Windows, NVIDIA GPU)

1. Install Python 3.10+ (or Miniconda) and a current NVIDIA driver.
2. Open a terminal in this folder and create an environment:
   ```
   python -m venv .venv
   .venv\Scripts\activate
   ```
   (conda: `conda create -n m3xi python=3.11 && conda activate m3xi`)
3. Install PyTorch with CUDA first, then the rest:
   ```
   pip install torch torchvision --index-url https://download.pytorch.org/whl/cu124
   pip install -r requirements.txt
   ```
4. Copy `.env.example` to `.env` and fill in the two Supabase values from the
   dashboard (Project Settings -> API): the project URL and the
   **service_role** key.
5. Run it:
   ```
   python worker.py
   ```
   The first video job downloads the model (about 20 GB) into the Hugging Face
   cache; after that it starts in seconds. Leave the window open; Ctrl+C stops
   it after the current job.

## Test without a GPU

Set `BACKEND=mock` in `.env` (or `set BACKEND=mock` before running). The
worker then claims real jobs, waits 3 seconds, uploads a placeholder file and
marks the job done, so you can check the whole path from the Studio to the
`videos` bucket without rendering anything. Do not leave a mock worker running
against the live queue: it will "finish" real customer jobs with junk.

## VRAM guidance

- Wan2.2 TI2V 5B at full settings (1280x704, 81 frames, 30 steps) wants about
  24 GB of VRAM (RTX 3090 / 4090). CPU offload is on, so 32 GB+ of system RAM
  helps too.
- For 12-16 GB cards open the top of `worker.py` and lower `MAX_FRAMES`
  (81 -> 49 or 33) and the `RESOLUTIONS` (e.g. 832x480 / 480x832 / 640x640).
  Shorter clips at lower resolution will render; 10 s jobs are capped at
  `MAX_FRAMES` anyway.
- A 5 s clip takes a few minutes on a 4090, longer on smaller cards.
- Images (FLUX.1-schnell) need about 12 GB with offload.

## Other backends

- `BACKEND=comfy` sends the prompt to a running ComfyUI (`COMFY_URL`) using an
  API-format workflow JSON (`COMFY_WORKFLOW`) whose prompt node is titled
  `PROMPT`. Useful if you already have a tuned ComfyUI setup.

## Secrets

The service_role key bypasses every security rule in the database. It lives
only in `worker/.env`, which is listed in the repo's `.gitignore`. Never paste
it into code, commits, screenshots or chat. If it leaks, rotate it in the
Supabase dashboard.
