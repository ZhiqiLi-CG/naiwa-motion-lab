"""Generate a dance with HY-Motion 1.0 (Tencent, text to 3D human motion) and write it as MediaPipe-style landmarks,
the same per-frame format as a PoseLandmarker run, so tools/dances/add.mjs cleans and loops it like a video's track.

Run with the HY-Motion env (see tools/dances/SOURCES.md), on the GPU through the machine's GPU policy:
  python tools/dances/hy_motion.py --code <HY-Motion-1.0 checkout with ckpts/> --prompt "..." --seconds 6 --seed 3 \
      --out .cache/dances/<id>/raw-generated.json
"""

import argparse
import json
import os
import sys

import numpy as np
import torch
import yaml


def landmark_sources(v, j, names):
    """Which template vertex or joint stands for each of MediaPipe's 33 pose landmarks (T-pose template: +Y up, facing
    +Z, +X the body's left). Face, heels and toes are surface points; the rest are joints."""
    J = {n: i for i, n in enumerate(names)}
    head = v[v[:, 1] > j[J["Neck"], 1] + 0.05]
    head_idx = np.nonzero(v[:, 1] > j[J["Neck"], 1] + 0.05)[0]

    def front(x, y, r=0.012):
        """Front-most head vertex near (x, y)."""
        near = np.nonzero((np.abs(head[:, 0] - x) < r) & (np.abs(head[:, 1] - y) < r))[0]
        return ("v", int(head_idx[near[np.argmax(head[near, 2])]]))

    mid = np.nonzero(np.abs(head[:, 0]) < 0.01)[0]
    nose = mid[np.argmax(head[mid, 2])]
    ny = head[nose, 1]
    ey = ny + 0.035
    band = np.nonzero(np.abs(head[:, 1] - (ey - 0.015)) < 0.02)[0]
    ear_l = head_idx[band[np.argmax(head[band, 0])]]
    ear_r = head_idx[band[np.argmin(head[band, 0])]]

    def foot(side):
        a, f = j[J[f"{side}_Ankle"]], j[J[f"{side}_Foot"]]
        heel = np.nonzero((np.abs(v[:, 0] - a[0]) < 0.03) & (v[:, 1] < a[1] + 0.01))[0]
        toe = np.nonzero((np.abs(v[:, 0] - f[0]) < 0.03) & (v[:, 1] < f[1] + 0.03))[0]
        return ("v", int(heel[np.argmin(v[heel, 2])])), ("v", int(toe[np.argmax(v[toe, 2])]))

    heel_l, toe_l = foot("L")
    heel_r, toe_r = foot("R")
    jt = lambda n: ("j", J[n])  # noqa: E731
    return [
        ("v", int(head_idx[nose])),
        front(0.018, ey), front(0.032, ey), front(0.048, ey),  # left eye inner, eye, outer
        front(-0.018, ey), front(-0.032, ey), front(-0.048, ey),
        ("v", int(ear_l)), ("v", int(ear_r)),
        front(0.022, ny - 0.045), front(-0.022, ny - 0.045),  # mouth left, right
        jt("L_Shoulder"), jt("R_Shoulder"), jt("L_Elbow"), jt("R_Elbow"), jt("L_Wrist"), jt("R_Wrist"),
        jt("L_Pinky1"), jt("R_Pinky1"), jt("L_Index1"), jt("R_Index1"), jt("L_Thumb2"), jt("R_Thumb2"),
        jt("L_Hip"), jt("R_Hip"), jt("L_Knee"), jt("R_Knee"), jt("L_Ankle"), jt("R_Ankle"),
        heel_l, heel_r, toe_l, toe_r,
    ]


