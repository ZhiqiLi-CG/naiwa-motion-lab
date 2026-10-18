/**
 * Binding to the character's skeleton: the rest skeleton, the limbs' lengths, sample points and flesh thickness, and
 * the body's shape as an elliptic-cylinder stack fitted to the Body mesh. The retargeting blocks (blocks/) read it.
 *
 * Poses are world-space rotations from the rest pose (D[b], so bone world = D[b] · rest world), which makes the
 * blocks independent of how the modeller oriented each bone.
 */
import * as THREE from "three";
import { CORE_BONES, FINGER_BONES, MESH_NAMES, type BoneName, type PoseFrame, type RigInfo } from "../contracts";
import { SIDES, sideSign, type Side } from "./pose";

type V3 = THREE.Vector3;
type Q = THREE.Quaternion;

interface RestBone {
  pos: V3;
  q: Q;
  /** Rest world rotation of the bone's actual parent object (a contract bone, an extra bone or the armature). */
  parentQ: Q;
  /** Nearest contract-bone ancestor (rotations of bones in between stay at rest). */
  anc: BoneName | null;
}

/** A slice of the body: an elliptic cylinder over [y0, y1] in the rest frame, carried by one torso bone. */
export interface Band {
  bone: BoneName;
  y0: number;
  y1: number;
  cx: number;
  cz: number;
  rx: number;
  rz: number;
}

/**
 * A point on a limb kept out of the body: `len` from the segment's base joint. It needs its flesh thickness of
 * clearance. Points buried at rest (the limb roots: the shoulders sit deep in the body, the thighs under the belly)
 * may stay as deep against the torso below the shoulders, never against the neck and head; points that only touch the
 * body at rest (an elbow on the belly) may do so near their rest spot only.
 */
export interface LimbSample {
  len: number;
  /** Flesh thickness around the bone there (m). */
  radius: number;
  /** Rest position, its clearance there, and the torso bone it rides on (chest for arms, hips for legs). */
  rest: V3;
  restClear: number;
  frame: BoneName;
}

interface ArmRest {
  upper: number;
  fore: number;
  /** Wrist to finger tips. */
  hand: number;
  dirUpper: V3;
  dirFore: V3;
  /** Rest finger direction and palm normal of the hand (world). */
  finger: V3;
  palm: V3;
  /** Along the upper arm from the shoulder, the forearm from the elbow, the hand from the wrist. */
  upperS: LimbSample[];
  foreS: LimbSample[];
  handS: LimbSample[];
}

interface LegRest {
  thigh: number;
  shin: number;
  dirThigh: V3;
  dirShin: V3;
  thighS: LimbSample[];
  shinS: LimbSample[];
  /** |x| of the rest knee and ankle: they keep at least half of it so the legs never cross. */
  kneeX: number;
  ankleX: number;
}

export interface Binding {
  rest: Map<BoneName, RestBone>;
  bands: Band[];
  /** Where the bands came from. */
  bodySource: "mesh" | "bones";
  arm: Record<Side, ArmRest>;
  leg: Record<Side, LegRest>;
  /** Finger bones: rest direction, curl and spread axes (world), slot in the curl list, and length to the tip. */
  fingers: Record<Side, { name: BoneName; dir: V3; curlAxis: V3; spreadAxis: V3 | null; slot: number; len: number }[]>;
  height: number;
  restFootY: number;
  /** Top of the head (rest pose), carried by the head bone. */
  headTop: V3;
  /** Height of the shoulder joints: above it the body is neck and head, where no limb may sink in. */
  neckY: number;
}

const CONTRACT = new Set<string>([...CORE_BONES, ...FINGER_BONES]);
const FINGER_SLOT = { thumb: 0, index: 1, middle: 2, ring: 3 } as const;

const v = () => new THREE.Vector3();
export const sub = (a: V3, b: V3) => a.clone().sub(b);

