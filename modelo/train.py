#!/usr/bin/env python
import os
import sys
import datetime
import json
from ultralytics import YOLO

MODEL_NAME = "yolo12m.pt"  
IMG_SIZE = 768              
EPOCHS = 150
BATCH = -1                  

PROJECT = "yolo_birds_tfg"
RUN_NAME = "yolo12m_final_768"

DATA_YAML = "data_yolo/birds.yaml"

os.makedirs("logs", exist_ok=True)

timestamp = datetime.datetime.now().strftime("%Y%m%d_%H%M")
log_path = f"logs/train_{timestamp}.log"

log_file = open(log_path, "w")

def log(msg):
    print(msg)
    log_file.write(msg + "\n")
    log_file.flush()

log("=======================================")
log("   ENTRENAMIENTO YOLO12 - INICIADO")
log("=======================================")
log(f"Modelo:   {MODEL_NAME}")
log(f"Imagen:   {IMG_SIZE}")
log(f"Épocas:   {EPOCHS}")
log(f"Batch:    {BATCH}")
log(f"Proyecto: {PROJECT}/{RUN_NAME}")
log(f"Log file: {log_path}")
log("=======================================\n")

try:
    model = YOLO(MODEL_NAME)
    log("Modelo cargado correctamente.")

    results = model.train(
        data=DATA_YAML,
        epochs=EPOCHS,
        imgsz=IMG_SIZE,
        batch=BATCH,
        patience=25,
        cos_lr=True,
        hsv_h=0.015,
        hsv_s=0.7,
        hsv_v=0.4,
        degrees=7.0,
        translate=0.10,
        scale=0.5,
        shear=2.0,
        flipud=0.0,
        fliplr=0.5,
        mosaic=0.8,
        mixup=0.2,
        project=PROJECT,
        name=RUN_NAME,
        verbose=True,
    )

    log("\n==== ENTRENAMIENTO COMPLETADO ====")
    log(f"Pesos guardados en: {PROJECT}/{RUN_NAME}/weights/")
    log("===================================")

except Exception as e:
    log("\nERROR DURANTE EL ENTRENAMIENTO:")
    log(str(e))
    raise

finally:
    log_file.close()
