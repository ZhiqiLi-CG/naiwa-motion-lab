# Implicit FEM (tetrahedral finite elements, an implicit BDF2 step with Newton–CG)

## Intuition
The textbook model of elastic flesh: each cell measures its deformation F, a material law turns it into stress and
energy, and the forces on the nodes are the derivative of that energy. The step is implicit — find the positions
where inertia and elasticity balance at the end of the step — so it is stable for stiff material and large steps; with
BDF2 rather than backward Euler it keeps the jiggle instead of damping it away.
Three materials show why the choice matters for a skeleton that rotates:

- **linear**: small-strain elasticity. Cheap and linear, but a cell that only turns is seen as stretched, so rotating
  flesh grows (the "ghost forces" of linear FEM);
- **corotational**: the same law measured in the cell's own rotation (F = RS): rotation-invariant, still one linear
  solve per step;
- **neo-Hookean** (stable variant): a true large-deformation material; a squashed or inverted cell is pushed back out.

## The math
An implicit step as a minimisation:

$$\Phi(\mathbf x) = \frac{1}{2h'^2}\|\mathbf x - \mathbf s\|_M^2 + \sum_t V_t\,\psi(F_t), \qquad (M/h'^2 + H)\,\Delta\mathbf x = -\nabla\Phi$$

- backward Euler: $h' = h$, $\mathbf s = \mathbf x_n + h\mathbf v_n + h^2\mathbf g$, $\mathbf v_{n+1} = (\mathbf x_{n+1} - \mathbf x_n)/h$ — shrinks a mode of frequency ω by
  $1/\sqrt{1 + (h\omega)^2}$ every step: a 4 Hz jiggle loses 8 % per step at 60 Hz and is gone in 0.2 s;
- BDF2 (`bdf2.ts`, the default): $h' = \tfrac23 h$, $\mathbf s = \tfrac43\mathbf x_n - \tfrac13\mathbf x_{n-1} + h'(\tfrac43\mathbf v_n - \tfrac13\mathbf v_{n-1}) + h'^2\mathbf g$,
  $\mathbf v_{n+1} = (\mathbf x_{n+1} - \tfrac43\mathbf x_n + \tfrac13\mathbf x_{n-1})/h'$ — loses only about $(h\omega)^4/8$ per step there (0.4 %), yet damps
  the stiff lattice-scale modes, so it stays stable at the firmest setting. (Newmark's energy-conserving trapezoidal
  rule, tried first, blew up there through the explicit coupling of flesh and bones.)

