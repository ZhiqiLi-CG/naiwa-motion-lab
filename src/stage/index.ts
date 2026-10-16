/** The stage: renderer, lights, set, camera and gestures around the simulated frog (plus the contract's Fx, kept
 *  working but no longer used by the app: a clean viewport for a simulation page). */
import * as THREE from "three";
import type { Fx, PointerInfo, Stage } from "../contracts";
import { createBalls } from "./balls";
import { CameraRig, FOV } from "./cameraRig";
import { createContactShadow } from "./contactShadow";
import { buildEnvironment } from "./env";
import { bindPointerEvents, GestureRecognizer, type StageGestureHandler } from "./gestures";
import { THEMES, type ThemeName } from "./palette";
import { createParticles } from "./particles";
import { createPopTexts } from "./popText";
import { createSet } from "./set";

export type { StageGestureHandler } from "./gestures";
export type { ThemeName } from "./palette";

export interface StageInfo {
  /** CPU time of the last frame() (ms), all passes included. */
  cpuMs: number;
  drawCalls: number;
  triangles: number;
  pixelRatio: number;
}

/** The contract's Stage plus what the stage can do beyond it. */
export interface PlayStage extends Stage {
  /** Also takes the optional onSwipe (a fast swipe across the frog, for slaps). */
  setGestureHandler(h: StageGestureHandler): void;
  /** Ease back to the default view (orbit and zoom), e.g. when the frog is reset. */
  resetView(): void;
  /** Ease to a view (radians; yaw 0 = in front of the frog, π/2 = its left side; zoom 1 = default framing), e.g. for
   *  front / side / top buttons. Unset fields keep their value. */
  setView(v: { yaw?: number; pitch?: number; zoom?: number }): void;
  /** How much of each canvas edge the UI covers (CSS px, as the UI's insets): the frog is framed in the free middle,
   *  easing when panels open or close. */
  setInsets(i: { top: number; right: number; bottom: number; left: number }): void;
  readonly info: StageInfo;
}

/** Key light relative to the camera's heading: up and well to the camera's left, so the side you see is lit, the
 *  shadow falls behind to the right whichever way the stage is turned, and the belly is lit at a raking angle where
 *  every dent and bulge changes its shading (the themes keep the ambient environment low for the same reason). */
const KEY_OFFSET = new THREE.Vector3(-3.3, 2.7, 1.0);
const SHADOW_HALF = 2.4;
/** Phones get a lower pixel-ratio cap: the frog and the physics need the budget more than extra pixels. */
const DPR_CAP_DESKTOP = 2;
const DPR_CAP_TOUCH = 1.5;

