/** Dev page for the UI: the real stage and the real 奶蛙 (public/models/naiwa.glb) behind mountUI, with a mock store
 *  and commands (no simulation or motion). The frog is framed in the free middle from ui.onInsets, as the integration
 *  can do. Query: ?theme=light|dark ?mode=… ?tool=… ?loading=1 ?motion=state&msg=… ?custom ?paused ?slow ?gpu
 *  ?recording ?rec ?help ?toast ?sheet=motion|sim ?collapsed ?regions ?preview ?analyse ?analysed ?mine ?lang=zh|en. window.mock
 *  for scripts. */
import * as THREE from "three";
import "../src/styles/index.css";
import { loadCharacter } from "../src/character";
import type { BoneName, DanceInfo, Recording, Tool } from "../src/contracts";
import { createStage } from "../src/stage";
import { createStore, initialState, MATERIAL_PRESETS } from "../src/store";
import { mountUI, type UICommands } from "../src/ui";

const q = new URLSearchParams(location.search);
const store = createStore(initialState());
const theme = q.get("theme");
if (theme === "light" || theme === "dark") store.set({ theme });
const lang = q.get("lang");
if (lang === "zh" || lang === "en") store.set({ lang });

const DANCES: DanceInfo[] = [
  { id: "gouxiong", name: "狗熊哆嗦毛", nameEn: "Bear Shake", duration: 1.5, origin: "video", credit: "明文军 · 狗熊哆嗦毛 教学" },
  { id: "belly-laugh", name: "捧腹大笑", nameEn: "Belly Laugh", duration: 4, origin: "procedural" },
  { id: "yeah", name: "比耶", nameEn: "Peace Sign", duration: 3, origin: "procedural" },
  { id: "wiggle", name: "扭屁股", nameEn: "Butt Wiggle", duration: 4, origin: "procedural" },
  { id: "disco", name: "蹦迪", nameEn: "Disco", duration: 6, origin: "procedural" },
  { id: "frog-jump", name: "青蛙跳", nameEn: "Frog Jump", duration: 3, origin: "procedural" },
];
store.set({ dances: q.has("mine") ? [...DANCES, { id: "mine-1", name: "我家猫的舞", nameEn: "My Cat's Dance", duration: 7, origin: "mine" }] : DANCES });

/* ---------------- the stage and the real frog ---------------- */

const stage = createStage(document.getElementById("stage")!);
const character = await loadCharacter("/models/naiwa.glb");
stage.scene.add(character.object);
const bones = new Map<BoneName, THREE.Matrix4>();
const toyBones = new Map<BoneName, THREE.Matrix4>();
const rest = character.spec.body.positions;
const body = new Float32Array(rest.length);
const proxy = new THREE.Mesh(
  new THREE.BufferGeometry()
    .setAttribute("position", new THREE.BufferAttribute(rest, 3))
    .setIndex(new THREE.BufferAttribute(character.spec.body.indices, 1)),
  new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }),
);
const raycaster = new THREE.Raycaster();
const hit = (ray: THREE.Ray) => {
  raycaster.ray.copy(ray);
  return raycaster.intersectObject(proxy, false)[0] ?? null;
};

// a squash spring about the feet, so a poke looks like one
let squash = 0;
let squashVel = 0;
const toy = new THREE.Matrix4();
function poseFrog(dt: number) {
  squashVel += (-160 * squash - 7 * squashVel) * dt;
  squash += squashVel * dt;
  const s = THREE.MathUtils.clamp(squash * 0.1, -0.3, 0.3);
  toy.makeScale(1 + s * 0.6, 1 - s, 1 + s * 0.6);
  character.targetsFromPose(null, bones);
  for (const [name, m] of bones) (toyBones.get(name) ?? toyBones.set(name, new THREE.Matrix4()).get(name)!).multiplyMatrices(toy, m);
  const e = toy.elements;
  for (let i = 0; i < rest.length; i += 3) {
    body[i] = e[0]! * rest[i]!;
    body[i + 1] = e[5]! * rest[i + 1]!;
    body[i + 2] = e[10]! * rest[i + 2]!;
  }
  character.applySim(toyBones, body);
}

