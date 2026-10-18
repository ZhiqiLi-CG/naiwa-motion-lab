#!/usr/bin/env node
/**
 * One-click run: `npm start` (start.cmd / start.sh).
 *
 *   node scripts/start.mjs [--no-lab] [--no-open] [--port N] [--host [addr]] [--prod]
 *
 * Installs the dependencies when they are missing or out of date, starts Vite (dev server, port 5180, or the next free
 * one; --prod builds and serves the production build with `vite preview`, port 5181) with the COOP/COEP headers from
 * vite.config.ts, starts the local Lab server (lab/server.mjs) when Codex CLI is installed and logged in, waits until
 * the page answers, opens the default browser and stops everything (whole process trees) on Ctrl+C.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { codexStatus, depsProblems, REPO, which } from "./doctor.mjs";

const WIN = process.platform === "win32";
const HELP = `用法 / usage: npm start -- [options]    (start.cmd / ./start.sh [options])

  --no-lab       不启动本机 Lab 服务 / don't start the local Lab server (Codex)
  --no-open      不打开浏览器 / don't open the browser
  --port N       页面端口 / page port (默认 / default 5180, --prod 5181; 被占用就往后找 / next free if busy)
  --host [addr]  让局域网里的其他设备也能访问 / reachable from other devices on the LAN (default 0.0.0.0)
  --prod         构建并运行生产版本 / build and serve the production build (= npm run start:prod)
`;

// ---------- options ----------
function parseArgs(argv) {
  const o = { lab: true, open: true, port: null, host: null, prod: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--no-lab") o.lab = false;
    else if (a === "--no-open") o.open = false;
    else if (a === "--prod") o.prod = true;
    else if (a === "--port" || a.startsWith("--port=")) {
      const v = a.includes("=") ? a.split("=")[1] : argv[++i];
      o.port = Number(v);
      if (!Number.isInteger(o.port) || o.port < 1 || o.port > 65535) fail(`--port: 不是有效端口 / not a valid port: ${v}`);
    } else if (a === "--host" || a.startsWith("--host=")) {
      if (a.includes("=")) o.host = a.split("=")[1];
      else o.host = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "0.0.0.0";
    } else if (a === "-h" || a === "--help") {
      console.log(HELP);
      process.exit(0);
    } else fail(`未知选项 / unknown option: ${a}\n\n${HELP}`);
  }
  return o;
}

function fail(msg) {
  console.error(`\n[naiwa] 错误 / error: ${msg}`);
  process.exit(1);
}
const log = (msg) => console.log(`[naiwa] ${msg}`);

// ---------- processes ----------
const children = new Set();
let stopping = false;

/** Spawn a long-running child; on Linux it gets its own process group so the whole tree can be stopped. */
function run(cmd, args, opts = {}) {
  const child = spawn(cmd, args, { cwd: REPO, stdio: "inherit", windowsHide: true, detached: !WIN, ...opts });
  children.add(child);
  child.on("exit", () => children.delete(child));
  return child;
}

function killTree(child) {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
  if (WIN) spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  else {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  }
}

async function stopAll(code = 0) {
  if (stopping) return;
  stopping = true;
  if (children.size) log("正在停止 / stopping…");
  for (const c of children) killTree(c);
  const deadline = Date.now() + 4000;
  while (children.size && Date.now() < deadline) await sleep(100);
  for (const c of children) {
    try {
      if (WIN) killTree(c);
      else process.kill(-c.pid, "SIGKILL");
    } catch {}
  }
  log("已停止 / stopped.");
  process.exit(code);
}

for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"]) {
  try {
    process.on(sig, () => stopAll(0));
  } catch {}
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Run a command to completion (inheriting the terminal); resolves its exit code. */
function runToEnd(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = run(cmd, args, { detached: false, ...opts });
    child.on("error", (e) => {
      console.error(String(e));
      resolve(-1);
    });
    child.on("exit", (code) => resolve(code ?? -1));
  });
}

