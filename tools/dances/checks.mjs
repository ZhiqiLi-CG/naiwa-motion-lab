// Check renders for looking at a track: the skeleton over the video frames, plus the world landmarks from the front and
// the side. Written under .cache/dances/<id>/ (never committed).
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const STYLE = {
  raw: { colors: { L: "#ff5a7a", R: "#6f8bff", C: "#ffffff" }, width: 1.5, alpha: 0.8 },
  clean: { colors: { L: "#ff9d2e", R: "#33d6ff", C: "#9cff57" }, width: 3, alpha: 1 },
};
const HEIGHT = 420;

const unpack = (seq, i) => {
  const f = seq[i];
  return Array.from({ length: 33 }, (_, j) => [f[j * 4], f[j * 4 + 1], f[j * 4 + 2], f[j * 4 + 3]]);
};

/** The part of the frame the dancer uses over the whole window, with a margin. */
function viewOf(image) {
  let [x0, y0, x1, y1] = [1, 1, 0, 0];
  for (let i = 0; i < image.length; i++)
    for (let j = 0; j < 33; j++) {
      const [x, y] = [image[i][j * 4], image[i][j * 4 + 1]];
      [x0, y0, x1, y1] = [Math.min(x0, x), Math.min(y0, y), Math.max(x1, x), Math.max(y1, y)];
    }
  const m = 0.05;
  return [Math.max(0, x0 - m), Math.max(0, y0 - m), Math.min(1, x1 + m), Math.min(1, y1 + m)];
}

async function panels(session, outDir, items, view) {
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  let n = 0;
  for (const it of items)
    await session.draw({ ...it, height: HEIGHT, view }, path.join(outDir, `${String(++n).padStart(5, "0")}.jpg`));
  return n;
}

const ffmpeg = (args) => execFileSync("ffmpeg", ["-v", "error", "-y", ...args]);
const encode = (dir, fps, out) =>
  ffmpeg(["-framerate", String(fps), "-i", path.join(dir, "%05d.jpg"), "-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2",
    "-c:v", "libx264", "-crf", "22", "-pix_fmt", "yuv420p", out]);

/** reference: one raw run (per frame { image, world } or null), drawn thin under the cleaned track. */
export async function renderChecks({ session, dir, id, fps, reference, track, log }) {
  const view = viewOf(track.window.image);
  const fwd = reference;
  const tmp = path.join(dir, "panels");
  const a = track.loopStart;
  const len = track.frames.length;

  // The whole window: the reference run (thin) and the cleaned track (thick), the loop marked.
  const win = track.window.world.map((_, i) => ({
    frame: i,
    label: `${i}${i >= a && i < a + len ? ` loop ${i - a}` : ""}`,
    layers: [
      { image: fwd[i]?.image, world: fwd[i]?.world, style: STYLE.raw },
      { image: unpack(track.window.image, i), world: unpack(track.window.world, i), style: STYLE.clean },
    ],
  }));
  await panels(session, tmp, win, view);
  encode(tmp, fps, path.join(dir, `${id}-window.mp4`));

  // The finished loop, three times over the frames it came from (the video jumps at the seam, the skeleton must not).
  const loop = [];
  for (let k = 0; k < 3; k++)
    for (let i = 0; i < len; i++)
      loop.push({ frame: a + i, label: `loop ${i}/${len}`, layers: [{ ...track.frames[i], style: STYLE.clean }] });
  await panels(session, tmp, loop, view);
  encode(tmp, fps, path.join(dir, `${id}-loop.mp4`));

  // Contact sheet of the loop (3 columns, ~18 frames), and the seam: the last 4 and first 4 frames in playing order.
  const cols = 3;
  const stepN = Math.max(1, Math.round(len / 18));
  const sheet = [];
  for (let i = 0; i < len; i += stepN) sheet.push(loop[i]);
  const rows = Math.ceil(sheet.length / cols);
  await panels(session, tmp, sheet, view);
  ffmpeg(["-i", path.join(tmp, "%05d.jpg"), "-vf", `tile=${cols}x${rows}`, "-frames:v", "1", "-q:v", "3",
    path.join(dir, `${id}-sheet.jpg`)]);
  const seam = [...loop.slice(len - 4, len), ...loop.slice(len, len + 4)];
  await panels(session, tmp, seam, view);
  ffmpeg(["-i", path.join(tmp, "%05d.jpg"), "-vf", "tile=4x2", "-frames:v", "1", "-q:v", "3",
    path.join(dir, `${id}-seam.jpg`)]);
  fs.rmSync(tmp, { recursive: true, force: true });
  log(`checks: ${id}-window.mp4, ${id}-loop.mp4, ${id}-sheet.jpg, ${id}-seam.jpg in ${dir}`);
}
