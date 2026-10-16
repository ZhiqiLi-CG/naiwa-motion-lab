/**
 * A frog skeleton + Body built to docs/character-contract.md (proportions of the first naiwa.glb), for unit tests and
 * for dev/motion.html when no GLB is there. Bones are oriented like Blender's (+Y along the bone, with a roll), so the
 * solver is tested against arbitrary bone frames, not identity ones.
 */
import * as THREE from "three";
import { MESH_NAMES, type BoneName, type RigInfo } from "../contracts";

type J = [BoneName, BoneName | null, [number, number, number], [number, number, number]];

/** name, parent, joint position, tail (world, meters). Right side mirrors the left. */
const LEFT: J[] = [
  ["upperarm_L", "chest", [0.11, 0.705, -0.005], [0.255, 0.56, 0.008]],
  ["forearm_L", "upperarm_L", [0.255, 0.56, 0.008], [0.325, 0.385, 0.04]],
  ["hand_L", "forearm_L", [0.325, 0.385, 0.04], [0.34, 0.347, 0.054]],
  ["thumb_L", "hand_L", [0.313, 0.367, 0.063], [0.3, 0.34, 0.08]],
  ["index_L", "hand_L", [0.316, 0.347, 0.054], [0.316, 0.31, 0.056]],
  ["middle_L", "hand_L", [0.34, 0.347, 0.054], [0.343, 0.31, 0.055]],
  ["ring_L", "hand_L", [0.365, 0.347, 0.054], [0.374, 0.312, 0.056]],
  ["thigh_L", "hips", [0.111, 0.318, -0.008], [0.126, 0.185, -0.012]],
  ["shin_L", "thigh_L", [0.126, 0.185, -0.012], [0.142, 0.055, -0.004]],
  ["foot_L", "shin_L", [0.142, 0.055, -0.004], [0.147, 0.02, 0.13]],
];
const JOINTS: J[] = [
  ["root", null, [0, 0, 0], [0, 0.1, 0]],
  ["hips", "root", [0, 0.31, 0], [0, 0.49, 0]],
  ["spine", "hips", [0, 0.49, 0], [0, 0.67, 0]],
  ["chest", "spine", [0, 0.67, 0], [0, 0.8, 0.035]],
  ["head", "chest", [0, 0.8, 0.035], [0, 1.0, 0.09]],
  ...LEFT,
  ...LEFT.map(([n, p, a, b]): J => [n.replace("_L", "_R") as BoneName, p && (p.replace("_L", "_R") as BoneName), [-a[0], a[1], a[2]], [-b[0], b[1], b[2]]]),
];

/** Body outline: height, half width, back and front z (rest pose). */
const PROFILE: [number, number, number, number][] = [
  [0.2, 0.02, -0.01, 0.0],
  [0.25, 0.17, -0.155, 0.143],
  [0.3, 0.213, -0.199, 0.183],
  [0.35, 0.24, -0.225, 0.21],
  [0.45, 0.256, -0.237, 0.229],
  [0.55, 0.241, -0.226, 0.21],
  [0.6, 0.229, -0.211, 0.188],
  [0.65, 0.206, -0.18, 0.155],
  [0.7, 0.177, -0.154, 0.135],
  [0.75, 0.149, -0.125, 0.132],
  [0.8, 0.127, -0.076, 0.147],
  [0.9, 0.111, -0.011, 0.167],
  [0.95, 0.094, 0.004, 0.156],
  [1.0, 0.01, 0.075, 0.085],
];

export interface TestFrog {
  object: THREE.Group;
  rig: RigInfo;
}

export function buildTestFrog(): TestFrog {
  const object = new THREE.Group();
  object.name = "NaiwaRig";
  const bones = new Map<BoneName, THREE.Bone>();
  const worldQ = new Map<BoneName, THREE.Quaternion>();
  const Y = new THREE.Vector3(0, 1, 0);
  for (const [i, [name, parent, head, tail]] of JOINTS.entries()) {
    const bone = new THREE.Bone();
    bone.name = name;
    const h = new THREE.Vector3(...head);
    const along = new THREE.Vector3(...tail).sub(h).normalize();
    // A deterministic, arbitrary roll around the bone, mirrored between the sides.
    const roll = ((i * 0.7) % 1.3) * (name.endsWith("_R") ? -1 : 1);
    const q = new THREE.Quaternion().setFromUnitVectors(Y, along).multiply(new THREE.Quaternion().setFromAxisAngle(Y, roll));
    worldQ.set(name, q);
    if (parent) {
      const pb = bones.get(parent)!;
      const pq = worldQ.get(parent)!;
      bone.position.copy(h.sub(pb.getWorldPosition(new THREE.Vector3())).applyQuaternion(pq.clone().invert()));
      bone.quaternion.copy(pq.clone().invert().multiply(q));
      pb.add(bone);
    } else {
      bone.position.copy(h);
      bone.quaternion.copy(q);
      object.add(bone);
    }
    bone.updateMatrixWorld(true);
    bones.set(name, bone);
  }
  const list = [...bones.values()];
  const skeleton = new THREE.Skeleton(list);

  // Body: a lathe through the profile, skinned rigidly by height to hips / spine / chest / head.
  const seg = 32;
  const pos: number[] = [];
  const idx: number[] = [];
  const skinIndex: number[] = [];
  const skinWeight: number[] = [];
  const owner = (y: number) => (y < 0.49 ? "hips" : y < 0.67 ? "spine" : y < 0.8 ? "chest" : "head") as BoneName;
  for (const [y, rx, z0, z1] of PROFILE) {
    const cz = (z0 + z1) / 2, rz = (z1 - z0) / 2;
    for (let k = 0; k < seg; k++) {
      const a = (k / seg) * Math.PI * 2;
      pos.push(rx * Math.sin(a), y, cz + rz * Math.cos(a));
      skinIndex.push(list.indexOf(bones.get(owner(y))!), 0, 0, 0);
      skinWeight.push(1, 0, 0, 0);
    }
  }
  for (let r = 0; r + 1 < PROFILE.length; r++)
    for (let k = 0; k < seg; k++) {
      const a = r * seg + k, b = r * seg + ((k + 1) % seg), c = a + seg, d = b + seg;
      idx.push(a, c, b, b, c, d);
    }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(skinIndex, 4));
  geo.setAttribute("skinWeight", new THREE.Float32BufferAttribute(skinWeight, 4));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const body = new THREE.SkinnedMesh(geo, new THREE.MeshStandardMaterial({ color: 0xf4c542, roughness: 0.6, transparent: true, opacity: 0.55 }));
  body.name = MESH_NAMES.body;
  object.add(body);
  object.updateMatrixWorld(true);
  body.bind(skeleton);
  return { object, rig: { skeleton, bones, height: 1.0 } };
}
