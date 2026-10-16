"""The character in Genesis space, split into the pieces Genesis builds: flesh parts (Body, each arm, each leg) and
the driven face parts (eyes, mouth inside), with the bones each piece rides on."""

import dataclasses

import numpy as np
import scipy.sparse
import scipy.sparse.csgraph

from . import skin
from .gltf import Character, MeshPart, Rig

# Which bones each flesh part rides on (fingers belong to the hand they hang from).
PART_BONES = {
    "body": ("hips", "spine", "chest", "head"),
    "arm_L": ("upperarm_L", "forearm_L", "hand_L", "thumb_L", "index_L", "middle_L", "ring_L"),
    "arm_R": ("upperarm_R", "forearm_R", "hand_R", "thumb_R", "index_R", "middle_R", "ring_R"),
    "leg_L": ("thigh_L", "shin_L", "foot_L"),
    "leg_R": ("thigh_R", "shin_R", "foot_R"),
}
HAND_BONES = {"hand", "thumb", "index", "middle", "ring"}


def to_genesis(c: Character) -> Character:
    """The same character with every position and matrix in Genesis space (+Z up, facing -Y)."""
    r = c.rig
    rig = Rig(
        names=r.names,
        parents=r.parents,
        rest_world=skin.matrices_to_genesis(r.rest_world),
        rest_local=skin.matrices_to_genesis(r.rest_local),
        inverse_bind=skin.matrices_to_genesis(r.inverse_bind),
    )
    parts = {
        name: dataclasses.replace(
            p,
            positions=skin.points_to_genesis(p.positions),
            morphs={k: skin.points_to_genesis(d) for k, d in p.morphs.items()},
        )
        for name, p in c.parts.items()
    }
    return Character(rig, parts)


def components(part: MeshPart) -> list[np.ndarray]:
    """Vertex indices of each connected piece of a mesh (welded by position: seams split vertices)."""
    _, weld = np.unique(np.round(part.positions / 1e-6).astype(np.int64), axis=0, return_inverse=True)
    weld = weld.reshape(-1)
    f = weld[part.faces]
    edges = np.concatenate([f[:, [0, 1]], f[:, [1, 2]], f[:, [2, 0]]])
    m = weld.max() + 1
    graph = scipy.sparse.coo_matrix((np.ones(len(edges)), (edges[:, 0], edges[:, 1])), shape=(m, m))
    _, labels = scipy.sparse.csgraph.connected_components(graph, directed=False)
    labels = labels[weld]
    return [np.flatnonzero(labels == k) for k in np.unique(labels)]


def subpart(part: MeshPart, vertices: np.ndarray, name: str) -> MeshPart:
    remap = -np.ones(len(part.positions), dtype=np.int64)
    remap[vertices] = np.arange(len(vertices))
    faces = remap[part.faces]
    faces = faces[(faces >= 0).all(axis=1)]

    def pick(a):
        return None if a is None else a[vertices]

    return dataclasses.replace(
        part,
        name=name,
        positions=part.positions[vertices],
        faces=faces,
        joints=part.joints[vertices],
        weights=part.weights[vertices],
        morphs={k: d[vertices] for k, d in part.morphs.items()},
        colors=pick(part.colors),
        uvs=pick(part.uvs),
        softness=pick(part.softness),
    )


def split_limbs(part: MeshPart, prefix: str) -> list[MeshPart]:
    """Each closed shell of Arms / Legs as its own part, named by side (_L is +X)."""
    out = []
    for verts in components(part):
        side = "L" if part.positions[verts, 0].mean() > 0 else "R"
        out.append(subpart(part, verts, f"{prefix}_{side}"))
    return out


def bone_segments(rig: Rig) -> tuple[np.ndarray, np.ndarray]:
    """Rest head and tail of every bone (B, 3) in Genesis space: the tail is the mean head of its children, or for an
    end bone its head pushed along the bone's direction by 60% of its parent's length. A Blender export points bones
    along their local +Y, which `to_genesis` turned into local +Z."""
    heads = rig.rest_world[:, :3, 3]
    tails = heads.copy()
    for b in range(len(rig.names)):
        kids = [k for k, p in enumerate(rig.parents) if p == b]
        if kids:
            tails[b] = heads[kids].mean(axis=0)
        else:
            p = rig.parents[b]
            length = 0.6 * np.linalg.norm(heads[b] - heads[p]) if p >= 0 else 0.05
            tails[b] = heads[b] + rig.rest_world[b, :3, 2] * max(length, 0.01)
    return heads, tails


def nearest_bone(points: np.ndarray, rig: Rig, bones: tuple[str, ...]) -> np.ndarray:
    """Index (into rig.names) of the bone segment nearest to each point."""
    heads, tails = bone_segments(rig)
    idx = np.array([rig.index(b) for b in bones if b in rig.names])
    a, b = heads[idx], tails[idx]
    ab = b - a
    t = np.clip(np.einsum("pbk,bk->pb", points[:, None, :] - a[None], ab) / np.maximum((ab * ab).sum(1), 1e-12), 0, 1)
    closest = a[None] + t[..., None] * ab[None]
    d = np.linalg.norm(points[:, None, :] - closest, axis=-1)
    return idx[np.argmin(d, axis=1)]


def is_hand_bone(name: str) -> bool:
    return name.split("_")[0] in HAND_BONES


def disjoint_groups(part: MeshPart) -> list[np.ndarray]:
    """The connected pieces of a mesh gathered into groups whose bounding boxes do not touch, so that each group can
    be filled with cells as one body (pieces inside one another, like an iris in an eye, go to different groups)."""
    groups: list[tuple[list[np.ndarray], list[tuple[np.ndarray, np.ndarray]]]] = []
    for verts in components(part):
        lo, hi = part.positions[verts].min(axis=0), part.positions[verts].max(axis=0)
        for members, boxes in groups:
            if all((hi < b_lo).any() or (lo > b_hi).any() for b_lo, b_hi in boxes):
                members.append(verts)
                boxes.append((lo, hi))
                break
        else:
            groups.append(([verts], [(lo, hi)]))
    return [np.concatenate(members) for members, _ in groups]
