// Driving the app in a page: open it with the watchers, wait until it is up, take pixel measures, find and press its
// controls, aim at the frog, read pose and motion.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decodePng, diffMask, maskCoverage, foregroundFraction, yellowBlob } from "./image.mjs";

const INSTRUMENT = readFileSync(new URL("./instrument.js", import.meta.url), "utf8");
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Mode labels from src/contracts.ts (Mode). */
export const MODES = { play: "捏捏奶蛙", camera: "跟着我跳", video: "视频模仿", dance: "舞蹈库" };
export const POSE_BONES = ["hips", "upperarm_L", "upperarm_R", "forearm_L", "forearm_R", "thigh_L", "thigh_R", "spine", "head"];

/** A fresh page with the watchers: console errors, page errors, failed or 4xx/5xx requests, anything off-origin. */
export async function openPage(browser, url, { viewport, userAgent, lang = "zh-CN" }) {
  const page = await browser.newPage();
  if (userAgent) await page.setUserAgent(userAgent);
  await page.setViewport(viewport);
  // The visitor's browser language (the app picks 中文 or English from it on a first visit).
  await page.evaluateOnNewDocument((l) => {
    Object.defineProperty(navigator, "language", { get: () => l });
    Object.defineProperty(navigator, "languages", { get: () => [l, l.split("-")[0]] });
  }, lang);
  await page.evaluateOnNewDocument(INSTRUMENT);
  const origin = new URL(url).origin;
  const log = { errors: [], failed: [], bad: [], external: [], requests: [], console: [], step: "load" };
  const at = (m) => `[${log.step}] ${m}`;
  page.on("console", (m) => {
    const where = m.location()?.url ? ` (${m.location().url.replace(origin, "")}${m.location().lineNumber != null ? `:${m.location().lineNumber + 1}` : ""})` : "";
    log.console.push(at(`console.${m.type()}: ${m.text()}`));
    if (m.type() === "error" || m.type() === "assert") log.errors.push(at(`console.${m.type()}: ${m.text()}${where}`));
  });
  page.on("pageerror", (e) => log.errors.push(at(`uncaught: ${e.message}`)));
  page.on("request", (r) => {
    const u = r.url();
    if (/^(data|blob):/.test(u)) return;
    if (!u.startsWith(origin)) log.external.push(at(`${r.method()} ${u}`));
    else log.requests.push(u.slice(origin.length));
  });
  page.on("requestfailed", (r) => {
    if (!r.url().startsWith(origin) || /^(data|blob):/.test(r.url())) return;
    // Media elements abort range requests as they seek; that is not a failure.
    if (r.failure()?.errorText === "net::ERR_ABORTED" && ["media", "other"].includes(r.resourceType())) return;
    log.failed.push(at(`${r.url().slice(origin.length)} ${r.failure()?.errorText}`));
  });
  page.on("response", (r) => {
    if (r.status() >= 400) log.bad.push(at(`${r.status()} ${r.url().replace(origin, "")}`));
  });
  await page.goto(url, { waitUntil: "load", timeout: 60000 });
  return { page, log };
}

/** Wait until the app says it is up (hook: loading done; the hook appears when boot finishes) or, without the hook,
 *  until a canvas has been there a while. */
export async function waitReady(page, timeoutMs = 40000) {
  const t0 = Date.now();
  let s = null;
  while (Date.now() - t0 < timeoutMs) {
    s = await page.evaluate(() => {
      const n = window.__naiwa;
      const c = window.__e2e.mainCanvas();
      return { hook: !!n, store: !!n?.store, loading: n?.store?.get().loading ?? null, canvas: !!c && c.width > 0, text: document.body.innerText.slice(0, 200) };
    });
    if (s.store ? s.loading && !s.loading.active : s.canvas && Date.now() - t0 > 12000) break;
    await sleep(250);
  }
  const hooks = await page.evaluate(() => window.__e2e.attachHooks());
  await sleep(800);
  return { ...s, hooks, ms: Date.now() - t0, timedOut: Date.now() - t0 >= timeoutMs };
}

