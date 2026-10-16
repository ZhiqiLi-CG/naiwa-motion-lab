/** The rendered 奶蛙 built from a contract scene (the GLB or the placeholder): rig spec, soft flesh, face and life. */
import * as THREE from "three";
import {
  EXPRESSIONS,
  MESH_NAMES,
  type BoneName,
  type Character,
  type Expression,
  type ExpressionWeights,
  type FleshRegion,
  type FrogEvent,
  type PoseFrame,
  type RigBone,
  type RigInfo,
  type RigSpec,
} from "../contracts";
import { CharacterAssetError } from "./asset";
import { aimEye, makeEye, makeRivet, updateRivet, type Eye, type Rivet } from "./face";
import { buildFlesh, showFlesh, type FleshPiece, type FleshSet } from "./flesh";
import { Life } from "./life";
import { boneExtents, findSkeleton, forwardKinematics, restPoints, type RestSkeleton } from "./rig";
import { softSkinMaterial, tieRoots, type RootTie } from "./skin";
import { Stance } from "./stance";
import type { SurfaceReport } from "./surface";

/** The character with what the contract does not cover yet (all optional to use). */
export interface NaiwaCharacter extends Character {
  /** Where it came from: the GLB, or the placeholder built in code because there was no GLB. */
  readonly source: "glb" | "placeholder";
  /** Topology of the welded Body handed to the simulation, and how many render vertices it came from. */
  readonly bodyReport: SurfaceReport & { renderVertices: number };
  /** Which limbs are soft flesh (closed shells in the asset) and, for rigid ones, why not. */
  readonly limbReport: { soft: string[]; rigid: { mesh: string; reasons: string[] }[] };
  /** Turn its own life (blinking, breathing, idle motion, the startle) on or off, e.g. for stills. */
  setLively(on: boolean): void;
}

type Part = THREE.SkinnedMesh;

/** Expression easing (1/s): quick to come, slower to go. */
const ATTACK = 22;
const RELEASE = 9;
const NO_EXPRESSION: Record<Expression, number> = { laugh: 0, tongue: 0, blink: 0, surprise: 0 };

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

const side = (c: THREE.Vector3) => (c.x >= 0 ? "L" : "R");
function bodyRegion(bone: BoneName, softness: number | undefined): FleshRegion {
  if (bone === "head") return "head";
  return softness !== undefined && softness >= 0.6 ? "belly" : "body";
}
const armRegion = (bone: BoneName): FleshRegion => (/^(hand|thumb|index|middle|ring)_/.test(bone) ? "hand" : "arm");
const legRegion = (bone: BoneName): FleshRegion => (/^foot_/.test(bone) ? "foot" : "leg");

class NaiwaFrog implements NaiwaCharacter {
  readonly object = new THREE.Group();
  readonly rig: RigInfo;
  readonly spec: RigSpec;
  readonly bodyReport: SurfaceReport & { renderVertices: number };
  readonly limbReport: { soft: string[]; rigid: { mesh: string; reasons: string[] }[] } = { soft: [], rigid: [] };

  private skel: RestSkeleton;
  private body: FleshSet;
  private softLimbs: FleshSet[] = [];
  /** Limb meshes that stay rigid skinned meshes, their roots moved with the Body on the GPU. */
  private rigidLimbs: { tie: RootTie; offset: THREE.BufferAttribute; toLocal: THREE.Matrix3 }[] = [];
  private rivets: Rivet[] = [];
  private eyes: Eye[] = [];
  private morphMeshes: { mesh: THREE.Mesh; slot: Partial<Record<Expression, number>> }[] = [];
  private life = new Life();
  private stance: Stance;
  private time = 0;

  // Latest simulated state (copied in applySim) and what the bones show.
  private simBones = new Map<BoneName, THREE.Matrix4>();
  private haveSim = new Set<BoneName>();
  private boneWorld = new Map<BoneName, THREE.Matrix4>();
  private lastTargets = new Map<BoneName, THREE.Matrix4>();
  private haveTargets = false;
  private centerPos = new THREE.Vector3();

