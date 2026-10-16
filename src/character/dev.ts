/**
 * Dev page for the character (dev/character.html): the frog on a neutral studio floor like the references, driven
 * by the real simulation. Hover: the eyes follow; click: poke; drag: grab and throw.
 * URL: ?view=front|three|side|back|laugh|upper|face|faceside, ?placeholder, ?nosim (rest surface), ?mode=free, ?pose=wave|peace,
 * ?clean, ?still (no life), ?preset=jelly|mochi|…, ?stage (the app's stage instead of the studio), ?raw (the GLB as three.js
 * loads it, without this module).
 * window.dev drives it from scripts (tests/tools/shot.mjs --eval).
 */
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import type { BoneName, Expression, ExpressionWeights, FrogEvent, FrogEventKind, FrogSim, HitRegion, PoseFrame } from "../contracts";
import { createFrogSim, initPhysics } from "../sim";
import { createStage } from "../stage";
import { MATERIAL_PRESETS } from "../store";
import { loadCharacter } from ".";

const params = new URLSearchParams(location.search);
if (params.has("clean")) document.body.classList.add("clean");

/** The real stage (?stage: its lights, set and camera) or a neutral studio like the references. */
const stage = params.has("stage") ? createStage(document.body) : null;
const renderer = stage?.renderer ?? new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
const scene = stage?.scene ?? new THREE.Scene();
const camera = stage?.camera ?? new THREE.PerspectiveCamera(30, 1, 0.05, 50);
if (!stage) {
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  document.body.prepend(renderer.domElement);
  scene.background = new THREE.Color(0xe9e9e6);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = () => (scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture);
  env();
  // A lost GL context (the GPU is shared) takes the rendered environment with it.
  renderer.domElement.addEventListener("webglcontextrestored", () => {
    console.warn("WebGL context restored: rebuilding the environment");
    env();
  });
  scene.environmentIntensity = 0.55;
  scene.add(new THREE.HemisphereLight(0xffffff, 0xcfc6b0, 0.9));
  const key = new THREE.DirectionalLight(0xffffff, 2.2);
  key.position.set(-1.6, 3, 2.4);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  Object.assign(key.shadow.camera, { left: -1.5, right: 1.5, top: 1.5, bottom: -1.5, near: 0.5, far: 8 });
  key.shadow.radius = 4;
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.02;
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xfff4e0, 1.1);
  rim.position.set(0.5, 2, -3);
  scene.add(rim);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.ShadowMaterial({ opacity: 0.18 }));
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);
}
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.enabled = !stage;

/** Reference viewpoints: azimuth from +Z (front) towards +X (its left), elevation, distance, look-at height. */
const VIEWS: Record<string, [number, number, number, [number, number, number]]> = {
  front: [0, 6, 3.1, [0, 0.52, 0]],
  three: [62, 6, 3.1, [0, 0.52, 0]],
  side: [90, 4, 3.1, [0, 0.52, 0]],
  back: [180, 10, 3.1, [0, 0.52, 0]],
  laugh: [-12, 16, 2.6, [0, 0.58, 0]],
  upper: [0, 4, 1.9, [0, 0.68, 0]],
  face: [0, 0, 1.0, [0, 0.86, 0.06]],
  faceside: [-90, 0, 1.1, [0, 0.84, 0.03]],
};
function view(name: string) {
  const [az, el, dist, target] = VIEWS[name] ?? VIEWS.front;
  const a = THREE.MathUtils.degToRad(az), e = THREE.MathUtils.degToRad(el);
  controls.target.set(...target);
  camera.position.set(
    target[0] + dist * Math.cos(e) * Math.sin(a), target[1] + dist * Math.sin(e), target[2] + dist * Math.cos(e) * Math.cos(a),
  );
  controls.update();
}
view(params.get("view") ?? "front");

function resize() {
  if (stage) return;
  renderer.setSize(innerWidth, innerHeight, false);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
}
addEventListener("resize", resize);
resize();

if (params.has("raw")) {
  // The GLB as three.js loads it, untouched by this module (to tell asset issues from ours).
  const { GLTFLoader } = await import("three/examples/jsm/loaders/GLTFLoader.js");
  scene.add((await new GLTFLoader().loadAsync("/models/naiwa.glb")).scene);
  renderer.setAnimationLoop(() => renderer.render(scene, camera));
  await new Promise(() => {}); // the rest of the page is not part of this view
}
const url = params.has("placeholder") ? "/models/no-such-frog.glb" : "/models/naiwa.glb";
const character = await loadCharacter(url);
scene.add(character.object);
if (params.has("still")) character.setLively(false);

