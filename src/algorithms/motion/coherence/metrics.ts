/**
 * How coherent a track is, on the person's landmarks (the frog's own metrics come from playing it through a
 * retargeter, src/algorithms/motion/bench.ts). Picture distances are turned into metres with a torso of TORSO_M.
 *
 * - jerk: the limbs' jerk (m/s³) from the world landmarks (elbows, wrists, knees, ankles, nose): jitter.
 * - travelJerk: the hips' jerk across the picture (m/s³): a shaky camera or jittery travel.
 * - footSlide: how fast standing feet move in the picture (m/s), for given contacts (the same ones for a before and
 *   an after).
 * - cutSpeed: the hips' fastest speed across a cut (m/s): a jump at the cut.
 * - boneCV: the mean variation of bone lengths (%): a person's bones do not stretch.
 * - fidelity / fidelityPicture: RMS distance from a reference (cm), world landmarks and the picture (outside a loop
 *   blend's tail, which is changed on purpose).
 */
import { hip, present, TORSO_M, typicalTorso, type Frame } from "./frames";
import { footAt, SIDES, type Side } from "./contacts";

export interface CoherenceMetrics {
  jerk: number;
  travelJerk: number;
  footSlide: number;
  cutSpeed: number;
  boneCV: number;
  fidelity?: number;
  fidelityPicture?: number;
}

const LIMBS = [0, 13, 14, 15, 16, 25, 26, 27, 28];
const BONES: [number, number][] = [[11, 13], [13, 15], [12, 14], [14, 16], [23, 25], [25, 27], [24, 26], [26, 28]];

export interface MeasureOptions {
  cuts?: number[];
  contacts?: Record<Side, boolean[]>;
  reference?: Frame[];
  /** Frames from here on are left out of the fidelity (a loop blend changes them on purpose). */
  fidelityUntil?: number;
}

export function measure(frames: Frame[], fps: number, aspect: number, o: MeasureOptions = {}): CoherenceMetrics {
  const n = frames.length;
  const T = typicalTorso(frames, aspect);
  const toM = TORSO_M / T;
  const run4 = (k: number) => k >= 1 && k + 2 < n && present(frames[k - 1]) && present(frames[k]) && present(frames[k + 1]) && present(frames[k + 2]);
  const fps3 = fps ** 3;
  let jerk = 0, jn = 0, tj = 0, tn = 0;
  const cutSet = new Set(o.cuts ?? []);
  for (let k = 1; k + 2 < n; k++) {
    if (!run4(k)) continue;
    // A window over a cut is not the person's motion.
    if (cutSet.has(k) || cutSet.has(k + 1) || cutSet.has(k + 2)) continue;
    const [a, b, c, d] = [frames[k - 1], frames[k], frames[k + 1], frames[k + 2]];
    for (const i of LIMBS) {
      let s = 0;
      for (let q = 0; q < 3; q++) s += (d.world[i][q] - 3 * c.world[i][q] + 3 * b.world[i][q] - a.world[i][q]) ** 2;
      jerk += Math.sqrt(s) * fps3;
      jn++;
    }
    const [ha, hb, hc, hd] = [a, b, c, d].map((f) => hip(f, aspect));
    tj += Math.hypot(hd[0] - 3 * hc[0] + 3 * hb[0] - ha[0], hd[1] - 3 * hc[1] + 3 * hb[1] - ha[1]) * fps3 * toM;
    tn++;
  }
  let slide = 0, sn = 0;
  if (o.contacts)
    for (const s of SIDES)
      for (let k = 1; k < n; k++) {
        if (!o.contacts[s][k] || !o.contacts[s][k - 1] || cutSet.has(k)) continue;
        const p = footAt(frames[k - 1], s, aspect), q = footAt(frames[k], s, aspect);
        if (!p || !q) continue;
        slide += Math.abs(q[0] - p[0]) * fps * toM;
        sn++;
      }
  let cutSpeed = 0;
  for (const c of cutSet) {
    if (c < 1 || c >= n || !present(frames[c]) || !present(frames[c - 1])) continue;
    const p = hip(frames[c - 1], aspect), q = hip(frames[c], aspect);
    cutSpeed = Math.max(cutSpeed, Math.hypot(q[0] - p[0], q[1] - p[1]) * fps * toM);
  }
  let cv = 0;
  for (const [i, j] of BONES) {
    const l = frames.filter(present).map((f) => Math.hypot(f.world[i][0] - f.world[j][0], f.world[i][1] - f.world[j][1], f.world[i][2] - f.world[j][2]));
    const m = l.reduce((x, y) => x + y, 0) / Math.max(1, l.length);
    const sd = Math.sqrt(l.reduce((x, y) => x + (y - m) ** 2, 0) / Math.max(1, l.length));
    cv += m > 0 ? sd / m : 0;
  }
  const out: CoherenceMetrics = {
    jerk: jn ? jerk / jn : 0, travelJerk: tn ? tj / tn : 0, footSlide: sn ? slide / sn : 0, cutSpeed, boneCV: (100 * cv) / BONES.length,
  };
  if (o.reference) {
    let w = 0, wn = 0, p = 0, pn = 0;
    o.reference.forEach((r, k) => {
      const f = frames[k];
      if (!present(r) || !present(f) || k >= (o.fidelityUntil ?? Infinity)) return;
      for (let i = 0; i < 33; i++) {
        if (r.world[i][3] < 0.5) continue;
        w += (f.world[i][0] - r.world[i][0]) ** 2 + (f.world[i][1] - r.world[i][1]) ** 2 + (f.world[i][2] - r.world[i][2]) ** 2;
        wn++;
        p += ((f.image[i][0] - r.image[i][0]) * aspect) ** 2 + (f.image[i][1] - r.image[i][1]) ** 2;
        pn++;
      }
    });
    out.fidelity = wn ? Math.sqrt(w / wn) * 100 : 0;
    out.fidelityPicture = pn ? Math.sqrt(p / pn) * toM * 100 : 0;
  }
  return out;
}
