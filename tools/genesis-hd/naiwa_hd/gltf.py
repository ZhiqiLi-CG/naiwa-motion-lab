"""Read the character GLB (public/models/naiwa.glb, docs/character-contract.md): skeleton, skin, shape keys, colours.

Everything stays in glTF space here (meters, +Y up, the frog faces +Z); `space.py` converts to Genesis (+Z up).
"""

import dataclasses
import io
import pathlib

import numpy as np
import pygltflib
from PIL import Image

_COMPONENTS = {5120: np.int8, 5121: np.uint8, 5122: np.int16, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}
_WIDTHS = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}


@dataclasses.dataclass
class MeshPart:
    """One mesh object of the GLB in its bind pose."""

    name: str
    positions: np.ndarray  # (V, 3) float64
    faces: np.ndarray  # (F, 3) int64
    joints: np.ndarray  # (V, 4) indices into Rig.names
    weights: np.ndarray  # (V, 4), rows sum to 1
    morphs: dict[str, np.ndarray]  # shape key name -> (V, 3) position deltas
    colors: np.ndarray | None  # (V, 3) linear RGB vertex colours (COLOR_0)
    uvs: np.ndarray | None  # (V, 2) TEXCOORD_0, glTF convention (v down)
    texture: np.ndarray | None  # (H, W, 3|4) uint8 sRGB base colour image
    base_color: np.ndarray  # (4,) linear RGBA factor
    roughness: float
    metallic: float
    softness: np.ndarray | None  # (V,) the Body's `_softness` attribute


@dataclasses.dataclass
class Rig:
    """The skin's joints, in the order JOINTS_0 indexes them."""

    names: list[str]
    parents: list[int]  # -1 for the root
    rest_world: np.ndarray  # (B, 4, 4) bone world matrices in the rest pose
    rest_local: np.ndarray  # (B, 4, 4) local matrices relative to the parent bone
    inverse_bind: np.ndarray  # (B, 4, 4)

    def index(self, name: str) -> int:
        return self.names.index(name)


@dataclasses.dataclass
class Character:
    rig: Rig
    parts: dict[str, MeshPart]


