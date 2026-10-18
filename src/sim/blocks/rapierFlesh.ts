/**
 * Flesh block: each part as a Rapier volumetric soft body (cells filling the closed surface, solved by Rapier's
 * constraint solver), one cluster per region carrying that region's softness, and a coarse copy of the surface
 * embedded in the cells as its collider. Rapier resolves those contacts in the same solve, so this block covers the
 * collision slot.
 *
 * Limb flesh rides whole on its bones (the coupling attaches all of it), so by default it is not solved but carried:
 * the same lattice, each particle moved rigidly by its bone, the surface embedded in the cells as Rapier embeds it (so
 * it bends across the joints the same way), its mass and a convex collider per bone on the bones themselves. Solved,
 * its particles stayed within half a millimetre of those positions while it cost a third of the physics step.
 */
import RAPIER from "@dimforge/rapier3d-compat";
import * as THREE from "three";
import { FLESH_REGIONS, type FleshRegion, type PhysicsParams } from "../../contracts";
import type { BlockDefinition, FleshBlock, ParticleView, Scene, Settings, SimBone, SimPart } from "../api";
import { TriMesh, coarseSkin } from "../geometry";
import { REGION_SOFTNESS, nearestBone, particleAttributes } from "../parts";
import { limbFlesh } from "./skeleton";

/** kg/m³: a 1 m frog of about 15 kg (a big plush toy, not a pond of water). */
const DENSITY = 190;
const CELL_MODELS: Record<string, RAPIER.SoftBodyCellModel> = {
  volume: RAPIER.SoftBodyCellModel.Volume,
  corotational: RAPIER.SoftBodyCellModel.Corotational,
  neohookean: RAPIER.SoftBodyCellModel.NeoHookean,
};

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const lerpLog = (a: number, b: number, t: number) => a * Math.pow(b / a, t);

/** Softness sets how fast the flesh springs back (Hz), bounciness how little it is damped. */
function spring(p: PhysicsParams) {
  return { f: lerpLog(14, 3, clamp01(p.softness)), z: lerpLog(0.9, 0.06, clamp01(p.bounciness)) };
}

function material(p: PhysicsParams): RAPIER.SoftBodyMaterial {
  const { f, z } = spring(p);
  const m = new RAPIER.SoftBodyMaterial();
  // The elastic cell models: 20 kPa (firm jelly) down to 2 kPa, nearly incompressible like flesh.
  m.youngModulus = 20000 * Math.pow(0.1, clamp01(p.softness));
  m.poissonRatio = 0.4;
  m.elasticDampingRatio = z;
  m.edgeSoftness = { naturalFrequency: f, dampingRatio: z };
  m.bendSoftness = { naturalFrequency: f, dampingRatio: z };
  m.volumeSoftness = { naturalFrequency: f * 2, dampingRatio: z };
  m.shapeMatchingSoftness = { naturalFrequency: f, dampingRatio: z };
  return m;
}

/** What the flesh block keeps of each part: its particles, surface, cells and volume. */
interface FleshPiece extends ParticleView {
  readonly soft: RAPIER.SoftBody | null;
  surface(): Float32Array;
  cells(): Uint32Array;
  volumeRatio(): number;
  addVelocity(dv: THREE.Vector3): void;
  afterStep?(): void;
  setParams(p: PhysicsParams): void;
  reset(): void;
}

/** One part's soft body, and what the other blocks see of it. */
class Piece implements FleshPiece {
  readonly soft: RAPIER.SoftBody;
  readonly count: number;
  readonly rest: Float32Array;
  private clusters = new Map<FleshRegion, number>();
  private attachedBody = new Map<number, RAPIER.RigidBody>();
  private out: Float32Array;

