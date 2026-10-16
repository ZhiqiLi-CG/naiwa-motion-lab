"""Read a session file (src/session/format.ts) and sample it at any time.

All sampled quantities stay in the browser's space (glTF: +Y up, the frog faces +Z); `skin.py` converts.
"""

import base64
import dataclasses
import gzip
import json
import pathlib

import numpy as np

FORMAT = "naiwa-session"
VERSION = 1
_DTYPES = {"f32": "<f4", "i16": "<i2", "u8": "u1"}
DEFAULT_PARAMS = {"softness": 0.6, "bounciness": 0.6, "gravity": 1.0, "bellySize": 1.0, "stubbornness": 0.8}


def unpack(p: dict) -> np.ndarray:
    raw = np.frombuffer(base64.b64decode(p["data"]), dtype=_DTYPES[p["dtype"]])
    values = raw.astype(np.float64) * p.get("scale", 1.0)
    return values.reshape(p["shape"])


def _quat_to_matrix(q: np.ndarray) -> np.ndarray:
    """(..., 4) xyzw -> (..., 3, 3)"""
    q = q / np.linalg.norm(q, axis=-1, keepdims=True)
    x, y, z, w = np.moveaxis(q, -1, 0)
    return np.stack(
        [
            np.stack([1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)], -1),
            np.stack([2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)], -1),
            np.stack([2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)], -1),
        ],
        -2,
    )


def _nlerp(qa: np.ndarray, qb: np.ndarray, w: float) -> np.ndarray:
    """Blend unit quaternions along the shorter arc (frames are close in time, so nlerp is as good as slerp)."""
    qb = np.where((np.sum(qa * qb, axis=-1, keepdims=True) < 0), -qb, qb)
    q = qa * (1 - w) + qb * w
    return q / np.linalg.norm(q, axis=-1, keepdims=True)


@dataclasses.dataclass
class Sample:
    bones: dict[str, np.ndarray]  # bone name -> (4, 4) world matrix
    camera: np.ndarray  # (4, 4) camera-to-world (three.js: looks down -Z, +Y up)
    fov: float  # vertical, degrees
    aspect: float
    expressions: dict[str, float]
    balls: np.ndarray  # (n, 4) x, y, z, radius


class Session:
    def __init__(self, doc: dict):
        if doc.get("format") != FORMAT or doc.get("version") != VERSION:
            raise ValueError(f"not a {FORMAT} v{VERSION} file (format={doc.get('format')}, version={doc.get('version')})")
        self.doc = doc
        self.bones: list[str] = doc["bones"]
        self.expression_names: list[str] = doc["expressions"]
        self.n = int(doc["frameCount"])
        if self.n < 2:
            raise ValueError("the session has fewer than two frames")
        self.time = unpack(doc["time"])
        self.bone_pos = unpack(doc["bonePos"])
        self.bone_rot = unpack(doc["boneRot"])
        cam = doc["camera"]
        self.cam_pos = unpack(cam["pos"])
        self.cam_rot = unpack(cam["rot"])
        self.cam_lens = unpack(cam["lens"])
        self.expr = unpack(doc["expressionWeights"])
        counts = unpack(doc["balls"]["count"]).astype(np.int64)
        self.ball_start = np.concatenate([[0], np.cumsum(counts)])
        self.ball_data = unpack(doc["balls"]["data"]).reshape(-1, 4)
        self.params_log = doc.get("params") or [{"t": 0.0, "params": DEFAULT_PARAMS, "mode": "driven"}]
        self.events: list[dict] = sorted(doc.get("events", []), key=lambda e: e["t"])
        self.theme: str = doc.get("stage", {}).get("theme", "light")
        self.character_url: str = doc.get("character", {}).get("url", "models/naiwa.glb")

    @classmethod
    def load(cls, path: pathlib.Path) -> "Session":
        raw = path.read_bytes()
        if raw[:2] == b"\x1f\x8b":
            raw = gzip.decompress(raw)
        return cls(json.loads(raw))

    @property
    def duration(self) -> float:
        return float(self.time[-1])

    @property
    def max_balls(self) -> int:
        return int(np.diff(self.ball_start).max(initial=0))

    def _bracket(self, t: float) -> tuple[int, int, float]:
        if t <= self.time[0]:
            return 0, 0, 0.0
        if t >= self.time[-1]:
            return self.n - 1, self.n - 1, 0.0
        b = int(np.searchsorted(self.time, t, side="right"))
        a = b - 1
        return a, b, float((t - self.time[a]) / max(1e-9, self.time[b] - self.time[a]))

    def sample(self, t: float) -> Sample:
        a, b, w = self._bracket(t)
        pos = self.bone_pos[a] * (1 - w) + self.bone_pos[b] * w
        rot = _quat_to_matrix(_nlerp(self.bone_rot[a], self.bone_rot[b], w))
        mats = np.tile(np.eye(4), (len(self.bones), 1, 1))
        mats[:, :3, :3] = rot
        mats[:, :3, 3] = pos
        cam = np.eye(4)
        cam[:3, :3] = _quat_to_matrix(_nlerp(self.cam_rot[a], self.cam_rot[b], w))
        cam[:3, 3] = self.cam_pos[a] * (1 - w) + self.cam_pos[b] * w
        lens = self.cam_lens[a] * (1 - w) + self.cam_lens[b] * w
        expr = self.expr[a] * (1 - w) + self.expr[b] * w
        f = a if w < 0.5 else b
        return Sample(
            bones={name: mats[k] for k, name in enumerate(self.bones)},
            camera=cam,
            fov=float(lens[0]),
            aspect=float(self.cam_lens[0][1]),
            expressions={name: float(expr[k]) for k, name in enumerate(self.expression_names)},
            balls=self.ball_data[self.ball_start[f] : self.ball_start[f + 1]],
        )

    def window(self, start: float, end: float | None) -> "Session":
        """The part of the session between start and end (seconds), with its time starting at 0."""
        doc = dict(self.doc)
        out = Session.__new__(Session)
        out.__dict__.update(self.__dict__)
        keep = (self.time >= start) & (self.time <= (end if end is not None else self.time[-1]))
        idx = np.flatnonzero(keep)
        out.n = len(idx)
        if out.n < 2:
            raise ValueError(f"no frames between {start} and {end} s")
        out.time = self.time[idx] - start
        for name in ("bone_pos", "bone_rot", "cam_pos", "cam_rot", "cam_lens", "expr"):
            setattr(out, name, getattr(self, name)[idx])
        counts = np.diff(self.ball_start)[idx]
        out.ball_data = np.concatenate([self.ball_data[self.ball_start[i] : self.ball_start[i + 1]] for i in idx])
        out.ball_start = np.concatenate([[0], np.cumsum(counts)])
        out.events = [{**e, "t": e["t"] - start} for e in self.events if e["t"] >= start]
        out.params_log = [{**e, "t": max(0.0, e["t"] - start)} for e in self.params_log]
        out.doc = doc
        return out

    def params_at(self, t: float) -> dict:
        current = self.params_log[0]
        for entry in self.params_log:
            if entry["t"] <= t:
                current = entry
        return {**DEFAULT_PARAMS, **current["params"]}
