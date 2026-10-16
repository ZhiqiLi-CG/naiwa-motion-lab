"""Soft flesh over the driven skeleton: one FEM body per closed piece of the character, integrated implicitly (backward
Euler, linear corotated elasticity): stable whatever the cells (tetgen leaves boundary slivers in the thin limbs that
an explicit integrator would need microsecond substeps for), and its small numerical damping is part of the decay.

The flesh rides on its bones the way the browser's Rapier flesh does (src/sim/frog.ts): cells deeper than a soft
layer are held to their nearest bone, the layer over them is free FEM, thickest where the flesh is softest (the
belly). On top of what the browser does, the face is driven by its shape keys (the open laughing mouth is a pocket
into the head), and the parts that only follow the head (eyes, mouth inside) are fully driven FEM bodies, so that
every renderer, Nyx included, draws them as Genesis deformable meshes.
"""

import dataclasses
import math
import pathlib

import numpy as np
import scipy.spatial
import torch
import trimesh
from PIL import Image

import genesis as gs

from . import rig as rigmod
from . import skin, surfaces
from .gltf import MeshPart, Rig

FLESH_REGIONS = ("belly", "body", "head", "arm", "hand", "leg", "foot")
# Relative softness of each region when the session sets none (src/contracts.ts: belly softest, hands/feet firmest).
DEFAULT_REGION_SOFTNESS = {"belly": 1.0, "body": 0.6, "head": 0.25, "arm": 0.5, "hand": 0.15, "leg": 0.45, "foot": 0.15}
RHO = 1000.0
NU = 0.45


def lerp_log(a: float, b: float, t: float) -> float:
    return a * (b / a) ** min(max(t, 0.0), 1.0)


def natural_frequency(softness: float) -> float:
    """Hz, as the browser's flesh material (frog.ts): 14 firm ... 3 very soft."""
    return lerp_log(14.0, 3.0, softness)


def damping_ratio(bounciness: float) -> float:
    return lerp_log(0.9, 0.06, bounciness)


def youngs_modulus(softness: float, layer: float) -> float:
    """E (Pa) giving a free layer of this thickness (m) the browser's natural frequency: the quarter-wave shear mode of
    a layer, f = c_s / (4 h), c_s = sqrt(mu / rho)."""
    mu = RHO * (4.0 * layer * natural_frequency(softness)) ** 2
    return 2.0 * mu * (1.0 + NU)


@dataclasses.dataclass
class Impulse:
    point: np.ndarray  # Genesis space
    dv: np.ndarray  # velocity change at the centre (m/s)
    radius: float


def _write_texture(piece: surfaces.Piece, path: pathlib.Path, srgb: bool) -> str:
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(surfaces.encode(piece.texture, srgb)).save(path)
    return str(path)


def _trimesh(part: MeshPart, piece: surfaces.Piece, inflate: float) -> trimesh.Trimesh:
    """The piece as a textured trimesh, its surface pushed out along the normals by `inflate` (m)."""
    v = part.positions[piece.vertices]
    if inflate:
        # Normals of the welded surface, so that vertices split by a seam move together.
        _, weld = np.unique(np.round(v / 1e-7).astype(np.int64), axis=0, return_inverse=True)
        weld = weld.reshape(-1)
        welded = trimesh.Trimesh(np.zeros((weld.max() + 1, 3)), weld[piece.faces], process=False)
        welded.vertices[weld] = v
        v = v + inflate * welded.vertex_normals[weld]
    visual = trimesh.visual.TextureVisuals(uv=piece.uvs)
    return trimesh.Trimesh(v, piece.faces, visual=visual, process=False)


