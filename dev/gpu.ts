/**
 * Dev page for the GPU example simulator (src/sim/gpu): the real frog's flesh by MLS-MPM on WebGPU or the CPU
 * workers, side by side in numbers with any other simulator. URL:
 *   ?backend=webgpu|cpu|inline|auto   force a backend (default auto: the probe's choice)
 *   ?sim=gpu-mpm|cpu-constraints      the simulator (default gpu-mpm)
 *   ?pose=free|bend|dance             free standing, a driven 50° forward bend, a driven hop with hands on the belly
 *   ?workers=N                        CPU workers (default: the cores less two, at most 12)
 *   ?show=particles,bones,xray        overlays; any block setting by its key (gridCell=2.5&youngModulus=3…)
 * Click pokes, drag grabs and throws. window.__gpu has poke(), stats() and the sim for scripted screenshots.
 */
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { BoneName, PhysicsParams, RigSpec } from "../src/contracts";
import { createFrogSim, initPhysics, listSimulators, type LabFrogSim, type Settings } from "../src/sim";
import { backendLabel, forceBackend, MpmFlesh, probeDevices, registerGpuSimulators, setWorkerCount, type BackendKind } from "../src/sim/gpu";
import { tr } from "../src/i18n";

const url = new URLSearchParams(location.search);
const show = new Set((url.get("show") ?? "").split(","));
const simId = url.get("sim") ?? "gpu-mpm";
const forced: Record<string, BackendKind | null> = { webgpu: "webgpu", cpu: "cpu-parallel", inline: "cpu-inline", auto: null };

const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
document.body.prepend(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xdfe3e6);
const camera = new THREE.PerspectiveCamera(35, innerWidth / innerHeight, 0.05, 50);
camera.position.set(Number(url.get("cx") ?? 1.5), Number(url.get("cy") ?? 1.0), Number(url.get("cz") ?? 2.2));
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0.45, 0);
controls.update();
scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8a7a, 1.6));
const sun = new THREE.DirectionalLight(0xffffff, 2.2);
sun.position.set(2, 4, 3);
scene.add(sun);
scene.add(new THREE.GridHelper(6, 30, 0x8899aa, 0xb8c2cc));

const params: PhysicsParams = { softness: 0.85, bounciness: 0.65, gravity: 1, bellySize: 1, stubbornness: 0.7 };

await initPhysics();
await probeDevices();
forceBackend(forced[url.get("backend") ?? "auto"] ?? null);
if (url.has("workers")) setWorkerCount(Number(url.get("workers")));
registerGpuSimulators();
const { loadCharacter } = await import("../src/character");
const spec: RigSpec = (await loadCharacter("/models/naiwa.glb")).spec;
const settings: Settings = {};
for (const p of listSimulators().find((s) => s.id === simId)?.parameters ?? []) {
  const v = url.get(p.key);
  if (v !== null) settings[p.key] = p.kind === "number" ? Number(v) : p.kind === "boolean" ? v === "1" : v;
}
const sim: LabFrogSim = createFrogSim(spec, params, { id: simId, settings });
await sim.ready;
const backendObj = (sim.scene.flesh as unknown as { backend?: { profiling?: boolean; profile?: Record<string, number> } }).backend;
if (backendObj && url.has("profile")) backendObj.profiling = true;
const label = simId === "gpu-mpm" ? backendLabel() : "Rapier (CPU)";

/* Drawing ------------------------------------------------------------------------------------------------------ */

const COLORS: Record<string, number> = { body: 0xf2c94c, arm_L: 0xe0b53c, arm_R: 0xe0b53c, leg_L: 0xd9ab35, leg_R: 0xd9ab35 };
const views = sim.scene.parts.map((part) => {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(part.positions.slice(), 3));
  g.setIndex(new THREE.BufferAttribute(part.indices, 1));
  g.computeVertexNormals();
  const mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({
    color: COLORS[part.name] ?? 0xe0b53c, roughness: 0.5, transparent: show.has("xray"), opacity: show.has("xray") ? 0.4 : 1,
  }));
  scene.add(mesh);
  const view = sim.scene.flesh.particles(part);
  const pg = new THREE.BufferGeometry();
  pg.setAttribute("position", new THREE.BufferAttribute(new Float32Array(view.count * 3), 3));
  const col = new Float32Array(view.count * 3);
  pg.setAttribute("color", new THREE.BufferAttribute(col, 3));
  const points = new THREE.Points(pg, new THREE.PointsMaterial({ size: 0.008, vertexColors: true, depthTest: !show.has("xray") }));
  points.visible = show.has("particles");
  scene.add(points);
  return { part, mesh, points, col };
});
const boneLines = new THREE.LineSegments(
  new THREE.BufferGeometry().setAttribute("position", new THREE.BufferAttribute(new Float32Array(17 * 6), 3)),
  new THREE.LineBasicMaterial({ color: 0x111111, depthTest: false }),
);
boneLines.visible = show.has("bones");
scene.add(boneLines);
const boneMats = new Map<BoneName, THREE.Matrix4>();
const tailLocal = new Map<BoneName, THREE.Vector3>(spec.bones.map((b) => [b.name, b.tail.clone().applyMatrix4(b.restWorld.clone().invert())]));
const limbOut = new Map<string, Float32Array>();

