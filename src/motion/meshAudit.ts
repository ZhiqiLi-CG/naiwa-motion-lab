/**
 * Dev check on the real meshes (dev/motion.html): how deep the skinned Arms and Legs vertices that are outside the
 * Body at rest sink into the skinned Body. Skin near the shoulders and hips is left out (the limb roots are buried
 * and turn inside the body, unseen). The posed Body is voxelised per frame by vertical ray parity; depth is the
 * distance to the nearest outside cell. Results are grouped by limb part and by head / torso.
 */
import * as THREE from "three";
import { MESH_NAMES } from "../contracts";

const CELL = 0.01;

interface LimbPoint {
  mesh: THREE.SkinnedMesh;
  index: number;
  part: string;
}

/** Limb part of a bone, or null for the roots (upper arm and thigh skin near the body is left out). */
const PART: Record<string, string> = { forearm: "forearm", hand: "hand", thumb: "hand", index: "hand", middle: "hand", ring: "hand", upperarm: "upperarm", shin: "shin", foot: "foot", thigh: "knee" };
const ROOT_REACH = 0.12;

export class MeshAudit {
  private readonly body: THREE.Mesh[] = [];
  private points: LimbPoint[] = [];

  constructor(root: THREE.Object3D) {
    root.getObjectByName(MESH_NAMES.body)?.traverse((o) => (o as THREE.Mesh).isMesh && this.body.push(o as THREE.Mesh));
    for (const name of [MESH_NAMES.arms, MESH_NAMES.legs])
      root.getObjectByName(name)?.traverse((o) => {
        const m = o as THREE.SkinnedMesh;
        if (!m.isSkinnedMesh) return;
        const si = m.geometry.getAttribute("skinIndex"), sw = m.geometry.getAttribute("skinWeight");
        for (let i = 0; i < m.geometry.getAttribute("position").count; i += 2) {
          let k = 0;
          for (let c = 1; c < 4; c++) if (sw.getComponent(i, c) > sw.getComponent(i, k)) k = c;
          const bone = m.skeleton.bones[si.getComponent(i, k)].name;
          const part = PART[bone.split("_")[0]];
          if (!part) continue;
          // Upper arm and thigh: only away from the shoulder / hip joint (the elbow and knee ends).
          if (part === "upperarm" || part === "knee") {
            const joint = m.skeleton.bones[si.getComponent(i, k)].getWorldPosition(new THREE.Vector3());
            root.updateMatrixWorld(true);
            if (m.getVertexPosition(i, new THREE.Vector3()).applyMatrix4(m.matrixWorld).distanceTo(joint) < ROOT_REACH) continue;
          }
          this.points.push({ mesh: m, index: i, part: `${part}_${bone.slice(-1)}` });
        }
      });
    root.updateMatrixWorld(true);
    const grid = this.voxelise();
    this.points = this.points.filter((p) => grid.depth(this.at(p)) === 0);
    const head = root.getObjectByName("head");
    this.head = head instanceof THREE.Bone ? head : null;
  }

  private head: THREE.Bone | null = null;

  /** Worst depth (m) and where ("hand_L in head"), worst per part, and the limb points more than 1 cm inside. */
  measure(): { depth: number; where: string; parts: Record<string, number>; inside: THREE.Vector3[] } {
    const grid = this.voxelise();
    const headY = this.head ? this.head.getWorldPosition(new THREE.Vector3()).y - 0.02 : Infinity;
    let depth = 0, where = "";
    const parts: Record<string, number> = {};
    const inside: THREE.Vector3[] = [];
    for (const p of this.points) {
      const at = this.at(p);
      const d = grid.depth(at);
      if (d <= 0.01) continue;
      inside.push(at);
      const key = `${p.part} in ${at.y > headY ? "head" : "torso"}`;
      parts[key] = Math.max(parts[key] ?? 0, +d.toFixed(3));
      if (d > depth) (depth = d), (where = key);
    }
    return { depth, where, parts, inside };
  }

  private at(p: LimbPoint): THREE.Vector3 {
    return p.mesh.getVertexPosition(p.index, new THREE.Vector3()).applyMatrix4(p.mesh.matrixWorld);
  }

  private voxelise() {
    const tris: THREE.Vector3[][] = [];
    const box = new THREE.Box3();
    for (const m of this.body) {
      const n = m.geometry.getAttribute("position").count;
      const pos = Array.from({ length: n }, (_, i) => m.getVertexPosition(i, new THREE.Vector3()).applyMatrix4(m.matrixWorld));
      pos.forEach((p) => box.expandByPoint(p));
      const idx = m.geometry.index;
      const count = idx ? idx.count : n;
      for (let t = 0; t < count; t += 3) tris.push([0, 1, 2].map((k) => pos[idx ? idx.getX(t + k) : t + k]));
    }
    box.expandByScalar(0.05);
    const nx = Math.ceil((box.max.x - box.min.x) / CELL), nz = Math.ceil((box.max.z - box.min.z) / CELL);
    const cols: number[][] = Array.from({ length: nx * nz }, () => []);
    for (const [a, b, c] of tris) {
      const x0 = Math.floor((Math.min(a.x, b.x, c.x) - box.min.x) / CELL), x1 = Math.floor((Math.max(a.x, b.x, c.x) - box.min.x) / CELL);
      const z0 = Math.floor((Math.min(a.z, b.z, c.z) - box.min.z) / CELL), z1 = Math.floor((Math.max(a.z, b.z, c.z) - box.min.z) / CELL);
      const det = (b.z - c.z) * (a.x - c.x) + (c.x - b.x) * (a.z - c.z);
      if (Math.abs(det) < 1e-12) continue;
      for (let ix = x0; ix <= x1; ix++)
        for (let iz = z0; iz <= z1; iz++) {
          // Column centres nudged off the grid so rays never run exactly through shared edges.
          const x = box.min.x + (ix + 0.5013) * CELL, z = box.min.z + (iz + 0.4987) * CELL;
          const l1 = ((b.z - c.z) * (x - c.x) + (c.x - b.x) * (z - c.z)) / det;
          const l2 = ((c.z - a.z) * (x - c.x) + (a.x - c.x) * (z - c.z)) / det;
          const l3 = 1 - l1 - l2;
          if (l1 < 0 || l2 < 0 || l3 < 0) continue;
          cols[ix * nz + iz].push(l1 * a.y + l2 * b.y + l3 * c.y);
        }
    }
    for (const c of cols) c.sort((p, q) => p - q);
    const inside = (ix: number, iz: number, y: number) => {
      if (ix < 0 || iz < 0 || ix >= nx || iz >= nz) return false;
      let above = 0;
      for (const h of cols[ix * nz + iz]) if (h > y) above++;
      return above % 2 === 1;
    };
    return {
      depth(p: THREE.Vector3): number {
        const ix = Math.floor((p.x - box.min.x) / CELL), iz = Math.floor((p.z - box.min.z) / CELL);
        if (!inside(ix, iz, p.y)) return 0;
        const ys = cols[ix * nz + iz];
        let d = Math.min(...ys.map((h) => Math.abs(h - p.y)));
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]])
          for (let k = 1; k * CELL < d; k++)
            if (!inside(ix + dx * k, iz + dz * k, p.y)) {
              d = Math.min(d, k * CELL);
              break;
            }
        return d;
      },
    };
  }
}
