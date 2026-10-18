/**
 * Seating the tongue on the face. A tongue is only believable when it grows out of the mouth: its root on the floor
 * of the mouth pocket, the rest lying on (or over) the lower lip. When the asset's tongue, in an open-mouth shape,
 * does not touch the Body's own surface of that shape at all (the shape key was authored floating in front of the
 * face), the tongue's shapes are rebuilt here from the Body's surface instead: the asset's tongue (a flat lozenge at
 * rest) is laid along the Body's midsagittal-ish profile through the lower lip, its underside on the skin, its top
 * domed with a centre groove and a rounded tip.
 *
 * - `tongue`: root on the floor of the pocket, over the lower lip, hanging down onto the chin (reference 3).
 * - `laugh`: lying on the floor of the mouth behind the lower teeth (reference 2).
 * - `surprise`: drawn back under the floor of the small round mouth (no tongue shows in an "O").
 *
 * Everything is in the rest frame; the result is written into the MouthInside morph targets (positions and normals),
 * so at run time the tongue rides on the mouth rivet with the teeth exactly as an asset-authored shape would.
 */
import * as THREE from "three";
import type { Expression } from "../contracts";

/** The Body in the rest frame: welded positions, triangles, expression offsets per welded vertex. */
export interface BodyShapes {
  rest: Float32Array;
  indices: Uint32Array;
  shapes: ReadonlyMap<Expression, Float32Array>;
}

/** How the tongue lies in one mouth shape (meters, arc length along the profile from the lower lip's crest, + out). */
interface Lay {
  /** Root and tip along the profile: negative is into the mouth, positive down the chin. */
  from: number;
  to: number;
  /** Half width and top thickness at the widest. */
  width: number;
  thick: number;
  /** Lift of the underside off the skin (negative sinks it in). */
  lift: number;
}
const LAYS: Partial<Record<Expression, Lay>> = {
  tongue: { from: -0.032, to: 0.052, width: 0.032, thick: 0.013, lift: -0.0015 },
  laugh: { from: -0.058, to: -0.02, width: 0.024, thick: 0.008, lift: -0.001 },
  surprise: { from: -0.05, to: -0.02, width: 0.012, thick: 0.004, lift: -0.012 },
};
/** The asset's tongue counts as seated when it comes this close to the Body in the `tongue` shape (m). */
const SEATED = 0.012;
/** Depth of the centre groove (fraction of the top thickness). */
const GROOVE = 0.32;

type Part = THREE.Mesh;

/** One cut of the Body by the plane x = const, ordered from below the mouth up over the lower lip into the mouth. */
export interface Profile {
  x: number;
  /** Points (y, z), outward normals (y, z), arc length from the lower lip's crest (+ towards the chin). */
  y: Float32Array;
  z: Float32Array;
  ny: Float32Array;
  nz: Float32Array;
  arc: Float32Array;
}

/**
 * The Body cut at x (positions of one shape), walked from the front of the chin (below mouthY by `below`) upwards
 * over the lower lip into the mouth; null when the cut does not reach there.
 */
