// Frame cost of the stage on dev/stage.html: desktop and phone-sized, with and without the frog, CPU throttled.
// usage: node dev/stage-perf.mjs [url]   (needs the stage dev server on :5194)
import puppeteer from "puppeteer-core";
const base = process.argv[2] ?? "http://127.0.0.1:5194/dev/stage.html?clean";
const browser = await puppeteer.launch({
  executablePath: "/usr/bin/google-chrome",
  headless: "new",
  args: ["--no-sandbox", "--enable-gpu", "--ignore-gpu-blocklist", "--use-angle=vulkan", "--enable-features=Vulkan"],
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cases = [
  { name: "desktop 1440x900 dpr1", vp: { width: 1440, height: 900 } },
  { name: "desktop 1440x900 dpr2", vp: { width: 1440, height: 900, deviceScaleFactor: 2 } },
  { name: "phone 390x844 dpr3 (cap 1.5), cpu x4", vp: { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true }, throttle: 4 },
];
for (const c of cases) {
  const page = await browser.newPage();
  await page.setViewport(c.vp);
  await page.goto(base, { waitUntil: "load" });
  await sleep(3000);
  if (c.throttle) await (await page.createCDPSession()).send("Emulation.setCPUThrottlingRate", { rate: c.throttle });
  const withFrog = await page.evaluate(() => __dev.measure(3000));
  await page.evaluate(() => __dev.stage.scene.getObjectByName("Naiwa").visible = false);
  const stageOnly = await page.evaluate(() => __dev.measure(3000));
  await page.evaluate(async () => {
    __dev.stage.scene.getObjectByName("Naiwa").visible = true;
    __dev.acts.balls();
    __dev.acts.balls();
    for (let i = 0; i < 6; i++) await __dev.showcase(120);
  });
  const busy = await page.evaluate(() => __dev.measure(1500));
  console.log(c.name, JSON.stringify({ withFrog, stageOnly, busyFx32Balls: busy }));
  await page.close();
}
await browser.close();
