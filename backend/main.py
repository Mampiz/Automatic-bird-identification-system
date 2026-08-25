import asyncio
import hashlib
import json
import logging
import os
import queue
import subprocess
import tempfile
import threading
import time
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime

import cv2
import numpy as np
from dotenv import load_dotenv
from fastapi import Body, Depends, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import confloat, conint
from sqlalchemy.orm import Session
from ultralytics import YOLO

load_dotenv()

# Imported after load_dotenv() on purpose: db reads DATABASE_URL at import time,
# so the .env file has to be in the environment before these run. E402 is the
# rule that would have this "fixed" into a broken configuration.
from auth import create_access_token, get_current_user, hash_password, verify_password  # noqa: E402
from db import Base, SessionLocal, engine, get_db  # noqa: E402
from models import Analysis, Post, User, VideoJob  # noqa: E402

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("birds-backend")


PUBLIC_BASE_URL = os.getenv("PUBLIC_BASE_URL", "http://localhost:8000")

def _parse_frontend_origins(raw: str) -> list[str]:
    raw = (raw or "").strip()
    if not raw:
        return ["http://localhost:5173"]
    if raw == "*":
        return ["*"]

    if raw.startswith("["):
        try:
            parsed = json.loads(raw)
            if isinstance(parsed, list):
                out = [str(o).strip() for o in parsed if str(o).strip()]
                if out:
                    return out
        except Exception:
            pass

    out = [o.strip() for o in raw.split(",") if o.strip()]
    return out if out else ["http://localhost:5173"]


FRONTEND_ORIGINS = _parse_frontend_origins(os.getenv("FRONTEND_ORIGINS", "http://localhost:5173"))

MAX_CONCURRENT_JOBS = int(os.getenv("MAX_CONCURRENT_JOBS", "2"))
job_sema = threading.Semaphore(MAX_CONCURRENT_JOBS)


app = FastAPI()
_db_init_lock = threading.Lock()
_db_initialized = False


@app.on_event("startup")
def _init_db_once():
    global _db_initialized
    if _db_initialized:
        return
    with _db_init_lock:
        if _db_initialized:
            return
        Base.metadata.create_all(bind=engine)
        _ensure_worker_pool()
        _recover_persisted_jobs()
        _db_initialized = True