  constructor(scene: Scene, readonly part: SimPart, settings: Readonly<Settings>) {
    const surface = new TriMesh(part.positions, part.indices);
    const particles = Number(part.limb ? settings.limbParticles : settings.bodyParticles);
    const desc = RAPIER.SoftBodyDesc.volumetric(part.positions, part.indices, cellSizeFor(part, surface, particles), true);
    if (!desc) throw new Error(`sim: ${part.name} cannot be filled with cells (is it closed?)`);
    desc
      .setNoSurfaceCollider()
      .setMass(DENSITY * surface.volume())
      .setParticleRadius(0.008)
      .setCellModel(CELL_MODELS[String(settings.cellModel)] ?? RAPIER.SoftBodyCellModel.Volume)
      .setShapeMatching(false)
      .setVolumePreservation(Boolean(settings.volumePreservation))
      .setAdditionalPgsIterations(Number(settings.iterations))
      .setMaterial(material(scene.params));
    this.soft = scene.world.createSoftBody(desc);
    this.count = this.soft.numParticles();
    this.rest = this.soft.particlePositions();
    this.out = new Float32Array(part.positions.length);

    // The collider: a coarse skin over the lattice, bound to the cells (relative to the soft body's proxy).
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
    if (!skinDesc) throw new Error(`sim: no collision skin for ${part.name}`);
    skinDesc.setDensity(0).setFriction(0.8).setRestitution(0.1)
      .setCollisionGroups(part.limb ? scene.collisionGroups.limb : scene.collisionGroups.body)
      .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
    const collider = scene.world.createDeformableCollider(skinDesc, RAPIER.SoftMeshBinding.skinned(), proxy);
    if (!collider) throw new Error(`sim: the collision skin of ${part.name} cannot be bound`);
    scene.registerCollider(collider, part);

    const { region } = particleAttributes(part, this.rest);
    FLESH_REGIONS.forEach((name, r) => {
      const ids: number[] = [];
      region.forEach((pr, i) => pr === r && ids.push(i));
      const c = ids.length ? scene.world.addSoftBodyCluster(this.soft, ids) : null;
      if (c !== null) this.clusters.set(name, c);
    });
  }

  positions() {
    return this.soft.particlePositions();
  }
  mass(i: number) {
    return this.soft.particleMass(i);
  }
  applyImpulse(i: number, x: number, y: number, z: number) {
    this.soft.applyParticleImpulse(i, { x, y, z }, true);
  }
  setPosition(i: number, x: number, y: number, z: number) {
    this.soft.setParticlePosition(i, { x, y, z });
  }
  setVelocity(i: number, x: number, y: number, z: number) {
    this.soft.setParticleVelocity(i, { x, y, z });
  }
  attach(i: number, body: RAPIER.RigidBody) {
    this.soft.attachParticle(i, body);
    this.attachedBody.set(i, body);
  }
  detach(i: number) {
    this.soft.detachParticle(i);
    this.attachedBody.delete(i);
  }
  attachedTo(i: number) {
    return this.attachedBody.get(i) ?? null;
  }

  /** The visual surface Rapier embeds in the cells, in the part's vertex order. */
  surface() {
    this.out.set(this.soft.meshVertices(0));
    return this.out;
  }

  cells() {
    return this.soft.cells();
  }

  volumeRatio() {
    return this.soft.volume() / this.soft.restVolume();
  }

  addVelocity(dv: THREE.Vector3) {
    // Particle by particle: SoftBody.applyImpulse gives the whole impulse to every particle.
    const V = this.soft.particleVelocities();
    for (let i = 0; i < this.count; i++) {
      this.soft.setParticleVelocity(i, { x: V[i * 3] + dv.x, y: V[i * 3 + 1] + dv.y, z: V[i * 3 + 2] + dv.z });
    }
    this.soft.wakeUp();
  }

  setParams(p: PhysicsParams) {
    const { f, z } = spring(p);
    this.soft.setMaterial(material(p));
    for (const [region, c] of this.clusters) {
      const r = clamp01(p.regionSoftness?.[region] ?? REGION_SOFTNESS[region]);
      // The softest region springs at the slider's rate, firm ones up to 2.5 times faster.
      this.soft.setClusterEdgeSoftness(c, { naturalFrequency: f * lerpLog(2.5, 1, r), dampingRatio: z });
    }
    if (!this.part.limb) this.soft.setVolumeFactor(Math.min(2, Math.max(0.5, p.bellySize)));
    this.soft.wakeUp();
  }

