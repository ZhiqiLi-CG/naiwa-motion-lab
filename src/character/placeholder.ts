/**
 * A stand-in 奶蛙 built in code, used only when public/models/naiwa.glb does not exist. It follows the same asset
 * contract as the GLB (bones, mesh names, shape keys, _softness, render vertices split at a seam like glTF does) so
 * everything downstream runs unchanged; proportions follow the Blender build (assets-src/naiwa/build_naiwa.py).
 */
import * as THREE from "three";
import type { BoneName, Expression } from "../contracts";

type V3 = [number, number, number];
type State = "rest" | Expression;
const STATES: State[] = ["rest", "laugh", "tongue", "surprise", "blink"];

const srgb = (hex: number) => new THREE.Color().setHex(hex, THREE.SRGBColorSpace);
const YELLOW = srgb(0xf3cb45), CREAM = srgb(0xefde9b), OLIVE = srgb(0x62552a), LIP = srgb(0x705021);
const DARK = srgb(0x2a1017), WHITE = srgb(0xf5f1ce), IRIS = srgb(0x87b65c), PUPIL = srgb(0x101a0b), PINK = srgb(0xe95869);

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const smooth = (v: number) => {
  const t = clamp01(v);
  return t * t * (3 - 2 * t);
};

/** Body rows bottom to top: [height, half-width, half-depth, depth centre (+ forward)]. */
const PROFILE: [number, number, number, number][] = [
  [0.245, 0, 0, -0.005], [0.265, 0.1, 0.09, -0.005], [0.3, 0.175, 0.155, -0.006], [0.365, 0.23, 0.208, -0.008],
  [0.445, 0.255, 0.232, -0.004], [0.525, 0.246, 0.226, -0.006], [0.605, 0.218, 0.198, -0.012],
  [0.685, 0.18, 0.162, -0.012], [0.755, 0.145, 0.128, -0.002], [0.805, 0.127, 0.106, 0.03],
  [0.855, 0.116, 0.096, 0.062], [0.905, 0.111, 0.089, 0.077], [0.95, 0.096, 0.075, 0.08], [0.98, 0.064, 0.05, 0.08],
  [1, 0, 0, 0.08],
];

/** [half-width, half-depth, depth centre] at height y (cubic Hermite through the rows, domed head top). */
function profile(y: number): V3 {
  const n = PROFILE.length;
  y = Math.min(Math.max(y, PROFILE[0][0]), PROFILE[n - 1][0]);
  let k = 0;
  while (k < n - 2 && PROFILE[k + 1][0] < y) k++;
  const a = PROFILE[k], b = PROFILE[k + 1], prev = PROFILE[Math.max(0, k - 1)], next = PROFILE[Math.min(n - 1, k + 2)];
  const h = b[0] - a[0], t = (y - a[0]) / h;
  const out: V3 = [0, 0, 0];
  for (let c = 1; c <= 3; c++) {
    const da = (b[c] - prev[c]) / (b[0] - prev[0]), db = (next[c] - a[c]) / (next[0] - a[0]);
    out[c - 1] = (2 * t ** 3 - 3 * t * t + 1) * a[c] + (t ** 3 - 2 * t * t + t) * h * da +
      (-2 * t ** 3 + 3 * t * t) * b[c] + (t ** 3 - t * t) * h * db;
  }
  if (y > 0.905) {
    const dome = Math.sqrt(Math.max(0, 1 - ((y - 0.905) / 0.095) ** 2));
    out[0] = 0.111 * dome;
    out[1] = 0.089 * dome;
  }
  return out;
}

/** The face's front surface (z) at (x, y). */
function frontZ(x: number, y: number): number {
  const [rx, rz, cz] = profile(y);
  return cz + rz * Math.sqrt(Math.max(0.02, 1 - (x / Math.max(0.001, rx)) ** 2));
}

