/**
 * Shared by the library's solver blocks: the goal turned into four limb chains (two arms, two legs), the constraint
 * projection every IK step can call, and the chains' result turned back into a FrogPose.
 *
 * A Goal carries directions, not positions (the frog's limbs are far shorter than a person's). An IK solver needs an
 * end-effector target, so the target is where the goal's directions put the wrist or ankle on the frog's own limbs:
 *
 *   W = S + ℓ₁·u + ℓ₂·f          (S shoulder, u / f the goal's upper-arm and forearm directions, ℓ the frog's lengths)
 *
 * blended towards a spot on the belly for a belly hold and above the head for an overhead reach, like the built-in
 * solver. The goal's own elbow (S + ℓ₁·u) is the hint that picks the elbow's swivel, which the target alone leaves
 * free. Torso, hands (following the forearm), fingers and feet are posed as the built-in solver does, without its
 * special cases (hands turned onto the belly, fingers kept out of it, the squat's knee escape).
 */
import * as THREE from "three";
import type { BoneName } from "../../contracts";
import type { ConstraintsBlock, FrogPose, Goal, LimbSample, Scene, Settings, Side, SolverBlock } from "../../motion/api";
import { sideSign, SIDES } from "../../motion/pose";
import { fromRest, place, restDeltas, type Binding, type Posed } from "../../motion/rig";

type V3 = THREE.Vector3;
export type Dirs = [V3, V3];

export interface Chain {
  side: Side;
  leg: boolean;
  /** Shoulder or hip joint. */
  root: V3;
  len: [number, number];
  /** Points kept out of the body, carried by each segment (the hand by the forearm). */
  points: [LimbPoint[], LimbPoint[]];
  /** The goal's segment directions (world, unit). */
  goal: Dirs;
  /** End-effector target, and how much of it comes from a belly hold or overhead reach (0: only directions). */
  target: V3;
  reach: number;
}

/** A limb point: its flesh sample, and where it is when the chain has directions d. */
export interface LimbPoint {
  sm: LimbSample;
  at(d: Dirs): V3;
}

export const nlerp = (a: V3, b: V3, w: number): V3 => {
  const r = a.clone().lerp(b, w);
  return r.lengthSq() < 1e-8 ? a.clone() : r.normalize();
};
const swing = (from: V3, to: V3) => new THREE.Quaternion().setFromUnitVectors(from.clone().normalize(), to.clone().normalize());

/** `lower` turned towards `upper` so the bend between them is at most max (rad). */
export function limitBend(upper: V3, lower: V3, max: number): V3 {
  const bend = upper.angleTo(lower);
  if (bend <= max) return lower;
  const axis = upper.clone().cross(lower);
  if (axis.lengthSq() < 1e-12) return lower;
  return lower.clone().applyAxisAngle(axis.normalize(), max - bend);
}

/** Joint positions of a chain with these directions: root, middle, end. */
export const joints = (c: Chain, d: Dirs): [V3, V3, V3] => {
  const m = c.root.clone().addScaledVector(d[0], c.len[0]);
  return [c.root.clone(), m, m.clone().addScaledVector(d[1], c.len[1])];
};
export const dirsOf = (p: readonly V3[]): Dirs => [p[1].clone().sub(p[0]).normalize(), p[2].clone().sub(p[1]).normalize()];

/** The base joint of segment `seg` (shoulder or elbow, hip or knee). */
export const baseOf = (c: Chain, d: Dirs, seg: 0 | 1): V3 => (seg === 0 ? c.root.clone() : c.root.clone().addScaledVector(d[0], c.len[0]));

/** The turn of a segment (about its base) that carries point p to q. */
export const turnTo = (base: V3, p: V3, q: V3) => swing(p.clone().sub(base), q.clone().sub(base));

/**
 * The constraint projection: root segment first, each turned so its deepest point lands pushed out of the body
 * (repeated up to 10 times), the bend clamped to the joint limit before the lower segment, and a leg's knee and ankle
 * kept off the middle so the legs never cross; swept twice for arms, three times for legs, as the built-in solver.
 * `light`: one sweep of at most two pushes, for inside an iteration (the full one ends the solve).
 */
