// Open a page in headless Chrome (GPU WebGL), wait, save a screenshot and print the page's console.
// usage: node tests/tools/shot.mjs <url> <out.png> [--wait ms] [--size 1440x900] [--eval "js expr"] [--fake-video file.y4m|.mjpeg]
import puppeteer from "puppeteer-core";

const args = process.argv.slice(2);
const url = args[0];
const out = args[1];
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const wait = Number(opt("wait", "3000"));
const [w, h] = opt("size", "1440x900").split("x").map(Number);
const evalExpr = opt("eval", null);
const fakeVideo = opt("fake-video", null);

const chromeArgs = [
  "--no-sandbox",
  "--enable-gpu",
  "--ignore-gpu-blocklist",
  "--use-angle=vulkan",
  "--enable-features=Vulkan",
  "--autoplay-policy=no-user-gesture-required",
  "--use-fake-ui-for-media-stream",
  `--window-size=${w},${h}`,
];
if (fakeVideo) chromeArgs.push("--use-fake-device-for-media-stream", `--use-file-for-fake-video-capture=${fakeVideo}`);

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME || "/usr/bin/google-chrome",
  headless: "new",
  args: chromeArgs,
});
const page = await browser.newPage();
await page.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
page.on("console", (m) => console.log(`[console.${m.type()}]`, m.text()));
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
page.on("requestfailed", (r) => console.log("[requestfailed]", r.url(), r.failure()?.errorText));
await page.goto(url, { waitUntil: "load", timeout: 60000 });
await new Promise((r) => setTimeout(r, wait));
if (evalExpr) console.log("[eval]", JSON.stringify(await page.evaluate(evalExpr)));
if (out) await page.screenshot({ path: out });
await browser.close();