class FleshBody:
    """One FEM entity: a flesh part (free soft layer over held cells) or a driven part (every cell held)."""

    def __init__(
        self,
        scene: gs.Scene,
        part: MeshPart,
        rig: Rig,
        bones: tuple[str, ...],
        *,
        driven: bool,
        softness: float,
        layer: float,
        cache: pathlib.Path,
        srgb_textures: bool,
    ):
        self.part = part
        self.rig = rig
        self.bones = bones
        self.driven = driven
        pieces = surfaces.pieces(part)
        if len(pieces) != 1:
            raise ValueError(f"{part.name}: one textured piece per FEM body is expected, got {len(pieces)}")
        self.piece = pieces[0]
        tex = _write_texture(self.piece, cache / f"{part.name}_{'srgb' if srgb_textures else 'linear'}.png", srgb_textures)
        # Driven parts include sub-millimetre shells (teeth, the closed mouth); Genesis splits cells whose corners all lie
        # on the surface at a single-precision centroid, which turns such slivers inside out. A fifth of a millimetre
        # of thickness keeps them right side out and cannot be seen.
        inflate = 0.0002 if driven else 0.0
        self.entity = scene.add_entity(
            morph=gs.morphs.MeshSet(files=(_trimesh(part, self.piece, inflate),), quality=True, minratio=1.5),
            material=gs.materials.FEM.Elastic(
                E=youngs_modulus(softness, layer), nu=NU, rho=RHO, model="linear_corotated"
            ),
            surface=gs.surfaces.Plastic(
                diffuse_texture=gs.textures.ImageTexture(image_path=tex),
                roughness=part.roughness,
                vis_mode="visual",
            ),
        )

    # ------------------------------------------------------------------------------------------------ after build

    def setup(self, region_softness: dict[str, float], face_driven: bool, hidden: trimesh.Trimesh | None = None):
        """Decide which cells are held and what they follow; call once after the scene is built. Cells inside
        `hidden` (the Body, for a limb whose root sinks into it) are out of sight and ride on their bones."""
        part, rig = self.part, self.rig
        P = self.entity.init_positions.cpu().numpy().astype(np.float64)
        self.n = len(P)
        vmap = np.asarray(self.entity.vgeoms[0].sim_verts_idx)  # render vertex (piece order) -> sim vertex
        part_of_render = self.piece.vertices  # render vertex -> part vertex
        surf = np.unique(vmap)
        is_surface = np.zeros(self.n, dtype=bool)
        is_surface[surf] = True
        # Each sim vertex takes the attributes of a part vertex: its own on the surface, the nearest one inside.
        rep = np.empty(self.n, dtype=np.int64)
        rep[vmap] = part_of_render
        tree = scipy.spatial.cKDTree(P[surf])
        depth, near = tree.query(P)
        rep[~is_surface] = rep[surf[near[~is_surface]]]
        depth[is_surface] = 0.0
        self.rest = P

        # Bone each cell rides on, and its offset in that bone's rest frame.
        self.bone = rigmod.nearest_bone(P, rig, self.bones)
        inv_rest = np.linalg.inv(rig.rest_world[self.bone])
        self.local = np.einsum("vij,vj->vi", inv_rest[:, :3, :3], P) + inv_rest[:, :3, 3]

        # Skin weights (for the shape-keyed face) from the representative part vertex.
        self.joints = part.joints[rep]
        self.weights = part.weights[rep]

        # Region and softness of every cell.
        names = [rig.names[b] for b in self.bone]
        asset = part.softness[rep] if part.softness is not None else None
        region = np.empty(self.n, dtype=object)
        if part.name == "body":
            head_z = rig.rest_world[rig.index("head"), 2, 3]
            region[:] = "body"
            if asset is not None:
                region[asset > 0.55] = "belly"
            region[P[:, 2] > head_z - 0.02] = "head"
        else:
            limb = "arm" if part.name.startswith("arm") else "leg"
            tip = "hand" if limb == "arm" else "foot"
            region[:] = [tip if (rigmod.is_hand_bone(n) or n.startswith("foot")) else limb for n in names]
        rel = np.array([region_softness.get(r, DEFAULT_REGION_SOFTNESS[r]) for r in region])
        default = np.array([DEFAULT_REGION_SOFTNESS[r] for r in region])
        # The asset grades softness within a region (the belly patch); the session's region softness scales it.
        s = asset * rel / default if asset is not None else rel
        self.softness = np.clip(s, 0.0, 1.0)
        self.region = region

        # Held cells: the deep core (browser rule for the Body; thin limbs keep a thinner layer), all of a driven part.
        if self.driven:
            held = np.ones(self.n, dtype=bool)
        elif part.name == "body":
            held = depth > 0.05 + 0.07 * self.softness
        else:
            # Thin limbs keep a thinner layer; firm hands and feet (fingers, toes) are held whole.
            held = (depth > 0.004 + 0.03 * self.softness) | (np.isin(region, ("hand", "foot")) & (self.softness < 0.3))
            if hidden is not None:
                held |= hidden.contains(P)

        # The face: every cell within reach of what the shape keys move follows the skin, keys included.
        self.morph_deltas = {}
        self.skinned = np.zeros(self.n, dtype=bool)
        if face_driven and part.morphs:
            moved = np.zeros(len(part.positions), dtype=bool)
            for d in part.morphs.values():
                moved |= np.linalg.norm(d, axis=1) > 1e-4
            if moved.any():
                reach = max(np.linalg.norm(d, axis=1).max() for d in part.morphs.values()) + 0.015
                src = part.positions[moved]
                tree_m = scipy.spatial.cKDTree(src)
                self.skinned = np.array([len(x) > 0 for x in tree_m.query_ball_point(P, reach)])
                held |= self.skinned
                # Shape-key offsets for every skinned cell: its own on the surface, a smooth blend of the nearby
                # surface offsets inside (so the cells around the mouth pocket open with it).
                sigma = 0.02
                for name, d in part.morphs.items():
                    dd = d[moved]
                    out = np.zeros((self.n, 3))
                    idx = np.flatnonzero(self.skinned)
                    dist, nb = tree_m.query(P[idx], k=min(16, len(src)))
                    w = np.exp(-((dist / sigma) ** 2))
                    out[idx] = np.einsum("vk,vkj->vj", w, dd[nb]) / np.maximum(w.sum(1, keepdims=True), 1.0)
                    own = is_surface & self.skinned
                    out[own] = d[rep[own]]
                    self.morph_deltas[name] = out
        if self.driven:
            self.skinned[:] = True
        self.held = np.flatnonzero(held)
        self.free = np.flatnonzero(~held)
        if len(self.held):
            self.entity.set_vertex_constraints(self.held, target_poss=P[self.held])

    def follow(self, skin_mats: np.ndarray, bone_world: np.ndarray, expressions: dict[str, float]) -> np.ndarray:
        """Where every cell would be if the flesh were at rest on the posed skeleton (n, 3)."""
        rigid = bone_world[self.bone] @ np.linalg.inv(self.rig.rest_world[self.bone])
        out = np.einsum("vij,vj->vi", rigid[:, :3, :3], self.rest) + rigid[:, :3, 3]
        if self.skinned.any():
            idx = np.flatnonzero(self.skinned)
            p = self.rest[idx].copy()
            for name, w in expressions.items():
                if w > 0 and name in self.morph_deltas:
                    p += w * self.morph_deltas[name][idx]
            m = np.einsum("vk,vkij->vij", self.weights[idx], skin_mats[self.joints[idx]])
            out[idx] = skin.skin_points(m, p)
        return out

    def drive(self, target: np.ndarray):
        if len(self.held):
            self.entity.update_constraint_targets(self.held, target[self.held])

    def state(self) -> tuple[np.ndarray, np.ndarray]:
        s = self.entity.get_state()
        return s.pos[0].cpu().numpy().astype(np.float64), s.vel[0].cpu().numpy().astype(np.float64)

    def settle(self, target: np.ndarray):
        """Put every cell where it rests on the posed skeleton, at rest (the first frame)."""
        self.entity.set_position(torch.as_tensor(target, dtype=gs.tc_float, device=gs.device))
        self.entity.set_velocity(torch.zeros((self.n, 3), dtype=gs.tc_float, device=gs.device))

    def damp_and_push(self, ref_vel: np.ndarray, damping: float, dt: float, impulses: list[Impulse]):
        """Internal damping of the free flesh relative to the skeleton's motion, and the pokes of this step."""
        if self.driven or not len(self.free):
            return
        pos, vel = self.state()
        f = self.free
        rel = vel[f] - ref_vel[f]
        vel[f] = ref_vel[f] + rel * math.exp(-damping * dt)
        for imp in impulses:
            d = np.linalg.norm(pos[f] - imp.point, axis=1) / imp.radius
            w = np.where(d < 1, (1 - d * d) ** 2, 0.0)
            vel[f] += w[:, None] * imp.dv
        self.entity.set_velocity(torch.as_tensor(vel, dtype=gs.tc_float, device=gs.device))