  reset() {
    const P = this.rest;
    for (let i = 0; i < this.count; i++) {
      this.soft.setParticlePosition(i, { x: P[i * 3], y: P[i * 3 + 1], z: P[i * 3 + 2] });
      this.soft.setParticleVelocity(i, { x: 0, y: 0, z: 0 });
    }
    this.soft.wakeUp();
  }
}

/** A part's flesh carried rigidly by its bones: the lattice Rapier would solve, each particle riding on its nearest
 *  bone (or on the body the coupling attaches it to), the surface embedded in the cells. */
class CarriedPiece implements FleshPiece {
  readonly soft = null;
  readonly count: number;
  readonly rest: Float32Array;
  private lattice: Uint32Array;
  private masses: Float32Array;
  /** The body carrying each particle, and the particle's offset in that body's frame. */
  private carrier: RAPIER.RigidBody[] = [];
  private offset: Float32Array;
  private P: Float32Array;
  /** Each surface vertex: the 4 particles of the cell holding it, and its barycentric weights there. */
  private embedIds: Uint32Array;
  private embedW: Float32Array;
  private out: Float32Array;
  private surfaceStale = true;
  private restVolume: number;

  constructor(scene: Scene, readonly part: SimPart, settings: Readonly<Settings>) {
    const surface = new TriMesh(part.positions, part.indices);
    const lattice = latticeOf(part, cellSizeFor(part, surface, Number(settings.limbParticles)), DENSITY * surface.volume());
    this.rest = lattice.rest;
    this.lattice = lattice.cells;
    this.masses = lattice.masses;
    this.count = this.rest.length / 3;
    this.P = this.rest.slice();
    this.offset = new Float32Array(this.rest.length);
    this.out = part.positions.slice();
    ({ ids: this.embedIds, w: this.embedW } = embed(part.positions, this.rest, this.lattice));
    this.restVolume = cellsVolume(this.lattice, this.rest);

    // Each particle rides on its nearest bone, and that bone takes on its mass.
    const p = new THREE.Vector3();
    const byBone = new Map<SimBone, number[]>();
    for (let i = 0; i < this.count; i++) {
      const bone = nearestBone(part, p.fromArray(this.rest, i * 3)).bone;
      this.carrier.push(bone.body);
      p.applyMatrix4(bone.restInverse).toArray(this.offset, i * 3);
      byBone.set(bone, [...(byBone.get(bone) ?? []), i]);
    }
    const flesh = limbFlesh(scene.spec);
    for (const [bone, ids] of byBone) this.carry(scene, bone, ids, flesh.get(bone.name)?.points);
  }

  /** The flesh a bone carries: its mass and inertia (from the particles), and a convex collider over its surface that
   *  meets the floor and balls. A foot meets them with the skeleton's sole; torso bones lie inside the Body. */
  private carry(scene: Scene, bone: SimBone, ids: number[], points: Float32Array | undefined) {
    let mass = 0;
    const com = new THREE.Vector3(), p = new THREE.Vector3(), inertia = new THREE.Vector3();
    for (const i of ids) {
      mass += this.masses[i];
      com.addScaledVector(p.fromArray(this.offset, i * 3), this.masses[i]);
    }
    com.divideScalar(mass);
    for (const i of ids) {
      p.fromArray(this.offset, i * 3).sub(com);
      inertia.x += this.masses[i] * (p.y * p.y + p.z * p.z);
      inertia.y += this.masses[i] * (p.x * p.x + p.z * p.z);
      inertia.z += this.masses[i] * (p.x * p.x + p.y * p.y);
    }
    let hull: RAPIER.ColliderDesc | null = null;
    if (points && points.length >= 12 && !/foot/.test(bone.name)) {
      const local = new Float32Array(points.length);
      for (let k = 0; k < points.length; k += 3) p.fromArray(points, k).applyMatrix4(bone.restInverse).toArray(local, k);
      hull = RAPIER.ColliderDesc.convexHull(local);
    }
    const desc = (hull ?? RAPIER.ColliderDesc.ball(0.01))
      .setMassProperties(mass, com, inertia, { x: 0, y: 0, z: 0, w: 1 })
      .setFriction(0.8)
      .setRestitution(0.1)
      .setCollisionGroups(hull ? scene.collisionGroups.limb : 0)
      .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
    scene.registerCollider(scene.world.createCollider(desc, bone.body), this.part);
  }