/** Bones: [name, parent, head, tail] in glTF space. */
function boneList(): [BoneName, BoneName | null, V3, V3][] {
  const b: [BoneName, BoneName | null, V3, V3][] = [
    ["root", null, [0, 0, 0], [0, 0.1, 0]],
    ["hips", "root", [0, 0.31, 0], [0, 0.49, 0]],
    ["spine", "hips", [0, 0.49, 0], [0, 0.67, 0]],
    ["chest", "spine", [0, 0.67, 0], [0, 0.8, 0.035]],
    ["head", "chest", [0, 0.8, 0.035], [0, 0.97, 0.08]],
  ];
  for (const [s, side] of [[1, "L"], [-1, "R"]] as const) {
    b.push(
      [`upperarm_${side}`, "chest", [s * 0.11, 0.705, -0.005], [s * 0.255, 0.56, 0.008]],
      [`forearm_${side}`, `upperarm_${side}`, [s * 0.255, 0.56, 0.008], [s * 0.325, 0.385, 0.04]],
      [`hand_${side}`, `forearm_${side}`, [s * 0.325, 0.385, 0.04], [s * 0.34, 0.34, 0.05]],
    );
    for (const [f, o, len] of [["index", -0.024, 0.066], ["middle", 0, 0.075], ["ring", 0.025, 0.063]] as const) {
      b.push([`${f}_${side}`, `hand_${side}`, [s * (0.34 + o), 0.347, 0.054], [s * (0.348 + o * 1.35), 0.347 - len, 0.057]]);
    }
    b.push(
      [`thumb_${side}`, `hand_${side}`, [s * 0.313, 0.367, 0.063], [s * 0.287, 0.324, 0.079]],
      [`thigh_${side}`, "hips", [s * 0.111, 0.318, -0.008], [s * 0.126, 0.185, -0.012]],
      [`shin_${side}`, `thigh_${side}`, [s * 0.126, 0.185, -0.012], [s * 0.142, 0.055, -0.004]],
      [`foot_${side}`, `shin_${side}`, [s * 0.142, 0.055, -0.004], [s * 0.148, 0.025, 0.103]],
    );
  }
  return b;
}

/** Collects one skinned mesh: vertices with colour, up to two bone weights and a position per expression. */
class MeshBuilder {
  pos: number[] = [];
  col: number[] = [];
  skin: [BoneName, number][][] = [];
  soft: number[] = [];
  shapes = new Map<State, number[]>(STATES.map((s) => [s, []]));
  idx: number[] = [];

  vertex(p: V3, c: THREE.Color, w: [BoneName, number][], shapes?: Partial<Record<State, V3>>, softness = 0.2): number {
    p = shapes?.rest ?? p;
    this.pos.push(...p);
    this.col.push(c.r, c.g, c.b);
    this.skin.push(w);
    this.soft.push(softness);
    for (const s of STATES) this.shapes.get(s)!.push(...(shapes?.[s] ?? p));
    return this.pos.length / 3 - 1;
  }

  tri(a: number, b: number, c: number) {
    this.idx.push(a, b, c);
  }

  /** Closed ellipsoid; shape(p, q) may give every expression's position (q: unit sphere direction). */
  ellipsoid(c: V3, r: V3, color: THREE.Color, w: [BoneName, number][], segs = 20, rings = 10,
    shape?: (p: V3, q: V3) => Partial<Record<State, V3>>) {
    const rows: number[][] = [];
    for (let j = 0; j <= rings; j++) {
      const phi = (Math.PI * j) / rings;
      const row: number[] = [];
      const count = j === 0 || j === rings ? 1 : segs;
      for (let i = 0; i < count; i++) {
        const th = (2 * Math.PI * i) / segs;
        const q: V3 = [Math.sin(phi) * Math.cos(th), Math.cos(phi), Math.sin(phi) * Math.sin(th)];
        const p: V3 = [c[0] + q[0] * r[0], c[1] + q[1] * r[1], c[2] + q[2] * r[2]];
        row.push(this.vertex(p, color, w, shape?.(p, q)));
      }
      rows.push(row);
    }
    for (let j = 0; j < rings; j++) {
      for (let i = 0; i < segs; i++) {
        const ni = (i + 1) % segs;
        if (j === 0) this.tri(rows[0][0], rows[1][ni], rows[1][i]);
        else if (j === rings - 1) this.tri(rows[j][i], rows[j][ni], rows[j + 1][0]);
        else {
          this.tri(rows[j][i], rows[j][ni], rows[j + 1][ni]);
          this.tri(rows[j][i], rows[j + 1][ni], rows[j + 1][i]);
        }
      }
    }
  }

