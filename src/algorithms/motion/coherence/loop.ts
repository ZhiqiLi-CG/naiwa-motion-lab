/**
 * A seamless loop: tracks loop, so the last frame should lead into the first as any frame leads into the next. Over the
 * last `seconds`, the frames are eased (smoothstep) towards the start: the heading turned by what separates the end
 * from the start (unwrapped, less the turn of one frame), then every coordinate offset by what separates the last
 * frame from the first less one frame's motion (the mean of the motion at both ends).
 */
import { heading, present, rotateWorld, wrap, type Frame } from "./frames";

export function seamlessLoop(frames: Frame[], fps: number, seconds: number): boolean {
  const n = frames.length;
  const L = Math.min(Math.round(seconds * fps), Math.floor(n / 3));
  if (L < 2 || n < 6) return false;
  const [f0, f1, g1, g0] = [frames[0], frames[1], frames[n - 2], frames[n - 1]];
  if (![f0, f1, g1, g0].every(present)) return false;
  const ease = (k: number) => {
    const x = (k - (n - L) + 1) / L;
    return x * x * (3 - 2 * x);
  };
  const turnStep = (wrap(heading(f1) - heading(f0)) + wrap(heading(g0) - heading(g1))) / 2;
  const turn = wrap(heading(f0) - turnStep - heading(g0));
  for (let k = n - L; k < n; k++) if (present(frames[k])) rotateWorld(frames[k], turn * ease(k));
  for (const kind of ["world", "image"] as const) {
    const off = f0[kind].map((p, i) => [0, 1, 2].map((c) => {
      const step = (f1[kind][i][c] - p[c] + g0[kind][i][c] - g1[kind][i][c]) / 2;
      return p[c] - step - g0[kind][i][c];
    }));
    for (let k = n - L; k < n; k++) {
      if (!present(frames[k])) continue;
      const w = ease(k);
      frames[k][kind].forEach((p, i) => {
        for (let c = 0; c < 3; c++) p[c] += off[i][c] * w;
      });
    }
  }
  return true;
}
