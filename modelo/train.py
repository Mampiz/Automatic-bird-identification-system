#!/usr/bin/env python
# -*- coding: utf-8 -*-

import os
import datetime
import random
import numpy as np
import torch
from pathlib import Path
from ultralytics import YOLO

# =========================================================
# CONFIGURACIÓN GENERAL
# =========================================================

MODEL_NAME = "yolo12m.pt"
DATA_YAML = "data_yolo/birds.yaml"

PROJECT = "yolo_birds_tfg"
RUN_NAME = "yolo12m_destructor_leosingador"

IMG_SIZE = 768           # Resolución base (ajustable según VRAM)
EPOCHS = 200
BATCH = 6                # Ajustar según GPU
SEED = 42

# Flags configurables (NO dependen del tamaño del dataset)
AUG_ONLINE = False        # False si el dataset ya viene augmentado offline
USE_MULTI_SCALE = False
CLOSE_MOSAIC_EPOCHS = 20
CACHE_DATASET = False   # True / "ram" si el dataset cabe en RAM

# =========================================================
# LOGGING
# =========================================================

LOG_DIR = "logs"
os.makedirs(LOG_DIR, exist_ok=True)
timestamp = datetime.datetime.now().strftime("%Y%m%d_%H%M")
log_path = os.path.join(LOG_DIR, f"train_{timestamp}.log")
log_file = open(log_path, "w")


def log(msg: str):
    print(msg)
    log_file.write(msg + "\n")
    log_file.flush()


# =========================================================
# UTILIDADES
# =========================================================

def seed_everything(seed: int):
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    torch.cuda.manual_seed_all(seed)
    torch.backends.cudnn.benchmark = True
    torch.backends.cudnn.deterministic = False


def detect_device_and_workers():
    if torch.cuda.is_available():
        device = 0
        log(f"GPU detectada: {torch.cuda.get_device_name(0)}")
    else:
        device = "cpu"
        log("GPU no detectada, usando CPU")

    cpu_count = os.cpu_count() or 8
    workers = max(4, min(16, cpu_count // 2))
    log(f"Workers dataloader: {workers}")

    return device, workers


# =========================================================
# ENTRENAMIENTO
# =========================================================

def train_model():
    seed_everything(SEED)
    device, workers = detect_device_and_workers()

    log("=======================================")
    log(" ENTRENAMIENTO YOLO12M - DETECCIÓN AVES ")
    log("=======================================")
    log(f"Modelo base: {MODEL_NAME}")
    log(f"IMG_SIZE:    {IMG_SIZE}")
    log(f"EPOCHS:      {EPOCHS}")
    log(f"BATCH:       {BATCH}")
    log(f"AUG_ONLINE:  {AUG_ONLINE}")
    log(f"Proyecto:    {PROJECT}/{RUN_NAME}")
    log("=======================================\n")

    model = YOLO(MODEL_NAME)

    train_metrics = model.train(
        data=DATA_YAML,
        epochs=EPOCHS,
        imgsz=IMG_SIZE,
        batch=BATCH,
        device=device,

        # -------------------- OPTIMIZADOR --------------------
        optimizer="AdamW",
        lr0=5e-4,                
        lrf=0.01,
        momentum=0.9,
        weight_decay=0.01,

        warmup_epochs=5,
        warmup_momentum=0.8,
        warmup_bias_lr=0.05,

        cos_lr=True,
        patience=25,

        # -------------------- LOSS (small objects) --------------------
        box=7.0,
        cls=0.8,
        dfl=1.5,
        label_smoothing=0.05,


        # -------------------- ROBUSTEZ --------------------
        amp=True,                     
        multi_scale=USE_MULTI_SCALE, 
        cache=CACHE_DATASET,

        # -------------------- LOGS / OUTPUT --------------------
        workers=workers,
        project=PROJECT,
        name=RUN_NAME,
        exist_ok=True,
        seed=SEED,
        verbose=True,
        save=True,
        save_period=25,
        plots=True,
        val=True,
        save_json=True,
    )

    save_dir = getattr(train_metrics, "save_dir", None)
    if save_dir:
        log(f"\nResultados guardados en: {save_dir}")
        log(f"Pesos: {Path(save_dir) / 'weights'}")

    log("\n==== ENTRENAMIENTO FINALIZADO ====")


# =========================================================
# MAIN
# =========================================================

if __name__ == "__main__":
    try:
        train_model()
    except Exception as e:
        log("\nERROR DURANTE EL ENTRENAMIENTO:")
        log(str(e))
        raise
    finally:
        log_file.close()
