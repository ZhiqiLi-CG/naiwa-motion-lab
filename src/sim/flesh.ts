/**
 * One closed piece of soft flesh (the Body, an arm, a leg) as a Rapier volumetric soft body: cells fill the surface,
 * the deep particles ride on the part's bones, a coarse copy of the surface embedded in the cells collides, and one
 * cluster per region carries that region's softness.
 */
import RAPIER from "@dimforge/rapier3d-compat";
import * as THREE from "three";
import { FLESH_REGIONS, type FleshRegion } from "../contracts";
import { TriMesh, coarseSkin, segmentDistance } from "./geometry";
import type { Bone } from "./skeleton";

export interface FleshInput {
  name: string;
  positions: Float32Array;
  indices: Uint32Array;
  softness?: Float32Array;
  regions?: Uint8Array;
  bones: Bone[];
}

/** How a part is built: the knobs the dev page compares. */
export interface FleshTuning {
  /** Particles to aim for (the cell size follows). */
  particles: number;
  mass: number;
  cellModel: RAPIER.SoftBodyCellModel;
  shapeMatching: boolean;
  volumePreservation: boolean;
  pgsIterations: number;
  /** Free flesh over the attached core, metres: at softness 0 and its growth up to softness 1. */
  depth: number;
  depthSoft: number;
  collisionGroups: number;
}

export const REGION_SOFTNESS: Record<FleshRegion, number> = {
  belly: 1, body: 0.55, head: 0.35, arm: 0.5, hand: 0.15, leg: 0.45, foot: 0.1,
};

export class Flesh {
  readonly name: string;
  readonly soft: RAPIER.SoftBody;
  readonly collider: RAPIER.Collider;
  readonly bones: Bone[];
  readonly rest: Float32Array;
  /** Free (unattached) particles, the bone each would ride with and its rest offset in that bone's frame. */
  readonly free: number[] = [];
  readonly freeBone: Bone[] = [];
  readonly freeOffset: THREE.Vector3[] = [];
  /** Region of each visual vertex (index into FLESH_REGIONS). */
  readonly vertexRegion: Uint8Array;
  /** Cluster index of each region present. */
  readonly clusters = new Map<FleshRegion, number>();
  readonly cellSize: number;
  readonly out: Float32Array;

  constructor(world: RAPIER.World, input: FleshInput, tuning: FleshTuning, material: RAPIER.SoftBodyMaterial) {
    this.name = input.name;
    this.bones = input.bones;
    const surface = new TriMesh(input.positions, input.indices);
    this.vertexRegion = input.regions ?? deriveRegions(input);
    this.cellSize = cellSizeFor(input, tuning.particles);
    const desc = RAPIER.SoftBodyDesc.volumetric(input.positions, input.indices, this.cellSize, true);
    if (!desc) throw new Error(`sim: ${input.name} cannot be filled with cells (is it closed?)`);
    desc
      .setNoSurfaceCollider()
      .setMass(tuning.mass)
      .setParticleRadius(0.008)
      .setCellModel(tuning.cellModel)
      .setShapeMatching(tuning.shapeMatching)
      .setVolumePreservation(tuning.volumePreservation)
      .setAdditionalPgsIterations(tuning.pgsIterations)
      .setMaterial(material);
    this.soft = world.createSoftBody(desc);
    this.rest = this.soft.particlePositions();

    const skin = coarseSkin(surface, this.rest, this.soft.boundary());
    const proxy = this.soft.rootBody();
    const o = proxy.translation();
    for (let i = 0; i < skin.positions.length; i += 3) {
      skin.positions[i] -= o.x;
      skin.positions[i + 1] -= o.y;
      skin.positions[i + 2] -= o.z;
    }
    const skinDesc = RAPIER.ColliderDesc.trimesh(
      skin.positions, skin.indices, RAPIER.TriMeshFlags.DEFORMABLE | RAPIER.TriMeshFlags.ORIENTED,
    );
    if (!skinDesc) throw new Error(`sim: no collision skin for ${input.name}`);
    skinDesc.setDensity(0).setFriction(0.8).setRestitution(0.1).setCollisionGroups(tuning.collisionGroups);
    const collider = world.createDeformableCollider(skinDesc, RAPIER.SoftMeshBinding.skinned(), proxy);
    if (!collider) throw new Error(`sim: the collision skin of ${input.name} cannot be bound`);
    this.collider = collider;

    const particleRegion = this.attach(surface, input, tuning);
    for (const region of FLESH_REGIONS) {
      const ids: number[] = [];
      particleRegion.forEach((r, i) => r === FLESH_REGIONS.indexOf(region) && ids.push(i));
      if (!ids.length) continue;
      const c = world.addSoftBodyCluster(this.soft, ids);
      if (c !== null) this.clusters.set(region, c);
    }
    this.out = new Float32Array(input.positions.length);
  }

