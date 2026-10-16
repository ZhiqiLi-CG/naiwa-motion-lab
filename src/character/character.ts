/** The rendered 奶蛙 built from a contract scene (the GLB or the placeholder): rig spec, soft Body, face and life. */
import * as THREE from "three";
import {
  EXPRESSIONS,
  MESH_NAMES,
  type BoneName,
  type Character,
  type Expression,
  type ExpressionWeights,
  type FrogEvent,
  type PoseFrame,
  type RigBone,
  type RigInfo,
  type RigSpec,
} from "../contracts";
import { CharacterAssetError } from "./asset";
import { aimEye, makeEye, makeRivet, updateRivet, type Eye, type Rivet } from "./face";
import { Life, type Mood } from "./life";
import { boneExtents, findSkeleton, forwardKinematics, restPoints, type RestSkeleton } from "./rig";
import { BodySkin, softSkinMaterial, tieRoots, type RootTie } from "./skin";
import { Stance, type ArmRest } from "./stance";
import { checkSurface, surfaceProblems, weld, type SurfaceReport } from "./surface";

/** The character with what the contract does not cover yet (all optional to use). */
export interface NaiwaCharacter extends Character {
  /** Where it came from: the GLB, or the placeholder built in code because there was no GLB. */
  readonly source: "glb" | "placeholder";
  readonly mood: Mood;
  /** Called when the mood changes (e.g. play the giggle / laugh sound). */
  onMood(cb: (mood: Mood, prev: Mood) => void): () => void;
  /** Topology of the welded Body handed to the simulation, and how many render vertices it came from. */
  readonly bodyReport: SurfaceReport & { renderVertices: number };
  /** Turn its own life (blinking, breathing, moods, idle motion, reactions) on or off, e.g. for stills. */
  setLively(on: boolean): void;
}

type Part = THREE.SkinnedMesh;

/** Expression easing (1/s): quick to come, slower to go. */
const ATTACK = 22;
const RELEASE = 9;

export function createCharacter(scene: THREE.Object3D, source: "glb" | "placeholder", url: string): NaiwaCharacter {
  scene.updateMatrixWorld(true);
  // The rest shape is the basis: glTF default morph weights (an exporter may leave them at 1) do not count.
  scene.traverse((o) => (o as THREE.Mesh).morphTargetInfluences?.fill(0));
  const problems: string[] = [];
  const skel = findSkeleton(scene, problems);
  const parts = {} as Record<keyof typeof MESH_NAMES, Part[]>;
  for (const [key, name] of Object.entries(MESH_NAMES) as [keyof typeof MESH_NAMES, string][]) {
    const o = scene.getObjectByName(name);
    parts[key] = [];
    if (!o) {
      problems.push(`missing mesh ${name}`);
      continue;
    }
    o.traverse((m) => {
      if (!(m as THREE.Mesh).isMesh) return;
      if (!(m as Part).isSkinnedMesh) problems.push(`${name}: mesh ${m.name} is not skinned to the armature`);
      else parts[key].push(m as Part);
    });
    if (!parts[key].length) problems.push(`${name} has no mesh`);
  }
  for (const p of parts.body) {
    if (!p.geometry.attributes._softness) problems.push(`Body mesh ${p.name} has no _softness attribute`);
  }
  if (problems.length || !skel) throw new CharacterAssetError(url, problems);
  return new NaiwaFrog(scene, source, url, skel, parts);
}

class NaiwaFrog implements NaiwaCharacter {
  readonly object = new THREE.Group();
  readonly rig: RigInfo;
  readonly spec: RigSpec;
  readonly bodyReport: SurfaceReport & { renderVertices: number };
  mood: Mood = "calm";

  private skel: RestSkeleton;
  private skin: BodySkin;
  private bodyParts: { mesh: THREE.Mesh; map: Uint32Array }[] = [];
  private skinBones: BoneName[];
  private deltas: THREE.Matrix4[];
  private limbs: { mesh: Part; tie: RootTie; offset: THREE.BufferAttribute; toLocal: THREE.Matrix3 }[] = [];
  private rivets: Rivet[] = [];
  private eyes: Eye[] = [];
  private morphMeshes: { mesh: THREE.Mesh; slot: Partial<Record<Expression, number>> }[] = [];
  private life = new Life();
  private stance: Stance;
  private time = 0;

