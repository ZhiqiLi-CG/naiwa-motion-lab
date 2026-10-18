// Headless Chrome session over a frame folder: the app's PoseLandmarker (@mediapipe/tasks-vision) runs in the page
// (tools/dances/page.html) on every frame, and the same page draws the check panels.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer-core";
import { chromePath } from "../../tests/tools/chrome.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const PORT = 5198;
const TYPES = { ".html": "text/html", ".mjs": "text/javascript", ".js": "text/javascript", ".wasm": "application/wasm" };

export async function openSession({ framesDir, model }) {
  const routes = [
    ["/vision/", path.join(ROOT, "node_modules/@mediapipe/tasks-vision/")],
    ["/frames/", framesDir + "/"],
  ];
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent(new URL(req.url, "http://x").pathname);
    let file = null;
    if (url === "/" || url === "/tool") file = path.join(ROOT, "tools/dances/page.html");
    else if (url === "/model.task") file = model;
    else for (const [prefix, dir] of routes) if (url.startsWith(prefix)) file = path.join(dir, url.slice(prefix.length));
    if (!file || !fs.existsSync(file)) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((ok, fail) => server.once("error", fail).listen(PORT, "127.0.0.1", ok));
  const browser = await puppeteer.launch({
    executablePath: chromePath(),
    headless: "new",
    args: ["--no-sandbox"],
    protocolTimeout: 3_600_000,
  });
  const page = await browser.newPage();
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") console.log(`[page.${m.type()}]`, m.text());
  });
  page.on("pageerror", (e) => console.log("[pageerror]", e.message));
  await page.goto(`http://127.0.0.1:${PORT}/tool`, { waitUntil: "load" });
  await page.waitForFunction("window.toolReady === true");
  return {
    extract: (opts) => page.evaluate((o) => window.extract(o), opts),
    /** Draws one check panel and writes it as a JPEG. */
    async draw(opts, outFile) {
      const url = await page.evaluate((o) => window.draw(o), opts);
      fs.writeFileSync(outFile, Buffer.from(url.slice(url.indexOf(",") + 1), "base64"));
    },
    async close() {
      await browser.close();
      await new Promise((ok) => server.close(ok));
    },
  };
}
