# CCD inverse kinematics (cyclic coordinate descent)

## Intuition
Inverse kinematics (IK) turns the joints of a limb so its end (wrist or ankle) reaches a target. CCD does it one joint at
a time: starting at the joint nearest the end, turn it so the line joint → end points at the target, then the next joint
towards the root, and repeat. Every step is a single rotation, easy to understand and to constrain.

**Where the target comes from.** The goal (`person-directions`) gives limb *directions*, because the frog's limbs are
far shorter than a person's. The target is where those directions put the wrist on the frog's own limbs:
$W = S + \ell_1 u + \ell_2 f$ (shoulder S, goal directions u, f, frog limb lengths ℓ), blended towards a spot on the belly
for a belly hold or above the head for an overhead reach. The same for the ankle from the hip. Unconstrained, the goal
pose reaches W exactly; IK matters where the body is in the way: it keeps the *hand* where the person's directions put it
while the elbow moves round the belly, where direction copy (the built-in solver) keeps the *directions* and lets the
hand move.

## The math
For joint j at $P_j$, end E and target T:

$$q_j = \text{rotation taking } \frac{E - P_j}{|E - P_j|} \text{ to } \frac{T - P_j}{|T - P_j|}, \qquad P_k \leftarrow P_j + q_j (P_k - P_j)\ \ (k > j)$$

After each sweep the chain is projected onto the constraints: each segment turned so its deepest point lands
`needed + 3 mm` out of the body (`constraints.pushOut`), the bend clamped to `constraints.limit("elbow" | "knee")`, knees
and ankles kept off the middle (`constraints.spread`).

## Steps
```ts
let p = joints(c, project(body, c, start, true));          // start: the person's directions (hint 1)
for (let it = 0; it < iterations && goOn(c, p[2], last); it++) {
  for (const j of [1, 0]) {                                // elbow, then shoulder
    q.setFromUnitVectors(norm(p[2] − p[j]), norm(target − p[j]));
    for (k > j) p[k] = p[j] + q·(p[k] − p[j]);
  }
  p = joints(c, project(body, c, dirsOf(p), true));        // light projection each sweep
}
return project(body, c, dirsOf(p));                        // full projection at the end
```
`goOn` stops at `ccdTolerance`, or when an iteration brings the end less than a tenth of it closer (a target the body
keeps out of reach).

## Parameters
| Parameter | Meaning | Typical range | What you see when you change it |
|---|---|---|---|
| `ccdIterations` | sweeps per limb and frame | 4–15 | more: closer to the target near the body, more cost |
| `ccdTolerance` | stop when the end is this close (m) | 0.001–0.005 | larger: cheaper, sloppier hands |
| `ccdHint` | start from the person's directions (1) or last frame's solution (0) | 0.5–1 | 0: the elbow's swivel drifts away from the person's (fidelity 22° on penguin vs 13°) |

## When to use it
Long chains (tails, spines, fingers) where one rotation per joint is simple and robust. On a two-bone limb CCD favours
the joint nearest the end, so the elbow does most of the work and the motion zig-zags between frames: it is the jerkiest
IK solver here. Measured on naiwa.glb (60 fps, built-in output; gouxiong / naenae / kemusan):

| | fidelity ° | jerk m/s³ | penetration mm | solve ms |
|---|---|---|---|---|
| direction copy (built-in) | 16.3 / 16.3 / 17.3 | 5131 / 383 / 1254 | 7.6 / 1.0 / 1.0 | 0.25 / 0.25 / 0.30 |
| `ccd-ik` | 18.9 / 17.6 / 17.2 | 6258 / 1184 / 1835 | 1.0 / 1.0 / 1.0 | 0.59 / 0.52 / 0.62 |

Fidelity is measured against the person's *directions*, which IK does not try to keep; it does keep the hands off the
head and belly better (penetration 1 mm everywhere). Compare FABRIK (smoother, similar cost) and DLS (smoother still on
calm dances).

## In the code
`src/algorithms/motion/ccdSolver.ts`, a **solver** block; the shared chain set-up (targets, `project`, pose assembly)
is in `src/algorithms/motion/limbs.ts`. First things to try: sweep root first instead of end first, or damp each
rotation (turn only part of the way) to calm the zig-zag.

## References
- L.-C. T. Wang, C. C. Chen, *A combined optimization method for solving the inverse kinematics problem of mechanical manipulators*, IEEE Trans. Robotics and Automation 1991. https://doi.org/10.1109/70.86079
- S. R. Buss, *Introduction to Inverse Kinematics with Jacobian Transpose, Pseudoinverse and Damped Least Squares methods*, 2004. https://mathweb.ucsd.edu/~sbuss/ResearchWeb/ikmethods/iksurvey.pdf
