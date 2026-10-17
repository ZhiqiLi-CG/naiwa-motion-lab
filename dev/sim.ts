/**
 * Dev page for the simulation: the flesh surfaces, particles (red = riding a bone), bones and collision skins of the
 * simulated frog, with pokes (click), grabs and throws (drag), slaps (shift-drag), balls (B), a driven test dance (D),
 * the physics sliders and the build options to compare (URL: ?rig=test|glb&bp=400&lp=60&model=volume|neo|corot
 * &sm=0|1&vp=0|1&pgs=3&show=particles,bones,skin).
 */
import RAPIER from "@dimforge/rapier3d-compat";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { BoneName, FrogEvent, GrabHandle, PhysicsParams, RigSpec } from "../src/contracts";
import { createFrogSim, initPhysics, type DebugFrogSim, type SimTuning } from "../src/sim";
import { createTestRigSpec } from "../src/sim/testRig";

const url = new URLSearchParams(location.search);
const num = (k: string, d: number) => (url.has(k) ? Number(url.get(k)) : d);
const show = new Set((url.get("show") ?? "particles,bones").split(","));
const MODELS: Record<string, RAPIER.SoftBodyCellModel> = {
  volume: RAPIER.SoftBodyCellModel.Volume,
  neo: RAPIER.SoftBodyCellModel.NeoHookean,
  corot: RAPIER.SoftBodyCellModel.Corotational,
};

const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
document.body.prepend(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xdfe3e6);
const camera = new THREE.PerspectiveCamera(35, innerWidth / innerHeight, 0.05, 50);
camera.position.set(num("cx", 1.6), num("cy", 1.1), num("cz", 2.4));
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0.5, 0);
controls.update();
scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8a7a, 1.6));
const sun = new THREE.DirectionalLight(0xffffff, 2.2);
sun.position.set(2, 4, 3);
scene.add(sun);
const grid = new THREE.GridHelper(6, 30, 0x8899aa, 0xb8c2cc);
scene.add(grid);
addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

const params: PhysicsParams = {
  softness: num("soft", 0.5), bounciness: num("bounce", 0.5), gravity: num("g", 1), bellySize: num("belly", 1),
  stubbornness: num("stub", 0.8),
};
const tuning: Partial<SimTuning> = {
  body: {
    particles: num("bp", 400), cellModel: MODELS[url.get("model") ?? "volume"], shapeMatching: url.get("sm") === "1",
    volumePreservation: url.get("vp") !== "0", pgsIterations: num("pgs", 3),
  },
  limb: {
    particles: num("lp", 60), cellModel: MODELS[url.get("model") ?? "volume"], shapeMatching: url.get("sm") === "1",
    volumePreservation: url.get("vp") !== "0", pgsIterations: num("pgs", 3),
  },
};

async function loadSpec(): Promise<RigSpec> {
  if (url.get("rig") === "glb") {
    const { loadCharacter } = await import("../src/character");
    return (await loadCharacter("/models/naiwa.glb")).spec;
  }
  return createTestRigSpec({ limbs: url.get("limbs") !== "0" });
}

await initPhysics();
const spec = await loadSpec();
let sim: DebugFrogSim = createFrogSim(spec, params, tuning);
const events: string[] = [];
const onEvent = (e: FrogEvent) => {
  events.unshift(`${e.kind} ${e.strength.toFixed(2)}${e.region ? " " + e.region : ""}`);
  events.length = Math.min(events.length, 8);
};
sim.onEvent(onEvent);

/* Drawing ---------------------------------------------------------------------------------------------------- */

