/**
 * Dev page for the code lab: the real frog simulated with the store's simulator (rebuilt when it changes, as the page
 * does), dancing through the store's retargeter, and the code lab mounted on top. URL: ?open=simulator|retargeter
 * &slot=output&theme=dark&lang=en.
 */
import "../src/styles/index.css";
import * as THREE from "three";
import type { BoneName } from "../src/contracts";
import { registerMotionLibrary } from "../src/algorithms/motion";
import { loadCharacter } from "../src/character";
import { setLang, tr } from "../src/i18n";
import { mountCodeLab, openCodeLab, type CoreKind } from "../src/labcode";
import { createMotion } from "../src/motion";
import { createFrogSim, initPhysics, listSimulators, onSimulatorsChanged, type LabFrogSim } from "../src/sim";
import { createStore } from "../src/store";
import { h } from "../src/ui/dom";

const url = new URLSearchParams(location.search);
const theme = url.get("theme") === "dark" ? "dark" : "light";
document.documentElement.dataset.theme = theme;
setLang(url.get("lang") === "en" ? "en" : "zh");

const store = createStore();
store.set({ lang: url.get("lang") === "en" ? "en" : "zh", mode: "dance" });
const motion = createMotion();
registerMotionLibrary();

const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
document.getElementById("stage")!.append(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(theme === "dark" ? 0x1b170f : 0xfff1cc);
const camera = new THREE.PerspectiveCamera(35, innerWidth / innerHeight, 0.05, 50);
scene.add(new THREE.HemisphereLight(0xffffff, 0x8a7a5a, 1.7));
const sun = new THREE.DirectionalLight(0xffffff, 2);
sun.position.set(2, 4, 3);
scene.add(sun);
const frame = () => {
  // The frog sits in the part of the window the code lab leaves free.
  const free = innerWidth > 820 ? innerWidth - Math.min(1180, Math.max(720, innerWidth * 0.64)) : innerWidth;
  camera.aspect = innerWidth / innerHeight;
  camera.setViewOffset(innerWidth, innerHeight, innerWidth > 820 && document.querySelector(".nw-cl:not([hidden])") ? (innerWidth - free) / 2 : 0, 0, innerWidth, innerHeight);
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
};
camera.position.set(0, 0.75, 3.1);
camera.lookAt(0, 0.45, 0);
addEventListener("resize", frame);

const status = document.getElementById("status")!;
store.set({ loading: { active: true, message: "" } });
await initPhysics();
const character = await loadCharacter("/models/naiwa.glb");
scene.add(character.object);
motion.bind(character.rig);
store.set({ simulators: listSimulators(), retargeters: motion.retargeters() });
onSimulatorsChanged(() => store.set({ simulators: listSimulators() }));
motion.onRetargetersChanged((retargeters) => store.set({ retargeters }));

const codeLab = mountCodeLab({
  host: document.getElementById("ui")!,
  store,
  spec: () => character.spec,
  binding: () => motion.binding(),
  toast: (m, k) => {
    status.textContent = `[${k ?? "info"}] ${m}\n` + status.textContent;
  },
});
await codeLab.ready;

let sim: LabFrogSim | null = null;
function buildSim() {
  sim?.dispose();
  sim = createFrogSim(character.spec, store.get().params, store.get().simulator);
  sim.setMode("driven");
}
buildSim();
const source = motion.startDance(store.get().dance);
store.subscribe((s, prev) => {
  if (s.simulator !== prev.simulator) buildSim();
  if (s.retargeter !== prev.retargeter) motion.setRetargeter(s.retargeter);
  if (s.lang !== prev.lang) setLang(s.lang);
});

const bar = document.getElementById("dev")!;
const button = (text: () => string, onclick: () => void) => {
  const b = h("button", { class: "nw-btn nw-btn--secondary nw-btn--sm", onclick }, text());
  return { b, text };
};
const buttons = [
  button(() => tr({ zh: "模拟器代码", en: "Simulator code" }), () => (openCodeLab({ kind: "simulator" }), frame())),
  button(() => tr({ zh: "动作迁移代码", en: "Motion transfer code" }), () => (openCodeLab({ kind: "retargeter" }), frame())),
  button(() => (store.get().lang === "zh" ? "English" : "中文"), () => store.set({ lang: store.get().lang === "zh" ? "en" : "zh" })),
];
bar.append(...buttons.map((x) => x.b));
store.subscribe(() => buttons.forEach((x) => (x.b.textContent = x.text())));

const targets = new Map<BoneName, THREE.Matrix4>();
const bones = new Map<BoneName, THREE.Matrix4>();
const limbs = new Map<string, Float32Array>();
let last = performance.now();
let shown = 0;
function tick(now: number) {
  requestAnimationFrame(tick);
  const dt = Math.min((now - last) / 1000, 1 / 20);
  last = now;
  if (!sim) return;
  const pose = source.update(now, dt);
  character.targetsFromPose(pose, targets);
  sim.setTargets(targets);
  sim.step(dt);
  sim.readBones(bones);
  sim.readLimbs(limbs);
  character.applySim(bones, sim.readBody(), limbs);
  character.update(dt, camera);
  renderer.render(scene, camera);
  if (now - shown > 500) {
    shown = now;
    const m = motion.metrics();
    const lines = status.textContent!.split("\n").filter((l) => l.startsWith("[")).slice(0, 4);
    status.textContent = [
      `simulator ${store.get().simulator.id}  retargeter ${store.get().retargeter.id}`,
      m ? `fidelity ${m.fidelity.toFixed(1)}°  jerk ${m.jerk.toFixed(0)}  foot slide ${(m.footSlide * 100).toFixed(1)} cm/s` : "",
      ...lines,
    ].join("\n");
  }
}
requestAnimationFrame(tick);
frame();
store.set({ loading: { active: false, message: "" } });

const open = url.get("open");
if (open === "simulator" || open === "retargeter") {
  openCodeLab({ kind: open as CoreKind, slot: url.get("slot") ?? undefined });
  frame();
}
Object.assign(window, { __lab: { store, codeLab, motion, get sim() { return sim; } } });
