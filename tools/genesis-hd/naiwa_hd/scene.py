"""The Genesis scene of a session: the set, the soft frog on its driven skeleton, the balls, the hands' colliders and
the camera, stepped along the session's time line and rendered frame by frame."""

import dataclasses
import math
import pathlib
import time

import numpy as np
import trimesh

import genesis as gs

from . import flesh as fl
from . import look, skin
from . import rig as rigmod
from .gltf import Character
from .session import Session

BALL_COLORS = (0xFF6F91, 0x5CC8FF, 0x7BE0A5, 0xB79CFF, 0xFFA24C, 0xFF5E5E, 0x4FD6C6, 0xFFD23F)
PARK = np.array([0.0, 0.0, -50.0])  # where unused balls wait, out of sight below the floor
# Sphere colliders that let the hands press into the belly: (bone, fraction along the bone, radius).
HAND_COLLIDERS = (("hand", 0.45, 0.012), ("forearm", 0.85, 0.016))


@dataclasses.dataclass
class Settings:
    renderer: str  # "nyx" | "raster"
    width: int
    height: int
    fps: int
    steps_per_frame: int
    substeps: int
    pcg_iterations: int
    spp: int
    settle: float  # seconds the flesh rests on the first pose before the clip starts


class Rigid:
    """A rigid sphere moved along a path (a ball or a hand collider): pose and velocity set every step."""

    def __init__(self, scene, radius, visible, surface):
        self.entity = scene.add_entity(
            morph=gs.morphs.Sphere(radius=radius, pos=tuple(PARK), visualization=visible, contype=0, conaffinity=0),
            material=gs.materials.Rigid(rho=5000.0, coup_friction=0.4, coup_softness=0.002, coup_restitution=0.0),
            surface=surface,
        )

    def make_heavy(self):
        """Driven along their recorded path, they must not be slowed by the flesh they push: a large mass."""
        self.entity.links[0].set_mass(50.0)

    def move(self, pos, vel):
        self.entity.set_pos(np.asarray(pos, dtype=np.float32), relative=False, zero_velocity=False)
        self.entity.set_dofs_velocity(np.concatenate([vel, np.zeros(3)]).astype(np.float32))


