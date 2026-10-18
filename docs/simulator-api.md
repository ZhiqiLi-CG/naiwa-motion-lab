# Simulator plugin API

The simulation is the page's other numerical core. It is built as a lab: a small core loop over eight slots, with one
replaceable block in each slot. A *simulator* is a named assembly of blocks. You can write one block (your own floor
contact, your own flesh solver) and keep the built-in blocks for the rest.

- Types: `src/sim/api.ts`
- The loop: `src/sim/core.ts`
- The registry: `src/sim/registry.ts`
- The built-in blocks: `src/sim/blocks/`

`docs/soft-binding.md` explains why the flesh is split up this way.

## The loop

```
pose targets ─▶ skeleton ◀─▶ coupling ◀─▶ flesh ─▶ (collision) ─▶ output ─▶ rendered surfaces
                (bones)      (bones as   (soft-body               (surface
                             boundary,    time step)               from the
                             two-way)                              particles)
        target: where the flesh would be if it were firm      interaction: the user's pokes and pinches
        metrics: quality numbers read from every stage
```

Every fixed step (1/60 s) the core does the following:

1. calls each block's `beforeStep(scene)`, in slot order;
2. steps the shared Rapier world once (rigid bones, balls, and any Rapier objects the blocks added);
3. calls each block's `afterStep(scene)`;
4. turns contacts into events (land, ball, squish).

A flesh solver that lives outside Rapier advances in `afterStep`, when this step's bones and targets are known. A frame
runs at most two steps. When a frame is slower than that, the extra time is dropped, so the page never spirals down.

| Slot | Interface | Built in (`cpu-constraints`) | Job |
|---|---|---|---|
| `skeleton` | `SkeletonBlock` | `rapier-skeleton` | Bone dynamics. Free mode: hold the pose and right itself. Driven mode: follow the pose targets. |
| `flesh` | `FleshBlock` | `rapier-soft-body` | The soft-body time step; exposes each part's particles as a `ParticleView`. |
| `target` | `TargetBlock` | `bone-carried-target` | Where each particle would be if the flesh were firm, and how fast that target moves. |
| `coupling` | `CouplingBlock` | `bone-attachments` | How flesh and bones exchange motion: the flesh near a bone rides on it, in both directions. |
| `collision` | `CollisionBlock` | — (covered) | Contacts of the flesh with the floor, the balls, the bones and the limbs. |
| `interaction` | `InteractionBlock` | `flesh-push` | `push` (a smooth velocity change around a point) and `grab` (a pinch that follows the pointer). |
| `output` | `OutputBlock` | `flesh-surface` | `read(part)`: the rendered surface, in the same vertex order as the part. |
| `metrics` | `MetricsBlock` | `quality-metrics` | Deviation from the target, inverted cells, volume per part, limb penetration, jitter, momentum, energy. |

**Covering a slot.** A block that does a neighbour's job itself declares that slot in `covers`, and the core then
builds no block for it. Rapier resolves the soft body's contacts in the same solve, so `rapier-soft-body` covers
`collision`. An MPM solver that resolves contacts on its grid would cover it too.

## The scene

Blocks are built in slot order and meet only through the `Scene`:

- `world`: the shared Rapier world. Never call `world.step` yourself; the core steps it.
- `dt`, `params` (the physics sliders), `mode` (free or driven).
- `parts`: the Body and the four limbs as `SimPart`s. Each has the rest surface, softness and region per vertex, and
  the skeleton bones it rides on.
- `skeleton`, `flesh`, `target`, `coupling`: the blocks built before the one reading them. Reading a block that is not
  built yet, or a covered slot, throws.
- `collisionGroups` for colliders a block adds, `registerCollider(collider, part)` to turn its contacts into events,
  and `reportContact(...)` for contacts found outside Rapier.

**Particles.** The common currency is the `ParticleView`: world positions, mass, impulses, and attaching a particle to
a rigid body. Coupling, interaction, metrics and output all work through it. Any flesh solver that exposes its
particles this way can therefore keep the other blocks.

## Parameters

A block declares its parameters as `SimParameter`s (`src/contracts.ts`): a key, a `{ zh, en }` label, a kind, a range,
a unit and a default. The Lab panel builds controls from these declarations. A simulator lists the parameters of all
its blocks together, so keys must be unique within one simulator. When a value changes, the core calls the block's
`setSettings`. A parameter marked `rebuild` rebuilds the simulation instead.