  // Latest simulated state (copied in applySim) and what the bones show.
  private simBody: Float32Array;
  private simBones = new Map<BoneName, THREE.Matrix4>();
  private haveSim = new Set<BoneName>();
  private boneWorld = new Map<BoneName, THREE.Matrix4>();
  private lastTargets = new Map<BoneName, THREE.Matrix4>();
  private haveTargets = false;
  private centerPos = new THREE.Vector3();
  private upright = 1;

  private requested: ExpressionWeights = {};
  private weights: Record<Expression, number> = { laugh: 0, tongue: 0, blink: 0, surprise: 0 };
  private lookTarget: THREE.Vector3 | null = null;
  private cameraPos = new THREE.Vector3(0, 0.6, 3);
  private moodListeners = new Set<(m: Mood, p: Mood) => void>();
  private materials = new Set<THREE.Material>();

  constructor(
    private scene: THREE.Object3D,
    readonly source: "glb" | "placeholder",
    url: string,
    skel: RestSkeleton,
    parts: Record<keyof typeof MESH_NAMES, Part[]>,
  ) {
    this.skel = skel;
    this.object.name = "Naiwa";

    // ---- The Body: weld the render vertices into the closed surface the simulation fills.
    const bodyPts = parts.body.map((p) => restPoints(p));
    const counts = bodyPts.map((b) => b.dominant.length);
    const total = counts.reduce((a, b) => a + b, 0);
    const all = new Float32Array(3 * total);
    const allIdx: number[] = [];
    let off = 0;
    parts.body.forEach((p, k) => {
      all.set(bodyPts[k].positions, 3 * off);
      const idx = p.geometry.index;
      const n = counts[k];
      if (idx) for (let i = 0; i < idx.count; i++) allIdx.push(idx.getX(i) + off);
      else for (let i = 0; i < n; i++) allIdx.push(i + off);
      off += n;
    });
    const w = weld(all, allIdx, 1e-5);
    const report = checkSurface(w.positions, w.indices);
    const bad = surfaceProblems(report);
    if (bad.length) throw new CharacterAssetError(url, bad.map((b) => `Body is not one closed manifold: ${b}`));
    this.bodyReport = { ...report, renderVertices: total };
    const nw = w.positions.length / 3;

    // Per welded vertex data from one render vertex that maps to it.
    const partOf = (gi: number): [number, number] => {
      let k = 0, base = 0;
      while (gi >= base + counts[k]) base += counts[k++];
      return [k, gi - base];
    };
    const softness = new Float32Array(nw);
    const skinBones: BoneName[] = [];
    const slotOf = new Map<THREE.Bone, number>();
    const skinIndex = new Uint16Array(4 * nw);
    const skinWeight = new Float32Array(4 * nw);
    const morphs = new Map<Expression, Float32Array>();
    const toWorld = parts.body.map((p) => new THREE.Matrix3().setFromMatrix4(p.matrixWorld));
    const v = new THREE.Vector3();
    for (let j = 0; j < nw; j++) {
      const [k, i] = partOf(w.first[j]);
      const g = parts.body[k].geometry;
      softness[j] = g.attributes._softness.getX(i);
      const si = g.attributes.skinIndex, sw = g.attributes.skinWeight;
      for (let c = 0; c < 4; c++) {
        const bone = parts.body[k].skeleton.bones[si.getComponent(i, c)];
        let slot = slotOf.get(bone);
        if (slot === undefined) {
          slot = skinBones.length;
          slotOf.set(bone, slot);
          skinBones.push(bone.name as BoneName);
        }
        skinIndex[4 * j + c] = slot;
        skinWeight[4 * j + c] = sw.getComponent(i, c);
      }
      for (const e of EXPRESSIONS) {
        const mesh = parts.body[k];
        const slotE = mesh.morphTargetDictionary?.[e];
        if (slotE === undefined) continue;
        const attr = g.morphAttributes.position?.[slotE];
        if (!attr) continue;
        let d = morphs.get(e);
        if (!d) morphs.set(e, (d = new Float32Array(3 * nw)));
        v.fromBufferAttribute(attr, i);
        if (!g.morphTargetsRelative) v.sub(new THREE.Vector3().fromBufferAttribute(g.attributes.position, i));
        v.applyMatrix3(toWorld[k]);
        d.set([v.x, v.y, v.z], 3 * j);
      }
    }
    for (const name of skinBones) {
      if (!skel.byName.has(name)) throw new CharacterAssetError(url, [`Body is skinned to ${name}, not a contract bone`]);
    }
    this.skinBones = skinBones;
    this.deltas = skinBones.map(() => new THREE.Matrix4());
    this.skin = new BodySkin({
      rest: w.positions, indices: w.indices, skinIndex, skinWeight, boneCount: skinBones.length, softness, morphs,
    });
    this.simBody = w.positions.slice();

    // Render meshes of the Body: world-space positions written every frame, same vertex colours and UVs.
    const soft = softSkinMaterial(parts.body[0].material as THREE.Material, false);
    this.materials.add(soft);
    off = 0;
    parts.body.forEach((p, k) => {
      const src = p.geometry;
      const geo = new THREE.BufferGeometry();
      const n = counts[k];
      geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(3 * n), 3).setUsage(THREE.DynamicDrawUsage));
      geo.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(3 * n), 3).setUsage(THREE.DynamicDrawUsage));
      for (const a of ["color", "uv"]) if (src.attributes[a]) geo.setAttribute(a, src.attributes[a].clone());
      if (src.index) geo.setIndex(src.index.clone());
      const mesh = new THREE.Mesh(geo, soft);
      mesh.name = p.name;
      mesh.matrixAutoUpdate = false;
      mesh.frustumCulled = false;
      mesh.castShadow = mesh.receiveShadow = true;
      this.bodyParts.push({ mesh, map: w.map.subarray(off, off + n) });
      this.object.add(mesh);
      off += n;
      p.removeFromParent();
      src.dispose();
    });

    // ---- Bones: the simulation writes their world matrices; local transforms stay at rest for retargeting.
    for (const b of skel.list) {
      b.bone.matrixWorldAutoUpdate = false;
      this.boneWorld.set(b.name, b.restWorld.clone());
      this.simBones.set(b.name, b.restWorld.clone());
    }
    const skeleton = parts.arms[0].skeleton;
    const limbPts = [...parts.arms, ...parts.legs].map((p) => restPoints(p));
    let lo = Infinity, hi = -Infinity;
    for (const pts of [...bodyPts, ...limbPts]) {
      for (let i = 1; i < pts.positions.length; i += 3) (lo = Math.min(lo, pts.positions[i])), (hi = Math.max(hi, pts.positions[i]));
    }
    this.rig = { skeleton, bones: new Map(skel.list.map((b) => [b.name, b.bone])), height: hi - lo };

    // ---- Rig spec for the simulation.
    const ext = boneExtents(skel, [...bodyPts, ...limbPts]);
    const bones: RigBone[] = skel.list.map((b) => ({
      name: b.name, parent: b.parent, restWorld: b.restWorld.clone(),
      tail: ext.get(b.name)!.tail, radius: ext.get(b.name)!.radius,
    }));
    this.spec = { bones, body: { positions: w.positions.slice(), indices: w.indices.slice(), softness } };

    // ---- Limbs: skinned to the simulated bones; their roots ride on the flesh.
    [...parts.arms, ...parts.legs].forEach((mesh, k) => {
      const tie = tieRoots(limbPts[k].positions, w.positions, this.skin.normals);
      const offset = new THREE.BufferAttribute(new Float32Array(3 * mesh.geometry.attributes.position.count), 3);
      offset.setUsage(THREE.DynamicDrawUsage);
      mesh.geometry.setAttribute("rootOffset", offset);
      const mat = softSkinMaterial(mesh.material as THREE.Material, true);
      this.materials.add(mat);
      mesh.material = mat;
      this.limbs.push({ mesh, tie, offset, toLocal: new THREE.Matrix3().setFromMatrix4(mesh.matrixWorld).invert() });
    });

    // ---- Face: eyes and mouth inside re-skinned onto rivets on the head surface.
    const head = skel.byName.get("head")!;
    const headCenter = new THREE.Vector3().setFromMatrixPosition(head.restWorld);
    const eyePts = parts.eyes.map((p) => restPoints(p).positions);
    const sides: { name: "L" | "R"; verts: [number, number][] }[] = [{ name: "L", verts: [] }, { name: "R", verts: [] }];
    eyePts.forEach((pts, k) => {
      for (let i = 0; i < pts.length / 3; i++) sides[pts[3 * i] >= 0 ? 0 : 1].verts.push([k, i]);
    });
    const eyeBones: THREE.Bone[] = [];
    const eyeSkin = eyePts.map((pts) => ({ index: new Uint16Array((4 * pts.length) / 3), weight: new Float32Array((4 * pts.length) / 3) }));
    for (const side of sides) {
      if (!side.verts.length) continue;
      // Flatten to one point list for this eye.
      const flat = new Float32Array(3 * side.verts.length);
      side.verts.forEach(([k, i], n) => flat.set(eyePts[k].subarray(3 * i, 3 * i + 3), 3 * n));
      const box = new THREE.Box3().setFromArray(flat);
      const size = box.getSize(new THREE.Vector3());
      const rivet = makeRivet(`eye_${side.name}`, box.getCenter(new THREE.Vector3()), 0.9 * Math.max(size.x, size.y, size.z),
        w.positions, w.indices, true);
      const { eye, gazeWeight } = makeEye(rivet, `gaze_${side.name}`, flat, side.verts.map((_, n) => n), headCenter);
      const base = eyeBones.length;
      eyeBones.push(rivet.bone, eye.gaze);
      side.verts.forEach(([k, i], n) => {
        const g = gazeWeight.get(n)!;
        eyeSkin[k].index.set([base, base + 1, 0, 0], 4 * i);
        eyeSkin[k].weight.set([1 - g, g, 0, 0], 4 * i);
      });
      this.rivets.push(rivet);
      this.eyes.push(eye);
    }
    parts.eyes.forEach((mesh, k) => this.reskin(mesh, eyeBones, eyeSkin[k].index, eyeSkin[k].weight));

    const mouthBox = new THREE.Box3();
    for (const p of parts.mouth) mouthBox.expandByPoint(new THREE.Box3().setFromArray(restPoints(p).positions).getCenter(v));
    const mouthRivet = makeRivet("mouth", mouthBox.getCenter(new THREE.Vector3()), 0.06, w.positions, w.indices, false);
    this.rivets.push(mouthRivet);
    for (const mesh of parts.mouth) {
      const n = mesh.geometry.attributes.position.count;
      this.reskin(mesh, [mouthRivet.bone], new Uint16Array(4 * n), new Float32Array(4 * n).map((_, i) => (i % 4 === 0 ? 1 : 0)));
    }

    // Morph targets shown on the GPU (everything but the soft Body).
    for (const mesh of [...parts.eyes, ...parts.mouth, ...parts.arms, ...parts.legs]) {
      const dict = mesh.morphTargetDictionary;
      if (!dict) continue;
      const slot: Partial<Record<Expression, number>> = {};
      for (const e of EXPRESSIONS) if (dict[e] !== undefined) slot[e] = dict[e];
      this.morphMeshes.push({ mesh, slot });
    }

    for (const p of [...parts.arms, ...parts.legs, ...parts.eyes, ...parts.mouth]) {
      p.frustumCulled = false;
      p.castShadow = true;
      p.receiveShadow = true;
    }

    // ---- Idle stance: arms know where the belly is, to hold it when laughing.
    this.stance = new Stance(skel, this.armRests(w.positions, w.indices));

    this.object.add(scene);
    this.render(0);
  }

  /** Bind a face mesh to its own little skeleton of rivet bones (all at identity at rest). */
  private reskin(mesh: Part, bones: THREE.Bone[], index: Uint16Array, weight: Float32Array): void {
    mesh.geometry.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(index, 4));
    mesh.geometry.setAttribute("skinWeight", new THREE.Float32BufferAttribute(weight, 4));
    mesh.bind(new THREE.Skeleton(bones, bones.map(() => new THREE.Matrix4())), mesh.matrixWorld.clone());
  }

  private armRests(rest: Float32Array, indices: Uint32Array): ArmRest[] {
    const s = this.skel;
    const pos = (n: BoneName) => new THREE.Vector3().setFromMatrixPosition(s.byName.get(n)!.restWorld);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(rest, 3));
    geo.setIndex(new THREE.BufferAttribute(indices, 1));
    const probe = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
    const ray = new THREE.Raycaster();
    const spine = s.byName.get("spine")!;
    const spineInv = spine.restWorld.clone().invert();
    const out: ArmRest[] = [];
    for (const [side, sfx] of [[1, "L"], [-1, "R"]] as const) {
      const upper = `upperarm_${sfx}` as const, fore = `forearm_${sfx}` as const, hand = `hand_${sfx}` as const;
      const from = pos("spine").add(new THREE.Vector3(0, 0.01, 0));
      ray.set(from, new THREE.Vector3(side * 0.62, -0.08, 0.78).normalize());
      const hit = ray.intersectObject(probe)[0];
      if (!hit?.face) continue;
      const n = hit.face.normal.clone();
      out.push({
        side, upper, fore, hand,
        l1: pos(upper).distanceTo(pos(fore)),
        l2: pos(fore).distanceTo(pos(hand)),
        spot: hit.point.clone().applyMatrix4(spineInv),
        normal: n.transformDirection(spineInv),
      });
    }
    geo.dispose();
    return out;
  }

  // ------------------------------------------------------------------------------------------------ contract API

  targetsFromPose(pose: PoseFrame | null, out: Map<BoneName, THREE.Matrix4>): void {
    if (pose) forwardKinematics(this.skel, (n) => pose.bones[n], pose.rootOffset, pose.rootYaw ?? 0, out);
    else this.stance.compute(this.time, this.life.out, this.lookTarget ?? this.cameraPos, out);
    for (const [name, m] of out) {
      const t = this.lastTargets.get(name);
      if (t) t.copy(m);
      else this.lastTargets.set(name, m.clone());
    }
    this.haveTargets = true;
  }

  applySim(bones: Map<BoneName, THREE.Matrix4>, body: Float32Array): void {
    if (body.length !== this.simBody.length) {
      throw new Error(`applySim: body has ${body.length / 3} vertices, the rig spec has ${this.simBody.length / 3}`);
    }
    this.simBody.set(body);
    this.haveSim.clear();
    for (const [name, m] of bones) {
      const own = this.simBones.get(name);
      if (!own) continue;
      own.copy(m);
      this.haveSim.add(name);
    }
    let x = 0, y = 0, z = 0;
    const n = body.length / 3;
    for (let i = 0; i < body.length; i += 3) (x += body[i]), (y += body[i + 1]), (z += body[i + 2]);
    this.centerPos.set(x / n, y / n, z / n);
  }

  setExpressions(w: ExpressionWeights | undefined): void {
    this.requested = w ?? {};
  }

  lookAt(target: THREE.Vector3 | null): void {
    if (!target) this.lookTarget = null;
    else (this.lookTarget ??= new THREE.Vector3()).copy(target);
  }

  react(e: FrogEvent): void {
    this.life.react(e, this.upright);
  }

  update(dt: number, camera: THREE.Camera): void {
    dt = Math.min(dt, 0.1);
    this.time += dt;
    camera.getWorldPosition(this.cameraPos);
    const life = this.life.update(dt, this.upright);
    if (this.life.mood !== this.mood) {
      const prev = this.mood;
      this.mood = this.life.mood;
      for (const cb of this.moodListeners) cb(this.mood, prev);
    }

    // Expressions: the motion's requests and the frog's own life, mouths sharing one mouth.
    const tgt = { laugh: 0, tongue: 0, blink: 0, surprise: 0 } as Record<Expression, number>;
    for (const e of EXPRESSIONS) tgt[e] = 1 - (1 - life.expr[e]) * (1 - THREE.MathUtils.clamp(this.requested[e] ?? 0, 0, 1));
    const mouth = tgt.laugh + tgt.tongue + tgt.surprise;
    if (mouth > 1) (tgt.laugh /= mouth), (tgt.tongue /= mouth), (tgt.surprise /= mouth);
    for (const e of EXPRESSIONS) {
      const cur = this.weights[e];
      // Blinks are already shaped in time; everything else eases.
      if (e === "blink") this.weights[e] = tgt[e];
      else this.weights[e] = cur + (tgt[e] - cur) * (1 - Math.exp(-(tgt[e] > cur ? ATTACK : RELEASE) * dt));
    }
    const wts = this.weights;
    for (const { mesh, slot } of this.morphMeshes) {
      const inf = mesh.morphTargetInfluences!;
      for (const e of EXPRESSIONS) {
        const i = slot[e];
        if (i === undefined) continue;
        // Laughing already squeezes the eyes shut; a blink on top must not close them twice.
        inf[i] = e === "blink" ? wts.blink * (1 - wts.laugh) : wts[e];
      }
    }

    this.render(dt);

    // Eyes look at the target (or the camera); dizzy, they roll in opposite circles.
    const target = this.lookTarget ?? this.cameraPos;
    const spin = life.gaze.spin;
    this.eyes.forEach((eye, k) => {
      const dir = k === 0 ? 1 : -1;
      const a = this.time * 2 * Math.PI * 1.3 * dir;
      aimEye(eye, target, life.gaze.yaw + 0.5 * spin * Math.cos(a), life.gaze.pitch + 0.5 * spin * Math.sin(a), 24, dt);
    });
  }

  center(out: THREE.Vector3): THREE.Vector3 {
    return out.copy(this.centerPos);
  }

  setLively(on: boolean): void {
    this.life.lively = on;
  }

  onMood(cb: (mood: Mood, prev: Mood) => void): () => void {
    this.moodListeners.add(cb);
    return () => this.moodListeners.delete(cb);
  }

  dispose(): void {
    this.object.removeFromParent();
    this.object.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) m.geometry.dispose();
      if ((o as Part).isSkinnedMesh) (o as Part).skeleton.dispose();
    });
    for (const m of this.materials) m.dispose();
    this.scene.traverse((o) => {
      const mat = (o as THREE.Mesh).material as THREE.Material | undefined;
      mat?.dispose();
    });
  }

  // ------------------------------------------------------------------------------------------------ rendering

  private _q = new THREE.Quaternion();
  private _q2 = new THREE.Quaternion();
  private _m = new THREE.Matrix4();
  private _v = new THREE.Vector3();
  private headTurn = new THREE.Quaternion();

  /** Pose the bones, deform the Body, put the face on it, tie the limb roots to it. */
  private render(_dt: number): void {
    const s = this.skel;
    // Bones the simulation does not move keep the pose's (or rest) relation to their parent.
    for (const b of s.list) {
      const world = this.boneWorld.get(b.name)!;
      if (this.haveSim.has(b.name)) world.copy(this.simBones.get(b.name)!);
      else if (b.parent) {
        const parent = this.boneWorld.get(b.parent)!;
        const t = this.haveTargets ? this.lastTargets.get(b.name) : undefined;
        const tp = this.haveTargets ? this.lastTargets.get(b.parent) : undefined;
        if (t && tp) world.copy(this._m.copy(tp).invert().multiply(t)).premultiply(parent);
        else world.compose(b.localPos, b.localQuat, b.localScale).premultiply(parent);
      } else world.copy(this.haveTargets ? this.lastTargets.get(b.name) ?? b.restWorld : b.restWorld);
      b.bone.matrixWorld.copy(world);
    }

    const head = s.byName.get("head")!;
    this.headTurn.setFromRotationMatrix(this.boneWorld.get("head")!).multiply(this._q.copy(head.restWorldQuat).invert());
    const hips = s.byName.get("hips")!;
    this._q.setFromRotationMatrix(this.boneWorld.get("hips")!).multiply(this._q2.copy(hips.restWorldQuat).invert());
    this.upright = this._v.set(0, 1, 0).applyQuaternion(this._q).y;

    this.skinBones.forEach((name, k) => {
      this.deltas[k].multiplyMatrices(this.boneWorld.get(name)!, this._m.copy(s.byName.get(name)!.restWorld).invert());
    });
    this.skin.update(this.simBody, this.deltas, this.headTurn, this.weights, this.life.out.breath);

    const P = this.skin.positions, N = this.skin.normals;
    for (const { mesh, map } of this.bodyParts) {
      const pa = mesh.geometry.attributes.position as THREE.BufferAttribute;
      const na = mesh.geometry.attributes.normal as THREE.BufferAttribute;
      const pos = pa.array as Float32Array, nor = na.array as Float32Array;
      for (let i = 0; i < map.length; i++) {
        const j = 3 * map[i];
        pos[3 * i] = P[j]; pos[3 * i + 1] = P[j + 1]; pos[3 * i + 2] = P[j + 2];
        nor[3 * i] = N[j]; nor[3 * i + 1] = N[j + 1]; nor[3 * i + 2] = N[j + 2];
      }
      pa.needsUpdate = true;
      na.needsUpdate = true;
    }

    for (const r of this.rivets) updateRivet(r, this.skin.surface, this.headTurn);

    const res = this.skin.residual;
    const v = new THREE.Vector3();
    for (const { tie, offset, toLocal } of this.limbs) {
      const o = offset.array as Float32Array;
      for (let k = 0; k < tie.vertex.length; k++) {
        const j = 3 * tie.body[k], w = tie.weight[k];
        v.set(res[j] * w, res[j + 1] * w, res[j + 2] * w).applyMatrix3(toLocal);
        o.set([v.x, v.y, v.z], 3 * tie.vertex[k]);
      }
      offset.needsUpdate = true;
    }
  }
}
