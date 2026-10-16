/** Dev page for the stage: the real 奶蛙 (src/character) on toy physics to poke, slap, grab and throw, balls to throw
 *  at it, and frame timing. URL: ?theme=dark, ?clean (no HUD, for screenshots). window.__dev for scripted checks. */
import * as THREE from "three";
import { loadCharacter, type NaiwaCharacter } from "../src/character";
import type { BoneName, FrogEvent, HitRegion, PointerInfo } from "../src/contracts";
import { createStage } from "../src/stage";

const params = new URLSearchParams(location.search);
const container = document.getElementById("stage")!;
const stage = createStage(container);
let theme: "light" | "dark" = params.get("theme") === "dark" ? "dark" : "light";
stage.setTheme(theme);
if (params.has("clean")) document.body.classList.add("clean");

/* ---------------------------------------------------------------------------------------------------------------- */
/* The real frog (src/character, public/models/naiwa.glb) on toy physics: thrown as a whole, squash and tilt springs. */
/* The simulation is not part of this page; the frog shows its idle stance and the rest body moved as one piece.     */
/* ---------------------------------------------------------------------------------------------------------------- */

const statusEl = document.getElementById("stats")!;
let character: NaiwaCharacter;
try {
  character = await loadCharacter("/models/naiwa.glb");
} catch (e) {
  statusEl.textContent = String(e);
  throw e;
}
stage.scene.add(character.object);
const restBody = character.spec.body.positions;
const body = new Float32Array(restBody.length);
const targets = new Map<BoneName, THREE.Matrix4>();
const bones = new Map<BoneName, THREE.Matrix4>();
// Hit proxy: the rest Body surface, moved with the toy transform.
const proxyGeo = new THREE.BufferGeometry();
proxyGeo.setAttribute("position", new THREE.BufferAttribute(restBody, 3));
proxyGeo.setIndex(new THREE.BufferAttribute(character.spec.body.indices, 1));
proxyGeo.computeBoundingSphere();
const proxy = new THREE.Mesh(proxyGeo, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
proxy.matrixAutoUpdate = false;
const restCenter = new THREE.Vector3();
new THREE.Box3().setFromBufferAttribute(proxyGeo.getAttribute("position") as THREE.BufferAttribute).getCenter(restCenter);

const frog = {
  pos: new THREE.Vector3(),
  vel: new THREE.Vector3(),
  squash: 0,
  squashVel: 0,
  tiltVel: new THREE.Vector2(),
  tilt: new THREE.Vector2(),
  grabbed: false,
  grabOffset: new THREE.Vector3(),
  grabPlane: new THREE.Plane(),
};
const toy = new THREE.Matrix4();
const GRAVITY = -9.8;
const center = () => restCenter.clone().applyMatrix4(toy);

const raycaster = new THREE.Raycaster();
function hitFrog(ray: THREE.Ray): THREE.Intersection | null {
  raycaster.ray.copy(ray);
  proxy.matrixWorld.copy(toy);
  return raycaster.intersectObject(proxy, false)[0] ?? null;
}
const region = (hit: THREE.Intersection): HitRegion => {
  const local = hit.point.clone().applyMatrix4(toy.clone().invert());
  return local.y > 0.72 ? "head" : local.z > 0.1 && local.y > 0.25 && local.y < 0.65 ? "belly" : "body";
};

const balls: { p: THREE.Vector3; v: THREE.Vector3; r: number }[] = [];
const ballData = () => {
  const a = new Float32Array(balls.length * 4);
  balls.forEach((b, i) => a.set([b.p.x, b.p.y, b.p.z, b.r], i * 4));
  return a;
};
function throwBall(toward: THREE.Vector3) {
  const from = stage.camera.position.clone().add(new THREE.Vector3(0, -0.2, 0));
  const t = 0.55;
  const v = toward.clone().sub(from).divideScalar(t);
  v.y -= (GRAVITY * t) / 2;
  balls.push({ p: from, v, r: 0.07 + Math.random() * 0.05 });
  if (balls.length > 60) balls.shift();
}

const texts = ["DUANG~", "噗!", "哈哈哈", "Boing!", "嘿嘿~", "咕叽", "Q弹!"];
const pick = <T>(a: T[]) => a[Math.floor(Math.random() * a.length)];
const fx = stage.fx;

const react = (kind: FrogEvent["kind"], point: THREE.Vector3, strength: number, where?: HitRegion) =>
  character.react({ kind, point, strength, region: where });

function poke(hit: THREE.Intersection, strength: number) {
  const at = hit.point;
  react("poke", at, strength, region(hit));
  frog.squashVel += 3.5 * strength;
  const d = at.clone().sub(center()).normalize();
  frog.tiltVel.x -= d.z * 4 * strength;
  frog.tiltVel.y += d.x * 4 * strength;
  fx.popText(at, pick(texts));
  fx.burst(at, Math.random() < 0.5 ? "stars" : "hearts");
  fx.shake(0.25 * strength);
}

/* ---------------------------------------------------------------------------------------------------------------- */
/* Gestures.                                                                                                       */
/* ---------------------------------------------------------------------------------------------------------------- */

const pxToWorld = () => {
  const d = stage.camera.position.distanceTo(center());
  return (2 * d * Math.tan(THREE.MathUtils.degToRad(stage.camera.fov) / 2)) / container.clientHeight;
};
const log: string[] = [];
const note = (s: string) => {
  log.push(`${Math.round(performance.now())} ${s}`);
  if (log.length > 40) log.shift();
};

function grabPoint(p: PointerInfo, out: THREE.Vector3) {
  return p.ray.intersectPlane(frog.grabPlane, out);
}

stage.setGestureHandler({
  hitTest: (ray) => hitFrog(ray) !== null,
  onPressStart: () => note("pressStart"),
  onPressEnd: () => note("pressEnd"),
  onTap(p) {
    const hit = hitFrog(p.ray);
    note(`tap ${hit ? "frog" : "background"}`);
    if (hit) poke(hit, 1);
    else {
      const floorHit = p.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), new THREE.Vector3());
      throwBall(floorHit && floorHit.distanceTo(frog.pos) < 4 ? floorHit : center());
    }
  },
  onSwipe(p, v) {
    const hit = hitFrog(p.ray)?.point ?? center();
    note(`swipe ${Math.round(v.length())}px/s`);
    react("slap", hit, 1);
    const k = pxToWorld();
    const right = new THREE.Vector3().setFromMatrixColumn(stage.camera.matrixWorld, 0);
    frog.vel.addScaledVector(right, v.x * k * 0.25);
    frog.vel.y += 1.2;
    frog.squashVel += 4;
    frog.tiltVel.y += (v.x > 0 ? 1 : -1) * 6;
    fx.popText(hit, "啪!", { color: "#ff5e5e", size: 1.2 });
    fx.burst(hit, "stars", 14);
    fx.burst(center().add(new THREE.Vector3(0, 0.4, 0)), "sweat");
    fx.shake(0.6);
  },
  onDragStart(p) {
    note("dragStart");
    const hit = hitFrog(p.ray)?.point ?? center();
    react("grab", hit, 0.6);
    const n = new THREE.Vector3().subVectors(stage.camera.position, hit).setY(0).normalize();
    frog.grabPlane.setFromNormalAndCoplanarPoint(n, hit);
    frog.grabOffset.copy(frog.pos).sub(hit);
    frog.grabbed = true;
    frog.vel.set(0, 0, 0);
  },
  onDragMove(p) {
    const q = grabPoint(p, new THREE.Vector3());
    if (!q) return;
    const target = q.add(frog.grabOffset);
    target.y = Math.max(0, target.y);
    frog.vel.copy(target).sub(frog.pos).multiplyScalar(60);
    frog.pos.copy(target);
  },
  onDragEnd(_p, v) {
    note(`dragEnd ${Math.round(v.length())}px/s`);
    frog.grabbed = false;
    react("release", center(), Math.min(1, v.length() / 2000));
    const k = pxToWorld();
    const right = new THREE.Vector3().setFromMatrixColumn(stage.camera.matrixWorld, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(stage.camera.matrixWorld, 1);
    frog.vel.copy(right).multiplyScalar(v.x * k).addScaledVector(up, -v.y * k).clampLength(0, 9);
    if (v.length() > 600) fx.popText(center(), "咻~", { color: "#3fb8ff" });
  },
  onHover(p) {
    character.lookAt(p ? p.ray.at(p.ray.origin.distanceTo(center()), new THREE.Vector3()) : null);
  },
});

