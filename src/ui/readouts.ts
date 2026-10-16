/** Simulation readouts (AppState.stats, refreshed by the integration): frame rate, step time, particles, cells and
 *  the volume ratio, plus the playback state when it is not plain real time. */
import { copy } from "./copy";
import { changed, type Part } from "./ctx";
import { h } from "./dom";
import { formatCount, formatMs } from "./format";

export function createReadouts(host: HTMLElement): Part {
  const T = copy();
  const cell = (label: string) => {
    const v = h("b", { class: "nw-readout-v" });
    return { v, el: h("span", { class: "nw-readout" }, h("span", { class: "nw-readout-k" }, label), v) };
  };
  const fps = cell(T.readouts.fps);
  const step = cell(T.readouts.step);
  const particles = cell(T.readouts.particles);
  const cells = cell(T.readouts.cells);
  const volume = cell(T.readouts.volume);
  const play = h("span", { class: "nw-readout-state" });
  host.append(h("div", { class: "nw-readouts", role: "status", "aria-label": T.readouts.label }, play, fps.el, step.el, particles.el, cells.el, volume.el));
  return {
    update(s, prev) {
      if (changed(s, prev, (x) => x.stats)) {
        const st = s.stats;
        fps.v.textContent = String(Math.round(st.fps));
        step.v.textContent = `${formatMs(st.stepMs)} ms`;
        particles.v.textContent = formatCount(st.particles);
        cells.v.textContent = formatCount(st.cells);
        volume.v.textContent = `${st.volumeRatio.toFixed(3)}`;
      }
      if (changed(s, prev, (x) => x.playback)) {
        const { paused, timeScale } = s.playback;
        play.textContent = paused ? T.readouts.paused : timeScale !== 1 ? `${timeScale}×` : "";
        play.hidden = play.textContent === "";
      }
    },
  };
}
