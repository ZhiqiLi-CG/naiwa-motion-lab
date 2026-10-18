/** Integration: wires stage, character, simulation, motion, media and UI together. */
import "./styles/index.css";
import * as THREE from "three";
import type { BoneName, DanceInfo, FrogEvent, FrogHit, GrabHandle, MotionSource, PointerInfo } from "./contracts";
import { createStore, MATERIAL_PRESETS } from "./store";
import { setLang, tr } from "./i18n";
import { createStage } from "./stage";
import { loadCharacter } from "./character";
import { createFrogSim, initPhysics, listSimulators, onSimulatorsChanged } from "./sim";
import { registerMotionLibrary } from "./algorithms/motion";
import { registerSimLibrary } from "./algorithms/sim";
import { createMotion, metricReadouts } from "./motion";
import { createRecorder, createSfx, decodeConfig, encodeConfig, shareRecording } from "./media";
import { mountLab } from "./lab";
import { mountCodeLab, openCodeLab } from "./labcode";
import { mountUI, type UICommands } from "./ui";

const GRAVITY = 9.81;
/** The pump inflates the flesh up to this volume factor. */
const MAX_BELLY = 1.8;

const store = createStore();
store.set(decodeConfig(location.hash));

const stage = createStage(document.getElementById("stage")!);
const sfx = createSfx();
const motion = createMotion();
registerMotionLibrary();
const recorder = createRecorder({
  onAutoStop: (rec) => finishRecording(rec),
});

let sim: ReturnType<typeof createFrogSim> | null = null;
let character: Awaited<ReturnType<typeof loadCharacter>> | null = null;

/* ---------------- recording ---------------- */

function finishRecording(rec: Awaited<ReturnType<typeof recorder.stop>>) {
  store.set({ recording: { active: false, startedAt: null }, lastRecording: rec });
}

/* ---------------- motion sources (mode switching) ---------------- */

let source: MotionSource | null = null;
let switchToken = 0;
let pendingVideo: File | null = null;
let cameraWanted = false;

function setSource(next: MotionSource | null) {
  source?.dispose();
  source = next;
  if (next) sim?.transition();
  sfx.attachMusic(next?.kind === "video" ? (next.media ?? null) : null);
  store.set({ canSaveDance: false });
}

async function switchMotion() {
  const token = ++switchToken;
  setSource(null);
  const { mode, dance, mirror } = store.get();
  sim?.setMode(mode === "play" ? "free" : "driven");
  if (mode === "play") store.set({ motion: { state: "idle" } });
  try {
    let next: MotionSource | null = null;
    if (mode === "dance") next = motion.startDance(dance);
    else if (mode === "camera" && cameraWanted) next = await motion.startCamera({ mirror, preview: ui.preview });
    else if (mode === "video" && pendingVideo) next = await motion.startVideo(pendingVideo, { mirror, preview: ui.preview });
    if (token !== switchToken) next?.dispose();
    else if (next) setSource(next);
  } catch (err) {
    if (token !== switchToken) return;
    const message = err instanceof Error ? err.message : String(err);
    store.set({ motion: { state: "error", message } });
    ui.toast(message, "error");
  }
}

/* ---------------- commands ---------------- */

let stepRequested = false;

