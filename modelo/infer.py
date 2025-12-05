#!/usr/bin/env python
import os
from ultralytics import YOLO

RUN_NAME = "yolo12l_final_768"
BEST_WEIGHTS = f"yolo_birds_tfg/{RUN_NAME}/weights/best.pt"
SOURCE = "data_yolo/images/test" 

IMG_SIZE = 768
CONF = 0.25

def main():
    if not os.path.exists(BEST_WEIGHTS):
        raise FileNotFoundError(f"No se encuentra {BEST_WEIGHTS}")

    print("Cargando modelo:", BEST_WEIGHTS)
    model = YOLO(BEST_WEIGHTS)

    print(f"Haciendo predicciones sobre: {SOURCE}")
    results = model.predict(
        source=SOURCE,
        conf=CONF,
        imgsz=IMG_SIZE,
        save=True,
        max_det=50
    )
    print("Detecciones guardadas en 'runs/detect/*'")

if __name__ == "__main__":
    main()