  /** Deep particles ride on the nearest of the part's bones, and so do those along the bones (thin limbs have few deep
   *  ones); the flesh over them is free, thickest where the part is softest. Particles next to a joint between two of
   *  the part's bones stay free so the flesh can fold there. Returns each particle's region. */
  private attach(surface: TriMesh, input: FleshInput, tuning: FleshTuning): Uint8Array {
    const n = this.soft.numParticles();
    const P = this.rest, V = input.positions, soft = input.softness;
    const region = new Uint8Array(n);
    const joints = this.bones.filter((b) => b.parent && this.bones.includes(b.parent)).map((b) => b.restPos);
    const p = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      p.set(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]);
      let nearestVertex = 0, best = Infinity;
      for (let v = 0; v < V.length / 3; v++) {
        const d = (V[v * 3] - p.x) ** 2 + (V[v * 3 + 1] - p.y) ** 2 + (V[v * 3 + 2] - p.z) ** 2;
        if (d < best) {
          best = d;
          nearestVertex = v;
        }
      }
      region[i] = this.vertexRegion[nearestVertex];
      const softness = soft ? soft[nearestVertex] : REGION_SOFTNESS[FLESH_REGIONS[region[i]]];
      let bone = this.bones[0], bd = Infinity;
      for (const b of this.bones) {
        const d = segmentDistance(p, b.restPos, b.tail);
        if (d < bd) {
          bd = d;
          bone = b;
        }
      }
      const depth = -surface.signedDistance(p.x, p.y, p.z);
      const nearJoint = joints.some((j) => j.distanceTo(p) < 0.35 * this.cellSize);
      const deep = depth > tuning.depth + tuning.depthSoft * softness || bd < 0.45 * this.cellSize;
      if (deep && !nearJoint) {
        this.soft.attachParticle(i, bone.body);
      } else {
        this.free.push(i);
        this.freeBone.push(bone);
        this.freeOffset.push(p.clone().applyMatrix4(bone.restInverse));
      }
    }
    return region;
  }

  /** Where its bones would carry the free flesh, against where it is: mean distance (m), how much it jiggles. */
  deformation(P = this.soft.particlePositions()): number {
    const poses = new Map<Bone, THREE.Matrix4>();
    const p = new THREE.Vector3();
    let sum = 0;
    this.free.forEach((i, k) => {
      const b = this.freeBone[k];
      let m = poses.get(b);
      if (!m) poses.set(b, (m = b.pose(new THREE.Matrix4())));
      p.copy(this.freeOffset[k]).applyMatrix4(m);
      sum += Math.hypot(P[i * 3] - p.x, P[i * 3 + 1] - p.y, P[i * 3 + 2] - p.z);
    });
    return sum / Math.max(1, this.free.length);
  }

  /** Impulse on the free flesh around a point, fading smoothly to nothing at radius (no single-particle spikes). */
  push(point: THREE.Vector3, dv: THREE.Vector3, radius: number) {
    const P = this.soft.particlePositions();
    for (const i of this.free) {
      const d = Math.hypot(P[i * 3] - point.x, P[i * 3 + 1] - point.y, P[i * 3 + 2] - point.z) / radius;
      if (d >= 1) continue;
      const m = this.soft.particleMass(i) * (1 - d * d) ** 2;
      this.soft.applyParticleImpulse(i, { x: dv.x * m, y: dv.y * m, z: dv.z * m }, true);
    }
  }

  /** Free particles nearest to a point: at least three, all within radius, at most eight. */
  nearestFree(point: THREE.Vector3, radius: number): number[] {
    const P = this.soft.particlePositions();
    return this.free
      .map((i) => ({ i, d: Math.hypot(P[i * 3] - point.x, P[i * 3 + 1] - point.y, P[i * 3 + 2] - point.z) }))
      .sort((a, b) => a.d - b.d)
      .filter((n, k) => k < 3 || n.d < radius)
      .slice(0, 8)
      .map((n) => n.i);
  }

  /** Region at a world point on the deformed surface. */
  regionAt(point: THREE.Vector3): FleshRegion {
    const V = this.read();
    let best = Infinity, region = 0;
    for (let v = 0; v < V.length / 3; v++) {
      const d = (V[v * 3] - point.x) ** 2 + (V[v * 3 + 1] - point.y) ** 2 + (V[v * 3 + 2] - point.z) ** 2;
      if (d < best) {
        best = d;
        region = this.vertexRegion[v];
      }
    }
    return FLESH_REGIONS[region];
  }

  /** The deformed visual surface (the skin Rapier embeds in the cells), in the input's vertex order. */
  read(): Float32Array {
    this.out.set(this.soft.meshVertices(0));
    return this.out;
  }

  reset() {
    const P = this.rest;
    for (let i = 0; i < P.length / 3; i++) {
      this.soft.setParticlePosition(i, { x: P[i * 3], y: P[i * 3 + 1], z: P[i * 3 + 2] });
      this.soft.setParticleVelocity(i, { x: 0, y: 0, z: 0 });
    }
    this.soft.wakeUp();
  }
}


