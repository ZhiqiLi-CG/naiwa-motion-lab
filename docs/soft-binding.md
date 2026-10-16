# Binding soft flesh to the skeleton so it looks right

The solver is only part of a skeleton-driven soft body. What the user notices is whether the frog *looks* right:
no twisting, no collapsing joints, no faceting, no lag like syrup, no jitter, nothing passing through anything. The
user (2026-10-16): "在simulation的时候绑定软体 肯定还有其他的也需要处理的，比如怎么看上去不扭曲阿，这些你也要想像怎么结合".
This page lists those problems and the block (src/sim/api.ts) that owns each one, so that every block stays small
and replaceable and the problems are still solved together.

## The pipeline

```
pose targets ─▶ skeleton ─▶ target shape ─▶ flesh solver ─▶ collision ─▶ surface output ─▶ render
 (motion)       (bones)     (skinning)       (dynamics      (contacts,     (embedding,
                                              around the     targets        smoothing,
                                              target)        kept outside)  features)
                                     quality metrics read every stage
```

The key idea: **the flesh simulates the difference from a good kinematic deformation**, not the whole shape. A
skinning method gives, every step, where each piece of flesh would be if it were perfectly firm (the *target
shape*); the solver adds the soft response around it (jiggle, dents, squash, inertia). Large bone rotations are then
carried by the skinning, which never folds, and the physics only has to handle small, well-conditioned deviations.
Today the free flesh is carried by physics alone, which is why the head and chest collapse when the spine bends.

## Problems and where they are solved

| Problem the user would see | Cause | Block | Approach |
|---|---|---|---|
| Joints collapse or twist like a candy wrapper (neck, shoulders, hips, wrists) | linear blend skinning averages rotations | target shape | dual-quaternion or centre-of-rotation skinning; twist spread along the limb |
| The head and chest fold into the torso when bending | free flesh carried by physics alone, cells held only by edges | target shape + flesh solver | flesh springs towards the skinned target (goal / shape matching per region), FEM or corotational cells for what remains |
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
