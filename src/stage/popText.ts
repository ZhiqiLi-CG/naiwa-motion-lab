/** Comic lettering ("DUANG~", "噗!", "哈哈哈") as billboards in the 3D scene, so recordings of the canvas carry them.
 *  Each text is drawn once into a canvas texture (cached by text and colour), then shown by a pooled sprite that
 *  bounces in, floats up with a wobble and fades. */
import * as THREE from "three";

const POOL = 8;
const CACHE = 16;
const TEX_W = 512;
const TEX_H = 256;
const LIFE = 1.35;
/** World height of the texture at size 1 (the lettering itself fills about 60% of it). */
const WORLD_H = 0.36;
const FILLS = ["#ff5f8f", "#ffb020", "#3fb8ff", "#58d68d", "#a77bff", "#ff7a3d"];
// Rounded, heavy faces where the system has them; CJK falls through to the heaviest system Chinese sans.
const FONT_STACK =
  '"Arial Rounded MT Bold", "Varela Round", "Nunito", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", ' +
  '"Noto Sans CJK SC", "Source Han Sans SC", "WenQuanYi Micro Hei", system-ui, sans-serif';

function shade(css: string, k: number): string {
  const c = new THREE.Color().setStyle(css, THREE.SRGBColorSpace);
  const hsl = { h: 0, s: 0, l: 0 };
  c.getHSL(hsl, THREE.SRGBColorSpace);
  c.setHSL(hsl.h, Math.min(1, hsl.s * (k < 1 ? 1.1 : 0.9)), THREE.MathUtils.clamp(hsl.l * k, 0, 0.97), THREE.SRGBColorSpace);
  return `#${c.getHexString(THREE.SRGBColorSpace)}`;
}

/** Sticker lettering: soft drop shadow, white border, dark outline, then the glyphs filled with a glossy gradient.
 *  Strokes are fattened so even a regular-weight system font reads as chunky comic type; each glyph bounces off
 *  the baseline and tilts a little. `layer` is a scratch canvas of the same size (the fill is glossed there alone). */
export function drawComicText(
  ctx: CanvasRenderingContext2D,
  layer: CanvasRenderingContext2D,
  text: string,
  fill: string,
): void {
  const { width: w, height: h } = ctx.canvas;
  const glyphs = [...text];
  // Letters overlap a little (gap < 0) like hand lettering; shrink the font until the line fits with its border.
  let fontPx = 140;
  const layout = () => {
    ctx.font = layer.font = `900 ${fontPx}px ${FONT_STACK}`;
    const widths = glyphs.map((g) => ctx.measureText(g).width);
    const gap = -fontPx * 0.02;
    return { widths, gap, total: widths.reduce((s, x) => s + x + gap, -gap) };
  };
  let { widths, gap, total } = layout();
  const room = w - fontPx * 0.5;
  if (total > room) {
    fontPx = Math.floor((fontPx * room) / total);
    ({ widths, gap, total } = layout());
  }
  const places = glyphs.map((g, i) => ({
    g,
    x: w / 2 - total / 2 + widths.slice(0, i).reduce((s, x) => s + x + gap, 0) + widths[i] / 2,
    y: h / 2 + fontPx * 0.04 + Math.sin(i * 1.9 + 0.6) * fontPx * 0.07,
    rot: (i % 2 ? 1 : -1) * 0.07 + Math.sin(i * 2.7) * 0.03,
  }));
  const each = (c: CanvasRenderingContext2D, style: string | CanvasGradient, line: number, dx = 0, dy = 0) => {
    c.fillStyle = c.strokeStyle = style;
    c.lineWidth = line;
    for (const p of places) {
      c.save();
      c.translate(p.x + dx, p.y + dy);
      c.rotate(p.rot);
      if (line > 0) c.strokeText(p.g, 0, 0);
      c.fillText(p.g, 0, 0);
      c.restore();
    }
  };
  for (const c of [ctx, layer]) {
    c.clearRect(0, 0, w, h);
    c.textAlign = "center";
    c.textBaseline = "middle";
    c.lineJoin = "round";
  }

  each(ctx, "rgba(60, 30, 20, 0.3)", fontPx * 0.38, fontPx * 0.03, fontPx * 0.09);
  each(ctx, "#ffffff", fontPx * 0.38);
  each(ctx, shade(fill, 0.3), fontPx * 0.2);

  const grad = layer.createLinearGradient(0, h / 2 - fontPx * 0.5, 0, h / 2 + fontPx * 0.5);
  grad.addColorStop(0, shade(fill, 1.25));
  grad.addColorStop(0.5, fill);
  grad.addColorStop(1, shade(fill, 0.78));
  each(layer, grad, fontPx * 0.05);
  layer.globalCompositeOperation = "source-atop";
  layer.fillStyle = "rgba(255, 255, 255, 0.5)";
  layer.beginPath();
  layer.ellipse(w / 2, h / 2 - fontPx * 0.3, total * 0.75, fontPx * 0.2, 0, 0, Math.PI * 2);
  layer.fill();
  layer.globalCompositeOperation = "source-over";
  ctx.drawImage(layer.canvas, 0, 0);
}

interface Pop {
  sprite: THREE.Sprite;
  age: number;
  life: number;
  size: number;
  base: THREE.Vector3;
  drift: THREE.Vector3;
  tilt: number;
  spin: number;
}

