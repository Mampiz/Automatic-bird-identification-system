from fastapi import FastAPI, File, UploadFile, Form, HTTPException, Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, FileResponse
from pydantic import conint, confloat
from sqlalchemy.orm import Session

import os
import time
import json
import hashlib
import tempfile
import threading
import subprocess
from datetime import datetime

import cv2
from ultralytics import YOLO
from dotenv import load_dotenv
load_dotenv()

from db import Base, engine, get_db
from models import User, Analysis, Post
from auth import hash_password, verify_password, create_access_token, get_current_user


# DB init 
Base.metadata.create_all(bind=engine)


# FastAPI + CORS
app = FastAPI()

FRONTEND_ORIGIN = "http://localhost:5173"
app.add_middleware(
    CORSMiddleware,
    allow_origins=[FRONTEND_ORIGIN],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


# Modelo YOLO
MODEL_PATH = "best.pt"
print("Cargando modelo YOLO...")
model = YOLO(MODEL_PATH)
print("Modelo YOLO cargado.")

DEFAULT_MIN_CONF = 0.25
DEFAULT_FRAME_STRIDE = 5

# Límites
MAX_UPLOAD_MB = 300
MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024
MAX_DURATION_SECONDS = 15 * 60
MAX_OUTPUT_WIDTH = 1280
MAX_OUTPUT_HEIGHT = 720

SEGMENT_GAP_SECONDS = 1.0
TTL_MULT = 2  # TTL de cajas = TTL_MULT * stride

# Outputs
OUTPUT_DIR = os.path.abspath("./outputs")
os.makedirs(OUTPUT_DIR, exist_ok=True)
OUTPUT_TTL_SECONDS = 24 * 60 * 60  # 24h

# Jobs in-memory: job_id(hash) -> dict(state, progress, message, user_id, result/error)
jobs = {}
jobs_lock = threading.Lock()



# Helpers
def _cleanup_old_outputs():
    now = time.time()
    try:
        for name in os.listdir(OUTPUT_DIR):
            path = os.path.join(OUTPUT_DIR, name)
            try:
                st = os.stat(path)
                if now - st.st_mtime > OUTPUT_TTL_SECONDS and os.path.isfile(path):
                    os.remove(path)
            except:
                pass
    except:
        pass


def _safe_suffix(filename: str) -> str:
    ext = os.path.splitext(filename or "")[1].lower()
    return ext if ext else ".mp4"


async def _stream_upload_to_tempfile_and_hash(file: UploadFile) -> tuple[str, str, int]:
    suffix = _safe_suffix(file.filename or "")
    h = hashlib.sha256()
    total = 0

    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        while True:
            chunk = await file.read(1024 * 1024)
            if not chunk:
                break
            total += len(chunk)
            if total > MAX_UPLOAD_BYTES:
                try:
                    os.remove(tmp.name)
                except:
                    pass
                raise HTTPException(status_code=413, detail=f"Archivo demasiado grande. Máximo {MAX_UPLOAD_MB}MB.")
            h.update(chunk)
            tmp.write(chunk)
        return tmp.name, h.hexdigest(), total


def _species_color(species: str) -> tuple[int, int, int]:
    digest = hashlib.md5(species.encode("utf-8")).digest()
    b = 80 + digest[0] % 176
    g = 80 + digest[1] % 176
    r = 80 + digest[2] % 176
    return int(b), int(g), int(r)


def _segments_from_times(times: list[float], gap_s: float) -> list[dict]:
    if not times:
        return []
    times = sorted(times)
    segs = []
    start = times[0]
    last = times[0]
    for t in times[1:]:
        if (t - last) <= gap_s:
            last = t
        else:
            segs.append({"start_time": start, "end_time": last})
            start = last = t
    segs.append({"start_time": start, "end_time": last})
    return segs


def _job_update(job_id: str, **kwargs):
    with jobs_lock:
        j = jobs.get(job_id)
        if not j:
            return
        j.update(kwargs)
        j["updated_at"] = time.time()



# Auth endpoints
@app.post("/auth/register")
def register(email: str = Form(...), password: str = Form(...), db: Session = Depends(get_db)):
    email = email.strip().lower()
    if len(password) < 6:
        raise HTTPException(status_code=400, detail="Password demasiado corto (mínimo 6).")

    exists = db.query(User).filter(User.email == email).first()
    if exists:
        raise HTTPException(status_code=409, detail="Email ya registrado.")

    u = User(email=email, password_hash=hash_password(password))
    db.add(u)
    db.commit()
    db.refresh(u)

    return {"ok": True}


@app.post("/auth/login")
def login(email: str = Form(...), password: str = Form(...), db: Session = Depends(get_db)):
    email = email.strip().lower()
    user = db.query(User).filter(User.email == email).first()
    if not user or not verify_password(password, user.password_hash):
        raise HTTPException(status_code=401, detail="Credenciales incorrectas.")

    token = create_access_token(user.id)
    return {"access_token": token, "token_type": "bearer"}


@app.get("/auth/me")
def me(current: User = Depends(get_current_user)):
    return {"id": current.id, "email": current.email}


@app.get("/videos/{video_id}.mp4")
def get_video(video_id: str, db: Session = Depends(get_db), current: User = Depends(get_current_user)):
    _cleanup_old_outputs()

    # Check ownership (user must have an analysis referencing this video_id)
    owns = db.query(Analysis).filter(Analysis.user_id == current.id, Analysis.video_id == video_id).first()
    if not owns:
        raise HTTPException(status_code=403, detail="No autorizado para este vídeo.")

    path = os.path.join(OUTPUT_DIR, f"{video_id}.mp4")
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail="Vídeo no encontrado o expirado.")
    return FileResponse(path, media_type="video/mp4", filename="video_annotated.mp4")


