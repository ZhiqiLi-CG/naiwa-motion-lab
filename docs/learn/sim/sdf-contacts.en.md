# SDF contacts (floor, bones, limbs and balls as distance fields)

## Intuition
A collision block for particle solvers that do not resolve contacts themselves. Every shape the flesh can meet has a
signed distance: the floor is the plane y = 0, a bone or a limb is a capsule (distance to a segment minus a radius), a
ball a sphere. After the flesh's step, every free particle closer than its margin is pushed out along the field's
gradient, its speed into the shape is removed, and its sliding is slowed by friction. The impulse it took goes to the
bone or ball it touched, so contacts are two-way.

## The math
Capsule with segment ab and radius r: $d(\mathbf p) = |\mathbf p - \mathbf c| - r$, $\mathbf c$ the closest point on ab, normal $\mathbf n = (\mathbf p - \mathbf c)/|\mathbf p - \mathbf c|$.
For overlap $\delta = r + \text{margin} - |\mathbf p - \mathbf c| > 0$ and relative velocity $\mathbf v_r = \mathbf v - \mathbf v_{bone}(\mathbf c)$:

$$v_n^{target} = \max\!\big(\beta\,\delta/h,\; -e\,v_n\big), \qquad \Delta v_n = v_n^{target} - v_n, \qquad |\Delta\mathbf v_t| \le \mu\,\Delta v_n$$

A shallow overlap is undone over a few steps by a separating speed (Baumgarte, β = 0.3), so a stiff solver is not kicked
by a jump every step while flesh rests on a bone; deeper than the margin is undone at once. The bone receives
$-m\,\Delta\mathbf v$ at the contact.

Two refinements matter on the real frog:
- a particle that starts inside a shape (flesh right at the bone, or the lattice reaching past the surface) is only kept
  from going deeper than it started;
- limb against Body is tested at the rendered surface, not at the particles (which are a lattice step apart, so a hand
  sits between them): each surface vertex inside a limb capsule moves its cell's particles by their barycentric
  weights so that the vertex lands on the capsule.

## Steps
```ts
for (part of parts)
  capsules: own bones' cores + the other parts' limb contact capsules, posed this step
  for (free particle i)
    floor: if (y < margin) contact(n = up)
    capsules: if (d < min(r + margin, rest distance)) contact(n, bone)
    balls: inelastic exchange of the normal impulse by both masses
  surfaceContacts(): limb capsules against the Body's embedded surface, averaged per particle
```

## Parameters
| Parameter | Meaning | Typical range | What you see when you change it |
|---|---|---|---|
| `contactMargin` | how close a particle may come, in half lattice steps | 0.3–1 | larger: the flesh floats further off bones and floor |
| `restitution` | e | 0–0.3 | bouncier contacts |
| `limbContact` | limbs against the Body | on | off: hands pass into the belly |

## When to use it
With any of the library's particle solvers (all assemblies use it). It is a post-step projection, not part of the
solve: simple and shared, but a contact and a stiff elastic force can disagree within a step; that is why shallow
overlaps are resolved softly. Hands pressed into the belly end up 0–29 mm deep depending on the solver (built-in, solved
inside Rapier: 8 mm). A solver that handles contacts in its own solve (e.g. as XPBD constraints in the substeps)
should cover the `collision` slot instead.

Measured on the real frog with the one harness of [the index](../sim-index.md) (all standing: head height 0.99, drift ≤ 5 cm):

| naiwa.glb, bend 50° | deviation cm | inverted | Body volume | head error mm | hands in belly mm | ms/step (flesh) |
|---|---|---|---|---|---|---|
| cpu-constraints (built-in) | 4.06 | 0 | 0.988 | 8.9 | 7.9 | 1.48 (in Rapier) |
| `mass-spring`, explicit | 2.13 | 20 | 0.917 | 8.8 | 12.0 | 0.84 (0.30) |
| `pbd` | 2.19 | 0 | 0.991 | 6.4 | 0.0 | 1.34 (0.87) |
| `xpbd` | 2.46 | 0 | 0.995 | 9.0 | 14.9 | 0.97 (0.51) |
| `shape-matching` | 3.66 | 0 | 0.979 | 15.9 | 6.9 | 0.63 (0.15) |
| `projective-dynamics` | 1.75 | 0 | 0.980 | 7.6 | 28.0 | 1.74 (1.23) |
| `implicit-fem`, corotational | 1.82 | 0 | 0.970 | 8.1 | 21.0 | 1.93 (1.48) |

## In the code
`src/algorithms/sim/sdfContacts.ts`, a **collision** block. First experiments: give the floor a softness instead of a
margin, or move the contacts into XPBD's substeps (a constraint $C = d(\mathbf p) \ge 0$).

## References
- K. Erleben, J. Sporring, K. Henriksen, H. Dohlmann, *Physics-Based Animation*, Charles River Media 2005 (ch. 7, contacts). https://iphys.wordpress.com/2020/01/12/free-book-physics-based-animation/
- M. Müller, N. Chentanez, T.-Y. Kim, M. Macklin, *Air Meshes for Robust Collision Handling*, SIGGRAPH 2015 (the problem post-step projection leaves). https://doi.org/10.1145/2766907
- E. Catto, *Iterative Dynamics with Temporal Coherence*, GDC 2005 (Baumgarte stabilisation). https://box2d.org/files/ErinCatto_IterativeDynamics_GDC2005.pdf
