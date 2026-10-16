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

interface ArmRest {
  upper: number;
  fore: number;
  hand: number;
  dirUpper: V3;
  dirFore: V3;
  /** Rest finger direction and palm normal of the hand (world). */
  finger: V3;
  palm: V3;
  /** Allowed clearance from the body for elbow, wrist and hand tip (m; negative = may sink in as in the rest pose). */
  margin: [number, number, number];
}

interface LegRest {
  thigh: number;
  shin: number;
  dirThigh: V3;
  dirShin: V3;
  margin: [number, number];
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
  fingers: Record<Side, { name: BoneName; dir: V3; curlAxis: V3; spreadAxis: V3 | null; slot: number }[]>;
  height: number;
  restFootY: number;
  /** Top of the head (rest pose), carried by the head bone. */
  headTop: V3;
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
    // Relaxed hands hang with the palms towards the body.
    const palm = new THREE.Vector3(-sideSign(s), 0, 0);
    palm.addScaledVector(finger, -palm.dot(finger)).normalize();
    arm[s] = {
      upper,
      fore,
      hand: centre ? centre.distanceTo(wr) * 1.8 : fore * 0.5,
      dirUpper: sub(el, sh).normalize(),
      dirFore: sub(wr, el).normalize(),
      finger,
      palm,
      margin: [0, 0, 0],
    };
    for (const f of own) {
      const name = `${f}_${s}` as BoneName;
      const d = f === "thumb" ? sub(P(name), wr).normalize() : finger.clone();
      const pair = f === "index" ? "middle" : f === "middle" ? "index" : null;
      const spreadAxis = pair && rest.has(`${pair}_${s}`) ? d.clone().cross(sub(P(name), P(`${pair}_${s}`))).normalize() : null;
      fingers[s].push({ name, dir: d, curlAxis: d.clone().cross(palm).normalize(), spreadAxis, slot: FINGER_SLOT[f] });
    }
    const hip = P(`thigh_${s}`), knee = P(`shin_${s}`), ankle = P(`foot_${s}`);
    leg[s] = {
      thigh: knee.distanceTo(hip),
      shin: ankle.distanceTo(knee),
      dirThigh: sub(knee, hip).normalize(),
      dirShin: sub(ankle, knee).normalize(),
      margin: [0, 0],
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
  };
  // Margins: limbs keep about their own thickness away from the body, but never need more room than the rest pose has.
  const D = restDeltas();
  for (const s of SIDES) {
    const a = arm[s];
    const thick = 0.3 * a.upper;
    const e = P(`forearm_${s}`), w = P(`hand_${s}`), t = w.clone().addScaledVector(a.dirFore, a.hand * 0.7);
    a.margin = [e, w, t].map((p) => Math.min(thick, clearance(b, D, p).c - 0.004)) as ArmRest["margin"];
    const l = leg[s];
    const lt = 0.3 * l.thigh;
    l.margin = [P(`shin_${s}`), P(`foot_${s}`)].map((p) => Math.min(lt, clearance(b, D, p).c - 0.004)) as LegRest["margin"];
  }
  return b;
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
  const clear = Math.max(a.margin[1], 0.25 * a.upper) + hold.lift;
  let W = spot.addScaledVector(N, clear);
  const reach = 0.97 * (a.upper + a.fore);
  for (let k = 0; k < 6; k++) {
    const d = W.distanceTo(S);
    if (d <= reach) break;
    W = S.clone().addScaledVector(sub(W, S), reach / d);
    W = pushOut(b, s, W, clear, side) ?? W;
  }
  const dSW = W.distanceTo(S);
  const d = Math.min(Math.max(dSW, Math.abs(a.upper - a.fore) + 1e-4), a.upper + a.fore - 1e-4);
  const axis = sub(W, S).normalize();
  const cosA = (a.upper * a.upper + d * d - a.fore * a.fore) / (2 * a.upper * d);
  const pole = new THREE.Vector3(sg * 0.8, -0.3, -0.5).applyQuaternion(s.D.get("chest")!);
  const perp = pole.addScaledVector(axis, -pole.dot(axis)).normalize();
  const E = S.clone().addScaledVector(axis, a.upper * cosA).addScaledVector(perp, a.upper * Math.sqrt(Math.max(0, 1 - cosA * cosA)));
  // Fingers lie along the belly, towards its front centre and a little down.
  const tangent = new THREE.Vector3(-sg * band.rx * cs, 0, band.rz * sn).normalize().add(new THREE.Vector3(0, -0.6, 0)).applyQuaternion(R);
  return {
    upper: sub(E, S).normalize(),
    fore: sub(W, E).normalize(),
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
    // Hands above the person's head go above the frog's head: its arms are short for its head, so raise them
    // towards straight up just as much as it takes.
    if (goal.overhead > 0) {
      const want = fromRest(b, D, P, "head", b.headTop).y + 0.02;
      const sg = sideSign(side);
      const upU = new THREE.Vector3(0.3 * sg, 1, 0.1).normalize().applyQuaternion(chest);
      const upF = new THREE.Vector3(0.05 * sg, 1, 0.1).normalize().applyQuaternion(chest);
      const wristY = (k: number) => S.y + nlerp(u, upU, k).y * a.upper + nlerp(f, upF, k).y * a.fore;
      if (wristY(0) < want) {
        let lo = 0, hi = 1;
        for (let k = 0; k < 7; k++) {
          const mid = (lo + hi) / 2;
          if (wristY(mid) < want) lo = mid;
          else hi = mid;
        }
        const k = hi * Math.min(goal.overhead, 1);
        u = nlerp(u, upU, k);
        f = nlerp(f, upF, k);
      }
    }
    for (let k = 0; k < 3; k++) {
      const E = S.clone().addScaledVector(u, a.upper);
      const e2 = pushOut(b, s, E, a.margin[0], side);
      if (e2) u = sub(e2, S).normalize();
      const E1 = S.clone().addScaledVector(u, a.upper);
      for (const [len, m] of [[a.fore, a.margin[1]], [a.fore + a.hand * 0.7, a.margin[2]]]) {
        const w2 = pushOut(b, s, E1.clone().addScaledVector(f, len), m, side);
        if (w2) f = sub(w2, E1).normalize();
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
    const [, , , , spread] = goal.fingers;
    for (const fg of b.fingers[side]) {
      const q = new THREE.Quaternion().setFromAxisAngle(fg.curlAxis, goal.fingers[fg.slot]);
      if (fg.spreadAxis && spread) q.premultiply(new THREE.Quaternion().setFromAxisAngle(fg.spreadAxis, spread));
      D.set(fg.name, Dha.clone().multiply(q));
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
    // Alternate between pushing out of the body and keeping the bone lengths (a few rounds converge). A knee raised
    // into the belly where the thigh is too short to get round it swings down and out instead (a fat frog's squat).
    const escape = new THREE.Vector3(0.7 * sg, -1, 0.3).normalize();
    for (let k = 0; k < 5; k++) {
      let K = H.clone().addScaledVector(t, l.thigh);
      K = pushOut(b, s, K, l.margin[0], side) ?? K;
      if (sg * K.x < 0.5 * l.kneeX) K.x = 0.5 * l.kneeX * sg;
      t = sub(K, H).normalize();
      for (let j = 1; j <= 8 && clearance(b, D, H.clone().addScaledVector(t, l.thigh), P).c < l.margin[0] - 0.003; j++)
        t = nlerp(t, escape, 0.15);
      K = H.clone().addScaledVector(t, l.thigh);
      let A = K.clone().addScaledVector(sh, l.shin);
      A = pushOut(b, s, A, l.margin[1], side) ?? A;
      if (sg * A.x < 0.5 * l.ankleX) A.x = 0.5 * l.ankleX * sg;
      sh = sub(A, K).normalize();
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
    rootOffset: new THREE.Vector3(0, b.restFootY - lowest + Math.max(0, pose.lift), 0),
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
  const check = (p: V3, margin: number) => (worst = Math.max(worst, margin - clearance(b, s.D, p, s.P).c));
  for (const side of SIDES) {
    const a = b.arm[side];
    const E = s.P.get(`forearm_${side}`)!, W = s.P.get(`hand_${side}`)!;
    check(E, a.margin[0]);
    check(W, a.margin[1]);
    check(W.clone().addScaledVector(sub(W, E).normalize(), a.hand * 0.7), a.margin[2]);
    check(s.P.get(`shin_${side}`)!, b.leg[side].margin[0]);
    check(s.P.get(`foot_${side}`)!, b.leg[side].margin[1]);
  }
  return worst;
}