  /** Open-ended tube capped at both ends, along points with radii, weights and colours per ring. */
  tube(points: THREE.Vector3[], radii: number[], weights: [BoneName, number][][], colors: THREE.Color[], segs = 16) {
    const rows: number[][] = [];
    const up = new THREE.Vector3(0, 0, 1);
    points.forEach((p, j) => {
      const tan = points[Math.min(j + 1, points.length - 1)].clone().sub(points[Math.max(0, j - 1)]).normalize();
      const ax = new THREE.Vector3().crossVectors(tan, up).normalize();
      const ay = new THREE.Vector3().crossVectors(ax, tan).normalize();
      const row: number[] = [];
      for (let i = 0; i < segs; i++) {
        const a = (2 * Math.PI * i) / segs;
        const q = p.clone().addScaledVector(ax, radii[j] * Math.cos(a)).addScaledVector(ay, radii[j] * Math.sin(a));
        row.push(this.vertex([q.x, q.y, q.z], colors[j], weights[j]));
      }
      rows.push(row);
    });
    for (let j = 0; j + 1 < rows.length; j++) {
      for (let i = 0; i < segs; i++) {
        const ni = (i + 1) % segs;
        this.tri(rows[j][i], rows[j + 1][i], rows[j + 1][ni]);
        this.tri(rows[j][i], rows[j + 1][ni], rows[j][ni]);
      }
    }
    for (const [row, p, w, c, flip] of [[rows[0], points[0], weights[0], colors[0], true], [rows[rows.length - 1], points[points.length - 1], weights[weights.length - 1], colors[colors.length - 1], false]] as const) {
      const centre = this.vertex([p.x, p.y, p.z], c, w);
      for (let i = 0; i < segs; i++) {
        const ni = (i + 1) % segs;
        if (flip) this.tri(centre, row[i], row[ni]);
        else this.tri(centre, row[ni], row[i]);
      }
    }
  }

  build(name: string, material: THREE.Material, skeleton: THREE.Skeleton, softness: boolean): THREE.SkinnedMesh {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute("color", new THREE.Float32BufferAttribute(this.col, 3));
    if (softness) g.setAttribute("_softness", new THREE.Float32BufferAttribute(this.soft, 1));
    const n = this.skin.length;
    const si = new Uint16Array(4 * n), sw = new Float32Array(4 * n);
    const slot = new Map(skeleton.bones.map((b, i) => [b.name, i]));
    this.skin.forEach((w, i) => {
      w.forEach(([b, x], k) => {
        si[4 * i + k] = slot.get(b)!;
        sw[4 * i + k] = x;
      });
    });
    g.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(si, 4));
    g.setAttribute("skinWeight", new THREE.Float32BufferAttribute(sw, 4));
    g.setIndex(this.idx);
    const base = this.shapes.get("rest")!;
    const names: Expression[] = [];
    const targets: THREE.Float32BufferAttribute[] = [];
    for (const s of STATES) {
      if (s === "rest") continue;
      const p = this.shapes.get(s)!;
      if (p.every((x, i) => x === base[i])) continue;
      names.push(s);
      targets.push(new THREE.Float32BufferAttribute(p.map((x, i) => x - base[i]), 3));
    }
    if (targets.length) {
      g.morphAttributes.position = targets;
      g.morphTargetsRelative = true;
    }
    g.computeVertexNormals();
    const mesh = new THREE.SkinnedMesh(g, material);
    mesh.name = name;
    if (targets.length) {
      mesh.updateMorphTargets();
      mesh.morphTargetDictionary = Object.fromEntries(names.map((n, i) => [n, i]));
      mesh.morphTargetInfluences = names.map(() => 0);
    }
    return mesh;
  }
}

