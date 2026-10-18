// Real input through Chrome (mouse, touch, two-finger pinch) on dev/stage.html; prints what the handler saw.
// usage: node dev/stage-gestures.mjs [url]   (needs the stage dev server on :5194)
import puppeteer from "puppeteer-core";
import { chromePath, gpuArgs } from "../tests/tools/chrome.mjs";
const url = process.argv[2] ?? "http://127.0.0.1:5194/dev/stage.html?clean";
const browser = await puppeteer.launch({
  executablePath: chromePath(),
  headless: "new",
  args: ["--no-sandbox", ...gpuArgs()],
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const result = {};
async function open(touch) {
  const page = await browser.newPage();
  await page.setViewport(touch ? { width: 390, height: 844, hasTouch: true, isMobile: true } : { width: 1280, height: 800 });
  page.on("pageerror", (e) => console.log("[pageerror]", e.message));
  await page.goto(url, { waitUntil: "load" });
  await sleep(3000);
  return page;
}
const log = (page) => page.evaluate(() => __dev.log.splice(0).map((l) => l.replace(/^\d+ /, "")));
const yaw = (page) => page.evaluate(() => __dev.stage.camera.position.toArray().map((x) => +x.toFixed(2)));

// Mouse.
{
  const page = await open(false);
  const [fx, fy] = await page.evaluate(() => __dev.screenOf());
  await page.mouse.click(fx, fy, { delay: 80 });
  await sleep(200);
  result.mouseTapFrog = await log(page);
  await page.mouse.click(80, 700, { delay: 60 });
  await sleep(200);
  result.mouseTapBackground = await log(page);
  const before = await yaw(page);
  await page.mouse.move(100, 400);
  await page.mouse.down();
  for (let i = 1; i <= 20; i++) (await page.mouse.move(100 + i * 10, 400), await sleep(16));
  await page.mouse.up();
  await sleep(600);
  result.mouseOrbit = { before, after: await yaw(page), log: await log(page) };
  // Slow grab then a fling.
  const [gx, gy] = await page.evaluate(() => __dev.screenOf());
  await page.mouse.move(gx, gy);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) (await page.mouse.move(gx + i * 2, gy - i * 2), await sleep(30));
  for (let i = 1; i <= 6; i++) (await page.mouse.move(gx + 20 + i * 40, gy - 20 - i * 30), await sleep(16));
  await page.mouse.up();
  await sleep(300);
  result.mouseThrow = await log(page);
  await sleep(2500);
  // Fast swipe across the frog from the left.
  await page.evaluate(() => __dev.acts.reset());
  await sleep(1500);
  const [sx, sy] = await page.evaluate(() => __dev.screenOf());
  await page.mouse.move(sx - 300, sy);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) (await page.mouse.move(sx - 300 + i * 75, sy), await sleep(16));
  await page.mouse.up();
  await sleep(300);
  result.mouseSwipe = await log(page);
  await page.close();
}

// Touch.
{
  const page = await open(true);
  const [fx, fy] = await page.evaluate(() => __dev.screenOf());
  await page.touchscreen.tap(fx, fy);
  await sleep(200);
  result.touchTapFrog = await log(page);
  // Pump-style hold.
  await page.touchscreen.touchStart(fx, fy);
  await sleep(900);
  await page.touchscreen.touchEnd();
  await sleep(200);
  result.touchHold = await log(page);
  // Pinch out on the background.
  const cdp = await page.createCDPSession();
  const dist0 = await page.evaluate(() => __dev.stage.camera.position.length());
  const pts = (d) => [{ x: 195 - d, y: 700, id: 0 }, { x: 195 + d, y: 700, id: 1 }];
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: pts(30) });
  for (let d = 30; d <= 150; d += 10) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: pts(d) });
    await sleep(16);
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await sleep(800);
  result.pinch = { dist0: +dist0.toFixed(2), dist1: +(await page.evaluate(() => __dev.stage.camera.position.length())).toFixed(2), log: await log(page) };
  await page.close();
}
console.log(JSON.stringify(result, null, 1));
await browser.close();
