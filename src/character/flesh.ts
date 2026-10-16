/**
 * The soft flesh pieces of the frog (the Body, and each arm and leg when the asset makes it one closed shell): the
 * welded surfaces handed to the simulation, and the world-space render meshes that show them deformed.
 */
import * as THREE from "three";
import { EXPRESSIONS, FLESH_REGIONS, type BoneName, type Expression, type FleshPart, type FleshRegion } from "../contracts";
import { restPoints } from "./rig";
import { FleshSkin, type RootTie } from "./skin";
import { checkSurface, surfaceProblems, weld, type SurfaceReport } from "./surface";

type Part = THREE.SkinnedMesh;

export interface FleshPiece {
  /** What the simulation gets. */
  part: FleshPart;
  skin: FleshSkin;
  /** Skin slot → bone, and the per-slot bone deltas (world · rest⁻¹) filled every frame. */
  slots: BoneName[];
  deltas: THREE.Matrix4[];
  /** Latest simulated surface, and whether the simulation moves this piece. */
  sim: Float32Array;
  simulated: boolean;
  /** Limb vertices sunk into the Body, which take the Body's residual. */
  roots?: RootTie;
  report: SurfaceReport;
}

/** A render mesh of one asset primitive: each render vertex shows a vertex of one piece. */
export interface FleshMesh {
  mesh: THREE.Mesh;
  piece: Uint8Array;
  local: Uint32Array;
}

export interface FleshSet {
  pieces: FleshPiece[];
  meshes: FleshMesh[];
  renderVertices: number;
}

/**
 * Weld the primitives of one asset mesh and split them into connected pieces. name(centroid) names each piece;
 * smoothing is the spacing of the basis their simulated deformation is shown through (FleshInit.smoothing). The
 * result lists what keeps them from being soft (not closed, two pieces with one name), or the pieces. boneIndex
 * numbers the bones as RigSpec.bones does, for the pieces' skin binding.
 */
