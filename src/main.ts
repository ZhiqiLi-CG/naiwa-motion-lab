/** Integration: wires stage, character, simulation, motion, media and UI together. */
import "./styles/index.css";
import * as THREE from "three";
import type { BoneName, DanceInfo, FrogEvent, FrogHit, GrabHandle, MotionSource, PointerInfo } from "./contracts";
import { createStore, MATERIAL_PRESETS } from "./store";
import { createStage } from "./stage";
import { loadCharacter } from "./character";
import { createFrogSim, initPhysics } from "./sim";
import { createMotion } from "./motion";
import { createRecorder, createSfx, decodeConfig, encodeConfig, shareRecording } from "./media";
import { mountUI, type UICommands } from "./ui";

const POKE_WORDS = ["DUANG~", "噗!", "啵~", "boing!", "Q弹!"];
const GIGGLE_WORDS = ["嘻嘻", "哈哈", "痒!", "嘿嘿"];
const GRAVITY = 9.81;
/** Inflating past this belly size pops it. */
const POP_SIZE = 1.9;

const store = createStore();
store.set(decodeConfig(location.hash));

const stage = createStage(document.getElementById("stage")!);
const sfx = createSfx();
const motion = createMotion();
const recorder = createRecorder({
  onAutoStop: (rec) => finishRecording(rec),
});

let sim: ReturnType<typeof createFrogSim> | null = null;
let character: Awaited<ReturnType<typeof loadCharacter>> | null = null;

/* ---------------- recording ---------------- */

function finishRecording(rec: Awaited<ReturnType<typeof recorder.stop>>) {
  const old = store.get().lastRecording;
  if (old && old !== rec) URL.revokeObjectURL(old.url);
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

const commands: UICommands = {
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
    ui.toast("链接已复制，发给朋友一起戳奶蛙！", "success");
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
    const how = await shareRecording(rec);
    ui.toast(how === "shared" ? "分享出去啦！" : "视频已保存", "success");
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
    if (!track) throw new Error("视频还没分析完");
    const info = await motion.saveDance(track, name);
    ui.toast(`「${info.name}」存进我的舞蹈啦`, "success");
    return info;
  },
  async deleteDance(id) {
    await motion.deleteDance(id);
  },
};

const ui = mountUI(document.getElementById("ui")!, store, commands, { dances: motion.dances(), presets: MATERIAL_PRESETS });
stage.setTheme(ui.theme());
ui.onTheme((theme) => stage.setTheme(theme));
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
  if (s.sound !== prev.sound) sfx.setEnabled(s.sound);
  if (s.params !== prev.params) sim?.setParams(effectiveParams());
  const mirrorMatters = s.mode === "camera" || s.mode === "video";
  if (s.mode !== prev.mode || s.dance !== prev.dance || (mirrorMatters && s.mirror !== prev.mirror)) void switchMotion();
});

/* ---------------- pump: hold to inflate, it pops when overdone ---------------- */

let pumping = false;
let pumpExtra = 0;
let pumpSoundAt = 0;
let sentBelly = -1;

function effectiveParams() {
  const p = store.get().params;
  return { ...p, bellySize: p.bellySize + pumpExtra };
}

function updatePump(dt: number, now: number) {
  if (!sim || !character) return;
  const base = store.get().params.bellySize;
  if (pumping) {
    pumpExtra += dt * 0.45;
    if (now - pumpSoundAt > 380) {
      sfx.play("pump", Math.min(1, 0.4 + pumpExtra));
      pumpSoundAt = now;
    }
    if (base + pumpExtra > POP_SIZE) {
      pumpExtra = 0;
      pumping = false;
      const at = character.center(new THREE.Vector3());
      sfx.play("pop", 1);
      stage.fx.popText(at.clone().add(new THREE.Vector3(0, 0.35, 0.3)), "噗——!", { size: 1.6, color: "#ff6b6b" });
      stage.fx.burst(at, "drops", 24);
      stage.fx.shake(0.6);
      character.react({ kind: "squish", point: at, strength: 1 });
    }
  } else if (pumpExtra > 0) {
    pumpExtra = Math.max(0, pumpExtra - dt * 0.12);
  }
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
let giggleAt = 0;
const trail: { p: THREE.Vector3; t: number }[] = [];

function bump(stat: "pokes" | "throws") {
  const stats = store.get().stats;
  store.set({ stats: { ...stats, [stat]: stats[stat] + 1 } });
}

function pick<T>(list: T[]): T {
  return list[Math.floor(Math.random() * list.length)];
}

function throwBallAt(p: PointerInfo) {
  if (!sim) return;
  const target = sim.raycast(p.ray)?.point ?? p.ray.intersectPlane(floor, new THREE.Vector3()) ?? p.ray.at(4, new THREE.Vector3());
  const origin = stage.camera.position.clone().add(new THREE.Vector3(0, -0.25, 0));
  const flight = THREE.MathUtils.clamp(origin.distanceTo(target) / 6, 0.35, 0.8);
  const g = GRAVITY * store.get().params.gravity;
  const velocity = target.clone().sub(origin).divideScalar(flight);
  velocity.y += 0.5 * g * flight;
  sim.throwBall(origin, velocity, 0.1);
  sfx.play("whoosh", 0.4);
}

function tickle(p: PointerInfo) {
  if (!sim || p.time - tickleAt < 70) return;
  const hit = sim.raycast(p.ray);
  if (!hit) return;
  tickleAt = p.time;
  sim.poke(hit, 0.12, p.ray.direction);
  character?.react({ kind: "tickle", point: hit.point, strength: 0.35, region: hit.region });
  if (p.time - giggleAt > 650) {
    giggleAt = p.time;
    sfx.play("giggle", 0.6);
    stage.fx.popText(hit.point.clone().addScaledVector(hit.normal, 0.12), pick(GIGGLE_WORDS), { color: "#ff8fb1" });
  }
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
    bump("pokes");
  },
  onSwipe(p, velocity) {
    if (!sim || store.get().tool !== "hand") return;
    const hit = sim.raycast(p.ray) ?? pressHit;
    if (!hit) return;
    sim.slap(hit.point, screenToWorldVelocity(velocity, hit.point).clampLength(0, 14));
    bump("pokes");
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
    if (velocity.length() > 3) {
      bump("throws");
      sfx.play("whoosh", Math.min(1, velocity.length() / 10));
      stage.fx.popText(last.p.clone().add(new THREE.Vector3(0, 0.3, 0)), "飞~", { color: "#5fb3ff" });
    }
  },
  onHover(p) {
    if (!character) return;
    if (!p) return character.lookAt(null);
    const center = character.center(new THREE.Vector3());
    character.lookAt(p.ray.at(p.ray.origin.distanceTo(center), new THREE.Vector3()));
  },
});