const commands: UICommands = {
  editSimulator: () => openCodeLab({ kind: "simulator" }),
  editRetargeter: () => openCodeLab({ kind: "retargeter" }),
  stepSim() {
    stepRequested = true;
  },
  resetFrog() {
    sim?.reset();
    sim?.clearBalls();
    stage.resetView();
  },
  startRecording() {
    sfx.unlock();
    const { mode, recordLayout } = store.get();
    const companion = mode === "camera" || mode === "video" ? (source?.media ?? null) : null;
    recorder.start(stage.canvas, sfx.stream, { companion, layout: companion ? recordLayout : "frog" });
    store.set({ recording: { active: true, startedAt: Date.now() } });
  },
  async stopRecording() {
    if (!recorder.active) return;
    finishRecording(await recorder.stop());
  },
  loadVideo(file) {
    pendingVideo = file;
    if (store.get().mode === "video") void switchMotion();
    else store.set({ mode: "video" });
  },
  async copyConfigLink() {
    const url = `${location.origin}${location.pathname}${encodeConfig(store.get())}`;
    await navigator.clipboard.writeText(url);
    ui.toast(tr({ zh: "链接已复制（含当前设置）", en: "Link copied (with the current settings)" }), "success");
  },
  rainBalls() {
    for (let i = 0; i < 14; i++) {
      setTimeout(() => {
        const origin = new THREE.Vector3((Math.random() - 0.5) * 1.4, 2.4 + Math.random() * 0.8, (Math.random() - 0.5) * 1.0);
        sim?.throwBall(origin, new THREE.Vector3(0, -1, 0), 0.08 + Math.random() * 0.06);
      }, i * 70);
    }
  },
  async shareRecording() {
    const rec = store.get().lastRecording;
    if (!rec) return;
    try {
      const how = await shareRecording(rec);
      ui.toast(how === "shared" ? tr({ zh: "已分享", en: "Shared" }) : tr({ zh: "视频已保存", en: "Video saved" }), "success");
    } catch (err) {
      // Closing the share sheet is not a failure.
      if (!(err instanceof DOMException && err.name === "AbortError")) throw err;
    }
  },
  startCamera() {
    cameraWanted = true;
    if (store.get().mode === "camera") void switchMotion();
    else store.set({ mode: "camera" });
  },
  stopCamera() {
    cameraWanted = false;
    setSource(null);
    store.set({ motion: { state: "idle" } });
  },
  async saveDance(name) {
    const track = source?.track?.();
    if (!track) throw new Error(tr({ zh: "视频还没分析完", en: "The video is not analysed yet" }));
    const info = await motion.saveDance(track, name);
    ui.toast(tr({ zh: `「${info.name}」存进我的舞蹈啦`, en: `"${info.nameEn ?? info.name}" saved to My Dances` }), "success");
    return info;
  },
  async deleteDance(id) {
    await motion.deleteDance(id);
  },
};

const ui = mountUI(document.getElementById("ui")!, store, commands, { dances: motion.dances(), presets: MATERIAL_PRESETS });
stage.setTheme(ui.theme());
ui.onTheme((theme) => stage.setTheme(theme));
// The code lab mounts on the body: mountUI rebuilds #ui when the language changes.
const codeLab = mountCodeLab({
  host: document.body,
  store,
  spec: () => character?.spec ?? null,
  binding: () => motion.binding(),
  toast: (m, k) => ui.toast(m, k),
});
// The local Lab (node lab/server.mjs + Codex): shows nothing unless its server answers and Codex is logged in.
const lab = mountLab({
  store,
  codeLab,
  commands,
  stage,
  motion,
  sim: () => sim,
  presets: MATERIAL_PRESETS,
  toast: (m, k) => ui.toast(m, k),
  videoTrack: () => source?.track?.() ?? null,
});
// Frame the frog in the part of the window the panels, the code lab and the Lab chat leave free.
const frameStage = () => {
  const a = ui.insets(), b = codeLab.insets(), c = lab.insets();
  stage.setInsets({ ...a, right: Math.max(a.right, b.right, c.right) });
};
ui.onInsets(frameStage);
codeLab.onInsets(frameStage);
lab.onInsets(frameStage);
frameStage();
sfx.setEnabled(store.get().sound);

function setDances(dances: DanceInfo[]) {
  store.set({ dances });
}
motion.onDancesChanged(setDances);
motion.onStatus((status) => {
  store.set({ motion: status });
  if (source?.kind === "video" && !store.get().canSaveDance && source.track?.()) store.set({ canSaveDance: true });
});

store.subscribe((s, prev) => {
  if (s.lang !== prev.lang) setLang(s.lang);
  if (s.sound !== prev.sound) sfx.setEnabled(s.sound);
  if (s.params !== prev.params) sim?.setParams(effectiveParams());
  if (s.simulator !== prev.simulator) rebuildSim();
  if (s.retargeter !== prev.retargeter) motion.setRetargeter(s.retargeter);
  const mirrorMatters = s.mode === "camera" || s.mode === "video";
  if (s.mode !== prev.mode || s.dance !== prev.dance || (mirrorMatters && s.mirror !== prev.mirror)) void switchMotion();
});

/* ---------------- the simulation (rebuilt when the simulator options change) ---------------- */

function buildSim() {
  if (!character) return;
  sim?.dispose();
  sim = createFrogSim(character.spec, effectiveParams(), store.get().simulator);
  sim.onEvent(onFrogEvent);
  sim.setMode(store.get().mode === "play" ? "free" : "driven");
  sentBelly = -1;
}

function rebuildSim() {
  grab = null;
  buildSim();
}

/* ---------------- pump: hold to inflate the flesh (volume factor), it relaxes back when let go ---------------- */

let pumping = false;
let pumpExtra = 0;
let sentBelly = -1;