function draw() {
  sim.readLimbs(limbOut);
  const body = sim.readBody();
  for (const v of views) {
    const src = v.part.limb ? limbOut.get(v.part.name) : body;
    if (!src) continue;
    const attr = v.mesh.geometry.getAttribute("position") as THREE.BufferAttribute;
    (attr.array as Float32Array).set(src);
    attr.needsUpdate = true;
    v.mesh.geometry.computeVertexNormals();
    if (v.points.visible) {
      const view = sim.scene.flesh.particles(v.part);
      const pa = v.points.geometry.getAttribute("position") as THREE.BufferAttribute;
      (pa.array as Float32Array).set(view.positions());
      pa.needsUpdate = true;
      for (let i = 0; i < view.count; i++) v.col.set(view.attachedTo(i) ? [0.9, 0.15, 0.1] : [0.15, 0.35, 1], i * 3);
      v.points.geometry.getAttribute("color").needsUpdate = true;
    }
  }
  sim.readBones(boneMats);
  const la = boneLines.geometry.getAttribute("position") as THREE.BufferAttribute;
  let k = 0;
  for (const [name, m] of boneMats) {
    if (k >= 34) break;
    const a = new THREE.Vector3().setFromMatrixPosition(m), b = (tailLocal.get(name) ?? new THREE.Vector3()).clone().applyMatrix4(m);
    la.setXYZ(k++, a.x, a.y, a.z);
    la.setXYZ(k++, b.x, b.y, b.z);
  }
  la.needsUpdate = true;
}

/* Driven poses ----------------------------------------------------------------------------------------------- */

const restWorld = new Map(spec.bones.map((b) => [b.name, b.restWorld]));
const targets = new Map<BoneName, THREE.Matrix4>();
function bendPose(turns: Partial<Record<BoneName, number>>, lift = new THREE.Matrix4()) {
  for (const b of spec.bones) {
    const local = b.parent ? restWorld.get(b.parent)!.clone().invert().multiply(b.restWorld) : b.restWorld.clone();
    const deg = turns[b.name];
    if (deg) {
      const restQ = new THREE.Quaternion().setFromRotationMatrix(b.restWorld);
      const turn = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), (deg * Math.PI) / 180);
      local.multiply(new THREE.Matrix4().makeRotationFromQuaternion(restQ.clone().invert().multiply(turn).multiply(restQ)));
    }
    targets.set(b.name, b.parent ? targets.get(b.parent)!.clone().multiply(local) : lift.clone().multiply(local));
  }
  return targets;
}
/** A hop with a sway and a nod: the flesh's inertia on a moving skeleton. */
function dancePose(t: number) {
  const hop = Math.max(0, Math.sin(t * Math.PI * 2 * 1.1)) * 0.1;
  const lift = new THREE.Matrix4().makeTranslation(0, hop, 0).multiply(new THREE.Matrix4().makeRotationY(Math.sin(t * Math.PI * 1.1) * 0.25));
  return bendPose({ chest: 8 + 8 * Math.sin(t * 7), head: 10 * Math.sin(t * 5) }, lift);
}

type Pose = "free" | "dance" | "bend";
let pose: Pose = (url.get("pose") as Pose) ?? "free";
let poseTime = 0;
function setPose(p: Pose) {
  pose = p;
  poseTime = 0;
  sim.setMode(p === "free" ? "free" : "driven");
}
setPose(pose);

/* Interaction -------------------------------------------------------------------------------------------------- */

