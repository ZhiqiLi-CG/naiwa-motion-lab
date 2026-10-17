// From raw per-frame poses to a seamless looping DanceTrack (pure functions, no I/O).
//
// Several PoseLandmarker runs over the same frames (VIDEO mode forward and backward in time) disagree mostly where
// one of them is wrong (a depth flip of the arms, a lost foot); a robust mean across the runs removes those errors and
// halves the jitter without smoothing over time, so the snap of the moves stays. What is left is light: isolated
// spikes are replaced, gaps filled, and a short Savitzky-Golay filter is run over the loop circularly, which also
// rounds off the velocity kink at the seam.

const N_LM = 33;
const KINDS = ["world", "image"];
/** Distance scale of the robust mean: world meters, image in frame heights. */
const TAU = { world: 0.06, image: 0.015 };
/** A frame that jumps this far away from both neighbours and back is a spike (image: x, y only, in frame heights). */
const SPIKE = { world: 0.25, image: 0.08 };
/** Landmarks compared when looking for the loop: shoulders, elbows, wrists, hips, knees, ankles, nose. */
const LOOP_LMS = [0, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28];
const DIGITS = { world: 3, image: 3 }; // 1 mm, 1/1000 of the frame: finer than the model resolves

/** Per kind: Float64Array[frame][landmark*4 + c] with NaN where nothing is known. */
function ensemble(runs, count, aspect, kind) {
  const out = [];
  const scale = kind === "image" ? [aspect, 1, aspect] : [1, 1, 1]; // image x and z are in frame widths
  for (let i = 0; i < count; i++) {
    const f = new Float64Array(N_LM * 4).fill(NaN);
    const ests = runs.map((r) => r[i]?.[kind]).filter(Boolean);
    for (let j = 0; ests.length && j < N_LM; j++) {
      const pts = ests.map((e) => e[j]);
      const med = [0, 1, 2].map((c) => median(pts.map((p) => p[c])));
      let wsum = 0;
      const acc = [0, 0, 0, 0];
      for (const p of pts) {
        const d = Math.hypot(...[0, 1, 2].map((c) => (p[c] - med[c]) * scale[c])) / TAU[kind];
        const w = 1 / (1 + d * d);
        for (let c = 0; c < 4; c++) acc[c] += w * p[c];
        wsum += w;
      }
      for (let c = 0; c < 4; c++) f[j * 4 + c] = acc[c] / wsum;
    }
    out.push(f);
  }
  return out;
}

function median(v) {
  const s = [...v].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Replace single-frame spikes and fill unknown frames per landmark (linear inside, held at the ends). */
function despikeAndFill(seq, kind, aspect) {
  const n = seq.length;
  const scale = kind === "image" ? [aspect, 1] : [1, 1, 1];
  const dist = (a, b, j) => Math.hypot(...scale.map((s, c) => (a[j * 4 + c] - b[j * 4 + c]) * s));
  let spikes = 0;
  for (let j = 0; j < N_LM; j++) {
    for (let i = 1; i < n - 1; i++) {
      const [p, q, r] = [seq[i - 1], seq[i], seq[i + 1]];
      if (dist(q, p, j) > SPIKE[kind] && dist(q, r, j) > SPIKE[kind] && dist(p, r, j) < SPIKE[kind] / 2) {
        for (let c = 0; c < 3; c++) q[j * 4 + c] = NaN;
        spikes++;
      }
    }
    for (let c = 0; c < 4; c++) {
      const k = j * 4 + c;
      const known = [];
      for (let i = 0; i < n; i++) if (!Number.isNaN(seq[i][k])) known.push(i);
      if (!known.length) throw new Error(`landmark ${j} never seen`);
      for (let i = 0; i < n; i++) {
        if (!Number.isNaN(seq[i][k])) continue;
        const hi = known.find((x) => x > i);
        const lo = known.findLast((x) => x < i);
        seq[i][k] =
          lo === undefined ? seq[hi][k] : hi === undefined ? seq[lo][k]
          : seq[lo][k] + ((seq[hi][k] - seq[lo][k]) * (i - lo)) / (hi - lo);
      }
    }
  }
  return spikes;
}

/** Savitzky-Golay smoothing coefficients (least-squares polynomial of this order over 2h+1 samples). */
function sgCoefficients(h, order) {
  const m = 2 * h + 1;
  // A^T A for the Vandermonde matrix A[i][p] = x_i^p, x in -h..h; the centre coefficients are row 0 of (A^T A)^-1 A^T.
  const ata = Array.from({ length: order + 1 }, (_, p) =>
    Array.from({ length: order + 1 }, (_, q) => {
      let s = 0;
      for (let x = -h; x <= h; x++) s += x ** (p + q);
      return s;
    }),
  );
  const inv = invert(ata);
  return Array.from({ length: m }, (_, i) => {
    const x = i - h;
    let s = 0;
    for (let q = 0; q <= order; q++) s += inv[0][q] * x ** q;
    return s;
  });
}

function invert(a) {
  const n = a.length;
  const m = a.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r][c]) > Math.abs(m[p][c])) p = r;
    [m[c], m[p]] = [m[p], m[c]];
    const d = m[c][c];
    for (let k = 0; k < 2 * n; k++) m[c][k] /= d;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = m[r][c];
      for (let k = 0; k < 2 * n; k++) m[r][k] -= f * m[c][k];
    }
  }
  return m.map((row) => row.slice(n));
}