function bodyWeights(y: number): [BoneName, number][] {
  const anchors: [number, BoneName][] = [[0.31, "hips"], [0.51, "spine"], [0.71, "chest"], [0.82, "head"]];
  if (y <= anchors[0][0]) return [["hips", 1]];
  if (y >= anchors[3][0]) return [["head", 1]];
  for (let k = 0; k < 3; k++) {
    const [a, an] = anchors[k], [b, bn] = anchors[k + 1];
    if (y <= b) {
      const w = smooth((y - a) / (b - a));
      return [[an, 1 - w], [bn, w]];
    }
  }
  return [["head", 1]];
}

/** Mouth line height at x (a wide smile, corners up). */
const MOUTH_Y = 0.835, MOUTH_W = 0.075;
const mouthLine = (x: number) => MOUTH_Y + 0.009 * (x / MOUTH_W) ** 2;

function buildBody(): MeshBuilder {
  const m = new MeshBuilder();
  const rows = 84, segs = 72;
  const y0 = PROFILE[0][0], y1 = PROFILE[PROFILE.length - 1][0];
  // A latitude/longitude grid with a duplicated seam column at the back and one vertex per pole cell, as glTF
  // exporters split vertices at UV seams (the character module welds them back).
  const grid: number[][] = [];
  for (let r = 0; r <= rows; r++) {
    const y = y0 + (y1 - y0) * (0.5 - 0.5 * Math.cos((Math.PI * r) / rows));
    const [rx, rz, cz] = profile(y);
    const row: number[] = [];
    for (let s = 0; s <= segs; s++) {
      const th = 2 * Math.PI * (s / segs - 0.5);
      const x = rx * Math.sin(th), z = cz + rz * Math.cos(th);
      const front = Math.cos(th);
      const patch = Math.hypot(x / 0.207, (y - 0.479) / 0.211);
      const blend = (1 - smooth((patch - 0.95) / 0.1)) * smooth((front - 0.25) / 0.28);
      const color = YELLOW.clone().lerp(CREAM, blend);
      // The mouth: a dark line across the face; the jaw drops for laugh and tongue, puckers for surprise.
      const inMouth = Math.abs(x) < MOUTH_W && front > 0.4;
      const d = y - mouthLine(x);
      if (inMouth) color.lerp(LIP, 0.85 * (1 - smooth(Math.abs(d) / 0.009)) * (1 - smooth((Math.abs(x) / MOUTH_W - 0.85) / 0.15)));
      const shapes: Partial<Record<State, V3>> = {};
      if (front > 0.2 && Math.abs(y - MOUTH_Y) < 0.08) {
        const across = 1 - smooth((Math.abs(x) / MOUTH_W - 0.7) / 0.6);
        const below = d < 0 ? 1 - smooth(-d / 0.07) : 0;
        const above = d >= 0 ? 1 - smooth(d / 0.04) : 0;
        const at = (dy: number, dz: number): V3 => [x, y + dy, z + dz];
        shapes.laugh = at(-0.026 * below * across + 0.008 * above * across, 0.006 * below * across);
        shapes.tongue = at(-0.02 * below * across + 0.006 * above * across, 0.005 * below * across);
        const o = 1 - smooth(Math.hypot(x / 0.04, d / 0.04));
        shapes.surprise = at(-0.01 * o * (d < 0 ? 1 : -0.4), 0.004 * o);
      }
      row.push(m.vertex([x, y, z], color, bodyWeights(y), shapes, 0.2 + 0.8 * blend));
    }
    grid.push(row);
  }
  for (let r = 0; r < rows; r++) {
    for (let s = 0; s < segs; s++) {
      const a = grid[r][s], b = grid[r][s + 1], c = grid[r + 1][s + 1], d = grid[r + 1][s];
      // Counter-clockwise seen from outside (s grows to the right, r upwards); pole cells have one triangle.
      if (r > 0) m.tri(a, b, c);
      if (r < rows - 1) m.tri(a, c, d);
    }
  }
  return m;
}

