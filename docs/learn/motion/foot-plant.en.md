# Foot planting (keeping standing feet still)

## Intuition
The default retargeter copies the person's heading onto the frog's root. A dancer who twists in place (狗熊哆嗦毛 swings
±0.68 rad) then swivels the frog's feet across the floor: they skate at about 1.2 m/s. Foot planting notices which feet
stand on the floor, pins each where it touched down, and places the root so the feet stay there. The turn the feet
cannot make goes into the upper body as a twist.

## The math
A foot stands when it is within `contactHeight` of the lower foot and the frog is not hopping. With the root turned by ψ
about +Y and moved by o in the floor plane, a foot at p (frog frame) is at $R(\psi)\,p + o$.

- Two feet down, anchors $A_L, A_R$: the heading is fixed by the line between them,
  $\psi = \angle(A_R - A_L) - \angle(p_R - p_L)$; the root offset is the least-squares fit
  $o = \tfrac12 \sum_s (A_s - R(\psi)p_s)$.
- One foot down: $o = A_s - R(\psi)p_s$ exactly, so any turn is a turn about that foot.
- The upper body takes the rest of the goal's turn: twist $\tau = \mathrm{clamp}(\psi_{goal} - \psi, \pm\tau_{max})$, applied to
  the spine and everything above it about the spine joint.

## Steps
```ts
const stance = SIDES.filter((s) => frog.lift < 0.005 && feet[s].y - lowest < contact);
if (planted.length === 2) yaw = heading(B - A) - heading(pR - pL);        // the feet fix the heading
else yaw = this.yaw + (free - this.yaw) * smoothstep(swingHeight / releaseHeight); // turn only once a foot really lifts
yaw = home(yaw, frog.yaw, dt, homing / halfStance);                        // slow pull to the goal heading
this.twist = clamp(frog.yaw - yaw, ±twistLimit);                           // the rest twists the upper body
offset = mean(anchor[s] - R(yaw)·foot[s]) over planted feet;               // keep them where they are
offset → goal offset: spring, capped at `homing` m/s while a foot stands, free in a hop
anchor[s] = R(yaw)·foot[s] + offset for standing feet, null for lifted ones
```

## Parameters
| Parameter | Meaning | Typical range | What you see when you change it |
|---|---|---|---|
| `contactHeight` | a foot this close to the lower one stands (m) | 0.01–0.03 | lower: feet let go sooner; higher: lifted feet still count as planted |
| `twistLimit` | most the upper body turns against the legs (rad) | 0.6–1.0 | lower: big turns slide the feet again; higher: a corkscrewed frog |
| `releaseHeight` | swing-foot height at which the frog may turn about the standing foot (m) | 0.03–0.08 | lower: shuffles become pivots and the frog wanders; higher: turns wait for big steps |
| `blend` | time constant for the twist to return to the root once a foot lifts (s) | 0.1–0.4 | lower: snappier turns on steps; higher: smoother |
| `homing` | top speed of the pull home while a foot stands (m/s): the slide it allows | 0.02–0.1 | 0: feet never slide but the frog can wander off in step-turns; higher: stays home, slides more |

## When to use it
Always, for dances on the floor. It does not change the limbs (fidelity and penetration are unchanged), only where the
whole frog stands. Measured on naiwa.glb (60 fps, gouxiong / naenae / kemusan, harness in
`src/algorithms/motion/bench.ts`):

| | foot slide cm/s | fidelity ° | jerk m/s³ |
|---|---|---|---|
| built-in output (`planted-rotations`) | 117.3 / 11.9 / 7.2 | 16.3 / 16.3 / 17.3 | 5131 / 383 / 1254 |
| `foot-plant` | 9.1 / 5.7 / 4.7 | 16.3 / 16.3 / 17.3 | 5294 / 408 / 1267 |

Costs about 0.02 ms per frame. Limits: it moves the whole frog, not the legs: when two planted feet move apart in the frog's
own frame, the fit splits the difference (a small slide), and side steps the goal asks for while a foot stands are
rate-limited to `homing`. Leg IK that puts the swing foot where it should land is the next step (the IK solvers of this
library could serve). Hopping dances step and turn in the air; the frog is pulled home during the flight, where it costs
no slide.

## In the code
`src/algorithms/motion/footPlant.ts`, an **output** block wrapping the built-in `planted-rotations`. It edits the
FrogPose in place (yaw, shift, upper-body twist) so the metrics see what is shown. Worth trying first: the heading rule
in the one-foot branch (`releaseHeight`), or replacing the least-squares fit for two feet by leg IK. The core does not
pass `dt` to output blocks yet; until it does, the block assumes 1/60 s.

## References
- L. Kovar, J. Schreiner, M. Gleicher, *Footskate cleanup for motion capture editing*, SCA 2002. https://doi.org/10.1145/545261.545277
