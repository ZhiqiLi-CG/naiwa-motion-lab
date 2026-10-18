/**
 * Dev page for the local Lab: the whole app (src/main.ts) with src/lab mounted on top, the way the integrator will
 * mount it. Start the server first (node lab/server.mjs), then open /dev/lab.html (?lab=<port> for another server,
 * &open=1 to open the conversation panel).
 */
import "../src/main";
import { mountLab } from "../src/lab";
import type { Store } from "../src/store";

type Naiwa = { store: Store };

const booted = () =>
  new Promise<Naiwa>((resolve) => {
    const t = setInterval(() => {
      const n = (window as unknown as { __naiwa?: Naiwa }).__naiwa;
      if (n) {
        clearInterval(t);
        resolve(n);
      }
    }, 100);
  });

const naiwa = await booted();
const lab = mountLab({ store: naiwa.store });
Object.assign(window, { __lab: lab });
if ((await lab.available) && new URLSearchParams(location.search).has("open")) lab.open();