  private requested: ExpressionWeights = {};
  private weights: Record<Expression, number> = { ...NO_EXPRESSION };
  private lookTarget: THREE.Vector3 | null = null;
  private cameraPos = new THREE.Vector3(0, 0.6, 3);
  private materials = new Set<THREE.Material>();

  constructor(
    scene: THREE.Object3D,
    readonly source: "glb" | "placeholder",
    url: string,
    skel: RestSkeleton,
    parts: Record<keyof typeof MESH_NAMES, Part[]>,
  ) {
    this.skel = skel;
    this.object.name = "Naiwa";
    const notContract = (set: FleshSet) =>
      set.pieces.flatMap((p) => p.slots).filter((n) => !skel.byName.has(n)).map((n) => `skinned to ${n}, not a contract bone`);

    // ---- The Body: one closed surface (seams welded), the flesh the simulation fills.
    const body = buildFlesh(parts.body, () => "body", bodyRegion);
    if (!body.flesh) throw new CharacterAssetError(url, body.problems.map((p) => p.replace(/^body/, "Body")));
    if (body.flesh.pieces.length !== 1) throw new CharacterAssetError(url, [`Body is ${body.flesh.pieces.length} separate pieces`]);
    if (notContract(body.flesh).length) throw new CharacterAssetError(url, notContract(body.flesh).map((p) => `Body is ${p}`));
    this.body = body.flesh;
    const bodyPiece = this.body.pieces[0];
    this.bodyReport = { ...bodyPiece.report, renderVertices: this.body.renderVertices };
    const bodyRest = bodyPiece.part.positions;
    const bodyMat = softSkinMaterial(parts.body[0].material as THREE.Material, false);
    this.materials.add(bodyMat);
    for (const m of this.body.meshes) (m.mesh.material = bodyMat), this.object.add(m.mesh);

    // ---- Limbs: soft flesh when every arm (leg) is one closed shell, else rigid skinned meshes.
    const limbPts = [...parts.arms, ...parts.legs].map((p) => restPoints(p));
    for (const [key, kind, region] of [["arms", "arm", armRegion], ["legs", "leg", legRegion]] as const) {
      const meshes = parts[key];
      const built = buildFlesh(meshes, (c) => `${kind}_${side(c)}`, region);
      const reasons = built.flesh ? notContract(built.flesh) : built.problems;
      if (built.flesh && built.flesh.pieces.length !== 2) reasons.push(`${built.flesh.pieces.length} pieces, not one per side`);
      if (built.flesh && !reasons.length) {
        const set = built.flesh;
        const mat = softSkinMaterial(meshes[0].material as THREE.Material, false);
        this.materials.add(mat);
        for (const p of set.pieces) {
          p.roots = tieRoots(p.part.positions, bodyRest, bodyPiece.skin.normals);
          this.limbReport.soft.push(p.part.name);
        }
        for (const m of set.meshes) (m.mesh.material = mat), this.object.add(m.mesh);
        this.softLimbs.push(set);
        for (const m of meshes) m.removeFromParent();
      } else {
        this.limbReport.rigid.push({ mesh: MESH_NAMES[key], reasons });
        for (const mesh of meshes) {
          const k = [...parts.arms, ...parts.legs].indexOf(mesh);
          const tie = tieRoots(limbPts[k].positions, bodyRest, bodyPiece.skin.normals);
          const offset = new THREE.BufferAttribute(new Float32Array(3 * mesh.geometry.attributes.position.count), 3);
          offset.setUsage(THREE.DynamicDrawUsage);
          mesh.geometry.setAttribute("rootOffset", offset);
          const mat = softSkinMaterial(mesh.material as THREE.Material, true);
          this.materials.add(mat);
          mesh.material = mat;
          this.rigidLimbs.push({ tie, offset, toLocal: new THREE.Matrix3().setFromMatrix4(mesh.matrixWorld).invert() });
        }
      }
    }

    // ---- Bones: the simulation writes their world matrices; local transforms stay at rest for retargeting.
    for (const b of skel.list) {
      b.bone.matrixWorldAutoUpdate = false;
      this.boneWorld.set(b.name, b.restWorld.clone());
      this.simBones.set(b.name, b.restWorld.clone());
    }
    let lo = Infinity, hi = -Infinity;
    for (const p of [bodyRest, ...limbPts.map((l) => l.positions)]) {
      for (let i = 1; i < p.length; i += 3) (lo = Math.min(lo, p[i])), (hi = Math.max(hi, p[i]));
    }
    this.rig = { skeleton: parts.arms[0].skeleton, bones: new Map(skel.list.map((b) => [b.name, b.bone])), height: hi - lo };

    // ---- Rig spec for the simulation.
    const ext = boneExtents(skel, [restPoints(parts.body[0]), ...limbPts]);
    const bones: RigBone[] = skel.list.map((b) => ({
      name: b.name, parent: b.parent, restWorld: b.restWorld.clone(),
      tail: ext.get(b.name)!.tail, radius: ext.get(b.name)!.radius,
    }));
    const copy = (p: FleshPiece) => ({
      ...p.part, positions: p.part.positions.slice(), indices: p.part.indices.slice(),
      softness: p.part.softness?.slice(), regions: p.part.regions?.slice(), bones: [...p.part.bones],
    });
    const limbs = this.softLimbs.flatMap((s) => s.pieces.map(copy));
    this.spec = { bones, body: copy(bodyPiece), ...(limbs.length ? { limbs } : {}) };
    for (const p of parts.body) {
      p.removeFromParent();
      p.geometry.dispose();
    }

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
    const bodyIdx = bodyPiece.part.indices;
    for (const s of sides) {
      if (!s.verts.length) continue;
      const flat = new Float32Array(3 * s.verts.length);
      s.verts.forEach(([k, i], n) => flat.set(eyePts[k].subarray(3 * i, 3 * i + 3), 3 * n));
      const box = new THREE.Box3().setFromArray(flat);
      const size = box.getSize(new THREE.Vector3());
      const rivet = makeRivet(`eye_${s.name}`, box.getCenter(new THREE.Vector3()), 0.9 * Math.max(size.x, size.y, size.z),
        bodyRest, bodyIdx, true);
      const { eye, gazeWeight } = makeEye(rivet, `gaze_${s.name}`, flat, s.verts.map((_, n) => n), headCenter);
      const base = eyeBones.length;
      eyeBones.push(rivet.bone, eye.gaze);
      s.verts.forEach(([k, i], n) => {
        const g = gazeWeight.get(n)!;
        eyeSkin[k].index.set([base, base + 1, 0, 0], 4 * i);
        eyeSkin[k].weight.set([1 - g, g, 0, 0], 4 * i);
      });
      this.rivets.push(rivet);
      this.eyes.push(eye);
    }
    parts.eyes.forEach((mesh, k) => this.reskin(mesh, eyeBones, eyeSkin[k].index, eyeSkin[k].weight));

    const mouthBox = new THREE.Box3();
    for (const p of parts.mouth) mouthBox.union(new THREE.Box3().setFromArray(restPoints(p).positions));
    const mouthRivet = makeRivet("mouth", mouthBox.getCenter(new THREE.Vector3()), 0.06, bodyRest, bodyIdx, false);
    this.rivets.push(mouthRivet);
    for (const mesh of parts.mouth) {
      const n = mesh.geometry.attributes.position.count;
      this.reskin(mesh, [mouthRivet.bone], new Uint16Array(4 * n), new Float32Array(4 * n).map((_, i) => (i % 4 === 0 ? 1 : 0)));
    }

    // Morph targets shown on the GPU (everything but the soft flesh).
    for (const mesh of [...parts.eyes, ...parts.mouth, ...parts.arms, ...parts.legs]) {
      const dict = mesh.morphTargetDictionary;
      if (!dict || !mesh.parent) continue;
      const slot: Partial<Record<Expression, number>> = {};
      for (const e of EXPRESSIONS) if (dict[e] !== undefined) slot[e] = dict[e];
      this.morphMeshes.push({ mesh, slot });
    }
    scene.traverse((o) => {
      if (!(o as THREE.Mesh).isMesh) return;
      o.frustumCulled = false;
      o.castShadow = o.receiveShadow = true;
    });

    this.stance = new Stance(skel);

    this.object.add(scene);
    this.render();
  }

