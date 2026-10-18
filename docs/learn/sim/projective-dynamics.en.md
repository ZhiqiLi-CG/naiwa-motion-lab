# Projective Dynamics (local projections, one prefactored global solve)

## Intuition
An implicit Euler step is the minimum of an energy: inertia plus elasticity. Projective Dynamics writes the
elasticity so that this minimum can be found by alternating two easy steps. Locally, each cell finds the nearest shape
it would be happy with (its rotation, and a volume-keeping version of itself). Globally, all particles solve one
linear system to get as close as possible to all those shapes and to where inertia carries them. The system's matrix
never changes, so it is factored once and every iteration costs only two triangular solves.

## The math
With the inertial target $\mathbf s = \mathbf x + h\mathbf v + h^2\mathbf g$ and per-cell deformation $F = \sum_k \mathbf x_k \nabla N_k^\top$:

$$\min_{\mathbf x}\; \frac{1}{2h^2}\|\mathbf x - \mathbf s\|_M^2 + \sum_t \frac{w_t}{2}\,\|F_t(\mathbf x) - T_t\|^2$$

- local: $T_t$ = the rotation R of $F_t$ (weight $2\mu V$, "as rigid as possible") and $F_t/\sqrt[3]{\det F_t}$ (weight $\lambda V$, volume);
- global: $\big(M/h^2 + \sum_t w_t G_t^\top G_t\big)\,\mathbf x = M\mathbf s/h^2 + \sum_t w_t G_t^\top T_t$, the same scalar matrix for x, y and z.

The matrix covers the free particles only; attached ones move to the right-hand side, and when one is attached or
detached (a pinch) the matrix is factored again. Sparse Cholesky in envelope form with reverse Cuthill–McKee ordering.

## Steps
```ts
if (dirty) factor();                        // M/h² + Σ w GᵀG over the free particles
x = s
for (it of iterations)
  local();                                   // T per cell: rotation and volume projection
  rhs = M s / h² + Σ w Gᵀ T − (columns of attached particles) · x_attached
  for (axis of x, y, z) chol.solve(rhs)     // two triangular solves
v = (x − x_old) / h
reaction (attached) = −Σ w (F − T) ∇N · h
```

## Parameters
| Parameter | Meaning | Typical range | What you see when you change it |
|---|---|---|---|
| `pdIterations` | local/global iterations | 2–10 | more: closer to the true implicit step (stiffer, less artificial softness) |
| `pdPoisson` | ν, the volume weight against the shape weight | 0.3–0.48 | higher: keeps volume better |

## When to use it
When you want an implicit, unconditionally stable step at a fixed cost: the deviation from the bones is the lowest of
the library in the bend (1.75 cm), 0 inverted cells. Its weakness is that few iterations make the material softer than
it should be (each iteration only moves part of the way), and any material that is not a projection (neo-Hookean
proper) needs a quasi-Newton extension. About 1.2 ms of flesh per step; a pinch costs one refactorisation.

Measured on the real frog with the one harness of [the index](../sim-index.md) (all standing: head height 0.99, drift ≤ 5 cm):

| naiwa.glb, bend 50° | deviation cm | inverted | Body volume | head error mm | hands in belly mm | ms/step (flesh) |
|---|---|---|---|---|---|---|
| cpu-constraints (built-in) | 4.06 | 0 | 0.988 | 8.9 | 7.9 | 1.48 (in Rapier) |
| `projective-dynamics` | 1.75 | 0 | 0.980 | 7.6 | 28.0 | 1.74 (1.23) |

## In the code
`src/algorithms/sim/projectiveDynamics.ts`, a **flesh** block; `EnvelopeCholesky` in `linalg.ts`. First experiments:
add a strain-limiting projection (clamp the singular values of F) in `local`, or try Chebyshev acceleration over the
iterations.

## References
- S. Bouaziz, S. Martin, T. Liu, L. Kavan, M. Pauly, *Projective Dynamics: Fusing Constraint Projections for Fast Simulation*, SIGGRAPH 2014. https://doi.org/10.1145/2601097.2601116
- T. Liu, S. Bouaziz, L. Kavan, *Quasi-Newton Methods for Real-Time Simulation of Hyperelastic Materials*, ACM TOG 2017. https://doi.org/10.1145/3072959.2990496