function buildEyes(): MeshBuilder {
  const m = new MeshBuilder();
  for (const s of [1, -1]) {
    const ec: V3 = [s * 0.077, 0.92, 0.151];
    const parts: [V3, number, THREE.Color, boolean][] = [
      [[0.029, 0.032, 0.015], 0, YELLOW, true], [[0.0265, 0.029, 0.014], 0.003, WHITE, false],
      [[0.0245, 0.027, 0.009], 0.014, IRIS, false], [[0.0125, 0.016, 0.005], 0.022, PUPIL, false],
    ];
    for (const [r, fwd, color, rim] of parts) {
      const c: V3 = [ec[0], ec[1], ec[2] + fwd];
      m.ellipsoid(c, r, color, [["head", 1]], 24, 12, (p, q) => {
        // Closed: squashed into a slit, pulled into the head (the rim is the skin-coloured lid).
        const shut: V3 = rim
          ? [p[0], ec[1] + (p[1] - ec[1]) * 0.22, p[2] + 0.005]
          : [p[0], ec[1] + (p[1] - ec[1]) * 0.035 + 0.006 * q[0] * q[0], ec[2] + 0.01 + (p[2] - c[2]) * 0.07];
        const wide: V3 = [ec[0] + (p[0] - ec[0]) * 1.09, ec[1] + (p[1] - ec[1]) * 1.09, ec[2] + (p[2] - ec[2]) * 1.09];
        return { blink: shut, laugh: shut, surprise: wide };
      });
    }
  }
  return m;
}

function buildMouth(): MeshBuilder {
  const m = new MeshBuilder();
  // The open mouth is shown on the face: a dark D-shaped cavity with teeth on top and the tongue below. At rest
  // it hides inside the head; the expressions bring it just in front of the dropped jaw.
  const place = (x: number, y: number, out: number): V3 => [x, y, frontZ(x, y) + out];
  const shapeOf = (u: number, v: number, depth: number): Partial<Record<State, V3>> => {
    // u −1..1 across, v 0 (top lip) … 1 (bottom of the jaw).
    const D = (w: number, h: number, sink: number): V3 => {
      const x = u * w * Math.sqrt(1 - 0.35 * v * v), y = mouthLine(x) + 0.002 - v * h * Math.sqrt(Math.max(0, 1 - u * u));
      return place(x, y, sink + depth);
    };
    return {
      rest: D(0.06, 0.004, -0.03), blink: D(0.06, 0.004, -0.03),
      laugh: D(0.068, 0.034, 0.001), tongue: D(0.066, 0.028, 0.001),
      surprise: (() => {
        const a = Math.atan2(v - 0.5, u), r = Math.hypot(u, v - 0.5) / 0.7;
        return place(0.018 * r * Math.cos(a), MOUTH_Y - 0.008 + 0.02 * r * Math.sin(a), 0.002 + depth);
      })(),
    };
  };
  const nu = 16, nv = 6;
  const grid: number[][] = [];
  for (let j = 0; j <= nv; j++) {
    const row: number[] = [];
    for (let i = 0; i <= nu; i++) {
      const sh = shapeOf(-1 + (2 * i) / nu, j / nv, 0);
      row.push(m.vertex(sh.rest!, DARK, [["head", 1]], sh));
    }
    grid.push(row);
  }
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu; i++) {
      m.tri(grid[j][i], grid[j + 1][i], grid[j + 1][i + 1]);
      m.tri(grid[j][i], grid[j + 1][i + 1], grid[j][i + 1]);
    }
  }
  // Teeth along the top lip.
  for (let k = 0; k < 9; k++) {
    const u = ((k - 4) / 4) * 0.8;
    const at = shapeOf(u, 0.12, 0.002);
    m.ellipsoid([0, 0, 0], [1, 1, 1], WHITE, [["head", 1]], 8, 6, (_p, q) => {
      const out: Partial<Record<State, V3>> = {};
      for (const s of STATES) {
        const c = at[s]!, big = s === "laugh" || s === "tongue" ? 1 : 0.1;
        out[s] = [c[0] + q[0] * 0.006, c[1] + q[1] * 0.005 * big, c[2] + q[2] * 0.003];
      }
      return out;
    });
  }
  // Tongue: lies in the jaw, sticks out for "tongue".
  const tongueAt = shapeOf(0, 0.75, 0.002);
  m.ellipsoid([0, 0, 0], [1, 1, 1], PINK, [["head", 1]], 20, 10, (_p, q) => {
    const out: Partial<Record<State, V3>> = {};
    for (const s of STATES) {
      const c = tongueAt[s]!;
      out[s] = s === "tongue"
        ? [q[0] * 0.034, c[1] - 0.03 + q[1] * 0.04 - 0.012 * (1 - q[1] * q[1]), c[2] + 0.015 + q[2] * 0.012]
        : s === "laugh" ? [q[0] * 0.032, c[1] + q[1] * 0.009, c[2] - 0.004 + q[2] * 0.008]
        : [q[0] * 0.012, c[1] + q[1] * 0.003, c[2] - 0.01 + q[2] * 0.004];
    }
    return out;
  });
  return m;
}