export function cutProfile(pos: Float32Array, indices: Uint32Array, x: number, mouthY: number, below = 0.15): Profile | null {
  // Segments of triangles crossing the plane, keyed by the crossed edges so they chain.
  const point = new Map<number, [number, number]>();
  const link = new Map<number, number[]>();
  const segN = new Map<string, [number, number]>();
  const n = pos.length / 3;
  const ek = (a: number, b: number) => (a < b ? a * n + b : b * n + a);
  const cross = (a: number, b: number) => {
    const k = ek(a, b);
    if (!point.has(k)) {
      const da = pos[3 * a] - x, db = pos[3 * b] - x;
      const t = da / (da - db);
      point.set(k, [pos[3 * a + 1] + t * (pos[3 * b + 1] - pos[3 * a + 1]), pos[3 * a + 2] + t * (pos[3 * b + 2] - pos[3 * a + 2])]);
    }
    return k;
  };
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), fn = new THREE.Vector3();
  for (let t = 0; t < indices.length; t += 3) {
    const v = [indices[t], indices[t + 1], indices[t + 2]];
    const s = v.map((i) => pos[3 * i] - x >= 0);
    if (s[0] === s[1] && s[1] === s[2]) continue;
    let ylo = Infinity, yhi = -Infinity;
    for (const i of v) (ylo = Math.min(ylo, pos[3 * i + 1])), (yhi = Math.max(yhi, pos[3 * i + 1]));
    if (yhi < mouthY - below - 0.03 || ylo > mouthY + 0.12) continue;
    const ks: number[] = [];
    for (let j = 0; j < 3; j++) if (s[j] !== s[(j + 1) % 3]) ks.push(cross(v[j], v[(j + 1) % 3]));
    const [a, b] = ks;
    (link.get(a) ?? link.set(a, []).get(a)!).push(b);
    (link.get(b) ?? link.set(b, []).get(b)!).push(a);
    e1.fromArray(pos, 3 * v[1]).sub(fn.fromArray(pos, 3 * v[0]));
    e2.fromArray(pos, 3 * v[2]).sub(fn);
    fn.crossVectors(e1, e2);
    const l = Math.hypot(fn.y, fn.z) || 1;
    segN.set(a < b ? `${a},${b}` : `${b},${a}`, [fn.y / l, fn.z / l]);
  }
  // Start: the front-most point at the chin height.
  let start = -1, best = -Infinity;
  for (const [k, [py, pz]] of point) {
    if (Math.abs(py - (mouthY - below)) < 0.015 && pz > best) (best = pz), (start = k);
  }
  if (start < 0) return null;
  // Walk upwards.
  const chain = [start];
  const seen = new Set(chain);
  let prev = -1, cur = start;
  {
    const nb = link.get(start) ?? [];
    const up = nb.reduce((m, k) => (point.get(k)![0] > point.get(m)![0] ? k : m), nb[0]);
    if (up === undefined) return null;
    prev = start;
    cur = up;
  }
  while (cur !== undefined && !seen.has(cur) && chain.length < 4000) {
    chain.push(cur);
    seen.add(cur);
    const next = (link.get(cur) ?? []).find((k) => k !== prev && !seen.has(k));
    prev = cur;
    cur = next!;
  }
  const ys = chain.map((k) => point.get(k)![0]), zs = chain.map((k) => point.get(k)![1]);
  // Into the mouth: the first stretch heading steeply back (above the start); the crest is the highest z before it.
  let drop = -1;
  for (let i = 1; i < chain.length; i++) {
    const dy = ys[i] - ys[i - 1], dz = zs[i] - zs[i - 1], l = Math.hypot(dy, dz);
    if (l > 1e-6 && dz / l < -0.6 && ys[i] > ys[0] + 0.02) {
      drop = i - 1;
      break;
    }
  }
  if (drop < 0) return null;
  let crest = drop;
  while (crest > 0 && zs[crest - 1] >= zs[crest]) crest--;
  // Arc length (+ down towards the chin) and outward normals (averaged from the two segments at each point).
  const m = chain.length;
  const arc = new Float32Array(m), ny = new Float32Array(m), nz = new Float32Array(m);
  for (let i = 1; i < m; i++) arc[i] = arc[i - 1] - Math.hypot(ys[i] - ys[i - 1], zs[i] - zs[i - 1]);
  const c0 = arc[crest];
  for (let i = 0; i < m; i++) arc[i] -= c0;
  for (let i = 0; i + 1 < m; i++) {
    const a = chain[i], b = chain[i + 1];
    const s = segN.get(a < b ? `${a},${b}` : `${b},${a}`) ?? [0, 0];
    ny[i] += s[0]; nz[i] += s[1]; ny[i + 1] += s[0]; nz[i + 1] += s[1];
  }
  // The chin faces forward; a Body wound inwards flips every normal.
  const flip = nz[0] < 0 ? -1 : 1;
  for (let i = 0; i < m; i++) {
    const l = Math.hypot(ny[i], nz[i]) || 1;
    ny[i] *= flip / l;
    nz[i] *= flip / l;
  }
  // Ordered by arc length, increasing.
  const order = [...Array(m).keys()].reverse();
  const pick = (a: Float32Array | number[]) => Float32Array.from(order, (i) => a[i]);
  const raw: Profile = { x, y: pick(ys), z: pick(zs), ny: pick(ny), nz: pick(nz), arc: pick(arc) };
  // Resampled evenly and smoothed: the cut runs across the Body's facets, which the tongue must not copy.
  const step = 0.0015, a0 = raw.arc[0], count = Math.max(2, Math.floor((raw.arc[m - 1] - a0) / step) + 1);
  const even = { y: new Float32Array(count), z: new Float32Array(count), ny: new Float32Array(count), nz: new Float32Array(count) };
  const q = [0, 0, 0, 0];
  for (let i = 0; i < count; i++) {
    at(raw, a0 + i * step, q);
    (even.y[i] = q[0]), (even.z[i] = q[1]), (even.ny[i] = q[2]), (even.nz[i] = q[3]);
  }
  const blur = (src: Float32Array, sigma: number) => {
    const r = Math.ceil((2.5 * sigma) / step), out = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      let s = 0, w = 0;
      for (let k = Math.max(0, i - r); k <= Math.min(count - 1, i + r); k++) {
        const g = Math.exp(-0.5 * (((k - i) * step) / sigma) ** 2);
        s += g * src[k];
        w += g;
      }
      out[i] = s / w;
    }
    return out;
  };
  const out: Profile = {
    x, y: blur(even.y, 0.002), z: blur(even.z, 0.002), ny: blur(even.ny, 0.004), nz: blur(even.nz, 0.004),
    arc: Float32Array.from({ length: count }, (_, i) => a0 + i * step),
  };
  for (let i = 0; i < count; i++) {
    const l = Math.hypot(out.ny[i], out.nz[i]) || 1;
    out.ny[i] /= l;
    out.nz[i] /= l;
  }
  return out;
}

