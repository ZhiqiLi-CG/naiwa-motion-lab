# Motion-transfer plugin API

Motion transfer turns a person's pose into pose targets for 奶蛙. It is one of the page's two numerical cores, and it is
built as a lab: a small core loop over five slots, one replaceable block per slot. A *retargeter* is a named assembly
of blocks. You can write one block (your own filter, your own IK) and keep the built-in ones for the rest.

The types are in `src/motion/api.ts`, the loop in `src/motion/core.ts` and the built-in blocks in `src/motion/blocks/`.

## The loop

```
person landmarks ─▶ filter ─▶ goal ─▶ solver ◀─▶ constraints ─▶ output ─▶ PoseFrame (character)
  (MediaPipe)       smooth    what the  frog skeleton   the frog's     bone rotations,
                              frog      pose (IK /      body: limbs    feet on the floor
                              should do optimisation)   outside it,
                                                        joint limits
                                         metrics read the result (fidelity, jerk, penetration, foot slide)
```

| Slot | Interface | Built in | Job |
|---|---|---|---|
| `filter` | `FilterBlock` | `one-euro` | Smooth the 33 MediaPipe landmarks. `live(frame, t)` is causal (camera); `recorded(frames, fps)` sees the whole video, so it can be zero-phase. |
| `constraints` | `ConstraintsBlock` | `frog-body` | The frog's own body: `clearance(p)` from its surface, `pushOut`, joint `limit`s, `spread` so legs never cross. |
| `goal` | `GoalBlock` | `person-directions` | Person frame → `Goal` (limb directions, belly holds, hops, face). Procedural dances are written directly as Goals and skip the first two slots. |
| `solver` | `SolverBlock` | `projected-directions` | `Goal` → `FrogPose` (world rotations and joint positions) under the constraints: the numerical core. |
| `output` | `OutputBlock` | `planted-rotations` | `pose(frog, dt)`: `FrogPose` → `PoseFrame` (local bone quaternions, root offset, heading, expressions); the lower foot on the floor. The default retargeter `planted-feet` uses the library's `foot-plant` here, which also pins standing feet. |

The core builds blocks in the order `filter, constraints, goal, solver, output`. Each block gets the **scene**: the
frog's rest rig (`scene.rig`), the recording if there is one, and the blocks built before it. The core runs
filter → goal once per person frame and solver → output once per shown frame. Splitting at the goal lets a source fade
or hold a pose when the person steps out of view.

**Frames.** Person landmarks are MediaPipe's: metres, hip-centred, x to the right of the image, y down, z away from the
camera. Everything about the frog is in the frog's frame: metres, root at its rest spot, +X its left, +Y up, +Z
forward.

## Parameters

A block declares its parameters as `SimParameter`s (`src/contracts.ts`): a key, a `{ zh, en }` label, a kind (number,
choice or boolean), a range, a unit and a default. The Lab panel builds controls from these declarations. A retargeter
lists the parameters of all its blocks together, so keys must be unique within one retargeter. When a value changes,
the core calls the block's `setSettings`. If the block has no `setSettings`, or the parameter is marked `rebuild`, the
pipeline is rebuilt instead.

## Metrics

`RetargetMetrics`, taken over the last 2 s, are shown in the Lab:

- `fidelity`: degrees between the goal's limb directions and the frog's. 0 means the frog reproduces the person's pose
  exactly.
- `jerk`: m/s³ at elbows, wrists, knees, ankles and head. Lower is smoother.
- `penetration`: metres a limb point sank into the body beyond what it may.
- `footSlide`: m/s of a foot that stands on the floor. 0 means the foot is planted.

## The smallest custom block

`src/motion/examples/emaFilter.ts` swaps the One Euro filter for an exponential moving average and is tested in
`emaFilter.test.ts`:

```ts
import type { BlockDefinition, FilterBlock, Landmarks, PersonFrame, Settings } from "../api";
import { registerRetargetBlock, registerRetargeter } from "../api";

class EmaFilter implements FilterBlock {
  private last: { world: Landmarks; image: Landmarks } | null = null;
  constructor(private s: Readonly<Settings>) {}
  setSettings(s: Readonly<Settings>) { this.s = s; }          // alpha applies live
  reset() { this.last = null; }                               // the person was lost
  live(frame: PersonFrame): PersonFrame { /* move alpha of the way to the new landmarks */ }
  recorded(frames: PersonFrame[]): PersonFrame[] { this.reset(); return frames.map((f) => this.live(f)); }
}

export const emaFilter: BlockDefinition<"filter"> = {
  id: "ema-filter", slot: "filter",
  name: { zh: "指数滑动平均", en: "Exponential moving average" },
  summary: { zh: "每帧向新的关键点靠近 alpha。", en: "Each frame moves alpha of the way to the new landmarks." },
  parameters: [{ key: "alpha", kind: "number", default: 0.3, min: 0.05, max: 1, step: 0.05, label: { zh: "alpha", en: "alpha" } }],
  create: (_scene, settings) => new EmaFilter(settings),
};

registerRetargetBlock(emaFilter);
registerRetargeter({
  id: "ema-direction-copy",
  name: { zh: "方向拷贝（EMA 滤波）", en: "Direction copy (EMA filter)" },
  summary: { zh: "默认的 retarget，换成指数滑动平均滤波。", en: "The default retargeter with an EMA filter." },
  blocks: { filter: "ema-filter", constraints: "frog-body", goal: "person-directions", solver: "projected-directions", output: "planted-rotations" },
});
```

Once registered, the retargeter shows up in the Lab's motion-transfer list. Both register functions return a function
that removes the registration again. To try a single block inside an existing retargeter without registering an
assembly, pass `blocks` to `createRetargetPipeline(rig, { id, settings, blocks: { filter: "ema-filter" } })`.

## Writing a solver

The built-in solver is not an optimiser. It copies the person's limb directions and then fixes each limb segment in
turn with closed-form steps: it projects the segment out of the body, clamps the joint to its limits, and solves the
two-bone limb analytically. A solver block receives the `Goal` and can query `scene.constraints` after the core has
called `setTorso`. Two kinds of solver fit the slot:

- **IK solvers** (CCD, FABRIK, damped least squares): they pull end-effectors to targets.
- **Constrained optimisation**: it minimises the distance to the person's directions subject to clearance ≥ thickness
  and the joint limits.

The library in `src/algorithms/motion/` (registered by `registerMotionLibrary()`) has CCD, FABRIK, damped least
squares and a penalty Gauss–Newton optimiser as solver blocks, Kalman and Savitzky–Golay filters and a foot-planting
output block; their learning pages and a measured comparison are in `docs/learn/motion-index.md`.