@app.get("/status/{job_id}")
def get_status(job_id: str, current: User = Depends(get_current_user)):
    with jobs_lock:
        j = jobs.get(job_id)
        if not j:
            raise HTTPException(status_code=404, detail="Job no encontrado.")
        if j.get("user_id") != current.id:
            raise HTTPException(status_code=403, detail="No autorizado.")
        return {
            "job_id": job_id,
            "state": j["state"],
            "progress": j.get("progress", 0.0),
            "message": j.get("message", ""),
            "result": j.get("result"),
            "error": j.get("error"),
        }



# MAIN endpoint
@app.post("/predict_video_annotated")
async def predict_video_annotated(
    file: UploadFile = File(...),
    conf: confloat(ge=0.0, le=1.0) = Form(DEFAULT_MIN_CONF),
    stride: conint(ge=1, le=60) = Form(DEFAULT_FRAME_STRIDE),
    db: Session = Depends(get_db),
    current: User = Depends(get_current_user),
):
    _cleanup_old_outputs()

    tmp_path, sha256_hex, size_bytes = await _stream_upload_to_tempfile_and_hash(file)
    job_id = sha256_hex  # cache key global

    # Si ya existe el mp4+json cacheados, solo crea "Analysis" para este user y listo
    cached_json_path = os.path.join(OUTPUT_DIR, f"{job_id}.json")
    cached_mp4_path = os.path.join(OUTPUT_DIR, f"{job_id}.mp4")

    if os.path.exists(cached_json_path) and os.path.exists(cached_mp4_path):
        # Asegura análisis para este usuario
        existing = db.query(Analysis).filter(Analysis.user_id == current.id, Analysis.video_id == job_id).first()
        if not existing:
            with open(cached_json_path, "r", encoding="utf-8") as f:
                result = f.read()
            a = Analysis(
                user_id=current.id,
                video_id=job_id,
                mp4_path=cached_mp4_path,
                result_json=result,
                conf_used=float(conf),
                stride_used=int(stride),
            )
            db.add(a)
            db.commit()

        try:
            os.remove(tmp_path)
        except:
            pass

        with jobs_lock:
            jobs[job_id] = {
                "state": "done",
                "progress": 1.0,
                "message": "Listo (cache)",
                "user_id": current.id,
                "result": json.loads(open(cached_json_path, "r", encoding="utf-8").read()),
                "error": None,
                "created_at": time.time(),
                "updated_at": time.time(),
            }

        return {"job_id": job_id, "cached": True}

    # Crear job
    with jobs_lock:
        jobs[job_id] = {
            "state": "queued",
            "progress": 0.0,
            "message": "En cola",
            "user_id": current.id,
            "result": None,
            "error": None,
            "created_at": time.time(),
            "updated_at": time.time(),
        }

    # Lanzar thread
    t = threading.Thread(
        target=_process_video_job,
        args=(job_id, tmp_path, float(conf), int(stride), size_bytes, current.id),
        daemon=True
    )
    t.start()

    return {"job_id": job_id, "cached": False}


