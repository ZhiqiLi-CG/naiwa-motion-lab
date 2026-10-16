# Binding soft flesh to the skeleton so it looks right

The solver is only part of a skeleton-driven soft body. What the user notices is whether the frog *looks* right:
no twisting, no collapsing joints, no faceting, no lag like syrup, no jitter, nothing passing through anything. The
user (2026-10-16): "在simulation的时候绑定软体 肯定还有其他的也需要处理的，比如怎么看上去不扭曲阿，这些你也要想像怎么结合".
This page lists those problems and the block (src/sim/api.ts) that owns each one, so that every block stays small
and replaceable and the problems are still solved together.

## The pipeline

```
pose targets ─▶ skeleton ◀─▶ coupling ◀─▶ flesh solver ─▶ collision ─▶ surface output ─▶ render
 (motion)       (bones)      (bones as     (hyperelastic    (contacts)     (embedding,
                             boundary,      cells; optional                 smoothing,
                             two-way)       target shape)                   features)
                                     quality metrics read every stage
```

**Physics first.** The default is a physical model: hyperelastic flesh (corotational or neo-Hookean cells, which
are rotation-invariant, so large bone rotations do not by themselves fold anything), the bones as boundary
conditions (the layer of flesh against a bone moves with it), an implicit/FEM solve, and two-way coupling (the flesh
pushes back on the bones, momentum is conserved), with parameters that mean something physically (Young's modulus,
Poisson ratio, damping, density). The head and chest collapse seen today is not a limit of physics: it comes from the
current set-up (Volume cells held only by edges, few particles riding on the head and chest bones, soft settings, an
iterative solve that does not converge under large rotations), and is fixed there first.

**A skinned target, only as a physically interpreted option.** The user asked whether simulating the deviation from
a skinned shape is "不太物理" — it is, if done naively: the skinned shape is a geometric guess rather than a stress-free
state, and pulling flesh towards it is an external force with no reaction on the bones (momentum and energy are not
conserved). It is therefore offered only in two physically interpreted forms, both two-way: as connective tissue
(distributed tethers from flesh to bones, their reaction forces applied to those bones by the skin weights), or as an
active, pose-dependent rest shape (as muscles change the stress-free state; the elastic energy is measured against
it). One weight parameter goes from 0 (pure physics, the default) upward, and the lab compares the two on the same
motion: deformation quality, interpenetration, momentum and energy drift.

## Problems and where they are solved

| Problem the user would see | Cause | Block | Approach |
|---|---|---|---|
| Joints collapse or twist like a candy wrapper (neck, shoulders, hips, wrists) | flesh at a joint bound to two bones that twist apart; for the optional target, linear blend skinning | coupling (+ target shape) | the flesh between two bones is free to deform elastically (not bound to either); twist spread along the limb; dual-quaternion or centre-of-rotation skinning for the optional target |
| The head and chest fold into the torso when bending | Volume cells held only by edges, few particles on the head/chest bones, soft settings, a solve that does not converge | flesh solver + coupling | rotation-invariant hyperelastic cells (corotational / neo-Hookean), FEM solve, enough flesh bound to the bones; the skinned-target option only as tethers or an active rest shape, two-way |
| A hard seam where flesh changes from "on the bone" to "free" | particles hard-attached to bones next to free ones | coupling | attachment strength falls off smoothly with the skin weights and the distance from the bone, no on/off boundary |
| Flesh lags behind like syrup on fast moves, or slides around the body | damping and inertia in world space | flesh solver / coupling | damp velocities relative to the target's motion (simulation in the body's frame); inertia transfer as a parameter |
| Arms enter the belly; the belly fights the arm and jitters | the target itself interpenetrates; collision and target pull against each other | collision (+ motion) | contacts win over target springs; targets inside another part are projected out; poses keep limbs outside (motion) |
| Facets, kinks, a visible lattice | the render surface is interpolated from a coarse cage | surface output | smooth embedding (displacement field over the target, not raw cell interpolation), rotation-aware detail, smoothed normals |
| Face features stretch or float (eyes off the head) | features follow single bones or stretch with the flesh | surface output (+ character) | eyes, mouth and other features ride on local surface frames, the face region firmer |
| The belly loses volume when squashed or bent | per-cell constraints only | flesh solver | global volume preservation per part, per region |
| Jitter at rest, explosions on noisy targets | stiff springs, noisy webcam poses | skeleton + flesh solver | filtered, velocity-limited targets; substeps; sleep thresholds |

## What each block needs

- **Skin weights** of every flesh vertex (FleshPart.skinIndices / skinWeights, from the GLB) so the target-shape
  block can skin; the character module hands them over.
- A shared **scene description** (bone poses, colliders as primitives/SDFs, the floor) so CPU and GPU blocks agree.
- **Quality metrics**, computed from the target shape and the simulated surface, shown in the page's readouts and
  used by the benchmarks: deviation from the target (mean, max), triangle stretch and area change, flipped
  triangles or inverted cells, volume per region, interpenetration depth between parts, jitter at rest.

## The asset's part

Good binding starts in the model: joints with enough edge loops where they bend, clean skin weights with smooth
falloff, a coarse closed cage for the simulation and a finer render surface, and the face region modelled to stay
firm. These go back to the Codex modelling session as requirements when the rig is refined.