/** npm, run through this same Node (npm_execpath under `npm start`, else the npm next to node). */
function npm(args) {
  const cli = [process.env.npm_execpath, path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"), path.join(path.dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js")].find(
    (p) => p && /\.c?js$/.test(p) && existsSync(p),
  );
  if (cli) return runToEnd(process.execPath, [cli, ...args]);
  if (WIN) return runToEnd("npm.cmd", args, { shell: true });
  return runToEnd(which("npm") ?? "npm", args);
}

// ---------- network ----------
/** Is the port free on this host (nothing answers, and we could bind it)? */
async function portFree(port, host) {
  const answers = await new Promise((resolve) => {
    const s = net.connect({ port, host: "127.0.0.1" });
    s.setTimeout(500);
    s.once("connect", () => (s.destroy(), resolve(true)));
    s.once("timeout", () => (s.destroy(), resolve(false)));
    s.once("error", () => resolve(false));
  });
  if (answers) return false;
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.listen({ port, host, exclusive: true }, () => srv.close(() => resolve(true)));
  });
}

async function freePort(start, host) {
  for (let p = start; p < start + 50 && p <= 65535; p++) if (await portFree(p, host)) return p;
  fail(`从 ${start} 起找不到空闲端口 / no free port from ${start}`);
}

function get(url, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(null));
  });
}

/** Is a Naiwa Lab server already answering on this port? */
async function labAt(port) {
  const r = await get(`http://127.0.0.1:${port}/api/status`, 1500);
  if (!r || r.status !== 200) return false;
  try {
    return typeof JSON.parse(r.body).codex === "object";
  } catch {
    return false;
  }
}

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) for (const a of list ?? []) if (a.family === "IPv4" && !a.internal) out.push(a.address);
  return out;
}

function isWsl() {
  if (process.platform !== "linux") return false;
  if (process.env.WSL_DISTRO_NAME) return true;
  try {
    return /microsoft/i.test(readFileSync("/proc/version", "utf8"));
  } catch {
    return false;
  }
}

function openBrowser(url) {
  try {
    if (WIN) spawn("cmd.exe", ["/d", "/s", "/c", `start "" "${url}"`], { windowsVerbatimArguments: true, windowsHide: true, stdio: "ignore", detached: true }).unref();
    else if (process.platform === "darwin") spawn("open", [url], { stdio: "ignore", detached: true }).unref();
    else {
      const hasDisplay = process.env.DISPLAY || process.env.WAYLAND_DISPLAY;
      const opener = isWsl() ? which("wslview") : hasDisplay ? which("xdg-open") : null;
      if (!opener) return false;
      spawn(opener, [url], { stdio: "ignore", detached: true }).unref();
    }
    return true;
  } catch {
    return false;
  }
}

// ---------- main ----------
const opts = parseArgs(process.argv.slice(2));

const [maj, min] = process.versions.node.split(".").map(Number);
if (maj < 18 || (maj === 18 && min < 19)) fail(`需要 Node.js 18.19 或更新，当前 ${process.versions.node} / Node.js >= 18.19 needed, this is ${process.versions.node}. 运行安装脚本 / run install.cmd or ./install.sh`);

const problems = depsProblems();
if (problems.length) {
  log(`依赖未装好，先安装 / dependencies missing or out of date, installing first (${problems[0]}${problems.length > 1 ? ", …" : ""})`);
  const lock = existsSync(path.join(REPO, "package-lock.json"));
  const code = await npm(lock ? ["ci", "--no-audit", "--no-fund"] : ["install", "--no-audit", "--no-fund"]);
  if (code !== 0) fail(`npm ${lock ? "ci" : "install"} 失败 (exit ${code}) / failed. 检查网络后重试 / check the network and retry.`);
  if (depsProblems().length) fail(`安装后依赖仍不完整 / dependencies still incomplete: ${depsProblems().join("; ")}`);
}

