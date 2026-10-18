# FABRIK inverse kinematics (forward and backward reaching)

## Intuition
FABRIK works on joint *positions*, not angles. Backward pass: put the end on the target, then pull each joint towards
the one after it until the bone has its length again. Forward pass: put the root back where it belongs and push each
joint out from the one before it. Every move is a point on a line, so it is cheap, never overshoots and converges in a
few passes.

The target is where the person's limb directions put the wrist or ankle on the frog's own limb lengths,
$W = S + \ell_1 u + \ell_2 f$ (blended towards the belly or above the head for holds and reaches); see the CCD page for
why IK keeps the hand there while direction copy keeps the directions.

## The math
With bone lengths $\ell_j$:

- backward: $P_2 \leftarrow T$, then $P_j \leftarrow P_{j+1} + \ell_j \dfrac{P_j - P_{j+1}}{|P_j - P_{j+1}|}$ for j = 1, 0
- forward: $P_0 \leftarrow S$, then $P_j \leftarrow P_{j-1} + \ell_{j-1} \dfrac{P_j - P_{j-1}}{|P_j - P_{j-1}|}$ for j = 1, 2

A target out of reach ends with the limb straight towards it. After each iteration the chain is projected onto the
body's constraints (pushed out of the body, bend within the joint limit, legs apart), lightly inside the loop and fully
at the end.

## Steps
```ts
let p = joints(c, project(body, c, start, true));
for (let it = 0; it < iterations && goOn(c, p[2], last); it++) {
  p[2].copy(target);   for (j = 1; j >= 0; j--) reach(p[j], p[j + 1], len[j]);      // backward
  p[0].copy(root);     for (j = 1; j <= 2; j++) reach(p[j], p[j - 1], len[j - 1]);  // forward
  p = joints(c, project(body, c, dirsOf(p), true));
}
return project(body, c, dirsOf(p));
```
`reach(p, anchor, len)` moves p onto the line from anchor through p, len from the anchor.

## Parameters
| Parameter | Meaning | Typical range | What you see when you change it |
|---|---|---|---|
| `fabrikIterations` | backward + forward passes per limb and frame | 3–10 | more: closer near the body, more cost |
| `fabrikTolerance` | stop when the end is this close (m) | 0.001–0.005 | larger: cheaper, sloppier hands |
| `fabrikHint` | start from the person's directions (1) or last frame (0) | 0.5–1 | 0: the elbow's swivel drifts (fidelity 18.8° vs 16.4° on naenae) |

## When to use it
The default choice for positional IK in games: fast, stable, no matrices, easy to extend with per-joint cones. It spreads
the correction over the joints more evenly than CCD, so it is smoother. Measured on naiwa.glb (60 fps, built-in output;
gouxiong / naenae / kemusan):

| | fidelity ° | jerk m/s³ | penetration mm | solve ms |
|---|---|---|---|---|
| direction copy (built-in) | 16.3 / 16.3 / 17.3 | 5131 / 383 / 1254 | 7.6 / 1.0 / 1.0 | 0.25 / 0.25 / 0.30 |
| `fabrik-ik` | 17.5 / 16.4 / 17.6 | 4746 / 456 / 1743 | 1.0 / 1.0 / 1.0 | 0.50 / 0.50 / 0.73 |

Lowest jerk of the solvers on 狗熊哆嗦毛, close to direction copy elsewhere, and hands kept off the body. Its weakness
is the same as every end-effector IK: the elbow's swivel is free, so it needs the person's elbow as a hint.

## In the code
`src/algorithms/motion/fabrikSolver.ts`, a **solver** block; targets and the projection are shared in
`src/algorithms/motion/limbs.ts`. First things to try: apply the bend limit inside the passes (FABRIK's cone constraints)
instead of in the projection, or add a pole step that turns the elbow towards the person's elbow after each pass.

## References
- A. Aristidou, J. Lasenby, *FABRIK: A fast, iterative solver for the Inverse Kinematics problem*, Graphical Models 2011. https://doi.org/10.1016/j.gmod.2011.05.003