  /** Bind a face mesh to its own little skeleton of rivet bones (all at identity at rest). */
  private reskin(mesh: Part, bones: THREE.Bone[], index: Uint16Array, weight: Float32Array): void {
    mesh.geometry.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(index, 4));
    mesh.geometry.setAttribute("skinWeight", new THREE.Float32BufferAttribute(weight, 4));
    mesh.bind(new THREE.Skeleton(bones, bones.map(() => new THREE.Matrix4())), mesh.matrixWorld.clone());
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

  applySim(bones: Map<BoneName, THREE.Matrix4>, body: Float32Array, limbs?: Map<string, Float32Array>): void {
    const bp = this.body.pieces[0];
    if (body.length !== bp.sim.length) {
      throw new Error(`applySim: body has ${body.length / 3} vertices, the rig spec has ${bp.sim.length / 3}`);
    }
    bp.sim.set(body);
    bp.simulated = true;
    for (const set of this.softLimbs) {
      for (const p of set.pieces) {
        const l = limbs?.get(p.part.name);
        p.simulated = !!l && l.length === p.sim.length;
        if (p.simulated) p.sim.set(l!);
      }
    }
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
    this.life.react(e);
  }

  update(dt: number, camera: THREE.Camera): void {
    dt = Math.min(dt, 0.1);
    this.time += dt;
    camera.getWorldPosition(this.cameraPos);
    const life = this.life.update(dt);

    // Expressions: the motion's requests and the frog's own life, the mouth shapes sharing one mouth.
    const tgt = { ...NO_EXPRESSION };
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

    this.render();

    // Eyes look at the target (or the camera).
    const target = this.lookTarget ?? this.cameraPos;
    for (const eye of this.eyes) aimEye(eye, target, life.gaze.yaw, life.gaze.pitch, 24, dt);
  }

