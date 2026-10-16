"""Colours of the character for Genesis, whose surfaces take one colour or one texture per mesh, never vertex colours.

The GLB paints its parts with vertex colours that are blends of two or three base colours (yellow and cream on the
Body, yellow and olive on the limbs). Such colours are an affine function of two coordinates, so they become UVs into
a small texture that holds that affine function: interpolating the UVs over a triangle then interpolates the colours
exactly as the browser does. A mesh whose colours span more (the Eyes: white, iris, pupil, lid) is split into its
connected pieces first, each of which is a plain blend again.
"""

import dataclasses

import numpy as np
import scipy.sparse
import scipy.sparse.csgraph

from .gltf import MeshPart

TEXTURE_SIZE = 32
# Largest colour error (linear RGB) accepted when dropping the third axis of a mesh's colours.
MAX_COLOR_RESIDUAL = 0.01


@dataclasses.dataclass
class Piece:
    """A part of a mesh with one texture: its vertices (indices into the MeshPart), faces into those, trimesh-style UVs
    (v up) and the texture as linear RGB floats (H, W, 3), row 0 at the top."""

    vertices: np.ndarray
    faces: np.ndarray
    uvs: np.ndarray
    texture: np.ndarray


def _affine_texture(colors: np.ndarray):
    """UVs and texture reproducing colours that lie (within MAX_COLOR_RESIDUAL) on a plane, else None."""
    mean = colors.mean(axis=0)
    _, _, axes = np.linalg.svd(colors - mean, full_matrices=False)
    axes = axes[:2]
    coords = (colors - mean) @ axes.T
    if np.abs(colors - mean - coords @ axes).max() > MAX_COLOR_RESIDUAL:
        return None
    lo = coords.min(axis=0)
    span = np.maximum(coords.max(axis=0) - lo, 1e-6)
    ab = (coords - lo) / span
    n = TEXTURE_SIZE
    uvs = (0.5 + (n - 1) * ab) / n
    a = np.arange(n) / (n - 1)
    b = (n - 1 - np.arange(n)) / (n - 1)  # image rows run downwards, v upwards
    grid = np.stack(np.meshgrid(a, b), axis=-1)  # grid[row, col] = (a[col], b[row])
    texture = mean + (lo + grid * span) @ axes
    return uvs, np.clip(texture, 0.0, 1.0)


def _pieces_by_component(part: MeshPart) -> list[np.ndarray]:
    n = len(part.positions)
    f = part.faces
    edges = np.concatenate([f[:, [0, 1]], f[:, [1, 2]], f[:, [2, 0]]])
    graph = scipy.sparse.coo_matrix((np.ones(len(edges)), (edges[:, 0], edges[:, 1])), shape=(n, n))
    _, labels = scipy.sparse.csgraph.connected_components(graph, directed=False)
    return [np.flatnonzero(labels == k) for k in range(labels.max() + 1)]


def _piece(part: MeshPart, vertices: np.ndarray, uvs: np.ndarray, texture: np.ndarray) -> Piece:
    remap = -np.ones(len(part.positions), dtype=np.int64)
    remap[vertices] = np.arange(len(vertices))
    faces = remap[part.faces]
    faces = faces[(faces >= 0).all(axis=1)]
    return Piece(vertices, faces, uvs, texture)


def pieces(part: MeshPart) -> list[Piece]:
    if part.texture is not None:
        # glTF UVs run downwards from the image's top left; trimesh's run upwards.
        uvs = np.column_stack([part.uvs[:, 0], 1.0 - part.uvs[:, 1]])
        srgb = part.texture[..., :3] / 255.0
        linear = np.where(srgb <= 0.04045, srgb / 12.92, ((srgb + 0.055) / 1.055) ** 2.4)
        return [_piece(part, np.arange(len(part.positions)), uvs, linear * part.base_color[:3])]
    colors = part.colors * part.base_color[:3] if part.colors is not None else None
    if colors is None:
        flat = np.broadcast_to(part.base_color[:3], (1, 1, 3)).copy()
        return [_piece(part, np.arange(len(part.positions)), np.full((len(part.positions), 2), 0.5), flat)]
    whole = _affine_texture(colors)
    if whole is not None:
        return [_piece(part, np.arange(len(part.positions)), *whole)]
    out = []
    for vertices in _pieces_by_component(part):
        fit = _affine_texture(colors[vertices])
        if fit is None:
            raise ValueError(f"{part.name}: a connected piece blends more than three colours")
        out.append(_piece(part, vertices, *fit))
    return out


def encode(texture_linear: np.ndarray, srgb: bool) -> np.ndarray:
    """uint8 image of a linear texture, sRGB-encoded for renderers that decode it (the rasterizer) or kept linear."""
    t = np.clip(texture_linear, 0.0, 1.0)
    if srgb:
        t = np.where(t <= 0.0031308, 12.92 * t, 1.055 * t ** (1 / 2.4) - 0.055)
    return np.round(t * 255).astype(np.uint8)