- linear: $\psi = \mu|\varepsilon|^2 + \tfrac{\lambda}{2}\operatorname{tr}(\varepsilon)^2$, $\varepsilon = \operatorname{sym}F - I$; $P = \mu(F + F^\top - 2I) + \lambda\operatorname{tr}(F - I)I$
- corotational: the same in $R^\top F$, $P = R\,P_{lin}(R^\top F)$, R held during the solve, $H_{ab} = R\,K_{ab}R^\top$
- stable neo-Hookean (Smith et al. 2018): $\psi = \tfrac{\mu}{2}(\operatorname{tr}F^\top F - 3) + \tfrac{\lambda'}{2}(J - \alpha)^2$, $\lambda' = \lambda + \mu$, $\alpha = 1 + \mu/\lambda'$; $P = \mu F + \lambda'(J - \alpha)\operatorname{cof}F$

Nodal force $\mathbf f_k = -V\,P\,\nabla N_k$. H is assembled over the free particles from 3 × 3 blocks; CG with a
block-Jacobi preconditioner stops at negative curvature (the neo-Hookean H may be indefinite), and the neo-Hookean step
backtracks on Φ.

## Steps
```ts
x = s
for (it of femNewton)
  rotations(x)                     // corotational: R of each cell (polar decomposition, warm-started)
  forces(x)                        // f = −Σ V P ∇N
  b = f − M (x − s) / h'²
  assemble(x)                      // M/h'² + Σ V ∂P/∂x (closed form for linear/corotational, from dP for neo-Hookean)
  dx = CG(A, b, femCgIterations)
  x += step · dx                   // neo-Hookean: backtracking line search on Φ
v from BDF2 (or (x − x_old)/h);   reaction (attached) = f(x) · h
```

## Parameters
| Parameter | Meaning | Typical range | What you see when you change it |
|---|---|---|---|
| `femMaterial` | linear, corotational, neo-Hookean | — | linear: the bent torso swells (volume 1.15) and the head distorts |
| `femIntegrator` | auto, BDF2, backward Euler | — | auto: BDF2, but backward Euler for the linear material (its ghost forces keep pumping energy in, which only backward Euler drains); backward Euler: the shake dies in 0.15 s |
| `femNewton` | Newton iterations | 1–3 | 1 is exact for linear and nearly so for corotational; neo-Hookean always takes at least 2 (one leaves errors BDF2 does not damp enough in a fast shake) |
| `femCgIterations` | CG iterations per Newton step | 5–30 | fewer: softer and cheaper |
| `femPoisson` | ν | 0.3–0.48 | higher: nearly incompressible, stiffer to solve |

## When to use it
When the material must mean something: Young's modulus and Poisson ratio are the real ones, and the corotational and
neo-Hookean materials keep the head and chest in shape through the bend (head 8 mm from rigid, 0 inverted cells, the
Body's volume within 3 % and 1.6 %). With BDF2 a shake swings 7 times over 0.85 s (1.4–1.7 s at
the softest), against 1.5 times in 0.15 s with backward Euler. Corotational costs about 2.2 ms of flesh per step in Node
(1.3 × the built-in step in the browser); neo-Hookean, with its two Newton steps, 5.4 ms: not interactive on a busy
machine. The CG iterations are the knob. The linear material is here to show what goes wrong without rotation invariance.

Measured on the real frog with the one harness of [the index](../sim-index.md) (all standing: head height 0.99, drift ≤ 5.4 cm; the shake is the jiggle harness of the index):

| naiwa.glb, bend 50° | deviation cm | inverted | Body volume | head error mm | hands in belly mm | ms/step (flesh) | shake, default: peak mm / swings / decay s | shake, softest |
|---|---|---|---|---|---|---|---|---|
| cpu-constraints (built-in) | 3.47 | 0 | 0.999 | 8.5 | 0.0 | 2.38 (in Rapier) | 32 / 3.5 / 0.47 | 25 / 3.5 / 0.50 |
| `implicit-fem`, linear | 3.17 | 0 | 1.158 | 25.5 | 7.5 | 1.80 (1.06) | — | — |
| `implicit-fem`, corotational | 2.00 | 0 | 0.970 | 7.9 | 12.7 | 3.10 (2.21) | 60 / 7.0 / 0.85 | 104 / 7.0 / 1.38 |
| `implicit-fem`, neo-Hookean | 2.05 | 0 | 0.986 | 8.2 | 6.6 | 6.46 (5.40) | 70 / 6.5 / 0.83 | 110 / 8.5 / 1.72 |

## In the code
`src/algorithms/sim/implicitFem.ts`, a **flesh** block (the materials are the small `Model` objects at the top).
First experiments: add your own material (a `P`, `dP`, `psi` triple), or use the previous step's Δx as the CG's warm
start.

## References
- M. Müller, M. Gross, *Interactive Virtual Materials* (corotational FEM), Graphics Interface 2004. https://dl.acm.org/doi/10.5555/1006058.1006083
- B. Smith, F. de Goes, T. Kim, *Stable Neo-Hookean Flesh Simulation*, ACM TOG 2018. https://doi.org/10.1145/3180491
- E. Sifakis, J. Barbič, *FEM Simulation of 3D Deformable Solids: A Practitioner's Guide*, SIGGRAPH Course 2012. https://doi.org/10.1145/2343483.2343501
