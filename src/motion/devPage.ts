/**
 * dev/motion.html: the motion module on its own. The frog (public/models/naiwa.glb, or the contract test frog) is posed
 * straight from the PoseFrames (no simulation), seen from the front and the side, with its skeleton drawn on top.
 *
 * URL: ?dance=<id> &t=<seconds> (freeze) &camera=1 &video=<url> &mirror=0 &rig=test &xray=1 &scale=<time scale>
 * Keys: space pause, . single step, 1 / 2 / 3 time scale 1 / 0.5 / 0.25.
 */
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { CHARACTER_URL, CORE_BONES, EXPRESSIONS, FINGER_BONES, type BoneName, type MotionSource, type MotionStatus, type PoseFrame, type RigInfo } from "../contracts";
import { PROCEDURAL_DANCES } from "./dances";
import { createMotion } from "./index";
import { limbPenetration, solve } from "./rig";
import { buildTestFrog } from "./testFrog";

const params = new URLSearchParams(location.search);
const motion = createMotion();
const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;

const renderer = new THREE.WebGLRenderer({ canvas: $("#view"), antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x20232a);
scene.add(new THREE.HemisphereLight(0xfff6e0, 0x404050, 2.2));
const sun = new THREE.DirectionalLight(0xffffff, 1.6);
sun.position.set(1.5, 3, 2);
scene.add(sun);
const grid = new THREE.GridHelper(4, 16, 0x556070, 0x343a46);
scene.add(grid);
const front = new THREE.PerspectiveCamera(32, 1, 0.05, 20);
front.position.set(0, 0.62, 2.5);
front.lookAt(0, 0.5, 0);
const side = new THREE.PerspectiveCamera(32, 1, 0.05, 20);
side.position.set(2.5, 0.62, 0);
side.lookAt(0, 0.5, 0);

interface Frog {
  object: THREE.Object3D;
  rig: RigInfo;
  rest: Map<BoneName, THREE.Quaternion>;
  morphs: THREE.Mesh[];
}

async function loadFrog(): Promise<Frog> {
  let object: THREE.Object3D;
  let rig: RigInfo;
  if (params.get("rig") !== "test") {
    try {
      const gltf = await new GLTFLoader().loadAsync(`/${CHARACTER_URL}`);
      object = gltf.scene;
      const bones = new Map<BoneName, THREE.Bone>();
      for (const n of [...CORE_BONES, ...FINGER_BONES]) {
        const b = object.getObjectByName(n);
        if (b instanceof THREE.Bone) bones.set(n, b);
      }
      let skeleton: THREE.Skeleton | null = null;
      object.traverse((o) => {
        if ((o as THREE.SkinnedMesh).isSkinnedMesh) skeleton ??= (o as THREE.SkinnedMesh).skeleton;
      });
      object.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(object);
      rig = { skeleton: skeleton!, bones, height: box.max.y - box.min.y };
      return finish(object, rig, "glb");
    } catch (e) {
      console.warn("motion dev: no GLB, using the test frog", e);
    }
  }
  ({ object, rig } = buildTestFrog());
  return finish(object, rig, "test");
}

function finish(object: THREE.Object3D, rig: RigInfo, kind: string): Frog {
  const rest = new Map<BoneName, THREE.Quaternion>();
  for (const [n, b] of rig.bones) rest.set(n, b.quaternion.clone());
  const morphs: THREE.Mesh[] = [];
  object.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh && m.morphTargetDictionary) morphs.push(m);
    if (m.isMesh && params.get("xray")) {
      const mat = (m.material as THREE.MeshStandardMaterial).clone();
      mat.transparent = true;
      mat.opacity = 0.45;
      m.material = mat;
    }
  });
  dev.rig = kind;
  return { object, rig, rest, morphs };
}

// Skeleton lines drawn over everything.
const lines = new THREE.LineSegments(
  new THREE.BufferGeometry(),
  new THREE.LineBasicMaterial({ color: 0x35e0ff, depthTest: false, transparent: true }),
);
lines.renderOrder = 10;
scene.add(lines);
const joints = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ color: 0xff5470, size: 6, sizeAttenuation: false, depthTest: false }));
joints.renderOrder = 11;
scene.add(joints);

function drawSkeleton(frog: Frog) {
  const pos: number[] = [];
  const pts: number[] = [];
  const w = new THREE.Vector3();
  for (const [, bone] of frog.rig.bones) {
    bone.getWorldPosition(w);
    pts.push(w.x, w.y, w.z);
    const parent = bone.parent;
    if (parent instanceof THREE.Bone && [...frog.rig.bones.values()].includes(parent)) {
      const p = parent.getWorldPosition(new THREE.Vector3());
      pos.push(p.x, p.y, p.z, w.x, w.y, w.z);
    }
  }
  lines.geometry.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  joints.geometry.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
}