const COLORS: Record<string, number> = { body: 0xf2c94c, arm_L: 0xe0b53c, arm_R: 0xe0b53c, leg_L: 0xd9ab35, leg_R: 0xd9ab35 };
interface PartView {
  name: string;
  mesh: THREE.Mesh;
  points: THREE.Points;
  skin: THREE.LineSegments;
  skinMesh: number;
}
const views: PartView[] = [];
const surfaces: { name: string; positions: Float32Array; indices: Uint32Array }[] = [
  { name: spec.body.name ?? "body", positions: spec.body.positions, indices: spec.body.indices },
  ...(spec.limbs ?? []),
];
function buildViews() {
  for (const v of views) scene.remove(v.mesh, v.points, v.skin);
  views.length = 0;
  sim.flesh.forEach((f, k) => {
    const s = surfaces[k];
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(s.positions.slice(), 3));
    g.setIndex(new THREE.BufferAttribute(s.indices, 1));
    g.computeVertexNormals();
    const mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({
      color: COLORS[s.name] ?? 0xe0b53c, roughness: 0.5, transparent: show.has("xray"), opacity: show.has("xray") ? 0.45 : 1,
    }));
    scene.add(mesh);
    const n = f.soft.numParticles();
    const pg = new THREE.BufferGeometry();
    pg.setAttribute("position", new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    const col = new Float32Array(n * 3);
    const free = new Set(f.free);
    for (let i = 0; i < n; i++) col.set(free.has(i) ? [0.15, 0.35, 1] : [1, 0.15, 0.1], i * 3);
    pg.setAttribute("color", new THREE.BufferAttribute(col, 3));
    const points = new THREE.Points(pg, new THREE.PointsMaterial({ size: 0.018, vertexColors: true, depthTest: false }));
    points.renderOrder = 2;
    points.visible = show.has("particles");
    scene.add(points);
    let skinMesh = 0;
    for (let m = 0; m < f.soft.numMeshes(); m++) if (f.soft.meshCollisionEnabled(m)) skinMesh = m;
    const tri = f.soft.meshIndices(skinMesh);
    const edges: number[] = [];
    for (let t = 0; t < tri.length; t += 3) edges.push(tri[t], tri[t + 1], tri[t + 1], tri[t + 2], tri[t + 2], tri[t]);
    const sg = new THREE.BufferGeometry();
    sg.setAttribute("position", new THREE.BufferAttribute(f.soft.meshVertices(skinMesh), 3));
    sg.setIndex(edges);
    const skin = new THREE.LineSegments(sg, new THREE.LineBasicMaterial({ color: 0x225522, depthTest: false }));
    skin.visible = show.has("skin");
    scene.add(skin);
    views.push({ name: s.name, mesh, points, skin, skinMesh });
  });
}
buildViews();

const boneLines = new THREE.LineSegments(
  new THREE.BufferGeometry().setAttribute("position", new THREE.BufferAttribute(new Float32Array(17 * 6), 3)),
  new THREE.LineBasicMaterial({ color: 0x111111, depthTest: false }),
);
boneLines.renderOrder = 3;
scene.add(boneLines);
const ballMeshes: THREE.Mesh[] = [];
const ballMaterial = new THREE.MeshStandardMaterial({ color: 0xff5a7a, roughness: 0.35 });
const boneMats = new Map<BoneName, THREE.Matrix4>();
const limbOut = new Map<string, Float32Array>();
const tailLocal = new Map<BoneName, THREE.Vector3>(
  spec.bones.map((b) => [b.name, b.tail.clone().applyMatrix4(b.restWorld.clone().invert())]),
);

function draw() {
  sim.readLimbs(limbOut);
  const body = sim.readBody();
  views.forEach((v, k) => {
    const src = k === 0 ? body : limbOut.get(v.name);
    if (!src) return;
    const attr = v.mesh.geometry.getAttribute("position") as THREE.BufferAttribute;
    (attr.array as Float32Array).set(src);
    attr.needsUpdate = true;
    v.mesh.geometry.computeVertexNormals();
    const f = sim.flesh[k];
    if (v.points.visible) {
      const pa = v.points.geometry.getAttribute("position") as THREE.BufferAttribute;
      (pa.array as Float32Array).set(f.soft.particlePositions());
      pa.needsUpdate = true;
    }
    if (v.skin.visible) {
      const sa = v.skin.geometry.getAttribute("position") as THREE.BufferAttribute;
      (sa.array as Float32Array).set(f.soft.meshVertices(v.skinMesh));
      sa.needsUpdate = true;
    }
  });
  sim.readBones(boneMats);
  const la = boneLines.geometry.getAttribute("position") as THREE.BufferAttribute;
  let k = 0;
  for (const [name, m] of boneMats) {
    const a = new THREE.Vector3().setFromMatrixPosition(m);
    const b = (tailLocal.get(name) ?? new THREE.Vector3()).clone().applyMatrix4(m);
    la.setXYZ(k++, a.x, a.y, a.z);
    la.setXYZ(k++, b.x, b.y, b.z);
  }
  la.needsUpdate = true;
  boneLines.visible = show.has("bones");
  const balls = sim.readBalls();
  while (ballMeshes.length < balls.length / 4) {
    const m = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 14), ballMaterial);
    scene.add(m);
    ballMeshes.push(m);
  }
  ballMeshes.forEach((m, i) => {
    m.visible = i < balls.length / 4;
    if (m.visible) {
      m.position.set(balls[i * 4], balls[i * 4 + 1], balls[i * 4 + 2]);
      m.scale.setScalar(balls[i * 4 + 3]);
    }
  });
}

/* A driven test dance: hops with the hands on the belly (FK of the rest skeleton) ------------------------------ */

