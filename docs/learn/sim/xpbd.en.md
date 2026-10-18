# Extended PBD (XPBD: compliance, multipliers and small steps)

## Intuition
PBD with a physical stiffness. Each constraint gets a compliance α (the inverse of a spring stiffness, from Young's
modulus) and the solver keeps its Lagrange multiplier λ, so the result no longer depends on how many iterations run:
it converges to an implicit Euler step of real springs. Many small substeps of one iteration each ("small steps")
converge faster than few steps with many iterations.

## The math
With $\tilde\alpha = \alpha/h_s^2$ for substep $h_s$, one iteration of a constraint changes λ by

$$\Delta\lambda = \frac{-C - \tilde\alpha\,\lambda}{\sum_j w_j|\nabla_j C|^2 + \tilde\alpha}, \qquad \Delta\mathbf p_i = w_i\,\nabla_i C\,\Delta\lambda$$

(one iteration per substep, so λ starts at 0 and $\Delta\lambda = -C/(\sum w|\nabla C|^2 + \tilde\alpha)$). Compliances from the material:

- edges: $\alpha = 1/k$, $k = 2E\,V_e/L^2$ (as the mass–spring);
- cells: $C = V - V_0$, energy $\tfrac{K}{2V_0}(V-V_0)^2$, so $\alpha = V_0/K$ with the bulk modulus $K = E/(3(1-2\nu))$.

The force a constraint exerts is $\lambda\nabla C/h_s^2$; on an attached particle its impulse $\lambda\nabla C/h_s$ goes to the bone.

## Steps
```ts
for (s of substeps)                       // xpbdSubsteps, hs = h / substeps
  prev = p;  v += hs·g (free);  p += hs·v
  distances(hs);  volumes(hs);            // Δλ with α̃ = α / hs², one pass each
  v = (p − prev) / hs                     // free particles
x = p
```

## Parameters
| Parameter | Meaning | Typical range | What you see when you change it |
|---|---|---|---|
| `xpbdSubsteps` | substeps per step | 3–15 | more: closer to the true stiffness (firm material needs more); cost grows linearly |
| `xpbdPoisson` | Poisson ratio ν for the volume compliance | 0.3–0.49 | towards 0.5: nearly incompressible, the belly keeps its volume |
| softness slider | Young's modulus 60 → 6 kPa | — | the same slider means the same flesh as in the FEM blocks |

## When to use it
The best value in the library: physically meaningful stiffness, robust (0 inverted cells, Body volume 0.995 in the
bend), and under 1 ms of flesh per step on the frog. Compared with the FEM blocks it handles volume with a separate
constraint rather than one consistent material model, and its Gauss–Seidel passes propagate a push across the body
only a few cells per substep.

Measured on the real frog with the one harness of [the index](../sim-index.md) (all standing: head height 0.99, drift ≤ 5 cm):

| naiwa.glb, bend 50° | deviation cm | inverted | Body volume | head error mm | hands in belly mm | ms/step (flesh) |
|---|---|---|---|---|---|---|
| cpu-constraints (built-in) | 4.06 | 0 | 0.988 | 8.9 | 7.9 | 1.48 (in Rapier) |
| `xpbd` | 2.46 | 0 | 0.995 | 9.0 | 14.9 | 0.97 (0.51) |

## In the code
`src/algorithms/sim/xpbd.ts` (the block) and `positionBased.ts` (`xpbd: true`), a **flesh** block. First experiments:
add a shape-matching or strain constraint per cell next to `volumes`, or compare 2 and 10 substeps at the firmest
softness.

## References
- M. Macklin, M. Müller, N. Chentanez, *XPBD: Position-Based Simulation of Compliant Constrained Dynamics*, MIG 2016. https://doi.org/10.1145/2994258.2994272
- M. Macklin, K. Storey, M. Lu, P. Terdiman, N. Chentanez, S. Jeschke, M. Müller, *Small Steps in Physics Simulation*, SCA 2019. https://doi.org/10.1145/3309486.3340247