class HDScene:
    def __init__(self, character: Character, session: Session, settings: Settings, cache: pathlib.Path):
        self.c = character
        self.s = session
        self.cfg = settings
        self.step_dt = 1.0 / (settings.fps * settings.steps_per_frame)
        nyx = settings.renderer == "nyx"
        p0 = session.params_at(0.0)
        theme = session.theme if session.theme in look.THEMES else "light"
        th = look.THEMES[theme]
        self.theme = theme

        # Light for the rasterizer: the browser's key light from the session's mean camera heading, a soft fill.
        key_dir = self._key_direction()
        lights = [
            {"type": "directional", "dir": tuple(-key_dir), "color": tuple(look.srgb_hex(th["key_color"]) ** (1 / 2.2)),
             "intensity": 0.9 * th["key_intensity"]},
            {"type": "directional", "dir": (0.4, -0.6, -0.3), "color": (0.85, 0.9, 1.0), "intensity": 1.0},
        ]
        self.scene = gs.Scene(
            sim_options=gs.options.SimOptions(dt=self.step_dt, substeps=settings.substeps, gravity=(0.0, 0.0, 0.0)),
            fem_options=gs.options.FEMOptions(
                gravity=(0.0, 0.0, -9.81 * max(0.0, p0["gravity"])),
                floor_height=0.0,
                use_implicit_solver=True,
                n_newton_iterations=1,
                n_pcg_iterations=settings.pcg_iterations,
                damping_alpha=0.0,
                damping_beta=0.0,
                enable_vertex_constraints=True,
            ),
            vis_options=gs.options.VisOptions(
                shadow=True,
                plane_reflection=False,
                background_color=tuple(look.srgb_hex(th["sky_horizon"]) ** (1 / 2.2)),
                ambient_light=(0.28, 0.28, 0.3),
                lights=lights,
            ),
            renderer=gs.renderers.Rasterizer(),
            show_viewer=False,
        )
        srgb = not nyx  # Nyx reads texture values as linear albedo; the rasterizer decodes sRGB
        obj, img = look.floor_mesh(theme, cache / "set", srgb)
        self.scene.add_entity(
            morph=gs.morphs.Mesh(file=str(obj), fixed=True, collision=False, file_meshes_are_zup=True),
            material=gs.materials.Rigid(needs_coup=False),
            surface=gs.surfaces.Rough(diffuse_texture=gs.textures.ImageTexture(image_path=str(img)), roughness=0.9),
        )

        # The frog: soft flesh parts, then the driven face parts.
        region_soft = p0.get("regionSoftness") or {}
        self.flesh: list[fl.FleshBody] = []
        body = character.parts["Body"]
        parts = [(dataclasses.replace(body, name="body"), rigmod.PART_BONES["body"], 0.08)]
        for key, prefix in (("Arms", "arm"), ("Legs", "leg")):
            if key in character.parts:
                parts += [(p, rigmod.PART_BONES[p.name], 0.03) for p in rigmod.split_limbs(character.parts[key], prefix)]
        for part, bones, layer in parts:
            # The material follows the softness of the part's softest region (the belly for the Body).
            region = {"body": "belly", "arm": "arm", "leg": "leg"}[part.name.split("_")[0]]
            rel = region_soft.get(region, fl.DEFAULT_REGION_SOFTNESS[region])
            self.flesh.append(
                fl.FleshBody(self.scene, part, character.rig, bones, driven=False, softness=p0["softness"] * rel,
                             layer=layer, cache=cache / "tex", srgb_textures=srgb)
            )
        for key in ("Eyes", "MouthInside"):
            if key not in character.parts:
                continue
            whole = character.parts[key]
            for k, verts in enumerate(rigmod.disjoint_groups(whole)):
                piece = rigmod.subpart(whole, verts, f"{key.lower()}_{k}")
                self.flesh.append(
                    fl.FleshBody(self.scene, piece, character.rig, ("head",), driven=True, softness=0.0, layer=0.02,
                                 cache=cache / "tex", srgb_textures=srgb)
                )
        self.region_soft = region_soft

        # Hand colliders (invisible) and the ball pool.
        self.colliders = []
        for side in ("L", "R"):
            for bone, frac, radius in HAND_COLLIDERS:
                name = f"{bone}_{side}"
                if name in character.rig.names:
                    # Genesis takes a sphere's mass from its visual geometry, so the colliders are drawn; they sit
                    # inside the hand and forearm, in the hand's colour.
                    surface = gs.surfaces.Plastic(color=tuple(look.srgb_hex(0x62552A) ** (1 if nyx else 1 / 2.2)))
                    self.colliders.append((character.rig.index(name), frac, Rigid(self.scene, radius, True, surface)))
        self.balls = []
        for k in range(session.max_balls):
            color = tuple(look.srgb_hex(BALL_COLORS[k % len(BALL_COLORS)]) ** (1 if nyx else 1 / 2.2))
            radius = float(session.ball_data[:, 3].max()) if len(session.ball_data) else 0.1
            self.balls.append(Rigid(self.scene, radius, True, gs.surfaces.Plastic(color=color, roughness=0.32)))

        # The camera.
        first = session.sample(0.0)
        self.fov = first.fov
        pos, lookat, up = self._camera_pose(first.camera)
        res = (settings.width, settings.height)
        if nyx:
            self.camera = self._add_nyx_camera(res, pos, lookat, up, cache, key_dir)
        else:
            self.camera = self.scene.add_camera(res=res, pos=pos, lookat=lookat, up=up, fov=self.fov, GUI=False,
                                                near=0.05, far=60.0)
        self.heads, self.tails = rigmod.bone_segments(character.rig)

    # ------------------------------------------------------------------------------------------------- set-up

    def _key_direction(self) -> np.ndarray:
        """Direction (Genesis space) from the frog to the browser's key light, for the mean camera heading."""
        cams = self.s.cam_pos
        heading = math.atan2(cams[:, 0].mean(), cams[:, 2].mean())  # three.js: camera position around +Z
        c, s_ = math.cos(heading), math.sin(heading)
        k = look.KEY_OFFSET
        three = np.array([c * k[0] + s_ * k[2], k[1], -s_ * k[0] + c * k[2]])
        g = skin.points_to_genesis(three[None])[0]
        return g / np.linalg.norm(g)

    def _camera_pose(self, cam_three: np.ndarray):
        m = skin.TO_GENESIS @ cam_three
        pos = m[:3, 3]
        return tuple(pos), tuple(pos - m[:3, 2]), tuple(m[:3, 1])

    def _add_nyx_camera(self, res, pos, lookat, up, cache, key_dir):
        import gs_nyx.nyx_py_renderer as npr
        import gs_nyx.nyx_py_sdk as nps
        from gs_nyx_plugin.nyx_camera_options import NyxCameraOptions

        th = look.THEMES[self.theme]
        env = nps.EnvironmentMapAsset()
        env.texture = str(look.environment_hdr(self.theme, cache / "set" / f"env_{self.theme}.hdr"))
        env.layout = nps.EEnvMapLayout.LongLat
        env.multiplier = 1.6 * th["env_intensity"]
        profile = nps.CameraProfileAsset()
        profile.set_fov_y(math.radians(self.fov))
        cm = profile.colorManagement
        cm.toneMapper = nps.EToneMapper.Neutral
        profile.colorManagement = cm
        profile_path = cache / "set" / "camera.nyxcam"
        nps.export_camera_profile_file(str(profile_path), profile)
        key = {"type": "directional", "dir": tuple(-key_dir), "color": tuple(look.srgb_hex(th["key_color"])),
               "intensity": 2.2 * th["key_intensity"], "shadow": True}
        return self.scene.add_sensor(
            NyxCameraOptions(res=res, pos=pos, lookat=lookat, up=up, lights=[key], spp=self.cfg.spp, denoise=True,
                             near=0.05, far=60.0, render_mode=npr.ERenderMode.FastPathTracer, env_maps=(env,),
                             camera_profile=str(profile_path))
        )

    def build(self):
        t = time.time()
        self.scene.build(n_envs=1 if self.cfg.renderer == "nyx" else 0)
        body = self.c.parts["Body"]
        body_mesh = trimesh.Trimesh(body.positions, body.faces, process=True)  # welded: closed
        for body in self.flesh:
            limb = not body.driven and body.part.name != "body"
            body.setup(self.region_soft, face_driven=body.part.name == "body", hidden=body_mesh if limb else None)
        for rigid in [c for _, _, c in self.colliders] + self.balls:
            rigid.make_heavy()

        print(f"built in {time.time() - t:.1f} s: " + ", ".join(
            f"{b.part.name} {b.n} cells ({len(b.free)} free)"
            for b in self.flesh if not b.driven) +
            f"; {sum(b.driven for b in self.flesh)} driven face parts")

    # ------------------------------------------------------------------------------------------------- running

    def _pose(self, t: float):
        smp = self.s.sample(t)
        given = {k: skin.matrices_to_genesis(m) for k, m in smp.bones.items()}
        world = skin.complete_pose(self.c.rig, given)
        return smp, world, skin.skin_matrices(self.c.rig, world)

    def _impulses(self, t0: float, t1: float, cam_pos: np.ndarray) -> list[fl.Impulse]:
        out = []
        for e in self.s.events:
            if not (t0 < e["t"] <= t1) or e["kind"] not in ("poke", "slap"):
                continue
            point = skin.points_to_genesis(np.array([e["point"]], dtype=np.float64))[0]
            if "dir" in e:
                d = skin.points_to_genesis(np.array([e["dir"]], dtype=np.float64))[0]
            else:
                # The browser pokes along the pointer ray: from the camera through the point.
                d = point - cam_pos
            d = d / max(np.linalg.norm(d), 1e-9)
            s = float(e["strength"])
            if e["kind"] == "poke":
                out.append(fl.Impulse(point, d * (1.5 + 3.5 * s), 0.14))
            else:
                out.append(fl.Impulse(point, d * 12.0 * s * 0.35, 0.26))
        return out

    def run(self, on_frame):
        """Step through the session and call on_frame(index, rgb) for every output frame."""
        cfg = self.cfg
        n_frames = int(math.floor(self.s.duration * cfg.fps)) + 1
        smp, world, mats = self._pose(0.0)
        targets = [b.follow(mats, world, smp.expressions) for b in self.flesh]
        for b, tgt in zip(self.flesh, targets):
            b.settle(tgt)
            b.drive(tgt)
        prev_t = -cfg.settle
        t = prev_t
        prev_targets = targets
        prev_rigid = [self._collider_pos(world, bi, frac) for bi, frac, _ in self.colliders]
        timer = {"sim": 0.0, "render": 0.0}
        frame = 0
        step = 0
        while frame < n_frames:
            t_next = prev_t + self.step_dt
            t_clip = max(t_next, 0.0)
            p = self.s.params_at(t_clip)
            # The browser's damping ratio at its natural frequency, less what backward Euler already takes away
            # (an amplitude rate of omega^2 dt / 2).
            omega = 2 * math.pi * fl.natural_frequency(p["softness"])
            sub = self.step_dt / cfg.substeps
            damping = max(0.0, 2.0 * fl.damping_ratio(p["bounciness"]) * omega - 0.5 * omega**2 * sub)
            t_a = time.time()
            smp, world, mats = self._pose(t_clip)
            cam_pos = (skin.TO_GENESIS @ smp.camera)[:3, 3]
            impulses = self._impulses(max(prev_t, -1.0) if t_next > 0 else 1e9, t_clip, cam_pos)
            targets = [b.follow(mats, world, smp.expressions) for b in self.flesh]
            for b, tgt, ptgt in zip(self.flesh, targets, prev_targets):
                b.drive(tgt)
                b.damp_and_push((tgt - ptgt) / self.step_dt, damping, self.step_dt, impulses)
            rigid = [self._collider_pos(world, bi, frac) for bi, frac, _ in self.colliders]
            for (_, _, col), pos, ppos in zip(self.colliders, rigid, prev_rigid):
                col.move(pos, (pos - ppos) / self.step_dt)
            self._move_balls(t_clip)
            is_frame = t_next >= frame / cfg.fps - 1e-9 and t_next >= 0.0
            if is_frame:
                # Nyx draws during the step, so the camera of a frame is placed before it.
                self._place_camera(smp)
            self.scene.step()
            timer["sim"] += time.time() - t_a
            prev_t, prev_targets, prev_rigid = t_next, targets, rigid
            step += 1
            if is_frame:
                t_b = time.time()
                rgb = self._read()
                timer["render"] += time.time() - t_b
                on_frame(frame, rgb)
                frame += 1
        return timer

    def _collider_pos(self, world: np.ndarray, bone: int, frac: float) -> np.ndarray:
        head = world[bone, :3, 3]
        rest = self.c.rig.rest_world[bone]
        tail = (world[bone] @ np.linalg.inv(rest) @ np.append(self.tails[bone], 1.0))[:3]
        return head + frac * (tail - head)

    def _move_balls(self, t: float):
        if not self.balls:
            return
        now = self.s.sample(t).balls
        before = self.s.sample(max(0.0, t - 1.0 / 60)).balls
        for k, ball in enumerate(self.balls):
            if k < len(now):
                p = skin.points_to_genesis(now[k : k + 1, :3])[0]
                q = skin.points_to_genesis(before[k : k + 1, :3])[0] if k < len(before) else p
                ball.move(p, (p - q) * 60.0)
            else:
                ball.move(PARK, np.zeros(3))

    def _place_camera(self, smp):
        pos, lookat, up = self._camera_pose(smp.camera)
        if self.cfg.renderer == "nyx":
            self.camera.update_camera_pose(pos=pos, lookat=lookat, up=up)
        else:
            self.camera.set_pose(pos=pos, lookat=lookat, up=up)

    def _read(self) -> np.ndarray:
        if self.cfg.renderer == "nyx":
            rgb = self.camera.read().rgb[0].cpu().numpy()
        else:
            rgb = self.camera.render(rgb=True, antialiasing=True)[0]
        return np.ascontiguousarray(rgb[..., :3])
