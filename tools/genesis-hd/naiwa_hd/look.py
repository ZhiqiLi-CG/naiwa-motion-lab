"""The set and light of the HD render, clean so that the frog's motion and flesh are the subject: the browser stage's
colours (src/stage/palette.ts) on a plain floor that melts into the sky gradient, lit by the studio light panels the
browser's environment map is made of (src/stage/env.ts), here as a real HDR environment for the path tracer."""

import math
import pathlib

import cv2
import numpy as np
import trimesh
from PIL import Image

from . import surfaces


def srgb_hex(h: int) -> np.ndarray:
    """Linear RGB of an sRGB hex colour."""
    c = np.array([(h >> 16) & 255, (h >> 8) & 255, h & 255], dtype=np.float64) / 255.0
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


# src/stage/palette.ts (positions there are three.js world space: +Y up, the frog faces +Z).
THEMES = {
    "light": dict(
        sky_top=0x74C0EC, sky_horizon=0xE2F3F0, floor=0xEEF7F2, floor_dot=0xDCEFE7, pad=0xAEE0BC, pad_rim=0x8FCFA2,
        pad_vein=0xC3EACD, key_color=0xFFF1DC, key_intensity=3.2, env_intensity=0.55,
        env_top=0xBFE2FF, env_horizon=0xFFF4E6, env_ground=0x8FA597, dome=0.9,
        panels=[
            (0xFFF1DE, 5.0, (-3.2, 4.2, 3.6), (4, 3)),
            (0xE4F0FF, 1.1, (4.5, 1.8, 2.6), (3, 3)),
            (0xFFFFFF, 4.5, (1.5, 3.2, -4.8), (6, 1.6)),
            (0xFFFFFF, 1.4, (0, 6, 0), (3, 3)),
        ],
    ),
    "dark": dict(
        sky_top=0x161A40, sky_horizon=0x34336C, floor=0x2C2F60, floor_dot=0x34386D, pad=0x2F6C66, pad_rim=0x25574F,
        pad_vein=0x418A7E, key_color=0xFFF0DC, key_intensity=2.8, env_intensity=0.75,
        env_top=0x2A2F6E, env_horizon=0x5B4B80, env_ground=0x2C2442, dome=0.5,
        panels=[
            (0xFFF0DC, 4.6, (-3.2, 4.2, 3.6), (3.5, 3)),
            (0xBFC8FF, 1.1, (4.5, 1.8, 2.6), (3, 3)),
            (0x9FD8FF, 3.6, (0.5, 3.2, -4.8), (6, 1.6)),
        ],
    ),
}
# The browser's key light sits up and to the camera's left (stage/index.ts KEY_OFFSET), in the camera's heading frame.
KEY_OFFSET = np.array([-2.6, 3.4, 1.7])


def _smooth(a, b, x):
    t = np.clip((x - a) / (b - a), 0.0, 1.0)
    return t * t * (3 - 2 * t)
def floor_mesh(theme: str, out_dir: pathlib.Path, srgb: bool) -> tuple[pathlib.Path, pathlib.Path]:
    """OBJ (Genesis space, z = 0) of a clean round floor in the stage's floor colour that melts into the sky's horizon
    far away, and its texture (a 1D gradient along the radius)."""
    out_dir.mkdir(parents=True, exist_ok=True)
    th = THEMES[theme]
    k = 96
    ang = np.linspace(0, 2 * np.pi, k, endpoint=False)
    radii = [3.0, 9.0, 30.0]
    verts, uvs = [[0.0, 0.0, 0.0]], [[0.0, 0.5]]
    for i, rr in enumerate(radii):
        for a in ang:
            verts.append([rr * math.cos(a), rr * math.sin(a), 0.0])
            uvs.append([(i + 1) / len(radii), 0.5])
    faces = [[0, 1 + j, 1 + (j + 1) % k] for j in range(k)]
    for i in range(len(radii) - 1):
        for j in range(k):
            a0, a1 = 1 + i * k + j, 1 + i * k + (j + 1) % k
            faces += [[a0, a0 + k, a1 + k], [a0, a1 + k, a1]]
    mesh = trimesh.Trimesh(verts, faces, visual=trimesh.visual.TextureVisuals(uv=uvs), process=False)
    u = np.linspace(0, 1, 64)[None, :, None]
    fade = _smooth(1 / 3, 1.0, u) * 0.85
    tex = srgb_hex(th["floor"]) * (1 - fade) + srgb_hex(th["sky_horizon"]) * fade
    img_path = out_dir / f"floor_{theme}_{'srgb' if srgb else 'linear'}.png"
    Image.fromarray(surfaces.encode(np.repeat(tex, 4, axis=0), srgb)).save(img_path)
    obj_path = out_dir / "floor.obj"
    mesh.export(obj_path)
    return obj_path, img_path


def environment_hdr(theme: str, path: pathlib.Path, width: int = 2048) -> pathlib.Path:
    """Equirectangular HDR of the sky dome and the light panels (three.js world directions: +Y up). Column 0 looks
    along three.js -Z (behind the frog), longitude grows towards +X; row 0 is straight up."""
    th = THEMES[theme]
    hgt = width // 2
    lon = (np.arange(width) + 0.5) / width * 2 * np.pi - np.pi
    lat = np.pi / 2 - (np.arange(hgt) + 0.5) / hgt * np.pi
    lon, lat = np.meshgrid(lon, lat)
    d = np.stack([np.cos(lat) * np.sin(lon), np.sin(lat), -np.cos(lat) * np.cos(lon)], axis=-1)
    up = d[..., 1:2]
    top, hor, gnd = srgb_hex(th["env_top"]), srgb_hex(th["env_horizon"]), srgb_hex(th["env_ground"])
    sky = hor + (top - hor) * np.clip(up, 0, 1) ** 0.6
    ground = hor + (gnd - hor) * np.clip(-up * 4, 0, 1)
    img = np.where(up >= 0, sky, ground) * th["dome"]
    for color, intensity, pos, size in th["panels"]:
        p = np.array(pos, dtype=np.float64)
        dist = np.linalg.norm(p)
        centre = p / dist
        # A rectangular panel facing the origin, with soft edges: angular half sizes from its size and distance.
        right = np.cross([0, 1, 0], centre)
        right = right / np.linalg.norm(right) if np.linalg.norm(right) > 1e-6 else np.array([1.0, 0, 0])
        upv = np.cross(centre, right)
        u = np.einsum("hwk,k->hw", d, right) / np.maximum(np.einsum("hwk,k->hw", d, centre), 1e-6)
        v = np.einsum("hwk,k->hw", d, upv) / np.maximum(np.einsum("hwk,k->hw", d, centre), 1e-6)
        hu, hv = size[0] / 2 / dist, size[1] / 2 / dist
        front = np.einsum("hwk,k->hw", d, centre) > 0
        mask = front * (1 - _smooth(hu * 0.8, hu * 1.1, np.abs(u))) * (1 - _smooth(hv * 0.8, hv * 1.1, np.abs(v)))
        img = img + mask[..., None] * srgb_hex(color) * intensity
    path.parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(path), img.astype(np.float32)[..., ::-1])
    return path
