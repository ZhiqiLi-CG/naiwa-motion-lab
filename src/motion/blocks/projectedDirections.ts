/**
 * Solver block: aim each limb segment along the goal's direction, then project it out of the body.
 *
 * Numerically this is not an optimisation but a sequence of projections onto the constraints (nonlinear Gauss–Seidel
 * in spirit, closed-form at every step):
 *
 *   1. aim: each segment (upper arm, forearm, thigh, shin) starts along the goal direction; a belly hold or overhead
 *      reach blends it with an analytic two-bone IK solution (law of cosines, elbow towards a pole);
 *   2. project: of the segment's sample points, the one deepest inside its allowed clearance is pushed radially out of
 *      its body slice, and the segment is re-aimed through the pushed point; repeated until all are clear or for
 *      `iterations` pushes. Segments are projected root first (upper arm, then forearm from the new elbow), and the
 *      chain is swept twice for arms, three times for legs;
 *   3. limits: the elbow and knee bend is clamped before the lower segment is projected; knees and ankles are kept
 *      off the middle; a knee raised into the belly that the thigh is too short to get round swings down and out (a
 *      fat frog's squat);
 *   4. hands follow the forearm, turned onto the belly by a hold; fingers curl as asked, less where the tips would go
 *      into the body (bisection on the curl).
 *
 * The result is feasible when the sweeps converge, close to the goal directions, but not the closest feasible pose in
 * any norm: a least-squares IK block could do better on fidelity, at more cost.
 */
import * as THREE from "three";
import type { BoneName } from "../../contracts";
import type { BlockDefinition, ConstraintsBlock, FrogPose, LimbSample, Scene, Settings, SolverBlock } from "../api";
import { sideSign, SIDES, type BellyHold, type BodyPose, type Side } from "../pose";
import { fromRest, place, restDeltas, sub, type Binding, type Posed } from "../rig";

type V3 = THREE.Vector3;
const TORSO: BoneName[] = ["hips", "spine", "chest", "head"];

const swing = (from: V3, to: V3) => new THREE.Quaternion().setFromUnitVectors(from.clone().normalize(), to.clone().normalize());
const nlerp = (a: V3, b: V3, w: number) => {
  const r = a.clone().lerp(b, w);
  return r.lengthSq() < 1e-8 ? a.clone() : r.normalize();
};

/** Rotation taking the frame (f0, n0) to (f1, n1) (finger direction and palm normal; n made orthogonal to f). */
function frameRotation(f0: V3, n0: V3, f1: V3, n1: V3): THREE.Quaternion {
  const basis = (f: V3, n: V3) => {
    const x = f.clone().normalize();
    const y = n.clone().addScaledVector(x, -n.dot(x)).normalize();
    return new THREE.Matrix4().makeBasis(x, y, x.clone().cross(y));
  };
  return new THREE.Quaternion().setFromRotationMatrix(basis(f1, n1).multiply(basis(f0, n0).transpose()));
}

/** Two-bone IK: upper and lower segment directions from S reaching W (straight towards it when out of reach), the
 *  middle joint bending towards `pole`. */
function twoBone(S: V3, W: V3, upper: number, fore: number, pole: V3) {
  const d = Math.min(Math.max(W.distanceTo(S), Math.abs(upper - fore) + 1e-4), upper + fore - 1e-4);
  const axis = sub(W, S).normalize();
  const cosA = (upper * upper + d * d - fore * fore) / (2 * upper * d);
  const perp = pole.clone().addScaledVector(axis, -pole.dot(axis)).normalize();
  const E = S.clone().addScaledVector(axis, upper * cosA).addScaledVector(perp, upper * Math.sqrt(Math.max(0, 1 - cosA * cosA)));
  const Wr = S.clone().addScaledVector(axis, d);
  return { upper: sub(E, S).normalize(), fore: sub(Wr, E).normalize() };
}

/** `lower` turned towards `upper` so the bend between them is at most max (rad). */
function limitBend(upper: V3, lower: V3, max: number): V3 {
  const bend = upper.angleTo(lower);
  if (bend <= max) return lower;
  const axis = upper.clone().cross(lower);
  if (axis.lengthSq() < 1e-12) return lower;
  return lower.clone().applyAxisAngle(axis.normalize(), max - bend);
}

class ProjectedDirections implements SolverBlock {
  private readonly b: Binding;
  private readonly body: ConstraintsBlock;

  constructor(scene: Scene, private s: Readonly<Settings>) {
    this.b = scene.rig;
    this.body = scene.constraints;
  }

  setSettings(s: Readonly<Settings>) {
    this.s = s;
  }

