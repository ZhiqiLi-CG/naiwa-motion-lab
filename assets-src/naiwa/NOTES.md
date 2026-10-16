# 奶蛙 reconstruction

`public/models/naiwa.glb` is the delivery asset. `naiwa.blend` is an editable inspection scene with the same mesh, skeleton, material and expression data, plus the render studio. The GLB excludes the studio and contains no animation clips.

## Rebuild and review

From the repository root, using Blender 5.2.2:

```bash
blender -b -P assets-src/naiwa/build_naiwa.py
blender -b -P assets-src/naiwa/build_naiwa.py -- --renders
python3 assets-src/naiwa/make_comparisons.py
blender -b -t 2 -P assets-src/naiwa/validate_naiwa.py -- --stress
node assets-src/naiwa/check_browser.mjs
```

The builder starts with an empty scene. It creates all geometry, skin weights, morphs and the embedded belly texture analytically; there are no input meshes or downloaded model dependencies. `--renders` also saves the inspection `.blend`. The comparison script requires Pillow; the builder and validator use Blender's bundled Python. GPU renders on this shared machine can be run through `/home/zhiqili/robotgen-studio/tools/gpu_run.sh --need 1800`.

Review [the three reference comparisons](renders/reference_comparisons.png), [the seven stress poses](renders/stress_poses.png), and the individual images in `renders/`. The comparisons preserve the complete reference images and render frames, with uniform resizing and no retouching. Reference 3 and its render show the upper body. The source images have different lighting, crops and poses, so they are not treated as calibrated orthographic views.

## Character decisions

The three supplied images remain authoritative; [SOURCES.md](references/SOURCES.md) records every supplementary image. The high-resolution standing image clarified a narrow, rounded head, a projecting upper lip above a concave throat, a large low pear-shaped abdomen, a cream patch with a substantial yellow band beneath it, fleshy arms, tapered legs and dark blunt toes. Eye caps turn slightly outwards so the near eye remains round in profile. The face has a closed neutral smile, a deep laugh pocket, an open tongue expression, a round surprise mouth and closed eyelid creases.

The standing proportions are approximately one metre tall, half a metre across the belly, with the legs and feet occupying the lower quarter. The silhouette and the cream patch were revised after comparison, rather than keeping the initial oversized patch and thin straight leg cones. Peace-sign hands have separate index, middle, ring and thumb bones, with rounded joined palm/finger surfaces. The rendered reference pose includes a small head roll and unequal hand heights, as in the source.

Unseen parts are explicit inferences:

- **Back:** a smooth, unmarked yellow convex continuation of the visible side silhouette. There is no evidence for a tail, dorsal ridge, spots or separate head/neck seam, so none were added.
- **Soles:** broad, nearly flat dark olive undersides, with three blunt toe lobes. The standing image supplies the toe count and outline; underside pads, nails and tread would be unsupported additions.
- **Hidden arm/leg sides:** mirrored rounded flesh and the same olive transition at wrists/ankles. Roots extend inside the torso to tolerate visible soft-body motion without exposing a gap.
- **Hand anatomy:** four digits per hand, including the thumb, consistent with the visible holds and peace signs. One contract bone per digit provides the gesture; the curved finger surface and distributed weights supply flexion without adding unsupported human anatomy.
- **Mouth interior:** a dark red closed pocket, ivory upper/lower teeth and a pink tongue. Interior depth and the hidden rear wall are inferred from the open-mouth images. The pocket is part of Body's surface, so opening the mouth never cuts a topological hole.

## Rig and deformation

The GLB uses metres, +Y up and +Z forward. The rest pose has relaxed, separated arms, straight legs and soles on the floor. It has one armature and one glTF skin, the 17 required core bones and all eight optional finger bones. All five named mesh objects are skinned.

Body is one closed connected manifold, including the head and mouth pocket. It has 7,172 triangles; the complete character has 27,596. The cream patch is an embedded texture on this same surface. The UV seam produces ordinary duplicate render vertices in glTF; welding coincident positions, as the character module does, recovers the closed surface. Blender's source Body itself has no duplicate seam vertices.

The point attribute `_softness` is approximately 1 over the belly and 0.2 over the back/head, with 0.15 in the mouth pocket. Blender exports the glTF semantic `_SOFTNESS`; Three's loader exposes it as `_softness`. Shape keys are named `laugh`, `tongue`, `surprise` and `blink` on the meshes they affect. Their neutral values in the exported file are zero.

The initial rigid finger roots and short elbow/knee weight transitions folded through themselves at large bends. The final rig uses wider smooth weight transitions, narrower joint regions, chest-supported shoulder roots and gradual palm-to-finger weighting. These corrections use ordinary linear skinning, which matches glTF/Three, without Blender-only dual quaternion deformation or unexported corrective drivers. Fuller thighs are retained above the knee supports. Arm and leg pose solvers used for evidence place the wrists and ankles explicitly; the exported rig remains unconstrained for the playground's own retargeting.

## Validation and limits

`validation.json` records the builder's topology and counts. `independent-validation.json` independently parses the actual GLB, checks the contract, hierarchy, mirrored bone frames, inverse binds, normalized skin weights, dimensions, morphs, embedded texture and softness, then checks the source and posed surfaces. Its hash identifies the audited GLB.

`check_browser.mjs` uses the repository's Three.js and Puppeteer in Chrome to load the actual GLB, check all five skinned meshes, zero default morph weights, the embedded texture and `_softness`, and save `renders/09_browser_rest.png`. `browser-validation.json` records that result and the GLB hash. This check exposed and fixed Blender's initially nonzero morph defaults; the delivered asset loads with a neutral face.

The stress suite includes a roughly 70-degree forward bend, arms overhead, hands across the belly, a squat, a leg lift, an airborne hop and a 45-degree torso twist. It also checks the standing hold, laugh and peace poses. In total the audit checks 11 endpoint poses, 30 intermediate rest-to-pose rotations (123 Body/Arms/Legs mesh evaluations), and 9 intermediate Body morph samples. Body is checked for manifold edges and vertex links, connectedness, positive volume, degenerate triangles and nonadjacent self-intersections; Arms and Legs are also checked for fold-through. Intersection checks include coplanar triangle overlaps.

These are sampled geometry checks, not a guarantee for arbitrary combinations of tracking noise, extreme joint rotations or physics parameters. Adjacent triangles sharing a vertex are excluded from the intersection test. The intentional overlap of arm/leg roots with the Body is not a surface defect. Actual soft-flesh dynamics and webcam retargeting are supplied by the playground; the evidence renders exercise the exported skeleton and skin without inventing a separate animation mesh.