/** Screenshot → saved PNG + decoded pixels (and the device pixel ratio to map CSS px). */
export async function shot(page, outDir, name) {
  const buf = await page.screenshot({ type: "png" });
  if (name) writeFileSync(join(outDir, `${name}.png`), buf);
  const img = decodePng(buf);
  img.dpr = img.width / page.viewport().width;
  return img;
}
export const toPx = (img, r) => r && { x: r.x * img.dpr, y: r.y * img.dpr, w: r.w * img.dpr, h: r.h * img.dpr };

export async function canvasRect(page) {
  return page.evaluate(() => window.__e2e.canvasRect());
}

/** Where the frog is: with the hook its projected centre and its exact pixels (screenshots with and without it);
 *  without, the canvas' warm-yellow blob or its centre. Also: how much of the canvas centre is frog / not background. */
export async function locateFrog(page, outDir, name) {
  const rect = await canvasRect(page);
  if (!rect) return null;
  const img = await shot(page, outDir, name);
  const crect = toPx(img, rect);
  const side = Math.min(crect.w, crect.h) * 0.1;
  const centre = { x: crect.x + crect.w / 2 - side / 2, y: crect.y + crect.h / 2 - side / 2, w: side, h: side };
  const point = await page.evaluate(() => window.__e2e.frogPoint());
  if (await page.evaluate(() => window.__e2e.setFrogVisible(false))) {
    const without = await shot(page, outDir, name ? `${name}-nofrog` : null);
    await page.evaluate(() => window.__e2e.setFrogVisible(true));
    const m = diffMask(img, without, crect);
    const bbox = m.bbox && { x: m.bbox.x / img.dpr, y: m.bbox.y / img.dpr, w: m.bbox.w / img.dpr, h: m.bbox.h / img.dpr };
    const target = point ?? (m.centroid && { x: m.centroid.x / img.dpr, y: m.centroid.y / img.dpr });
    return { how: point ? "hook: projected centre + frog mask" : "hook: frog mask", img, rect, target, bbox, centreCoverage: maskCoverage(img, m.mask, centre), areaFraction: m.count / (crect.w * crect.h), yellow: yellowBlob(img, toPx(img, bbox ?? rect)).fraction };
  }
  const fg = foregroundFraction(img, crect, centre);
  const y = yellowBlob(img, crect);
  const target = y.fraction > 0.01 && y.centroid
    ? { x: y.centroid.x / img.dpr, y: (y.top + 0.6 * (y.bottom - y.top)) / img.dpr }
    : { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
  return { how: y.fraction > 0.01 ? "no hook: yellow blob" : "no hook: canvas centre", img, rect, target, bbox: null, centreForeground: fg, yellow: y.fraction };
}

/** The region frame differences are measured in: the frog's box grown by half, or the middle of the canvas. */
export function frogRegion(frog) {
  if (frog.bbox) {
    const g = 0.5;
    return { x: frog.bbox.x - frog.bbox.w * g / 2, y: frog.bbox.y - frog.bbox.h * g / 2, w: frog.bbox.w * (1 + g), h: frog.bbox.h * (1 + g) };
  }
  const r = frog.rect;
  return { x: r.x + r.w * 0.2, y: r.y + r.h * 0.1, w: r.w * 0.6, h: r.h * 0.8 };
}

/** Find a control: mode button, or by label / pattern. Returns an ElementHandle or null. */
export async function findControl(page, spec) {
  const h = await page.evaluateHandle((s) => window.__e2e.findControl(s), spec);
  const el = h.asElement();
  if (!el) await h.dispose();
  return el;
}
export const findMode = (page, mode) => findControl(page, { mode, label: MODES[mode] });

export async function describe(el) {
  return el.evaluate((e) => window.__e2e.describe(e));
}
export async function selected(el) {
  return el.evaluate((e) => window.__e2e.selectedState(e));
}
export async function appState(page) {
  return page.evaluate(() => window.__e2e.state());
}

/** Press a mode control; a file chooser it opens gets `file` (video mode) or is cancelled. */
export async function enterMode(page, mode, file) {
  const el = await findMode(page, mode);
  if (!el) return { found: false };
  const chooserP = page.waitForFileChooser({ timeout: 2500 }).catch(() => null);
  await el.click();
  const chooser = await chooserP;
  if (chooser) {
    if (file) await chooser.accept([file]);
    else await chooser.cancel();
  }
  await sleep(800);
  const st = await appState(page);
  return { found: true, el, chooser: !!chooser, selected: await selected(el).catch(() => null), storeMode: st?.mode ?? null, info: await describe(el).catch(() => null) };
}

/** Give the video file to the app: a file input (preferring accept=video) or an upload control's file chooser. */
export async function uploadVideo(page, file) {
  const inputs = await page.$$("input[type=file]");
  let target = inputs.at(-1);
  for (const i of inputs) if (await i.evaluate((e) => /video/.test(e.accept))) target = i;
  if (target) {
    await target.uploadFile(file);
    return "file input";
  }
  const el = await findControl(page, { re: "上传|选择视频|选视频|换视频|打开视频|导入" });
  if (!el) return null;
  const chooserP = page.waitForFileChooser({ timeout: 2500 }).catch(() => null);
  await el.click();
  const chooser = await chooserP;
  if (!chooser) return null;
  await chooser.accept([file]);
  return `chooser from "${(await describe(el)).text}"`;
}

/** Largest rotation (degrees) any of the bones went through between samples. */
export function poseRange(samples) {
  let best = 0, which = null;
  const rot = (e) => {
    const c = [0, 4, 8].map((o) => { const v = [e[o], e[o + 1], e[o + 2]]; const l = Math.hypot(...v) || 1; return v.map((x) => x / l); });
    return c;
  };
  const angle = (a, b) => {
    const A = rot(a), B = rot(b);
    let tr = 0;
    for (let i = 0; i < 3; i++) tr += A[i][0] * B[i][0] + A[i][1] * B[i][1] + A[i][2] * B[i][2];
    return (Math.acos(Math.max(-1, Math.min(1, (tr - 1) / 2))) * 180) / Math.PI;
  };
  const valid = samples.filter(Boolean);
  for (const name of Object.keys(valid[0] ?? {})) {
    for (let i = 0; i < valid.length; i++) for (let j = i + 1; j < valid.length; j++) {
      if (!valid[i][name] || !valid[j][name]) continue;
      const d = angle(valid[i][name], valid[j][name]);
      if (d > best) { best = d; which = name; }
    }
  }
  return { degrees: best, bone: which };
}

export async function sampleBones(page) {
  return page.evaluate((names) => window.__e2e.boneSample(names), POSE_BONES);
}

/** Frame rate and per-frame main-thread work over a quiet window (no screenshots meanwhile). */
export async function measureFrames(page, ms = 3000) {
  const t0 = await page.evaluate(() => performance.now());
  await sleep(ms);
  const t1 = await page.evaluate(() => performance.now());
  return page.evaluate((a, b) => window.__e2e.frameStats(a, b), t0, t1);
}

export async function counts(page) {
  return page.evaluate(() => ({ sounds: window.__e2e.sounds.length, events: window.__e2e.events.map((e) => e.kind), fx: window.__e2e.fx.map((f) => f.arg ? `${f.k}:${f.arg}` : f.k) }));
}
/** What happened since `before` (from counts()). */
export function since(before, after) {
  return { sounds: after.sounds - before.sounds, events: after.events.slice(before.events.length), fx: after.fx.slice(before.fx.length) };
}

/** Mouse press-drag-release, fast enough at the end to be a throw. */
export async function mouseThrow(page, from, to, ms = 160, steps = 10) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await sleep(80);
  for (let i = 1; i <= steps; i++) {
    const k = i / steps;
    await page.mouse.move(from.x + (to.x - from.x) * k, from.y + (to.y - from.y) * k);
    await sleep(ms / steps);
  }
  await page.mouse.up();
}
export async function touchThrow(page, from, to, ms = 160, steps = 10) {
  const t = await page.touchscreen.touchStart(from.x, from.y);
  await sleep(80);
  for (let i = 1; i <= steps; i++) {
    const k = i / steps;
    await t.move(from.x + (to.x - from.x) * k, from.y + (to.y - from.y) * k);
    await sleep(ms / steps);
  }
  await t.end();
}
