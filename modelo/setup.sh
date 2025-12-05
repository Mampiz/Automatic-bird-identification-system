#!/usr/bin/env bash
set -e

PROJECT_DIR=~/yolo_birds_tfg
cd "$PROJECT_DIR"

echo ">>> Creando entorno virtual..."
python3 -m venv venv

echo ">>> Activando entorno virtual..."
source venv/bin/activate

echo ">>> Actualizando pip..."
pip install --upgrade pip

pip install torch torchvision --index-url https://download.pytorch.org/whl/cu121

echo ">>> Instalando Ultralytics (YOLOv12) y dependencias..."
pip install ultralytics
pip install tqdm matplotlib pandas seaborn opencv-python pillow

echo ">>> Comprobando GPU..."
python - << 'EOF'
import torch
print("CUDA disponible:", torch.cuda.is_available())
if torch.cuda.is_available():
    print("GPU:", torch.cuda.get_device_name(0))
EOF

echo ">>> Entorno listo. Para usarlo:"
echo "cd $PROJECT_DIR"
echo "source venv/bin/activate"