let sim: (FrogSim & { stats(): { particles: number; deformation: number } }) | null = null;
if (!params.has("nosim")) {
  await initPhysics();
  const preset = MATERIAL_PRESETS.find((p) => p.id === params.get("preset")) ?? MATERIAL_PRESETS[0];
  sim = createFrogSim(character.spec, { ...preset.params });
  sim.setMode(params.get("mode") === "free" ? "free" : "driven");
  sim.onEvent((e) => {
    character.react(e);
    log(`${e.kind} ${e.region ?? ""} ${e.strength.toFixed(2)}`);
  });
}

/* ---------------------------------------------------------------------------------------------------------------- */
/* Poses for testing the driven skeleton                                                                             */
/* ---------------------------------------------------------------------------------------------------------------- */

const restWorldQ = new Map(character.spec.bones.map((b) => [b.name, new THREE.Quaternion().setFromRotationMatrix(b.restWorld)]));
/** Local rotation producing a world-axis turn (parents at rest). */
function turn(name: BoneName, x: number, y: number, z: number): THREE.Quaternion {
  const d = new THREE.Quaternion().setFromEuler(new THREE.Euler(x, y, z, "YXZ"));
  const rw = restWorldQ.get(name)!;
  const local = character.rig.bones.get(name)!.quaternion.clone();
  return local.multiply(rw.clone().invert().multiply(d).multiply(rw));
}
const POSES: Record<string, (t: number) => PoseFrame> = {
  peace: () => ({
    bones: {
      upperarm_L: turn("upperarm_L", 0, 0, 1.9), forearm_L: turn("forearm_L", 0, 0, 0.6),
      upperarm_R: turn("upperarm_R", 0, 0, -1.9), forearm_R: turn("forearm_R", 0, 0, -0.6),
    },
    expressions: { tongue: 1 },
  }),
  wave: (t) => ({
    bones: {
      hips: turn("hips", 0, 0.25 * Math.sin(t * 4), 0),
      chest: turn("chest", 0, 0, 0.15 * Math.sin(t * 8)),
      upperarm_L: turn("upperarm_L", 0, 0, 1.2 + 0.6 * Math.sin(t * 8)),
      upperarm_R: turn("upperarm_R", 0, 0, -1.2 + 0.6 * Math.sin(t * 8)),
      thigh_L: turn("thigh_L", -0.3 - 0.3 * Math.sin(t * 8), 0, 0),
      shin_L: turn("shin_L", 0.5 + 0.5 * Math.sin(t * 8), 0, 0),
    },
    rootOffset: new THREE.Vector3(0, 0.03 * Math.abs(Math.sin(t * 8)), 0),
    rootYaw: 0.3 * Math.sin(t * 2),
  }),
};
let pose: string | null = params.get("pose");

/* ---------------------------------------------------------------------------------------------------------------- */
/* Interaction                                                                                                       */
/* ---------------------------------------------------------------------------------------------------------------- */

const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
let press: { x: number; y: number; hit: ReturnType<FrogSim["raycast"]>; grab: ReturnType<FrogSim["grab"]> | null; depth: number; trail: [number, THREE.Vector3][] } | null = null;

function rayAt(e: PointerEvent): THREE.Ray {
  ndc.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  return raycaster.ray;
}
function hitAt(e: PointerEvent) {
  return sim?.raycast(rayAt(e)) ?? null;
}

renderer.domElement.addEventListener("pointerdown", (e) => {
  const hit = hitAt(e);
  if (!hit) return;
  controls.enabled = false;
  press = { x: e.clientX, y: e.clientY, hit, grab: null, depth: camera.position.distanceTo(hit.point), trail: [] };
});
addEventListener("pointermove", (e) => {
  const ray = rayAt(e);
  const hit = sim?.raycast(ray.clone()) ?? null;
  character.lookAt(hit ? hit.point : ray.at(1.6, new THREE.Vector3()));
  if (!press || !sim) return;
  if (!press.grab && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 6) press.grab = sim.grab(press.hit!);
  if (press.grab) {
    const p = ray.at(press.depth, new THREE.Vector3());
    press.grab.move(p);
    press.trail.push([performance.now(), p]);
    if (press.trail.length > 6) press.trail.shift();
  }
});
addEventListener("pointerup", (e) => {
  controls.enabled = true;
  if (!press || !sim) return;
  if (press.grab) {
    const t = press.trail;
    const v = t.length > 1 ? t[t.length - 1][1].clone().sub(t[0][1]).divideScalar((t[t.length - 1][0] - t[0][0]) / 1000 || 1) : new THREE.Vector3();
    press.grab.release(v);
  } else sim.poke(press.hit!, 0.7, rayAt(e).direction.clone());
  press = null;
});
addEventListener("pointerleave", () => character.lookAt(null));