app.add_middleware(
    CORSMiddleware,
    allow_origins=FRONTEND_ORIGINS,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


MODEL_PATH = os.getenv("MODEL_PATH", "bestgen.pt")
log.info("Cargando modelo YOLO...")
model = YOLO(MODEL_PATH)
log.info("Modelo YOLO cargado: %s", MODEL_PATH)

DEFAULT_MIN_CONF = 0.25
DEFAULT_FRAME_STRIDE = 5

MAX_UPLOAD_MB = 400
MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024
MAX_DURATION_SECONDS = 20 * 60
MAX_OUTPUT_WIDTH = 1280
MAX_OUTPUT_HEIGHT = 720

SEGMENT_GAP_SECONDS = 1.0
TTL_MULT = 2

OUTPUT_DIR = os.path.abspath("./outputs")
os.makedirs(OUTPUT_DIR, exist_ok=True)
UPLOAD_DIR = os.path.join(OUTPUT_DIR, "incoming")
os.makedirs(UPLOAD_DIR, exist_ok=True)
OUTPUT_TTL_SECONDS = 24 * 60 * 60

JOB_RETENTION_SECONDS = int(os.getenv("JOB_RETENTION_SECONDS", "21600"))
JOB_MAX_ENTRIES = int(os.getenv("JOB_MAX_ENTRIES", "5000"))

jobs = {}
jobs_lock = threading.Lock()
active_jobs = set()
active_jobs_lock = threading.Lock()

JOB_WORKER_COUNT = max(1, MAX_CONCURRENT_JOBS)
job_queue = queue.Queue()
queued_job_ids = set()
queued_job_ids_lock = threading.Lock()
_worker_pool_lock = threading.Lock()
_worker_pool_started = False

MAX_FRAME_UPLOAD_MB = float(os.getenv("MAX_FRAME_UPLOAD_MB", "8"))
MAX_FRAME_UPLOAD_BYTES = int(MAX_FRAME_UPLOAD_MB * 1024 * 1024)
FRAME_RATE_LIMIT_WINDOW_SECONDS = max(0.1, float(os.getenv("FRAME_RATE_LIMIT_WINDOW_SECONDS", "1.0")))
FRAME_RATE_LIMIT_COUNT = max(1, int(os.getenv("FRAME_RATE_LIMIT_COUNT", "20")))
FRAME_MAX_CONCURRENT_INFER = max(1, int(os.getenv("FRAME_MAX_CONCURRENT_INFER", "2")))
FRAME_INFER_TIMEOUT_SECONDS = max(1.0, float(os.getenv("FRAME_INFER_TIMEOUT_SECONDS", "12")))
FFMPEG_TIMEOUT_SECONDS = max(30, int(os.getenv("FFMPEG_TIMEOUT_SECONDS", "1800")))

frame_rate_lock = threading.Lock()
frame_rate_state: dict[str, deque[float]] = {}
frame_infer_executor = ThreadPoolExecutor(max_workers=FRAME_MAX_CONCURRENT_INFER, thread_name_prefix="frame-infer")


def _build_video_job_id(file_sha256: str, conf: float, stride: int) -> str:
    conf_norm = f"{float(conf):.4f}"
    raw = f"{file_sha256}:{conf_norm}:{int(stride)}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _pinned_post_paths(db: Session | None) -> set[str]:
    if db is None:
        return set()

    keep = set()
    try:
        rows = db.query(Post.mp4_path).all()
        for (p,) in rows:
            if not p:
                continue
            keep.add(os.path.abspath(p))
    except Exception as e:
        log.warning("cleanup: no se pudieron cargar rutas publicadas: %s", e)
    return keep


def _cleanup_old_outputs(db: Session | None = None):
    now = time.time()
    removed = 0
    pinned_paths = _pinned_post_paths(db)
    try:
        for name in os.listdir(OUTPUT_DIR):
            path = os.path.join(OUTPUT_DIR, name)
            try:
                if os.path.abspath(path) in pinned_paths:
                    continue
                st = os.stat(path)
                if now - st.st_mtime > OUTPUT_TTL_SECONDS and os.path.isfile(path):
                    os.remove(path)
                    removed += 1
            except Exception as e:
                log.warning("cleanup: no se pudo borrar %s: %s", path, e)
    except Exception as e:
        log.warning("cleanup: error listando outputs: %s", e)

    if removed:
        log.info("cleanup: borrados %d outputs antiguos", removed)


def _safe_suffix(filename: str) -> str:
    ext = os.path.splitext(filename or "")[1].lower()
    return ext if ext else ".mp4"


def _check_frame_rate_limit(user_id: str):
    now = time.monotonic()
    cutoff = now - FRAME_RATE_LIMIT_WINDOW_SECONDS

    with frame_rate_lock:
        bucket = frame_rate_state.setdefault(user_id, deque())
        while bucket and bucket[0] < cutoff:
            bucket.popleft()

        if len(bucket) >= FRAME_RATE_LIMIT_COUNT:
            raise HTTPException(status_code=429, detail="Demasiadas solicitudes de frame. Reduce la frecuencia.")

        bucket.append(now)


async def _read_upload_limited(file: UploadFile, max_bytes: int, chunk_size: int = 1024 * 1024) -> bytes:
    total = 0
    chunks = []

    while True:
        chunk = await file.read(chunk_size)
        if not chunk:
            break
        total += len(chunk)
        if total > max_bytes:
            raise HTTPException(
                status_code=413,
                detail=f"Frame demasiado grande. Máximo {MAX_FRAME_UPLOAD_MB:.1f}MB.",
            )
        chunks.append(chunk)

    if not chunks:
        return b""
    return b"".join(chunks)


async def _stream_upload_to_tempfile_and_hash(file: UploadFile) -> tuple[str, str, int]:
    suffix = _safe_suffix(file.filename or "")
    h = hashlib.sha256()
    total = 0

    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix, dir=UPLOAD_DIR) as tmp:
        while True:
            chunk = await file.read(1024 * 1024)
            if not chunk:
                break
            total += len(chunk)
            if total > MAX_UPLOAD_BYTES:
                try:
                    os.remove(tmp.name)
                except Exception:
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


