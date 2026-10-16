/** Bursts of stars, hearts, drops and sweat: one instanced draw of camera-facing quads from a small atlas drawn in
 *  code. The atlas stores masks, not colours (R: fill vs outline, G: gloss, B: shading), so every particle is tinted
 *  with a dark outline of its own hue: cartoon stickers in any colour from one texture. */
import * as THREE from "three";

export type BurstKind = "stars" | "hearts" | "drops" | "sweat";

const MAX = 320;
const CELL = 128;
const COLS = 4;
const ROWS = 2;
/** Atlas cells. */
const Cell = { Star: 0, Sparkle: 1, Heart: 2, Drop: 3, Dot: 4 } as const;
type Cell = (typeof Cell)[keyof typeof Cell];

interface KindSpec {
  count: number;
  cells: Cell[];
  tints: number[];
  speed: [number, number];
  /** How much the spray leans up (and towards the camera). */
  up: number;
  toCamera: number;
  gravity: number;
  drag: number;
  size: [number, number];
  life: [number, number];
  spin: number;
  /** Point along the motion (drops) instead of spinning. */
  orient: boolean;
  /** Side to side float (hearts). */
  sway: number;
}

const KINDS: Record<BurstKind, KindSpec> = {
  stars: {
    count: 10,
    cells: [Cell.Star, Cell.Star, Cell.Sparkle],
    tints: [0xffd23f, 0xffc21a, 0xff8fb1, 0x7fd8ff, 0x9ff0b8, 0xfff6d8],
    speed: [1.3, 2.4],
    up: 0.7,
    toCamera: 0.5,
    gravity: -2.2,
    drag: 2.6,
    size: [0.06, 0.12],
    life: [0.6, 1.05],
    spin: 7,
    orient: false,
    sway: 0,
  },
  hearts: {
    count: 7,
    cells: [Cell.Heart],
    tints: [0xff6f9c, 0xff4f7b, 0xff8fb8, 0xff5f6f],
    speed: [0.45, 1.05],
    up: 1.1,
    toCamera: 0.6,
    gravity: 0.7,
    drag: 1.6,
    size: [0.07, 0.13],
    life: [1.1, 1.7],
    spin: 1.2,
    orient: false,
    sway: 1,
  },
  drops: {
    count: 11,
    cells: [Cell.Drop, Cell.Drop, Cell.Dot],
    tints: [0x4fb7ff, 0x6fd3ff, 0x3f9bff, 0x9fe4ff],
    speed: [1.5, 2.8],
    up: 0.8,
    toCamera: 0.4,
    gravity: -9,
    drag: 0.5,
    size: [0.035, 0.075],
    life: [0.5, 0.9],
    spin: 0,
    orient: true,
    sway: 0,
  },
  sweat: {
    count: 3,
    cells: [Cell.Drop],
    tints: [0x9fdcff, 0x8fd0ff],
    speed: [0.9, 1.5],
    up: 1.2,
    toCamera: 0.3,
    gravity: -5,
    drag: 0.8,
    size: [0.075, 0.1],
    life: [0.7, 1.0],
    spin: 0,
    orient: true,
    sway: 0,
  },
};

interface Particle {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  age: number;
  life: number;
  size: number;
  rot: number;
  spin: number;
  cell: number;
  tint: THREE.Color;
  spec: KindSpec;
  phase: number;
}

function path(ctx: CanvasRenderingContext2D, cell: Cell, r: number): void {
  ctx.beginPath();
  switch (cell) {
    case Cell.Star: {
      for (let i = 0; i < 10; i++) {
        const a = -Math.PI / 2 + (i * Math.PI) / 5;
        const rr = i % 2 ? r * 0.48 : r;
        ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr + r * 0.06);
      }
      break;
    }
    case Cell.Sparkle: {
      ctx.moveTo(0, -r);
      ctx.quadraticCurveTo(r * 0.12, -r * 0.12, r, 0);
      ctx.quadraticCurveTo(r * 0.12, r * 0.12, 0, r);
      ctx.quadraticCurveTo(-r * 0.12, r * 0.12, -r, 0);
      ctx.quadraticCurveTo(-r * 0.12, -r * 0.12, 0, -r);
      break;
    }
    case Cell.Heart: {
      ctx.moveTo(0, r * 0.95);
      ctx.bezierCurveTo(-r * 1.25, r * 0.1, -r * 0.85, -r * 0.95, 0, -r * 0.42);
      ctx.bezierCurveTo(r * 0.85, -r * 0.95, r * 1.25, r * 0.1, 0, r * 0.95);
      break;
    }
    case Cell.Drop: {
      // Tip up, round bottom.
      ctx.moveTo(0, -r);
      ctx.bezierCurveTo(r * 0.25, -r * 0.5, r * 0.75, -r * 0.05, r * 0.72, r * 0.32);
      ctx.arc(0, r * 0.32, r * 0.72, 0, Math.PI);
      ctx.bezierCurveTo(-r * 0.75, -r * 0.05, -r * 0.25, -r * 0.5, 0, -r);
      break;
    }
    case Cell.Dot:
      ctx.arc(0, 0, r * 0.75, 0, Math.PI * 2);
      break;
  }
  ctx.closePath();
}

