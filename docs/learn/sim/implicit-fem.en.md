# Implicit FEM (tetrahedral finite elements, backward Euler with Newton–CG)

## Intuition
The textbook model of elastic flesh: each cell measures its deformation F, a material law turns it into stress and
energy, and the forces on the nodes are the derivative of that energy. The step is backward Euler — find the positions
where inertia and elasticity balance at the end of the step — so it is stable for stiff material and large steps.
Three materials show why the choice matters for a skeleton that rotates:

- **linear**: small-strain elasticity. Cheap and linear, but a cell that only turns is seen as stretched, so rotating
  flesh grows (the "ghost forces" of linear FEM);
- **corotational**: the same law measured in the cell's own rotation (F = RS): rotation-invariant, still one linear
  solve per step;
- **neo-Hookean** (stable variant): a true large-deformation material; a squashed or inverted cell is pushed back out.

## The math
Backward Euler as a minimisation, $\mathbf s = \mathbf x_n + h\mathbf v_n + h^2\mathbf g$:

$$\Phi(\mathbf x) = \frac{1}{2h^2}\|\mathbf x - \mathbf s\|_M^2 + \sum_t V_t\,\psi(F_t), \qquad (M/h^2 + H)\,\Delta\mathbf x = -\nabla\Phi$$

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
  b = f − M (x − s) / h²
  assemble(x)                      // M/h² + Σ V ∂P/∂x (closed form for linear/corotational, from dP for neo-Hookean)
  dx = CG(A, b, femCgIterations)
  x += step · dx                   // neo-Hookean: backtracking line search on Φ
v = (x − x_old) / h;   reaction (attached) = f(x) · h
```

## Parameters
| Parameter | Meaning | Typical range | What you see when you change it |
|---|---|---|---|
| `femMaterial` | linear, corotational, neo-Hookean | — | linear: the bent torso swells (volume 1.15) and the head distorts |
| `femNewton` | Newton iterations | 1–3 | 1 is exact for linear and nearly so for corotational; neo-Hookean gains a little from 2 |
| `femCgIterations` | CG iterations per Newton step | 5–30 | fewer: softer and cheaper |
| `femPoisson` | ν | 0.3–0.48 | higher: nearly incompressible, stiffer to solve |

## When to use it
When the material must mean something: Young's modulus and Poisson ratio are the real ones, and the corotational and
neo-Hookean materials keep the head and chest in shape through the bend (head 8 mm from rigid, 0 inverted cells, the
Body's volume within 3 % and 1.6 %). It is the most expensive block (1.5–2 ms of flesh per step on the frog in Node, about 1.5 × the built-in step in the
browser); the
CG iterations are the knob. The linear material is here to show what goes wrong without rotation invariance.

Measured on the real frog with the one harness of [the index](../sim-index.md) (all standing: head height 0.99, drift ≤ 5 cm):

| naiwa.glb, bend 50° | deviation cm | inverted | Body volume | head error mm | hands in belly mm | ms/step (flesh) |
|---|---|---|---|---|---|---|
| cpu-constraints (built-in) | 4.06 | 0 | 0.988 | 8.9 | 7.9 | 1.48 (in Rapier) |
| `implicit-fem`, linear | 2.94 | 0 | 1.152 | 25.4 | 28.9 | 1.27 (0.81) |
| `implicit-fem`, corotational | 1.82 | 0 | 0.970 | 8.1 | 21.0 | 1.93 (1.48) |
| `implicit-fem`, neo-Hookean | 1.89 | 0 | 0.984 | 8.5 | 10.2 | 2.64 (2.06) |

## In the code
`src/algorithms/sim/implicitFem.ts`, a **flesh** block (the materials are the small `Model` objects at the top).
First experiments: add your own material (a `P`, `dP`, `psi` triple), or use the previous step's Δx as the CG's warm
start.

## References
- M. Müller, M. Gross, *Interactive Virtual Materials* (corotational FEM), Graphics Interface 2004. https://dl.acm.org/doi/10.5555/1006058.1006083
- B. Smith, F. de Goes, T. Kim, *Stable Neo-Hookean Flesh Simulation*, ACM TOG 2018. https://doi.org/10.1145/3180491
- E. Sifakis, J. Barbič, *FEM Simulation of 3D Deformable Solids: A Practitioner's Guide*, SIGGRAPH Course 2012. https://doi.org/10.1145/2343483.2343501