def _job_response(job_id: str, j: dict) -> dict:
    return {
        "job_id": job_id,
        "state": j["state"],
        "progress": j.get("progress", 0.0),
        "message": j.get("message", ""),
        "result": j.get("result"),
        "error": j.get("error"),
    }


def _parse_result_json(result_json: str | None):
    if not result_json:
        return None
    try:
        return json.loads(result_json)
    except Exception:
        return None


def _prune_jobs():
    now = time.time()
    removed = 0

    with jobs_lock:
        stale_ids = []
        for job_id, data in jobs.items():
            state = data.get("state")
            updated_at = float(data.get("updated_at", data.get("created_at", now)))
            if state in ("done", "error") and (now - updated_at) > JOB_RETENTION_SECONDS:
                stale_ids.append(job_id)

        for job_id in stale_ids:
            if jobs.pop(job_id, None) is not None:
                removed += 1

        overflow = len(jobs) - JOB_MAX_ENTRIES
        if overflow > 0:
            oldest = sorted(
                jobs.items(),
                key=lambda kv: float(kv[1].get("updated_at", kv[1].get("created_at", 0.0)))
            )
            for job_id, _ in oldest[:overflow]:
                if jobs.pop(job_id, None) is not None:
                    removed += 1

    if removed:
        log.info("jobs: limpiados %d registros en memoria", removed)


def _persist_job_fields(job_id: str, **fields):
    db = SessionLocal()
    try:
        row = db.query(VideoJob).filter(VideoJob.job_id == job_id).first()
        if not row:
            return

        for k, v in fields.items():
            if hasattr(row, k):
                setattr(row, k, v)
        row.updated_at = datetime.utcnow()
        db.commit()
    except Exception as e:
        db.rollback()
        log.warning("job persist: no se pudo actualizar %s: %s", job_id, e)
    finally:
        db.close()


def _job_dict_from_row(row: VideoJob) -> dict:
    return {
        "state": row.state,
        "progress": float(row.progress or 0.0),
        "message": row.message or "",
        "user_id": row.user_id,
        "result": _parse_result_json(row.result_json),
        "error": row.error,
        "created_at": row.created_at.timestamp() if row.created_at else time.time(),
        "updated_at": row.updated_at.timestamp() if row.updated_at else time.time(),
    }


def _job_response_from_row(row: VideoJob) -> dict:
    return {
        "job_id": row.job_id,
        "state": row.state,
        "progress": float(row.progress or 0.0),
        "message": row.message or "",
        "result": _parse_result_json(row.result_json),
        "error": row.error,
    }


def _mark_job_active(job_id: str) -> bool:
    with active_jobs_lock:
        if job_id in active_jobs:
            return False
        active_jobs.add(job_id)
        return True


def _mark_job_inactive(job_id: str):
    with active_jobs_lock:
        active_jobs.discard(job_id)


def _enqueue_job(job_id: str) -> bool:
    with active_jobs_lock:
        if job_id in active_jobs:
            return False

    with queued_job_ids_lock:
        if job_id in queued_job_ids:
            return False
        queued_job_ids.add(job_id)

    job_queue.put(job_id)
    return True


def _job_worker_loop(worker_idx: int):
    while True:
        job_id = job_queue.get()
        try:
            if not _mark_job_active(job_id):
                continue
            _process_video_job_from_db(job_id)
        except Exception as e:
            log.exception("worker-%d: error procesando job %s: %s", worker_idx, job_id, e)
        finally:
            with queued_job_ids_lock:
                queued_job_ids.discard(job_id)
            job_queue.task_done()


def _ensure_worker_pool():
    global _worker_pool_started
    if _worker_pool_started:
        return

    with _worker_pool_lock:
        if _worker_pool_started:
            return

        for i in range(JOB_WORKER_COUNT):
            t = threading.Thread(target=_job_worker_loop, args=(i + 1,), daemon=True)
            t.start()
        _worker_pool_started = True