export interface PopTexts {
  readonly group: THREE.Group;
  pop(at: THREE.Vector3, text: string, camera: THREE.PerspectiveCamera, opts?: { color?: string; size?: number }): void;
  update(dt: number): void;
  dispose(): void;
}

export function createPopTexts(): PopTexts {
  const group = new THREE.Group();
  group.name = "stage-pop-texts";
  const cache = new Map<string, THREE.CanvasTexture>();
  // CPU canvases (willReadFrequently): a GPU reset would silently blank accelerated ones.
  const scratch = () => {
    const c = document.createElement("canvas");
    c.width = TEX_W;
    c.height = TEX_H;
    return c.getContext("2d", { willReadFrequently: true })!;
  };
  const ctx = scratch();
  const layer = scratch();
  let nextFill = 0;
  let nextPop = 0;

  const pops: Pop[] = [];
  for (let i = 0; i < POOL; i++) {
    const mat = new THREE.SpriteMaterial({ transparent: true, depthTest: false, depthWrite: false, toneMapped: false });
    const sprite = new THREE.Sprite(mat);
    sprite.visible = false;
    sprite.renderOrder = 20;
    group.add(sprite);
    pops.push({ sprite, age: 0, life: 0, size: 1, base: new THREE.Vector3(), drift: new THREE.Vector3(), tilt: 0, spin: 0 });
  }

  const texture = (text: string, fill: string) => {
    const key = `${fill}|${text}`;
    let tex = cache.get(key);
    if (tex) {
      cache.delete(key); // re-insert: Map order is the LRU order
      cache.set(key, tex);
      return tex;
    }
    drawComicText(ctx, layer, text, fill);
    // Each texture keeps its own pixels: copy the shared drawing canvas.
    const own = scratch();
    own.drawImage(ctx.canvas, 0, 0);
    tex = new THREE.CanvasTexture(own.canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    cache.set(key, tex);
    if (cache.size > CACHE) {
      const [oldKey, old] = cache.entries().next().value!;
      if (!pops.some((p) => p.sprite.visible && p.sprite.material.map === old)) {
        cache.delete(oldKey);
        old.dispose();
      }
    }
    return tex;
  };

  const toCamera = new THREE.Vector3();
  const local = new THREE.Vector3();
  return {
    group,
    pop(at, text, camera, opts = {}) {
      const fill = opts.color ?? FILLS[nextFill++ % FILLS.length];
      const p = pops[nextPop++ % POOL];
      p.sprite.material.map = texture(text, fill);
      p.sprite.material.needsUpdate = true;
      // A little towards the camera and up from the touched spot, jittered so repeated pops do not stack.
      toCamera.copy(camera.position).sub(at).normalize();
      p.base.copy(at).addScaledVector(toCamera, 0.15);
      p.base.x += (Math.random() - 0.5) * 0.12;
      p.base.y += 0.12 + Math.random() * 0.06;
      p.size = opts.size ?? 1;
      // Keep the whole lettering (at its overshoot, and after its rise) inside the view: narrow phone screens.
      local.copy(p.base).applyMatrix4(camera.matrixWorldInverse);
      const depth = Math.max(0.3, -local.z);
      const halfH = depth * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
      const textH = p.size * WORLD_H * 0.6 * 1.25;
      const textW = (textH / 0.6) * (TEX_W / TEX_H) * 0.9;
      const limX = Math.max(0, halfH * camera.aspect - textW / 2);
      local.x = THREE.MathUtils.clamp(local.x, -limX, limX);
      local.y = Math.min(local.y, Math.max(0, halfH - textH / 2 - 0.45));
      p.base.copy(local).applyMatrix4(camera.matrixWorld);
      p.drift.set((Math.random() - 0.5) * 0.25, 0.42 + Math.random() * 0.12, 0);
      p.tilt = (Math.random() - 0.5) * 0.4;
      p.spin = (Math.random() - 0.5) * 0.3;
      p.age = 0;
      p.life = LIFE * (0.9 + 0.2 * Math.random());
      p.sprite.visible = true;
    },
    update(dt) {
      for (const p of pops) {
        if (!p.sprite.visible) continue;
        p.age += dt;
        const t = p.age;
        if (t >= p.life) {
          p.sprite.visible = false;
          continue;
        }
        const u = t / p.life;
        // Springy pop: overshoots to ~1.25 and settles.
        const s = 1 - Math.exp(-10 * t) * Math.cos(17 * t);
        const rise = 1 - (1 - u) * (1 - u);
        p.sprite.position.copy(p.base).addScaledVector(p.drift, rise);
        p.sprite.position.x += Math.sin(t * 7) * 0.012;
        const k = p.size * WORLD_H * Math.max(0.001, s) * (1 + 0.15 * u);
        p.sprite.scale.set(k * (TEX_W / TEX_H), k, 1);
        p.sprite.material.rotation = p.tilt * Math.exp(-4 * t) * Math.cos(12 * t) + p.spin * u;
        p.sprite.material.opacity = u < 0.7 ? 1 : 1 - (u - 0.7) / 0.3;
      }
    },
    dispose() {
      for (const p of pops) p.sprite.material.dispose();
      for (const t of cache.values()) t.dispose();
      cache.clear();
    },
  };
}
