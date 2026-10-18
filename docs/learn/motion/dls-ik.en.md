# Damped least squares IK (Jacobian)

## Intuition
The Jacobian says how the end of the limb moves when each joint turns a little. Inverting it tells how to turn the
joints to move the end towards the target. Near a straight limb that inverse blows up (the end cannot move along the
limb, whatever the joints do) and the joints would spin; damping trades a little speed for steps that stay small.

The target is where the person's limb directions put the wrist or ankle on the frog's limb lengths,
$W = S + \ell_1 u + \ell_2 f$ (see the CCD page).

## The math
Two ball joints (shoulder, elbow), so six rotation unknowns ω. Turning joint j by ω moves the end by $\omega \times r_j$,
$r_j$ from the joint to the end, so $J = [-[r_0]_\times\ \ -[r_1]_\times]$ (3 × 6) and

$$\Delta\omega = J^\top (J J^\top + \lambda^2 I)^{-1} e, \qquad J J^\top = \sum_j \left(|r_j|^2 I - r_j r_j^\top\right), \qquad \Delta\omega_j = r_j \times y$$

with $y = (JJ^\top + \lambda^2 I)^{-1} e$ and e the end's error, clipped to `dlsMaxStep`. λ = 0 is the pseudo-inverse
(fast, unstable when straight); a large λ is the Jacobian transpose (stable, slow).

## Steps
```ts
let d = project(body, c, start, true);
for (let it = 0; it < iterations; it++) {
  const p = joints(c, d);
  if (!goOn(c, p[2], last)) break;
  const e = clip(target − p[2], maxStep);
  const r = [p[2] − p[0], p[2] − p[1]];
  const y = inverse(Σ (|rⱼ|² I − rⱼ rⱼᵀ) + λ² I) · e;      // 3 × 3
  const w0 = r[0] × y, w1 = r[1] × y;                     // Δω for shoulder and elbow
  d = project(body, c, [rotate(d[0], w0), rotate(rotate(d[1], w0), w1)], true);
}
return project(body, c, d);
```

## Parameters
| Parameter | Meaning | Typical range | What you see when you change it |
|---|---|---|---|
| `dlsDamping` | λ (m) | 0.01–0.1 | lower: faster convergence, jumpy near a straight limb; higher: steady, slower |
| `dlsMaxStep` | most the end moves towards the target per iteration (m) | 0.02–0.1 | lower: smoother, more iterations needed |
| `dlsIterations` | iterations per limb and frame | 4–15 | more: closer near the body, more cost |
| `dlsTolerance` | stop when the end is this close (m) | 0.001–0.005 | larger: cheaper |
| `dlsHint` | start from the person's directions (1) or last frame (0) | 0.5–1 | 0 is bad here: from a stale start DLS settles on another elbow swivel (fidelity 39.4° on naenae vs 16.1°) |

## When to use it
When you want the general machinery: the same step handles any number of joints, several targets at once (stack the
Jacobians), and secondary goals in the null space. It is the most faithful of the three IK solvers on 狗熊哆嗦毛 and Nae Nae, the least on 科目三.
Measured on naiwa.glb (60 fps, built-in output; gouxiong / naenae / kemusan):

| | fidelity ° | jerk m/s³ | penetration mm | solve ms |
|---|---|---|---|---|
| direction copy (built-in) | 16.3 / 16.3 / 17.3 | 5131 / 383 / 1254 | 7.6 / 1.0 / 1.0 | 0.25 / 0.25 / 0.30 |
| `dls-ik` | 17.0 / 16.1 / 18.2 | 5837 / 542 / 1701 | 1.0 / 1.0 / 1.0 | 0.66 / 0.52 / 0.66 |

Costs a 3 × 3 inverse per iteration, still under 1 ms for four limbs. Like all end-effector IK it does not know about the
elbow: add the person's elbow as a second, weaker task to pin the swivel.

## In the code
`src/algorithms/motion/dlsSolver.ts`, a **solver** block; targets and projection in `src/algorithms/motion/limbs.ts`.
First things to try: a second task row for the elbow (a 6 × 6 system), or a λ that grows only near singularities
(selectively damped least squares).

## References
- C. W. Wampler, *Manipulator Inverse Kinematic Solutions Based on Vector Formulations and Damped Least-Squares Methods*, IEEE Trans. SMC 1986. https://doi.org/10.1109/TSMC.1986.4308957
- Y. Nakamura, H. Hanafusa, *Inverse Kinematic Solutions With Singularity Robustness for Robot Manipulator Control*, J. Dyn. Sys., Meas., Control 1986. https://doi.org/10.1115/1.3143764
- S. R. Buss, *Introduction to Inverse Kinematics with Jacobian Transpose, Pseudoinverse and Damped Least Squares methods*, 2004. https://mathweb.ucsd.edu/~sbuss/ResearchWeb/ikmethods/iksurvey.pdf