/* ---------------------------------------------------------------------------------------------------------------- */
/* Loop and timing.                                                                                                */
/* ---------------------------------------------------------------------------------------------------------------- */

const gl = stage.renderer.getContext() as WebGL2RenderingContext;
type TimerExt = { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number };
let timerExt = gl.getExtension("EXT_disjoint_timer_query_webgl2") as TimerExt | null;
const pending: WebGLQuery[] = [];
// Headless Chrome here loses and restores its first context at startup: extensions and queries die with it.
stage.canvas.addEventListener("webglcontextrestored", () => {
  pending.length = 0;
  timerExt = gl.getExtension("EXT_disjoint_timer_query_webgl2") as TimerExt | null;
});
const samples = { cpu: [] as number[], gpu: [] as number[], frame: [] as number[] };
const push = (a: number[], v: number) => {
  a.push(v);
  if (a.length > 240) a.shift();
};
const avg = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
const pct = (a: number[], q: number) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor((a.length - 1) * q)] : NaN);

let last = performance.now();
let wasAir = false;
function tick(now: number) {
  const dt = Math.min(0.05, (now - last) / 1000);
  push(samples.frame, now - last);
  last = now;

  if (!frog.grabbed) {
    frog.vel.y += GRAVITY * dt;
    frog.pos.addScaledVector(frog.vel, dt);
    const r = Math.hypot(frog.pos.x, frog.pos.z);
    if (r > 6) {
      frog.pos.x *= 6 / r;
      frog.pos.z *= 6 / r;
      frog.vel.x *= -0.5;
      frog.vel.z *= -0.5;
    }
    if (frog.pos.y <= 0) {
      if (wasAir && frog.vel.y < -2.5) {
        const s = Math.min(1, -frog.vel.y / 8);
        fx.popText(center(), pick(["噗!", "DUANG~", "咚!"]), { size: 0.8 + 0.5 * s });
        fx.burst(new THREE.Vector3(frog.pos.x, 0.05, frog.pos.z), "drops");
        fx.shake(0.5 * s);
        react("land", center(), s);
        frog.squashVel += 6 * s;
      }
      frog.pos.y = 0;
      frog.vel.y = frog.vel.y < -1 ? -frog.vel.y * 0.35 : 0;
      frog.vel.x *= Math.exp(-6 * dt);
      frog.vel.z *= Math.exp(-6 * dt);
    }
    wasAir = frog.pos.y > 0.02;
  }
  // Jelly: damped springs for squash and tilt.
  frog.squashVel += (-160 * frog.squash - 7 * frog.squashVel) * dt;
  frog.squash += frog.squashVel * dt;
  frog.tiltVel.x += (-90 * frog.tilt.x - 6 * frog.tiltVel.x) * dt;
  frog.tiltVel.y += (-90 * frog.tilt.y - 6 * frog.tiltVel.y) * dt;
  frog.tilt.addScaledVector(frog.tiltVel, dt);
  // The toy transform: position, a squash about the feet (volume roughly kept) and a wobbly tilt.
  const sq = THREE.MathUtils.clamp(frog.squash * 0.1, -0.3, 0.3);
  toy
    .makeTranslation(frog.pos.x, frog.pos.y, frog.pos.z)
    .multiply(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(frog.tilt.x * 0.12, 0, -frog.tilt.y * 0.12)))
    .multiply(new THREE.Matrix4().makeScale(1 + sq * 0.6, 1 - sq, 1 + sq * 0.6));
  character.targetsFromPose(null, targets);
  for (const [name, m] of targets) (bones.get(name) ?? bones.set(name, new THREE.Matrix4()).get(name)!).multiplyMatrices(toy, m);
  const e = toy.elements;
  for (let i = 0; i < restBody.length; i += 3) {
    const x = restBody[i], y = restBody[i + 1], z = restBody[i + 2];
    body[i] = e[0] * x + e[4] * y + e[8] * z + e[12];
    body[i + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
    body[i + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
  }
  character.applySim(bones, body);
  character.update(dt, stage.camera);

  for (const b of balls) {
    b.v.y += GRAVITY * dt;
    b.p.addScaledVector(b.v, dt);
    if (b.p.y < b.r) {
      b.p.y = b.r;
      b.v.y = Math.abs(b.v.y) * 0.6;
      b.v.x *= 0.92;
      b.v.z *= 0.92;
    }
    const c = center();
    const d = b.p.clone().sub(c);
    const minD = 0.4 + b.r;
    if (d.length() < minD) {
      const n = d.normalize();
      b.p.copy(c).addScaledVector(n, minD);
      const vn = b.v.dot(n);
      if (vn < 0) {
        b.v.addScaledVector(n, -1.6 * vn);
        if (vn < -2) {
          fx.popText(b.p.clone(), pick(["咚!", "Boing!"]), { size: 0.7 });
          react("ball", b.p.clone(), Math.min(1, -vn / 6));
          frog.squashVel += 2;
        }
      }
    }
  }
  stage.setBalls(ballData());
  stage.setFocus(character.center(new THREE.Vector3()));

  let query: WebGLQuery | null = null;
  if (timerExt && !gl.isContextLost()) {
    query = gl.createQuery()!;
    gl.beginQuery(timerExt.TIME_ELAPSED_EXT, query);
  }
  stage.frame(dt);
  if (query && timerExt) {
    gl.endQuery(timerExt.TIME_ELAPSED_EXT);
    pending.push(query);
  }
  while (pending.length && gl.getQueryParameter(pending[0], gl.QUERY_RESULT_AVAILABLE)) {
    const q = pending.shift()!;
    if (!gl.getParameter(timerExt!.GPU_DISJOINT_EXT)) push(samples.gpu, gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6);
    gl.deleteQuery(q);
  }
  push(samples.cpu, stage.info.cpuMs);
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

setInterval(() => {
  const i = stage.info;
  statusEl.textContent =
    `frame ${avg(samples.frame).toFixed(1)} ms  stage cpu ${avg(samples.cpu).toFixed(2)} ms (p95 ${pct(samples.cpu, 0.95).toFixed(2)})` +
    `  gpu ${timerExt ? avg(samples.gpu).toFixed(2) + " ms" : "n/a"}\n` +
    `draws ${i.drawCalls}  tris ${i.triangles}  dpr ${i.pixelRatio}  ${container.clientWidth}x${container.clientHeight}\n` +
    log.slice(-4).join("\n");
}, 500);

/* ---------------------------------------------------------------------------------------------------------------- */
/* HUD and scripted checks.                                                                                        */
/* ---------------------------------------------------------------------------------------------------------------- */

const head = () => center().add(new THREE.Vector3(0, 0.35, 0.15));
const acts: Record<string, () => void> = {
  theme: () => stage.setTheme((theme = theme === "light" ? "dark" : "light")),
  stars: () => fx.burst(head(), "stars"),
  hearts: () => fx.burst(head(), "hearts"),
  drops: () => fx.burst(head(), "drops"),
  sweat: () => fx.burst(head(), "sweat"),
  text: () => fx.popText(head(), pick(texts)),
  shake: () => fx.shake(0.8),
  balls: () => {
    for (let i = 0; i < 16; i++)
      balls.push({
        p: new THREE.Vector3((Math.random() - 0.5) * 2.5, 2.5 + Math.random() * 1.5, (Math.random() - 0.5) * 2.5),
        v: new THREE.Vector3(),
        r: 0.07 + Math.random() * 0.05,
      });
  },
  reset: () => {
    frog.pos.set(0, 0, 0);
    frog.vel.set(0, 0, 0);
    balls.length = 0;
    stage.resetView();
  },
};
document.getElementById("hud")!.addEventListener("click", (e) => {
  const act = (e.target as HTMLElement).dataset.act;
  if (act) acts[act]();
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
Object.assign(window, {
  __dev: {
    stage,
    frog,
    acts,
    log,
    /** Pop a showcase of effects and resolve once they are mid-flight. */
    async showcase(ms = 260) {
      fx.popText(center().add(new THREE.Vector3(-0.25, 0.25, 0.3)), "DUANG~");
      fx.popText(center().add(new THREE.Vector3(0.35, 0.05, 0.3)), "哈哈哈", { color: "#ffb020" });
      fx.burst(center().add(new THREE.Vector3(-0.3, 0.1, 0.3)), "stars", 14);
      fx.burst(center().add(new THREE.Vector3(0.3, 0.3, 0.3)), "hearts", 8);
      fx.burst(head().add(new THREE.Vector3(0.2, 0.05, 0)), "sweat");
      fx.burst(center().add(new THREE.Vector3(0, -0.3, 0.4)), "drops");
      await wait(ms);
      return true;
    },
    async measure(ms = 3000) {
      samples.cpu.length = samples.gpu.length = samples.frame.length = 0;
      await wait(ms);
      return {
        frameMs: +avg(samples.frame).toFixed(2),
        stageCpuMs: +avg(samples.cpu).toFixed(3),
        stageCpuP95: +pct(samples.cpu, 0.95).toFixed(3),
        gpuMs: timerExt ? +avg(samples.gpu).toFixed(3) : null,
        gpuP95: timerExt ? +pct(samples.gpu, 0.95).toFixed(3) : null,
        draws: stage.info.drawCalls,
        tris: stage.info.triangles,
        dpr: stage.info.pixelRatio,
      };
    },
  },
});