const vite = path.join(REPO, "node_modules", "vite", "bin", "vite.js");
if (opts.prod) {
  log("构建生产版本 / building the production build (npm run build)…");
  const code = await npm(["run", "build"]);
  if (code !== 0) fail(`构建失败 / build failed (exit ${code})`);
}

const bindHost = opts.host ?? "127.0.0.1";
const port = await freePort(opts.port ?? (opts.prod ? 5181 : 5180), bindHost);
if (opts.port && port !== opts.port) log(`端口 ${opts.port} 被占用，改用 ${port} / port ${opts.port} is busy, using ${port}`);

// The local Lab (Codex).
let labPort = null;
if (opts.lab) {
  const c = await codexStatus();
  if (c.installed && c.loggedIn) {
    if (await labAt(5170)) {
      labPort = 5170;
      log("本机 Lab 服务已在运行 / the local Lab server is already running on 127.0.0.1:5170, reusing it");
    } else {
      labPort = await freePort(5170, "127.0.0.1");
      log(`Codex CLI ${c.version} 已登录，启动本机 Lab / logged in, starting the local Lab server on 127.0.0.1:${labPort}`);
      const lab = run(process.execPath, [path.join(REPO, "lab", "server.mjs"), "--port", String(labPort)]);
      lab.on("exit", (code) => {
        if (!stopping) log(`本机 Lab 服务已退出 (exit ${code}) / the local Lab server exited; 页面照常可用 / the page keeps working without it`);
      });
    }
  } else if (c.installed) log(`Codex CLI ${c.version} 未登录：本机 Lab 入口保持隐藏 / not logged in: the local Lab entry points stay hidden (codex login, then restart)`);
  else log("未找到 Codex CLI：本机 Lab 入口保持隐藏 / Codex CLI not found: the local Lab entry points stay hidden (optional)");
} else log("--no-lab：不启动本机 Lab / not starting the local Lab");

const viteArgs = [vite, ...(opts.prod ? ["preview"] : []), "--port", String(port), "--strictPort", ...(opts.host ? ["--host", opts.host] : [])];
log(`启动 / starting ${opts.prod ? "vite preview (production build)" : "vite (dev server)"} on port ${port}…`);
const server = run(process.execPath, viteArgs);
server.on("exit", async (code) => {
  if (stopping) return;
  await sleep(500); // Ctrl+C reaches Vite too (Windows consoles): let our own handler win
  if (!stopping) {
    log(`Vite 已退出 (exit ${code}) / Vite exited`);
    stopAll(code === 0 ? 0 : 1);
  }
});

// Wait until the page answers.
const local = `http://localhost:${port}/`;
const deadline = Date.now() + 120000;
let ok = false;
while (!stopping && Date.now() < deadline) {
  const r = await get(`http://127.0.0.1:${port}/`);
  if (r && r.status === 200) {
    ok = true;
    break;
  }
  await sleep(300);
}
if (stopping) await new Promise(() => {});
if (!ok) {
  log("页面 120 秒内没有响应 / the page didn't answer within 120 s");
  await stopAll(1);
}

const pageUrl = labPort && labPort !== 5170 ? `${local}?lab=${labPort}` : local;
console.log("");
log("==================================================================");
log(`  打开 / open:  ${pageUrl}`);
if (opts.host) {
  for (const ip of lanAddresses()) log(`  局域网 / LAN: http://${ip}:${port}/`);
  log("  (局域网里摄像头等需要 HTTPS，可能不可用；本机 Lab 只在本机可用 / over plain http on the LAN the camera may be unavailable; the local Lab works on this machine only)");
}
log(`  本机 Lab / local Lab: ${labPort ? `http://127.0.0.1:${labPort}/` : "未启动 / not running"}`);
log("  按 Ctrl+C 停止 / press Ctrl+C to stop");
log("==================================================================");
if (opts.open && !process.env.NAIWA_NO_OPEN) {
  if (!openBrowser(pageUrl)) log(`没有可用的图形界面，请在浏览器里打开上面的地址 / no display to open a browser here: open the address above${isWsl() ? " in Windows" : ""}`);
}
