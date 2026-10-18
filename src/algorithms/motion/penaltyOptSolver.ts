/**
 * Solver block: constrained optimisation. For each limb, find unit segment directions d₀, d₁ as close as possible to
 * the person's g₀, g₁ subject to every limb point keeping its clearance from the body and the bend within the joint
 * limit:
 *
 *   min Σᵢ |dᵢ − gᵢ|²  +  w_reach·|ℓ₀d₀ + ℓ₁d₁ − T|²  +  μ Σₖ min(0, cₖ(d) − mₖ)²       |dᵢ| = 1, bend ≤ limit
 *
 * The reach term only counts for a belly hold or overhead reach (T the target from the shoulder, limbs.ts). The last
 * is the penalty: cₖ a limb point's clearance from the body, mₖ what it needs (its thickness, plus 3 mm); for a leg
 * also the knee and ankle's distance from the middle.
 *
 * Each iteration is one Gauss–Newton step on that sum. Every constraint is linearised where the point is now,
 * cₖ(p + Δ) ≈ cₖ + nₖ·Δ (nₖ the outward normal, the direction the body's pushOut moves it), and a point moves by
 * Δ = a·δ when its segment's direction moves by δ (a its distance from the segment's base; the elbow carries the
 * forearm by ℓ₀·δ₀). So every residual is linear in the step δ = (δ₀, δ₁) and the step solves a 6 × 6 system
 * H δ = −∇, clipped to a trust region. Which constraints count (the active set): those violated now, those the step
 * would violate (added and solved again), and those active earlier in this solve while still within 5 mm of their
 * bound (so a point the last step put on the bound stays held there rather than flickering in and out).
 *
 * δᵢ is kept tangent to |dᵢ| = 1 by a stiff term on dᵢ·δᵢ; then dᵢ ← normalise(dᵢ + δᵢ) and the bend is clamped to the
 * joint limit. It starts from the light projection of limbs.ts and ends with the full one, which removes the slack
 * the penalty leaves (about 1/(μ·a) metres).
 */
import * as THREE from "three";
import type { BlockDefinition, Scene, Settings } from "../../motion/api";
import { sideSign } from "../../motion/pose";
import { baseOf, CHAIN_PARAMETERS, ChainSolver, limitBend, project, type Chain, type Dirs } from "./limbs";

type V3 = THREE.Vector3;
/** Stiffness keeping each step tangent to the unit sphere, and the Levenberg damping that keeps H invertible. */
const TANGENT = 100;
const DAMPING = 1e-3;
/** Trust region: the largest change of a direction per step (a chord of the unit sphere, about 14°). */
const MAX_STEP = 0.25;
/** Constraints farther than this from their bound are left out (m): one step cannot reach them. */
const NEAR = 0.05;
/** An active constraint stays active while within this of its bound (m). */
const HOLD = 0.005;

/** Solve the 6 × 6 system A x = b (Gaussian elimination, partial pivoting; A and b are overwritten). */
function solve6(A: number[][], b: number[]): number[] {
  const n = 6;
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    [b[c], b[p]] = [b[p], b[c]];
    for (let r = c + 1; r < n; r++) {
      const f = A[r][c] / A[c][c];
      for (let k = c; k < n; k++) A[r][k] -= f * A[c][k];
      b[r] -= f * b[c];
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r];
    for (let k = r + 1; k < n; k++) s -= A[r][k] * x[k];
    x[r] = s / A[r][r];
  }
  return x;
}

/** A linearised constraint: margin r = c − m (< 0 violated), outward normal n, and how far the point moves per unit
 *  of δ₀ and δ₁ (k₀, k₁). */
interface Row {
  key: string;
  r: number;
  n: V3;
  k0: number;
  k1: number;
}

class PenaltyOptSolver extends ChainSolver {
  constructor(scene: Scene, s: Readonly<Settings>) {
    super(scene, s, "opt");
  }

  /** The constraints near their bound, linearised at d. */
  private rows(c: Chain, d: Dirs): Row[] {
    const out: Row[] = [];
    const l0 = c.len[0];
    for (const seg of [0, 1] as const) {
      const base = baseOf(c, d, seg);
      c.points[seg].forEach((pt, k) => {
        const p = pt.at(d);
        const chk = this.body.check(pt.sm, p);
        const r = chk.clearance - (chk.needed + 0.003);
        if (r > NEAR) return;
        // The outward normal: where pushOut moves the point to 1 cm more clearance.
        const n = this.body.pushOut(p, chk.clearance + 0.01, c.side)?.sub(p);
        if (!n || n.lengthSq() < 1e-12) return;
        const a = p.distanceTo(base);
        out.push({ key: `${seg}:${k}`, r, n: n.normalize(), k0: seg === 0 ? a : l0, k1: seg === 0 ? 0 : a });
      });
    }
    if (c.leg) {
      const sg = sideSign(c.side), knee = baseOf(c, d, 1), ankle = knee.clone().addScaledVector(d[1], c.len[1]);
      const n = new THREE.Vector3(sg, 0, 0);
      out.push({ key: "knee", r: sg * knee.x - this.body.spread("knee", c.side), n, k0: l0, k1: 0 });
      out.push({ key: "ankle", r: sg * ankle.x - this.body.spread("ankle", c.side), n, k0: l0, k1: c.len[1] });
    }
    return out;
  }