The physics sliders (softness, bounciness, gravity, volume, stubbornness, softness per region) reach every block
through `setParams`.

## Devices: GPU and the CPU-parallel fallback

A block declares `device: "cpu" | "gpu"`. Two methods tell the page how the block will run in this browser:

- `available()`: `null` when it can run here, otherwise the reason it cannot.
- `backend()`: what it actually runs on here.

Probe the device once at start-up, since `initPhysics` waits for it. Both methods must be synchronous, so they just
read the result of that probe.

**Without a usable GPU** (no WebGPU adapter, or only a software or fallback adapter), MPM and FEM are **not**
disabled. They run on the CPU in parallel instead:

- same algorithm, a second backend;
- Web Workers over `SharedArrayBuffer`, which needs the page to be cross-origin isolated (COOP/COEP headers);
- `backend()` then returns e.g. `{ zh: "CPU 并行 · 8 线程", en: "CPU parallel · 8 workers" }`, which the Lab shows next
  to the simulator.

## The smallest custom block

`src/sim/examples/smoothSurface.ts` replaces the output block with a few rounds of Laplacian smoothing. It is tested in
`smoothSurface.test.ts`:

```ts
import type { BlockDefinition, OutputBlock, Scene, Settings, SimPart } from "../api";
import { registerBlock, registerSimulator } from "../api";

class SmoothSurface implements OutputBlock {
  constructor(private scene: Scene, private s: Readonly<Settings>) { /* neighbour rings per part */ }
  setSettings(s: Readonly<Settings>) { this.s = s; }          // rounds and weight apply live
  read(part: SimPart): Float32Array {
    const source = this.scene.flesh.surface?.(part) ?? part.positions;
    /* `rounds` times: move each vertex `weight` of the way to the mean of its neighbours */
  }
}

export const smoothSurface: BlockDefinition<"output"> = {
  id: "smooth-surface", slot: "output", device: "cpu",
  name: { zh: "平滑表面", en: "Smoothed surface" },
  summary: { zh: "对求解器的表面做几轮拉普拉斯平滑。", en: "A few rounds of Laplacian smoothing over the solver's surface." },
  parameters: [
    { key: "rounds", kind: "number", default: 2, min: 0, max: 6, step: 1, label: { zh: "轮数", en: "Rounds" } },
    { key: "weight", kind: "number", default: 0.5, min: 0, max: 1, step: 0.05, label: { zh: "强度", en: "Weight" } },
  ],
  create: (scene, settings) => new SmoothSurface(scene, settings),
};

registerBlock(smoothSurface);
// Try it in place of one slot of an existing simulator…
createFrogSim(spec, params, { id: "cpu-constraints", settings: { rounds: 3 }, blocks: { output: "smooth-surface" } });
// …or register a simulator that uses it; it then shows up in the Lab's simulator list.
registerSimulator({
  id: "cpu-constraints-smooth",
  name: { zh: "CPU 约束求解（平滑表面）", en: "CPU constraint solver (smoothed surface)" },
  summary: { zh: "内置的 CPU 示例，输出换成平滑表面。", en: "The built-in CPU example with a smoothed surface." },
  blocks: { skeleton: "rapier-skeleton", flesh: "rapier-soft-body", target: "bone-carried-target",
            coupling: "bone-attachments", interaction: "flesh-push", output: "smooth-surface", metrics: "quality-metrics" },
});
```

Both register functions return a function that removes the registration again.

## Writing a flesh solver

A flesh block owns the soft body's time step. It must provide `particles(part)` (a `ParticleView`), `addVelocity`
(used for throws) and `stats()`. If it tracks a render surface it can also provide `surface`, and it can provide
`cells` and `volumeRatio` so the metrics can measure it.

To keep the built-in coupling, its particles must be able to `attach` to a bone's rigid body in both directions: the
bone carries the particle, and the particle's inertia pulls on the bone. A solver that cannot do this brings its own
coupling block.

`docs/soft-binding.md` lists the problems the blocks solve together and which block owns each one: twisting joints,
collapsing head and chest, seams, lag, penetration, facets, volume loss and jitter.
