FROM python:3.11-slim

# ---------------- System deps ----------------
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    libx264-dev \
    libgl1 \
    libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# ---------------- Python deps ----------------
COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

# ---------------- App code ----------------
COPY . /app

# Outputs dir (solo local/dev; en AWS será S3)
RUN mkdir -p /app/outputs

# Evita warnings de Ultralytics
ENV YOLO_CONFIG_DIR=/tmp/Ultralytics
ENV PYTHONUNBUFFERED=1

EXPOSE 8000


# ---------------- Run ----------------
CMD ["gunicorn", "-k", "uvicorn.workers.UvicornWorker", "main:app", "--bind", "0.0.0.0:8000", "--workers", "1", "--timeout", "900"]