function effectiveParams() {
  const p = store.get().params;
  return { ...p, bellySize: p.bellySize + pumpExtra };
}

function updatePump(dt: number) {
  if (!sim) return;
  const base = store.get().params.bellySize;
  if (pumping) pumpExtra = Math.min(pumpExtra + dt * 0.45, Math.max(0, MAX_BELLY - base));
  else if (pumpExtra > 0) pumpExtra = Math.max(0, pumpExtra - dt * 0.12);
  const belly = base + pumpExtra;
  if (Math.abs(belly - sentBelly) > 0.01) {
    sentBelly = belly;
    sim.setParams(effectiveParams());
  }
}

/* ---------------- gestures → tools ---------------- */

const floor = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const dragPlane = new THREE.Plane();
let grab: GrabHandle | null = null;
let pressHit: FrogHit | null = null;
let tickleAt = 0;
const trail: { p: THREE.Vector3; t: number }[] = [];

function throwBallAt(p: PointerInfo) {
  if (!sim) return;
  const target = sim.raycast(p.ray)?.point ?? p.ray.intersectPlane(floor, new THREE.Vector3()) ?? p.ray.at(4, new THREE.Vector3());
  const origin = stage.camera.position.clone().add(new THREE.Vector3(0, -0.25, 0));
  const flight = THREE.MathUtils.clamp(origin.distanceTo(target) / 6, 0.35, 0.8);
  const g = GRAVITY * store.get().params.gravity;
  const velocity = target.clone().sub(origin).divideScalar(flight);
  velocity.y += 0.5 * g * flight;
  sim.throwBall(origin, velocity, 0.1);
}

function tickle(p: PointerInfo) {
  if (!sim || p.time - tickleAt < 70) return;
  const hit = sim.raycast(p.ray);
  if (!hit) return;
  tickleAt = p.time;
  sim.poke(hit, 0.12, p.ray.direction);
  character?.react({ kind: "tickle", point: hit.point, strength: 0.35, region: hit.region });
}

/** A screen velocity (px/s) as a world velocity at the depth of point. */
function screenToWorldVelocity(v: THREE.Vector2, point: THREE.Vector3): THREE.Vector3 {
  const cam = stage.camera;
  const depth = cam.position.distanceTo(point);
  const metersPerPx = (2 * depth * Math.tan(THREE.MathUtils.degToRad(cam.fov / 2))) / stage.canvas.clientHeight;
  const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0);
  const up = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 1);
  return right.multiplyScalar(v.x * metersPerPx).addScaledVector(up, -v.y * metersPerPx);
}

stage.setGestureHandler({
  hitTest(ray) {
    if (!sim || store.get().tool === "ball") return false;
    pressHit = sim.raycast(ray);
    return pressHit !== null;
  },
  onPressStart() {
    sfx.unlock();
    if (store.get().tool === "pump") pumping = true;
  },
  onPressEnd() {
    pumping = false;
  },
  onTap(p) {
    sfx.unlock();
    const tool = store.get().tool;
    if (tool === "ball") return throwBallAt(p);
    if (tool === "feather") return tickle(p);
    if (tool !== "hand" || !sim) return;
    const hit = sim.raycast(p.ray);
    if (!hit) return;
    sim.poke(hit, 0.7, p.ray.direction);
  },
  onSwipe(p, velocity) {
    if (!sim || store.get().tool !== "hand") return;
    const hit = sim.raycast(p.ray) ?? pressHit;
    if (!hit) return;
    sim.slap(hit.point, screenToWorldVelocity(velocity, hit.point).clampLength(0, 14));
  },
  onDragStart(p) {
    const tool = store.get().tool;
    if (tool === "feather") return tickle(p);
    if (tool !== "hand" || !sim || !pressHit) return;
    grab = sim.grab(pressHit);
    dragPlane.setFromNormalAndCoplanarPoint(stage.camera.getWorldDirection(new THREE.Vector3()).negate(), pressHit.point);
    trail.length = 0;
    trail.push({ p: pressHit.point.clone(), t: p.time });
  },
  onDragMove(p) {
    if (store.get().tool === "feather") return tickle(p);
    if (!grab) return;
    const point = p.ray.intersectPlane(dragPlane, new THREE.Vector3());
    if (!point) return;
    point.y = Math.max(point.y, 0.02);
    grab.move(point);
    trail.push({ p: point, t: p.time });
    while (trail.length > 2 && p.time - trail[0].t > 90) trail.shift();
  },
  onDragEnd() {
    if (!grab) return;
    const first = trail[0];
    const last = trail[trail.length - 1];
    const span = Math.max((last.t - first.t) / 1000, 1 / 120);
    const velocity = last.p.clone().sub(first.p).divideScalar(span).clampLength(0, 12);
    grab.release(velocity);
    grab = null;
  },
  onHover(p) {
    if (!character) return;
    if (!p) return character.lookAt(null);
    const center = character.center(new THREE.Vector3());
    character.lookAt(p.ray.at(p.ray.origin.distanceTo(center), new THREE.Vector3()));
  },
});