export function project(body: ConstraintsBlock, c: Chain, start: Dirs, light = false): Dirs {
  const pushes = light ? 2 : 10, sweeps = light ? 1 : c.leg ? 3 : 2;
  const sg = sideSign(c.side);
  const d: Dirs = [start[0].clone(), start[1].clone()];
  const clear = (seg: 0 | 1) => {
    const base = baseOf(c, d, seg);
    for (let it = 0; it < pushes; it++) {
      let worst: V3 | null = null, margin = 0, depth = 0.001;
      for (const pt of c.points[seg]) {
        const p = pt.at(d);
        const k = body.check(pt.sm, p);
        if (k.needed - k.clearance > depth) (depth = k.needed - k.clearance), (worst = p), (margin = k.needed);
      }
      const q = worst && body.pushOut(worst, margin + 0.003, c.side);
      if (!q) break;
      d[seg].applyQuaternion(turnTo(base, worst!, q)).normalize();
    }
  };
  const keepApart = (seg: 0 | 1, x: number) => {
    const base = baseOf(c, d, seg);
    const p = base.clone().addScaledVector(d[seg], c.len[seg]);
    if (sg * p.x < x) d[seg] = p.setX(sg * x).sub(base).normalize();
  };
  // Keeping the knees apart can push a thigh back in: hence the sweeps.
  for (let sweep = 0; sweep < sweeps; sweep++) {
    clear(0);
    if (c.leg) keepApart(0, body.spread("knee", c.side));
    d[1] = limitBend(d[0], d[1], body.limit(c.leg ? "knee" : "elbow"));
    clear(1);
    if (c.leg) keepApart(1, body.spread("ankle", c.side));
  }
  return d;
}

/** Points along a chain's two segments, plus extra ones carried by the lower segment. */
function alongChain(root: V3, len0: number, s0: LimbSample[], s1: LimbSample[], extra: LimbPoint[]): [LimbPoint[], LimbPoint[]] {
  return [
    s0.map((sm) => ({ sm, at: (d: Dirs) => root.clone().addScaledVector(d[0], sm.len) })),
    [...s1.map((sm) => ({ sm, at: (d: Dirs) => root.clone().addScaledVector(d[0], len0).addScaledVector(d[1], sm.len) })), ...extra],
  ];
}

/** Settings every chain solver shares (keys prefixed: unique within a retargeter), with its own defaults. */
export const CHAIN_PARAMETERS = (prefix: string, defaults: { iterations: number; hint: number }) => [
  {
    key: `${prefix}Iterations`, kind: "number" as const, default: defaults.iterations, min: 1, max: 50, step: 1,
    label: { zh: "迭代次数", en: "Iterations" },
    help: { zh: "每条肢体每帧最多迭代多少次", en: "Most iterations per limb and frame" },
  },
  {
    key: `${prefix}Tolerance`, kind: "number" as const, default: 0.002, min: 0.0001, max: 0.02, step: 0.0001, unit: "m",
    label: { zh: "收敛距离", en: "Tolerance" },
    help: { zh: "末端离目标这么近就停止", en: "Stop once the end is this close to its target" },
  },
  {
    key: `${prefix}Hint`, kind: "number" as const, default: defaults.hint, min: 0, max: 1, step: 0.05,
    label: { zh: "肘/膝提示", en: "Elbow / knee hint" },
    help: {
      zh: "迭代的起点：1 从人的肢体方向出发（目标只决定末端，肘的朝向由起点决定），0 从上一帧的解出发",
      en: "Where iterating starts: 1 from the person's limb directions (the target fixes only the end; the start picks the elbow's swivel), 0 from last frame's solution",
    },
  },
];

/**
 * A solver over limb chains: the torso from the goal, each chain from its own algorithm (`solveChain`), the rest as
 * the built-in solver does it. Subclasses implement one chain.
 */