def _process_video_job_from_db(job_id: str):
    try:
        db = SessionLocal()
        try:
            claimed = (
                db.query(VideoJob)
                .filter(VideoJob.job_id == job_id, VideoJob.state == "queued")
                .update(
                    {
                        VideoJob.state: "running",
                        VideoJob.message: "Worker adquirido",
                        VideoJob.error: None,
                        VideoJob.started_at: datetime.utcnow(),
                        VideoJob.updated_at: datetime.utcnow(),
                    },
                    synchronize_session=False,
                )
            )
            db.commit()
            if not claimed:
                return

            row = db.query(VideoJob).filter(VideoJob.job_id == job_id).first()
            if not row:
                return
            input_path = row.input_path
            conf = float(row.conf_used)
            stride = int(row.stride_used)
            size_bytes = int(row.size_bytes or 0)
            user_id = row.user_id
        except Exception:
            db.rollback()
            raise
        finally:
            db.close()

        _process_video_job(job_id, input_path, conf, stride, size_bytes, user_id)
    finally:
        _mark_job_inactive(job_id)


def _ensure_job_worker(job_id: str):
    _ensure_worker_pool()
    _enqueue_job(job_id)


def _recover_persisted_jobs():
    db = SessionLocal()
    try:
        rows = db.query(VideoJob).filter(VideoJob.state.in_(("queued", "running"))).all()
        if not rows:
            return

        now = datetime.utcnow()
        recovered_ids = []
        for row in rows:
            if row.state == "running":
                row.state = "queued"
                row.message = "Reanudado tras reinicio"
                row.updated_at = now
            recovered_ids.append(row.job_id)

        db.commit()
    except Exception as e:
        db.rollback()
        log.warning("recover jobs: error restaurando cola: %s", e)
        recovered_ids = []
    finally:
        db.close()

    for job_id in recovered_ids:
        _ensure_job_worker(job_id)


def _to_bbox_norm_xyxy(x1, y1, x2, y2, w, h):
    x1c = max(0.0, min(float(x1), float(w)))
    y1c = max(0.0, min(float(y1), float(h)))
    x2c = max(0.0, min(float(x2), float(w)))
    y2c = max(0.0, min(float(y2), float(h)))
    if w <= 0 or h <= 0:
        return [0.0, 0.0, 0.0, 0.0], [x1c, y1c, x2c, y2c]
    return [x1c / w, y1c / h, x2c / w, y2c / h], [x1c, y1c, x2c, y2c]


@app.get("/health")
def health():
    """Liveness probe.

    Deliberately checks nothing external: if this reported unhealthy whenever
    Postgres hiccuped, the orchestrator would restart a process that is working
    fine and take the API down with it. It answers the only question a restart
    can fix - is this process alive and did the model load.
    """
    return {
        "status": "ok",
        "model": MODEL_PATH,
        "workers": JOB_WORKER_COUNT,
    }


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
    _cleanup_old_outputs(db)

    owns = db.query(Analysis).filter(Analysis.user_id == current.id, Analysis.video_id == video_id).first()
    if not owns:
        raise HTTPException(status_code=403, detail="No autorizado para este vídeo.")

    path = os.path.join(OUTPUT_DIR, f"{video_id}.mp4")
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail="Vídeo no encontrado o expirado.")
    return FileResponse(path, media_type="video/mp4", filename="video_annotated.mp4")