function buildLimbs(bones: Map<BoneName, [THREE.Vector3, THREE.Vector3]>): { arms: MeshBuilder; legs: MeshBuilder } {
  const arms = new MeshBuilder(), legs = new MeshBuilder();
  const h = (n: BoneName) => bones.get(n)![0], t = (n: BoneName) => bones.get(n)![1];
  for (const side of ["L", "R"] as const) {
    const s = side === "L" ? 1 : -1;
    const upper: BoneName = `upperarm_${side}`, fore: BoneName = `forearm_${side}`, hand: BoneName = `hand_${side}`;
    const pts: THREE.Vector3[] = [], radii: number[] = [], ws: [BoneName, number][][] = [], cs: THREE.Color[] = [];
    for (let j = 0; j < 23; j++) {
      const u = (j / 22) * 2.35;
      let p: THREE.Vector3, r: number, w: [BoneName, number][];
      if (u <= 1) (p = h(upper).clone().lerp(h(fore), u)), (r = 0.043 + 0.024 * Math.sin(Math.PI * u * 0.8));
      else if (u <= 2) (p = h(fore).clone().lerp(h(hand), u - 1)), (r = 0.059 - (u - 1) * 0.026);
      else (p = h(hand).clone().lerp(t(hand), (u - 2) / 0.35)), (r = 0.035 * (1 - (0.3 * (u - 2)) / 0.35));
      if (u < 0.7) w = [[upper, 1]];
      else if (u < 1.3) w = [[upper, 1 - smooth((u - 0.7) / 0.6)], [fore, smooth((u - 0.7) / 0.6)]];
      else if (u < 1.8) w = [[fore, 1]];
      else if (u < 2.2) w = [[fore, 1 - smooth((u - 1.8) / 0.4)], [hand, smooth((u - 1.8) / 0.4)]];
      else w = [[hand, 1]];
      pts.push(p); radii.push(r); ws.push(w); cs.push(YELLOW.clone().lerp(OLIVE, smooth((u - 1.9) / 0.3)));
    }
    arms.tube(pts, radii, ws, cs, 20);
    const palm = t(hand);
    arms.ellipsoid([palm.x, palm.y + 0.012, palm.z], [0.041, 0.041, 0.025], OLIVE, [[hand, 1]], 24, 12);
    for (const f of ["thumb", "index", "middle", "ring"] as const) {
      const n: BoneName = `${f}_${side}`;
      const d = t(n).clone().sub(h(n));
      const us = [0, 0.15, 0.35, 0.6, 0.82, 0.94, 1];
      arms.tube(us.map((u) => h(n).clone().addScaledVector(d, u)), [0.012, 0.013, 0.012, 0.011, 0.01, 0.007, 0.001],
        [0, 0.55, 1, 1, 1, 1, 1].map((u) => (u < 1 ? [[hand, 1 - u], [n, u]] : [[n, 1]]) as [BoneName, number][]),
        us.map(() => OLIVE), 12);
    }
    const thigh: BoneName = `thigh_${side}`, shin: BoneName = `shin_${side}`, foot: BoneName = `foot_${side}`;
    const lp: THREE.Vector3[] = [], lr: number[] = [], lw: [BoneName, number][][] = [], lc: THREE.Color[] = [];
    for (let j = 0; j < 18; j++) {
      const u = (j / 17) * 2;
      lp.push(u <= 1 ? h(thigh).clone().lerp(h(shin), u) : h(shin).clone().lerp(h(foot), u - 1));
      lr.push(0.064 * (1 - u / 2) + 0.016);
      const k = smooth((u - 0.65) / 0.7);
      lw.push(u < 0.65 ? [[thigh, 1]] : u > 1.35 ? [[shin, 1]] : [[thigh, 1 - k], [shin, k]]);
      lc.push(YELLOW.clone().lerp(OLIVE, smooth((u - 1.65) / 0.35)));
    }
    legs.tube(lp, lr, lw, lc, 20);
    legs.ellipsoid([s * 0.146, 0.028, 0.037], [0.047, 0.028, 0.082], OLIVE, [[foot, 1]], 28, 12);
    for (const [o, ext] of [[-0.028, 0.009], [0, 0.02], [0.028, 0.012]]) {
      legs.ellipsoid([s * (0.146 + o), 0.019, 0.095 + ext], [0.019, 0.019, 0.033], OLIVE, [[foot, 1]], 16, 10);
    }
  }
  return { arms, legs };
}

