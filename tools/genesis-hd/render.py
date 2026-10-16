"""Render a Naiwa Motion Lab session in high quality with Genesis.

    <python> tools/genesis-hd/render.py session.json -o out.mp4 [--audio browser-clip.mp4] [--renderer nyx|raster]

The session (src/session/format.ts) is what the browser recorded next to its video: the skeleton, camera, faces,
balls and pokes of every frame. This rebuilds the shot in Genesis 1.4.2 with the character GLB, simulates the whole
frog's flesh as FEM soft bodies over the recorded skeleton, and renders it with the Nyx path tracer where it is
installed (CUDA), else with Genesis's rasterizer.
"""

import argparse
import ctypes
import importlib.util
import pathlib
import subprocess
import sys
import time

import numpy as np
import torch
from PIL import Image

import genesis as gs

from naiwa_hd import gltf, overlay, rig, scene
from naiwa_hd.session import Session

REPO = pathlib.Path(__file__).resolve().parents[2]


def preload_nvrtc_builtins():
    """The CUDA 13 torch wheels ship NVRTC without a RUNPATH to its builtins library, so TorchScript's fused kernels
    (Genesis's scripted geometry, e.g. camera poses) fail to compile; loading the library first lets NVRTC find it.
    (Same work-around as RobotGen Studio's genesis_runtime.)"""
    for lib in sorted((pathlib.Path(torch.__file__).parents[1] / "nvidia").glob("*/lib/libnvrtc-builtins.so.*")):
        if ".alt." not in lib.name:
            ctypes.CDLL(str(lib), mode=ctypes.RTLD_GLOBAL)


def nyx_available() -> bool:
    return importlib.util.find_spec("gs_nyx_plugin") is not None and torch.cuda.is_available()


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("session", type=pathlib.Path)
    ap.add_argument("-o", "--out", type=pathlib.Path, required=True)
    ap.add_argument("--glb", type=pathlib.Path, default=REPO / "public/models/naiwa.glb")
    ap.add_argument("--renderer", choices=("auto", "nyx", "raster"), default="auto")
    ap.add_argument("--height", type=int, default=1080, help="output height in pixels (width follows the session)")
    ap.add_argument("--fps", type=int, default=60)
    ap.add_argument("--spp", type=int, default=64, help="path-tracing samples per pixel (Nyx)")
    ap.add_argument("--steps-per-frame", type=int, default=8, help="simulation steps per output frame")
    ap.add_argument("--substeps", type=int, default=1, help="FEM substeps per simulation step")
    ap.add_argument("--pcg-iterations", type=int, default=200, help="most PCG iterations of each implicit FEM solve")
    ap.add_argument("--start", type=float, default=0.0, help="first second of the session to render")
    ap.add_argument("--end", type=float, default=None, help="last second of the session to render")
    ap.add_argument("--audio", type=pathlib.Path, help="the browser clip whose sound track to put under the video")
    ap.add_argument("--frames", type=pathlib.Path, help="also save every frame as PNG here")
    ap.add_argument("--no-watermark", action="store_true")
    ap.add_argument("--cache", type=pathlib.Path, default=REPO / ".cache/genesis-hd/build")
    args = ap.parse_args(argv)

    renderer = args.renderer
    if renderer == "auto":
        renderer = "nyx" if nyx_available() else "raster"
    if renderer == "nyx" and not nyx_available():
        sys.exit("Nyx needs gs-nyx-plugin and a CUDA build of torch in this Python environment")

    session = Session.load(args.session)
    if args.start or args.end is not None:
        session = session.window(args.start, args.end)
    aspect = session.cam_lens[0][1]
    height = args.height
    width = int(round(height * aspect / 2)) * 2
    character = rig.to_genesis(gltf.load(args.glb))

    if torch.cuda.is_available():
        preload_nvrtc_builtins()
    gs.init(backend=gs.gpu if torch.cuda.is_available() else gs.cpu, precision="32", logging_level="warning")
    settings = scene.Settings(
        renderer=renderer, width=width, height=height, fps=args.fps, steps_per_frame=args.steps_per_frame,
        substeps=args.substeps, pcg_iterations=args.pcg_iterations, spp=args.spp, settle=0.6,
    )
    args.cache.mkdir(parents=True, exist_ok=True)
    hd = scene.HDScene(character, session, settings, args.cache)
    hd.build()

    args.out.parent.mkdir(parents=True, exist_ok=True)
    if args.frames:
        args.frames.mkdir(parents=True, exist_ok=True)
    video = args.out.with_suffix(".video.mp4") if args.audio else args.out
    ff = subprocess.Popen(
        ["ffmpeg", "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{width}x{height}",
         "-r", str(args.fps), "-i", "-", "-c:v", "libx264", "-preset", "slow", "-crf", "16", "-pix_fmt", "yuv420p",
         "-movflags", "+faststart", str(video)],
        stdin=subprocess.PIPE,
    )
    mark = None if args.no_watermark else overlay.Watermark(width, height)
    t0 = time.time()

    def on_frame(i, rgb):
        t = i / args.fps
        img = rgb if mark is None else mark.draw(rgb)
        ff.stdin.write(np.ascontiguousarray(img).tobytes())
        if args.frames:
            Image.fromarray(img).save(args.frames / f"{i:05d}.png")
        if i % args.fps == 0:
            print(f"  t = {t:5.2f} s  ({time.time() - t0:.0f} s elapsed)", flush=True)

    timer = hd.run(on_frame)
    ff.stdin.close()
    ff.wait()
    if args.audio:
        subprocess.run(
            ["ffmpeg", "-y", "-loglevel", "error", "-i", str(video), "-ss", str(args.start), "-i", str(args.audio),
             "-map", "0:v", "-map", "1:a?", "-c:v", "copy", "-c:a", "aac", "-shortest", str(args.out)],
            check=True,
        )
        video.unlink()
    gs.destroy()
    n = int(session.duration * args.fps) + 1
    print(
        f"{args.out}: {n} frames {width}x{height} @ {args.fps} fps with {renderer}; "
        f"simulation {timer['sim']:.0f} s, rendering {timer['render']:.0f} s, total {time.time() - t0:.0f} s"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