  center(out: THREE.Vector3): THREE.Vector3 {
    return out.copy(this.centerPos);
  }

  setLively(on: boolean): void {
    this.life.lively = on;
  }

  dispose(): void {
    this.object.removeFromParent();
    this.object.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.geometry.dispose();
        (m.material as THREE.Material).dispose();
      }
      if ((o as Part).isSkinnedMesh) (o as Part).skeleton.dispose();
    });
    for (const m of this.materials) m.dispose();
  }

  // ------------------------------------------------------------------------------------------------ rendering

  private _q = new THREE.Quaternion();
  private _m = new THREE.Matrix4();
  private _v = new THREE.Vector3();
  private headTurn = new THREE.Quaternion();

  /** Pose the bones, deform the flesh, put the face on it, tie the limb roots to it. */
  private render(): void {
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

    const deform = (p: FleshPiece, weights: Record<Expression, number>, breath: number, tie?: { roots: RootTie; residual: Float32Array }) => {
      p.slots.forEach((name, k) => {
        p.deltas[k].multiplyMatrices(this.boneWorld.get(name)!, this._m.copy(s.byName.get(name)!.restWorld).invert());
      });
      p.skin.update(p.simulated ? p.sim : null, p.deltas, this.headTurn, weights, breath, tie);
    };
    const body = this.body.pieces[0];
    deform(body, this.weights, this.life.out.breath);
    showFlesh(this.body);
    const residual = body.skin.residual;
    for (const set of this.softLimbs) {
      for (const p of set.pieces) deform(p, NO_EXPRESSION, 0, { roots: p.roots!, residual });
      showFlesh(set);
    }

    for (const r of this.rivets) updateRivet(r, body.skin.surface, this.headTurn);

    const v = this._v;
    for (const { tie, offset, toLocal } of this.rigidLimbs) {
      const o = offset.array as Float32Array;
      for (let k = 0; k < tie.vertex.length; k++) {
        const j = 3 * tie.body[k], w = tie.weight[k];
        v.set(residual[j] * w, residual[j + 1] * w, residual[j + 2] * w).applyMatrix3(toLocal);
        o[3 * tie.vertex[k]] = v.x;
        o[3 * tie.vertex[k] + 1] = v.y;
        o[3 * tie.vertex[k] + 2] = v.z;
      }
      offset.needsUpdate = true;
    }
  }
}