@app.get("/status/{job_id}")
def get_status(job_id: str, db: Session = Depends(get_db), current: User = Depends(get_current_user)):
    _prune_jobs()

    with jobs_lock:
        j = jobs.get(job_id)
    if j:
        if j.get("user_id") != current.id:
            raise HTTPException(status_code=403, detail="No autorizado.")
        return _job_response(job_id, j)

    row = db.query(VideoJob).filter(VideoJob.job_id == job_id).first()
    if row:
        if row.user_id != current.id:
            # Cache compartida: si el job está materializado para este usuario en analyses,
            # devolvemos estado done aunque el dueño del registro de cola sea otro.
            if row.state == "done":
                analysis = db.query(Analysis).filter(Analysis.user_id == current.id, Analysis.video_id == job_id).first()
                if analysis:
                    result = _parse_result_json(analysis.result_json)
                    synthetic = {
                        "state": "done",
                        "progress": 1.0,
                        "message": "Listo (persistido)",
                        "user_id": current.id,
                        "result": result,
                        "error": None,
                        "created_at": time.time(),
                        "updated_at": time.time(),
                    }
                    with jobs_lock:
                        jobs[job_id] = synthetic
                    return _job_response(job_id, synthetic)
            raise HTTPException(status_code=403, detail="No autorizado.")
        response = _job_response_from_row(row)
        with jobs_lock:
            jobs[job_id] = _job_dict_from_row(row)
        if row.state == "queued":
            _ensure_job_worker(job_id)
        return response

    # Fallback legado: jobs antiguos ya materializados en analyses.
    analysis = db.query(Analysis).filter(Analysis.user_id == current.id, Analysis.video_id == job_id).first()
    if analysis:
        result = _parse_result_json(analysis.result_json)
        synthetic = {
            "state": "done",
            "progress": 1.0,
            "message": "Listo (persistido)",
            "user_id": current.id,
            "result": result,
            "error": None,
            "created_at": time.time(),
            "updated_at": time.time(),
        }
        with jobs_lock:
            jobs[job_id] = synthetic
        return _job_response(job_id, synthetic)

    raise HTTPException(status_code=404, detail="Job no encontrado.")


@app.post("/predict_video_annotated")
async def predict_video_annotated(
    file: UploadFile = File(...),
    conf: confloat(ge=0.0, le=1.0) = Form(DEFAULT_MIN_CONF),
    stride: conint(ge=1, le=60) = Form(DEFAULT_FRAME_STRIDE),
    db: Session = Depends(get_db),
    current: User = Depends(get_current_user),
):
    _cleanup_old_outputs(db)
    _prune_jobs()

    tmp_path, sha256_hex, size_bytes = await _stream_upload_to_tempfile_and_hash(file)
    job_id = _build_video_job_id(sha256_hex, float(conf), int(stride))

    cached_json_path = os.path.join(OUTPUT_DIR, f"{job_id}.json")
    cached_mp4_path = os.path.join(OUTPUT_DIR, f"{job_id}.mp4")

    if os.path.exists(cached_json_path) and os.path.exists(cached_mp4_path):
        existing = db.query(Analysis).filter(Analysis.user_id == current.id, Analysis.video_id == job_id).first()
        with open(cached_json_path, encoding="utf-8") as f:
            result = f.read()

        if not existing:
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

        row = db.query(VideoJob).filter(VideoJob.job_id == job_id).first()
        if row is None:
            row = VideoJob(
                job_id=job_id,
                user_id=current.id,
                state="done",
                progress=1.0,
                message="Listo (cache)",
                error=None,
                result_json=result,
                input_path="",
                size_bytes=int(size_bytes),
                conf_used=float(conf),
                stride_used=int(stride),
                created_at=datetime.utcnow(),
                updated_at=datetime.utcnow(),
                finished_at=datetime.utcnow(),
            )
            db.add(row)
            db.commit()
        elif row.user_id == current.id:
            row.state = "done"
            row.progress = 1.0
            row.message = "Listo (cache)"
            row.error = None
            row.result_json = result
            row.finished_at = datetime.utcnow()
            row.updated_at = datetime.utcnow()
            db.commit()

        try:
            os.remove(tmp_path)
        except Exception:
            pass

        with jobs_lock:
            jobs[job_id] = {
                "state": "done",
                "progress": 1.0,
                "message": "Listo (cache)",
                "user_id": current.id,
                "result": json.loads(result),
                "error": None,
                "created_at": time.time(),
                "updated_at": time.time(),
            }

        return {"job_id": job_id, "cached": True}

    row = db.query(VideoJob).filter(VideoJob.job_id == job_id).first()
    if row:
        if row.user_id != current.id:
            try:
                os.remove(tmp_path)
            except Exception:
                pass
            raise HTTPException(
                status_code=409,
                detail="Este análisis ya está en cola por otro usuario. Espera a que termine para usar caché."
            )

        if row.state in ("queued", "running"):
            try:
                os.remove(tmp_path)
            except Exception:
                pass
            with jobs_lock:
                jobs[job_id] = _job_dict_from_row(row)
            _ensure_job_worker(job_id)
            return {"job_id": job_id, "cached": False, "reused": True}

        row.state = "queued"
        row.progress = 0.0
        row.message = "En cola"
        row.error = None
        row.result_json = None
        row.input_path = tmp_path
        row.size_bytes = int(size_bytes)
        row.conf_used = float(conf)
        row.stride_used = int(stride)
        row.started_at = None
        row.finished_at = None
        row.updated_at = datetime.utcnow()
        db.commit()
    else:
        row = VideoJob(
            job_id=job_id,
            user_id=current.id,
            state="queued",
            progress=0.0,
            message="En cola",
            error=None,
            result_json=None,
            input_path=tmp_path,
            size_bytes=int(size_bytes),
            conf_used=float(conf),
            stride_used=int(stride),
            created_at=datetime.utcnow(),
            updated_at=datetime.utcnow(),
        )
        db.add(row)
        db.commit()

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

    _ensure_job_worker(job_id)

    return {"job_id": job_id, "cached": False}