const requested: ExpressionWeights = {};
function toggle(e: Expression) {
  requested[e] = requested[e] ? 0 : 1;
}
const KEYS: Record<string, () => void> = {
  "1": () => toggle("laugh"), "2": () => toggle("tongue"), "3": () => toggle("surprise"), "4": () => toggle("blink"),
  r: () => sim?.reset(),
  p: () => (pose = pose === null ? "wave" : pose === "wave" ? "peace" : null),
  m: () => sim?.setMode((mode = mode === "free" ? "driven" : "free")),
};
let mode = params.get("mode") === "free" ? "free" : "driven";
addEventListener("keydown", (e) => KEYS[e.key]?.());
const hud = document.getElementById("hud")!;
for (const [k, label] of [["1", "laugh"], ["2", "tongue"], ["3", "surprise"], ["4", "blink"], ["p", "pose"], ["m", "free/driven"], ["r", "reset"]]) {
  const b = document.createElement("button");
  b.textContent = `${k} ${label}`;
  b.onclick = () => KEYS[k]();
  hud.append(b);
}
const info = document.getElementById("info")!;
const events: string[] = [];
function log(s: string) {
  events.unshift(s);
  events.length = Math.min(events.length, 4);
}

/* ---------------------------------------------------------------------------------------------------------------- */
/* Loop                                                                                                              */
/* ---------------------------------------------------------------------------------------------------------------- */

const targets = new Map<BoneName, THREE.Matrix4>();
const bones = new Map<BoneName, THREE.Matrix4>();
const limbs = new Map<string, Float32Array>();
let last = performance.now();
let time = 0;
let fps = 60;
let frameMs = 0;
const forced: ExpressionWeights = {};

function frame(now: number) {
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;
  time += dt;
  fps += (1 / Math.max(dt, 1e-3) - fps) * 0.05;
  const t0 = performance.now();
  const p = pose ? POSES[pose](time) : null;
  character.targetsFromPose(p, targets);
  character.setExpressions({ ...p?.expressions, ...requested, ...forced });
  if (sim) {
    sim.setTargets(targets);
    sim.step(dt);
    sim.readBones(bones);
    sim.readLimbs?.(limbs);
    character.applySim(bones, sim.readBody(), limbs);
  }
  // Without a simulation the character shows the targets with its flesh skinned to them.
  character.update(dt, camera);
  frameMs += (performance.now() - t0 - frameMs) * 0.05;
  if (stage) {
    stage.setFocus(character.center(new THREE.Vector3()));
    stage.frame(dt);
  } else {
    controls.update();
    renderer.render(scene, camera);
  }
  const r = character.bodyReport;
  info.textContent =
    `${character.source}  body ${r.renderVertices}→${r.vertices} v, ${r.triangles} t, χ=${r.euler}  ` +
    `soft limbs ${character.limbReport.soft.join(",") || "none"}  ` +
    `${fps.toFixed(0)} fps, character+sim ${frameMs.toFixed(2)} ms\n` +
    `mode ${mode}${pose ? `  pose ${pose}` : ""}` +
    (sim ? `  particles ${sim.stats().particles} jiggle ${(sim.stats().deformation * 1000).toFixed(1)} mm` : "") +
    `\n${events.join("  |  ")}`;
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
Object.assign(window, {
  dev: {
    character, sim, camera, renderer, view,
    still: (on = true) => character.setLively(!on),
    express: (w: ExpressionWeights) => Object.assign(forced, w),
    pose: (name: string | null) => (pose = name),
    react: (kind: FrogEventKind, region: HitRegion = "belly", strength = 0.7) => {
      const e: FrogEvent = { kind, region, strength, point: new THREE.Vector3(0, 0.45, 0.25) };
      character.react(e);
    },
    poke: (x: number, y: number, z: number, strength = 0.8) => {
      const origin = new THREE.Vector3(x, y, z).multiplyScalar(3).setY(y);
      const ray = new THREE.Ray(origin, new THREE.Vector3(-x, 0, -z).normalize());
      const hit = sim?.raycast(ray);
      if (hit) sim!.poke(hit, strength, ray.direction);
      return !!hit;
    },
    lookAt: (x: number, y: number, z: number) => character.lookAt(new THREE.Vector3(x, y, z)),
    wait,
  },
});
