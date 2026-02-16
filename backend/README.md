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

## Detener los servicios

Para detener los contenedores:

```bash
docker compose down
```

Para detenerlos y eliminar los volúmenes:

```bash
docker compose down -v
```
