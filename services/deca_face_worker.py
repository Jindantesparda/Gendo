"""Build a canonical DECA face animation sequence from a video.

The worker runs DECA on every frame, keeps the per-frame expression/jaw pose,
removes DECA's global head rotation, and exports:

  deca_face.npz          neutral head + per-frame face shapes + FLAME skinning
  deca_face_texture.png  UV texture from the most frontal frame
  deca_face_meta.json    frame count / fps / reference frame

The output is consumed by services/blender_fuse_head.py.
"""
import argparse
import json
import os
import shutil
import sys
import time
from pathlib import Path

import numpy as np

# DECA's FLAME pickle imports chumpy, which still uses the old NumPy aliases.
_aliases = {
    "bool": bool,
    "int": int,
    "float": float,
    "complex": complex,
    "object": object,
    "str": str,
    "unicode": str,
}
for _name, _value in _aliases.items():
    if _name not in np.__dict__:
        setattr(np, _name, _value)

import cv2
import torch

# The worker is launched with the DECA repo as its working directory.
sys.path.insert(0, os.getcwd())

from decalib.deca import DECA
from decalib.datasets import datasets
from decalib.utils import util
from decalib.utils.config import cfg as deca_cfg


def extract_frames(video_path, frames_dir):
    """Decode a video into zero-padded JPEG frames using OpenCV."""
    frames_dir.mkdir(parents=True, exist_ok=True)
    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        raise RuntimeError(f"Could not open video: {video_path}")
    fps = float(cap.get(cv2.CAP_PROP_FPS) or 30.0)
    declared = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    paths = []
    index = 0
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        path = frames_dir / f"frame_{index:06d}.jpg"
        if not cv2.imwrite(str(path), frame):
            raise RuntimeError(f"Could not write extracted frame: {path}")
        paths.append(str(path))
        index += 1
        if index % 25 == 0:
            print(f"[deca-face] decoded {index}/{declared or '?'} frames", flush=True)
    cap.release()
    if not paths:
        raise RuntimeError(f"No frames decoded from: {video_path}")
    return paths, fps