  /** Re-aim a segment from `base` until none of its sample points sinks into the body (step 2 above). */
  private clearSegment(base: V3, dir: V3, list: LimbSample[], side: Side): V3 {
    let d = dir;
    for (let it = 0; it < (this.s.iterations as number); it++) {
      let worst: { p: V3; margin: number } | null = null, depth = 0.001;
      for (const sm of list) {
        const p = base.clone().addScaledVector(d, sm.len);
        const c = this.body.check(sm, p);
        const over = c.needed - c.clearance;
        if (over > depth) (depth = over), (worst = { p, margin: c.needed });
      }
      if (!worst) break;
      const q = this.body.pushOut(worst.p, worst.margin + 0.003, side);
      if (!q) break;
      d = sub(q, base).normalize();
    }
    return d;
  }

  /** Two-bone IK onto a spot of the belly: segment directions, palm normal and finger direction. */
  private bellyArm(s: Posed, side: Side, hold: BellyHold, S: V3) {
    const a = this.b.arm[side];
    const sg = sideSign(side);
    const spot = this.body.bellySpot(hold.height, hold.around, side);
    const clear = this.body.thickness(a.foreS[a.foreS.length - 1]) + hold.lift;
    let W = spot.point.clone().addScaledVector(spot.normal, clear);
    const reach = 0.97 * (a.upper + a.fore);
    for (let k = 0; k < 6; k++) {
      const d = W.distanceTo(S);
      if (d <= reach) break;
      W = S.clone().addScaledVector(sub(W, S), reach / d);
      W = this.body.pushOut(W, clear, side) ?? W;
    }
    const ik = twoBone(S, W, a.upper, a.fore, new THREE.Vector3(sg * 0.8, -0.3, -0.5).applyQuaternion(s.D.get("chest")!));
    // Fingers lie along the belly, towards its front centre and a little down.
    const along = spot.tangent.clone().addScaledVector(spot.down, 0.6);
    return { ...ik, palm: spot.normal.clone().negate(), finger: along.addScaledVector(spot.normal, -along.dot(spot.normal)).normalize() };
  }

