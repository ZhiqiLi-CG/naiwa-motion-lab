# Soft tethers (two-way coupling with no seam between carried and free flesh)

## Intuition
The built-in coupling lets the flesh near a bone ride on it rigidly and leaves the rest free. Where the two meet there
is a hard boundary, and a fixed share of the flesh can never give. Soft tethers tie every particle to where its bone
would carry it with a damped spring whose strength falls off smoothly with depth: nearly rigid next to the bone,
almost free at the surface. Only the tissue right around the bone rides on it. Each tether pulls the bone back as hard
as it pulls the flesh, so momentum is exchanged, not created (docs/soft-binding.md: "no on/off seam").

## The math
Particle i at depth $u_i$ (distance to its bone over the flesh's typical thickness there), firmness $\phi_i = 1.5 - $ softness:

$$f_i = f_{near}\,\big(f_{far}/f_{near}\big)^{\,\mathrm{smoothstep}(0,\;r\phi_i,\;u_i)}, \qquad \omega_i = 2\pi f_i, \quad k_i = m_i\omega_i^2, \quad c_i = 2\zeta m_i\omega_i$$

Implicit for the pair (particle, bone), with the reduced mass $\mu = m M/(m + M)$ and M the bone's mass shared among
the particles tied to it (a Jacobi split that stays stable however stiff), $\mathbf d = \mathbf t - \mathbf x$, $\mathbf v_r = \mathbf v - \mathbf v_t$:

$$\mathbf J = \frac{\mu\,h\,\big(k\,\mathbf d - (c + hk)\,\mathbf v_r\big)}{\mu + hc + h^2k}$$

The particle gets $+\mathbf J$, the bone $-\mathbf J$ at the target point (linear and angular).

## Steps
```ts
constructor: depth of each particle; limbs and flesh with depth < tetherCore·φ ride on their bone (attach)
setSettings: ω of each tether from depth, firmness, near/far frequencies and reach
afterStep (after the flesh's step and the targets):
  share = bone mass per kg of flesh tied to it
  for (free particle i): J = implicit pair impulse;  particle += J;  bone −= J at the target
```

## Parameters
| Parameter | Meaning | Typical range | What you see when you change it |
|---|---|---|---|
| `tetherCore` | depth (× flesh thickness) that rides hard on the bone | 0.3–0.8 | lower: more of the flesh can give; the head and chest wobble more |
| `tetherNear` | frequency next to the bone (Hz) | 10–40 | lower: the deep flesh lags on fast moves |
| `tetherFar` | frequency at the surface (Hz) | 0.2–3 | higher: the surface is pulled back to the bone's shape, less jiggle |
| `tetherReach` | depth over which the strength falls | 0.8–2 | larger: a firmer, more bone-shaped body |
| `tetherDamping` | ζ of the tethers | 0.3–1 | lower: more bounce |

## When to use it
When the flesh should give everywhere a little and the transition from carried to free must not show. It costs
almost nothing itself; with the corotational FEM the Body follows the bend within 2.3 cm with 0 inverted cells, and the
head, with less of it riding hard on the skull, gives more (17 mm from rigid against 8 mm with bone attachments). It is
applied after the flesh's step (operator splitting): tethers and elasticity are not solved together, so very stiff
tethers can fight a stiff solver; the hard core is what carries the weight.

Measured on the real frog with the one harness of [the index](../sim-index.md) (all standing: head height 0.99, drift ≤ 5 cm):

| naiwa.glb, bend 50° | deviation cm | inverted | Body volume | head error mm | hands in belly mm | ms/step (flesh) |
|---|---|---|---|---|---|---|
| cpu-constraints (built-in) | 4.06 | 0 | 0.988 | 8.9 | 7.9 | 1.48 (in Rapier) |
| `implicit-fem`, corotational | 1.82 | 0 | 0.970 | 8.1 | 21.0 | 1.93 (1.48) |
| `fem-tethers` (soft tethers) | 2.31 | 0 | 0.977 | 17.0 | 17.0 | 2.52 (1.86) |

## In the code
`src/algorithms/sim/softTethers.ts`, a **coupling** block (the `fem-tethers` simulator pairs it with
`implicit-fem`). First experiments: put the tethers into the flesh solver's system (an extra spring term in its
Hessian) instead of after it, or weight them by the skin weights of the target instead of the nearest bone.

## References
- S. Capell, S. Green, B. Curless, T. Duchamp, Z. Popović, *Interactive Skeleton-Driven Dynamic Deformations*, SIGGRAPH 2002. https://doi.org/10.1145/566654.566622
- J. Kim, N. S. Pollard, *Fast Simulation of Skeleton-Driven Deformable Body Characters*, ACM TOG 2011. https://doi.org/10.1145/2019627.2019640