export function bindRig(rig: RigInfo): Binding {
  const root = rig.bones.get("root");
  if (!root) throw new Error("motion: rig has no root bone");
  let top: THREE.Object3D = root;
  while (top.parent) top = top.parent;
  top.updateWorldMatrix(false, true);
  const origin = root.getWorldPosition(v());

  const nameOf = new Map<THREE.Object3D, BoneName>();
  for (const [name, bone] of rig.bones) if (CONTRACT.has(name)) nameOf.set(bone, name);
  const rest = new Map<BoneName, RestBone>();
  for (const [bone, name] of nameOf) {
    let anc: BoneName | null = null;
    for (let o = bone.parent; o && !anc; o = o.parent) anc = nameOf.get(o) ?? null;
    rest.set(name, {
      pos: bone.getWorldPosition(v()).sub(origin),
      q: bone.getWorldQuaternion(new THREE.Quaternion()),
      parentQ: bone.parent ? bone.parent.getWorldQuaternion(new THREE.Quaternion()) : new THREE.Quaternion(),
      anc,
    });
  }
  for (const name of CORE_BONES) if (!rest.has(name)) throw new Error(`motion: rig has no ${name} bone`);
  const P = (n: BoneName) => rest.get(n)!.pos;

  const meshBands = bandsFromMesh(top, origin, rest);
  const bands = meshBands ?? bandsFromBones(rest, rig.height);
  const flesh = limbFlesh(top, origin, rest);

  const fingers: Binding["fingers"] = { L: [], R: [] };
  const arm = {} as Record<Side, ArmRest>;
  const leg = {} as Record<Side, LegRest>;
  for (const s of SIDES) {
    const sh = P(`upperarm_${s}`), el = P(`forearm_${s}`), wr = P(`hand_${s}`);
    const own = (["thumb", "index", "middle", "ring"] as const).filter((f) => rest.has(`${f}_${s}`));
    const knuckles = own.filter((f) => f !== "thumb").map((f) => P(`${f}_${s}`));
    const centre = knuckles.length ? knuckles.reduce((a, b) => a.clone().add(b)).divideScalar(knuckles.length) : null;
    const upper = el.distanceTo(sh), fore = wr.distanceTo(el);
    const finger = centre ? sub(centre, wr).normalize() : sub(wr, el).normalize();
    const palm = palmNormal(s, finger, knuckles, rest.has(`thumb_${s}`) ? P(`thumb_${s}`) : null, centre);
    const hand = flesh.get(`hand_${s}`) ?? (centre ? centre.distanceTo(wr) * 1.8 : fore * 0.5);
    const along = (len: number, ks: number[]) => ks.map((k): LimbSample => ({ len: len * k, radius: 0, rest: v(), restClear: 0, frame: "chest" }));
    arm[s] = {
      upper,
      fore,
      hand,
      dirUpper: sub(el, sh).normalize(),
      dirFore: sub(wr, el).normalize(),
      finger,
      palm,
      upperS: along(upper, [0.5, 0.75, 1]),
      foreS: along(fore, [0.33, 0.66, 1]),
      handS: along(hand, [0.45, 0.9]),
    };
    for (const f of own) {
      const name = `${f}_${s}` as BoneName;
      const d = f === "thumb" ? sub(P(name), wr).normalize() : finger.clone();
      const pair = f === "index" ? "middle" : f === "middle" ? "index" : null;
      const spreadAxis = pair && rest.has(`${pair}_${s}`) ? d.clone().cross(sub(P(name), P(`${pair}_${s}`))).normalize() : null;
      const len = Math.max(0.02, hand - P(name).distanceTo(wr));
      fingers[s].push({ name, dir: d, curlAxis: d.clone().cross(palm).normalize(), spreadAxis, slot: FINGER_SLOT[f], len });
    }
    const hip = P(`thigh_${s}`), knee = P(`shin_${s}`), ankle = P(`foot_${s}`);
    const thigh = knee.distanceTo(hip), shin = ankle.distanceTo(knee);
    leg[s] = {
      thigh,
      shin,
      dirThigh: sub(knee, hip).normalize(),
      dirShin: sub(ankle, knee).normalize(),
      thighS: [0.5, 1].map((k): LimbSample => ({ len: thigh * k, radius: 0, rest: v(), restClear: 0, frame: "hips" })),
      shinS: [0.5, 1].map((k): LimbSample => ({ len: shin * k, radius: 0, rest: v(), restClear: 0, frame: "hips" })),
      kneeX: Math.abs(knee.x),
      ankleX: Math.abs(ankle.x),
    };
  }

  const b: Binding = {
    rest,
    bands,
    bodySource: meshBands ? "mesh" : "bones",
    arm,
    leg,
    fingers,
    height: rig.height,
    restFootY: Math.min(P("foot_L").y, P("foot_R").y),
    headTop: ((t: Band) => new THREE.Vector3(t.cx, t.y1, t.cz))(bands.reduce((a, c) => (c.y1 > a.y1 ? c : a))),
    neckY: Math.min(P("upperarm_L").y, P("upperarm_R").y),
  };
  // Each limb point's flesh thickness and how much room the rest pose gives it.
  const D = restDeltas();
  const fit = (list: LimbSample[], from: V3, dir: V3, radius: number) => {
    for (const sm of list) {
      sm.radius = radius;
      sm.rest = from.clone().addScaledVector(dir, sm.len);
      sm.restClear = clearance(b, D, sm.rest).c - 0.004;
    }
  };
  const r = (name: BoneName, fallback: number) => flesh.get(name) ?? fallback;
  for (const s of SIDES) {
    const a = arm[s], l = leg[s];
    fit(a.upperS, P(`upperarm_${s}`), a.dirUpper, r(`upperarm_${s}`, 0.28 * a.upper));
    fit(a.foreS, P(`forearm_${s}`), a.dirFore, r(`forearm_${s}`, 0.24 * a.fore));
    fit(a.handS, P(`hand_${s}`), a.finger, r(`forearm_${s}`, 0.24 * a.fore));
    fit(l.thighS, P(`thigh_${s}`), l.dirThigh, r(`thigh_${s}`, 0.3 * l.thigh));
    fit(l.shinS, P(`shin_${s}`), l.dirShin, r(`shin_${s}`, 0.25 * l.shin));
  }
  return b;
}

