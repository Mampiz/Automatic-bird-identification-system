#!/usr/bin/env python
import os
import json
import shutil
from tqdm import tqdm
import pandas as pd

BASE_DIR = "dataset_tfg"
TRAIN_DIR = os.path.join(BASE_DIR, "train")
VAL_DIR   = os.path.join(BASE_DIR, "valid")  
TEST_DIR  = os.path.join(BASE_DIR, "test")
YOLO_BASE = "data_yolo"

def ensure_dirs():
    for split in ["train", "val", "test"]:
        img_dir = os.path.join(YOLO_BASE, "images", split)
        lbl_dir = os.path.join(YOLO_BASE, "labels", split)
        os.makedirs(img_dir, exist_ok=True)
        os.makedirs(lbl_dir, exist_ok=True)

def coco_class_distribution(ann_path):
    with open(ann_path, "r") as f:
        coco = json.load(f)
    df_anns = pd.DataFrame(coco["annotations"])
    df_cats = pd.DataFrame(coco["categories"])
    counts = df_anns["category_id"].value_counts().sort_index()
    id_to_name = {row["id"]: row["name"] for _, row in df_cats.iterrows()}
    counts_named = counts.rename(index=id_to_name)
    return counts_named, id_to_name, coco["categories"]

def coco_to_yolo_split(
    split_dir,
    split_name,
    yolo_base,
    cat_id_to_idx=None,
    base_categories=None,
    min_rel_area=0.001,
):
    ann_path = os.path.join(split_dir, "_annotations.coco.json")
    print(f"Procesando {split_name} desde {ann_path}")

    with open(ann_path, "r") as f:
        coco = json.load(f)

    if base_categories is None:
        categories = sorted(coco["categories"], key=lambda c: c["id"])
        cat_id_to_idx = {c["id"]: i for i, c in enumerate(categories)}
    else:
        categories = base_categories 

    img_id_to_info = {img["id"]: img for img in coco["images"]}

    img_id_to_anns = {}
    for ann in coco["annotations"]:
        img_id = ann["image_id"]
        cat_id = ann["category_id"]
        if cat_id not in cat_id_to_idx:
            continue
        img_id_to_anns.setdefault(img_id, []).append(ann)

    img_src_dir = split_dir
    img_dst_dir = os.path.join(yolo_base, "images", split_name)
    lbl_dst_dir = os.path.join(yolo_base, "labels", split_name)

    num_boxes_before = 0
    num_boxes_after = 0

    for img_id, img_info in tqdm(img_id_to_info.items()):
        anns = img_id_to_anns.get(img_id, [])
        if not anns:
            continue

        file_name = img_info["file_name"]
        width = img_info["width"]
        height = img_info["height"]

        src_img_path = os.path.join(img_src_dir, file_name)
        dst_img_path = os.path.join(img_dst_dir, file_name)
        if not os.path.exists(src_img_path):
            continue

        shutil.copy(src_img_path, dst_img_path)

        label_filename = os.path.splitext(file_name)[0] + ".txt"
        label_path = os.path.join(lbl_dst_dir, label_filename)

        lines = []
        for ann in anns:
            cat_id = ann["category_id"]
            bbox = ann["bbox"]  # [x_min, y_min, w, h]
            x_min, y_min, bw, bh = bbox

            num_boxes_before += 1

            area_rel = (bw * bh) / (width * height)
            if area_rel < min_rel_area:
                continue

            x_center = x_min + bw / 2.0
            y_center = y_min + bh / 2.0

            x_center /= width
            y_center /= height
            bw /= width
            bh /= height

            class_idx = cat_id_to_idx[cat_id]
            lines.append(f"{class_idx} {x_center} {y_center} {bw} {bh}")
            num_boxes_after += 1

        if not lines:
            if os.path.exists(dst_img_path):
                os.remove(dst_img_path)
            continue

        with open(label_path, "w") as lf:
            lf.write("\n".join(lines))

    print(f"[{split_name}] cajas antes de filtrar: {num_boxes_before}, después: {num_boxes_after}")
    return categories, cat_id_to_idx

def create_data_yaml(categories, yolo_base):
    class_names = [c["name"] for c in categories]
    data_yaml_path = os.path.join(yolo_base, "birds.yaml")

    data_yaml = f"""
path: {yolo_base}
train: images/train
val: images/val
test: images/test

names:
"""
    for i, name in enumerate(class_names):
        data_yaml += f"  {i}: {name}\n"

    with open(data_yaml_path, "w") as f:
        f.write(data_yaml)

    print("\n=== birds.yaml ===")
    print(open(data_yaml_path).read())
    print("==================")

def main():
    ensure_dirs()

    train_ann = os.path.join(TRAIN_DIR, "_annotations.coco.json")
    train_counts, id_to_name, categories_train = coco_class_distribution(train_ann)
    print("Número de clases:", len(categories_train))
    print("Top clases (por nº de anotaciones):")
    print(train_counts.sort_values(ascending=False).head(10))

    # Convertir train
    categories_train, cat_id_to_idx = coco_to_yolo_split(
        TRAIN_DIR, "train", YOLO_BASE, min_rel_area=0.001
    )
    # Convertir val/test con mismas categorías
    coco_to_yolo_split(VAL_DIR, "val", YOLO_BASE, cat_id_to_idx, categories_train, min_rel_area=0.001)
    coco_to_yolo_split(TEST_DIR, "test", YOLO_BASE, cat_id_to_idx, categories_train, min_rel_area=0.001)

    # Crear birds.yaml
    create_data_yaml(categories_train, YOLO_BASE)

if __name__ == "__main__":
    main()
