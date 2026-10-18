// Where Chrome is and how to give headless Chrome a real GPU, on Linux, Windows and macOS. CHROME=<path> overrides.
import { existsSync } from "node:fs";

const CANDIDATES = {
  linux: ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"],
  win32: [
    `${process.env.PROGRAMFILES}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env["PROGRAMFILES(X86)"]}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env["PROGRAMFILES(X86)"]}\\Microsoft\\Edge\\Application\\msedge.exe`,
  ],
  darwin: ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"],
};

export function chromePath() {
  const found = process.env.CHROME || process.env.CHROME_BIN || (CANDIDATES[process.platform] ?? []).find((p) => existsSync(p));
  if (!found) throw new Error("No Chrome found: set CHROME=<path to chrome>");
  return found;
}

// ANGLE's backend for WebGL: Vulkan on Linux (as the project was built), Direct3D 11 on Windows, Metal on macOS.
const ANGLE = { linux: ["--use-angle=vulkan", "--enable-features=Vulkan"], win32: ["--use-angle=d3d11"], darwin: ["--use-angle=metal"] };

export function gpuArgs() {
  return ["--enable-gpu", "--ignore-gpu-blocklist", "--enable-unsafe-webgpu", ...(ANGLE[process.platform] ?? [])];
}
