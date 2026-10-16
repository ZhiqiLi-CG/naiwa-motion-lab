/** The contract skeleton found in a loaded scene: rest transforms, forward kinematics, tails and flesh radii. */
import * as THREE from "three";
import { CORE_BONES, FINGER_BONES, type BoneName } from "../contracts";

const ALL_BONES: readonly BoneName[] = [...CORE_BONES, ...FINGER_BONES];
const CONTRACT_PARENT: Record<BoneName, BoneName | null> = {
  root: null, hips: "root", spine: "hips", chest: "spine", head: "chest",
  upperarm_L: "chest", forearm_L: "upperarm_L", hand_L: "forearm_L",
  upperarm_R: "chest", forearm_R: "upperarm_R", hand_R: "forearm_R",
  thigh_L: "hips", shin_L: "thigh_L", foot_L: "shin_L",
  thigh_R: "hips", shin_R: "thigh_R", foot_R: "shin_R",
  thumb_L: "hand_L", index_L: "hand_L", middle_L: "hand_L", ring_L: "hand_L",
  thumb_R: "hand_R", index_R: "hand_R", middle_R: "hand_R", ring_R: "hand_R",
};
/** The child joint that ends each bone (the chain the bone belongs to). */
const MAIN_CHILD: Partial<Record<BoneName, BoneName>> = {
  root: "hips", hips: "spine", spine: "chest", chest: "head",
  upperarm_L: "forearm_L", forearm_L: "hand_L", hand_L: "middle_L",
  upperarm_R: "forearm_R", forearm_R: "hand_R", hand_R: "middle_R",
  thigh_L: "shin_L", shin_L: "foot_L", thigh_R: "shin_R", shin_R: "foot_R",
};

export interface RestBone {
  name: BoneName;
  parent: BoneName | null;
  bone: THREE.Bone;
  /** Rest local transform (relative to the parent bone, or to the armature for root). */
  localPos: THREE.Vector3;
  localQuat: THREE.Quaternion;
  localScale: THREE.Vector3;
  restWorld: THREE.Matrix4;
  restWorldQuat: THREE.Quaternion;
}

export interface RestSkeleton {
  /** Bones in parent-before-child order. */
  list: RestBone[];
  byName: Map<BoneName, RestBone>;
  /** World matrix of root's parent (the armature object) at rest. */
  armatureWorld: THREE.Matrix4;
}

/** Find the contract bones under scene (already updateMatrixWorld'ed) and check their hierarchy. */
export function findSkeleton(scene: THREE.Object3D, problems: string[]): RestSkeleton | null {
  const found = new Map<string, THREE.Bone>();
  scene.traverse((o) => {
    if ((o as THREE.Bone).isBone) found.set(o.name, o as THREE.Bone);
  });
  const missing = CORE_BONES.filter((n) => !found.has(n));
  if (missing.length) {
    problems.push(`missing bones: ${missing.join(", ")}`);
    return null;
  }
  const list: RestBone[] = [];
  for (const name of ALL_BONES) {
    const bone = found.get(name);
    if (!bone) continue;
    const parent = CONTRACT_PARENT[name];
    if (parent && bone.parent !== found.get(parent)) {
      problems.push(`bone ${name} should be a child of ${parent}, not of ${bone.parent?.name || "nothing"}`);
    }
    const restWorld = bone.matrixWorld.clone();
    list.push({
      name, parent, bone,
      localPos: bone.position.clone(), localQuat: bone.quaternion.clone(), localScale: bone.scale.clone(),
      restWorld, restWorldQuat: new THREE.Quaternion().setFromRotationMatrix(restWorld),
    });
  }
  const root = found.get("root")!;
  const armatureWorld = root.parent ? root.parent.matrixWorld.clone() : new THREE.Matrix4();
  return { list, byName: new Map(list.map((b) => [b.name, b])), armatureWorld };
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _yaw = new THREE.Matrix4();

/**
 * Forward kinematics of the rest skeleton: each bone's local rotation is local(name) (or its rest rotation when that
 * returns undefined); the whole frog is turned by yaw around +Y at home and moved by offset. Writes world matrices.
 */
export function forwardKinematics(
  skel: RestSkeleton,
  local: (name: BoneName) => THREE.Quaternion | undefined,
  offset: THREE.Vector3 | undefined,
  yaw: number,
  out: Map<BoneName, THREE.Matrix4>,
): void {
  for (const b of skel.list) {
    let m = out.get(b.name);
    if (!m) out.set(b.name, (m = new THREE.Matrix4()));
    m.compose(b.localPos, local(b.name) ?? b.localQuat, b.localScale);
    if (b.parent) m.premultiply(out.get(b.parent)!);
    else {
      m.premultiply(skel.armatureWorld);
      if (yaw) m.premultiply(_yaw.makeRotationY(yaw));
      if (offset) m.premultiply(_m.makeTranslation(offset.x, offset.y, offset.z));
    }
  }
}

/**
 * A rotation given in world axes for a bone whose parents are at rest, as the local rotation that produces it:
 * local = rest local · (rest world⁻¹ · delta · rest world). Composes along the chain like the rest frames do.
 */
export function worldDeltaToLocal(b: RestBone, delta: THREE.Quaternion, out: THREE.Quaternion): THREE.Quaternion {
  _q.copy(b.restWorldQuat).invert().multiply(delta).multiply(b.restWorldQuat);
  return out.copy(b.localQuat).multiply(_q);
}

/** Per-vertex dominant bone of skinned geometry and the vertex world positions at rest. */
export interface WeightedPoints {
  positions: Float32Array;
  /** Index into skeleton.bones of the largest weight. */
  dominant: Int32Array;
  bones: THREE.Bone[];
}

export function restPoints(mesh: THREE.SkinnedMesh): WeightedPoints {
  const g = mesh.geometry;
  const n = g.attributes.position.count;
  const positions = new Float32Array(3 * n);
  const dominant = new Int32Array(n);
  const si = g.attributes.skinIndex, sw = g.attributes.skinWeight;
  const v = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    mesh.getVertexPosition(i, v).applyMatrix4(mesh.matrixWorld);
    positions.set([v.x, v.y, v.z], 3 * i);
    let best = 0;
    for (let k = 1; k < 4; k++) if (sw.getComponent(i, k) > sw.getComponent(i, best)) best = k;
    dominant[i] = si.getComponent(i, best);
  }
  return { positions, dominant, bones: mesh.skeleton.bones };
}