/** Point and outward normal on a profile at arc length s (clamped to its ends). */
function at(p: Profile, s: number, out: number[]): void {
  const a = p.arc, m = a.length;
  let i = 0;
  if (s <= a[0]) i = 0;
  else if (s >= a[m - 1]) i = m - 2;
  else {
    let lo = 0, hi = m - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (a[mid] <= s) lo = mid;
      else hi = mid;
    }
    i = lo;
  }
  const t = THREE.MathUtils.clamp((s - a[i]) / (a[i + 1] - a[i] || 1), 0, 1);
  out[0] = p.y[i] + t * (p.y[i + 1] - p.y[i]);
  out[1] = p.z[i] + t * (p.z[i + 1] - p.z[i]);
  const ny = p.ny[i] + t * (p.ny[i + 1] - p.ny[i]), nz = p.nz[i] + t * (p.nz[i + 1] - p.nz[i]);
  const l = Math.hypot(ny, nz) || 1;
  out[2] = ny / l;
  out[3] = nz / l;
}

/** Welded connected components of a mesh (vertex → component id). */
function components(pos: THREE.BufferAttribute | THREE.InterleavedBufferAttribute, index: THREE.BufferAttribute | null): Int32Array {
  const n = pos.count;
  const parent = Int32Array.from({ length: n }, (_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const join = (a: number, b: number) => (parent[find(a)] = find(b));
  const at = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    const k = `${pos.getX(i).toFixed(5)},${pos.getY(i).toFixed(5)},${pos.getZ(i).toFixed(5)}`;
    const j = at.get(k);
    if (j === undefined) at.set(k, i);
    else join(i, j);
  }
  const tri = index ? index.count : n;
  for (let t = 0; t < tri; t += 3) {
    const a = index ? index.getX(t) : t, b = index ? index.getX(t + 1) : t + 1, c = index ? index.getX(t + 2) : t + 2;
    join(a, b);
    join(a, c);
  }
  return Int32Array.from({ length: n }, (_, i) => find(i));
}

/** The tongue's vertices of a MouthInside mesh: its pink parts (vertex colours), not the white teeth or a dark cavity. */
function tongueVertices(mesh: Part): number[] {
  const g = mesh.geometry;
  const col = g.attributes.color;
  if (!col) return [];
  const comp = components(g.attributes.position, g.index);
  const sum = new Map<number, [number, number, number, number]>();
  for (let i = 0; i < comp.length; i++) {
    const s = sum.get(comp[i]) ?? [0, 0, 0, 0];
    s[0] += col.getX(i); s[1] += col.getY(i); s[2] += col.getZ(i); s[3]++;
    sum.set(comp[i], s);
  }
  const pink = new Set<number>();
  for (const [c, [r, gr, b, k]] of sum) if (r / k > 0.35 && r > 1.8 * gr && r > 1.8 * b) pink.add(c);
  const out: number[] = [];
  for (let i = 0; i < comp.length; i++) if (pink.has(comp[i])) out.push(i);
  return out;
}

/**
 * Rebuild the tongue's open-mouth shapes on the Body when the asset's tongue floats off the face. mouthY: height of
 * the mouth (rest). Returns what was done, for the report, or null when the asset's tongue was already seated.
 */
export function seatTongue(mouth: Part[], body: BodyShapes, mouthY: number): string | null {
  const shape = body.shapes.get("tongue");
  if (!shape) return null;
  const bodyTongue = body.rest.map((v, i) => v + shape[i]);
  const done: string[] = [];
  for (const mesh of mouth) {
    const g = mesh.geometry;
    const dict = mesh.morphTargetDictionary ?? {};
    const morphPos = g.morphAttributes.position, morphNrm = g.morphAttributes.normal;
    const verts = tongueVertices(mesh);
    if (!verts.length || dict.tongue === undefined || !morphPos) continue;
    mesh.updateMatrixWorld(true);
    const toWorld = mesh.matrixWorld, toLocal = toWorld.clone().invert();
    const linWorld = new THREE.Matrix3().setFromMatrix4(toWorld), linLocal = new THREE.Matrix3().setFromMatrix4(toLocal);
    const nToLocal = new THREE.Matrix3().getNormalMatrix(toLocal);
    const rel = g.morphTargetsRelative;
    const pos = g.attributes.position;
    const v = new THREE.Vector3(), d = new THREE.Vector3();
    const rest = verts.map((i) => new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(toWorld));
    const shaped = (e: Expression, k: number) => {
      d.fromBufferAttribute(morphPos[dict[e]], verts[k]);
      if (rel) return v.copy(rest[k]).add(d.applyMatrix3(linWorld));
      return v.copy(d).applyMatrix4(toWorld);
    };

    // Seated already? The nearest Body point to the tongue in the `tongue` shape.
    let gap = Infinity;
    for (let k = 0; k < verts.length; k++) {
      const p = shaped("tongue", k);
      for (let j = 0; j < bodyTongue.length; j += 3) {
        const dx = bodyTongue[j] - p.x, dy = bodyTongue[j + 1] - p.y, dz = bodyTongue[j + 2] - p.z;
        gap = Math.min(gap, dx * dx + dy * dy + dz * dz);
      }
    }
    gap = Math.sqrt(gap);
    if (gap < SEATED) continue;

    // The rest tongue's own frame: across (x), along (out of the mouth), up (its top), normalized to its half extents.
    const box = new THREE.Box3().setFromPoints(rest);
    const centre = box.getCenter(new THREE.Vector3()), half = box.getSize(new THREE.Vector3()).multiplyScalar(0.5);
    const across = new THREE.Vector3(1, 0, 0);
    const thin = half.y < half.z;
    const along = thin ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, -1, 0);
    const up = new THREE.Vector3().crossVectors(along, across);
    const hu = Math.max(half.x, 1e-6), ha = Math.max(thin ? half.z : half.y, 1e-6), hw = Math.max(thin ? half.y : half.z, 1e-6);
    const local = rest.map((p) => {
      d.copy(p).sub(centre);
      return [d.dot(across) / hu, d.dot(along) / ha, d.dot(up) / hw];
    });

    for (const e of ["tongue", "laugh", "surprise"] as const) {
      const lay = LAYS[e], slot = dict[e], bs = body.shapes.get(e);
      if (!lay || slot === undefined || !bs) continue;
      const bodyPos = body.rest.map((x, i) => x + bs[i]);
      // Cuts across the tongue's width.
      const K = 9;
      const cuts: Profile[] = [];
      for (let c = 0; c < K; c++) {
        const p = cutProfile(bodyPos, body.indices, ((2 * c) / (K - 1) - 1) * lay.width * 1.05, mouthY);
        if (p) cuts.push(p);
      }
      if (cuts.length < 2) continue;
      const L = lay.to - lay.from;
      const tipStart = Math.max(0.3, 1 - lay.width / L);
      const target = rest.map(() => new THREE.Vector3());
      const pa = [0, 0, 0, 0], pb = [0, 0, 0, 0];
      local.forEach(([u, s, w], k) => {
        // Cross-section of the lozenge at s (an ellipse u² + w² = r²) mapped to the unit circle.
        const r = Math.sqrt(Math.max(1 - s * s, 0.0025));
        let un = u / r, wn = w / r;
        const l = Math.hypot(un, wn);
        if (l > 1) (un /= l), (wn /= l);
        const t = THREE.MathUtils.clamp((s + 1) / 2, 0, 1);
        // Full width out to a rounded tip; slightly narrower root.
        const tip = t > tipStart ? Math.sqrt(Math.max(0, 1 - ((t - tipStart) / (1 - tipStart)) ** 2)) : 1;
        const width = lay.width * tip * (0.85 + 0.15 * Math.min(1, t / 0.3));
        const x = width * un;
        // Underside on the skin, a domed top with a groove down the middle.
        const h = wn >= 0
          ? lay.thick * Math.sqrt(tip) * Math.pow(wn, 0.6) * (1 - GROOVE * Math.exp(-((un / 0.28) ** 2)))
          : 0.0015 * wn;
        // The profile at this x, between the two nearest cuts.
        let j = 0;
        while (j < cuts.length - 2 && cuts[j + 1].x < x) j++;
        const f = THREE.MathUtils.clamp((x - cuts[j].x) / (cuts[j + 1].x - cuts[j].x), 0, 1);
        const sArc = lay.from + t * L;
        at(cuts[j], sArc, pa);
        at(cuts[j + 1], sArc, pb);
        const py = pa[0] + f * (pb[0] - pa[0]), pz = pa[1] + f * (pb[1] - pa[1]);
        let ny = pa[2] + f * (pb[2] - pa[2]), nz = pa[3] + f * (pb[3] - pa[3]);
        const nl = Math.hypot(ny, nz) || 1;
        (ny /= nl), (nz /= nl);
        const off = lay.lift + h;
        target[k].set(x, py + ny * off, pz + nz * off);
      });
      // Write positions and recompute the shape's normals over the tongue's triangles.
      const attr = morphPos[slot];
      target.forEach((p, k) => {
        if (rel) d.copy(p).sub(rest[k]).applyMatrix3(linLocal);
        else d.copy(p).applyMatrix4(toLocal);
        attr.setXYZ(verts[k], d.x, d.y, d.z);
      });
      attr.needsUpdate = true;
      if (morphNrm?.[slot]) {
        const kOf = new Map(verts.map((i, k) => [i, k]));
        const nrm = target.map(() => new THREE.Vector3());
        const idx = g.index;
        const tri = idx ? idx.count : pos.count;
        const a = new THREE.Vector3(), b = new THREE.Vector3();
        for (let q = 0; q < tri; q += 3) {
          const ks = [0, 1, 2].map((o) => kOf.get(idx ? idx.getX(q + o) : q + o));
          if (ks.some((x) => x === undefined)) continue;
          const [k0, k1, k2] = ks as number[];
          a.subVectors(target[k1], target[k0]);
          b.subVectors(target[k2], target[k0]);
          a.cross(b);
          nrm[k0].add(a); nrm[k1].add(a); nrm[k2].add(a);
        }
        const restN = g.attributes.normal;
        const na = morphNrm[slot];
        nrm.forEach((n, k) => {
          n.normalize().applyMatrix3(nToLocal).normalize();
          if (rel && restN) n.sub(d.fromBufferAttribute(restN, verts[k]));
          na.setXYZ(verts[k], n.x, n.y, n.z);
        });
        na.needsUpdate = true;
      }
      done.push(e);
    }
    done.unshift(`tongue of ${mesh.name} ${(gap * 1000).toFixed(0)} mm off the face in its asset shape; laid on the Body for`);
  }
  return done.length ? done.join(" ") : null;
}
