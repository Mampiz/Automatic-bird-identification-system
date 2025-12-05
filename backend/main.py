from fastapi import FastAPI, File, UploadFile, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
import uvicorn
import numpy as np
from PIL import Image
import io
import os
import tempfile
import base64

import cv2
from ultralytics import YOLO

# ---- Configuración FastAPI ----
app = FastAPI()

# CORS: permite peticiones desde el frontend React
origins = [
    "http://localhost:5173",  # React en local (Vite)
    # añade aquí tu dominio si despliegas en otro sitio
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # en desarrollo, dejar "*"; en producción, restringir
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---- Cargar modelo YOLO al iniciar ----
MODEL_PATH = "yolo_birds_best_single.pt"  # ajusta si el nombre es distinto

print("Cargando modelo YOLO...")
model = YOLO(MODEL_PATH)
print("Modelo YOLO cargado.")

# Valores por defecto (por si no vienen del frontend)
DEFAULT_MIN_CONF = 0.25
DEFAULT_FRAME_STRIDE = 5


# ---- Endpoint de prueba ----
@app.get("/")
def read_root():
    return {"message": "API de detección de aves funcionando 🐦"}


# ---- Endpoint de predicción en imagen ----
@app.post("/predict")
async def predict(
    file: UploadFile = File(...),
    conf: float = Form(DEFAULT_MIN_CONF),
):
    """
    Recibe una imagen, ejecuta YOLO y devuelve:
    - tamaño de la imagen
    - lista de detecciones con bbox y bbox_norm
    """
    try:
        # Leer bytes de la imagen
        contents = await file.read()

        # Abrir imagen con PIL
        img = Image.open(io.BytesIO(contents)).convert("RGB")
        width, height = img.size

        # Convertir a array para YOLO (RGB)
        img_np = np.array(img)

        # Inferencia con YOLO
        results = model.predict(
            source=img_np,
            conf=conf,
            imgsz=640,
            verbose=False
        )

        r = results[0]
        boxes = r.boxes
        names = r.names  # diccionario id -> nombre de clase

        detections = []

        if boxes is not None and len(boxes) > 0:
            for box in boxes:
                # xyxy en píxeles
                x1, y1, x2, y2 = box.xyxy[0].tolist()
                cls_id = int(box.cls[0])
                c = float(box.conf[0])

                # Normalizar 0-1 para usar en el frontend fácilmente
                x1_n = x1 / width
                y1_n = y1 / height
                x2_n = x2 / width
                y2_n = y2 / height

                detections.append({
                    "class": names.get(cls_id, f"class_{cls_id}"),
                    "confidence": c,
                    "bbox": [x1, y1, x2, y2],
                    "bbox_norm": [x1_n, y1_n, x2_n, y2_n]
                })

        response = {
            "width": width,
            "height": height,
            "num_detections": len(detections),
            "detections": detections,
        }

        return JSONResponse(content=response)

    except Exception as e:
        return JSONResponse(
            status_code=500,
            content={"error": str(e)},
        )


# ---- Endpoint de predicción en vídeo ----
@app.post("/predict_video")
async def predict_video(
    file: UploadFile = File(...),
    conf: float = Form(DEFAULT_MIN_CONF),
    stride: int = Form(DEFAULT_FRAME_STRIDE)
):
    """
    Recibe un vídeo, analiza frames cada `stride`, y devuelve:
    - info del vídeo
    - detecciones por frame (detections_per_frame)
    - segmentos de tiempo donde hay aves (segments)
    - key_frames: primeros frames representativos por combinación de aves,
      incluyendo una imagen anotada (base64) para cada uno.
    """
    tmp_path = None
    try:
        # Guardar vídeo temporalmente en disco
        contents = await file.read()
        suffix = os.path.splitext(file.filename or "")[1] or ".mp4"

        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
            tmp.write(contents)
            tmp_path = tmp.name

        cap = cv2.VideoCapture(tmp_path)
        if not cap.isOpened():
            raise RuntimeError("No se ha podido abrir el vídeo.")

        fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
        frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
        width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

        detections_per_frame = []
        frame_idx = -1

        # Firma para agrupar frames con las mismas aves
        def frame_signature(frame_dets):
            classes = [d["class"] for d in frame_dets]
            return tuple(sorted(classes))

        seen_signatures = set()
        key_frames = []

        while True:
            ret, frame = cap.read()
            if not ret:
                break
            frame_idx += 1

            # Saltar frames según stride
            if frame_idx % stride != 0:
                continue

            # Inferencia en el frame (OpenCV da BGR, YOLO lo soporta)
            results = model.predict(
                source=frame,
                conf=conf,
                imgsz=640,
                verbose=False
            )
            r = results[0]
            boxes = r.boxes
            names = r.names

            if boxes is None or len(boxes) == 0:
                continue

            frame_dets = []
            for box in boxes:
                x1, y1, x2, y2 = box.xyxy[0].tolist()
                cls_id = int(box.cls[0])
                c = float(box.conf[0])

                x1_n = x1 / width
                y1_n = y1 / height
                x2_n = x2 / width
                y2_n = y2 / height

                frame_dets.append({
                    "class": names.get(cls_id, f"class_{cls_id}"),
                    "confidence": c,
                    "bbox": [x1, y1, x2, y2],
                    "bbox_norm": [x1_n, y1_n, x2_n, y2_n]
                })

            time_sec = frame_idx / fps if fps > 0 else None

            frame_info = {
                "frame_index": frame_idx,
                "time": time_sec,
                "detections": frame_dets,
            }
            detections_per_frame.append(frame_info)

            # Selección de key frames
            sig = frame_signature(frame_dets)
            if sig not in seen_signatures:
                seen_signatures.add(sig)

                annotated = frame.copy()
                for det in frame_dets:
                    x1, y1, x2, y2 = det["bbox"]
                    cv2.rectangle(
                        annotated,
                        (int(x1), int(y1)),
                        (int(x2), int(y2)),
                        (0, 255, 0),
                        2
                    )
                    cv2.putText(
                        annotated,
                        det["class"],
                        (int(x1), int(max(0, y1 - 10))),
                        cv2.FONT_HERSHEY_SIMPLEX,
                        0.5,
                        (0, 255, 0),
                        1,
                        cv2.LINE_AA
                    )

                ok, buffer = cv2.imencode(".jpg", annotated)
                if ok:
                    img_b64 = base64.b64encode(buffer.tobytes()).decode("utf-8")
                else:
                    img_b64 = None

                key_frames.append({
                    "frame_index": frame_idx,
                    "time": time_sec,
                    "detections": frame_dets,
                    "image_b64": img_b64,
                })

        cap.release()

        # Construir segmentos de tiempo donde hay detecciones
        segments = []
        if detections_per_frame:
            current_start_frame = detections_per_frame[0]["frame_index"]
            current_end_frame = detections_per_frame[0]["frame_index"]

            for item in detections_per_frame[1:]:
                fi = item["frame_index"]
                # Si este frame sigue justo después del anterior (considerando stride)
                if fi == current_end_frame + stride:
                    current_end_frame = fi
                else:
                    start_time = current_start_frame / fps if fps > 0 else None
                    end_time = current_end_frame / fps if fps > 0 else None
                    segments.append({
                        "start_frame": current_start_frame,
                        "end_frame": current_end_frame,
                        "start_time": start_time,
                        "end_time": end_time
                    })
                    current_start_frame = current_end_frame = fi

            # Añadir último segmento
            start_time = current_start_frame / fps if fps > 0 else None
            end_time = current_end_frame / fps if fps > 0 else None
            segments.append({
                "start_frame": current_start_frame,
                "end_frame": current_end_frame,
                "start_time": start_time,
                "end_time": end_time
            })

        response = {
            "video_info": {
                "fps": fps,
                "frame_count": frame_count,
                "width": width,
                "height": height,
                "frame_stride": stride,
                "conf_used": conf,
            },
            "num_frames_with_detections": len(detections_per_frame),
            "segments": segments,
            "detections_per_frame": detections_per_frame,
            "key_frames": key_frames,
        }

        return JSONResponse(content=response)

    except Exception as e:
        return JSONResponse(
            status_code=500,
            content={"error": str(e)},
        )
    finally:
        if tmp_path and os.path.exists(tmp_path):
            os.remove(tmp_path)


if __name__ == "__main__":
    # Asegúrate de que este archivo se llame main.py o ajusta "main:app"
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
