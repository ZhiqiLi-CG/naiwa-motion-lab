// Does the frog follow the person? The person's pose in a clip (MediaPipe on every frame, cached) against the
// frog's bones sampled while the clip plays, matched by the video's own time: arm-raise correlation, its time lag
// (sync) and which of the frog's arms answers which of the person's (mirroring). Plus colour histograms to tell
// which part of a recorded frame shows the video and which the frog's stage.
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";

/** MediaPipe world landmarks of the clip at 15 fps, computed once per clip version. */
export async function personPose(browser, baseUrl, clip, cacheDir, model) {
  const cache = join(cacheDir, `${basename(clip)}.${Math.round(statSync(clip).mtimeMs)}.pose.json`);
  if (existsSync(cache)) return JSON.parse(readFileSync(cache, "utf8"));
  const ctx = await browser.createBrowserContext();
  try {
    const page = await ctx.newPage();
    await page.goto(`${baseUrl}__e2e/oracle.html`, { waitUntil: "load" });
    await page.waitForFunction(() => window.__oracle, { timeout: 20000 });
    const pose = await page.evaluate((u, m) => window.__oracle(u, m), `/__e2e/media/${basename(clip)}`, model);
    const found = pose.frames.filter((f) => f.world).length;
    if (found < pose.frames.length * 0.8) throw new Error(`MediaPipe finds the person in only ${found}/${pose.frames.length} frames of ${basename(clip)}`);
    writeFileSync(cache, JSON.stringify(pose));
    return pose;
  } finally {
    await ctx.close();
  }
}

// MediaPipe landmark indices (the person's own left/right).
const SH = { L: 11, R: 12 }, WR = { L: 15, R: 16 }, NOSE = 0, HIP = { L: 23, R: 24 };

/** The person's wrist height above the shoulder, per arm, over the clip (world metres, up positive). */
function personArms(pose) {
  const f0 = pose.frames.find((f) => f.world);
  const hipY = (f0.world[HIP.L][1] + f0.world[HIP.R][1]) / 2;
  const up = f0.world[NOSE][1] < hipY ? -1 : 1; // MediaPipe's y points down
  const t = [], L = [], R = [];
  for (const f of pose.frames) {
    if (!f.world) continue;
    t.push(f.t);
    L.push(up * (f.world[WR.L][1] - f.world[SH.L][1]));
    R.push(up * (f.world[WR.R][1] - f.world[SH.R][1]));
  }
  return { t, L, R, duration: pose.duration };
}

/** Linear interpolation in a looping series. */
function at(series, values, time) {
  const d = series.duration;
  const x = ((time % d) + d) % d;
  const t = series.t;
  let i = t.findIndex((v) => v > x);
  if (i <= 0) return values[i === 0 ? 0 : t.length - 1];
  const k = (x - t[i - 1]) / (t[i] - t[i - 1]);
  return values[i - 1] * (1 - k) + values[i] * k;
}

function pearson(a, b) {
  const n = a.length;
  if (n < 3) return 0;
  const ma = a.reduce((s, x) => s + x, 0) / n, mb = b.reduce((s, x) => s + x, 0) / n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) {
    sab += (a[i] - ma) * (b[i] - mb);
    saa += (a[i] - ma) ** 2;
    sbb += (b[i] - mb) ** 2;
  }
  return saa && sbb ? sab / Math.sqrt(saa * sbb) : 0;
}
const variance = (a) => {
  const m = a.reduce((s, x) => s + x, 0) / a.length;
  return a.reduce((s, x) => s + (x - m) ** 2, 0) / a.length;
};

