/**
 * Dev page for the simulation: the flesh surfaces, particles (red = riding a bone), bones and collision skins of the
 * simulated frog, with pokes (click), grabs and throws (drag), slaps (shift-drag), balls (B), and driven test poses:
 * a hop with the hands on the belly (D) and a forward bend (F). The physics sliders and the simulator's settings
 * come from the URL: ?rig=test|glb&pose=free|dance|bend&bend=50&show=particles,bones,skin,xray, plus any block
 * setting by its key (bodyParticles=250&cellModel=corotational&carried=1…).
 */
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { BoneName, FrogEvent, GrabHandle, PhysicsParams, RigSpec } from "../src/contracts";
import { createFrogSim, initPhysics, listSimulators, type LabFrogSim, type Settings } from "../src/sim";
import { createTestRigSpec } from "../src/sim/testRig";

const url = new URLSearchParams(location.search);
const num = (k: string, d: number) => (url.has(k) ? Number(url.get(k)) : d);
const show = new Set((url.get("show") ?? "particles,bones").split(","));

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
scene.add(new THREE.GridHelper(6, 30, 0x8899aa, 0xb8c2cc));
addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

const params: PhysicsParams = {
  softness: num("soft", 0.85), bounciness: num("bounce", 0.65), gravity: num("g", 1), bellySize: num("belly", 1),
  stubbornness: num("stub", 0.7),
};

async function loadSpec(): Promise<RigSpec> {
  if (url.get("rig") !== "test") {
    const { loadCharacter } = await import("../src/character");
    return (await loadCharacter("/models/naiwa.glb")).spec;
  }
  return createTestRigSpec({ limbs: url.get("limbs") !== "0" });
}

await initPhysics();
const spec = await loadSpec();
/** The simulator's settings: every declared parameter found in the URL. */
const settings: Settings = {};
for (const p of listSimulators().find((s) => s.id === "cpu-constraints")?.parameters ?? []) {
  const v = url.get(p.key);
  if (v !== null) settings[p.key] = p.kind === "number" ? Number(v) : p.kind === "boolean" ? v === "1" : v;
}
const events: string[] = [];
const onEvent = (e: FrogEvent) => {
  events.unshift(`${e.kind} ${e.strength.toFixed(2)}${e.region ? " " + e.region : ""}`);
  events.length = Math.min(events.length, 6);
};
let sim: LabFrogSim = createFrogSim(spec, params, { id: "cpu-constraints", settings });
sim.onEvent(onEvent);
await sim.ready;

/* Drawing ---------------------------------------------------------------------------------------------------- */

const COLORS: Record<string, number> = { body: 0xf2c94c, arm_L: 0xe0b53c, arm_R: 0xe0b53c, leg_L: 0xd9ab35, leg_R: 0xd9ab35 };
interface PartView {
  mesh: THREE.Mesh;
  points: THREE.Points;
  skin: THREE.LineSegments | null;
}
const views: PartView[] = [];