export function createStage(container: HTMLElement): PlayStage {
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  // Neutral keeps the toy's yellow its own colour (ACES would push it to orange and desaturate the cream).
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.VSMShadowMap;
  // Shadows are rendered once per frame by frame(), not again by the contact shadow pass.
  renderer.shadowMap.autoUpdate = false;
  renderer.info.autoReset = false;
  const canvas = renderer.domElement;
  Object.assign(canvas.style, {
    display: "block",
    width: "100%",
    height: "100%",
    touchAction: "none",
    userSelect: "none",
    webkitUserSelect: "none",
    outline: "none",
  });
  canvas.style.setProperty("-webkit-touch-callout", "none");
  canvas.style.setProperty("-webkit-tap-highlight-color", "transparent");
  container.appendChild(canvas);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.05, 120);
  const rig = new CameraRig(camera);
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  rig.shakeScale = reducedMotion.matches ? 0.35 : 1;

  const key = new THREE.DirectionalLight(0xffffff, 2);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  Object.assign(key.shadow.camera, {
    left: -SHADOW_HALF,
    right: SHADOW_HALF,
    top: SHADOW_HALF,
    bottom: -SHADOW_HALF,
    near: 0.5,
    far: 12,
  });
  key.shadow.camera.updateProjectionMatrix();
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.02;
  key.shadow.radius = 10;
  key.shadow.blurSamples = 12;
  scene.add(key, key.target);

  const set = createSet();
  const contact = createContactShadow();
  const balls = createBalls();
  const particles = createParticles();
  const pops = createPopTexts();
  scene.add(set.sky, set.floor, balls.object, particles.mesh, pops.group);
  const notInContact = [set.sky, set.floor, particles.mesh, pops.group];

  const envs = new Map<ThemeName, THREE.WebGLRenderTarget>();
  const envFor = (name: ThemeName) => {
    let rt = envs.get(name);
    if (!rt) envs.set(name, (rt = buildEnvironment(renderer, THEMES[name].env)));
    return rt.texture;
  };
  // The environment map is made at the next frame, so a theme picked right after creation costs one map, not two.
  let themeName: ThemeName = "light";
  let envDirty = true;
  const setTheme = (name: ThemeName) => {
    themeName = name;
    const t = THEMES[name];
    set.apply(t);
    key.color.set(t.keyColor);
    key.intensity = t.keyIntensity;
    scene.environmentIntensity = t.envIntensity;
    renderer.toneMappingExposure = t.exposure;
    envDirty = true;
  };
  setTheme("light");
  // A lost context (phones in the background, GPU resets) takes rendered textures with it; the environment maps
  // are rendered, so make them again. Everything else three re-uploads by itself or is redrawn every frame.
  const onRestored = () => {
    envs.clear(); // their GL objects died with the old context; disposing them would touch dead handles
    envDirty = true;
  };
  canvas.addEventListener("webglcontextrestored", onRestored);

  // Size: the container decides; the pixel ratio is capped. Resizing the drawing buffer clears it, so only on change.
  const coarse = matchMedia("(pointer: coarse)");
  let rect = canvas.getBoundingClientRect();
  const measure = () => (rect = canvas.getBoundingClientRect());
  const resize = () => {
    const w = Math.max(1, container.clientWidth);
    const h = Math.max(1, container.clientHeight);
    const dpr = Math.min(window.devicePixelRatio || 1, coarse.matches ? DPR_CAP_TOUCH : DPR_CAP_DESKTOP);
    const size = renderer.getSize(new THREE.Vector2());
    if (dpr !== renderer.getPixelRatio()) renderer.setPixelRatio(dpr);
    if (size.x !== w || size.y !== h) renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    measure();
  };
  resize();
  const observer = new ResizeObserver(resize);
  observer.observe(container);
  // The window's resize also catches pixel ratio changes (browser zoom, another screen); scrolling moves the rect.
  window.addEventListener("resize", resize);
  window.addEventListener("scroll", measure, { passive: true });

  // UI insets: the frog is centred in the free part of the canvas (a shifted projection centre) and fitted to it.
  const insets = { top: 0, right: 0, bottom: 0, left: 0 };
  const shift = { x: 0, y: 0, w: 1, h: 1 };
  const applyInsets = (k: number) => {
    const w = Math.max(1, rect.width);
    const h = Math.max(1, rect.height);
    // Never frame into less than 40% of the canvas: a panel covering almost everything should not shrink the frog away.
    const fw = Math.max(0.4, (w - insets.left - insets.right) / w);
    const fh = Math.max(0.4, (h - insets.top - insets.bottom) / h);
    const cx = ((insets.left - insets.right) / 2) / w;
    const cy = ((insets.top - insets.bottom) / 2) / h;
    shift.x += (cx - shift.x) * k;
    shift.y += (cy - shift.y) * k;
    shift.w += (fw - shift.w) * k;
    shift.h += (fh - shift.h) * k;
    rig.freeW = shift.w;
    rig.freeH = shift.h;
    const ox = Math.round(-shift.x * w * 10) / 10;
    const oy = Math.round(-shift.y * h * 10) / 10;
    const v = camera.view;
    if (ox === 0 && oy === 0) {
      if (v?.enabled) camera.clearViewOffset();
    } else if (!v?.enabled || v.offsetX !== ox || v.offsetY !== oy || v.fullWidth !== w || v.fullHeight !== h) {
      camera.setViewOffset(w, h, ox, oy, w, h);
    }
  };

  // Gestures.
  const raycaster = new THREE.Raycaster();
  const orbitPerPx = () => 2.8 / Math.max(1, Math.min(rect.width, rect.height));
  let orbitMark: [number, number] = rig.mark();
  const rec = new GestureRecognizer({
    info(x, y, t, pointerType): PointerInfo {
      const ndc = new THREE.Vector2(((x - rect.left) / rect.width) * 2 - 1, -((y - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(ndc, camera);
      return { ray: raycaster.ray.clone(), ndc, clientX: x, clientY: y, time: t, pointerType };
    },
    orbitStart: () => (orbitMark = rig.mark()),
    orbit: (dx, dy) => rig.orbitBy(-dx * orbitPerPx(), dy * orbitPerPx()),
    orbitCancel: () => rig.restore(orbitMark),
    fling: (vx, vy) => rig.fling(-vx * orbitPerPx(), vy * orbitPerPx()),
    zoom: (f) => rig.zoomBy(f),
  });
  const unbind = bindPointerEvents(canvas, rec);

  const fx: Fx = {
    popText: (at, text, opts) => pops.pop(at, text, camera, opts),
    burst: (at, kind, count) => particles.burst(at, kind, camera, count),
    shake: (amount) => rig.shake(amount),
  };

  const info: StageInfo = { cpuMs: 0, drawCalls: 0, triangles: 0, pixelRatio: renderer.getPixelRatio() };
  const focus = new THREE.Vector3(0, 0.5, 0);
  const keyOffset = new THREE.Vector3();
  const lightX = new THREE.Vector3();
  const lightY = new THREE.Vector3();
  const shadowAt = new THREE.Vector3();
  const texel = (2 * SHADOW_HALF) / key.shadow.mapSize.x;
  const yAxis = new THREE.Vector3(0, 1, 0);
  let started = false;

  return {
    canvas,
    renderer,
    scene,
    camera,
    fx,
    info,
    setGestureHandler(h) {
      rec.handler = h;
    },
    setFocus(target) {
      focus.copy(target);
      rig.setFocus(target);
    },
    setBalls: (b) => balls.set(b),
    setTheme,
    resetView: () => rig.reset(),
    setView: (v) => rig.setView(v),
    setInsets: (i) => Object.assign(insets, i),
    frame(dt) {
      const t0 = performance.now();
      dt = Math.min(Math.max(dt, 0), 0.1);
      applyInsets(started ? 1 - Math.exp(-8 * dt) : 1);
      if (!started) {
        rig.snap();
        started = true;
      }
      rig.update(dt);
      if (envDirty) {
        scene.environment = envFor(themeName);
        envDirty = false;
      }

      // Light and environment turn with the camera's heading (see KEY_OFFSET).
      keyOffset.copy(KEY_OFFSET).applyAxisAngle(yAxis, rig.yaw);
      // The shadow map follows the frog in whole texels across the light, so shadow edges do not crawl as it moves.
      lightX.crossVectors(yAxis, keyOffset).normalize();
      lightY.crossVectors(keyOffset, lightX).normalize();
      const u = rig.target.dot(lightX);
      const v = rig.target.dot(lightY);
      shadowAt
        .copy(rig.target)
        .addScaledVector(lightX, Math.round(u / texel) * texel - u)
        .addScaledVector(lightY, Math.round(v / texel) * texel - v);
      key.position.copy(shadowAt).add(keyOffset);
      key.target.position.copy(shadowAt);
      key.target.updateMatrixWorld();
      scene.environmentRotation.y = rig.yaw;

      set.update(camera, rig.target);
      pops.update(dt);
      particles.update(dt, camera);

      renderer.info.reset();
      contact.render(renderer, scene, notInContact, focus);
      set.setContact(contact.texture, contact.center.x, contact.center.y, contact.size);
      renderer.shadowMap.needsUpdate = true;
      renderer.render(scene, camera);

      info.drawCalls = renderer.info.render.calls;
      info.triangles = renderer.info.render.triangles;
      info.pixelRatio = renderer.getPixelRatio();
      info.cpuMs = performance.now() - t0;
    },
    dispose() {
      unbind();
      canvas.removeEventListener("webglcontextrestored", onRestored);
      observer.disconnect();
      window.removeEventListener("resize", resize);
      window.removeEventListener("scroll", measure);
      set.dispose();
      contact.dispose();
      balls.dispose();
      particles.dispose();
      pops.dispose();
      for (const rt of envs.values()) rt.dispose();
      key.shadow.dispose();
      renderer.dispose();
      canvas.remove();
    },
  };
}