/**
 * Tails and flesh radii of the bones from the skinned geometry around them: a bone ends at its chain child's joint,
 * an end bone at the farthest point of its own vertices along its +Y axis; the radius is the median distance of the
 * vertices it dominates from its segment (0 for bones without flesh, such as root).
 */
export function boneExtents(
  skel: RestSkeleton,
  meshes: WeightedPoints[],
): Map<BoneName, { tail: THREE.Vector3; radius: number }> {
  const points = new Map<THREE.Bone, number[]>();
  for (const m of meshes) {
    for (let i = 0; i < m.dominant.length; i++) {
      const bone = m.bones[m.dominant[i]];
      let arr = points.get(bone);
      if (!arr) points.set(bone, (arr = []));
      arr.push(m.positions[3 * i], m.positions[3 * i + 1], m.positions[3 * i + 2]);
    }
  }
  const out = new Map<BoneName, { tail: THREE.Vector3; radius: number }>();
  const head = new THREE.Vector3(), axis = new THREE.Vector3(), p = new THREE.Vector3(), c = new THREE.Vector3();
  for (const b of skel.list) {
    head.setFromMatrixPosition(b.restWorld);
    const pts = points.get(b.bone) ?? [];
    const child = MAIN_CHILD[b.name];
    const childBone = child && skel.byName.get(child);
    let tail: THREE.Vector3;
    if (childBone) tail = new THREE.Vector3().setFromMatrixPosition(childBone.restWorld);
    else {
      axis.setFromMatrixColumn(b.restWorld, 1).normalize();
      let reach = 0;
      for (let i = 0; i < pts.length; i += 3) reach = Math.max(reach, p.fromArray(pts, i).sub(head).dot(axis));
      if (reach === 0) {
        // No flesh of its own: half the parent's length.
        const parent = b.parent ? out.get(b.parent) : undefined;
        const parentHead = b.parent ? new THREE.Vector3().setFromMatrixPosition(skel.byName.get(b.parent)!.restWorld) : head;
        reach = parent ? parent.tail.distanceTo(parentHead) * 0.5 : 0.05;
      }
      tail = head.clone().addScaledVector(axis, reach);
    }
    const seg = new THREE.Line3(head.clone(), tail);
    const d: number[] = [];
    for (let i = 0; i < pts.length; i += 3) d.push(seg.closestPointToPoint(p.fromArray(pts, i), true, c).distanceTo(p));
    d.sort((x, y) => x - y);
    out.set(b.name, { tail, radius: d.length ? d[d.length >> 1] : 0 });
  }
  return out;
}
