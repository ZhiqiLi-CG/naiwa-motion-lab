// End-to-end checks of Naiwa Motion Lab: build, serve the build like the static hosts do, and use it in headless
// Chrome (GPU WebGL, a fake webcam playing a real dance video, real dance clips uploaded) the way a visitor would.
// Screenshots, recordings and report.md go to tests/e2e/out/. Exits non-zero when a check fails, or while a part of
// the app is still missing.
//
//   npm run e2e [-- options]
//     --head              build the last commit (an export in .cache/e2e/head) instead of the working tree, so
//                         other builders' unfinished edits do not get in the way
//     --skip-build        reuse the last build in .cache/e2e/dist
//     --url <url>         test a running server instead (e.g. the dev server); no build checks
//     --only <a,b>        run only these scenarios (names below)
//     --quick             skip the 65 s camera soak that catches MediaPipe's periodic usage logging
//     --allow-missing     exit 0 when nothing fails even if parts of the app are not there yet
//
// Scenarios: play, modes, dances, camera, video-portrait, video-landscape, playback, simulators, record, phone, lang,
// lang-phone.
//
// The app exposes window.__naiwa = { store, sim, character, stage, motion, commands } (src/main.ts). Everything also
// works without it from the DOM, the pixels and the browser APIs, but with it the checks are exact (the frog's pixels
// and centre, simulation events, effects, physics time, motion state, the pose).
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, readdirSync, existsSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";
import { chromePath, gpuArgs } from "../tools/chrome.mjs";
import { checkBuild, mb, isGoogleHost, MEDIAPIPE_TELEMETRY } from "./lib/deploy.mjs";
import { serve } from "./lib/server.mjs";
import { ensureY4m } from "./lib/media.mjs";
import { personPose } from "./lib/follow.mjs";
import { openPage, shot } from "./lib/app.mjs";
import * as S from "./scenarios.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const OUT = join(ROOT, "tests/e2e/out");
const CACHE = join(ROOT, ".cache/e2e");
const DIST = join(CACHE, "dist");
const MEDIA = join(ROOT, "tests/e2e/media");
const PORT = 5197;
const DESKTOP = { width: 1280, height: 800, deviceScaleFactor: 1 };
const PHONE = { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const PHONE_UA = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Mobile Safari/537.36";

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n) => (argv.indexOf(`--${n}`) >= 0 ? argv[argv.indexOf(`--${n}`) + 1] : null);
const only = opt("only")?.split(",");
const started = Date.now();

