# Shape matching (pull each cluster towards its best rigid motion)

## Intuition
Forget elements: for a group of particles, find the rotation and translation that best fit their rest shape onto
where they are now, and pull every particle part of the way to its spot in that fitted shape. A cluster can never
collapse or turn inside out, because its goal is always an undeformed copy of itself. Here the clusters are the flesh
regions (belly, body, head…), each grown by one ring of neighbours so that neighbouring regions overlap.

## The math
Cluster with rest offsets $\mathbf q_i = \mathbf x_i^0 - \mathbf c^0$ and current centre of mass $\mathbf c$:

$$A_{pq} = \sum_i m_i(\mathbf p_i - \mathbf c)\,\mathbf q_i^\top, \qquad A_{pq} = R\,S \;\text{(polar)}, \qquad \mathbf g_i = R\,\mathbf q_i + \mathbf c, \qquad \mathbf p_i \mathrel{+}= \alpha(\mathbf g_i - \mathbf p_i)$$

R is the rotation of the best fit (the polar decomposition, found iteratively). With β > 0 the goal blends towards the
affine fit $A = A_{pq}A_{qq}^{-1}$ (volume kept by $\det A = 1$): $G = \beta A + (1-\beta)R$. A particle in several
clusters moves by the mean of their pulls. Since $\sum m_i(\mathbf g_i - \mathbf p_i) = 0$, a cluster conserves momentum.

## Steps
```ts
p = x + h·v + h²g (free)                       // attached particles: on their bones, they take part in the fit
for (it of iterations)
  for (cluster of clusters)
    c = centre of mass;  Apq = Σ m (p − c) qᵀ;  R = rotation(Apq)
    goal[i] += α (R q + c − p)
  free: p += mean pull;   attached: reaction += m · pull / h
v = (p − x) / h;  x = p
```

## Parameters
| Parameter | Meaning | Typical range | What you see when you change it |
|---|---|---|---|
| `smStiffness` | pull α per step (times region and material) | 0.1–1 | low: a slow, wobbly jelly; 1: rigid regions |
| `smIterations` | fit-and-pull passes per step | 1–4 | more: firmer |
| `smLinear` | β, affine part of the goal | 0–0.5 | the regions may stretch and shear |

## When to use it
When it must be cheap and unconditionally stable: the cheapest flesh of the library (about 0.2 ms per step), never
inverted cells. The price: with one cluster per region the flesh moves as a few soft blobs; the head deviates most
from its bone in the bend (16 mm against 8–9 mm for the FEM blocks), since the head cluster also contains neck flesh
pulled by the chest. More, smaller clusters (e.g. one per lattice cube with its neighbours) give finer detail at more
cost.

Measured on the real frog with the one harness of [the index](../sim-index.md) (all standing: head height 0.99, drift ≤ 5 cm):

| naiwa.glb, bend 50° | deviation cm | inverted | Body volume | head error mm | hands in belly mm | ms/step (flesh) |
|---|---|---|---|---|---|---|
| cpu-constraints (built-in) | 4.06 | 0 | 0.988 | 8.9 | 7.9 | 1.48 (in Rapier) |
| `shape-matching` | 3.66 | 0 | 0.979 | 15.9 | 6.9 | 0.63 (0.15) |

## In the code
`src/algorithms/sim/shapeMatching.ts`, a **flesh** block. First experiments: make clusters per lattice region instead
of per flesh region (in the constructor), or try β = 0.3 and poke the belly.

## References
- M. Müller, B. Heidelberger, M. Teschner, M. Gross, *Meshless Deformations Based on Shape Matching*, SIGGRAPH 2005. https://doi.org/10.1145/1073204.1073216
- A. R. Rivers, D. L. James, *FastLSM: Fast Lattice Shape Matching for Robust Real-Time Deformation*, SIGGRAPH 2007. https://doi.org/10.1145/1276377.1276480