def _process_video_job(job_id: str, tmp_path: str, conf: float, stride: int, size_bytes: int, user_id: str):
    raw_path = None
    cap = None
    writer = None

    with job_sema:
        try:
            _job_update(job_id, state="running", progress=0.01, message="Abriendo vídeo")
            _persist_job_fields(
                job_id,
                state="running",
                progress=0.01,
                message="Abriendo vídeo",
                error=None,
                started_at=datetime.utcnow(),
                finished_at=None,
            )

            cap = cv2.VideoCapture(tmp_path)
            if not cap.isOpened():
                raise RuntimeError("No se pudo abrir el vídeo.")

            fps = float(cap.get(cv2.CAP_PROP_FPS) or 0.0)
            if fps <= 0.0:
                fps = 25.0
            frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
            width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
            height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)

            duration_meta = (frame_count / fps) if frame_count > 0 else 0.0
            if duration_meta > MAX_DURATION_SECONDS:
                raise RuntimeError(f"Vídeo demasiado largo ({duration_meta:.1f}s). Máximo {MAX_DURATION_SECONDS}s.")
            duration_limit_frames = max(1, int(MAX_DURATION_SECONDS * fps))
            processed_frames = 0

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

            for frame_idx in range(frame_count if frame_count > 0 else 10**9):
                ret, frame = cap.read()
                if not ret:
                    break
                processed_frames += 1

                # Cuando el contenedor no informa frame_count, cortamos por frames procesados.
                if processed_frames > duration_limit_frames:
                    raise RuntimeError(f"Vídeo demasiado largo (>{MAX_DURATION_SECONDS:.1f}s). Máximo {MAX_DURATION_SECONDS}s.")

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

                if frame_idx - last_det_frame > (TTL_MULT * stride):
                    last_dets = []

                annotated = frame.copy()

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
                timeout=FFMPEG_TIMEOUT_SECONDS,
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

            duration_effective = duration_meta if duration_meta > 0 else (processed_frames / fps if fps > 0 else 0.0)
            frame_count_effective = frame_count if frame_count > 0 else processed_frames
            video_url = f"/videos/{job_id}.mp4"
            result = {
                "video_id": job_id,
                "video_url": video_url,
                "video_info": {
                    "fps": float(fps),
                    "frame_count": int(frame_count_effective),
                    "width": int(width if scale == 1.0 else out_w),
                    "height": int(height if scale == 1.0 else out_h),
                    "frame_stride": int(stride),
                    "conf_used": float(conf),
                    "duration_seconds": float(duration_effective),
                    "upload_bytes": int(size_bytes),
                    "scaled_from": {"width": int(width), "height": int(height)} if scale < 1.0 else None,
                },
                "num_inference_points_with_detections": len(detect_times),
                "top_species_overall": top_species,
                "segments": segments_enriched,
                "species_ranking": species_ranking,
                "species_segments": species_segments,
            }
            result_json = json.dumps(result, ensure_ascii=False)

            json_path = os.path.join(OUTPUT_DIR, f"{job_id}.json")
            with open(json_path, "w", encoding="utf-8") as f:
                json.dump(result, f, ensure_ascii=False, indent=2)

            db = SessionLocal()
            try:
                existing = db.query(Analysis).filter(Analysis.user_id == user_id, Analysis.video_id == job_id).first()
                if not existing:
                    a = Analysis(
                        user_id=user_id,
                        video_id=job_id,
                        mp4_path=final_mp4_path,
                        result_json=result_json,
                        conf_used=float(conf),
                        stride_used=int(stride),
                    )
                    db.add(a)
                    db.commit()
            finally:
                db.close()

            _persist_job_fields(
                job_id,
                state="done",
                progress=1.0,
                message="Listo",
                error=None,
                result_json=result_json,
                finished_at=datetime.utcnow(),
            )
            _job_update(job_id, state="done", progress=1.0, message="Listo", result=result)

        except subprocess.TimeoutExpired:
            err = f"FFmpeg superó el timeout de {FFMPEG_TIMEOUT_SECONDS}s"
            _persist_job_fields(
                job_id,
                state="error",
                progress=1.0,
                message=err,
                error=err,
                finished_at=datetime.utcnow(),
            )
            _job_update(job_id, state="error", progress=1.0, error=err)
        except subprocess.CalledProcessError:
            err = "FFmpeg falló (¿ffmpeg + libx264 instalados?)"
            _persist_job_fields(
                job_id,
                state="error",
                progress=1.0,
                message=err,
                error=err,
                finished_at=datetime.utcnow(),
            )
            _job_update(job_id, state="error", progress=1.0, error=err)
        except Exception as e:
            err = str(e)
            _persist_job_fields(
                job_id,
                state="error",
                progress=1.0,
                message=err,
                error=err,
                finished_at=datetime.utcnow(),
            )
            _job_update(job_id, state="error", progress=1.0, error=err)
        finally:
            try:
                if writer is not None:
                    writer.release()
            except Exception:
                pass
            try:
                if cap is not None:
                    cap.release()
            except Exception:
                pass
            if tmp_path and os.path.exists(tmp_path):
                try:
                    os.remove(tmp_path)
                except Exception:
                    pass
            if raw_path and os.path.exists(raw_path):
                try:
                    os.remove(raw_path)
                except Exception:
                    pass