const results = [];
function check(group, name, status, detail = "") {
  results.push({ group, name, status, detail });
  const tag = { PASS: "\x1b[32mPASS\x1b[0m", FAIL: "\x1b[31mFAIL\x1b[0m", MISSING: "\x1b[33mMISS\x1b[0m", WARN: "\x1b[33mWARN\x1b[0m", INFO: "\x1b[36mINFO\x1b[0m" }[status];
  console.log(`${tag}  ${group}: ${name}${detail ? ` — ${detail}` : ""}`);
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
mkdirSync(CACHE, { recursive: true });

/* ---------------------------------------------------------------- build ---------------------------------------- */
let appBase = opt("url");
let server = null;
let SRC = ROOT;
if (!appBase) {
  if (flag("head") && !flag("skip-build")) {
    SRC = join(CACHE, "head");
    rmSync(SRC, { recursive: true, force: true });
    mkdirSync(SRC, { recursive: true });
    const exp = spawnSync("sh", ["-c", `git -C "${ROOT}" archive HEAD | tar -x -C "${SRC}"`], { encoding: "utf8" });
    if (exp.status !== 0) check("build", "export HEAD", "FAIL", exp.stderr.slice(0, 300));
    symlinkSync(join(ROOT, "node_modules"), join(SRC, "node_modules"));
    const rev = spawnSync("git", ["log", "-1", "--format=%h %s"], { cwd: ROOT, encoding: "utf8" }).stdout.trim();
    check("build", "source", "INFO", `last commit ${rev} (not the working tree)`);
  }
  if (!flag("skip-build")) {
    const tsc = spawnSync("npx", ["tsc", "--noEmit", "--pretty", "false"], { cwd: SRC, encoding: "utf8" });
    if (tsc.status === 0) check("build", "typecheck (tsc --noEmit)", "PASS");
    else {
      const byModule = {};
      for (const l of (tsc.stdout + tsc.stderr).split("\n").filter((x) => /error TS/.test(x))) (byModule[l.split(/[/(]/).slice(0, 2).join("/")] ??= []).push(l);
      check("build", "typecheck (tsc --noEmit)", "FAIL", Object.entries(byModule).map(([m, ls]) => `${m}: ${ls.length} error(s), first: ${ls[0]}`).join(" | ") || tsc.stdout.slice(0, 400));
    }
    const vite = spawnSync("npx", ["vite", "build", "--outDir", DIST, "--emptyOutDir"], { cwd: SRC, encoding: "utf8" });
    if (vite.status !== 0) {
      const lines = (vite.stdout + vite.stderr).split("\n").filter((l) => l.trim() && !/^\s+at /.test(l));
      const i = lines.findIndex((l) => /error during build/.test(l));
      check("build", "vite build", "FAIL", (i >= 0 ? lines.slice(i + 1, i + 4) : lines.slice(-4)).join(" | "));
      finish();
    }
    check("build", "vite build", "PASS", `into ${DIST.replace(ROOT, "")}`);
  }
  if (!existsSync(join(DIST, "index.html"))) {
    check("build", "build present", "FAIL", `no ${DIST}/index.html (run without --skip-build)`);
    finish();
  }
  for (const r of checkBuild(SRC, DIST).results) check("build", r.name.replace(/^(build|deploy): /, ""), r.status, r.detail);
}
// The build (or nothing, with --url) plus the harness' own pages: the pose oracle and the test clips.
server = await serve(existsSync(join(DIST, "index.html")) ? DIST : join(CACHE, "none"), PORT, {
  "/__e2e/": join(ROOT, "tests/e2e/lib"),
  "/__e2e/media/": MEDIA,
  "/__e2e/mediapipe/": join(ROOT, "public/mediapipe"),
  "/__e2e/vision_bundle.mjs": join(ROOT, "node_modules/@mediapipe/tasks-vision/vision_bundle.mjs"),
});
appBase ??= server.url;
const appUrl = appBase + (appBase.includes("?") ? "&" : "?") + "e2e";

/* ---------------------------------------------------------------- browser -------------------------------------- */
const camClip = join(MEDIA, "dance-naenae.mp4");
const y4m = ensureY4m(camClip, join(CACHE, "dance-naenae.y4m"));
const browser = await puppeteer.launch({
  executablePath: chromePath(),
  headless: "new",
  args: [
    "--no-sandbox",
    ...gpuArgs(),
    "--autoplay-policy=no-user-gesture-required",
    "--mute-audio",
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    `--use-file-for-fake-video-capture=${y4m}`,
    // Like a visitor in China: nothing but the site (this machine, or the --url host) is reachable; any other
    // request shows up as an error.
    `--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1${opt("url") ? `, EXCLUDE ${new URL(opt("url")).hostname}` : ""}`,
  ],
});

/** The uploaded clips and the person's pose in them (the ground truth for "the frog follows"). */
const model = ["pose_landmarker_full.task", "pose_landmarker_lite.task"].find((m) => existsSync(join(ROOT, "public/mediapipe", m)));
const clips = {};
for (const [which, name] of [["portrait", "dance-naenae.mp4"], ["landscape", "dance-waacking.mp4"]]) {
  if (only && !only.includes(`video-${which}`)) continue;
  const file = join(MEDIA, name);
  const probe = JSON.parse(spawnSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,width,height:format=duration", "-of", "json", file], { encoding: "utf8" }).stdout);
  const v = probe.streams.find((s) => s.codec_type === "video");
  let pose = null;
  try {
    pose = model ? await personPose(browser, server.url, file, CACHE, model) : null;
  } catch (e) {
    check("media", `${name} pose reference`, "FAIL", e.message);
  }
  clips[which] = { name, file, pose, width: v.width, height: v.height, duration: parseFloat(probe.format.duration), audio: probe.streams.some((s) => s.codec_type === "audio") };
  if (pose) check("media", `${name} pose reference`, "INFO", `MediaPipe (${model}) finds the person in ${pose.frames.filter((f) => f.world).length}/${pose.frames.length} frames`);
}

const externalAll = [];
const T = { check, out: OUT, cache: CACHE, clips, flag, shared: {} };

/** One scenario in its own browser context (fresh cache and storage), with its console and network verdict. */
async function scenario(name, viewport, body, { timeoutMs = 150000, userAgent, lang } = {}) {
  if (only && !only.includes(name)) return;
  const ctx = await browser.createBrowserContext();
  let opened = null, timer;
  const t0 = Date.now();
  const served0 = server.served.length;
  try {
    opened = await openPage(ctx, appUrl, { viewport, userAgent, lang });
    await Promise.race([
      body(opened.page, opened.log).finally(() => clearTimeout(timer)),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs / 1000} s`)), timeoutMs); }),
    ]);
    if (!opt("url")) {
      const s = server.served.slice(served0).filter((r) => !r.path.startsWith("/__e2e/"));
      check(name, "transfer", "INFO", `${s.length} requests, ${mb(s.reduce((a, r) => a + r.size, 0))} with an empty cache` + (name === "play" ? " (what a first visit downloads)" : ""));
    }
  } catch (e) {
    check(name, "scenario ran", "FAIL", `${e.message.split("\n")[0]}${opened ? ` (step "${opened.log.step}")` : ""}`);
    if (opened) await shot(opened.page, OUT, `${name}-crash`).catch(() => {});
  } finally {
    clearTimeout(timer);
    if (opened) {
      const { log } = opened;
      const problems = [...new Set([...log.errors, ...log.failed, ...log.bad])];
      check(name, "no console errors or failed requests", problems.length ? "FAIL" : "PASS",
        problems.length ? problems.slice(0, 8).join(" | ") + (problems.length > 8 ? ` … (${problems.length})` : "") : `${log.requests.length} requests, ${Math.round((Date.now() - t0) / 1000)} s`);
      if (log.covered.length) check(name, "controls are not covered by other elements", "FAIL", [...new Set(log.covered)].slice(0, 6).join("; "));
      externalAll.push(...log.external.map((u) => `${name} ${u}`));
      writeFileSync(join(OUT, `${name}-console.txt`), [...log.console, "", "-- errors --", ...problems, "", "-- external --", ...log.external].join("\n"));
    }
    await ctx.close().catch(() => {});
  }
}

await scenario("play", DESKTOP, (p, l) => S.play(T, p, l));
await scenario("modes", DESKTOP, (p, l) => S.modes(T, p, l));
await scenario("dances", DESKTOP, (p, l) => S.dances(T, p, l));
await scenario("camera", DESKTOP, (p, l) => S.camera(T, p, l), { timeoutMs: 200000 });
for (const which of Object.keys(clips)) await scenario(`video-${which}`, DESKTOP, (p, l) => S.video(T, p, l, which), { timeoutMs: 240000 });
await scenario("playback", DESKTOP, (p, l) => S.playback(T, p, l));
await scenario("simulators", DESKTOP, (p, l) => S.simulators(T, p, l), { timeoutMs: 480000 });
await scenario("record", DESKTOP, (p, l) => S.record(T, p, l));
await scenario("phone", PHONE, (p, l) => S.phone(T, p, l), { userAgent: PHONE_UA });
await scenario("lang", DESKTOP, (p, l) => S.languages(T, p, l, "lang"));
await scenario("lang-phone", PHONE, (p, l) => S.languages(T, p, l, "lang-phone"), { userAgent: PHONE_UA, lang: "en-US" });

/* ---------------------------------------------------------------- network verdict + report --------------------- */
const google = externalAll.filter((u) => { try { return isGoogleHost(new URL(u.split(" ").pop()).hostname); } catch { return false; } });
check("network", "nothing loaded from outside the site", externalAll.length ? "FAIL" : "PASS",
  externalAll.length ? [...new Set(externalAll)].slice(0, 6).join(" | ") + (google.length ? ` — ${google.length} to Google` : "") +
    (externalAll.some((u) => u.includes(MEDIAPIPE_TELEMETRY)) ? ` (${MEDIAPIPE_TELEMETRY} is @mediapipe/tasks-vision's built-in usage logging: src/motion must keep it from being sent)` : "")
    : "no request left the site in any scenario");
await browser.close();
finish();

function finish() {
  server?.close();
  const counts = {};
  for (const r of results) counts[r.status] = (counts[r.status] ?? 0) + 1;
  const failed = results.filter((r) => r.status === "FAIL");
  const missing = results.filter((r) => r.status === "MISSING");
  const ok = !failed.length && (flag("allow-missing") || !missing.length);
  const rev = spawnSync("git", ["log", "-1", "--format=%h %s"], { cwd: ROOT, encoding: "utf8" }).stdout.trim();
  const files = existsSync(OUT) ? readdirSync(OUT).filter((f) => /\.(png|webm|mp4)$/.test(f)).sort() : [];
  const esc = (s) => String(s).replace(/\|/g, "\\|").replace(/\n/g, " ");
  const md = [
    "# Naiwa Motion Lab e2e report",
    "",
    `${new Date().toISOString()} · ${rev} · ${Math.round((Date.now() - started) / 1000)} s · ${ok ? "**passed**" : "**failed**"}${argv.length ? ` · \`${argv.join(" ")}\`` : ""}`,
    "",
    Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(" · "),
    "",
    "| | group | check | detail |",
    "|---|---|---|---|",
    ...results.map((r) => `| ${r.status} | ${r.group} | ${esc(r.name)} | ${esc(r.detail)} |`),
    "",
    "## Files",
    "",
    ...files.map((s) => `- ${s}`),
    "",
  ].join("\n");
  writeFileSync(join(OUT, "report.md"), md);
  writeFileSync(join(OUT, "report.json"), JSON.stringify({ ok, rev, args: argv, results }, null, 2));
  console.log(`\n${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(", ")} in ${Math.round((Date.now() - started) / 1000)} s; report: ${join(OUT, "report.md")}`);
  if (!ok) {
    console.log("\n\x1b[31mE2E FAILED\x1b[0m");
    for (const r of [...failed, ...(flag("allow-missing") ? [] : missing)]) console.log(`  ${r.status} ${r.group}: ${r.name} — ${r.detail}`);
  }
  process.exit(ok ? 0 : 1);
}