stage.setGestureHandler({
  hitTest: (ray) => hit(ray) !== null,
  onTap(p) {
    const h = hit(p.ray);
    if (!h) return;
    squashVel += 3;
    character.react({ kind: "poke", point: h.point, strength: 0.7, region: "belly" });
  },
  onDragStart() {},
  onDragMove() {},
  onDragEnd(p) {
    character.react({ kind: "release", point: p.ray.origin, strength: 0.8 });
  },
  onHover() {},
});

/* ---------------- mock commands ---------------- */

let recorder: MediaRecorder | null = null;
let chunks: Blob[] = [];
let camStream: MediaStream | null = null;
const commands: UICommands = {
  resetFrog: () => stage.resetView(),
  rainBalls: () => console.log("[mock] rainBalls"),
  stepSim: () => console.log("[mock] stepSim"),
  editSimulator: (id) => ui.toast(`[mock] edit ${id}`, "info"),
  startRecording() {
    chunks = [];
    recorder = new MediaRecorder(stage.canvas.captureStream(30), { mimeType: "video/webm" });
    recorder.ondataavailable = (e) => chunks.push(e.data);
    recorder.start(200);
    store.set({ recording: { active: true, startedAt: Date.now() } });
  },
  async stopRecording() {
    const at = store.get().recording.startedAt ?? Date.now();
    store.set({ recording: { active: false, startedAt: null } });
    const rec = await new Promise<Recording>((resolve) => {
      recorder!.onstop = () => {
        const blob = new Blob(chunks, { type: "video/webm" });
        resolve({ blob, mimeType: "video/webm", durationMs: Date.now() - at, url: URL.createObjectURL(blob), fileName: "naiwa-20261016-153000.webm" });
      };
      recorder!.stop();
    });
    store.set({ lastRecording: rec });
  },
  loadVideo(file) {
    store.set({ mode: "video", canSaveDance: false });
    const v = Object.assign(document.createElement("video"), { src: URL.createObjectURL(file), loop: true, muted: true, autoplay: true, playsInline: true });
    ui.preview.replaceChildren(v);
    analyse();
  },
  async copyConfigLink() {
    ui.toast(store.get().lang === "en" ? "Link copied" : "链接已复制", "success");
  },
  async shareRecording() {
    ui.toast(store.get().lang === "en" ? "Video saved" : "视频已保存", "success");
  },
  startCamera() {
    store.set({ mode: "camera", motion: { state: "loading", message: "正在加载姿态模型…" } });
    navigator.mediaDevices.getUserMedia({ video: true }).then(
      (stream) => {
        camStream = stream;
        ui.preview.replaceChildren(Object.assign(document.createElement("video"), { srcObject: stream, muted: true, autoplay: true, playsInline: true }));
        store.set({ motion: { state: "ready", message: "退后一点，让全身入镜" } });
        setTimeout(() => store.set({ motion: { state: "tracking", fps: 28 } }), 1200);
      },
      () => store.set({ motion: { state: "error", message: "没拿到摄像头权限，点地址栏的摄像头图标允许一下" } }),
    );
  },
  stopCamera() {
    camStream?.getTracks().forEach((t) => t.stop());
    ui.preview.replaceChildren();
    store.set({ motion: { state: "idle" } });
  },
  async saveDance(name) {
    const info: DanceInfo = { id: `mine-${Date.now().toString(36)}`, name, duration: 6, origin: "mine" };
    store.set({ dances: [...store.get().dances, info] });
    ui.toast(store.get().lang === "en" ? `Saved “${info.name}” to My motions` : `「${info.name}」已保存到我的动作`, "success");
    return info;
  },
  async deleteDance(id) {
    store.set({ dances: store.get().dances.filter((d) => d.id !== id) });
  },
};

function analyse(to = 1) {
  const t0 = performance.now();
  const step = () => {
    const p = Math.min(to, (performance.now() - t0) / 2500);
    if (p < 1) {
      store.set({ motion: { state: "loading", message: "正在分析舞蹈动作…", progress: p } });
      if (p < to) requestAnimationFrame(step);
    } else store.set({ motion: { state: "tracking", fps: 30 }, canSaveDance: true });
  };
  step();
}

