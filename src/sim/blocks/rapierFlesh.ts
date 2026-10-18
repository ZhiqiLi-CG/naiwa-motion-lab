/**
 * Flesh block: each part as a Rapier volumetric soft body (cells filling the closed surface, solved by Rapier's
 * constraint solver), one cluster per region carrying that region's softness, and a coarse copy of the surface
 * embedded in the cells as its collider. Rapier resolves those contacts in the same solve, so this block covers the
 * collision slot.
 */
import RAPIER from "@dimforge/rapier3d-compat";
import type * as THREE from "three";
import { FLESH_REGIONS, type FleshRegion, type PhysicsParams } from "../../contracts";
import type { BlockDefinition, FleshBlock, ParticleView, Scene, Settings, SimPart } from "../api";
import { TriMesh, coarseSkin } from "../geometry";
import { REGION_SOFTNESS, particleAttributes } from "../parts";

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
  m.edgeSoftness = { naturalFrequency: f, dampingRatio: z };
  m.bendSoftness = { naturalFrequency: f, dampingRatio: z };
  m.volumeSoftness = { naturalFrequency: f * 2, dampingRatio: z };
  m.shapeMatchingSoftness = { naturalFrequency: f, dampingRatio: z };
  return m;
}

/** One part's soft body, and what the other blocks see of it. */
class Piece implements ParticleView {
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
  private pieces = new Map<SimPart, Piece>();

  constructor(scene: Scene, settings: Readonly<Settings>) {
    for (const part of scene.parts) this.pieces.set(part, new Piece(scene, part, settings));
  }

  private piece(part: SimPart): Piece {
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
    return this.piece(part).soft.cells();
  }
  volumeRatio(part: SimPart) {
    const s = this.piece(part).soft;
    return s.volume() / s.restVolume();
  }

  addVelocity(dv: THREE.Vector3) {
    for (const { soft } of this.pieces.values()) {
      const M = soft.mass();
      soft.applyImpulse({ x: dv.x * M, y: dv.y * M, z: dv.z * M }, true);
    }
  }

  stats() {
    let particles = 0, cells = 0;
    for (const { soft } of this.pieces.values()) {
      particles += soft.numParticles();
      cells += soft.numCells();
    }
    const body = [...this.pieces.values()][0].soft;
    return { particles, cells, volumeRatio: body.volume() / body.restVolume() };
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
      key: "bodyParticles", kind: "number", default: 400, min: 150, max: 1200, step: 50, rebuild: true,
      label: { zh: "身体粒子数", en: "Body particles" },
    },
    {
      key: "limbParticles", kind: "number", default: 60, min: 30, max: 200, step: 10, rebuild: true,
      label: { zh: "四肢粒子数", en: "Limb particles" },
    },
    {
      key: "iterations", kind: "number", default: 3, min: 0, max: 12, step: 1, rebuild: true,
      label: { zh: "额外迭代", en: "Extra iterations" },
    },
    {
      key: "volumePreservation", kind: "boolean", default: true, rebuild: true,
      label: { zh: "整体保体积", en: "Keep total volume" },
    },
  ],
  create: (scene, settings) => new RapierFlesh(scene, settings),
};
