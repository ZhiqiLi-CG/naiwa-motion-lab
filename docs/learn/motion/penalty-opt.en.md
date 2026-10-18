# Constrained optimisation (penalty Gauss–Newton)

## Intuition
Say what you want and let a solver find it: limb directions as close to the person's as possible, subject to the limb
staying out of the frog's body and the elbow or knee bending no further than its limit. The built-in direction copy
fixes violations one segment at a time; this solver weighs both segments of a limb together, so it can move the upper
arm a little to save the forearm a lot.

## The math
For each limb, unit directions $d_0, d_1$ (upper and lower segment):

$$\min_{d}\ \sum_i |d_i - g_i|^2 + w_{reach}\,|\ell_0 d_0 + \ell_1 d_1 - T|^2 + \mu \sum_k \min(0,\ c_k(d) - m_k)^2 \quad \text{s.t. } |d_i| = 1,\ \angle(d_0, d_1) \le \text{limit}$$

g the person's directions, T a belly-hold or overhead target (reach weight only then), $c_k$ the clearance of limb
point k (`constraints.check`), $m_k$ what it needs plus 3 mm, and for legs the knees' and ankles' distance from the middle.
Each iteration linearises every constraint where the point is, $c_k(p + \Delta) \approx c_k + n_k\cdot\Delta$ ($n_k$ the
outward normal from `constraints.pushOut`), and a point moves by $\Delta = a\,\delta$ when its segment's direction moves
by δ (a its distance from the segment's base; the elbow carries the forearm by $\ell_0\delta_0$). Every residual is then
linear in $\delta = (\delta_0, \delta_1)$ and the Gauss–Newton step solves a 6 × 6 system $H\delta = -\nabla$.

## Steps
```ts
let d = project(body, c, start, true);                    // start: last frame's solution (hint 0)
for (let it = 0; it < iterations; it++) {
  H, g = fidelity + tangent (keeps δᵢ ⊥ dᵢ) + reach
  rows = constraints near their bound, linearised at d     // r = c − m, n, k₀, k₁
  active = violated, or active before and within 5 mm
  repeat ≤ 3: step = solve6(H + μ Σ JᵀJ, −(g + μ Σ r Jᵀ)), clipped to 0.25
              add rows the step would violate
  d = normalise(d + step); clamp the bend
}
return project(body, c, d);                                // removes the slack the penalty leaves
```

## Parameters
| Parameter | Meaning | Typical range | What you see when you change it |
|---|---|---|---|
| `optPenalty` | μ (1/m²) | 300–3000 | higher: stiffer constraints, but steps jerk between active sets (μ = 10⁵: jerk 8700 on naenae vs 471); lower: softer, the final projection does more |
| `optReach` | weight of the belly / overhead target (1/m²) | 30–300 | higher: hands reach the belly or head spot, directions give way |
| `optIterations` | Gauss–Newton steps per limb and frame | 5–15 | more: closer to the optimum, more cost |
| `optTolerance` | (shared chain parameter; the loop stops when the directions change less than 10⁻³) | | |
| `optHint` | start from last frame (0) or the person (1) | 0–0.5 | 0 warm-starts: the optimum moves little between frames, so few steps suffice and the motion is smooth |

## When to use it
When you want the closest feasible pose by a stated measure, and to add terms (a pole for the elbow, symmetry, a pose
prior) without inventing a new procedure. It is the most faithful solver here. Measured on naiwa.glb (60 fps, built-in
output; gouxiong / naenae / kemusan):

| | fidelity ° | jerk m/s³ | penetration mm | solve ms |
|---|---|---|---|---|
| direction copy (built-in) | 16.3 / 16.3 / 17.3 | 5131 / 383 / 1254 | 7.6 / 1.0 / 1.0 | 0.25 / 0.25 / 0.30 |
| `penalty-opt` | 16.1 / 15.2 / 15.8 | 6463 / 471 / 1615 | 1.2 / 0.9 / 1.0 | 0.90 / 0.95 / 0.84 |

It is the most expensive (each step evaluates the body for every limb point) and a little jerkier where the active set
changes. Two lessons came from building it: constraint planes must be re-linearised every step (a plane kept from an
earlier position on a curved body pushes the arm ever further out), and a hard penalty makes the active set flicker,
so a moderate μ followed by a projection works better than a huge μ.

## In the code
`src/algorithms/motion/penaltyOptSolver.ts`, a **solver** block (`rows` linearises, `solveChain` iterates); targets
and projection in `src/algorithms/motion/limbs.ts`. First things to try: an elbow-pole term (the person's elbow as a
soft target), or replacing the penalty by an augmented Lagrangian (multipliers carried between frames).

## References
- J. Nocedal, S. J. Wright, *Numerical Optimization*, 2nd ed., Springer 2006, ch. 10 (Gauss–Newton) and 17 (penalty methods). https://doi.org/10.1007/978-0-387-40065-5
