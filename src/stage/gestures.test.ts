import * as THREE from "three";
import { describe, expect, it } from "vitest";
import type { PointerInfo } from "../contracts";
import { estimateVelocity, GestureRecognizer, type GestureHost, type StageGestureHandler } from "./gestures";

/** The "frog" covers client x in [100, 200]; rays carry the client x in origin.x so hitTest can read it. */
function setup(opts: { swipe?: boolean } = {}) {
  const calls: string[] = [];
  const orbit = { dx: 0, dy: 0, flings: [] as [number, number][], cancels: 0, zoom: 1 };
  const host: GestureHost = {
    info: (x, y, t, pointerType): PointerInfo => ({
      ray: new THREE.Ray(new THREE.Vector3(x, y, 0), new THREE.Vector3(0, 0, -1)),
      ndc: new THREE.Vector2(),
      clientX: x,
      clientY: y,
      time: t,
      pointerType,
    }),
    orbitStart: () => calls.push("orbitStart"),
    orbit: (dx, dy) => ((orbit.dx += dx), (orbit.dy += dy)),
    orbitCancel: () => orbit.cancels++,
    fling: (vx, vy) => orbit.flings.push([vx, vy]),
    zoom: (f) => (orbit.zoom *= f),
  };
  const h: StageGestureHandler = {
    hitTest: (ray) => ray.origin.x >= 100 && ray.origin.x <= 200,
    onPressStart: () => calls.push("pressStart"),
    onPressEnd: () => calls.push("pressEnd"),
    onTap: (p) => calls.push(`tap@${p.clientX}`),
    onDragStart: (p) => calls.push(`dragStart@${p.clientX}`),
    onDragMove: () => calls.push("dragMove"),
    onDragEnd: (_p, v) => calls.push(`dragEnd ${Math.round(v.x)}`),
    onHover: (p) => calls.push(p ? "hover" : "hover-null"),
  };
  if (opts.swipe) h.onSwipe = (p, v) => calls.push(`swipe@${Math.round(p.clientX)} ${Math.round(v.x)}`);
  const rec = new GestureRecognizer(host);
  rec.handler = h;
  const events = () => calls.filter((c) => c !== "hover" && c !== "dragMove" && c !== "orbitStart");
  return { rec, calls, events, orbit };
}

/** Move pointer id from x0 to x1 (y fixed) in steps of dtMs, starting at t0; returns the end time. */
function slide(rec: GestureRecognizer, id: number, x0: number, x1: number, t0: number, steps: number, dtMs: number, type = "touch") {
  let t = t0;
  for (let i = 1; i <= steps; i++) {
    t = t0 + i * dtMs;
    rec.move(id, [{ x: x0 + ((x1 - x0) * i) / steps, y: 300, t }], type);
  }
  return t;
}

