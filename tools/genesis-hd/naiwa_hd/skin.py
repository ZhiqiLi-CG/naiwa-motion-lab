"""Linear blend skinning of the character, as three.js draws a SkinnedMesh, and the change from glTF to Genesis space.

glTF / three.js: +Y up, the frog faces +Z. Genesis: +Z up. A rotation of +90 degrees about X maps one to the other:
(x, y, z) -> (x, -z, y), so the frog faces -Y in Genesis.
"""

import numpy as np

from .gltf import MeshPart, Rig

TO_GENESIS = np.array([[1.0, 0, 0, 0], [0, 0, -1.0, 0], [0, 1.0, 0, 0], [0, 0, 0, 1.0]])


def points_to_genesis(p: np.ndarray) -> np.ndarray:
    return p @ TO_GENESIS[:3, :3].T


def matrices_to_genesis(m: np.ndarray) -> np.ndarray:
    return TO_GENESIS @ m @ TO_GENESIS.T


def complete_pose(rig: Rig, given: dict[str, np.ndarray]) -> np.ndarray:
    """World matrices (B, 4, 4) of every rig bone: the given ones as they are, the others (fingers the simulation does
    not move, a bone a recorded session lacks) carried by their parent with their rest local transform."""
    out = np.empty_like(rig.rest_world)
    done = np.zeros(len(rig.names), dtype=bool)

    def solve(b):
        if not done[b]:
            if rig.names[b] in given:
                out[b] = given[rig.names[b]]
            elif rig.parents[b] < 0:
                out[b] = rig.rest_world[b]
            else:
                out[b] = solve(rig.parents[b]) @ rig.rest_local[b]
            done[b] = True
        return out[b]

    for b in range(len(rig.names)):
        solve(b)
    return out


def skin_matrices(rig: Rig, bone_world: np.ndarray) -> np.ndarray:
    return bone_world @ rig.inverse_bind


def blend(part: MeshPart, skin: np.ndarray) -> np.ndarray:
    """Per-vertex blended skin matrices (V, 4, 4)."""
    return np.einsum("vk,vkij->vij", part.weights, skin[part.joints])


def skin_points(blended: np.ndarray, points: np.ndarray) -> np.ndarray:
    return np.einsum("vij,vj->vi", blended[:, :3, :3], points) + blended[:, :3, 3]


def morphed(part: MeshPart, weights: dict[str, float]) -> np.ndarray:
    p = part.positions.copy()
    for name, w in weights.items():
        if w > 0 and name in part.morphs:
            p += w * part.morphs[name]
    return p