export abstract class ChainSolver implements SolverBlock {
  protected readonly b: Binding;
  protected readonly body: ConstraintsBlock;
  /** Last frame's directions per chain (arms in the chest's frame, legs in the frog's): the warm start. */
  private prev = new Map<string, Dirs>();

  constructor(scene: Scene, protected s: Readonly<Settings>, private readonly prefix: string) {
    this.b = scene.rig;
    this.body = scene.constraints;
  }

  setSettings(s: Readonly<Settings>) {
    this.s = s;
  }

  reset() {
    this.prev.clear();
  }

  protected get iterations() {
    return this.s[`${this.prefix}Iterations`] as number;
  }
  protected get tolerance() {
    return this.s[`${this.prefix}Tolerance`] as number;
  }

  /** Whether to iterate on: the end is not yet within tolerance of its target, and the last iteration still brought
   *  it closer by a tenth of the tolerance (a target the body keeps out of reach stalls). */
  protected goOn(c: Chain, end: V3, last: { err: number }): boolean {
    const err = end.distanceTo(c.target);
    const on = err > this.tolerance && last.err - err > this.tolerance / 10;
    last.err = err;
    return on;
  }

  /** The chain's directions, starting from `start`. */
  protected abstract solveChain(c: Chain, start: Dirs): Dirs;

  solve(goal: Goal): FrogPose {
    const b = this.b;
    const D = restDeltas();
    const P = new Map<BoneName, V3>([["root", b.rest.get("root")!.pos.clone()]]);
    const s: Posed = { D, P };
    D.set("hips", goal.hips.clone());
    D.set("spine", D.get("hips")!.clone().multiply(goal.spine));
    D.set("chest", D.get("spine")!.clone().multiply(goal.chest));
    D.set("head", D.get("chest")!.clone().multiply(goal.head));
    for (const n of ["hips", "spine", "chest", "head"] as const) place(b, s, n);
    this.body.setTorso({ rotations: D, joints: P });
    const chest = D.get("chest")!;
    const toLocal = (leg: boolean) => (leg ? new THREE.Quaternion() : chest.clone().invert());

    const hint = this.s[`${this.prefix}Hint`] as number;
    for (const c of this.chains(goal, s)) {
      const key = `${c.leg ? "leg" : "arm"}${c.side}`;
      const local = this.prev.get(key);
      const from = local ? local.map((d) => d.clone().applyQuaternion(c.leg ? new THREE.Quaternion() : chest)) as Dirs : this.rest(c, chest);
      const d = this.solveChain(c, [nlerp(from[0], c.goal[0], hint), nlerp(from[1], c.goal[1], hint)]);
      const q = toLocal(c.leg);
      this.prev.set(key, [d[0].clone().applyQuaternion(q), d[1].clone().applyQuaternion(q)]);
      this.apply(s, goal, c, d);
    }
    return { rotations: D, joints: P, lift: goal.lift, shift: goal.shift, yaw: goal.yaw, expressions: goal.expressions };
  }

  private rest(c: Chain, chest: THREE.Quaternion): Dirs {
    if (c.leg) return [this.b.leg[c.side].dirThigh.clone(), this.b.leg[c.side].dirShin.clone()];
    const a = this.b.arm[c.side];
    return [a.dirUpper.clone().applyQuaternion(chest), a.dirFore.clone().applyQuaternion(chest)];
  }