function applyFrame(frog: Frog, frame: PoseFrame | null) {
  for (const [n, b] of frog.rig.bones) b.quaternion.copy(frame?.bones[n] ?? frog.rest.get(n)!);
  frog.object.position.copy(frame?.rootOffset ?? new THREE.Vector3());
  frog.object.rotation.set(0, frame?.rootYaw ?? 0, 0);
  for (const m of frog.morphs)
    for (const e of EXPRESSIONS) {
      const i = m.morphTargetDictionary![e];
      if (i !== undefined) m.morphTargetInfluences![i] = frame?.expressions?.[e] ?? 0;
    }
  frog.object.updateMatrixWorld(true);
}

const dev = {
  motion,
  rig: "",
  frame: null as PoseFrame | null,
  status: null as MotionStatus | null,
  statuses: [] as MotionStatus[],
  source: null as MotionSource | null,
  frames: 0,
};
(window as unknown as { motionDev: typeof dev & { audit: typeof audit } }).motionDev = Object.assign(dev, { audit });

/** Worst limb penetration (m) and when, per procedural dance, on the loaded rig. */
function audit() {
  const b = motion.binding()!;
  return PROCEDURAL_DANCES.map((d) => {
    let worst = 0, at = 0;
    for (let t = 0; t < d.duration; t += 0.04) {
      const pen = limbPenetration(b, solve(b, d.pose(t)));
      if (pen > worst) (worst = pen), (at = t);
    }
    return { id: d.id, worst: +worst.toFixed(3), at: +at.toFixed(2) };
  });
}

const statusEl = $("#status");
motion.onStatus((s) => {
  dev.status = s;
  dev.statuses.push(s);
  statusEl.textContent = `${s.state}${s.message ? " · " + s.message : ""}${s.fps ? ` · ${s.fps.toFixed(0)} fps` : ""}`;
});

function use(src: MotionSource) {
  dev.source?.dispose();
  dev.source = src;
}

async function main() {
  const frog = await loadFrog();
  scene.add(frog.object);
  motion.bind(frog.rig);
  await motion.ready();
  const preview = $("#preview");
  const mirror = $<HTMLInputElement>("#mirror");
  mirror.checked = params.get("mirror") !== "0";

  const bar = $("#dances");
  for (const d of motion.dances()) {
    const btn = document.createElement("button");
    btn.textContent = d.name;
    btn.title = `${d.id} · ${d.duration.toFixed(1)} s`;
    btn.onclick = () => use(motion.startDance(d.id));
    bar.append(btn);
  }
  $("#camera").onclick = () => motion.startCamera({ mirror: mirror.checked, preview }).then(use, (e) => console.warn(e));
  $<HTMLInputElement>("#file").onchange = (ev) => {
    const f = (ev.target as HTMLInputElement).files?.[0];
    if (f) motion.startVideo(f, { mirror: mirror.checked, preview }).then(use, (e) => console.warn(e));
  };
  $("#stop").onclick = () => {
    dev.source?.dispose();
    dev.source = null;
  };

  if (params.get("dance")) use(motion.startDance(params.get("dance")!));
  if (params.get("camera")) motion.startCamera({ mirror: mirror.checked, preview }).then(use, (e) => console.warn(String(e)));
  if (params.get("video")) motion.startVideo(params.get("video")!, { mirror: mirror.checked, preview }).then(use, (e) => console.warn(String(e)));

  // The clock: dt is scaled for slow motion (?scale=, keys 1/2/3), 0 while paused (space), one frame per "." step.
  let scale = Number(params.get("scale") ?? 1);
  let paused = false;
  let stepOnce = false;
  addEventListener("keydown", (e) => {
    if (e.key === " ") paused = !paused;
    else if (e.key === ".") (paused = true), (stepOnce = true);
    else if ("123".includes(e.key)) scale = [1, 0.5, 0.25]["123".indexOf(e.key)];
  });
  // Frozen time (?t=): step the source there (filters and faces settle on the way), then pause.
  const freeze = params.get("t");
  if (freeze !== null && dev.source) {
    await new Promise((r) => setTimeout(r, 50));
    const loopLen = motion.dances().find((d) => d.id === params.get("dance"))?.duration ?? 1;
    const total = Number(freeze) + Math.ceil(1.5 / loopLen) * loopLen;
    for (let t = 0; t < total - 1e-9; t += 0.02) dev.source.update(performance.now(), Math.min(0.02, total - t));
    paused = true;
  }
  let last = performance.now();
  const loop = (now: number) => {
    const dt = paused ? (stepOnce ? 1 / 60 : 0) : ((now - last) / 1000) * scale;
    stepOnce = false;
    dev.frame = dev.source ? dev.source.update(now, dt) : null;
    last = now;
    dev.frames++;
    applyFrame(frog, dev.frame);
    drawSkeleton(frog);
    const { width, height } = renderer.domElement.getBoundingClientRect();
    renderer.setSize(width, height, false);
    renderer.setScissorTest(true);
    for (const [i, cam] of [front, side].entries()) {
      const x = (i * width) / 2;
      cam.aspect = width / 2 / height;
      cam.updateProjectionMatrix();
      renderer.setViewport(x, 0, width / 2, height);
      renderer.setScissor(x, 0, width / 2, height);
      renderer.render(scene, cam);
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

main().catch((e) => console.error(e));