/** The cell size that gives about the wanted number of particles (the lattice covers the surface, so thin parts get
 *  relatively more): a few trial meshings. */
function cellSizeFor(input: FleshInput, particles: number): number {
  const volume = new TriMesh(input.positions, input.indices).volume();
  let cs = Math.cbrt((4.7 * volume) / particles);
  for (let k = 0; k < 4; k++) {
    const n = RAPIER.SoftBodyDesc.volumetric(input.positions, input.indices, cs, false)?.numParticles() ?? 0;
    if (Math.abs(n - particles) < 0.08 * particles) break;
    cs *= Math.cbrt(Math.max(n, 1) / particles);
  }
  return cs;
}

/** Regions when the asset gives none: by the nearest bone (head, hand, foot), the belly from softness. */
function deriveRegions(input: FleshInput): Uint8Array {
  const V = input.positions, out = new Uint8Array(V.length / 3);
  const p = new THREE.Vector3();
  for (let v = 0; v < out.length; v++) {
    p.set(V[v * 3], V[v * 3 + 1], V[v * 3 + 2]);
    let bone = input.bones[0], bd = Infinity;
    for (const b of input.bones) {
      const d = segmentDistance(p, b.restPos, b.tail);
      if (d < bd) {
        bd = d;
        bone = b;
      }
    }
    let r: FleshRegion = "body";
    if (bone.name === "head") r = "head";
    else if (/hand/.test(bone.name)) r = "hand";
    else if (/foot/.test(bone.name)) r = "foot";
    else if (/arm/.test(bone.name)) r = "arm";
    else if (/thigh|shin/.test(bone.name)) r = "leg";
    else if ((input.softness?.[v] ?? 0) > 0.6) r = "belly";
    out[v] = FLESH_REGIONS.indexOf(r);
  }
  return out;
}
