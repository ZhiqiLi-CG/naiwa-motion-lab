/** A CPU-backend worker: waits for a frame, runs its share of it, reports done. */
import { CTL, FrameRunner, type CpuShared } from "./shared";

self.onmessage = (e: MessageEvent<{ shared: CpuShared; index: number }>) => {
  const { shared, index } = e.data;
  const runner = new FrameRunner(shared, index);
  const ctl = new Int32Array(shared.buffers.control);
  let seen = Atomics.load(ctl, CTL.FRAME);
  (self as unknown as Worker).postMessage("ready");
  for (;;) {
    Atomics.wait(ctl, CTL.FRAME, seen);
    if (Atomics.load(ctl, CTL.QUIT)) return;
    seen = Atomics.load(ctl, CTL.FRAME);
    runner.frame();
    Atomics.add(ctl, CTL.DONE, 1);
  }
};
