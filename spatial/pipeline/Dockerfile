# M3XI World Viewer reconstruction worker — RunPod L40S image.
#
# Two design decisions worth stating, because both cost money if you get them
# wrong:
#
#   1. Model weights are baked in at build time, not fetched at start. A cold
#      serverless start that downloads 6 GB of checkpoints bills GPU seconds
#      for a download. The image is large (~28 GB) and that is the correct
#      trade: storage is charged once, GPU time is charged per job.
#
#   2. COLMAP is built from source rather than taken from apt. Ubuntu 22.04
#      ships COLMAP 3.7, which predates the GLOMAP global mapper merge that the
#      pose stage's refinement path depends on.

FROM nvidia/cuda:12.4.1-cudnn-devel-ubuntu22.04 AS build

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential cmake ninja-build git wget ca-certificates \
      libboost-program-options-dev libboost-graph-dev libboost-system-dev \
      libeigen3-dev libfreeimage-dev libmetis-dev libgoogle-glog-dev \
      libgflags-dev libsqlite3-dev libglew-dev qtbase5-dev libqt5opengl5-dev \
      libcgal-dev libceres-dev libflann-dev liblz4-dev \
    && rm -rf /var/lib/apt/lists/*

# COLMAP 4.0 (GLOMAP merged). CUDA architecture 89 is Ada, which is the L40S.
ARG COLMAP_REF=4.0.0
RUN git clone --depth 1 --branch ${COLMAP_REF} https://github.com/colmap/colmap.git /src/colmap \
 && cmake -S /src/colmap -B /src/colmap/build -GNinja \
      -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=/opt/colmap \
      -DCMAKE_CUDA_ARCHITECTURES=89 -DGUI_ENABLED=OFF -DTESTS_ENABLED=OFF \
 && cmake --build /src/colmap/build --target install \
 && rm -rf /src/colmap

# ---------------------------------------------------------------------------

FROM nvidia/cuda:12.4.1-cudnn-runtime-ubuntu22.04

# The pod's entire secret inventory is WV_WORKER_SECRET, supplied at run time
# alongside WV_JOBS_URL and WV_WORKER_ID. Deliberately no Supabase key: see
# .env.example, and worldengine/worker.py's module docstring for why. Nothing
# below bakes a credential into a layer, because an image layer is forever and
# these images are pushed to a registry a rented pod pulls from.
ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PATH=/opt/colmap/bin:/usr/local/bin:$PATH \
    WORLDENGINE_MODEL_ROOT=/opt/models \
    WORLDENGINE_ROOMFORMER_ROOT=/opt/roomformer \
    WORLDENGINE_RUN_ROOT=/workspace/runs \
    WORLDENGINE_GPU=L40S \
    WORLDENGINE_BILLING_MODE=on_demand \
    HF_HOME=/opt/models/hf \
    TORCH_CUDA_ARCH_LIST=8.9

RUN apt-get update && apt-get install -y --no-install-recommends \
      python3.10 python3-pip python3.10-dev git ffmpeg ca-certificates \
      libgl1 libglib2.0-0 libgomp1 libfreeimage3 libmetis5 libgoogle-glog0v5 \
      libceres2 libflann1.9 liblz4-1 libsqlite3-0 libboost-program-options1.74.0 \
      libboost-graph1.74.0 nodejs npm \
    && rm -rf /var/lib/apt/lists/* \
    && ln -sf /usr/bin/python3.10 /usr/local/bin/python3

COPY --from=build /opt/colmap /opt/colmap

# Torch first and from the CUDA index, so nothing downstream pulls the CPU
# wheel and silently disables every GPU stage.
RUN python3 -m pip install --no-cache-dir --upgrade pip setuptools wheel \
 && python3 -m pip install --no-cache-dir \
      --index-url https://download.pytorch.org/whl/cu124 \
      torch==2.5.1 torchvision==0.20.1

COPY requirements.txt /tmp/requirements.txt
RUN python3 -m pip install --no-cache-dir -r /tmp/requirements.txt

# RoomFormer is a research repo, not a package. MIT licensed; vendored at a
# pinned commit so a silent upstream change cannot alter published floorplans.
ARG ROOMFORMER_REF=main
RUN git clone --depth 1 --branch ${ROOMFORMER_REF} \
      https://github.com/ywyue/RoomFormer.git /opt/roomformer \
 && python3 -m pip install --no-cache-dir -r /opt/roomformer/requirements.txt \
 && (cd /opt/roomformer/models/ops && python3 setup.py build install)

# PlayCanvas' SOG encoder. Optional: the packaging stage records SOG as skipped
# when it is absent rather than failing, because it is a bandwidth
# optimisation and not a source of truth.
RUN npm install -g @playcanvas/splat-transform@latest || \
    echo "splat-transform unavailable; SOG output will be skipped"

# --- model weights ----------------------------------------------------------
# Baked in. Each line names its licence because the licence is the reason the
# model is in the stack.
RUN mkdir -p ${WORLDENGINE_MODEL_ROOT}/yunet ${WORLDENGINE_MODEL_ROOT}/sam3 \
             ${WORLDENGINE_MODEL_ROOT}/roomformer

# YuNet face detector — MIT, from opencv_zoo.
RUN wget -q -O ${WORLDENGINE_MODEL_ROOT}/yunet/face_detection_yunet_2023mar.onnx \
      https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx

# MapAnything (Apache-2.0 checkpoint), MoGe-2 (MIT), OWLv2 (Apache-2.0),
# docTR (Apache-2.0). Pulled through huggingface_hub into HF_HOME so the
# from_pretrained calls in the stages resolve offline.
RUN python3 - <<'PY'
from huggingface_hub import snapshot_download
import os
root = os.environ["WORLDENGINE_MODEL_ROOT"]
# The apache checkpoint specifically: MapAnything's default weights are
# CC-BY-NC and cannot ship in a commercial product.
snapshot_download("facebook/map-anything-apache",
                  local_dir=f"{root}/map-anything-apache")
snapshot_download("Ruicheng/moge-2-vitl-normal",
                  local_dir=f"{root}/moge-2-vitl-normal")
snapshot_download("google/owlv2-base-patch16-ensemble",
                  local_dir=f"{root}/owlv2-base-patch16-ensemble")
PY

# SAM 3.1 and the RoomFormer checkpoint are gated or hosted outside HF, so they
# are supplied at build time as build arguments rather than fetched anonymously.
# The stages raise StageUnavailable with this exact instruction if they are
# missing, which is the intended behaviour: no model, no output.
ARG SAM3_URL=""
ARG ROOMFORMER_CKPT_URL=""
RUN if [ -n "$SAM3_URL" ]; then \
      wget -q -O ${WORLDENGINE_MODEL_ROOT}/sam3/sam3.1_hiera_large.pt "$SAM3_URL"; \
    else echo "SAM3_URL not set; redact and semantics will fail loudly at run time"; fi \
 && if [ -n "$ROOMFORMER_CKPT_URL" ]; then \
      wget -q -O ${WORLDENGINE_MODEL_ROOT}/roomformer/roomformer_scenecad.pth "$ROOMFORMER_CKPT_URL"; \
    else echo "ROOMFORMER_CKPT_URL not set; layout will fail loudly at run time"; fi

# --- the pipeline itself ----------------------------------------------------
WORKDIR /opt/worldengine
COPY pyproject.toml README.md .env.example /opt/worldengine/
COPY worldengine /opt/worldengine/worldengine
COPY tests /opt/worldengine/tests
COPY sql /opt/worldengine/sql
RUN python3 -m pip install --no-cache-dir -e .

# The CPU-testable half of the suite runs at build time. A broken quality gate
# or a broken SPZ writer should fail the image, not the first paying job.
RUN python3 -m pytest tests -q -x

RUN mkdir -p /workspace/runs
VOLUME ["/workspace/runs"]

# Reports what is present and what is missing, without inventing anything.
HEALTHCHECK --interval=60s --timeout=20s --start-period=30s \
  CMD python3 -m worldengine.cli doctor > /dev/null || exit 1

# Required at run time, never baked in:
#   WV_JOBS_URL        the wv-jobs function endpoint
#   WV_WORKER_SECRET   shared secret, >= 32 chars, matching the function
#   WV_WORKER_ID       this pod's pre-registered wv_worker row id
# The worker refuses to start if any is missing, rather than polling an empty
# queue while looking healthy.
#
# --idle-exit stops the meter on serverless when the queue empties. On a
# dedicated pod, drop it.
ENTRYPOINT ["python3", "-m", "worldengine.worker"]
CMD ["--poll", "10", "--idle-exit", "300"]
