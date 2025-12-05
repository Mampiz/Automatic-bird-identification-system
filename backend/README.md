# Backend del Detector d’Aus — FastAPI + YOLOv12

Aquest backend implementa una API en **FastAPI** capaç d’analitzar imatges i vídeos per detectar aus mitjançant un model **YOLOv12m** entrenat específicament.

## Requisits
- Python 3.10 o superior
- pip i virtualenv recomanats
- ffmpeg (opcional però recomanat)

## Instal·lació
```bash
git clone <repo>
cd backend
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

## Execució
```bash
uvicorn main:app --reload