/**
 * Flesh around the limb bones, measured on the Arms and Legs meshes at rest: per segment the thickness (90th
 * percentile distance of its vertices from the bone), and for hand_* the reach from the wrist to the finger tips.
 */
function limbFlesh(top: THREE.Object3D, origin: V3, rest: Map<BoneName, RestBone>): Map<BoneName, number> {
  const next: Partial<Record<BoneName, BoneName>> = {};
  for (const s of SIDES) {
    next[`upperarm_${s}`] = `forearm_${s}`;
    next[`forearm_${s}`] = `hand_${s}`;
    next[`thigh_${s}`] = `shin_${s}`;
    next[`shin_${s}`] = `foot_${s}`;
  }
  const dist = new Map<BoneName, number[]>();
  const add = (n: BoneName, d: number) => (dist.get(n) ?? dist.set(n, []).get(n)!).push(d);
  const p = v(), si = new THREE.Vector4(), sw = new THREE.Vector4(), seg = new THREE.Line3(), q = v();
  for (const meshName of [MESH_NAMES.arms, MESH_NAMES.legs]) {
    top.getObjectByName(meshName)?.traverse((o) => {
      const mesh = o as THREE.SkinnedMesh;
      if (!mesh.isSkinnedMesh) return;
      const g = mesh.geometry;
      for (let i = 0; i < g.getAttribute("position").count; i++) {
        si.fromBufferAttribute(g.getAttribute("skinIndex") as THREE.BufferAttribute, i);
        sw.fromBufferAttribute(g.getAttribute("skinWeight") as THREE.BufferAttribute, i);
        let k = 0;
        for (let c = 1; c < 4; c++) if (sw.getComponent(c) > sw.getComponent(k)) k = c;
        let name = mesh.skeleton.bones[si.getComponent(k)]?.name as BoneName;
        if (name?.match(/^(thumb|index|middle|ring)_/)) name = `hand_${name.slice(-1)}` as BoneName;
        if (!name || !rest.has(name)) continue;
        mesh.getVertexPosition(i, p).applyMatrix4(mesh.matrixWorld).sub(origin);
        const to = next[name];
        if (to) add(name, seg.set(rest.get(name)!.pos, rest.get(to)!.pos).closestPointToPoint(p, true, q).distanceTo(p));
        else if (name.startsWith("hand_")) add(name, p.distanceTo(rest.get(name)!.pos));
      }
    });
  }
  const out = new Map<BoneName, number>();
  for (const [n, d] of dist) if (d.length > 20) out.set(n, d.sort((a, b) => a - b)[Math.floor(d.length * 0.9)]);
  return out;
}