const raycaster = new THREE.Raycaster();
function rayAt(e: PointerEvent): THREE.Ray {
  raycaster.setFromCamera(new THREE.Vector2((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1), camera);
  return raycaster.ray.clone();
}
renderer.domElement.addEventListener("pointerdown", (e) => {
  if (!e.shiftKey) return;
  const ray = rayAt(e), hit = sim.raycast(ray);
  if (hit) sim.poke(hit, 0.8, ray.direction);
});
addEventListener("keydown", (e) => {
  if (e.key === "r") sim.reset();
  if (e.key === "d") setPose(pose === "dance" ? "free" : "dance");
  if (e.key === "f") setPose(pose === "bend" ? "free" : "bend");
  if (e.key === "b") {
    const dir = camera.getWorldDirection(new THREE.Vector3());
    const origin = camera.position.clone().addScaledVector(dir, 0.4);
    sim.throwBall(origin, new THREE.Vector3(0, 0.5, 0).sub(origin).normalize().multiplyScalar(9), 0.08);
  }
});

/* Loop --------------------------------------------------------------------------------------------------------- */

const panel = document.getElementById("panel")!;
panel.textContent = "shift-click: poke · D dance · F bend · B ball · R reset";
const statsEl = document.getElementById("stats")!;
const stepTimes: number[] = [];
let stats = sim.stats();
let statsAt = 0, prev = performance.now(), simTime = 0;
const hips0 = new THREE.Vector3().setFromMatrixPosition(restWorld.get("hips")!);
const f = (v: number | undefined, d = 3) => (v ?? 0).toFixed(d);

function frame(now: number) {
  const dt = Math.min(0.1, (now - prev) / 1000);
  prev = now;
  poseTime += dt;
  if (pose === "dance") sim.setTargets(dancePose(poseTime));
  if (pose === "bend") {
    const b = Number(url.get("bend") ?? 50) * Math.min(1, poseTime / 1.5);
    sim.setTargets(bendPose({ spine: b / 2, chest: b / 2, head: b / 3 }));
  }
  const t0 = performance.now();
  sim.step(dt);
  stepTimes.push(performance.now() - t0);
  if (stepTimes.length > 120) stepTimes.shift();
  simTime += dt;
  draw();
  renderer.render(scene, camera);
  if (now - statsAt > 250) {
    statsAt = now;
    stats = sim.stats();
  }
  const flesh = sim.scene.flesh;
  const t = flesh instanceof MpmFlesh ? flesh.timing : null;
  const sorted = [...stepTimes].sort((a, b) => a - b);
  const hips = new THREE.Vector3().setFromMatrixPosition(boneMats.get("hips") ?? new THREE.Matrix4());
  statsEl.textContent =
    `${simId} · ${typeof label === "string" ? label : label ? tr(label) : ""}\n` +
    `step ms (page thread, per frame)  avg ${(stepTimes.reduce((a, b) => a + b, 0) / Math.max(1, stepTimes.length)).toFixed(2)}  p95 ${(sorted[Math.floor(sorted.length * 0.95)] ?? 0).toFixed(2)}\n` +
    (t ? `flesh: device ${f(t.deviceMs, 2)} ms/step  submit ${f(t.submitMs, 2)}  wait ${f(t.waitMs, 2)}  substeps ${t.substeps}\n` : "") +
    `particles ${stats.particles}  cells/nodes ${stats.cells}  t ${simTime.toFixed(1)} s\n` +
    `deviation ${f(stats.deviation)} (max ${f(stats.deviationMax)}) m  inverted ${stats.invertedCells ?? 0}\n` +
    `penetration ${f(stats.penetration)} m  jitter ${f(stats.jitter)} m/s\n` +
    `momentum ${(stats.momentum ?? []).map((v) => v.toFixed(2)).join(" ")}  energy ${f(stats.energy, 1)} J\n` +
    `volume ${Object.entries(stats.volume ?? {}).map(([k, v]) => `${k} ${v.toFixed(3)}`).join("  ")}\n` +
    (backendObj?.profiling ? `kernels ms: ${Object.entries(backendObj.profile ?? {}).map(([k, v]) => `${k} ${v.toFixed(2)}`).join("  ")}
` : "") +
    `hips drift ${hips.clone().setY(0).distanceTo(hips0.clone().setY(0)).toFixed(3)} m`;
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

Object.assign(window, {
  __gpu: {
    sim, setPose,
    /** Poke along a ray from (x, y, z) in direction (dx, dy, dz). */
    poke(x: number, y: number, z: number, dx = 0, dy = 0, dz = -1, s = 1) {
      const ray = new THREE.Ray(new THREE.Vector3(x, y, z), new THREE.Vector3(dx, dy, dz).normalize());
      const hit = sim.raycast(ray);
      if (hit) sim.poke(hit, s, ray.direction);
      return hit?.region ?? null;
    },
    text: () => statsEl.textContent,
  },
});