  positions() {
    return this.P;
  }
  /** Its mass rides in its carrier's body. */
  mass() {
    return 0;
  }
  applyImpulse(i: number, x: number, y: number, z: number) {
    const at = { x: this.P[i * 3], y: this.P[i * 3 + 1], z: this.P[i * 3 + 2] };
    this.carrier[i].applyImpulseAtPoint({ x, y, z }, at, true);
  }
  /** Carried flesh goes where its body takes it. */
  setPosition() {}
  setVelocity() {}
  attach(i: number, body: RAPIER.RigidBody) {
    if (body === this.carrier[i]) return;
    this.carrier[i] = body;
    const p = new THREE.Vector3().fromArray(this.P, i * 3);
    p.applyMatrix4(poseOf(body, new THREE.Matrix4()).invert()).toArray(this.offset, i * 3);
  }
  detach() {}
  attachedTo(i: number) {
    return this.carrier[i];
  }

  /** Move the particles with their bodies (after the world stepped); the surface follows when it is read. */
  afterStep() {
    const poses = new Map<RAPIER.RigidBody, THREE.Matrix4>();
    const P = this.P, O = this.offset;
    for (let i = 0; i < this.count; i++) {
      const b = this.carrier[i];
      let m = poses.get(b);
      if (!m) poses.set(b, (m = poseOf(b, new THREE.Matrix4())));
      const e = m.elements, x = O[i * 3], y = O[i * 3 + 1], z = O[i * 3 + 2];
      P[i * 3] = e[0] * x + e[4] * y + e[8] * z + e[12];
      P[i * 3 + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
      P[i * 3 + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
    }
    this.surfaceStale = true;
  }

  surface() {
    if (!this.surfaceStale) return this.out;
    const P = this.P, ids = this.embedIds, w = this.embedW, out = this.out;
    for (let v = 0, k = 0; v < out.length; v += 3, k += 4) {
      let x = 0, y = 0, z = 0;
      for (let j = 0; j < 4; j++) {
        const a = ids[k + j] * 3, wj = w[k + j];
        x += wj * P[a];
        y += wj * P[a + 1];
        z += wj * P[a + 2];
      }
      out[v] = x;
      out[v + 1] = y;
      out[v + 2] = z;
    }
    this.surfaceStale = false;
    return out;
  }

  cells() {
    return this.lattice;
  }
  volumeRatio() {
    return cellsVolume(this.lattice, this.P) / this.restVolume;
  }
  addVelocity() {}
  setParams() {}
  reset() {
    this.afterStep();
  }
}

function poseOf(body: RAPIER.RigidBody, out: THREE.Matrix4): THREE.Matrix4 {
  const t = body.translation(), r = body.rotation();
  return out.compose(new THREE.Vector3(t.x, t.y, t.z), new THREE.Quaternion(r.x, r.y, r.z, r.w), new THREE.Vector3(1, 1, 1));
}

/** The lattice Rapier builds for a part (particles, cells, masses), from a throwaway world. */
function latticeOf(part: SimPart, cellSize: number, mass: number) {
  const world = new RAPIER.World({ x: 0, y: 0, z: 0 });
  try {
    const desc = RAPIER.SoftBodyDesc.volumetric(part.positions, part.indices, cellSize, false);
    if (!desc) throw new Error(`sim: ${part.name} cannot be filled with cells (is it closed?)`);
    const soft = world.createSoftBody(desc.setNoSurfaceCollider().setMass(mass));
    const masses = Float32Array.from({ length: soft.numParticles() }, (_, i) => soft.particleMass(i));
    return { rest: soft.particlePositions(), cells: soft.cells(), masses };
  } finally {
    world.free();
  }
}

/** Each vertex of V in the cell (4 particle indices into P) that holds it, with its barycentric weights there; a vertex
 *  outside every cell takes the cell it is least outside of. */
function embed(V: Float32Array, P: Float32Array, cells: Uint32Array): { ids: Uint32Array; w: Float32Array } {
  const n = V.length / 3, ids = new Uint32Array(n * 4), w = new Float32Array(n * 4);
  const m = new THREE.Matrix3(), b = new THREE.Vector3();
  for (let v = 0; v < n; v++) {
    let best = -Infinity;
    for (let c = 0; c < cells.length && best < -1e-6; c += 4) {
      const a = cells[c] * 3, i1 = cells[c + 1] * 3, i2 = cells[c + 2] * 3, i3 = cells[c + 3] * 3;
      m.set(
        P[i1] - P[a], P[i2] - P[a], P[i3] - P[a],
        P[i1 + 1] - P[a + 1], P[i2 + 1] - P[a + 1], P[i3 + 1] - P[a + 1],
        P[i1 + 2] - P[a + 2], P[i2 + 2] - P[a + 2], P[i3 + 2] - P[a + 2],
      );
      if (Math.abs(m.determinant()) < 1e-15) continue;
      b.set(V[v * 3] - P[a], V[v * 3 + 1] - P[a + 1], V[v * 3 + 2] - P[a + 2]).applyMatrix3(m.invert());
      const w0 = 1 - b.x - b.y - b.z, worst = Math.min(w0, b.x, b.y, b.z);
      if (worst <= best) continue;
      best = worst;
      ids.set(cells.subarray(c, c + 4), v * 4);
      w.set([w0, b.x, b.y, b.z], v * 4);
    }
  }
  return { ids, w };
}

function cellsVolume(cells: Uint32Array, P: Float32Array): number {
  let volume = 0;
  for (let c = 0; c < cells.length; c += 4) {
    const a = cells[c] * 3, b = cells[c + 1] * 3, d = cells[c + 2] * 3, e = cells[c + 3] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[d] - P[a], vy = P[d + 1] - P[a + 1], vz = P[d + 2] - P[a + 2];
    const wx = P[e] - P[a], wy = P[e + 1] - P[a + 1], wz = P[e + 2] - P[a + 2];
    volume += Math.abs(ux * (vy * wz - vz * wy) - uy * (vx * wz - vz * wx) + uz * (vx * wy - vy * wx)) / 6;
  }
  return volume;
}

/** The cell size that gives about the wanted number of particles (the lattice covers the surface, so thin parts get
 *  relatively more): a few trial meshings. */
function cellSizeFor(part: SimPart, surface: TriMesh, particles: number): number {
  let cs = Math.cbrt((4.7 * surface.volume()) / particles);
  for (let k = 0; k < 4; k++) {
    const n = RAPIER.SoftBodyDesc.volumetric(part.positions, part.indices, cs, false)?.numParticles() ?? 0;
    if (Math.abs(n - particles) < 0.08 * particles) break;
    cs *= Math.cbrt(Math.max(n, 1) / particles);
  }
  return cs;
}

class RapierFlesh implements FleshBlock {
  private pieces = new Map<SimPart, FleshPiece>();

  constructor(scene: Scene, settings: Readonly<Settings>) {
    // Few substeps with more iterations each: the per-substep work (contacts, soft-body updates) is most of the cost,
    // and the joints converge better (with 4 substeps of 2 extra iterations the standing frog crept ~2 cm/s).
    scene.world.integrationParameters.numSolverIterations = Number(settings.substeps);
    const carried = settings.limbFlesh !== "solved";
    for (const part of scene.parts) {
      this.pieces.set(part, part.limb && carried ? new CarriedPiece(scene, part, settings) : new Piece(scene, part, settings));
    }
  }

  private piece(part: SimPart): FleshPiece {
    const p = this.pieces.get(part);
    if (!p) throw new Error(`sim: no flesh for ${part.name}`);
    return p;
  }

  particles(part: SimPart): ParticleView {
    return this.piece(part);
  }
  surface(part: SimPart) {
    return this.piece(part).surface();
  }
  rapier(part: SimPart) {
    return this.piece(part).soft;
  }
  cells(part: SimPart) {
    return this.piece(part).cells();
  }
  volumeRatio(part: SimPart) {
    return this.piece(part).volumeRatio();
  }

  afterStep() {
    for (const piece of this.pieces.values()) piece.afterStep?.();
  }

  addVelocity(dv: THREE.Vector3) {
    for (const piece of this.pieces.values()) piece.addVelocity(dv);
  }

  stats() {
    let particles = 0, cells = 0;
    for (const piece of this.pieces.values()) {
      particles += piece.count;
      cells += piece.cells().length / 4;
    }
    return { particles, cells, volumeRatio: [...this.pieces.values()][0].volumeRatio() };
  }

  setParams(p: PhysicsParams) {
    for (const piece of this.pieces.values()) piece.setParams(p);
  }

  reset() {
    for (const piece of this.pieces.values()) piece.reset();
  }
}

export const rapierFlesh: BlockDefinition<"flesh"> = {
  id: "rapier-soft-body",
  slot: "flesh",
  name: { zh: "Rapier 体积软体", en: "Rapier volumetric soft body" },
  summary: {
    zh: "四面体单元填满每块肉，用 Rapier 的约束求解器（PGS）求解；接触在同一次求解里处理。",
    en: "Tetrahedral cells fill each piece of flesh, solved by Rapier's constraint solver (PGS); contacts are resolved in the same solve.",
  },
  device: "cpu",
  covers: ["collision"],
  parameters: [
    {
      key: "cellModel", kind: "choice", default: "volume", rebuild: true,
      label: { zh: "单元模型", en: "Cell model" },
      choices: [
        { value: "volume", label: { zh: "体积约束", en: "Volume" } },
        { value: "corotational", label: { zh: "共旋 FEM", en: "Corotational FEM" } },
        { value: "neohookean", label: { zh: "Neo-Hookean", en: "Neo-Hookean" } },
      ],
      help: {
        zh: "共旋和 Neo-Hookean 单元对旋转不变，大转动时不塌。",
        en: "Corotational and neo-Hookean cells are rotation-invariant and keep their shape under large rotations.",
      },
    },
    {
      key: "bodyParticles", kind: "number", default: 250, min: 150, max: 1200, step: 50, rebuild: true,
      label: { zh: "身体粒子数", en: "Body particles" },
    },
    {
      key: "limbParticles", kind: "number", default: 40, min: 30, max: 200, step: 10, rebuild: true,
      label: { zh: "四肢粒子数", en: "Limb particles" },
    },
    {
      key: "limbFlesh", kind: "choice", default: "carried", rebuild: true,
      label: { zh: "四肢的肉", en: "Limb flesh" },
      choices: [
        { value: "carried", label: { zh: "随骨骼携带", en: "Carried by the bones" } },
        { value: "solved", label: { zh: "求解", en: "Solved" } },
      ],
      help: {
        zh: "四肢的肉整块挂在骨头上。携带：同一套晶格随骨头刚性移动，表面在关节处随单元弯曲，不用求解（省下约三分之一的物理时间）。求解：作为 Rapier 软体参与求解。",
        en: "Limb flesh rides whole on its bones. Carried: the same lattice moves rigidly with the bones and the surface bends with the cells across the joints, with nothing to solve (about a third of the physics time). Solved: a Rapier soft body in the solve.",
      },
    },
    {
      key: "substeps", kind: "number", default: 2, min: 1, max: 8, step: 1, rebuild: true,
      label: { zh: "子步", en: "Substeps" },
      help: {
        zh: "每个物理步里求解器积分几次（Rapier 的 solver iterations）。每个子步都重新检测接触、更新软体，所以比额外迭代贵。",
        en: "How many times the solver integrates within each physics step (Rapier's solver iterations). Each substep updates the contacts and the soft bodies again, so it costs more than extra iterations.",
      },
    },
    {
      key: "iterations", kind: "number", default: 6, min: 0, max: 12, step: 1, rebuild: true,
      label: { zh: "额外迭代", en: "Extra iterations" },
      help: {
        zh: "每个子步里额外的 PGS 迭代，作用于软体和与它相连的一切（骨骼、关节）：越多越收敛，站得越稳。",
        en: "Extra PGS iterations per substep for the soft bodies and everything joined to them (bones, joints): more converges further, and the frog stands steadier.",
      },
    },
    {
      key: "volumePreservation", kind: "boolean", default: true, rebuild: true,
      label: { zh: "整体保体积", en: "Keep total volume" },
    },
  ],
  create: (scene, settings) => new RapierFlesh(scene, settings),
};