def to_mediapipe(points, root_rot0, aspect, distance=4.5, cam_height=1.0, frame_height=0.55):
    """points: (L, 33, 3) world, +Y up. A camera fixed in front of where the body faces on the first frame stands for
    the video camera: world landmarks are in its axes (x right, y down, z away from it) around each frame's hip
    midpoint, image landmarks are its perspective view (a 1.7 m body fills about frame_height of the frame)."""
    fwd0 = root_rot0 @ np.array([0.0, 0.0, 1.0])
    fwd0[1] = 0
    fwd0 /= np.linalg.norm(fwd0)
    right = np.cross(np.array([0.0, 1.0, 0.0]), fwd0)  # the body's left, seen on the image right
    right /= np.linalg.norm(right)
    axes = np.stack([right, np.array([0.0, -1.0, 0.0]), -fwd0])  # rows: camera x, y, z
    hips = (points[:, 23] + points[:, 24]) / 2
    world = np.einsum("ij,lnj->lni", axes, points - hips[:, None])
    centre = hips[0].copy()
    centre[1] = cam_height
    cam = centre + fwd0 * distance
    pc = np.einsum("ij,lnj->lni", axes, points - cam)
    f = frame_height * distance / 1.7
    hip_z = (pc[:, 23, 2] + pc[:, 24, 2]) / 2
    u = 0.5 + f * pc[..., 0] / pc[..., 2] / aspect
    w = 0.5 + f * pc[..., 1] / pc[..., 2]
    z = (pc[..., 2] - hip_z[:, None]) * f / aspect / hip_z[:, None]
    image = np.stack([u, w, z], -1)
    return world, image


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--code", required=True)
    ap.add_argument("--model", default="HY-Motion-1.0")
    ap.add_argument("--prompt", required=True)
    ap.add_argument("--seconds", type=float, required=True)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--cfg", type=float, default=5.0)
    ap.add_argument("--aspect", type=float, default=16 / 9)
    ap.add_argument("--llm-8bit", action="store_true", help="Qwen3-8B text encoder in 8 bits (about 9 GB instead of 16)")
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    out = os.path.abspath(a.out)
    os.chdir(a.code)  # the checkout's code loads its text encoders and body model from relative paths
    sys.path.insert(0, a.code)
    from hymotion.network.text_encoders import text_encoder as te
    from hymotion.pipeline.body_model import WoodenMesh
    from hymotion.utils.loaders import load_object

    dev = torch.device("cuda:0")
    cfg_path = f"ckpts/tencent/{a.model}/config.yml"
    with open(cfg_path) as fh:
        config = yaml.load(fh, Loader=yaml.FullLoader)

    # 1. Text features, then free the text encoder before the motion model comes in.
    if a.llm_8bit:
        from transformers import AutoModelForCausalLM, BitsAndBytesConfig

        class Qwen8bit:
            @staticmethod
            def from_pretrained(path, **kw):
                kw.pop("torch_dtype", None)
                return AutoModelForCausalLM.from_pretrained(
                    path, quantization_config=BitsAndBytesConfig(load_in_8bit=True), device_map={"": 0},
                    torch_dtype=torch.bfloat16, **kw)

        te.LLM_ENCODER_LAYOUT["qwen3"]["text_encoder_class"] = Qwen8bit
    args = config["train_pipeline_args"]
    text_model = te.HYTextModel(**args.get("text_encoder_cfg", {}))
    if not a.llm_8bit:
        text_model.to(dev)
    else:
        text_model.sentence_emb_text_encoder.to(dev)
    with torch.no_grad():
        vtxt, ctxt, clen = text_model.encode(text=[a.prompt])
    hidden = {"text_vec_raw": vtxt.to(dev).float(), "text_ctxt_raw": ctxt.to(dev).float(),
              "text_ctxt_raw_length": clen.to(dev)}
    del text_model
    torch.cuda.empty_cache()

    # 2. Motion.
    pipeline = load_object(config["train_pipeline"], args, network_module=config["network_module"],
                           network_module_args=config["network_module_args"])
    pipeline.load_in_demo(f"ckpts/tencent/{a.model}/latest.ckpt", build_text_encoder=False)
    pipeline.to(dev).eval()
    res = pipeline.generate(a.prompt, [a.seed], a.seconds, cfg_scale=a.cfg, hidden_state_dict=hidden)
    rot6d, transl = res["rot6d"][0], res["transl"][0]
    fps = pipeline.output_mesh_fps

    # 3. Landmarks from the posed template.
    body = WoodenMesh()
    with torch.no_grad():
        posed = body.forward({"rot6d": rot6d, "trans": transl})
    verts = posed["vertices"].numpy()
    joints = posed["keypoints3d"].numpy() + transl.numpy()[:, None]
    src = landmark_sources(body.v_template.numpy(), body.j_template.numpy(), body.joint_names)
    pts = np.stack([verts[:, i] if k == "v" else joints[:, i] for k, i in src], 1)
    world, image = to_mediapipe(pts, res["root_rotations_mat"][0, 0].numpy(), a.aspect)
    frames = []
    for i in range(len(pts)):
        frames.append({
            "world": [[float(x) for x in p] + [1.0] for p in world[i]],
            "image": [[float(x) for x in p] + [1.0] for p in image[i]],
        })
    with open(out, "w") as fh:
        json.dump({"fps": fps, "aspect": a.aspect, "frames": frames}, fh)
    print(f"wrote {out}: {len(frames)} frames at {fps} fps")


if __name__ == "__main__":
    main()