/**
 * The palm's normal: across the knuckle row, on the thumb's side. Without fingers to tell, a relaxed hand is taken to
 * face the body.
 */
function palmNormal(s: Side, finger: V3, knuckles: V3[], thumb: V3 | null, centre: V3 | null): V3 {
  const towardsBody = new THREE.Vector3(-sideSign(s), 0, 0);
  let n = towardsBody;
  if (knuckles.length >= 2) {
    const across = sub(knuckles[knuckles.length - 1], knuckles[0]);
    n = finger.clone().cross(across);
    if (thumb && centre ? sub(thumb, centre).dot(n) < 0 : n.dot(towardsBody) < 0) n.negate();
  }
  return n.addScaledVector(finger, -n.dot(finger)).normalize();
}

export function restDeltas(): Map<BoneName, Q> {
  const D = new Map<BoneName, Q>();
  for (const n of [...CORE_BONES, ...FINGER_BONES]) D.set(n, new THREE.Quaternion());
  return D;
}

/** Fit bands to the rest-pose Body mesh found next to the skeleton (null if the asset has none). */
function bandsFromMesh(top: THREE.Object3D, origin: V3, rest: Map<BoneName, RestBone>): Band[] | null {
  const body = top.getObjectByName(MESH_NAMES.body);
  if (!body) return null;
  const pts: number[] = [];
  const p = v();
  body.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const n = mesh.geometry.getAttribute("position").count;
    for (let i = 0; i < n; i++) {
      mesh.getVertexPosition(i, p).applyMatrix4(mesh.matrixWorld).sub(origin);
      pts.push(p.x, p.y, p.z);
    }
  });
  if (pts.length < 30) return null;
  let y0 = Infinity, y1 = -Infinity;
  for (let i = 1; i < pts.length; i += 3) (y0 = Math.min(y0, pts[i])), (y1 = Math.max(y1, pts[i]));
  const N = 20;
  const bands: Band[] = [];
  for (let k = 0; k < N; k++) {
    const a = y0 + ((y1 - y0) * k) / N, z = y0 + ((y1 - y0) * (k + 1)) / N;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < pts.length; i += 3) {
      if (pts[i + 1] < a || pts[i + 1] > z) continue;
      minX = Math.min(minX, pts[i]), maxX = Math.max(maxX, pts[i]);
      minZ = Math.min(minZ, pts[i + 2]), maxZ = Math.max(maxZ, pts[i + 2]);
    }
    if (!(maxX > minX && maxZ > minZ)) continue;
    bands.push({ bone: ownerAt((a + z) / 2, rest), y0: a, y1: z, cx: (minX + maxX) / 2, cz: (minZ + maxZ) / 2, rx: (maxX - minX) / 2, rz: (maxZ - minZ) / 2 });
  }
  return bands;
}

/** Without a Body mesh: a pear shape guessed from the skeleton (shoulders sit on the surface). */
function bandsFromBones(rest: Map<BoneName, RestBone>, height: number): Band[] {
  const P = (n: BoneName) => rest.get(n)!.pos;
  const w = Math.abs(P("upperarm_L").x - P("upperarm_R").x) / 2;
  const bottom = P("hips").y - 0.6 * (P("hips").y - P("shin_L").y);
  const profile: [number, number][] = [
    [bottom, 0.9 * w],
    [P("hips").y, 1.45 * w],
    [P("spine").y, 1.5 * w],
    [P("chest").y, 1.15 * w],
    [P("upperarm_L").y, 1.0 * w],
    [P("head").y, 0.85 * w],
    [height, 0.3 * w],
  ];
  const bands: Band[] = [];
  const N = 16;
  for (let k = 0; k < N; k++) {
    const a = bottom + ((height - bottom) * k) / N, z = bottom + ((height - bottom) * (k + 1)) / N, m = (a + z) / 2;
    let i = 0;
    while (i < profile.length - 2 && profile[i + 1][0] < m) i++;
    const [ya, ra] = profile[i], [yb, rb] = profile[i + 1];
    const r = ra + ((rb - ra) * (m - ya)) / (yb - ya);
    bands.push({ bone: ownerAt(m, rest), y0: a, y1: z, cx: 0, cz: 0.1 * w, rx: r, rz: r * 0.95 });
  }
  return bands;
}