/* ---------------- what happens to the frog → sound, comic effects, face ---------------- */

function onFrogEvent(e: FrogEvent) {
  character?.react(e);
  const above = e.point.clone().add(new THREE.Vector3(0, 0.15, 0.1));
  switch (e.kind) {
    case "poke":
      sfx.play("boing", e.strength);
      stage.fx.popText(above, pick(POKE_WORDS), { size: 0.8 + e.strength * 0.6 });
      break;
    case "slap":
      sfx.play("slap", e.strength);
      stage.fx.popText(above, "啪!", { size: 1 + e.strength * 0.8, color: "#ff6b6b" });
      stage.fx.burst(e.point, "stars", 6 + Math.round(e.strength * 10));
      stage.fx.shake(0.25 * e.strength);
      break;
    case "grab":
      sfx.play("squish", 0.5);
      break;
    case "squish":
      sfx.play("squish", e.strength);
      break;
    case "land":
      if (e.strength < 0.15) break;
      sfx.play("land", e.strength);
      if (e.strength > 0.5) {
        stage.fx.popText(above, "咚!", { size: 1.2 });
        stage.fx.shake(0.4 * e.strength);
      }
      break;
    case "ball":
      sfx.play("ball", e.strength);
      if (e.strength > 0.5) stage.fx.popText(above, "嘭!", { size: 0.9 });
      break;
    default:
      break;
  }
}

/* ---------------- boot and the frame loop ---------------- */

async function boot() {
  store.set({ loading: { active: true, message: "正在叫醒奶蛙…" } });
  void motion.ready().then(() => setDances(motion.dances()));
  const [, loaded] = await Promise.all([initPhysics(), loadCharacter()]);
  character = loaded;
  stage.scene.add(character.object);
  motion.bind(character.rig);
  sim = createFrogSim(character.spec, effectiveParams());
  sim.onEvent(onFrogEvent);
  character.onMood((mood) => {
    if (mood === "giggling") sfx.play("giggle", 0.7);
    else if (mood === "laughing") sfx.play("laugh", 0.9);
  });
  store.set({ loading: { active: false, message: "" } });
  await switchMotion();

  const targets = new Map<BoneName, THREE.Matrix4>();
  const bones = new Map<BoneName, THREE.Matrix4>();
  const limbs = new Map<string, Float32Array>();
  const focus = new THREE.Vector3();
  let last = performance.now();
  let fpsFrames = 0;
  let fpsSince = last;

  const tick = (now: number) => {
    requestAnimationFrame(tick);
    const dt = Math.min((now - last) / 1000, 1 / 20);
    last = now;
    if (!sim || !character) return;
    const pose = source ? source.update(now, dt) : null;
    character.targetsFromPose(pose, targets);
    sim.setTargets(targets);
    character.setExpressions(pose?.expressions);
    updatePump(dt, now);
    sim.step(dt);
    sim.readBones(bones);
    sim.readLimbs?.(limbs);
    character.applySim(bones, sim.readBody(), limbs);
    character.update(dt, stage.camera);
    stage.setBalls(sim.readBalls());
    stage.setFocus(character.center(focus));
    stage.frame(dt);

    fpsFrames++;
    if (now - fpsSince > 500) {
      const fps = Math.round((fpsFrames * 1000) / (now - fpsSince));
      fpsFrames = 0;
      fpsSince = now;
      if (fps !== store.get().stats.fps) store.set({ stats: { ...store.get().stats, fps } });
    }
  };
  requestAnimationFrame(tick);

  // For the end-to-end checks.
  Object.assign(window, { __naiwa: { store, sim, character, stage, motion, commands } });
}

boot().catch((err) => {
  console.error(err);
  store.set({ loading: { active: true, message: `奶蛙没醒过来：${err instanceof Error ? err.message : String(err)}` } });
});