/* ---------------- simulators as the integration registers them (src/sim/api.ts), and live readouts ---------------- */
const gpu = q.has("gpu");
store.set({
  simulators: [
    {
      id: "cpu-constraints",
      name: { zh: "约束求解（CPU）", en: "Constraint solver (CPU)" },
      device: "cpu",
      summary: { zh: "Rapier 软体约束，快速稳定，适合实时跟随动作", en: "Rapier soft-body constraints; fast and stable for live motion" },
      parameters: [
        { key: "substeps", label: { zh: "子步数", en: "Substeps" }, kind: "number", min: 1, max: 16, step: 1, default: 4, help: { zh: "每帧的仿真子步", en: "Simulation substeps per frame" } },
        { key: "iterations", label: { zh: "迭代次数", en: "Iterations" }, kind: "number", min: 1, max: 32, step: 1, default: 8 },
        { key: "compliance", label: { zh: "柔度", en: "Compliance" }, kind: "number", min: 0, max: 0.01, step: 0.0001, unit: "m/N", default: 0.002 },
        { key: "cellModel", label: { zh: "单元模型", en: "Cell model" }, kind: "choice", default: "volume", rebuild: true, choices: [
          { value: "volume", label: { zh: "体积保持", en: "Volume" } },
          { value: "corotational", label: { zh: "共旋", en: "Corotational" } },
          { value: "neohookean", label: { zh: "Neo-Hookean", en: "Neo-Hookean" } },
        ] },
        { key: "resolution", label: { zh: "分辨率", en: "Resolution" }, kind: "choice", default: "medium", rebuild: true, choices: [
          { value: "low", label: { zh: "低", en: "Low" } },
          { value: "medium", label: { zh: "中", en: "Medium" } },
          { value: "high", label: { zh: "高", en: "High" } },
        ] },
        { key: "selfCollision", label: { zh: "自碰撞", en: "Self-collision" }, kind: "boolean", default: true, help: { zh: "手臂与肚子互不穿透", en: "Arms and belly do not pass through each other" } },
      ],
      unavailable: null,
      origin: "builtin",
    },
    {
      id: "gpu-mpm",
      name: { zh: "MPM / FEM（WebGPU）", en: "MPM / FEM (WebGPU)" },
      device: "gpu",
      summary: { zh: "整体求解弹性，形变更准确，需要 WebGPU", en: "Solves the whole body's elasticity; truer deformation, needs WebGPU" },
      parameters: [
        { key: "youngs", label: { zh: "杨氏模量", en: "Young's modulus" }, kind: "number", min: 1, max: 200, step: 1, unit: "kPa", default: 40 },
        { key: "poisson", label: { zh: "泊松比", en: "Poisson's ratio" }, kind: "number", min: 0, max: 0.49, step: 0.01, default: 0.45 },
        { key: "grid", label: { zh: "网格", en: "Grid" }, kind: "number", min: 32, max: 256, step: 32, default: 96, rebuild: true },
      ],
      unavailable: gpu ? null : { zh: "这个浏览器没有 WebGPU", en: "This browser has no WebGPU" },
      origin: "builtin",
    },
    {
      id: "user-pbd",
      name: { zh: "我的 PBD 试验", en: "My PBD experiment" },
      device: "cpu",
      summary: { zh: "用户自己写的位置动力学求解器", en: "A position-based solver written by the user" },
      parameters: [{ key: "stiffness", label: { zh: "刚度", en: "Stiffness" }, kind: "number", min: 0, max: 1, step: 0.01, default: 0.6 }],
      unavailable: null,
      origin: "user",
    },
  ],
});
if (gpu) store.set({ simulator: { id: "gpu-mpm", settings: {} } });
setInterval(() => {
  const big = store.get().simulator.id === "gpu-mpm";
  store.set({
    stats: {
      fps: 58 + Math.random() * 3,
      stepMs: (big ? 6.5 : 2.1) + Math.random() * 0.4,
      particles: big ? 48_000 : 1_842,
      cells: big ? 96 ** 3 / 8 : 6_215,
      volumeRatio: 0.998 + Math.random() * 0.004,
    },
  });
}, 500);

const ui = mountUI(document.getElementById("ui")!, store, commands, { dances: DANCES, presets: MATERIAL_PRESETS });
stage.setTheme(ui.theme());
ui.onTheme((t) => stage.setTheme(t));

