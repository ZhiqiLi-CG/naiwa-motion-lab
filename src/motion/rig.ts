/**
 * Binding to the character's skeleton and the solver BodyPose → PoseFrame.
 *
 * Rotations are built as world-space deltas from the rest pose (D[b], so bone world = D[b] · rest world), which makes
 * the solver independent of how the modeller oriented each bone. Limbs are aimed by direction (the frog's limbs are
 * far shorter than a person's), pushed out of the body (an elliptic-cylinder stack fitted to the Body mesh) so no arm
 * goes through the belly, and the root is lowered so the lower foot stays on the floor.
 */
import * as THREE from "three";
import { CORE_BONES, FINGER_BONES, MESH_NAMES, type BoneName, type PoseFrame, type RigInfo } from "../contracts";
import { SIDES, sideSign, type BellyHold, type BodyPose, type Side } from "./pose";

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
interface LimbSample {
  len: number;
  radius: number;
  /** Rest position, its clearance there, and the torso bone it rides on (chest for arms, hips for legs). */
  rest: V3;
  restClear: number;
  frame: BoneName;
}

/** Clearance a limb point at p needs from the body part (band) it is nearest to. */
function needed(b: Binding, D: Map<BoneName, Q>, P: Map<BoneName, V3>, sm: LimbSample, p: V3, band: Band | null): number {
  if (sm.restClear >= sm.radius || !band || band.y0 >= b.neckY) return sm.radius;
  if (sm.restClear < 0) return sm.restClear;
  const moved = toRest(b, D, P, sm.frame, p).distanceTo(sm.rest);
  const k = Math.min(1, Math.max(0, (moved - 0.02) / 0.06));
  return sm.restClear + (sm.radius - sm.restClear) * k * k * (3 - 2 * k);
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

const TORSO: BoneName[] = ["hips", "spine", "chest", "head"];
const CONTRACT = new Set<string>([...CORE_BONES, ...FINGER_BONES]);
const FINGER_SLOT = { thumb: 0, index: 1, middle: 2, ring: 3 } as const;

const v = () => new THREE.Vector3();
const sub = (a: V3, b: V3) => a.clone().sub(b);

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
  // Margins: each limb point keeps its flesh thickness away from the body, but never needs more room than the rest
  // pose gives it.
  const D = restDeltas();
  // The bands only approximate the skinned body: keep a centimetre more than the flesh thickness.
  const fit = (list: LimbSample[], from: V3, dir: V3, radius: number) => {
    for (const sm of list) {
      sm.radius = radius + 0.01;
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

function restDeltas(): Map<BoneName, Q> {
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

interface Posed {
  D: Map<BoneName, Q>;
  P: Map<BoneName, V3>;
}

/** Joint position of b from its contract ancestor's current position and rotation. */
function place(b: Binding, s: Posed, name: BoneName): V3 {
  const r = b.rest.get(name)!;
  const anc = r.anc!;
  const p = sub(r.pos, b.rest.get(anc)!.pos).applyQuaternion(s.D.get(anc)!).add(s.P.get(anc)!);
  s.P.set(name, p);
  return p;
}

/** Point in the rest frame of a torso bone. */
function toRest(b: Binding, D: Map<BoneName, Q>, P: Map<BoneName, V3>, bone: BoneName, p: V3): V3 {
  const r = b.rest.get(bone)!;
  return sub(p, P.get(bone) ?? r.pos).applyQuaternion(D.get(bone)!.clone().invert()).add(r.pos);
}
function fromRest(b: Binding, D: Map<BoneName, Q>, P: Map<BoneName, V3>, bone: BoneName, q: V3): V3 {
  const r = b.rest.get(bone)!;
  return sub(q, r.pos).applyQuaternion(D.get(bone)!).add(P.get(bone) ?? r.pos);
}

/** Signed horizontal clearance of p from the body (most penetrating band) and the band it refers to. */
function clearance(b: Binding, D: Map<BoneName, Q>, p: V3, P = new Map<BoneName, V3>()) {
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

/** p moved horizontally (in its band's frame) to `margin` outside the body, or null when it already is. */
function pushOut(b: Binding, s: Posed, p: V3, margin: number, side: Side): V3 | null {
  const { c, band, q } = clearance(b, s.D, p, s.P);
  if (!band || c >= margin) return null;
  let dx = q.x - band.cx, dz = q.z - band.cz;
  let r = Math.hypot(dx, dz);
  if (r < 1e-6) (dx = sideSign(side)), (dz = 0), (r = 1);
  const reff = 1 / Math.hypot(dx / r / band.rx, dz / r / band.rz);
  const k = (reff + margin) / r;
  return fromRest(b, s.D, s.P, band.bone, new THREE.Vector3(band.cx + dx * k, q.y, band.cz + dz * k));
}

/**
 * Aim a segment from `base` along `dir` so none of its sample points sinks into the body: the worst one is pushed
 * out first and the segment turned towards it, until all are clear.
 */
function clearSegment(b: Binding, s: Posed, base: V3, dir: V3, list: LimbSample[], side: Side): V3 {
  let d = dir;
  for (let it = 0; it < 10; it++) {
    let worst: { p: V3; margin: number } | null = null, depth = 0.001;
    for (const sm of list) {
      const p = base.clone().addScaledVector(d, sm.len);
      const c = clearance(b, s.D, p, s.P);
      const margin = needed(b, s.D, s.P, sm, p, c.band);
      const over = margin - c.c;
      if (over > depth) (depth = over), (worst = { p, margin });
    }
    if (!worst) break;
    const q = pushOut(b, s, worst.p, worst.margin + 0.003, side);
    if (!q) break;
    d = sub(q, base).normalize();
  }
  return d;
}

function bandAt(b: Binding, y: number): Band {
  let best = b.bands[0];
  for (const band of b.bands) if (Math.abs((band.y0 + band.y1) / 2 - y) < Math.abs((best.y0 + best.y1) / 2 - y)) best = band;
  return best;
}

const swing = (from: V3, to: V3) => new THREE.Quaternion().setFromUnitVectors(from.clone().normalize(), to.clone().normalize());
const nlerp = (a: V3, b: V3, w: number) => {
  const r = a.clone().lerp(b, w);
  return r.lengthSq() < 1e-8 ? a.clone() : r.normalize();
};
/** Rotation taking the frame (f0, n0) to (f1, n1) (finger direction and palm normal; n made orthogonal to f). */
function frameRotation(f0: V3, n0: V3, f1: V3, n1: V3): Q {
  const basis = (f: V3, n: V3) => {
    const x = f.clone().normalize();
    const y = n.clone().addScaledVector(x, -n.dot(x)).normalize();
    return new THREE.Matrix4().makeBasis(x, y, x.clone().cross(y));
  };
  const m = basis(f1, n1).multiply(basis(f0, n0).transpose());
  return new THREE.Quaternion().setFromRotationMatrix(m);
}

/** Two-bone IK: upper arm and forearm directions from S reaching W (straight towards it when out of reach), the
 *  elbow bending towards `pole`. */
function twoBone(S: V3, W: V3, upper: number, fore: number, pole: V3) {
  const d = Math.min(Math.max(W.distanceTo(S), Math.abs(upper - fore) + 1e-4), upper + fore - 1e-4);
  const axis = sub(W, S).normalize();
  const cosA = (upper * upper + d * d - fore * fore) / (2 * upper * d);
  const perp = pole.clone().addScaledVector(axis, -pole.dot(axis)).normalize();
  const E = S.clone().addScaledVector(axis, upper * cosA).addScaledVector(perp, upper * Math.sqrt(Math.max(0, 1 - cosA * cosA)));
  const Wr = S.clone().addScaledVector(axis, d);
  return { upper: sub(E, S).normalize(), fore: sub(Wr, E).normalize() };
}

/** Two-bone IK onto a spot of the belly: upper/forearm directions, palm normal and finger direction (world). */
function bellyArm(b: Binding, s: Posed, side: Side, hold: BellyHold, S: V3) {
  const a = b.arm[side];
  const rest = (n: BoneName) => b.rest.get(n)!.pos;
  const y = rest("hips").y + (rest("chest").y - rest("hips").y) * hold.height;
  const band = bandAt(b, y);
  const sg = sideSign(side), sn = Math.sin(hold.around), cs = Math.cos(hold.around);
  const qy = Math.min(Math.max(y, band.y0), band.y1);
  const spot = fromRest(b, s.D, s.P, band.bone, new THREE.Vector3(band.cx + sg * band.rx * sn, qy, band.cz + band.rz * cs));
  const R = s.D.get(band.bone)!;
  const N = new THREE.Vector3((sg * sn) / band.rx, 0, cs / band.rz).normalize().applyQuaternion(R);
  const clear = a.foreS[a.foreS.length - 1].radius + hold.lift;
  let W = spot.addScaledVector(N, clear);
  const reach = 0.97 * (a.upper + a.fore);
  for (let k = 0; k < 6; k++) {
    const d = W.distanceTo(S);
    if (d <= reach) break;
    W = S.clone().addScaledVector(sub(W, S), reach / d);
    W = pushOut(b, s, W, clear, side) ?? W;
  }
  const ik = twoBone(S, W, a.upper, a.fore, new THREE.Vector3(sg * 0.8, -0.3, -0.5).applyQuaternion(s.D.get("chest")!));
  // Fingers lie along the belly, towards its front centre and a little down.
  const tangent = new THREE.Vector3(-sg * band.rx * cs, 0, band.rz * sn).normalize().add(new THREE.Vector3(0, -0.6, 0)).applyQuaternion(R);
  return {
    ...ik,
    palm: N.clone().negate(),
    finger: tangent.addScaledVector(N, -tangent.dot(N)).normalize(),
  };
}

/** Solve a BodyPose for the bound rig. */
export function solve(b: Binding, pose: BodyPose): PoseFrame {
  const D = restDeltas();
  const P = new Map<BoneName, V3>([["root", b.rest.get("root")!.pos.clone()]]);
  const s: Posed = { D, P };
  D.set("hips", pose.hips.clone());
  D.set("spine", D.get("hips")!.clone().multiply(pose.spine));
  D.set("chest", D.get("spine")!.clone().multiply(pose.chest));
  D.set("head", D.get("chest")!.clone().multiply(pose.head));
  for (const n of TORSO) place(b, s, n);
  const chest = D.get("chest")!;

  for (const side of SIDES) {
    const goal = pose.arm[side];
    const a = b.arm[side];
    const S = place(b, s, `upperarm_${side}`);
    let u = goal.upper.clone().applyQuaternion(chest);
    let f = goal.fore.clone().applyQuaternion(chest);
    const w = goal.belly ? Math.min(Math.max(goal.belly.weight, 0), 1) : 0;
    const ik = goal.belly && w > 0 ? bellyArm(b, s, side, goal.belly, S) : null;
    if (ik) {
      u = nlerp(u, ik.upper, w);
      f = nlerp(f, ik.fore, w);
    }
    // Hands above the person's head go above the frog's head: its arms are short for its head, so they reach (IK)
    // for a spot just above it, beside the middle, elbows out.
    if (goal.overhead > 0) {
      const sg = sideSign(side);
      const W = fromRest(b, D, P, "head", b.headTop).add(new THREE.Vector3(0.07 * sg, 0.05, 0.02).applyQuaternion(chest));
      const up = twoBone(S, W, a.upper, a.fore, new THREE.Vector3(sg, 0.3, -0.2).applyQuaternion(chest));
      const k = Math.min(goal.overhead, 1);
      u = nlerp(u, up.upper, k);
      f = nlerp(f, up.fore, k);
    }
    // Keep every point of the arm and hand out of the body. The hand lies along the forearm, or along the belly when
    // holding it (then a hand point in the body moves the wrist).
    const along = a.handS.map((sm) => ({ ...sm, len: a.fore + sm.len }));
    for (let k = 0; k < 2; k++) {
      u = clearSegment(b, s, S, u, a.upperS, side);
      const E = S.clone().addScaledVector(u, a.upper);
      f = clearSegment(b, s, E, f, ik ? a.foreS : [...a.foreS, ...along], side);
      if (!ik) continue;
      const hd = nlerp(f, ik.finger, w);
      for (const sm of a.handS) {
        const W = E.clone().addScaledVector(f, a.fore);
        const p = W.clone().addScaledVector(hd, sm.len);
        const q = pushOut(b, s, p, needed(b, D, P, sm, p, clearance(b, D, p, P).band) + 0.003, side);
        if (q) f = W.add(q).sub(p).sub(E).normalize();
      }
    }
    const up = `upperarm_${side}` as const, fo = `forearm_${side}` as const, ha = `hand_${side}` as const;
    D.set(up, swing(a.dirUpper.clone().applyQuaternion(chest), u).multiply(chest));
    place(b, s, fo);
    D.set(fo, swing(a.dirFore.clone().applyQuaternion(D.get(up)!), f).multiply(D.get(up)!));
    place(b, s, ha);
    // The hand follows the forearm, turned onto the belly by the hold and towards the palm goal.
    const Dfo = D.get(fo)!;
    const curF = a.finger.clone().applyQuaternion(Dfo), curN = a.palm.clone().applyQuaternion(Dfo);
    let tf = curF, tn = curN;
    if (ik) (tf = nlerp(curF, ik.finger, w)), (tn = nlerp(curN, ik.palm, w));
    if (goal.palm && goal.palm.weight > 0) tn = nlerp(tn, goal.palm.dir.clone().applyQuaternion(chest), Math.min(goal.palm.weight, 1));
    const Dha = tf === curF && tn === curN ? Dfo.clone() : frameRotation(curF, curN, tf, tn).multiply(Dfo);
    D.set(ha, Dha);
    // Fingers curl as asked, less where the tips would go into the body (a fist on the hip).
    const [, , , , spread] = goal.fingers;
    for (const fg of b.fingers[side]) {
      const base = place(b, s, fg.name);
      const at = (k: number) => {
        const q = new THREE.Quaternion().setFromAxisAngle(fg.curlAxis, goal.fingers[fg.slot] * k);
        if (fg.spreadAxis && spread) q.premultiply(new THREE.Quaternion().setFromAxisAngle(fg.spreadAxis, spread));
        return Dha.clone().multiply(q);
      };
      const clearAt = (k: number) => clearance(b, D, base.clone().addScaledVector(fg.dir.clone().applyQuaternion(at(k)), fg.len), P).c > 0.012;
      let k = 1;
      if (goal.fingers[fg.slot] > 0 && !clearAt(1)) {
        let lo = 0;
        for (let i = 0; i < 6; i++) if (clearAt((lo + k) / 2)) lo = (lo + k) / 2; else k = (lo + k) / 2;
        k = lo;
      }
      D.set(fg.name, at(k));
    }
  }

  let lowest = Infinity;
  for (const side of SIDES) {
    const goal = pose.leg[side];
    const l = b.leg[side];
    const sg = sideSign(side);
    const H = place(b, s, `thigh_${side}`);
    let t = goal.thigh.clone().normalize();
    let sh = goal.shin.clone().normalize();
    // Keep the thigh and shin out of the body, alternating with the bone lengths. A knee raised into the belly where
    // the thigh is too short to get round it swings down and out instead (a fat frog's squat).
    const escape = new THREE.Vector3(0.7 * sg, -1, 0.3).normalize();
    const knee = l.thighS[l.thighS.length - 1];
    for (let k = 0; k < 3; k++) {
      t = clearSegment(b, s, H, t, l.thighS, side);
      const K = H.clone().addScaledVector(t, l.thigh);
      if (sg * K.x < 0.5 * l.kneeX) (K.x = 0.5 * l.kneeX * sg), (t = sub(K, H).normalize());
      const kneeAt = () => H.clone().addScaledVector(t, l.thigh);
      const kneeShort = () => {
        const c = clearance(b, D, kneeAt(), P);
        return c.c < needed(b, D, P, knee, kneeAt(), c.band) - 0.003;
      };
      for (let j = 1; j <= 8 && kneeShort(); j++)
        t = nlerp(t, escape, 0.15);
      const K2 = H.clone().addScaledVector(t, l.thigh);
      sh = clearSegment(b, s, K2, sh, l.shinS, side);
      const A = K2.clone().addScaledVector(sh, l.shin);
      if (sg * A.x < 0.5 * l.ankleX) (A.x = 0.5 * l.ankleX * sg), (sh = sub(A, K2).normalize());
    }
    const th = `thigh_${side}` as const, sn = `shin_${side}` as const, ft = `foot_${side}` as const;
    D.set(th, swing(l.dirThigh.clone().applyQuaternion(D.get("hips")!), t).multiply(D.get("hips")!));
    place(b, s, sn);
    D.set(sn, swing(l.dirShin.clone().applyQuaternion(D.get(th)!), sh).multiply(D.get(th)!));
    lowest = Math.min(lowest, place(b, s, ft).y);
    D.set(ft, new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), goal.toe));
  }

  const bones: PoseFrame["bones"] = {};
  for (const [name, r] of b.rest) {
    if (name === "root") continue;
    const parentWorld = D.get(r.anc!)!.clone().multiply(r.parentQ);
    bones[name] = parentWorld.invert().multiply(D.get(name)!.clone().multiply(r.q));
  }
  const expressions: PoseFrame["expressions"] = {};
  for (const [k, x] of Object.entries(pose.expressions)) if (x > 0.01) expressions[k as keyof typeof expressions] = Math.min(x, 1);
  return {
    bones,
    rootOffset: new THREE.Vector3(pose.shift, b.restFootY - lowest + Math.max(0, pose.lift), 0),
    rootYaw: Math.atan2(Math.sin(pose.yaw), Math.cos(pose.yaw)),
    expressions,
  };
}

/** FK of a solved frame on the rest skeleton, in the frog's own frame (no root offset or yaw). */
function fk(b: Binding, frame: PoseFrame): Posed {
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

/** How far the limbs of a solved frame sink into the body beyond what the rest pose allows (m, 0 = clear). */
export function limbPenetration(b: Binding, frame: PoseFrame): number {
  const s = fk(b, frame);
  let worst = 0;
  const check = (from: V3, dir: V3, list: LimbSample[]) => {
    for (const sm of list) {
      const p = from.clone().addScaledVector(dir, sm.len);
      const c = clearance(b, s.D, p, s.P);
      worst = Math.max(worst, needed(b, s.D, s.P, sm, p, c.band) - c.c);
    }
  };
  for (const side of SIDES) {
    const a = b.arm[side], l = b.leg[side];
    const at = (n: BoneName) => s.P.get(n)!;
    check(at(`upperarm_${side}`), sub(at(`forearm_${side}`), at(`upperarm_${side}`)).normalize(), a.upperS);
    check(at(`forearm_${side}`), sub(at(`hand_${side}`), at(`forearm_${side}`)).normalize(), a.foreS);
    check(at(`hand_${side}`), a.finger.clone().applyQuaternion(s.D.get(`hand_${side}`)!), a.handS);
    check(at(`thigh_${side}`), sub(at(`shin_${side}`), at(`thigh_${side}`)).normalize(), l.thighS);
    check(at(`shin_${side}`), sub(at(`foot_${side}`), at(`shin_${side}`)).normalize(), l.shinS);
  }
  return worst;
}