describe("GestureRecognizer", () => {
  it("a short still press on the frog is press start, tap, press end", () => {
    const { rec, events } = setup();
    rec.down(1, 150, 300, 0, "touch");
    rec.up(1, 151, 300, 120);
    expect(events()).toEqual(["pressStart", "tap@151", "pressEnd", "hover-null"]);
  });

  it("a long still press on the frog (the pump) has press start and end but no tap", () => {
    const { rec, events } = setup();
    rec.down(1, 150, 300, 0, "touch");
    rec.up(1, 150, 300, 1500);
    expect(events()).toEqual(["pressStart", "pressEnd", "hover-null"]);
  });

  it("a tap on the background is still a tap, and does not orbit", () => {
    const { rec, events, orbit } = setup();
    rec.down(1, 400, 300, 0, "mouse");
    rec.up(1, 402, 300, 100);
    expect(events()).toEqual(["tap@402"]);
    expect(orbit.dx).toBe(0);
  });

  it("a slow drag from the frog grabs from where it was pressed and throws with the release speed", () => {
    const { rec, events } = setup({ swipe: true });
    rec.down(1, 150, 300, 0, "touch");
    // Slow start (well under the swipe speed), then a fast fling.
    let t = slide(rec, 1, 150, 180, 0, 10, 30);
    t = slide(rec, 1, 180, 380, t, 5, 16);
    rec.up(1, 380, 300, t + 5);
    const ev = events();
    expect(ev[0]).toBe("pressStart");
    expect(ev[1]).toBe("dragStart@150");
    const end = ev.find((e) => e.startsWith("dragEnd"))!;
    expect(Number(end.split(" ")[1])).toBeGreaterThan(1500);
    expect(ev.slice(-2)).toEqual(["pressEnd", "hover-null"]);
    expect(ev.some((e) => e.startsWith("swipe"))).toBe(false);
  });

  it("holding still before the release throws nothing", () => {
    const { rec, events } = setup();
    rec.down(1, 150, 300, 0, "touch");
    const t = slide(rec, 1, 150, 300, 0, 10, 20);
    rec.up(1, 300, 300, t + 300);
    expect(events()).toContain("dragEnd 0");
  });

  it("a press on the frog that moves fast from the start is a slap, not a drag", () => {
    const { rec, events } = setup({ swipe: true });
    rec.down(1, 150, 300, 0, "touch");
    const t = slide(rec, 1, 150, 330, 0, 4, 16);
    rec.up(1, 330, 300, t);
    const ev = events();
    expect(ev[0]).toBe("pressStart");
    expect(ev[1]).toMatch(/^swipe@150 \d+/);
    expect(Number(ev[1].split(" ")[1])).toBeGreaterThan(1000);
    expect(ev.some((e) => e.startsWith("drag"))).toBe(false);
    expect(ev).toContain("pressEnd");
  });

  it("without onSwipe a fast swipe from the frog is a drag", () => {
    const { rec, events } = setup();
    rec.down(1, 150, 300, 0, "touch");
    slide(rec, 1, 150, 330, 0, 4, 16);
    expect(events()[1]).toBe("dragStart@150");
  });

  it("a fast swipe from the background across the frog slaps where it crossed and undoes its orbit", () => {
    const { rec, events, orbit } = setup({ swipe: true });
    rec.down(1, 20, 300, 0, "touch");
    // 60 px per 16 ms ≈ 3750 px/s; crosses x = 100 on the second step.
    const t = slide(rec, 1, 20, 260, 0, 4, 16);
    rec.up(1, 260, 300, t);
    const ev = events();
    const swipe = ev.find((e) => e.startsWith("swipe"))!;
    const at = Number(swipe.slice(6).split(" ")[0]);
    expect(at).toBeGreaterThanOrEqual(100);
    expect(at).toBeLessThanOrEqual(112);
    expect(orbit.cancels).toBe(1);
    expect(orbit.flings).toEqual([]);
    expect(ev.some((e) => e.startsWith("press"))).toBe(false);
  });

  it("a slow background drag orbits and flings with the release speed; it never slaps", () => {
    const { rec, events, orbit } = setup({ swipe: true });
    rec.down(1, 20, 300, 0, "mouse");
    let t = slide(rec, 1, 20, 140, 0, 20, 30, "mouse");
    t = slide(rec, 1, 140, 300, t, 8, 16, "mouse");
    rec.up(1, 300, 300, t + 4);
    expect(events().some((e) => e.startsWith("swipe") || e.startsWith("tap"))).toBe(false);
    expect(orbit.dx).toBeCloseTo(280);
    expect(orbit.flings.length).toBe(1);
    expect(orbit.flings[0][0]).toBeGreaterThan(1000);
  });

  it("a second finger ends the frog drag and pinches: spreading fingers zooms in", () => {
    const { rec, events, orbit } = setup();
    rec.down(1, 150, 300, 0, "touch");
    slide(rec, 1, 150, 200, 0, 5, 30);
    rec.down(2, 300, 300, 200, "touch");
    rec.move(2, [{ x: 400, y: 300, t: 216 }], "touch");
    rec.up(2, 400, 300, 300);
    rec.up(1, 200, 300, 310);
    const ev = events();
    expect(ev).toEqual(["pressStart", "dragStart@150", "dragEnd 0", "pressEnd", "hover-null"]);
    expect(orbit.zoom).toBeCloseTo(100 / 200);
  });

  it("mouse hover reports positions and null when the pointer leaves", () => {
    const { rec, calls } = setup();
    rec.move(9, [{ x: 10, y: 10, t: 0 }], "mouse");
    rec.leave();
    expect(calls).toEqual(["hover", "hover-null"]);
  });
});

describe("estimateVelocity", () => {
  it("uses the last ~80 ms and is zero after a pause", () => {
    const s = [
      { x: 0, y: 0, t: 0 },
      { x: 10, y: 0, t: 100 },
      { x: 20, y: 0, t: 120 },
      { x: 40, y: 0, t: 140 },
    ];
    expect(estimateVelocity(s, 140).x).toBeCloseTo(30 / 0.04);
    expect(estimateVelocity(s, 300).x).toBe(0);
  });
});