function buildViews() {
  for (const v of views) scene.remove(v.mesh, v.points, ...(v.skin ? [v.skin] : []));
  views.length = 0;
  for (const part of sim.scene.parts) {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(part.positions.slice(), 3));
    g.setIndex(new THREE.BufferAttribute(part.indices, 1));
    g.computeVertexNormals();
    const mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({
      color: COLORS[part.name] ?? 0xe0b53c, roughness: 0.5, transparent: show.has("xray"), opacity: show.has("xray") ? 0.45 : 1,
    }));
    scene.add(mesh);
    const view = sim.scene.flesh.particles(part);
    const pg = new THREE.BufferGeometry();
    pg.setAttribute("position", new THREE.BufferAttribute(new Float32Array(view.count * 3), 3));
    const col = new Float32Array(view.count * 3);
    for (let i = 0; i < view.count; i++) col.set(view.attachedTo(i) ? [1, 0.15, 0.1] : [0.15, 0.35, 1], i * 3);
    pg.setAttribute("color", new THREE.BufferAttribute(col, 3));
    const points = new THREE.Points(pg, new THREE.PointsMaterial({ size: 0.018, vertexColors: true, depthTest: false }));
    points.renderOrder = 2;
    points.visible = show.has("particles");
    scene.add(points);
    // The collision skin, when the flesh is a Rapier soft body (its last collision mesh).
    let skin: THREE.LineSegments | null = null;
    const soft = sim.scene.flesh.rapier?.(part);
    if (soft && soft.numMeshes() > 0) {
      const tri = soft.meshIndices(soft.numMeshes() - 1);
      const edges: number[] = [];
      for (let t = 0; t < tri.length; t += 3) edges.push(tri[t], tri[t + 1], tri[t + 1], tri[t + 2], tri[t + 2], tri[t]);
      const sg = new THREE.BufferGeometry();
      sg.setAttribute("position", new THREE.BufferAttribute(soft.meshVertices(soft.numMeshes() - 1), 3));
      sg.setIndex(edges);
      skin = new THREE.LineSegments(sg, new THREE.LineBasicMaterial({ color: 0x225522, depthTest: false }));
      skin.visible = show.has("skin");
      scene.add(skin);
    }
    views.push({ mesh, points, skin });
  }
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
  sim.scene.parts.forEach((part, k) => {
    const v = views[k];
    const src = part.limb ? limbOut.get(part.name) : body;
    if (!v || !src) return;
    const attr = v.mesh.geometry.getAttribute("position") as THREE.BufferAttribute;
    (attr.array as Float32Array).set(src);
    attr.needsUpdate = true;
    v.mesh.geometry.computeVertexNormals();
    if (v.points.visible) {
      const pa = v.points.geometry.getAttribute("position") as THREE.BufferAttribute;
      (pa.array as Float32Array).set(sim.scene.flesh.particles(part).positions());
      pa.needsUpdate = true;
    }
    const soft = sim.scene.flesh.rapier?.(part);
    if (v.skin && soft) {
      v.skin.visible = show.has("skin");
      const sa = v.skin.geometry.getAttribute("position") as THREE.BufferAttribute;
      (sa.array as Float32Array).set(soft.meshVertices(soft.numMeshes() - 1));
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

/* Driven test poses (FK of the rest skeleton) ---------------------------------------------------------------- */

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
/** The rest pose with bones turned about world X (degrees, forward positive) in their parent chain. */
function bendPose(turns: Partial<Record<BoneName, number>>) {
  for (const b of spec.bones) {
    const local = b.parent ? restWorld.get(b.parent)!.clone().invert().multiply(b.restWorld) : b.restWorld.clone();
    const deg = turns[b.name];
    if (deg) {
      const restQ = new THREE.Quaternion().setFromRotationMatrix(b.restWorld);
      const turn = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), (deg * Math.PI) / 180);
      local.multiply(new THREE.Matrix4().makeRotationFromQuaternion(restQ.clone().invert().multiply(turn).multiply(restQ)));
    }
    targets.set(b.name, b.parent ? targets.get(b.parent)!.clone().multiply(local) : local);
  }
  return targets;
}
/** Hops with the hands on the belly. */
function dancePose(t: number) {
  const hop = Math.max(0, Math.sin(t * Math.PI * 2 * 1.1)) * 0.11;
  const sway = Math.sin(t * Math.PI * 1.1) * 0.12;
  const lift = new THREE.Matrix4().makeTranslation(0, hop, 0).multiply(new THREE.Matrix4().makeRotationY(sway));
  bendPose({ chest: 7 + 5 * Math.sin(t * 7) });
  for (const b of spec.bones) targets.set(b.name, lift.clone().multiply(targets.get(b.name)!));
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
let press: { x: number; y: number; hit: NonNullable<ReturnType<LabFrogSim["raycast"]>>; shift: boolean } | null = null;
let grab: GrabHandle | null = null;
const grabPlane = new THREE.Plane();
let last: { p: THREE.Vector3; t: number } | null = null;
const velocity = new THREE.Vector3();
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
  grab ??= sim.grab(press.hit);
  grab.move(p);
});
addEventListener("pointerup", (e) => {
  if (press && !grab) sim.poke(press.hit, 0.7, rayAt(e).direction);
  grab?.release(velocity.clone());
  grab = null;
  press = null;
  last = null;
  controls.enabled = true;
});