function drawAtlas(): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = CELL * COLS;
  canvas.height = CELL * ROWS;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.lineJoin = "round";
  const r = CELL * 0.34;
  for (const cell of [Cell.Star, Cell.Sparkle, Cell.Heart, Cell.Drop, Cell.Dot]) {
    ctx.save();
    ctx.translate((cell % COLS) * CELL + CELL / 2, Math.floor(cell / COLS) * CELL + CELL / 2);
    // Outline: the shape grown by a round stroke, all masks zero.
    path(ctx, cell, r);
    ctx.fillStyle = ctx.strokeStyle = "rgb(0,0,0)";
    ctx.lineWidth = CELL * 0.09;
    ctx.fill();
    ctx.stroke();
    // Fill (R = 1) with shading in B (lit top, darker bottom); a soft round inset so star tips stay chubby.
    path(ctx, cell, r);
    const g = ctx.createLinearGradient(0, -r, 0, r);
    g.addColorStop(0, "rgb(255,0,255)");
    g.addColorStop(1, "rgb(255,0,120)");
    ctx.fillStyle = g;
    ctx.fill();
    // Gloss (G = 1).
    ctx.fillStyle = "rgb(255,255,255)";
    ctx.beginPath();
    const hx = cell === Cell.Drop ? -r * 0.28 : -r * 0.3;
    const hy = cell === Cell.Drop ? r * 0.18 : cell === Cell.Heart ? -r * 0.35 : -r * 0.28;
    ctx.ellipse(hx, hy, r * 0.16, r * 0.1, -0.7, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  return canvas;
}

const VERT = /* glsl */ `
attribute vec3 iPos;
attribute vec4 iData; // size, rotation, alpha, cell
attribute vec3 iTint;
varying vec2 vUv;
varying vec3 vTint;
varying float vAlpha;
void main() {
  vec4 mv = viewMatrix * vec4(iPos, 1.0);
  float c = cos(iData.y), s = sin(iData.y);
  mv.xy += mat2(c, s, -s, c) * position.xy * iData.x;
  gl_Position = projectionMatrix * mv;
  float cell = iData.w;
  vec2 origin = vec2(mod(cell, ${COLS}.0), ${ROWS}.0 - 1.0 - floor(cell / ${COLS}.0));
  vUv = (origin + position.xy + 0.5) / vec2(${COLS}.0, ${ROWS}.0);
  vTint = iTint;
  vAlpha = iData.z;
}`;

const FRAG = /* glsl */ `
uniform sampler2D uAtlas;
varying vec2 vUv;
varying vec3 vTint;
varying float vAlpha;
void main() {
  vec4 t = texture2D(uAtlas, vUv);
  vec3 col = mix(vTint * 0.26, vTint * mix(0.72, 1.0, t.b), t.r);
  col = mix(col, vec3(1.0), t.g * 0.9);
  gl_FragColor = vec4(col, t.a * vAlpha);
  if (gl_FragColor.a < 0.01) discard;
  #include <colorspace_fragment>
}`;

export interface Particles {
  readonly mesh: THREE.Mesh;
  burst(at: THREE.Vector3, kind: BurstKind, camera: THREE.Camera, count?: number): void;
  update(dt: number, camera: THREE.Camera): void;
  dispose(): void;
}

const rand = (r: [number, number]) => r[0] + Math.random() * (r[1] - r[0]);
const pick = <T>(a: T[]) => a[Math.floor(Math.random() * a.length)];

export function createParticles(): Particles {
  const atlas = new THREE.CanvasTexture(drawAtlas());
  atlas.colorSpace = THREE.NoColorSpace; // masks, not colours

  const geo = new THREE.InstancedBufferGeometry();
  const quad = new THREE.PlaneGeometry(1, 1);
  geo.index = quad.index;
  geo.setAttribute("position", quad.getAttribute("position"));
  const iPos = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 3), 3).setUsage(THREE.DynamicDrawUsage);
  const iData = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 4), 4).setUsage(THREE.DynamicDrawUsage);
  const iTint = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 3), 3).setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute("iPos", iPos);
  geo.setAttribute("iData", iData);
  geo.setAttribute("iTint", iTint);
  geo.instanceCount = 0;

  const mat = new THREE.ShaderMaterial({
    uniforms: { uAtlas: { value: atlas } },
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = "stage-particles";
  mesh.frustumCulled = false;
  mesh.renderOrder = 10;

  const live: Particle[] = [];
  const free: Particle[] = [];
  const toCam = new THREE.Vector3();
  const dir = new THREE.Vector3();
  const view = new THREE.Vector3();

  return {
    mesh,
    burst(at, kind, camera, count) {
      const spec = KINDS[kind];
      const n = Math.max(1, Math.round(count ?? spec.count));
      toCam.copy(camera.position).sub(at).normalize();
      for (let i = 0; i < n; i++) {
        // Full: the oldest particle is recycled.
        const p: Particle = (live.length >= MAX ? live.shift() : free.pop()) ?? {
          pos: new THREE.Vector3(),
          vel: new THREE.Vector3(),
          age: 0,
          life: 1,
          size: 1,
          rot: 0,
          spin: 0,
          cell: 0,
          tint: new THREE.Color(),
          spec,
          phase: 0,
        };
        dir.randomDirection();
        dir.y = Math.abs(dir.y) * 0.5 + spec.up;
        dir.addScaledVector(toCam, spec.toCamera).normalize();
        p.pos.copy(at).addScaledVector(toCam, 0.08);
        p.vel.copy(dir).multiplyScalar(rand(spec.speed));
        p.age = 0;
        p.life = rand(spec.life);
        p.size = rand(spec.size);
        p.rot = (Math.random() - 0.5) * 0.8;
        p.spin = (Math.random() - 0.5) * 2 * spec.spin;
        p.cell = pick(spec.cells);
        p.tint.set(pick(spec.tints));
        p.spec = spec;
        p.phase = Math.random() * Math.PI * 2;
        live.push(p);
      }
    },
    update(dt, camera) {
      const inv = camera.matrixWorldInverse;
      let n = 0;
      for (let i = 0; i < live.length; i++) {
        const p = live[i];
        p.age += dt;
        if (p.age >= p.life) {
          free.push(p);
          continue;
        }
        const s = p.spec;
        p.vel.y += s.gravity * dt;
        p.vel.multiplyScalar(Math.exp(-s.drag * dt));
        p.pos.addScaledVector(p.vel, dt);
        if (s.sway) p.pos.x += Math.cos(p.age * 5 + p.phase) * s.sway * 0.25 * dt;
        if (s.orient) {
          view.copy(p.vel).transformDirection(inv);
          p.rot = Math.atan2(view.x, -view.y);
        } else {
          p.rot += p.spin * dt;
        }
        const u = p.age / p.life;
        const pop = Math.min(1, p.age / 0.09);
        const grow = pop < 1 ? pop * (1.35 - 0.35 * pop) : 1;
        const shrink = u > 0.7 ? 1 - (u - 0.7) / 0.3 : 1;
        live[n++] = p;
        const j = n - 1;
        iPos.setXYZ(j, p.pos.x, p.pos.y, p.pos.z);
        iData.setXYZW(j, p.size * grow * (0.4 + 0.6 * shrink), p.rot, shrink, p.cell);
        iTint.setXYZ(j, p.tint.r, p.tint.g, p.tint.b);
      }
      live.length = n;
      geo.instanceCount = n;
      if (n > 0) {
        for (const a of [iPos, iData, iTint]) {
          a.clearUpdateRanges();
          a.addUpdateRange(0, n * a.itemSize);
          a.needsUpdate = true;
        }
      }
      mesh.visible = n > 0;
    },
    dispose() {
      geo.dispose();
      quad.dispose();
      mat.dispose();
      atlas.dispose();
    },
  };
}