function ownerAt(y: number, rest: Map<BoneName, RestBone>): BoneName {
  const Y = (n: BoneName) => rest.get(n)!.pos.y;
  return y < Y("spine") ? "hips" : y < Y("chest") ? "spine" : y < Y("head") ? "chest" : "head";
}

/* ------------------------------------------------------------------------------------------------------------------ */

/** A posed skeleton: world rotations from rest (D) and joint positions (P). */
export interface Posed {
  D: Map<BoneName, Q>;
  P: Map<BoneName, V3>;
}

/** Joint position of b from its contract ancestor's current position and rotation. */
export function place(b: Binding, s: Posed, name: BoneName): V3 {
  const r = b.rest.get(name)!;
  const anc = r.anc!;
  const p = sub(r.pos, b.rest.get(anc)!.pos).applyQuaternion(s.D.get(anc)!).add(s.P.get(anc)!);
  s.P.set(name, p);
  return p;
}

/** Point in the rest frame of a torso bone. */
export function toRest(b: Binding, D: ReadonlyMap<BoneName, Q>, P: ReadonlyMap<BoneName, V3>, bone: BoneName, p: V3): V3 {
  const r = b.rest.get(bone)!;
  return sub(p, P.get(bone) ?? r.pos).applyQuaternion(D.get(bone)!.clone().invert()).add(r.pos);
}
export function fromRest(b: Binding, D: ReadonlyMap<BoneName, Q>, P: ReadonlyMap<BoneName, V3>, bone: BoneName, q: V3): V3 {
  const r = b.rest.get(bone)!;
  return sub(q, r.pos).applyQuaternion(D.get(bone)!).add(P.get(bone) ?? r.pos);
}

/** Signed horizontal clearance of p from the body (most penetrating band), the band it refers to and p in that band's
 *  rest frame. */
export function clearance(b: Binding, D: ReadonlyMap<BoneName, Q>, p: V3, P: ReadonlyMap<BoneName, V3> = new Map()) {
  let best = { c: Infinity, band: null as Band | null, q: p };
  for (const band of b.bands) {
    const q = toRest(b, D, P, band.bone, p);
    if (q.y < band.y0 || q.y > band.y1) continue;
    const dx = q.x - band.cx, dz = q.z - band.cz;
    const r = Math.hypot(dx, dz);
    const reff = r < 1e-6 ? Math.min(band.rx, band.rz) : 1 / Math.hypot(dx / r / band.rx, dz / r / band.rz);
    if (r - reff < best.c) best = { c: r - reff, band, q };
  }
  return best;
}

/** FK of a solved frame on the rest skeleton, in the frog's own frame (no root offset or yaw). */
export function fk(b: Binding, frame: PoseFrame): Posed {
  const D = new Map<BoneName, Q>([["root", new THREE.Quaternion()]]);
  const P = new Map<BoneName, V3>([["root", b.rest.get("root")!.pos.clone()]]);
  for (const name of [...CORE_BONES, ...FINGER_BONES]) {
    const r = b.rest.get(name);
    if (!r || name === "root") continue;
    const parentWorld = D.get(r.anc!)!.clone().multiply(r.parentQ);
    const local = frame.bones[name] ?? r.parentQ.clone().invert().multiply(r.q);
    D.set(name, parentWorld.multiply(local).multiply(r.q.clone().invert()));
    place(b, { D, P }, name);
  }
  return { D, P };
}

/** World joint positions of a solved frame (FK from the rest skeleton), for stick figures and tests. */
export function jointPositions(b: Binding, frame: PoseFrame): Map<BoneName, V3> {
  const { P } = fk(b, frame);
  const yaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), frame.rootYaw ?? 0);
  for (const p of P.values()) p.applyQuaternion(yaw).add(frame.rootOffset ?? new THREE.Vector3());
  return P;
}

