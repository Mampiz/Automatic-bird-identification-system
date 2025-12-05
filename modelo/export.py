#!/usr/bin/env python
import os
from ultralytics import YOLO

RUN_NAME = "yolo12l_final_768" 
BEST_WEIGHTS = f"yolo_birds_tfg/{RUN_NAME}/weights/best.pt"

def main():
    if not os.path.exists(BEST_WEIGHTS):
        raise FileNotFoundError(f"No se encuentra {BEST_WEIGHTS}")

    print("Cargando modelo:", BEST_WEIGHTS)
    model = YOLO(BEST_WEIGHTS)

    print("Exportando a ONNX...")
    onnx_path = model.export(format="onnx")
    print("Modelo ONNX guardado en:", onnx_path)

    print("\nEl modelo PyTorch (para FastAPI, etc.) está en:")
    print(BEST_WEIGHTS)

if __name__ == "__main__":
    main()
