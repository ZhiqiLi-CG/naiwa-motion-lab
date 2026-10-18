#!/usr/bin/env node
/**
 * Environment checks shared by the installers and `npm start`. Built-ins only: it runs before `npm ci`.
 *
 *   node scripts/doctor.mjs deps      exit 0 when node_modules matches package-lock.json, else 1 (prints what is off)
 *   node scripts/doctor.mjs summary   what is ready, what is optional and missing, how to start
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WIN = process.platform === "win32";

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

/** Problems with the installed dependencies ([] = ready): every direct dependency installed at the locked version. */
export function depsProblems(repo = REPO) {
  const pkg = readJson(path.join(repo, "package.json"));
  const lockPath = path.join(repo, "package-lock.json");
  const lock = existsSync(lockPath) ? readJson(lockPath) : null;
  const names = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
  const problems = [];
  for (const name of names) {
    const p = path.join(repo, "node_modules", name, "package.json");
    if (!existsSync(p)) {
      problems.push(`${name}: not installed`);
      continue;
    }
    const want = lock?.packages?.[`node_modules/${name}`]?.version;
    const have = readJson(p).version;
    if (want && have !== want) problems.push(`${name}: ${have} installed, ${want} locked`);
  }
  return problems;
}

/** The first executable called `name` on PATH (Windows: with PATHEXT), or null. Windows paths inside WSL don't count. */
export function which(name, env = process.env) {
  const dirs = (env.PATH ?? env.Path ?? "").split(path.delimiter).filter(Boolean);
  const exts = WIN ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean) : [""];
  for (const dir of dirs) {
    if (!WIN && dir.startsWith("/mnt/")) continue;
    for (const ext of exts) {
      const p = path.join(dir.replace(/^"|"$/g, ""), name + ext.toLowerCase());
      if (existsSync(p)) return p;
    }
  }
  return null;
}

/** Codex CLI: { installed, version, loggedIn, how } via the Lab server's own probe. */
export async function codexStatus() {
  try {
    const { createStatus } = await import(pathToFileURL(path.join(REPO, "lab", "lib", "codex.mjs")).href);
    return await createStatus().get();
  } catch (e) {
    return { installed: false, loggedIn: false, error: String(e) };
  }
}

async function chrome() {
  try {
    const { chromePath } = await import(pathToFileURL(path.join(REPO, "tests", "tools", "chrome.mjs")).href);
    return chromePath();
  } catch {
    return null;
  }
}

/** ffmpeg the way the e2e tests look for it (PATH, FFMPEG, winget's folders). */
async function ffmpeg() {
  try {
    const { ff } = await import(pathToFileURL(path.join(REPO, "tests", "e2e", "lib", "media.mjs")).href);
    return ff().ffmpeg;
  } catch {
    return which("ffmpeg");
  }
}

async function summary() {
  const ok = (s) => console.log(`  [ok]   ${s}`);
  const opt = (s) => console.log(`  [--]   ${s}`);
  const bad = (s) => console.log(`  [!!]   ${s}`);
  console.log("\n==== Naiwa Motion Lab: 环境检查 / environment ====");
  ok(`Node.js ${process.versions.node} (${process.execPath})`);
  const problems = depsProblems();
  if (problems.length) bad(`依赖未装好 / dependencies not ready: ${problems.slice(0, 3).join("; ")}`);
  else ok("依赖已安装 / dependencies installed (node_modules)");

  console.log("\n  可选 / optional:");
  const c = await codexStatus();
  if (c.installed && c.loggedIn) ok(`Codex CLI ${c.version}, 已登录 / logged in (${c.how}) -> 本机 Lab 可用 / local Lab available`);
  else if (c.installed) opt(`Codex CLI ${c.version} 未登录 / not logged in -> 运行 / run: codex login  (本机 Lab 需要 / needed for the local Lab)`);
  else opt("未找到 Codex CLI / Codex CLI not found -> 本机 Lab 入口会隐藏 / the local Lab stays hidden (npm i -g @openai/codex; codex login)");
  const ch = await chrome();
  if (ch) ok(`Chrome: ${ch} (开发者测试用 / for developer tests)`);
  else opt("未找到 Chrome / Chrome not found (只有开发者测试需要 / only for developer tests: e2e, shot tool)");
  const ff = await ffmpeg();
  if (ff) ok(`ffmpeg: ${ff} (开发者测试用 / for developer tests)`);
  else opt("未找到 ffmpeg / ffmpeg not found (只有开发者测试需要 / only for developer tests)");

  console.log("\n  启动 / start:");
  if (WIN) console.log("    双击 start.cmd，或 / double-click start.cmd, or:  npm start");
  else console.log("    ./start.sh   或 / or   npm start");
  console.log("    选项 / options: --no-lab  --no-open  --port N  --host   (生产构建 / production build: npm run start:prod)\n");
  return problems.length ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cmd = process.argv[2];
  if (cmd === "deps") {
    const p = depsProblems();
    for (const s of p) console.log(s);
    process.exit(p.length ? 1 : 0);
  } else if (cmd === "summary") process.exit(await summary());
  else {
    console.error("usage: node scripts/doctor.mjs deps|summary");
    process.exit(2);
  }
}