export function buildFlesh(
  meshes: Part[],
  name: (centroid: THREE.Vector3) => string,
  region: (bone: BoneName, softness: number | undefined) => FleshRegion,
  smoothing: number,
  boneIndex: (bone: BoneName) => number,
): { flesh: FleshSet; problems: [] } | { flesh: null; problems: string[] } {
  const pts = meshes.map((m) => restPoints(m));
  const counts = pts.map((p) => p.dominant.length);
  const total = counts.reduce((a, b) => a + b, 0);
  const all = new Float32Array(3 * total);
  const idx: number[] = [];
  let off = 0;
  meshes.forEach((m, k) => {
    all.set(pts[k].positions, 3 * off);
    const index = m.geometry.index;
    if (index) for (let i = 0; i < index.count; i++) idx.push(index.getX(i) + off);
    else for (let i = 0; i < counts[k]; i++) idx.push(i + off);
    off += counts[k];
  });
  const w = weld(all, idx, 1e-5);
  const nw = w.positions.length / 3;

  // Connected pieces over the welded triangles.
  const parent = Int32Array.from({ length: nw }, (_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]];
    return i;
  };
  for (let t = 0; t < w.indices.length; t += 3) {
    const a = find(w.indices[t]);
    parent[find(w.indices[t + 1])] = a;
    parent[find(w.indices[t + 2])] = a;
  }
  const groups = new Map<number, number[]>();
  for (let j = 0; j < nw; j++) {
    const r = find(j);
    let g = groups.get(r);
    if (!g) groups.set(r, (g = []));
    g.push(j);
  }

  const partOf = (gi: number): [number, number] => {
    let k = 0, base = 0;
    while (gi >= base + counts[k]) base += counts[k++];
    return [k, gi - base];
  };
  const problems: string[] = [];
  const pieceOf = new Uint8Array(nw);
  const localOf = new Uint32Array(nw);
  const pieces: FleshPiece[] = [];
  const named = new Set<string>();
  const toWorld = meshes.map((m) => new THREE.Matrix3().setFromMatrix4(m.matrixWorld));
  const v = new THREE.Vector3();
  for (const verts of groups.values()) {
    const n = verts.length;
    verts.forEach((j, i) => ((pieceOf[j] = pieces.length), (localOf[j] = i)));
    const positions = new Float32Array(3 * n);
    const centroid = new THREE.Vector3();
    verts.forEach((j, i) => {
      positions.set(w.positions.subarray(3 * j, 3 * j + 3), 3 * i);
      centroid.add(v.fromArray(w.positions, 3 * j));
    });
    centroid.divideScalar(n);
    const pieceName = name(centroid);
    const tris: number[] = [];
    const root = find(verts[0]);
    for (let t = 0; t < w.indices.length; t += 3) {
      if (find(w.indices[t]) === root) {
        tris.push(localOf[w.indices[t]], localOf[w.indices[t + 1]], localOf[w.indices[t + 2]]);
      }
    }
    const indices = Uint32Array.from(tris);
    const report = checkSurface(positions, indices);
    const bad = surfaceProblems(report);
    if (bad.length) problems.push(`${pieceName} is not one closed manifold: ${bad.join(", ")}`);
    if (named.has(pieceName)) problems.push(`${pieceName} is in more than one piece`);
    named.add(pieceName);

    // Per-vertex data from one render vertex of each welded vertex.
    const hasSoft = meshes.every((m) => m.geometry.attributes._softness);
    const softness = hasSoft ? new Float32Array(n) : undefined;
    const regions = new Uint8Array(n);
    const slots: BoneName[] = [];
    const slotOf = new Map<THREE.Bone, number>();
    const skinIndex = new Uint16Array(4 * n), skinWeight = new Float32Array(4 * n);
    const morphs = new Map<Expression, Float32Array>();
    const used = new Set<BoneName>();
    verts.forEach((j, i) => {
      const [k, r] = partOf(w.first[j]);
      const mesh = meshes[k], g = mesh.geometry;
      if (softness) softness[i] = g.attributes._softness.getX(r);
      const si = g.attributes.skinIndex, sw = g.attributes.skinWeight;
      let best = 0;
      for (let c = 0; c < 4; c++) {
        const bone = mesh.skeleton.bones[si.getComponent(r, c)];
        let slot = slotOf.get(bone);
        if (slot === undefined) {
          slot = slots.length;
          slotOf.set(bone, slot);
          slots.push(bone.name as BoneName);
        }
        skinIndex[4 * i + c] = slot;
        skinWeight[4 * i + c] = sw.getComponent(r, c);
        if (skinWeight[4 * i + c] > 0) used.add(bone.name as BoneName);
        if (sw.getComponent(r, c) > sw.getComponent(r, best)) best = c;
      }
      regions[i] = FLESH_REGIONS.indexOf(region(slots[skinIndex[4 * i + best]], softness?.[i]));
      for (const e of EXPRESSIONS) {
        const slotE = mesh.morphTargetDictionary?.[e];
        const attr = slotE === undefined ? undefined : g.morphAttributes.position?.[slotE];
        if (!attr) continue;
        let d = morphs.get(e);
        if (!d) morphs.set(e, (d = new Float32Array(3 * n)));
        v.fromBufferAttribute(attr, r);
        if (!g.morphTargetsRelative) v.sub(new THREE.Vector3().fromBufferAttribute(g.attributes.position, r));
        v.applyMatrix3(toWorld[k]);
        d.set([v.x, v.y, v.z], 3 * i);
      }
    });
    const skin = new FleshSkin({
      rest: positions, indices, skinIndex, skinWeight, boneCount: slots.length,
      softness: softness ?? new Float32Array(n), morphs, smoothing,
    });
    const skinIndices = Uint16Array.from(skinIndex, (slot) => Math.max(0, boneIndex(slots[slot])));
    pieces.push({
      part: { name: pieceName, positions, indices, softness, regions, bones: [...used], skinIndices, skinWeights: skinWeight },
      skin, slots, deltas: slots.map(() => new THREE.Matrix4()), sim: positions.slice(), simulated: false, report,
    });
  }
  if (problems.length) return { flesh: null, problems };

  // Render meshes: world-space positions written every frame, same colours and UVs as the asset.
  const out: FleshMesh[] = [];
  off = 0;
  meshes.forEach((m, k) => {
    const src = m.geometry, n = counts[k];
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(3 * n), 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(3 * n), 3).setUsage(THREE.DynamicDrawUsage));
    for (const a of ["color", "uv"]) if (src.attributes[a]) geo.setAttribute(a, src.attributes[a].clone());
    if (src.index) geo.setIndex(src.index.clone());
    const mesh = new THREE.Mesh(geo, m.material);
    mesh.name = m.name;
    mesh.matrixAutoUpdate = false;
    mesh.frustumCulled = false;
    mesh.castShadow = mesh.receiveShadow = true;
    const piece = new Uint8Array(n), local = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      const j = w.map[off + i];
      piece[i] = pieceOf[j];
      local[i] = localOf[j];
    }
    out.push({ mesh, piece, local });
    off += n;
  });
  return { flesh: { pieces, meshes: out, renderVertices: total }, problems: [] };
}

/** Copy the pieces' current positions and normals into their render meshes. */
export function showFlesh(set: FleshSet): void {
  for (const { mesh, piece, local } of set.meshes) {
    const pa = mesh.geometry.attributes.position as THREE.BufferAttribute;
    const na = mesh.geometry.attributes.normal as THREE.BufferAttribute;
    const pos = pa.array as Float32Array, nor = na.array as Float32Array;
    for (let i = 0; i < local.length; i++) {
      const s = set.pieces[piece[i]].skin;
      const P = s.positions, N = s.normals, j = 3 * local[i];
      pos[3 * i] = P[j]; pos[3 * i + 1] = P[j + 1]; pos[3 * i + 2] = P[j + 2];
      nor[3 * i] = N[j]; nor[3 * i + 1] = N[j + 1]; nor[3 * i + 2] = N[j + 2];
    }
    pa.needsUpdate = true;
    na.needsUpdate = true;
  }
}