const restWorld = new Map(spec.bones.map((b) => [b.name, b.restWorld]));
const targets = new Map<BoneName, THREE.Matrix4>();
/** World matrix of a bone aimed from its (posed) head at a point, keeping its rest roll. */
function aim(name: BoneName, head: THREE.Vector3, at: THREE.Vector3): THREE.Matrix4 {
  const rest = restWorld.get(name)!;
  const restRot = new THREE.Quaternion().setFromRotationMatrix(rest);
  const restDir = (tailLocal.get(name) ?? new THREE.Vector3(0, 1, 0)).clone().applyQuaternion(restRot).normalize();
  const q = new THREE.Quaternion().setFromUnitVectors(restDir, at.clone().sub(head).normalize()).multiply(restRot);
  return new THREE.Matrix4().compose(head, q, new THREE.Vector3(1, 1, 1));
}
function dancePose(t: number) {
  const hop = Math.max(0, Math.sin(t * Math.PI * 2 * 1.1)) * 0.11;
  const sway = Math.sin(t * Math.PI * 1.1) * 0.12;
  const lift = new THREE.Matrix4().makeTranslation(0, hop, 0).multiply(new THREE.Matrix4().makeRotationY(sway));
  // Rest FK, with the whole frog lifted and swayed, then the arms aimed at the belly.
  for (const b of spec.bones) targets.set(b.name, lift.clone().multiply(restWorld.get(b.name)!));
  const lean = new THREE.Matrix4().makeRotationX(0.12 + 0.08 * Math.sin(t * 7));
  for (const name of ["chest", "head"] as BoneName[]) {
    const spine = targets.get("spine")!, rel = restWorld.get("spine")!.clone().invert().multiply(restWorld.get(name)!);
    targets.set(name, spine.clone().multiply(lean).multiply(rel));
  }
  for (const [s, side] of [[1, "L"], [-1, "R"]] as const) {
    const chest = targets.get("chest")!, restChest = restWorld.get("chest")!;
    const shoulder = new THREE.Vector3().setFromMatrixPosition(restWorld.get(`upperarm_${side}`)!)
      .applyMatrix4(restChest.clone().invert()).applyMatrix4(chest);
    const world = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z).applyMatrix4(lift);
    const elbow = world(s * 0.255, 0.55, 0.06);
    const wrist = world(s * 0.11, 0.5, 0.25 + 0.02 * Math.sin(t * 9));
    const palm = world(s * 0.04, 0.48, 0.26);
    targets.set(`upperarm_${side}`, aim(`upperarm_${side}`, shoulder, elbow));
    targets.set(`forearm_${side}`, aim(`forearm_${side}`, elbow, wrist));
    targets.set(`hand_${side}`, aim(`hand_${side}`, wrist, palm));
  }
  return targets;
}

/* Interaction ------------------------------------------------------------------------------------------------- */

const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
let press: { x: number; y: number; hit: ReturnType<DebugFrogSim["raycast"]>; shift: boolean } | null = null;
let grab: GrabHandle | null = null;
let grabPlane = new THREE.Plane();
let last: { p: THREE.Vector3; t: number } | null = null;
let velocity = new THREE.Vector3();
function rayAt(e: PointerEvent): THREE.Ray {
  ndc.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  return raycaster.ray.clone();
}
renderer.domElement.addEventListener("pointerdown", (e) => {
  const hit = sim.raycast(rayAt(e));
  if (!hit) return;
  controls.enabled = false;
  press = { x: e.clientX, y: e.clientY, hit, shift: e.shiftKey };
  grabPlane.setFromNormalAndCoplanarPoint(camera.getWorldDirection(new THREE.Vector3()).negate(), hit.point);
});
addEventListener("pointermove", (e) => {
  if (!press) return;
  const p = rayAt(e).intersectPlane(grabPlane, new THREE.Vector3());
  if (!p) return;
  const now = performance.now();
  if (last) velocity.copy(p).sub(last.p).multiplyScalar(1000 / Math.max(1, now - last.t)).lerp(velocity, 0.5);
  last = { p, t: now };
  if (Math.hypot(e.clientX - press.x, e.clientY - press.y) < 6) return;
  if (press.shift) {
    sim.slap(p, velocity.clone().clampLength(0, 14));
    press = null;
    return;
  }
  grab ??= sim.grab(press.hit!);
  grab.move(p);
});
addEventListener("pointerup", (e) => {
  if (press && !grab) sim.poke(press.hit!, 0.7, rayAt(e).direction);
  grab?.release(velocity.clone());
  grab = null;
  press = null;
  last = null;
  controls.enabled = true;
});