@app.post("/posts")
def create_post(
    payload: dict = Body(...),
    db: Session = Depends(get_db),
    current: User = Depends(get_current_user),
):
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
        "public_video_url": f"/public/posts/{post.id}.mp4",
    }


@app.get("/posts/public")
def list_public_posts(
    limit: int = 20,
    offset: int = 0,
    db: Session = Depends(get_db),
):
    limit = max(1, min(limit, 50))
    offset = max(0, offset)

    rows = (
        db.query(Post, User.email)
        .outerjoin(User, User.id == Post.user_id)
        .order_by(Post.created_at.desc())
        .offset(offset)
        .limit(limit)
        .all()
    )

    out = []
    for p, author_email in rows:
        out.append({
            "id": p.id,
            "video_id": p.video_id,
            "title": p.title,
            "description": p.description,
            "created_at": p.created_at.isoformat(),
            "author": author_email if author_email else "unknown",
            "public_video_url": f"/public/posts/{p.id}.mp4",
        })

    return {"items": out, "limit": limit, "offset": offset}


@app.get("/public/posts/{post_id}.mp4")
def get_public_post_video(post_id: str, db: Session = Depends(get_db)):
    _cleanup_old_outputs(db)

    post = db.query(Post).filter(Post.id == post_id).first()
    if not post:
        raise HTTPException(status_code=404, detail="Post no encontrado")

    path = post.mp4_path
    if not path or not os.path.exists(path):
        raise HTTPException(status_code=404, detail="Vídeo no encontrado o expirado")

    return FileResponse(path, media_type="video/mp4", filename="post.mp4")


