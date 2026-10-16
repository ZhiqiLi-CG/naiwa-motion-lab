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

/** Bold sticker lettering: hard drop shadow, thick dark outline, glossy gradient fill, each glyph tilted a little. */
export function drawComicText(ctx: CanvasRenderingContext2D, text: string, fill: string): void {
  const { width: w, height: h } = ctx.canvas;
  ctx.clearRect(0, 0, w, h);
  const glyphs = [...text];
  // Letters overlap a little (gap < 0) like hand lettering; shrink the font until the line fits with its outline.
  let fontPx = 150;
  const layout = () => {
    ctx.font = `900 ${fontPx}px ${FONT_STACK}`;
    const widths = glyphs.map((g) => ctx.measureText(g).width);
    const gap = -fontPx * 0.04;
    return { widths, gap, total: widths.reduce((s, x) => s + x + gap, -gap) };
  };
  let { widths, gap, total } = layout();
  const room = w - fontPx * 0.5 - 24;
  if (total > room) {
    fontPx = Math.floor((fontPx * room) / total);
    ({ widths, gap, total } = layout());
  }
  const line = fontPx * 0.2;
  const dark = shade(fill, 0.32);
  const light = shade(fill, 1.35);

  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  ctx.miterLimit = 2;

  // Glyph placements: a bouncy baseline and alternating tilt.
  const places = glyphs.map((g, i) => {
    const x = w / 2 - total / 2 + widths.slice(0, i).reduce((s, x) => s + x + gap, 0) + widths[i] / 2;
    const y = h / 2 + Math.sin(i * 1.9 + 0.6) * fontPx * 0.07;
    const rot = (i % 2 ? 1 : -1) * 0.07 + Math.sin(i * 2.7) * 0.03;
    return { g, x, y, rot };
  });
  const each = (draw: (g: string) => void, dx = 0, dy = 0) => {
    for (const p of places) {
      ctx.save();
      ctx.translate(p.x + dx, p.y + dy);
      ctx.rotate(p.rot);
      draw(p.g);
      ctx.restore();
    }
  };

  // Drop shadow, outline (strokes under fills so neighbours never cover each other's fill), fill, gloss.
  ctx.fillStyle = ctx.strokeStyle = dark;
  ctx.lineWidth = line * 2;
  each((g) => {
    ctx.strokeText(g, 0, 0);
    ctx.fillText(g, 0, 0);
  }, fontPx * 0.05, fontPx * 0.07);
  each((g) => ctx.strokeText(g, 0, 0));
  const grad = ctx.createLinearGradient(0, h / 2 - fontPx * 0.5, 0, h / 2 + fontPx * 0.45);
  grad.addColorStop(0, light);
  grad.addColorStop(0.55, fill);
  grad.addColorStop(1, shade(fill, 0.8));
  ctx.fillStyle = grad;
  each((g) => ctx.fillText(g, 0, 0));
  ctx.save();
  ctx.globalCompositeOperation = "source-atop";
  ctx.fillStyle = "rgba(255,255,255,0.45)";
  ctx.beginPath();
  ctx.ellipse(w / 2, h / 2 - fontPx * 0.5, total * 0.62, fontPx * 0.36, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
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
  pop(at: THREE.Vector3, text: string, camera: THREE.Camera, opts?: { color?: string; size?: number }): void;
  update(dt: number): void;
  dispose(): void;
}

export function createPopTexts(): PopTexts {
  const group = new THREE.Group();
  group.name = "stage-pop-texts";
  const cache = new Map<string, THREE.CanvasTexture>();
  const canvas = document.createElement("canvas");
  canvas.width = TEX_W;
  canvas.height = TEX_H;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
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
    drawComicText(ctx, text, fill);
    // Each texture keeps its own pixels: copy the shared drawing canvas.
    const own = document.createElement("canvas");
    own.width = TEX_W;
    own.height = TEX_H;
    own.getContext("2d", { willReadFrequently: true })!.drawImage(canvas, 0, 0);
    tex = new THREE.CanvasTexture(own);
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
      p.drift.set((Math.random() - 0.5) * 0.25, 0.42 + Math.random() * 0.12, 0);
      p.tilt = (Math.random() - 0.5) * 0.4;
      p.spin = (Math.random() - 0.5) * 0.3;
      p.size = opts.size ?? 1;
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