type Pose = "free" | "dance" | "bend";
let pose: Pose = (url.get("pose") as Pose) ?? "free";
let paused = false;
let poseTime = 0;
function throwBall() {
  const dir = camera.getWorldDirection(new THREE.Vector3());
  const origin = camera.position.clone().addScaledVector(dir, 0.4);
  const to = new THREE.Vector3(0, 0.5, 0).sub(origin).normalize();
  sim.throwBall(origin, to.multiplyScalar(9), 0.08);
}
function setPose(p: Pose) {
  pose = p;
  poseTime = 0;
  sim.setMode(p === "free" ? "free" : "driven");
}
addEventListener("keydown", (e) => {
  if (e.key === "b") throwBall();
  if (e.key === "r") sim.reset();
  if (e.key === "d") setPose(pose === "dance" ? "free" : "dance");
  if (e.key === "f") setPose(pose === "bend" ? "free" : "bend");
  if (e.key === " ") paused = !paused;
});
setPose(pose);

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
  ["dance (D)", () => setPose(pose === "dance" ? "free" : "dance")],
  ["bend (F)", () => setPose(pose === "bend" ? "free" : "bend")],
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
let stats = sim.stats();
let statsAt = 0;
let prev = performance.now();
const f2 = (v: number | undefined, d = 3) => (v ?? 0).toFixed(d);
function frame(now: number) {
  const dt = Math.min(0.1, (now - prev) / 1000);
  prev = now;
  if (!paused) {
    poseTime += dt;
    if (pose === "dance") sim.setTargets(dancePose(poseTime));
    if (pose === "bend") {
      const b = num("bend", 50) * Math.min(1, poseTime / 1.5);
      sim.setTargets(bendPose({ spine: b / 2, chest: b / 2, head: b / 3 }));
    }
    const t0 = performance.now();
    sim.step(dt);
    stepTimes.push(performance.now() - t0);
    if (stepTimes.length > 120) stepTimes.shift();
  }
  draw();
  renderer.render(scene, camera);
  if (now - statsAt > 250) {
    statsAt = now;
    stats = sim.stats();
  }
  const sorted = [...stepTimes].sort((a, b) => a - b);
  statsEl.textContent =
    `step ms  avg ${(stepTimes.reduce((a, b) => a + b, 0) / Math.max(1, stepTimes.length)).toFixed(2)}  p95 ${(sorted[Math.floor(sorted.length * 0.95)] ?? 0).toFixed(2)}\n` +
    `particles ${stats.particles}  cells ${stats.cells}\n` +
    `deviation ${f2(stats.deviation)} (max ${f2(stats.deviationMax)}) m  inverted ${stats.invertedCells ?? 0}\n` +
    `penetration ${f2(stats.penetration)} m  jitter ${f2(stats.jitter)} m/s\n` +
    `momentum ${(stats.momentum ?? []).map((v) => v.toFixed(2)).join(" ")}  energy ${f2(stats.energy, 1)} J\n` +
    `volume ${Object.entries(stats.volume ?? {}).map(([k, v]) => `${k} ${v.toFixed(3)}`).join("  ")}\n` +
    events.join("\n");
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

Object.assign(window, {
  __sim: {
    get sim() { return sim; },
    THREE, params, setPose, throwBall,
    poke(x: number, y: number, z: number, dx = 0, dy = 0, dz = -1, s = 0.8) {
      const ray = new THREE.Ray(new THREE.Vector3(x, y, z), new THREE.Vector3(dx, dy, dz).normalize());
      const hit = sim.raycast(ray);
      if (hit) sim.poke(hit, s, ray.direction);
      return hit?.region ?? null;
    },
    async rebuild() {
      sim.dispose();
      sim = createFrogSim(spec, params, { id: "cpu-constraints", settings });
      sim.onEvent(onEvent);
      await sim.ready;
      buildViews();
      setPose(pose);
    },
  },
});
