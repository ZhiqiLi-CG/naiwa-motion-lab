# 奶蛙 character asset contract

The playground loads `public/models/naiwa.glb` and turns it into a soft-body + skeleton simulation (Rapier 0.21): the
skeleton is a set of rigid bones, and the **whole** frog is soft flesh over them — the Body and every arm and leg is
filled as a volumetric soft body riding on its bones, each region with its own softness (the belly softest, hands and
feet firmest). The bones are driven by poses retargeted from a webcam, a video or built-in dances. The names below are what the code looks up
(`src/contracts.ts`).

## File and space

- glTF 2.0 binary, meters, +Y up, the frog faces +Z.
- Height about 1.0 m from the soles to the top of the head. Soles on y = 0, centred on x = z = 0.
- Rest (bind) pose: standing, legs straight down, arms hanging relaxed and a little away from the body (A-pose), so
  that every limb can be posed from it. No animation clips are needed.

## Armature

One armature. Bone names exactly as below (underscores, not dots: three.js strips dots from node names).

```
root                      at the floor between the feet
└─ hips                   pelvis, inside the lower belly
   ├─ spine               belly centre height
   │  └─ chest            upper torso
   │     ├─ head          the small head on top
   │     ├─ upperarm_L ─ forearm_L ─ hand_L ─ thumb_L, index_L, middle_L, ring_L   (fingers optional)
   │     └─ upperarm_R ─ forearm_R ─ hand_R ─ thumb_R, index_R, middle_R, ring_R
   ├─ thigh_L ─ shin_L ─ foot_L
   └─ thigh_R ─ shin_R ─ foot_R
```

`_L` is the character's own left (+X). Left and right mirror each other (positions and rolls).

## Meshes

Separate objects, all skinned to the armature, about 40k triangles in all at most.

| Object        | What                                                                                              |
|---------------|---------------------------------------------------------------------------------------------------|
| `Body`        | Torso and head as ONE closed, watertight, manifold surface with outward normals and no self-intersections (it is filled with soft-body cells). 3k–12k triangles. Carries the cream belly patch (material, vertex colour or texture on the same surface). Weighted mainly to hips, spine, chest and head. |
| `Eyes`        | Both eyes (white, green iris, black pupil) and whatever lids the blink needs; weighted to head.    |
| `Arms`        | Upper arms, forearms and the dark hands with fingers; each arm (with its hand) one closed, watertight, manifold shell, since it is filled with soft-body cells too. The arm roots sink into the Body so no gap shows when the flesh wobbles. |
| `Legs`        | Thighs, shins and the dark frog feet with toes; each leg (with its foot) one closed, watertight, manifold shell; roots sink into the Body. |
| `MouthInside` | Mouth cavity, teeth and tongue, shown when the mouth opens; weighted to head.                      |

`Body`, `Arms` and `Legs` carry a float point attribute `_softness` (0..1: belly ≈ 1, upper arms and thighs ≈ 0.5,
back and top of the head ≈ 0.2, hands and feet ≈ 0.15), exported as a custom glTF attribute (`export_attributes`);
three.js reads it as geometry attribute `_softness`.

## Shape keys (morph targets)

Same names on every mesh they affect; any may be missing and the app copes.

- `laugh`: the big belly laugh of reference 2: mouth wide open (teeth and the dark inside showing), eyes squeezed shut.
- `tongue`: the open grin with the tongue out of reference 3.
- `surprise`: small round "O" mouth, eyes wide.
- `blink`: eyes closed.

The Body stays closed in the rest shape; an open mouth is a pocket into the head, not a hole.

## Materials

glTF PBR (Principled BSDF), colours from the references: warm yellow body, cream belly, dark olive-grey hands and
feet, green iris, black pupil, dark red mouth, pink tongue, white teeth. A smooth soft-vinyl toy look (roughness about
0.5). Embedded textures are fine.