  solve(goal: BodyPose): FrogPose {
    const b = this.b, body = this.body;
    const D = restDeltas();
    const P = new Map<BoneName, V3>([["root", b.rest.get("root")!.pos.clone()]]);
    const s: Posed = { D, P };
    D.set("hips", goal.hips.clone());
    D.set("spine", D.get("hips")!.clone().multiply(goal.spine));
    D.set("chest", D.get("spine")!.clone().multiply(goal.chest));
    D.set("head", D.get("chest")!.clone().multiply(goal.head));
    for (const n of TORSO) place(b, s, n);
    body.setTorso({ rotations: D, joints: P });
    const chest = D.get("chest")!;

    for (const side of SIDES) {
      const g = goal.arm[side];
      const a = b.arm[side];
      const S = place(b, s, `upperarm_${side}`);
      let u = g.upper.clone().applyQuaternion(chest);
      let f = g.fore.clone().applyQuaternion(chest);
      const w = g.belly ? Math.min(Math.max(g.belly.weight, 0), 1) : 0;
      const ik = g.belly && w > 0 ? this.bellyArm(s, side, g.belly, S) : null;
      if (ik) {
        u = nlerp(u, ik.upper, w);
        f = nlerp(f, ik.fore, w);
      }
      // Hands above the person's head go above the frog's head: its arms are short for its head, so they reach (IK)
      // for a spot just above it, beside the middle, elbows out.
      if (g.overhead > 0) {
        const sg = sideSign(side);
        const W = fromRest(b, D, P, "head", b.headTop).add(new THREE.Vector3(0.07 * sg, 0.05, 0.02).applyQuaternion(chest));
        const up = twoBone(S, W, a.upper, a.fore, new THREE.Vector3(sg, 0.3, -0.2).applyQuaternion(chest));
        const k = Math.min(g.overhead, 1);
        u = nlerp(u, up.upper, k);
        f = nlerp(f, up.fore, k);
      }
      // Every point of the arm and hand out of the body. The hand lies along the forearm, or along the belly when
      // holding it (then a hand point in the body moves the wrist).
      const along = a.handS.map((sm) => ({ ...sm, len: a.fore + sm.len }));
      for (let k = 0; k < 2; k++) {
        u = this.clearSegment(S, u, a.upperS, side);
        const E = S.clone().addScaledVector(u, a.upper);
        f = this.clearSegment(E, limitBend(u, f, body.limit("elbow")), ik ? a.foreS : [...a.foreS, ...along], side);
        if (!ik) continue;
        const hd = nlerp(f, ik.finger, w);
        for (const sm of a.handS) {
          const W = E.clone().addScaledVector(f, a.fore);
          const p = W.clone().addScaledVector(hd, sm.len);
          const q = body.pushOut(p, body.check(sm, p).needed + 0.003, side);
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
      if (g.palm && g.palm.weight > 0) tn = nlerp(tn, g.palm.dir.clone().applyQuaternion(chest), Math.min(g.palm.weight, 1));
      const Dha = tf === curF && tn === curN ? Dfo.clone() : frameRotation(curF, curN, tf, tn).multiply(Dfo);
      D.set(ha, Dha);
      // Fingers curl as asked, less where the tips would go into the body (a fist on the hip).
      const spread = g.fingers[4];
      for (const fg of b.fingers[side]) {
        const base = place(b, s, fg.name);
        const at = (k: number) => {
          const q = new THREE.Quaternion().setFromAxisAngle(fg.curlAxis, g.fingers[fg.slot] * k);
          if (fg.spreadAxis && spread) q.premultiply(new THREE.Quaternion().setFromAxisAngle(fg.spreadAxis, spread));
          return Dha.clone().multiply(q);
        };
        const clearAt = (k: number) => body.clearance(base.clone().addScaledVector(fg.dir.clone().applyQuaternion(at(k)), fg.len)) > 0.012;
        let k = 1;
        if (g.fingers[fg.slot] > 0 && !clearAt(1)) {
          let lo = 0;
          for (let i = 0; i < 6; i++) if (clearAt((lo + k) / 2)) lo = (lo + k) / 2; else k = (lo + k) / 2;
          k = lo;
        }
        D.set(fg.name, at(k));
      }
    }

    for (const side of SIDES) {
      const g = goal.leg[side];
      const l = b.leg[side];
      const sg = sideSign(side);
      const H = place(b, s, `thigh_${side}`);
      let t = g.thigh.clone().normalize();
      let sh = g.shin.clone().normalize();
      const escape = new THREE.Vector3(0.7 * sg, -1, 0.3).normalize();
      const knee = l.thighS[l.thighS.length - 1];
      const kneeX = body.spread("knee", side), ankleX = body.spread("ankle", side);
      for (let k = 0; k < 3; k++) {
        t = this.clearSegment(H, t, l.thighS, side);
        const K = H.clone().addScaledVector(t, l.thigh);
        if (sg * K.x < kneeX) (K.x = kneeX * sg), (t = sub(K, H).normalize());
        const kneeShort = () => {
          const c = body.check(knee, H.clone().addScaledVector(t, l.thigh));
          return c.clearance < c.needed - 0.003;
        };
        for (let j = 1; j <= 8 && kneeShort(); j++) t = nlerp(t, escape, 0.15);
        const K2 = H.clone().addScaledVector(t, l.thigh);
        sh = this.clearSegment(K2, limitBend(t, sh, body.limit("knee")), l.shinS, side);
        const A = K2.clone().addScaledVector(sh, l.shin);
        if (sg * A.x < ankleX) (A.x = ankleX * sg), (sh = sub(A, K2).normalize());
      }
      const th = `thigh_${side}` as const, sn = `shin_${side}` as const, ft = `foot_${side}` as const;
      D.set(th, swing(l.dirThigh.clone().applyQuaternion(D.get("hips")!), t).multiply(D.get("hips")!));
      place(b, s, sn);
      D.set(sn, swing(l.dirShin.clone().applyQuaternion(D.get(th)!), sh).multiply(D.get(th)!));
      place(b, s, ft);
      D.set(ft, new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), g.toe));
    }
    return { rotations: D, joints: P, lift: goal.lift, shift: goal.shift, yaw: goal.yaw, expressions: goal.expressions };
  }
}

export const projectedDirections: BlockDefinition<"solver"> = {
  id: "projected-directions",
  slot: "solver",
  name: { zh: "方向瞄准 + 投影避让", en: "Aim and project" },
  summary: {
    zh: "每段肢体先沿目标方向摆好（捧肚子、举过头顶时混入解析的两骨 IK），再把最深入身体的采样点径向推出、让肢体重新对准它，反复直到都在外面：一连串约束投影，不是最优化。",
    en: "Each limb segment is aimed along the goal direction (blended with analytic two-bone IK for belly holds and overhead reaches), then its deepest sample point is pushed radially out of the body and the segment re-aimed through it, until all are clear: a sequence of constraint projections, not an optimisation.",
  },
  parameters: [
    {
      key: "iterations", kind: "number", default: 10, min: 1, max: 30, step: 1,
      label: { zh: "每段最多推出次数", en: "Pushes per segment" },
      help: { zh: "越多越能避开身体，也越费时", en: "More keeps limbs out of the body more reliably, at more cost" },
    },
  ],
  create: (scene, settings) => new ProjectedDirections(scene, settings),
};
