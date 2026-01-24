#!/usr/bin/env python
# -*- coding: utf-8 -*-

import os
import datetime
import random
from pathlib import Path

import numpy as np
import torch
from ultralytics import YOLO


# =========================================================
# CONFIGURACIÓN GENERAL
# =========================================================

os.environ["PYTORCH_CUDA_ALLOC_CONF"] = "expandable_segments:True"
os.environ["YOLO_LOGGING"] = "tensorboard" 

MODEL_NAME = "yolo12m.pt"
DATA_YAML = "data_yolo/data.yaml"

PROJECT = "general_birds_tfg"
RUN_NAME = "yolo12m_test1_dobleetapa"

SEED = 42

# -------- ETAPA A (generalización) --------
IMG_SIZE_A = 640
EPOCHS_A = 220
BATCH_A = 12
MULTISCALE_A = True

# -------- ETAPA B (fine-tune precisión) ---
IMG_SIZE_B = 768
EPOCHS_B = 120
BATCH_B = 6
MULTISCALE_B = False

VAL_BATCH = 4
CACHE_DATASET = "disk"
FINAL_EVAL_TTA = True


# =========================================================
# LOGGING
# =========================================================

os.makedirs("logs", exist_ok=True)
timestamp = datetime.datetime.now().strftime("%Y%m%d_%H%M")
LOG_PATH = f"logs/train_{timestamp}.log"
log_file = open(LOG_PATH, "w", encoding="utf-8")


def log(msg: str):
    print(msg)
    log_file.write(msg + "\n")
    log_file.flush()


# =========================================================
# UTILIDADES
# =========================================================

def seed_everything(seed):
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    torch.cuda.manual_seed_all(seed)
    torch.backends.cudnn.benchmark = True


def detect_device_and_workers():
    if torch.cuda.is_available():
        device = 0
        log(f"GPU: {torch.cuda.get_device_name(0)}")
    else:
        device = "cpu"
        log(" CPU (muy lento)")

    workers = min(16, (os.cpu_count() or 8) // 2)
    log(f"Workers: {workers}")
    return device, workers


def clear_cuda():
    if torch.cuda.is_available():
        torch.cuda.empty_cache()


def train_with_backoff(model, kwargs, batches):
    for b in batches:
        try:
            clear_cuda()
            log(f"Intentando batch={b}")
            k = dict(kwargs)
            k["batch"] = b
            metrics = model.train(**k)
            return metrics, b
        except RuntimeError as e:
            if "out of memory" in str(e).lower():
                log("OOM → reduciendo batch")
                continue
            raise
    raise RuntimeError("No se pudo entrenar por OOM")


# =========================================================
# ETAPA A — GENERALIZACIÓN
# =========================================================

def stage_a(device, workers):
    log("\n=== ETAPA A: GENERALIZACIÓN ===")

    model = YOLO(MODEL_NAME)

    train_kwargs = dict(
        data=DATA_YAML,
        epochs=EPOCHS_A,
        imgsz=IMG_SIZE_A,
        device=device,

        optimizer="auto", 
        cos_lr=True,
        patience=45,

        box=7.0,
        cls=1.2,
        dfl=1.6,
        label_smoothing=0.06,

        hsv_h=0.012,
        hsv_s=0.55,
        hsv_v=0.25,
        translate=0.10,
        scale=0.25,
        fliplr=0.15,
        mosaic=0.40,
        mixup=0.0,
        close_mosaic=15,

        amp=True,
        multi_scale=MULTISCALE_A,
        cache=CACHE_DATASET,
        workers=workers,
        seed=SEED,

        project=PROJECT,
        name=RUN_NAME + "_A",
        save=True,
        plots=True,
        val=True,
        save_json=True,
    )

    metrics, used_batch = train_with_backoff(
        model, train_kwargs, [BATCH_A, 10, 8, 6, 4, 2]
    )

    save_dir = Path(metrics.save_dir)
    best = save_dir / "weights/best.pt"

    log(f"ETAPA A finalizada | batch={used_batch}")
    log(f"best.pt: {best}")
    return best


# =========================================================
# ETAPA B — FINE TUNE (SGD)
# =========================================================

def stage_b(best_a, device, workers):
    log("\n=== ETAPA B: FINE-TUNE (SGD) ===")

    model = YOLO(str(best_a))

    train_kwargs = dict(
        data=DATA_YAML,
        epochs=EPOCHS_B,
        imgsz=IMG_SIZE_B,
        device=device,

        optimizer="SGD",
        lr0=0.002,
        momentum=0.9,
        weight_decay=0.0005,
        cos_lr=True,
        patience=25,

        box=7.5,
        cls=1.25,
        dfl=1.7,
        label_smoothing=0.01,

        hsv_h=0.005,
        hsv_s=0.15,
        hsv_v=0.10,
        translate=0.02,
        scale=0.05,
        fliplr=0.05,
        mosaic=0.0,

        amp=True,
        multi_scale=MULTISCALE_B,
        cache=CACHE_DATASET,
        workers=workers,
        seed=SEED,

        project=PROJECT,
        name=RUN_NAME + "_B",
        save=True,
        plots=True,
        val=True,
        save_json=True,
    )

    metrics, used_batch = train_with_backoff(
        model, train_kwargs, [BATCH_B, 5, 4, 3, 2, 1]
    )

    save_dir = Path(metrics.save_dir)
    best = save_dir / "weights/best.pt"

    log(f"ETAPA B finalizada | batch={used_batch}")
    log(f"best.pt FINAL: {best}")
    return best


# =========================================================
# EVALUACIÓN FINAL
# =========================================================

def final_eval(weights, device):
    log("\n=== EVALUACIÓN FINAL ===")

    model = YOLO(str(weights))

    m = model.val(
        data=DATA_YAML,
        imgsz=IMG_SIZE_B,
        batch=VAL_BATCH,
        device=device,
        split="val",
        plots=True,
        save_json=True,
        augment=False,
    )

    log(f"mAP50: {m.box.map50:.4f}")
    log(f"mAP50-95: {m.box.map:.4f}")

    if FINAL_EVAL_TTA:
        m_tta = model.val(
            data=DATA_YAML,
            imgsz=IMG_SIZE_B,
            batch=VAL_BATCH,
            device=device,
            split="val",
            augment=True,
        )
        log(f"[TTA] mAP50: {m_tta.box.map50:.4f}")
        log(f"[TTA] mAP50-95: {m_tta.box.map:.4f}")


# =========================================================
# MAIN
# =========================================================

if __name__ == "__main__":
    try:
        seed_everything(SEED)
        device, workers = detect_device_and_workers()

        log("=== YOLO12m MANY-CLASSES FINAL ===")
        log(f"LOG: {LOG_PATH}")

        best_a = stage_a(device, workers)
        best_final = stage_b(best_a, device, workers)
        final_eval(best_final, device)

        log("\n ENTRENAMIENTO COMPLETADO")
        log(f"MODELO FINAL: {best_final}")

    except Exception as e:
        log(" ERROR:")
        log(str(e))
        raise
    finally:
        log_file.close()