def _trs(node) -> np.ndarray:
    if node.matrix:
        return np.array(node.matrix, dtype=np.float64).reshape(4, 4).T
    t = np.array(node.translation or (0, 0, 0), dtype=np.float64)
    x, y, z, w = node.rotation or (0, 0, 0, 1)
    s = np.array(node.scale or (1, 1, 1), dtype=np.float64)
    r = np.array(
        [
            [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
            [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
            [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
        ]
    )
    m = np.eye(4)
    m[:3, :3] = r * s
    m[:3, 3] = t
    return m


class _Reader:
    def __init__(self, gltf: pygltflib.GLTF2):
        self.gltf = gltf
        self.blob = gltf.binary_blob()

    def _view(self, view_idx, offset, dtype, count, width):
        view = self.gltf.bufferViews[view_idx]
        start = (view.byteOffset or 0) + offset
        item = np.dtype(dtype).itemsize * width
        stride = view.byteStride or item
        raw = np.frombuffer(self.blob, np.uint8, count=stride * (count - 1) + item, offset=start)
        rows = np.lib.stride_tricks.as_strided(raw, (count, item), (stride, 1))
        return rows.copy().view(dtype).reshape(count, width)

    def accessor(self, idx) -> np.ndarray:
        a = self.gltf.accessors[idx]
        dtype, width = _COMPONENTS[a.componentType], _WIDTHS[a.type]
        if a.bufferView is None:
            out = np.zeros((a.count, width), dtype)
        else:
            out = self._view(a.bufferView, a.byteOffset or 0, dtype, a.count, width)
        if a.sparse:
            s = a.sparse
            idx_type = _COMPONENTS[s.indices.componentType]
            rows = self._view(s.indices.bufferView, s.indices.byteOffset or 0, idx_type, s.count, 1)[:, 0]
            out = out.copy()
            out[rows] = self._view(s.values.bufferView, s.values.byteOffset or 0, dtype, s.count, width)
        if a.normalized:
            return out.astype(np.float64) / np.iinfo(dtype).max
        return out

    def image(self, texture_idx) -> np.ndarray:
        image = self.gltf.images[self.gltf.textures[texture_idx].source]
        view = self.gltf.bufferViews[image.bufferView]
        data = self.blob[(view.byteOffset or 0) : (view.byteOffset or 0) + view.byteLength]
        return np.array(Image.open(io.BytesIO(data)).convert("RGBA"))


def load(path: pathlib.Path) -> Character:
    gltf = pygltflib.GLTF2().load(str(path))
    reader = _Reader(gltf)
    if len(gltf.skins) != 1:
        raise ValueError(f"{path}: expected one skin, found {len(gltf.skins)}")
    skin = gltf.skins[0]
    joints = list(skin.joints)
    names = [gltf.nodes[j].name for j in joints]

    parent_node = {c: i for i, n in enumerate(gltf.nodes) for c in (n.children or [])}
    world = {}

    def node_world(i):
        if i not in world:
            local = _trs(gltf.nodes[i])
            world[i] = node_world(parent_node[i]) @ local if i in parent_node else local
        return world[i]

    parents = []
    for j in joints:
        p = parent_node.get(j)
        while p is not None and p not in joints:
            p = parent_node.get(p)
        parents.append(-1 if p is None else joints.index(p))
    rest_world = np.stack([node_world(j) for j in joints])
    rest_local = np.stack(
        [rest_world[b] if p < 0 else np.linalg.inv(rest_world[p]) @ rest_world[b] for b, p in enumerate(parents)]
    )
    inverse_bind = reader.accessor(skin.inverseBindMatrices).reshape(-1, 4, 4).transpose(0, 2, 1).astype(np.float64)
    rig = Rig(names, parents, rest_world, rest_local, inverse_bind)

    parts = {}
    for i, node in enumerate(gltf.nodes):
        if node.mesh is None:
            continue
        mesh = gltf.meshes[node.mesh]
        if len(mesh.primitives) != 1:
            raise ValueError(f"{path}: mesh {node.name} has {len(mesh.primitives)} primitives; one is expected")
        prim = mesh.primitives[0]
        attrs = prim.attributes
        # A skinned mesh's vertices are in the bind space of the skin; its node transform is ignored (glTF spec).
        positions = reader.accessor(attrs.POSITION).astype(np.float64)
        faces = reader.accessor(prim.indices).reshape(-1, 3).astype(np.int64)
        w = reader.accessor(attrs.WEIGHTS_0).astype(np.float64)
        w = w / np.maximum(w.sum(axis=1, keepdims=True), 1e-12)
        target_names = (mesh.extras or {}).get("targetNames", [])
        morphs = {}
        for k, target in enumerate(prim.targets or []):
            pos_idx = target["POSITION"] if isinstance(target, dict) else target.POSITION
            morphs[target_names[k] if k < len(target_names) else f"target{k}"] = reader.accessor(pos_idx).astype(
                np.float64
            )
        material = gltf.materials[prim.material] if prim.material is not None else None
        pbr = material.pbrMetallicRoughness if material else None
        texture = None
        if pbr and pbr.baseColorTexture is not None and attrs.TEXCOORD_0 is not None:
            texture = reader.image(pbr.baseColorTexture.index)
        extra = getattr(attrs, "_SOFTNESS", None)
        parts[node.name] = MeshPart(
            name=node.name,
            positions=positions,
            faces=faces,
            joints=reader.accessor(attrs.JOINTS_0).astype(np.int64),
            weights=w,
            morphs=morphs,
            colors=reader.accessor(attrs.COLOR_0)[:, :3].astype(np.float64) if attrs.COLOR_0 is not None else None,
            uvs=reader.accessor(attrs.TEXCOORD_0).astype(np.float64) if attrs.TEXCOORD_0 is not None else None,
            texture=texture,
            base_color=np.array(pbr.baseColorFactor if pbr else (1, 1, 1, 1), dtype=np.float64),
            roughness=float(pbr.roughnessFactor if pbr and pbr.roughnessFactor is not None else 0.5),
            metallic=float(pbr.metallicFactor if pbr and pbr.metallicFactor is not None else 0.0),
            softness=reader.accessor(extra)[:, 0].astype(np.float64) if extra is not None else None,
        )
    if "Body" not in parts:
        raise ValueError(f"{path}: no Body mesh (docs/character-contract.md)")
    return Character(rig, parts)