let dancing = url.get("dance") === "1";
let paused = false;
let danceTime = 0;
function throwBall() {
  const dir = camera.getWorldDirection(new THREE.Vector3());
  const origin = camera.position.clone().addScaledVector(dir, 0.4);
  const to = new THREE.Vector3(0, 0.5, 0).sub(origin).normalize();
  sim.throwBall(origin, to.multiplyScalar(9), 0.08);
}
addEventListener("keydown", (e) => {
  if (e.key === "b") throwBall();
  if (e.key === "r") sim.reset();
  if (e.key === "d") setDance(!dancing);
  if (e.key === " ") paused = !paused;
});
function setDance(on: boolean) {
  dancing = on;
  sim.setMode(on ? "driven" : "free");
}
setDance(dancing);

/* Panel -------------------------------------------------------------------------------------------------------- */

const panel = document.getElementById("panel")!;
const statsEl = document.getElementById("stats")!;
function slider(label: string, key: keyof PhysicsParams, min: number, max: number) {
  const row = document.createElement("label");
  const input = Object.assign(document.createElement("input"), { type: "range", min, max, step: 0.01, value: params[key] });
  const out = document.createElement("span");
  out.textContent = String(params[key]);
  input.addEventListener("input", () => {
    (params[key] as number) = Number(input.value);
    out.textContent = input.value;
    sim.setParams(params);
  });
  row.append(label, input, out);
  panel.append(row);
}
slider("softness", "softness", 0, 1);
slider("bounciness", "bounciness", 0, 1);
slider("gravity", "gravity", 0, 2);
slider("bellySize", "bellySize", 0.6, 1.8);
slider("stubborn", "stubbornness", 0, 1);
const buttons = document.createElement("div");
buttons.className = "row";
for (const [label, fn] of [
  ["dance (D)", () => setDance(!dancing)],
  ["ball (B)", throwBall],
  ["reset (R)", () => sim.reset()],
  ["clear balls", () => sim.clearBalls()],
] as const) {
  const b = Object.assign(document.createElement("button"), { textContent: label });
  b.addEventListener("click", fn);
  buttons.append(b);
}
panel.append(buttons);
const toggles = document.createElement("div");
toggles.className = "row";
for (const key of ["particles", "bones", "skin", "xray"]) {
  const l = document.createElement("label");
  l.style.display = "inline-flex";
  const c = Object.assign(document.createElement("input"), { type: "checkbox", checked: show.has(key) });
  c.addEventListener("change", () => {
    if (c.checked) show.add(key);
    else show.delete(key);
    buildViews();
  });
  l.append(c, key);
  toggles.append(l);
}
panel.append(toggles);

/* Loop --------------------------------------------------------------------------------------------------------- */

const stepTimes: number[] = [];
let prev = performance.now();
function frame(now: number) {
  const dt = Math.min(0.1, (now - prev) / 1000);
  prev = now;
  if (!paused) {
    if (dancing) {
      danceTime += dt;
      sim.setTargets(dancePose(danceTime));
    }
    const t0 = performance.now();
    sim.step(dt);
    stepTimes.push(performance.now() - t0);
    if (stepTimes.length > 120) stepTimes.shift();
  }
  draw();
  renderer.render(scene, camera);
  const sorted = [...stepTimes].sort((a, b) => a - b);
  const st = sim.stats();
  statsEl.textContent =
    `step ms  avg ${(stepTimes.reduce((a, b) => a + b, 0) / Math.max(1, stepTimes.length)).toFixed(2)}  p95 ${(sorted[Math.floor(sorted.length * 0.95)] ?? 0).toFixed(2)}\n` +
    `particles ${st.particles} (attached ${st.attached})  cells ${st.cells}\n` +
    `body volume ${st.volumeRatio.toFixed(3)}  jiggle ${(st.deformation * 100).toFixed(1)} cm\n` +
    sim.flesh.map((f) => `${f.name} ${f.soft.numParticles()}p cell ${(f.cellSize * 100).toFixed(1)}cm`).join("\n") + "\n" +
    events.join("\n");
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

Object.assign(window, {
  __sim: {
    get sim() { return sim; },
    THREE, params,
    poke(x: number, y: number, z: number, dx = 0, dy = 0, dz = -1, s = 0.8) {
      const ray = new THREE.Ray(new THREE.Vector3(x, y, z), new THREE.Vector3(dx, dy, dz).normalize());
      const hit = sim.raycast(ray);
      if (hit) sim.poke(hit, s, ray.direction);
      return hit?.region ?? null;
    },
    throwBall, setDance,
    rebuild() {
      sim.dispose();
      sim = createFrogSim(spec, params, tuning);
      sim.onEvent(onEvent);
      buildViews();
    },
  },
});