/* ---------------- what happens to the frog → its face and (optional) impact sounds ---------------- */

const IMPACT_SOUND: Partial<Record<FrogEvent["kind"], Parameters<typeof sfx.play>[0]>> = {
  poke: "boing",
  slap: "slap",
  squish: "squish",
  land: "land",
  ball: "ball",
};

function onFrogEvent(e: FrogEvent) {
  character?.react(e);
  const sound = IMPACT_SOUND[e.kind];
  if (sound && e.strength >= 0.15) sfx.play(sound, e.strength);
}

/* ---------------- boot and the frame loop ---------------- */

async function boot() {
  store.set({ loading: { active: true, message: tr({ zh: "正在叫醒奶蛙…", en: "Waking 奶蛙 up…" }) } });
  void motion.ready().then(() => setDances(motion.dances()));
  const [, loaded] = await Promise.all([initPhysics(), loadCharacter()]);
  registerSimLibrary();
  // Saved experiments register their blocks before the lists are read.
  await codeLab.ready;
  store.set({ simulators: listSimulators(), retargeters: motion.retargeters() });
  motion.onRetargetersChanged((retargeters) => store.set({ retargeters }));
  motion.setRetargeter(store.get().retargeter);
  onSimulatorsChanged(() => store.set({ simulators: listSimulators() }));
  character = loaded;
  stage.scene.add(character.object);
  motion.bind(character.rig);
  buildSim();
  store.set({ loading: { active: false, message: "" } });
  await switchMotion();

  const targets = new Map<BoneName, THREE.Matrix4>();
  const bones = new Map<BoneName, THREE.Matrix4>();
  const limbs = new Map<string, Float32Array>();
  const focus = new THREE.Vector3();
  let last = performance.now();
  let fpsFrames = 0;
  let fpsSince = last;
  let stepMs = 0;

  const tick = (now: number) => {
    requestAnimationFrame(tick);
    const frameDt = Math.min((now - last) / 1000, 1 / 20);
    last = now;
    if (!sim || !character) return;
    const { paused, timeScale } = store.get().playback;
    const advance = !paused || stepRequested;
    const dt = paused ? (stepRequested ? 1 / 60 : 0) : frameDt * timeScale;
    stepRequested = false;
    const pose = source ? source.update(now, dt) : null;
    character.targetsFromPose(pose, targets);
    sim.setTargets(targets, pose?.contacts);
    character.setExpressions(pose?.expressions);
    updatePump(dt);
    if (advance) {
      const t0 = performance.now();
      sim.step(dt);
      stepMs = stepMs * 0.9 + (performance.now() - t0) * 0.1;
    }
    sim.readBones(bones);
    sim.readLimbs?.(limbs);
    character.applySim(bones, sim.readBody(), limbs);
    character.update(frameDt, stage.camera);
    stage.setBalls(sim.readBalls());
    stage.setFocus(character.center(focus));
    stage.frame(frameDt);

    fpsFrames++;
    if (now - fpsSince > 500) {
      const fps = Math.round((fpsFrames * 1000) / (now - fpsSince));
      fpsFrames = 0;
      fpsSince = now;
      const s = sim.stats();
      const m = motion.metrics();
      store.set({
        motion: { ...store.get().motion, metrics: m ? metricReadouts(m) : [] },
        stats: { fps, stepMs: Math.round(stepMs * 100) / 100, particles: s.particles, cells: s.cells, volumeRatio: Math.round(s.volumeRatio * 1000) / 1000 },
      });
    }
  };
  requestAnimationFrame(tick);

  // For the end-to-end checks; getters, since the simulation and the character are rebuilt.
  Object.assign(window, { __naiwa: { store, get sim() { return sim; }, get character() { return character; }, stage, motion, commands } });
}

boot().catch((err) => {
  console.error(err);
  const reason = err instanceof Error ? err.message : String(err);
  store.set({ loading: { active: true, message: tr({ zh: `奶蛙没醒过来：${reason}`, en: `奶蛙 did not wake up: ${reason}` }) } });
});