/** Blender-like bone frame: +Y along the bone, +Z as close to forward (+Z) as it can be. */
function boneFrame(head: THREE.Vector3, tail: THREE.Vector3): THREE.Matrix4 {
  const y = tail.clone().sub(head).normalize();
  const z = new THREE.Vector3(0, 0, 1).addScaledVector(y, -y.z);
  if (z.lengthSq() < 1e-6) z.set(0, -1, 0).addScaledVector(y, y.y);
  z.normalize();
  const x = new THREE.Vector3().crossVectors(y, z);
  return new THREE.Matrix4().makeBasis(x, y, z).setPosition(head);
}

/** The placeholder scene, structured like the GLB: Scene > NaiwaRig > bones + skinned meshes. */
export function buildPlaceholder(): THREE.Group {
  const scene = new THREE.Group();
  scene.name = "Scene";
  const rig = new THREE.Object3D();
  rig.name = "NaiwaRig";
  scene.add(rig);

  const list = boneList();
  const ends = new Map<BoneName, [THREE.Vector3, THREE.Vector3]>(
    list.map(([n, , h, t]) => [n, [new THREE.Vector3(...h), new THREE.Vector3(...t)]]),
  );
  const bones = new Map<BoneName, THREE.Bone>();
  const world = new Map<BoneName, THREE.Matrix4>();
  for (const [name, parent, h, t] of list) {
    const bone = new THREE.Bone();
    bone.name = name;
    const w = boneFrame(new THREE.Vector3(...h), new THREE.Vector3(...t));
    world.set(name, w);
    const local = parent ? world.get(parent)!.clone().invert().multiply(w) : w;
    local.decompose(bone.position, bone.quaternion, bone.scale);
    (parent ? bones.get(parent)! : rig).add(bone);
    bones.set(name, bone);
  }
  scene.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton([...bones.values()]);

  const skinMat = new THREE.MeshStandardMaterial({ name: "Naiwa placeholder skin", vertexColors: true, roughness: 0.5 });
  const eyeMat = new THREE.MeshStandardMaterial({ name: "Naiwa placeholder eyes", vertexColors: true, roughness: 0.34 });
  const mouthMat = new THREE.MeshStandardMaterial({ name: "Naiwa placeholder mouth", vertexColors: true, roughness: 0.43 });
  const { arms, legs } = buildLimbs(ends);
  const meshes = [
    buildBody().build("Body", skinMat, skeleton, true),
    buildEyes().build("Eyes", eyeMat, skeleton, false),
    arms.build("Arms", skinMat, skeleton, false),
    legs.build("Legs", skinMat, skeleton, false),
    buildMouth().build("MouthInside", mouthMat, skeleton, false),
  ];
  for (const mesh of meshes) {
    rig.add(mesh);
    mesh.bind(skeleton, new THREE.Matrix4());
  }
  scene.updateMatrixWorld(true);
  return scene;
}
