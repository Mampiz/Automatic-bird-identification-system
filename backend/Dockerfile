FROM python:3.11-slim

# ---------------- System deps ----------------
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    libx264-dev \
    libgl1 \
    libglib2.0-0 \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# ---------------- Python deps ----------------
# torch is installed before requirements.txt so that ultralytics finds it
# already satisfied and does not pull its own.
#
# On x86_64 the default PyPI wheel drags in the NVIDIA CUDA runtime as
# dependencies: roughly 2.5 GB of image for a server that has no GPU. The CPU
# index avoids that. On aarch64 there is no CUDA build at all, so PyPI is already
# CPU-only and the index would just fail to resolve.
COPY requirements.txt /app/requirements.txt
RUN if [ "$(uname -m)" = "x86_64" ]; then \
        pip install --no-cache-dir torch torchvision \
            --index-url https://download.pytorch.org/whl/cpu; \
    fi && \
    pip install --no-cache-dir -r requirements.txt

# ---------------- App code ----------------
COPY . /app

# Written to at runtime; a bind mount or volume should back this in production
# so results survive a redeploy.
RUN mkdir -p /app/outputs

ENV YOLO_CONFIG_DIR=/tmp/Ultralytics
ENV PYTHONUNBUFFERED=1

EXPOSE 8000

# Liveness only: /health checks nothing external on purpose, so a database
# hiccup cannot restart a process that is working.
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
    CMD curl -fsS http://localhost:8000/health || exit 1

# ---------------- Run ----------------
# One worker: the model is held in process memory and the job queue lives in
# process too, so a second worker would double the memory and split the queue.
CMD ["gunicorn", "-k", "uvicorn.workers.UvicornWorker", "main:app", "--bind", "0.0.0.0:8000", "--workers", "1", "--timeout", "900"]