def _process_video_job(job_id: str, tmp_path: str, conf: float, stride: int, size_bytes: int, user_id: str):
    raw_path = None
    cap = None
    writer = None

    try:
        _job_update(job_id, state="running", progress=0.01, message="Abriendo vídeo")

        cap = cv2.VideoCapture(tmp_path)
        if not cap.isOpened():
            raise RuntimeError("No se pudo abrir el vídeo.")

        fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
        frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
        width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
        height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)

        duration = (frame_count / fps) if fps > 0 else 0.0
        if duration > MAX_DURATION_SECONDS:
            raise RuntimeError(f"Vídeo demasiado largo ({duration:.1f}s). Máximo {MAX_DURATION_SECONDS}s.")

        scale = min(MAX_OUTPUT_WIDTH / width, MAX_OUTPUT_HEIGHT / height, 1.0)
        out_w = int(width * scale)
        out_h = int(height * scale)
        out_w -= out_w % 2
        out_h -= out_h % 2
        if out_w <= 0 or out_h <= 0:
            out_w, out_h = width, height

        _job_update(job_id, progress=0.03, message="Preparando writer")

        fourcc = cv2.VideoWriter_fourcc(*"mp4v")
        raw_path = tempfile.NamedTemporaryFile(delete=False, suffix=".mp4").name
        writer = cv2.VideoWriter(raw_path, fourcc, fps, (out_w, out_h))
        if not writer.isOpened():
            raise RuntimeError("No se pudo inicializar VideoWriter (mp4v).")

        last_dets = []
        last_det_frame = -10**9

        detect_times = []
        species_counter = {}
        species_times = {}

        _job_update(job_id, progress=0.05, message="Procesando frames")

        # procesado
        for frame_idx in range(frame_count if frame_count > 0 else 10**9):
            ret, frame = cap.read()
            if not ret:
                break

            if frame_count > 0 and frame_idx % max(1, frame_count // 100) == 0:
                p = 0.05 + 0.70 * (frame_idx / frame_count)
                _job_update(job_id, progress=min(0.75, p), message=f"Procesando... {int((frame_idx/frame_count)*100)}%")

            if scale < 1.0:
                frame = cv2.resize(frame, (out_w, out_h), interpolation=cv2.INTER_AREA)

            if frame_idx % stride == 0:
                results = model.predict(source=frame, conf=conf, imgsz=640, verbose=False)
                r = results[0]
                boxes = r.boxes
                names = r.names

                dets = []
                if boxes is not None and len(boxes) > 0:
                    for box in boxes:
                        x1, y1, x2, y2 = box.xyxy[0].tolist()
                        cls_id = int(box.cls[0])
                        c = float(box.conf[0])
                        cls_name = names.get(cls_id, f"class_{cls_id}")

                        dets.append({"class": cls_name, "confidence": float(c), "bbox": [x1, y1, x2, y2]})
                        species_counter[cls_name] = species_counter.get(cls_name, 0) + 1
                        tsec = frame_idx / fps if fps > 0 else None
                        if tsec is not None:
                            species_times.setdefault(cls_name, []).append(tsec)

                    last_det_frame = frame_idx
                    tsec = frame_idx / fps if fps > 0 else None
                    if tsec is not None:
                        detect_times.append(tsec)

                last_dets = dets

            # TTL cajas
            if frame_idx - last_det_frame > (TTL_MULT * stride):
                last_dets = []

            annotated = frame.copy()

            # leyenda top3
            top_now = sorted(species_counter.items(), key=lambda x: x[1], reverse=True)[:3]
            y0 = 30
            cv2.putText(annotated, f"Aves: {len(last_dets)}", (10, y0),
                        cv2.FONT_HERSHEY_SIMPLEX, 1.0, (255, 255, 255), 2, cv2.LINE_AA)
            y = y0 + 28
            if top_now:
                cv2.putText(annotated, "Top:", (10, y),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.7, (255,255,255), 2, cv2.LINE_AA)
                y += 24
                for sp, cnt in top_now:
                    col = _species_color(sp)
                    cv2.rectangle(annotated, (10, y-16), (28, y+2), col, -1)
                    cv2.putText(annotated, f"{sp} ({cnt})", (36, y),
                                cv2.FONT_HERSHEY_SIMPLEX, 0.65, (255,255,255), 2, cv2.LINE_AA)
                    y += 22

            for det in last_dets:
                x1, y1, x2, y2 = map(int, det["bbox"])
                sp = det["class"]
                col = _species_color(sp)
                label = f'{sp} {det["confidence"]*100:.1f}%'
                cv2.rectangle(annotated, (x1, y1), (x2, y2), col, 2)
                cv2.putText(annotated, label, (x1, max(20, y1 - 8)),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.6, col, 2, cv2.LINE_AA)

            writer.write(annotated)

        writer.release()
        cap.release()
        writer = None
        cap = None

        _job_update(job_id, progress=0.80, message="Transcodificando (H.264)")

        final_mp4_path = os.path.join(OUTPUT_DIR, f"{job_id}.mp4")
        gop = max(24, int(fps * 2))

        subprocess.run(
            [
                "ffmpeg", "-y",
                "-i", raw_path,
                "-c:v", "libx264",
                "-profile:v", "baseline",
                "-level", "3.0",
                "-preset", "veryfast",
                "-tune", "fastdecode",
                "-crf", "23",
                "-pix_fmt", "yuv420p",
                "-movflags", "+faststart",
                "-g", str(gop),
                "-keyint_min", str(gop),
                final_mp4_path
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=True
        )

        _job_update(job_id, progress=0.92, message="Generando estadísticas")

        segments = _segments_from_times(detect_times, SEGMENT_GAP_SECONDS)
        species_segments = {sp: _segments_from_times(ts, SEGMENT_GAP_SECONDS) for sp, ts in species_times.items()}
        species_ranking = sorted(
            [{"species": sp, "count": c} for sp, c in species_counter.items()],
            key=lambda x: x["count"],
            reverse=True
        )
        top_species = species_ranking[0]["species"] if species_ranking else None

        def top_for_segment(seg):
            s, e = seg["start_time"], seg["end_time"]
            best_sp, best_cnt = None, 0
            for sp, ts in species_times.items():
                cnt = sum(1 for t in ts if s <= t <= e)
                if cnt > best_cnt:
                    best_cnt = cnt
                    best_sp = sp
            return {"species": best_sp, "count": best_cnt}

        segments_enriched = []
        for seg in segments:
            enriched = dict(seg)
            enriched["top_species"] = top_for_segment(seg)
            segments_enriched.append(enriched)

        video_url = f"http://localhost:8000/videos/{job_id}.mp4"
        result = {
            "video_id": job_id,
            "video_url": video_url,
            "video_info": {
                "fps": float(fps),
                "frame_count": int(frame_count),
                "width": int(width if scale == 1.0 else out_w),
                "height": int(height if scale == 1.0 else out_h),
                "frame_stride": int(stride),
                "conf_used": float(conf),
                "duration_seconds": float(duration),
                "upload_bytes": int(size_bytes),
                "scaled_from": {"width": int(width), "height": int(height)} if scale < 1.0 else None,
            },
            "num_inference_points_with_detections": len(detect_times),
            "top_species_overall": top_species,
            "segments": segments_enriched,
            "species_ranking": species_ranking,
            "species_segments": species_segments,
        }

        # Guardar json cache
        json_path = os.path.join(OUTPUT_DIR, f"{job_id}.json")
        with open(json_path, "w", encoding="utf-8") as f:
            json.dump(result, f, ensure_ascii=False, indent=2)

        # Guardar en Postgres un "Analysis" para ESTE usuario
        from db import SessionLocal
        db = SessionLocal()
        try:
            existing = db.query(Analysis).filter(Analysis.user_id == user_id, Analysis.video_id == job_id).first()
            if not existing:
                a = Analysis(
                    user_id=user_id,
                    video_id=job_id,
                    mp4_path=final_mp4_path,
                    result_json=json.dumps(result, ensure_ascii=False),
                    conf_used=float(conf),
                    stride_used=int(stride),
                )
                db.add(a)
                db.commit()
        finally:
            db.close()

        _job_update(job_id, state="done", progress=1.0, message="Listo", result=result)

    except subprocess.CalledProcessError:
        _job_update(job_id, state="error", progress=1.0, error="FFmpeg falló (¿ffmpeg + libx264 instalados?)")
    except Exception as e:
        _job_update(job_id, state="error", progress=1.0, error=str(e))
    finally:
        try:
            if writer is not None:
                writer.release()
        except:
            pass
        try:
            if cap is not None:
                cap.release()
        except:
            pass
        if tmp_path and os.path.exists(tmp_path):
            try:
                os.remove(tmp_path)
            except:
                pass
        if raw_path and os.path.exists(raw_path):
            try:
                os.remove(raw_path)
            except:
                pass


from fastapi import Body

@app.post("/posts")
def create_post(
    payload: dict = Body(...),
    db: Session = Depends(get_db),
    current: User = Depends(get_current_user),
):
    """
    Publicar un vídeo resultado de un análisis.
    payload:
      - video_id: str
      - title: str
      - description: str (opcional)
    """
    video_id = (payload.get("video_id") or "").strip()
    title = (payload.get("title") or "").strip()
    description = payload.get("description")

    if not video_id:
        raise HTTPException(status_code=400, detail="video_id requerido")
    if not title or len(title) > 140:
        raise HTTPException(status_code=400, detail="title requerido (máx 140)")

    analysis = db.query(Analysis).filter(Analysis.user_id == current.id, Analysis.video_id == video_id).first()
    if not analysis:
        raise HTTPException(status_code=404, detail="No tienes un análisis para ese video_id")

    post = Post(
        user_id=current.id,
        video_id=video_id,
        mp4_path=analysis.mp4_path,
        title=title,
        description=description if isinstance(description, str) else None,
    )
    db.add(post)
    db.commit()
    db.refresh(post)

    return {
        "id": post.id,
        "video_id": post.video_id,
        "title": post.title,
        "description": post.description,
        "created_at": post.created_at.isoformat(),
        "public_video_url": f"http://localhost:8000/public/posts/{post.id}.mp4",
    }


@app.get("/posts/public")
def list_public_posts(
    limit: int = 20,
    offset: int = 0,
    db: Session = Depends(get_db),
    # current: User = Depends(get_current_user),  # feed sin login, quita esto
):
    limit = max(1, min(limit, 50))
    offset = max(0, offset)

    posts = (
        db.query(Post)
        .order_by(Post.created_at.desc())
        .offset(offset)
        .limit(limit)
        .all()
    )

    out = []
    for p in posts:
        author = db.query(User).filter(User.id == p.user_id).first()
        out.append({
            "id": p.id,
            "video_id": p.video_id,
            "title": p.title,
            "description": p.description,
            "created_at": p.created_at.isoformat(),
            "author": author.email if author else "unknown",
            "public_video_url": f"http://localhost:8000/public/posts/{p.id}.mp4",
        })

    return {"items": out, "limit": limit, "offset": offset}


@app.get("/public/posts/{post_id}.mp4")
def get_public_post_video(post_id: str, db: Session = Depends(get_db)):
    _cleanup_old_outputs()

    post = db.query(Post).filter(Post.id == post_id).first()
    if not post:
        raise HTTPException(status_code=404, detail="Post no encontrado")

    path = post.mp4_path
    if not path or not os.path.exists(path):
        raise HTTPException(status_code=404, detail="Vídeo no encontrado o expirado")

    return FileResponse(path, media_type="video/mp4", filename="post.mp4")
