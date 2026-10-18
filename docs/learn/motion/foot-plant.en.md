# Foot planting (keeping standing feet still)

## Intuition
The default retargeter copies the person's heading onto the frog's root. A dancer who twists in place (狗熊哆嗦毛 swings
±0.68 rad) then swivels the frog's feet across the floor: heels and toes skate at about 1.1 m/s. Foot planting notices
which feet stand on the floor, pins each where it touched down, and does two things to keep it there: it holds the
heading and places the root, and what the root cannot do it hands to the legs (a small two-bone IK). The turn the feet
cannot make goes into the upper body as a twist.

## The math
A foot stands when it is within `contactHeight` of the floor (a small hop counts: the frog's lift is added), and lets
go 1 cm higher (hysteresis). With the root turned by ψ about +Y and moved by o in the floor plane, a foot at p (frog
frame) is at $R(\psi)\,p + o$. A standing foot turns with the root, so turning the root would swing its toe round its
heel: while any foot stands, ψ holds and the goal's turn goes to the upper body, $\tau = \mathrm{clamp}(\psi_{goal} - \psi, \pm\tau_{max})$.

- Root offset: $o = \sum_s w_s (A_s - R(\psi)p_s) / \sum_s w_s$ over the planted feet (anchors $A_s$), weight
  $w_s$ larger for the foot flatter on the floor.
- Leg IK: each planted ankle is moved back over its anchor (height kept) by law-of-cosines two-bone IK in the leg's own
  bend plane, at most 8 cm, and only as far as the leg stays within 1 cm of the body's surface (bisection on the
  fraction of the fix, `constraints.check`).
- After lift-off the correction fades (0.12 s) instead of snapping; a free foot near the floor (< 3 cm now or last
  frame) sweeps no faster than 0.6 m/s; a free foot sweeping fast is lifted up to 5 cm. Recordings have one-frame leg
  jumps (狗熊哆嗦毛: 10 cm in a frame); a simulated foot asked to follow them on the floor drags.

## Steps
```ts
const stance = SIDES.filter((s) => height(s) < contact + (anchored ? 0.01 : 0));
let yaw = stance.length ? this.yaw : free;                  // hold the heading while a foot stands
yaw = home(yaw, frog.yaw, dt, homing / max(toe, stance width));
this.twist = clamp(frog.yaw - yaw, ±twistLimit);            // the rest twists the upper body
offset = weighted mean of anchor[s] − R(yaw)·foot[s];       // root keeps the planted feet as well as it can
twist the upper body; constraints.setTorso(frog)
for each foot: planted → reach(anchor) | free → fade the correction, limit low sweeps, lift fast sweeps
anchor[s] = standing ? where the foot is now : null
```

## Parameters
| Parameter | Meaning | Typical range | What you see when you change it |
|---|---|---|---|
| `contactHeight` | a foot this close to the floor stands (m) | 0.01–0.02 | higher: more two-foot stance, the legs work harder; lower: feet let go sooner |
| `twistLimit` | most the upper body turns against the legs (rad) | 0.5–1.0 | lower: big turns slide the feet again, and less forearm/belly contact (kemusan 5.3 → 3.3 mm at 0.3) |
| `blend` | time constant for the twist to return to the root in the air (s) | 0.1–0.4 | lower: snappier turns in hops |
| `homing` | top speed of the pull home while a foot stands (m/s): the slide it allows | 0.01–0.05 | 0: the frog can wander in step-turns; higher: stays home, slides more |

## When to use it
Always, for dances on the floor. Measured on naiwa.glb (60 fps, gouxiong / naenae / kemusan, `src/algorithms/motion/bench.ts`):

| | foot slide cm/s (metric) | heel and toe slide cm/s (e2e measure) | fidelity ° | penetration mm |
|---|---|---|---|---|
| built-in output (`planted-rotations`) | 117.3 / 11.9 / 7.2 | 113.7 / 6.5 / 3.3 | 16.3 / 16.3 / 17.3 | 7.6 / 1.0 / 1.0 |
| `foot-plant` | 0.0 / 0.0 / 0.0 | 0.4 / 2.7 / 0.8 | 18.8 / 16.8 / 17.4 | 10.0 / 4.2 / 5.3 |

The e2e measure is the page's own (`tests/e2e/lib/instrument.js`, footSlide): heel and toe each, counted while within
1.5 cm of their lowest point, by how far they end up from where they touched down (`measureContact` in bench.ts). On
naenae a foot hovers 1.4–3 cm up for long stretches; the measure counts it as down while it moves.

Costs about 0.03 ms per frame. Limits: the leg IK changes the legs a little (fidelity on 狗熊哆嗦毛 16.3° → 18.8°) and
the twist lets a forearm brush the belly (4–5 mm). In the simulated page the feet are dynamic limbs driven by motors and
lag their targets: on 狗熊哆嗦毛 the rendered heels and toes still slide about 16–18 cm/s, mostly the right foot lifting
late and its toe dragging (see `docs/learn/motion-index.md`).

## In the code
`src/algorithms/motion/footPlant.ts`, an **output** block wrapping the built-in `planted-rotations`. It edits the
FrogPose in place (heading, shift, upper-body twist, leg rotations) so the metrics see what is shown, and reports
`PoseFrame.contacts`: a foot is pinned while it is planted, within `contactHeight` (not the release hysteresis) and not
rising, so the simulation lets it go no later than the frame it lifts. Worth trying
first: turn the hips with the twist and let the leg IK re-plant the feet, or move the release earlier with a lookahead
on recordings.

## References
- L. Kovar, J. Schreiner, M. Gleicher, *Footskate cleanup for motion capture editing*, SCA 2002. https://doi.org/10.1145/545261.545277
