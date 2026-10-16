// Screenshot pixels: a small PNG decoder (Chrome's 8-bit RGB/RGBA screenshots) and the measures the checks use.
import { inflateSync } from "node:zlib";

/** Decode an 8-bit, non-interlaced RGB or RGBA PNG into RGBA pixels. */
export function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
  let pos = 8;
  let width = 0, height = 0, colorType = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("latin1", pos + 4, pos + 8);
    const body = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      colorType = body[9];
      if (body[8] !== 8 || body[12] !== 0 || (colorType !== 2 && colorType !== 6)) {
        throw new Error(`unsupported PNG (depth ${body[8]}, colour type ${colorType}, interlace ${body[12]})`);
      }
    } else if (type === "IDAT") idat.push(body);
    else if (type === "IEND") break;
    pos += 12 + len;
  }
  const bpp = colorType === 6 ? 4 : 3;
  const stride = width * bpp;
  const raw = inflateSync(Buffer.concat(idat));
  const px = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const row = px.subarray(y * stride, (y + 1) * stride);
    const up = y > 0 ? px.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? row[i - bpp] : 0;
      const b = up ? up[i] : 0;
      const c = up && i >= bpp ? up[i - bpp] : 0;
      let v = src[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      row[i] = v & 255;
    }
  }
  if (bpp === 4) return { width, height, data: px };
  const data = new Uint8Array(width * height * 4);
  for (let i = 0, j = 0; i < px.length; i += 3, j += 4) {
    data[j] = px[i]; data[j + 1] = px[i + 1]; data[j + 2] = px[i + 2]; data[j + 3] = 255;
  }
  return { width, height, data };
}

/** Clamp a rect {x, y, w, h} (image pixels) to the image. */
function clampRect(img, r) {
  const x0 = Math.max(0, Math.floor(r?.x ?? 0)), y0 = Math.max(0, Math.floor(r?.y ?? 0));
  const x1 = Math.min(img.width, Math.ceil(r ? r.x + r.w : img.width));
  const y1 = Math.min(img.height, Math.ceil(r ? r.y + r.h : img.height));
  return { x0, y0, x1, y1 };
}

/** Fraction of pixels in rect (minus the `exclude` rects) whose largest channel difference exceeds threshold. */
export function diffFraction(a, b, rect, exclude = [], threshold = 32) {
  if (a.width !== b.width || a.height !== b.height) throw new Error("image sizes differ");
  const { x0, y0, x1, y1 } = clampRect(a, rect);
  const ex = exclude.map((r) => clampRect(a, r));
  let n = 0, changed = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (ex.some((e) => x >= e.x0 && x < e.x1 && y >= e.y0 && y < e.y1)) continue;
      const i = (y * a.width + x) * 4;
      const d = Math.max(Math.abs(a.data[i] - b.data[i]), Math.abs(a.data[i + 1] - b.data[i + 1]), Math.abs(a.data[i + 2] - b.data[i + 2]));
      n++;
      if (d > threshold) changed++;
    }
  }
  return n ? changed / n : 0;
}

/** Mask of pixels that differ between two images (e.g. with and without the frog), with its bounding box. */
export function diffMask(a, b, rect, threshold = 24) {
  const { x0, y0, x1, y1 } = clampRect(a, rect);
  const mask = new Uint8Array(a.width * a.height);
  let count = 0, sx = 0, sy = 0, minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * a.width + x) * 4;
      const d = Math.max(Math.abs(a.data[i] - b.data[i]), Math.abs(a.data[i + 1] - b.data[i + 1]), Math.abs(a.data[i + 2] - b.data[i + 2]));
      if (d <= threshold) continue;
      mask[y * a.width + x] = 1;
      count++; sx += x; sy += y;
      if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  const bbox = count ? { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 } : null;
  return { mask, count, bbox, centroid: count ? { x: sx / count, y: sy / count } : null };
}

/** Fraction of rect covered by a mask from diffMask. */
export function maskCoverage(img, mask, rect) {
  const { x0, y0, x1, y1 } = clampRect(img, rect);
  let n = 0, on = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { n++; on += mask[y * img.width + x]; }
  return n ? on / n : 0;
}

/** Fraction of pixels in rect that are far (RGB distance > minDist) from every colour sampled along the rect's border:
 *  how much of the centre is "not background", without knowing the scene. */
export function foregroundFraction(img, rect, centre, minDist = 40) {
  const { x0, y0, x1, y1 } = clampRect(img, rect);
  const samples = [];
  const at = (x, y) => { const i = (y * img.width + x) * 4; return [img.data[i], img.data[i + 1], img.data[i + 2]]; };
  const inset = 3;
  for (let k = 0; k <= 40; k++) {
    const x = Math.round(x0 + inset + (x1 - x0 - 2 * inset - 1) * k / 40);
    const y = Math.round(y0 + inset + (y1 - y0 - 2 * inset - 1) * k / 40);
    samples.push(at(x, y0 + inset), at(x, y1 - 1 - inset), at(x0 + inset, y), at(x1 - 1 - inset, y));
  }
  const c = clampRect(img, centre);
  let n = 0, fg = 0;
  for (let y = c.y0; y < c.y1; y++) {
    for (let x = c.x0; x < c.x1; x++) {
      const [r, g, b] = at(x, y);
      let best = Infinity;
      for (const s of samples) best = Math.min(best, Math.hypot(r - s[0], g - s[1], b - s[2]));
      n++;
      if (best > minDist) fg++;
    }
  }
  return n ? fg / n : 0;
}

/** Warm 奶蛙 yellow (hue 30–65°, saturated, bright): count and centroid within rect, to find the frog without hooks. */
export function yellowBlob(img, rect) {
  const { x0, y0, x1, y1 } = clampRect(img, rect);
  let count = 0, sx = 0, sy = 0, minY = Infinity, maxY = -1;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * img.width + x) * 4;
      const r = img.data[i], g = img.data[i + 1], b = img.data[i + 2];
      const max = Math.max(r, g, b), min = Math.min(r, g, b);
      if (max < 120 || max - min < 0.3 * max || max === b) continue;
      const hue = max === r ? 60 * ((g - b) / (max - min)) : 60 * (2 + (b - r) / (max - min));
      if (hue < 30 || hue > 65) continue;
      count++; sx += x; sy += y;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  const area = (x1 - x0) * (y1 - y0);
  return { fraction: area ? count / area : 0, centroid: count ? { x: sx / count, y: sy / count } : null, top: minY, bottom: maxY };
}

/** Mean and standard deviation of luminance in rect (a blank or black frame has a tiny deviation). */
export function lumaStats(img, rect) {
  const { x0, y0, x1, y1 } = clampRect(img, rect);
  let n = 0, s = 0, s2 = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * img.width + x) * 4;
      const l = 0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2];
      n++; s += l; s2 += l * l;
    }
  }
  const mean = n ? s / n : 0;
  return { mean, std: n ? Math.sqrt(Math.max(0, s2 / n - mean * mean)) : 0 };
}