/** Smooth every channel; circular wraps around (for the finished loop), otherwise the ends are held. */
function smooth(seq, coeffs, circular) {
  const n = seq.length;
  const h = (coeffs.length - 1) / 2;
  const at = (i) => (circular ? seq[((i % n) + n) % n] : seq[Math.max(0, Math.min(n - 1, i))]);
  return seq.map((_, i) => {
    const f = new Float64Array(seq[0].length);
    for (let k = -h; k <= h; k++) {
      const s = at(i + k);
      const w = coeffs[k + h];
      for (let c = 0; c < f.length; c++) f[c] += w * s[c];
    }
    return f;
  });
}

/** Loop [a, b): the pair of frames whose poses (and velocities) match best, the loop length within [min, max]. */
function findLoop(world, image, aspect, minLen, maxLen) {
  const n = world.length;
  const vec = (i) => {
    const v = [];
    for (const j of LOOP_LMS) for (let c = 0; c < 3; c++) v.push(world[i][j * 4 + c]);
    // Where the hips are in the frame matters too (squats, hops), up to the drift the seam takes out.
    const hipY = (image[i][23 * 4 + 1] + image[i][24 * 4 + 1]) / 2;
    v.push(hipY * 2);
    return v;
  };
  const vecs = world.map((_, i) => vec(i));
  const rms = (u, v) => Math.sqrt(u.reduce((s, x, k) => s + (x - v[k]) ** 2, 0) / u.length);
  const vel = (i) => vecs[i + 1].map((x, k) => (x - vecs[i - 1][k]) / 2);
  let best = null;
  for (let a = 1; a < n - 1; a++) {
    for (let len = minLen; len <= maxLen && a + len < n - 1; len++) {
      const b = a + len;
      const cost = rms(vecs[a], vecs[b]) + 0.5 * rms(vel(a), vel(b));
      if (!best || cost < best.cost) best = { a, b, cost, pose: rms(vecs[a], vecs[b]), vel: rms(vel(a), vel(b)) };
    }
  }
  if (!best) throw new Error(`no loop of ${minLen}..${maxLen} frames fits in ${n} frames`);
  return best;
}

const round = (x, d) => {
  const r = Number(x.toFixed(d));
  return r === 0 ? 0 : r; // no "-0"
};

/** Resample a closed loop to n frames (linear between neighbours, wrapping around). */
function resampleLoop(seq, n) {
  const len = seq.length;
  return Array.from({ length: n }, (_, i) => {
    const t = (i * len) / n;
    const k = Math.floor(t);
    const w = t - k;
    const a = seq[k % len];
    const b = seq[(k + 1) % len];
    return a.map((x, c) => x + (b[c] - x) * w);
  });
}

/**
 * raw: { mode: (null | { world: number[33][4], image: number[33][4] })[] } over the same frames.
 * loop: [minSeconds, maxSeconds] to search, or loopAt: [startFrame, endFrame) inside the window to use as is.
 * Sources faster than maxFps are worked at their own rate and the finished loop is resampled (smaller files).
 * Returns the finished frames and their fps, the loop in window frames, the window frame each output frame came
 * from, and the cleaned window for the checks.
 */
export function buildTrack({ raw, fps, aspect, loop, loopAt, maxFps = 30, smoothSeconds = 0.1, log = () => {} }) {
  const runs = Object.values(raw);
  const count = runs[0].length;
  const missing = runs.map((r) => r.filter((x) => !x).length);
  log(`raw: ${count} frames, no person in ${missing.join("/")} (per run)`);
  const clean = {};
  for (const kind of KINDS) {
    clean[kind] = ensemble(runs, count, aspect, kind);
    const spikes = despikeAndFill(clean[kind], kind, aspect);
    if (spikes) log(`${kind}: ${spikes} spike samples replaced`);
  }
  const coeffs = sgCoefficients(Math.max(2, Math.round(smoothSeconds * fps)), 3);
  const window = Object.fromEntries(KINDS.map((k) => [k, smooth(clean[k], coeffs, false)]));

  const pick = loopAt
    ? { a: loopAt[0], b: loopAt[1] }
    : findLoop(window.world, window.image, aspect, Math.round(loop[0] * fps), Math.round(loop[1] * fps));
  const { a, b } = pick;
  const len = b - a;
  if (pick.cost !== undefined)
    log(`loop frames ${a}..${b} (${(len / fps).toFixed(2)} s): pose rms ${pick.pose.toFixed(3)}, vel rms ${pick.vel.toFixed(3)}`);

  // Seam: frame b is where frame a should be; spread that difference linearly over the loop so it closes exactly.
  const n = fps > maxFps ? Math.round((len * maxFps) / fps) : len;
  const looped = {};
  for (const kind of KINDS) {
    const seq = clean[kind];
    const res = seq[b].map((x, c) => (c % 4 === 3 ? 0 : x - seq[a][c]));
    const cut = [];
    for (let i = 0; i < len; i++) cut.push(seq[a + i].map((x, c) => x - (res[c] * i) / len));
    const smoothed = smooth(cut, coeffs, true);
    looped[kind] = n === len ? smoothed : resampleLoop(smoothed, n);
  }
  const frames = [];
  for (let i = 0; i < n; i++) {
    const f = {};
    for (const kind of KINDS) {
      const s = looped[kind][i];
      f[kind] = [];
      for (let j = 0; j < N_LM; j++) {
        const p = [0, 1, 2].map((c) => round(s[j * 4 + c], DIGITS[kind]));
        p.push(round(Math.min(1, Math.max(0, s[j * 4 + 3])), 2));
        f[kind].push(p);
      }
    }
    frames.push({ world: f.world, image: f.image });
  }
  const outFps = n === len ? fps : (n * fps) / len;
  const sourceFrame = frames.map((_, i) => a + Math.round((i * len) / n));
  return { frames, fps: outFps, loopStart: a, loopLength: len, sourceFrame, window };
}
