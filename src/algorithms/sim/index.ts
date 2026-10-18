/**
 * The simulation algorithm library: well-known CPU soft-body algorithms as blocks (one per file), each with a learning
 * page in docs/learn/sim/<block id>.{zh,en}.md, and simulators that assemble them with the built-in blocks
 * (src/sim/blocks). The built-in CPU example `cpu-constraints` (Rapier soft bodies, PGS) is the reference.
 *
 *   flesh        mass-spring            springs on the cells' edges; explicit or semi-implicit (Baraff–Witkin)
 *   collision    sdf-contacts           floor, bones and balls as signed distance fields, two-way
 *   metrics      particle-metrics       the built-in metrics with the solvers' own particle velocities
 *
 * Every flesh block fills each part with tetrahedra on a lattice (lattice.ts), keeps its particles in typed arrays
 * that implement ParticleView, and lets particles ride on bones two-way (flesh.ts), so the built-in target, coupling,
 * interaction and output blocks keep working.
 */
import type { AssemblyDefinition, BlockDefinition } from "../../sim/api";
import { registerBlock, registerSimulator } from "../../sim/api";
import { implicitFem } from "./implicitFem";
import { massSpring } from "./massSpring";
import { particleMetrics } from "./particleMetrics";
import { pbd } from "./pbd";
import { projectiveDynamics } from "./projectiveDynamics";
import { shapeMatching } from "./shapeMatching";
import { softTethers } from "./softTethers";
import { xpbd } from "./xpbd";
import { sdfContacts } from "./sdfContacts";

export const SIM_LIBRARY_BLOCKS: BlockDefinition[] = [massSpring, pbd, xpbd, shapeMatching, projectiveDynamics, implicitFem, sdfContacts, softTethers, particleMetrics] as BlockDefinition[];

/** The built-in blocks the assemblies keep (src/sim/blocks), with the library's contacts and metrics. */
const BASE = {
  skeleton: "rapier-skeleton", target: "bone-carried-target", coupling: "bone-attachments", collision: sdfContacts.id,
  interaction: "flesh-push", output: "flesh-surface", metrics: particleMetrics.id,
};

export const SIM_LIBRARY_SIMULATORS: AssemblyDefinition[] = [
  {
    id: "mass-spring",
    name: { zh: "质点–弹簧", en: "Mass–spring" },
    summary: {
      zh: "格点四面体的每条边一根弹簧，显式或半隐式积分；SDF 接触，深层的肉挂在骨头上（双向）。",
      en: "A spring on every edge of the lattice tetrahedra, explicit or semi-implicit; SDF contacts, the deep flesh riding on the bones (two-way).",
    },
    blocks: { ...BASE, flesh: massSpring.id },
  },
  {
    id: "pbd",
    name: { zh: "PBD 位置动力学", en: "Position-based dynamics" },
    summary: {
      zh: "边长和体积约束逐个投影（PBD）；SDF 接触，深层的肉挂在骨头上（双向）。",
      en: "Edge-length and volume constraints projected one at a time (PBD); SDF contacts, the deep flesh riding on the bones (two-way).",
    },
    blocks: { ...BASE, flesh: pbd.id },
  },
  {
    id: "xpbd",
    name: { zh: "XPBD 柔度位置动力学", en: "Extended PBD" },
    summary: {
      zh: "PBD 加上来自杨氏模量的柔度，小步长；SDF 接触，深层的肉挂在骨头上（双向）。",
      en: "PBD with compliance from Young's modulus, small steps; SDF contacts, the deep flesh riding on the bones (two-way).",
    },
    blocks: { ...BASE, flesh: xpbd.id },
  },
  {
    id: "shape-matching",
    name: { zh: "形状匹配", en: "Shape matching" },
    summary: {
      zh: "每个区域一簇（相邻簇重叠），拉向最佳刚体运动；SDF 接触，深层的肉挂在骨头上（双向）。",
      en: "One cluster per region (overlapping), pulled towards its best rigid motion; SDF contacts, the deep flesh riding on the bones (two-way).",
    },
    blocks: { ...BASE, flesh: shapeMatching.id },
  },
  {
    id: "projective-dynamics",
    name: { zh: "投影动力学", en: "Projective Dynamics" },
    summary: {
      zh: "局部投影 + 预分解的全局求解（隐式欧拉）；SDF 接触，深层的肉挂在骨头上（双向）。",
      en: "Local projections and a prefactored global solve (implicit Euler); SDF contacts, the deep flesh riding on the bones (two-way).",
    },
    blocks: { ...BASE, flesh: projectiveDynamics.id },
  },
  {
    id: "implicit-fem",
    name: { zh: "隐式有限元", en: "Implicit FEM" },
    summary: {
      zh: "四面体有限元（线性 / 共旋 / Neo-Hookean），后向欧拉 + 牛顿–CG；SDF 接触，深层的肉挂在骨头上（双向）。",
      en: "Tetrahedral FEM (linear, corotational or neo-Hookean), backward Euler with Newton–CG; SDF contacts, the deep flesh riding on the bones (two-way).",
    },
    blocks: { ...BASE, flesh: implicitFem.id },
  },
  {
    id: "fem-tethers",
    name: { zh: "隐式有限元 + 柔性系带", en: "Implicit FEM, soft tethers" },
    summary: {
      zh: "共旋有限元，肉用强度随深度平滑衰减的弹簧系在骨头上（没有硬挂/自由的分界），双向；SDF 接触。",
      en: "Corotational FEM with the flesh tied to the bones by springs that weaken smoothly with depth (no seam between carried and free flesh), two-way; SDF contacts.",
    },
    blocks: { ...BASE, flesh: implicitFem.id, coupling: softTethers.id },
  },
];

/** Register the library's blocks and simulators (as built-ins); returns a function that removes them again. The
 *  assemblies use the built-in blocks too (initPhysics registers those). */
export function registerSimLibrary(): () => void {
  const removers = [
    ...SIM_LIBRARY_BLOCKS.map((def) => registerBlock(def, "builtin")),
    ...SIM_LIBRARY_SIMULATORS.map((def) => registerSimulator(def, "builtin")),
  ];
  return () => removers.forEach((r) => r());
}