// Keep the frog in the middle of the height the UI leaves free (a view offset of the stage camera); sideways it stays
// centred, under the mode tabs and the dock.
let insets = ui.insets();
ui.onInsets((i) => (insets = i));
function frameFree() {
  const w = stage.canvas.clientWidth;
  const h = stage.canvas.clientHeight;
  stage.camera.setViewOffset(w, h, 0, (insets.bottom - insets.top) / 2, w, h);
}

let last = performance.now();
stage.renderer.setAnimationLoop((now) => {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  poseFrog(dt);
  character.update(dt, stage.camera);
  stage.setFocus(character.center(new THREE.Vector3()));
  frameFree();
  stage.frame(dt);
});

/* ---------------- query-driven states for screenshots ---------------- */

const sampleVideo = () => {
  // a still "camera picture" with a tracked skeleton, standing in for what the motion module draws
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 480"><defs><linearGradient id="g" x2="1" y2="1"><stop offset="0" stop-color="#7d8fa8"/><stop offset="1" stop-color="#d9c9a8"/></linearGradient></defs><rect width="640" height="480" fill="url(#g)"/><g fill="none" stroke="#7cf" stroke-width="6" stroke-linecap="round"><circle cx="320" cy="95" r="28"/><path d="M320 123v157l-50 140M320 280l50 140M240 220l80-50 80 50"/></g></svg>`;
  ui.preview.replaceChildren(Object.assign(new Image(), { src: "data:image/svg+xml," + encodeURIComponent(svg) }));
};
const later = (ms: number, f: () => void) => setTimeout(f, ms);
const mode = q.get("mode");
const tool = q.get("tool");
if (q.get("loading") === "1") store.set({ loading: { active: true, message: store.get().lang === "en" ? "Loading the model…" : "正在加载模型…" } });
else later(Number(q.get("load") ?? 300), () => store.set({ loading: { active: false, message: "" } }));
if (mode === "play" || mode === "camera" || mode === "video" || mode === "dance") store.set({ mode });
if (tool) store.set({ tool: tool as Tool });
if (q.has("paused")) store.set({ playback: { paused: true, timeScale: 1 } });
if (q.has("slow")) store.set({ playback: { paused: false, timeScale: 0.25 } });
const motion = q.get("motion");
if (motion) store.set({ motion: { state: motion as "tracking", message: q.get("msg") ?? undefined, fps: 27 } });
if (q.has("custom")) store.set({ params: { softness: 0.42, bellySize: 1.5 } });
if (q.has("regions")) {
  store.set({ params: { regionSoftness: { belly: 1, body: 1, head: 0.2 } } });
  later(200, () => (document.querySelector("#nw-r-head") as HTMLInputElement).focus());
}
if (q.has("recording")) store.set({ recording: { active: true, startedAt: Date.now() - 12_400 } });
const sheet = q.get("sheet");
if (sheet) (document.querySelector(`.nw-tab[data-tab="${sheet}"]`) as HTMLButtonElement).click();
if (q.has("collapsed")) for (const b of document.querySelectorAll<HTMLButtonElement>(".nw-panel-toggle")) b.click();
if (q.has("help")) later(700, () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "?" })));
if (q.has("toast"))
  later(700, () => {
    ui.toast(store.get().lang === "en" ? "Link copied" : "链接已复制", "success");
    ui.toast(store.get().lang === "en" ? "No person detected: step back" : "未检测到人：请后退一些", "warning");
  });
if (q.has("rec")) {
  commands.startRecording();
  later(1500, () => void commands.stopRecording());
}
if (q.has("preview")) sampleVideo();
// as if a file had been dropped (the panel reads the name from the root)
const fakeFile = () => {
  const root = document.getElementById("ui")!;
  root.dataset.videoName = "dance-demo.mp4";
  root.dispatchEvent(new CustomEvent("nw:video", { detail: root.dataset.videoName }));
};
if (q.has("analyse")) {
  store.set({ mode: "video" });
  fakeFile();
  sampleVideo();
  analyse(0.42);
}
if (q.has("analysed")) {
  store.set({ mode: "video" });
  fakeFile();
  sampleVideo();
  store.set({ motion: { state: "tracking", fps: 30 }, canSaveDance: true });
}

Object.assign(window, { mock: { store, ui, commands, stage, character } });