def complete_texture_background(texture):
    """Replace DECA's flat UV background with skin so scalp/neck are not white."""
    image = texture.copy()
    border = np.concatenate([
        image[:4].reshape(-1, 3),
        image[-4:].reshape(-1, 3),
        image[:, :4].reshape(-1, 3),
        image[:, -4:].reshape(-1, 3),
    ], axis=0)
    background_color = np.median(border, axis=0)
    distance = np.max(np.abs(image.astype(np.float32) - background_color[None, None, :]), axis=2)
    background_pixels = distance < 10.0
    labels_count, labels = cv2.connectedComponents(background_pixels.astype(np.uint8), connectivity=8)
    border_labels = set(labels[0].tolist()) | set(labels[-1].tolist())
    border_labels |= set(labels[:, 0].tolist()) | set(labels[:, -1].tolist())
    border_labels.discard(0)
    if border_labels:
        fill_mask = np.isin(labels, list(border_labels))
    else:
        fill_mask = background_pixels
    # Eat a couple of pixels into the UV island to cover the pale antialiased
    # fringe that otherwise renders as a bright seam around the face.
    fill_mask = cv2.dilate(
        fill_mask.astype(np.uint8),
        np.ones((3, 3), dtype=np.uint8),
        iterations=2,
    ).astype(bool)

    b, g, r = image[:, :, 0].astype(np.int16), image[:, :, 1].astype(np.int16), image[:, :, 2].astype(np.int16)
    skin_mask = (r > b + 8) & (r > g - 4) & (r > 40) & (~fill_mask)
    if not skin_mask.any():
        skin_color = np.array([150, 175, 200], dtype=np.float32)  # BGR fallback
    else:
        skin_color = np.median(image[skin_mask], axis=0)

    if fill_mask.any():
        image[fill_mask] = np.clip(skin_color, 0, 255).astype(np.uint8)
    print(
        f"[deca-face] texture fill: background {background_color.astype(int).tolist()} -> "
        f"skin {np.clip(skin_color, 0, 255).astype(int).tolist()} "
        f"({fill_mask.mean() * 100:.1f}% of atlas)",
        flush=True,
    )
    return image


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--video", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--temp", default=None, help="Directory for extracted frames")
    parser.add_argument("--device", default="cuda")
    parser.add_argument("--keep-frames", action="store_true")
    parser.add_argument("--max-frames", type=int, default=0, help="0 means all frames")
    parser.add_argument(
        "--identity",
        choices=["reference", "median", "mean"],
        default="reference",
        help="Which per-frame identity code becomes the head shape",
    )
    args = parser.parse_args()

    started = time.time()
    out_dir = Path(args.output)
    out_dir.mkdir(parents=True, exist_ok=True)
    temp_dir = Path(args.temp) if args.temp else out_dir / "_frames"
    if temp_dir.exists():
        shutil.rmtree(temp_dir)
    temp_dir.mkdir(parents=True, exist_ok=True)

    print(f"[deca-face] Input: {args.video}", flush=True)
    frame_paths, source_fps = extract_frames(Path(args.video), temp_dir)
    if args.max_frames and len(frame_paths) > args.max_frames:
        frame_paths = frame_paths[: args.max_frames]
    print(f"[deca-face] {len(frame_paths)} frames at {source_fps:.3f} fps", flush=True)

    deca_cfg.model.use_tex = False
    deca_cfg.rasterizer_type = "pytorch3d"
    deca = DECA(config=deca_cfg, device=args.device)
    testdata = datasets.TestData(frame_paths, iscrop=True, face_detector="fan")

    shapes = []
    expressions = []
    poses = []
    ref_index = 0
    ref_score = float("inf")
    for index in range(len(frame_paths)):
        item = testdata[index]
        image = item["image"].to(args.device)[None, ...]
        with torch.no_grad():
            codedict = deca.encode(image, use_detail=False)
        shape = codedict["shape"].detach().cpu().numpy()[0]
        exp = codedict["exp"].detach().cpu().numpy()[0]
        pose = codedict["pose"].detach().cpu().numpy()[0]
        shapes.append(shape)
        expressions.append(exp)
        poses.append(pose)
        head_angle = float(np.linalg.norm(pose[:3]))
        if head_angle < ref_score:
            ref_score = head_angle
            ref_index = index
        if index % 10 == 0 or index == len(frame_paths) - 1:
            print(
                f"[deca-face] encoded {index + 1}/{len(frame_paths)} "
                f"(frontal ref {ref_index}, angle {ref_score:.3f})",
                flush=True,
            )

    shapes = np.stack(shapes).astype(np.float32)
    expressions = np.stack(expressions).astype(np.float32)
    poses = np.stack(poses).astype(np.float32)
    if args.identity == "mean":
        identity_shape = shapes.mean(axis=0, keepdims=True)
    elif args.identity == "median":
        identity_shape = np.median(shapes, axis=0, keepdims=True)
    else:
        identity_shape = shapes[ref_index:ref_index + 1]
    print(
        f"[deca-face] identity shape: {args.identity} "
        f"(frame {ref_index}, angle {ref_score:.3f})",
        flush=True,
    )
    eye_pose = torch.zeros((1, 6), dtype=torch.float32, device=args.device)
    shape_t = torch.from_numpy(identity_shape).to(args.device)
    zero_exp = torch.zeros((1, expressions.shape[1]), dtype=torch.float32, device=args.device)
    zero_pose = torch.zeros((1, 6), dtype=torch.float32, device=args.device)

    with torch.no_grad():
        base_vertices, _, _ = deca.flame(
            shape_params=shape_t,
            expression_params=zero_exp,
            pose_params=zero_pose,
            eye_pose_params=eye_pose,
        )

    # Keep facial expression and jaw motion, but remove DECA's global head
    # rotation so the GVHMR head bone owns all neck/head motion.
    canonical_poses = poses.copy()
    canonical_poses[:, :3] = 0.0
    frame_vertices = []
    batch = 32
    exp_t = torch.from_numpy(expressions).to(args.device)
    pose_t = torch.from_numpy(canonical_poses).to(args.device)
    with torch.no_grad():
        for start in range(0, len(frame_paths), batch):
            end = min(len(frame_paths), start + batch)
            count = end - start
            verts, _, _ = deca.flame(
                shape_params=shape_t.repeat(count, 1),
                expression_params=exp_t[start:end],
                pose_params=pose_t[start:end],
                eye_pose_params=torch.zeros((count, 6), dtype=torch.float32, device=args.device),
            )
            frame_vertices.append(verts.detach().cpu().numpy().astype(np.float32))
            print(f"[deca-face] shaped {end}/{len(frame_paths)}", flush=True)
    frame_vertices = np.concatenate(frame_vertices, axis=0)

    # Decode the most frontal frame once for its UV texture.
    ref_item = testdata[ref_index]
    ref_image = ref_item["image"].to(args.device)[None, ...]
    with torch.no_grad():
        ref_codedict = deca.encode(ref_image, use_detail=True)
        ref_opdict, _ = deca.decode(
            ref_codedict,
            rendering=True,
            vis_lmk=False,
            return_vis=True,
            use_detail=True,
        )
    texture = util.tensor2image(ref_opdict["uv_texture_gt"][0])
    cv2.imwrite(str(out_dir / "deca_face_texture_raw.png"), texture)
    texture = complete_texture_background(texture)
    texture_path = out_dir / "deca_face_texture.png"
    cv2.imwrite(str(texture_path), texture)

    faces = deca.flame.faces_tensor.detach().cpu().numpy().astype(np.int32)
    uv_coords = deca.render.raw_uvcoords[0].detach().cpu().numpy().astype(np.float32)
    uv_faces = deca.render.uvfaces[0].detach().cpu().numpy().astype(np.int32)
    weights = deca.flame.lbs_weights.detach().cpu().numpy().astype(np.float32)
    joints = (deca.flame.J_regressor @ base_vertices[0]).detach().cpu().numpy().astype(np.float32)

    npz_path = out_dir / "deca_face.npz"
    np.savez_compressed(
        npz_path,
        base_vertices=base_vertices[0].cpu().numpy().astype(np.float32),
        frame_vertices=frame_vertices,
        faces=faces,
        uv_coords=uv_coords,
        uv_faces=uv_faces,
        weights=weights,
        joints=joints,
        frame_count=np.int32(len(frame_paths)),
        fps=np.float32(source_fps),
    )
    meta = {
        "source_video": str(Path(args.video).resolve()),
        "frame_count": int(len(frame_paths)),
        "fps": float(source_fps),
        "reference_frame": int(ref_index),
        "identity": args.identity,
        "texture": texture_path.name,
        "duration_seconds": round(float(len(frame_paths) / source_fps), 4),
        "elapsed_seconds": round(time.time() - started, 2),
    }
    (out_dir / "deca_face_meta.json").write_text(json.dumps(meta, indent=2), encoding="utf8")

    if not args.keep_frames:
        shutil.rmtree(temp_dir, ignore_errors=True)
    print(f"[deca-face] Saved {npz_path}", flush=True)
    print(f"[deca-face] Texture {texture_path}", flush=True)
    print(f"[deca-face] Done in {time.time() - started:.1f}s", flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"[deca-face] ERROR: {exc}", file=sys.stderr, flush=True)
        raise