/** samples: [{vt, pos: {hand_L: [x,y,z], upperarm_L: …}}] taken while the clip played. Returns the best match. */
export function followScore(pose, samples) {
  const person = personArms(pose);
  const s = samples.filter((x) => x.vt != null && x.pos.hand_L && x.pos.hand_R && x.pos.upperarm_L && x.pos.upperarm_R);
  if (s.length < 20) return { error: `only ${s.length} samples with the video time and both arms` };
  const frog = { L: s.map((x) => x.pos.hand_L[1] - x.pos.upperarm_L[1]), R: s.map((x) => x.pos.hand_R[1] - x.pos.upperarm_R[1]) };
  // Weight each arm by how much the person moves it: a resting arm says little.
  const wL = variance(person.L), wR = variance(person.R);
  const score = (lag, swap) => {
    const pL = s.map((x) => at(person, person.L, x.vt - lag)), pR = s.map((x) => at(person, person.R, x.vt - lag));
    const fL = swap ? frog.R : frog.L, fR = swap ? frog.L : frog.R;
    return (wL * pearson(pL, fL) + wR * pearson(pR, fR)) / (wL + wR);
  };
  let best = null;
  for (const swap of [false, true]) {
    for (let lag = -0.8; lag <= 0.8001; lag += 0.05) {
      const c = score(lag, swap);
      if (!best || c > best.corr) best = { corr: c, lag, swap };
    }
  }
  const other = Math.max(...[-0.8, -0.4, 0, 0.4, 0.8].map((l) => score(l, !best.swap)));
  const wraps = s.filter((x, i) => i > 0 && x.vt < s[i - 1].vt - person.duration / 2).length;
  return { ...best, otherMapping: other, samples: s.length, loops: wraps + 1 };
}

/** Hue × saturation × value histogram of a rect (dark pixels left out), normalised to 1. */
export function histogram(img, rect) {
  const h = new Float64Array(6 * 3 * 3);
  const x0 = Math.max(0, Math.floor(rect.x)), y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(img.width, Math.ceil(rect.x + rect.w)), y1 = Math.min(img.height, Math.ceil(rect.y + rect.h));
  let n = 0;
  for (let y = y0; y < y1; y += 2) {
    for (let x = x0; x < x1; x += 2) {
      const i = (y * img.width + x) * 4;
      const r = img.data[i] / 255, g = img.data[i + 1] / 255, b = img.data[i + 2] / 255;
      const max = Math.max(r, g, b), min = Math.min(r, g, b), c = max - min;
      if (max < 0.08) continue;
      let hue = 0;
      if (c > 0) hue = max === r ? ((g - b) / c + 6) % 6 : max === g ? (b - r) / c + 2 : (r - g) / c + 4;
      const sat = max ? c / max : 0;
      h[Math.min(5, Math.floor(hue)) * 9 + Math.min(2, Math.floor(sat * 3)) * 3 + Math.min(2, Math.floor(max * 3))]++;
      n++;
    }
  }
  if (n) for (let k = 0; k < h.length; k++) h[k] /= n;
  return h;
}
export const intersection = (a, b) => a.reduce((s, x, k) => s + Math.min(x, b[k]), 0);
export function meanHistogram(hs) {
  const out = new Float64Array(hs[0].length);
  for (const h of hs) for (let k = 0; k < h.length; k++) out[k] += h[k] / hs.length;
  return out;
}

/** Which halves of a recorded frame show the video and the stage: tries left|right and top|bottom. */
export function splitLayout(frame, videoRef, stageRef) {
  const W = frame.width, H = frame.height;
  const splits = {
    "left|right": [{ x: 0, y: 0, w: W / 2, h: H }, { x: W / 2, y: 0, w: W / 2, h: H }],
    "top|bottom": [{ x: 0, y: 0, w: W, h: H / 2 }, { x: 0, y: H / 2, w: W, h: H / 2 }],
  };
  let best = null;
  for (const [name, [a, b]] of Object.entries(splits)) {
    const ha = histogram(frame, a), hb = histogram(frame, b);
    for (const [vid, stg, order] of [[ha, hb, "video first"], [hb, ha, "stage first"]]) {
      const vv = intersection(vid, videoRef), vs = intersection(vid, stageRef);
      const sv = intersection(stg, videoRef), ss = intersection(stg, stageRef);
      const margin = Math.min(vv - vs, ss - sv);
      if (!best || margin > best.margin) best = { split: name, order, margin, videoHalf: { video: vv, stage: vs }, stageHalf: { video: sv, stage: ss } };
    }
  }
  return best;
}