  /** The four chains of this goal, arms first. */
  private chains(goal: Goal, s: Posed): Chain[] {
    const b = this.b, body = this.body, chest = s.D.get("chest")!;
    const out: Chain[] = [];
    for (const side of SIDES) {
      const g = goal.arm[side], a = b.arm[side], sg = sideSign(side);
      const S = place(b, s, `upperarm_${side}`);
      const u = g.upper.clone().applyQuaternion(chest), f = g.fore.clone().applyQuaternion(chest);
      let target = S.clone().addScaledVector(u, a.upper).addScaledVector(f, a.fore);
      const hold = g.belly ? Math.min(Math.max(g.belly.weight, 0), 1) : 0;
      if (hold > 0) {
        const spot = body.bellySpot(g.belly!.height, g.belly!.around, side);
        const W = spot.point.addScaledVector(spot.normal, body.thickness(a.foreS[a.foreS.length - 1]) + g.belly!.lift);
        target.lerp(W, hold);
      }
      const over = Math.min(Math.max(g.overhead, 0), 1);
      if (over > 0) {
        const W = fromRest(b, s.D, s.P, "head", b.headTop).add(new THREE.Vector3(0.07 * sg, 0.05, 0.02).applyQuaternion(chest));
        target = target.lerp(W, over);
      }
      // The hand follows the forearm (apply() below): its finger direction is the rest one carried by the same
      // rotations. On the belly it would point into it, so there only the forearm counts.
      const fingerAt = (d: Dirs) => {
        const Dup = swing(a.dirUpper.clone().applyQuaternion(chest), d[0]).multiply(chest);
        return a.finger.clone().applyQuaternion(swing(a.dirFore.clone().applyQuaternion(Dup), d[1]).multiply(Dup));
      };
      const hand = hold < 0.5
        ? a.handS.map((sm): LimbPoint => ({ sm, at: (d) => S.clone().addScaledVector(d[0], a.upper).addScaledVector(d[1], a.fore).addScaledVector(fingerAt(d), sm.len) }))
        : [];
      out.push({ side, leg: false, root: S, len: [a.upper, a.fore], points: alongChain(S, a.upper, a.upperS, a.foreS, hand), goal: [u, f], target, reach: Math.max(hold, over) });
    }
    for (const side of SIDES) {
      const g = goal.leg[side], l = b.leg[side];
      const H = place(b, s, `thigh_${side}`);
      const t = g.thigh.clone().normalize(), sh = g.shin.clone().normalize();
      const target = H.clone().addScaledVector(t, l.thigh).addScaledVector(sh, l.shin);
      out.push({ side, leg: true, root: H, len: [l.thigh, l.shin], points: alongChain(H, l.thigh, l.thighS, l.shinS, []), goal: [t, sh], target, reach: 0 });
    }
    return out;
  }

  /** Bone rotations of a solved chain (and its hand, fingers or foot). */
  private apply(s: Posed, goal: Goal, c: Chain, d: Dirs) {
    const b = this.b, D = s.D, side = c.side;
    if (c.leg) {
      const l = b.leg[side];
      const th = `thigh_${side}` as const, sn = `shin_${side}` as const, ft = `foot_${side}` as const;
      D.set(th, swing(l.dirThigh.clone().applyQuaternion(D.get("hips")!), d[0]).multiply(D.get("hips")!));
      place(b, s, sn);
      D.set(sn, swing(l.dirShin.clone().applyQuaternion(D.get(th)!), d[1]).multiply(D.get(th)!));
      place(b, s, ft);
      D.set(ft, new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), goal.leg[side].toe));
      return;
    }
    const a = b.arm[side], g = goal.arm[side], chest = D.get("chest")!;
    const up = `upperarm_${side}` as const, fo = `forearm_${side}` as const, ha = `hand_${side}` as const;
    D.set(up, swing(a.dirUpper.clone().applyQuaternion(chest), d[0]).multiply(chest));
    place(b, s, fo);
    D.set(fo, swing(a.dirFore.clone().applyQuaternion(D.get(up)!), d[1]).multiply(D.get(up)!));
    place(b, s, ha);
    const Dha = D.get(fo)!.clone();
    D.set(ha, Dha);
    for (const fg of b.fingers[side]) {
      place(b, s, fg.name);
      const q = new THREE.Quaternion().setFromAxisAngle(fg.curlAxis, g.fingers[fg.slot]);
      if (fg.spreadAxis && g.fingers[4]) q.premultiply(new THREE.Quaternion().setFromAxisAngle(fg.spreadAxis, g.fingers[4]));
      D.set(fg.name, Dha.clone().multiply(q));
    }
  }
}