  protected solveChain(c: Chain, start: Dirs): Dirs {
    const mu = this.s.optPenalty as number, wReach = (this.s.optReach as number) * c.reach;
    const [l0, l1] = c.len;
    const limit = this.body.limit(c.leg ? "knee" : "elbow");
    const T = c.target.clone().sub(c.root);
    const held = new Set<string>();
    let d = project(this.body, c, start, true);
    for (let it = 0; it < this.iterations; it++) {
      const H0 = Array.from({ length: 6 }, (_, i) => Array.from({ length: 6 }, (_, j) => (i === j ? 1 + DAMPING : 0)));
      const g0 = new Array<number>(6).fill(0);
      /** Residual r with Jacobian row (k₀ uᵀ, k₁ uᵀ): H += w JᵀJ, ∇ += w r Jᵀ. */
      const add = (H: number[][], g: number[], w: number, r: number, k0: number, k1: number, u: V3) => {
        const row = [k0 * u.x, k0 * u.y, k0 * u.z, k1 * u.x, k1 * u.y, k1 * u.z];
        for (let i = 0; i < 6; i++) {
          g[i] += w * r * row[i];
          for (let j = 0; j < 6; j++) H[i][j] += w * row[i] * row[j];
        }
      };
      // Fidelity |dᵢ + δᵢ − gᵢ|² (its identity is on H's diagonal already), the tangent terms, the reach.
      for (const i of [0, 1] as const) {
        const e = d[i].clone().sub(c.goal[i]);
        for (let k = 0; k < 3; k++) g0[i * 3 + k] += e.getComponent(k);
        add(H0, g0, TANGENT, 0, i === 0 ? 1 : 0, i === 1 ? 1 : 0, d[i]);
      }
      if (wReach > 0) {
        const e = d[0].clone().multiplyScalar(l0).addScaledVector(d[1], l1).sub(T);
        for (const u of [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)]) add(H0, g0, wReach, e.dot(u), l0, l1, u);
      }

      const rows = this.rows(c, d);
      const active = new Set(rows.filter((x) => x.r < 0 || (held.has(x.key) && x.r < HOLD)).map((x) => x.key));
      let step: number[] = [];
      for (let pass = 0; pass < 3; pass++) {
        const H = H0.map((row) => row.slice()), g = g0.slice();
        for (const x of rows) if (active.has(x.key)) add(H, g, mu, x.r, x.k0, x.k1, x.n);
        step = solve6(H, g.map((v) => -v));
        const big = Math.max(Math.hypot(step[0], step[1], step[2]), Math.hypot(step[3], step[4], step[5]));
        if (big > MAX_STEP) for (let i = 0; i < 6; i++) step[i] *= MAX_STEP / big;
        // Constraints the step would violate join the active set, and the step is solved again.
        const moved = (x: Row) => x.k0 * (x.n.x * step[0] + x.n.y * step[1] + x.n.z * step[2]) + x.k1 * (x.n.x * step[3] + x.n.y * step[4] + x.n.z * step[5]);
        const join = rows.filter((x) => !active.has(x.key) && x.r + moved(x) < 0);
        if (!join.length) break;
        for (const x of join) active.add(x.key);
      }
      for (const k of active) held.add(k);

      const next: Dirs = [
        d[0].clone().add(new THREE.Vector3(step[0], step[1], step[2])).normalize(),
        d[1].clone().add(new THREE.Vector3(step[3], step[4], step[5])).normalize(),
      ];
      next[1] = limitBend(next[0], next[1], limit);
      const change = Math.max(next[0].distanceTo(d[0]), next[1].distanceTo(d[1]));
      d = next;
      if (change < 1e-3) break;
    }
    return project(this.body, c, d);
  }
}

export const penaltyOptSolver: BlockDefinition<"solver"> = {
  id: "penalty-opt",
  slot: "solver",
  name: { zh: "约束优化（罚函数 Gauss–Newton）", en: "Constrained optimisation (penalty Gauss–Newton)" },
  summary: {
    zh: "让每条肢体的方向尽量接近人的方向，同时肢体上的点离身体至少一个厚度、弯曲不超过关节限制。约束在当前位置线性化（法向由 pushOut 给出），违反的约束按罚函数计入；每轮一次 6×6 的 Gauss–Newton 步，再归一化并限制弯曲，最后投影去掉余下的穿透。",
    en: "Each limb's directions as close as possible to the person's, subject to its points keeping their thickness off the body and the bend within the joint limit. Constraints are linearised where the points are (normals from pushOut) and penalised while violated; one 6 × 6 Gauss–Newton step per iteration, then normalised and the bend clamped, a final projection removing what intrusion is left.",
  },
  parameters: [
    ...CHAIN_PARAMETERS("opt", { iterations: 8, hint: 0 }),
    {
      key: "optPenalty", kind: "number", default: 1000, min: 10, max: 1000000, step: 10, unit: "1/m²",
      label: { zh: "罚系数 μ", en: "Penalty μ" },
      help: { zh: "越大越不穿模（剩余穿透约 1/(μ·肢长)，最后由投影去掉），太大时迭代变硬", en: "Higher leaves less intrusion (about 1/(μ·limb length), removed by the final projection); too high makes the steps stiff" },
    },
    {
      key: "optReach", kind: "number", default: 100, min: 0, max: 10000, step: 1, unit: "1/m²",
      label: { zh: "够目标权重", en: "Reach weight" },
      help: { zh: "捧肚子、举过头顶时手腕到目标点的权重", en: "Weight of the wrist reaching its spot in a belly hold or overhead reach" },
    },
  ],
  create: (scene, settings) => new PenaltyOptSolver(scene, settings),
};
