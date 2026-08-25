# Backend – FastAPI

- Python 3
- FastAPI
- PostgreSQL
- Docker
- Docker Compose

---

## Instalación

Antes de levantar los contenedores, es necesario instalar las dependencias del proyecto.

Desde /backend del proyecto:

```bash
pip install -r requirements.txt
```

---

## Levantar el backend

Una vez instaladas las dependencias, levanta el backend y la base de datos ejecutando desde la raiz del proyecto este comando:

```bash
docker compose up --build
```

Este comando levanta:

- El backend en FastAPI
- La base de datos PostgreSQL

---

## Acceso a la aplicación

- Backend:
  http://localhost:8000

- Documentación de la API (Swagger):
  http://localhost:8000/docs

---

## Variables de entorno relevantes

- `JWT_SECRET`: obligatorio en producción.
- `FRONTEND_ORIGINS`: permite lista separada por comas o JSON array.
- `JOB_RETENTION_SECONDS`: tiempo en segundos para mantener jobs en memoria.
- `JOB_MAX_ENTRIES`: límite máximo de jobs en memoria.

La cola/estado de análisis de vídeo se persiste en PostgreSQL (`video_jobs`), y al reiniciar backend se reanudan jobs en `queued/running`.

---

## Tests

Los tests no necesitan GPU, ni los pesos, ni PostgreSQL: `tests/conftest.py`
sustituye `ultralytics` y `cv2` por stubs y apunta `DATABASE_URL` a SQLite en
memoria. Por eso se instalan `requirements-dev.txt` y no `requirements.txt`, que
arrastraría torch.

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements-dev.txt

pytest          # 71 tests, ~3 segundos
ruff check .
```

Cubren la lógica que decide qué devuelve la API: identidad de jobs, agrupación de
detecciones en segmentos, recorte de bounding boxes, hashing y tokens, las rutas
de autenticación contra una base de datos real, y el rate limiter por usuario.

Lo que necesita inferencia de verdad va en tests de integración contra
`requirements.txt` y los checkpoints reales, que todavía no existen.

---

## Detener los servicios

Para detener los contenedores:

```bash
docker compose down
```

Para detenerlos y eliminar los volúmenes:

```bash
docker compose down -v
```