@app.post("/predict_image")
async def predict_image(
    file: UploadFile = File(...),
    conf: confloat(ge=0.0, le=1.0) = Form(DEFAULT_MIN_CONF),
    current: User = Depends(get_current_user),
):
    try:
        data = await file.read()
        if not data:
            raise HTTPException(status_code=400, detail="Imagen vacía")

        arr = np.frombuffer(data, dtype=np.uint8)
        img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
        if img is None:
            raise HTTPException(status_code=400, detail="No se pudo decodificar la imagen")

        h, w = img.shape[:2]
        results = model.predict(source=img, conf=float(conf), imgsz=640, verbose=False)
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

                bbox_norm, bbox_px = _to_bbox_norm_xyxy(x1, y1, x2, y2, w, h)
                dets.append({
                    "class": cls_name,
                    "confidence": float(c),
                    "bbox": bbox_px,
                    "bbox_norm": bbox_norm,
                })

        return {
            "ok": True,
            "num_detections": len(dets),
            "image_size": {"width": int(w), "height": int(h)},
            "detections": dets,
        }

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e)) from e


@app.post("/predict_frame_fast")
async def predict_frame_fast(
    file: UploadFile = File(...),
    conf: confloat(ge=0.0, le=1.0) = Form(DEFAULT_MIN_CONF),
    current: User = Depends(get_current_user),
):
    _check_frame_rate_limit(current.id)

    data = await _read_upload_limited(file, MAX_FRAME_UPLOAD_BYTES)
    if not data:
        return {"ok": True, "detections": []}

    img = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        return {"ok": True, "detections": []}

    h, w = img.shape[:2]
    conf_value = float(conf)

    try:
        loop = asyncio.get_running_loop()
        results = await asyncio.wait_for(
            loop.run_in_executor(
                frame_infer_executor,
                lambda: model.predict(
                    source=img,
                    conf=conf_value,
                    imgsz=640,
                    verbose=False,
                    device="cpu",
                ),
            ),
            timeout=FRAME_INFER_TIMEOUT_SECONDS,
        )
    except TimeoutError as err:
        raise HTTPException(status_code=504, detail="Timeout en inferencia de frame.") from err

    r = results[0]
    dets = []

    if r.boxes is not None:
        for box in r.boxes:
            x1, y1, x2, y2 = box.xyxy[0].tolist()
            cls_id = int(box.cls[0])
            c = float(box.conf[0])

            dets.append({
                "class": r.names.get(cls_id, str(cls_id)),
                "confidence": c,
                "bbox_norm": [
                    max(0.0, min(x1 / w, 1.0)),
                    max(0.0, min(y1 / h, 1.0)),
                    max(0.0, min(x2 / w, 1.0)),
                    max(0.0, min(y2 / h, 1.0)),
                ],
            })

    return {"ok": True, "detections": dets}



HLS_DIR = os.getenv("HLS_DIR", "/hls")
HLS_PUBLIC_BASE = os.getenv("HLS_PUBLIC_BASE", "").strip().rstrip("/")

def _guess_hls_base(req: Request) -> str:
    if HLS_PUBLIC_BASE:
        return HLS_PUBLIC_BASE
    host = req.headers.get("host", "localhost:8000").split(":")[0]
    return f"http://{host}:8080/hls"

@app.get("/live/streams")
def list_live_streams(req: Request):
    try:
        base = _guess_hls_base(req)
        items = []
        if os.path.isdir(HLS_DIR):
            for name in os.listdir(HLS_DIR):
                if name.endswith(".m3u8"):
                    stream_id = name[:-5]
                    items.append({"id": stream_id, "m3u8_url": f"{base}/{name}"})
        items.sort(key=lambda x: x["id"])
        return {"items": items}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e)) from e

@app.get("/live/streams/{stream_id}")
def get_live_stream(stream_id: str, req: Request):
    safe = "".join(ch for ch in stream_id if ch.isalnum() or ch in ("-", "_"))
    if not safe:
        raise HTTPException(status_code=400, detail="stream_id inválido")

    m3u8_name = f"{safe}.m3u8"
    path = os.path.join(HLS_DIR, m3u8_name)
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail="stream no encontrado")

    base = _guess_hls_base(req)
    return {"id": safe, "m3u8_url": f"{base}/{m3u8_name}"}
