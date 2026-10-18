# Position-based dynamics (PBD: project constraints, take velocities from the motion)

## Intuition
Instead of computing forces, guess where each particle goes this step, then move the guesses until the constraints
hold: every edge back to its length, every cell back to its volume, one constraint at a time. The velocity is just
how far a particle went. Nothing can blow up, which is why games use it, but how stiff the flesh is depends on how many
passes you make and on the time step, not on a material constant.

## The math
For a constraint $C(\mathbf p) = 0$ with gradients $\nabla_i C$ and inverse masses $w_i$, one projection moves

$$\Delta\mathbf p_i = -\,k'\,\frac{C}{\sum_j w_j\,|\nabla_j C|^2}\;w_i\,\nabla_i C, \qquad k' = 1 - (1-k)^{1/n}$$

($n$ iterations, so that n passes give the stiffness k). The two constraints:

- distance $C = |\mathbf p_i - \mathbf p_j| - L$, $\nabla_i C = \mathbf n$, $\nabla_j C = -\mathbf n$;
- volume $C = V(\mathbf p_0..\mathbf p_3) - V_0$, $\nabla_1 V = (\mathbf p_2 - \mathbf p_0)\times(\mathbf p_3 - \mathbf p_0)/6$ (and cyclic), $\nabla_0 V = -\sum$.

Signed volume, so an inverted cell is pushed back out. Afterwards $\mathbf v = (\mathbf p - \mathbf x)/h$.

## Steps
```ts
for (s of substeps)                          // pbdSubsteps, hs = h / substeps
  p = x + hs·v (+ hs²g for free particles)   // attached particles: from their bone's motion
  for (it of iterations)
  distances(): for each active edge, project; an attached end has w = 0 and passes λ∇C/h to its bone
  volumes():   for each active cell, project
v = (p − x) / h;  x = p
```
(`positionBased.ts`, shared with XPBD; PBD is the `xpbd: false` branch.)

## Parameters
| Parameter | Meaning | Typical range | What you see when you change it |
|---|---|---|---|
| `pbdSubsteps` | substeps per step | 1–6 | more: stiffer too (k is per pass, not per second) and less of the jiggle lost per step |
| `pbdIterations` | Gauss–Seidel passes per substep | 2–10 | more: stiffer flesh (yes, the material changes) and more cost |
| `pbdStiffness` | edge stiffness k (times the material's modulus against the default) | 0.02–0.3 | lower: softer, sags more; the default 0.05 is soft because 9 passes a step compound it |
| `pbdVolumeStiffness` | volume stiffness | 0.1–1 | 0: the belly loses volume when squeezed |

## When to use it
When it must never explode and you can tune by eye: robust, simple, 0 inverted cells and the Body's volume within
1 % in the 50° bend. The price: the stiffness is not physical — double the iterations or halve the step and the frog
gets firmer. And it is dissipative by construction: each projection moves the particles only part of the way and
the velocity is what remains, so the jiggle dies in a few tenths of a second whatever the bounciness (a shake: 2.5
swings, 0.4 s). XPBD keeps everything good about PBD and removes the first problem.

Measured on the real frog with the one harness of [the index](../sim-index.md) (all standing: head height 0.99, drift ≤ 5.4 cm; the shake is the jiggle harness of the index):

| naiwa.glb, bend 50° | deviation cm | inverted | Body volume | head error mm | hands in belly mm | ms/step (flesh) | shake, default: peak mm / swings / decay s | shake, softest |
|---|---|---|---|---|---|---|---|---|
| cpu-constraints (built-in) | 3.47 | 0 | 0.999 | 8.5 | 0.0 | 2.38 (in Rapier) | 32 / 3.5 / 0.47 | 25 / 3.5 / 0.50 |
| `pbd` | 2.65 | 0 | 0.996 | 8.0 | 28.1 | 2.85 (1.97) | 80 / 2.5 / 0.38 | 81 / 3.0 / 0.38 |

## In the code
`src/algorithms/sim/pbd.ts` (the block) and `positionBased.ts` (the solver), a **flesh** block. First experiments:
switch the volume constraint off (`pbdVolumeStiffness` 0) and squeeze the belly; or run 4 versus 20 iterations.

## References
- M. Müller, B. Heidelberger, M. Hennix, J. Ratcliff, *Position Based Dynamics*, VRIPHYS 2006 / JVCIR 2007. https://doi.org/10.1016/j.jvcir.2007.01.005
- J. Bender, M. Müller, M. Macklin, *A Survey on Position Based Dynamics*, Eurographics Tutorials 2017. https://doi.org/10.2312/egt.20171034
