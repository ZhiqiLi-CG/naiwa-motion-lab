# Mass–spring (a damped spring on every edge)

## Intuition
The simplest soft body: put a mass at every node of the cells and a spring along every edge. Stretch the flesh and
the springs pull it back; the damping along each spring takes the wobble out. It is easy to read and cheap per step,
but springs only resist changes of length: they do not hold a cell's volume or keep it from turning inside out, and a
stiff spring forces small time steps when integrated explicitly.

## The math
For the spring between particles i and j, rest length L, stiffness k, damping c, with $\mathbf n = (\mathbf x_j - \mathbf x_i)/l$:

$$\mathbf f_i = \big(k\,(l - L) + c\,(\mathbf v_j - \mathbf v_i)\cdot\mathbf n\big)\,\mathbf n, \qquad \mathbf f_j = -\mathbf f_i$$

Stiffness from the material: $k = 2E\,V_e/L^2$, $V_e$ the edge's share of the volume of its cells (a sixth of each, times
the region's stiffness); $c = 2\zeta\sqrt{k\,m}$.

**Explicit** (symplectic Euler, substeps of $h_s$): $\mathbf v \mathrel{+}= h_s(\mathbf g + \mathbf f/m)$, then $\mathbf x \mathrel{+}= h_s\mathbf v$. Stable only while $h_s\,\omega < 2$
for the fastest particle, $\omega^2 \approx \sum k/m$: the code takes at least $\lceil h\,\omega\rceil$ substeps.

**Semi-implicit** (Baraff & Witkin 1998, one linearised backward Euler step), with $K = -\partial\mathbf f/\partial\mathbf x$, $C = -\partial\mathbf f/\partial\mathbf v$:

$$(M + hC + h^2K)\,\Delta\mathbf v = h\,(\mathbf f_0 - hK\mathbf v)$$

solved by conjugate gradients; a spring's transverse stiffness $k(1 - L/l)$ is clamped at 0 so that the matrix stays positive.

## Steps
```ts
// attached particles start at the start of the step and move with their bone's velocity
if (implicit) implicitStep(h, g);           // assemble M + hC + h²K over the free particles, CG for Δv
else for (s of substeps)                    // max(springSubsteps, ⌈h·ω⌉)
  forces(X, V);                             // springs + dampers on the active edges
  free:     V += hs * (g + f / m)
  attached: reaction += f * hs              // the spring's pull goes to the bone
  X += hs * V
```

## Parameters
| Parameter | Meaning | Typical range | What you see when you change it |
|---|---|---|---|
| `integrator` | explicit or semi-implicit | — | semi-implicit: steadier and fewer inverted cells, costs a CG solve |
| `springSubsteps` | least explicit substeps per step | 5–20 | fewer is cheaper; the stability limit raises it anyway |
| `springDamping` | ζ of each spring | 0.1–0.6 | low: the flesh rings and the standing frog never comes to rest |
| `springCgIterations` | CG iterations (semi-implicit) | 10–50 | fewer: the step is softer than it should be |
| `bodyParticles` | lattice nodes in the Body | 150–600 | finer, slower; the explicit substeps grow too (smaller cells are stiffer) |

## When to use it
For learning and as a baseline. Cheap (0.3 ms of flesh per step on the frog), but its flesh loses
volume when the torso bends (Body 0.92 of rest) and cells turn inside out (20 in the 50° bend) because nothing
measures a cell's volume. XPBD and the FEM blocks fix exactly that. See the measured table in
[the index](../sim-index.md).

Measured on the real frog with the one harness of [the index](../sim-index.md) (all standing: head height 0.99, drift ≤ 5 cm):

| naiwa.glb, bend 50° | deviation cm | inverted | Body volume | head error mm | hands in belly mm | ms/step (flesh) |
|---|---|---|---|---|---|---|
| cpu-constraints (built-in) | 4.06 | 0 | 0.988 | 8.9 | 7.9 | 1.48 (in Rapier) |
| `mass-spring`, explicit | 2.13 | 20 | 0.917 | 8.8 | 12.0 | 0.84 (0.30) |
| `mass-spring`, semi-implicit | 2.14 | 6 | 0.941 | 9.1 | 11.1 | 1.15 (0.61) |

## In the code
`src/algorithms/sim/massSpring.ts`, a **flesh** block (the particles, lattice and two-way attachments come from
`flesh.ts`). First experiments: add a volume spring per cell to `forces`, or compare `springDamping` 0.1 and 0.6 while
poking the belly.

## References
- D. Baraff, A. Witkin, *Large Steps in Cloth Simulation*, SIGGRAPH 1998. https://doi.org/10.1145/280814.280821
- A. Nealen et al., *Physically Based Deformable Models in Computer Graphics*, Computer Graphics Forum 2006 (§3, mass–spring). https://doi.org/10.1111/j.1467-8659.2006.01000.x
