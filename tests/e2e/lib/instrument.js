// Injected before the app's own scripts: watches what the app does without needing any hook in it.
// window.__e2e collects frame timing, sounds, object URLs (the recording) and long tasks; attachHooks() adds what
// the optional window.__naiwa test hook makes visible (simulation events, effects, physics time).
(() => {
  const e2e = (window.__e2e = { frames: [], sounds: [], blobs: [], longTasks: [], events: [], fx: [], physics: [] });

  // Frame timing: every rAF callback with its frame timestamp and how long it ran.
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) =>
    raf((ts) => {
      const t0 = performance.now();
      try {
        cb(ts);
      } finally {
        e2e.frames.push([ts, performance.now() - t0]);
        if (e2e.frames.length > 4000) e2e.frames.splice(0, 2000);
      }
    });

  // Sounds: any Web Audio source started, any <audio> played.
  const start = AudioScheduledSourceNode.prototype.start;
  AudioScheduledSourceNode.prototype.start = function (...args) {
    e2e.sounds.push({ t: performance.now(), node: this.constructor.name });
    return start.apply(this, args);
  };
  const play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function (...args) {
    if (!(this instanceof HTMLVideoElement)) e2e.sounds.push({ t: performance.now(), node: "audio" });
    return play.apply(this, args);
  };

  // Blobs handed out as object URLs: a finished recording shows up here.
  const createObjectURL = URL.createObjectURL;
  URL.createObjectURL = function (obj) {
    const url = createObjectURL.call(URL, obj);
    if (obj instanceof Blob) e2e.blobs.push({ url, type: obj.type, size: obj.size, t: performance.now(), blob: /^(video|audio)\//.test(obj.type) ? obj : null });
    return url;
  };

  // Camera streams the app opened (to see they are stopped again when it leaves camera mode).
  e2e.streams = [];
  const gum = navigator.mediaDevices?.getUserMedia?.bind(navigator.mediaDevices);
  if (gum) {
    navigator.mediaDevices.getUserMedia = async (c) => {
      const s = await gum(c);
      e2e.streams.push({ stream: s, constraints: JSON.stringify(c), t: performance.now() });
      return s;
    };
  }
  // Media elements whose sound is routed through Web Audio (the dance music mixed in for playback and recording).
  e2e.routed = [];
  const createMES = AudioContext.prototype.createMediaElementSource;
  AudioContext.prototype.createMediaElementSource = function (el) {
    e2e.routed.push(el);
    return createMES.call(this, el);
  };

  e2e.liveCameraTracks = () => e2e.streams.flatMap((s) => s.stream.getVideoTracks()).filter((t) => t.readyState === "live").length;

  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) e2e.longTasks.push([e.startTime, e.duration]);
    }).observe({ type: "longtask", buffered: true });
  } catch {}

  /** Wrap the optional test hook's objects (called once the app is up). Returns what was found. */
  e2e.attachHooks = () => {
    const n = window.__naiwa;
    const found = { hook: !!n };
    if (!n) return found;
    if (n.sim?.onEvent && !e2e.simHooked) {
      n.sim.onEvent((e) => e2e.events.push({ kind: e.kind, strength: e.strength, region: e.region, t: performance.now() }));
      e2e.simHooked = true;
    }
    if (n.sim?.step && !n.sim.step.__e2e) {
      const step = n.sim.step.bind(n.sim);
      n.sim.step = Object.assign((dt) => {
        const t0 = performance.now();
        step(dt);
        e2e.physics.push([t0, performance.now() - t0]);
        if (e2e.physics.length > 4000) e2e.physics.splice(0, 2000);
      }, { __e2e: true });
    }
    const fx = n.stage?.fx;
    if (fx && !fx.__e2e) {
      for (const k of ["popText", "burst", "shake"]) {
        const f = fx[k]?.bind(fx);
        if (f) fx[k] = (...a) => (e2e.fx.push({ k, arg: typeof a[1] === "string" ? a[1] : null, t: performance.now() }), f(...a));
      }
      fx.__e2e = true;
    }
    for (const k of ["store", "stage", "character", "sim", "motion"]) found[k] = !!n[k];
    return found;
  };

  /* ---- Page-side helpers the runner calls through page.evaluate ---- */

  /** Rendered, not hidden by itself or an ancestor (display, visibility, opacity), and at least partly on screen. */
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0 || r.right <= 0 || r.bottom <= 0 || r.left >= innerWidth || r.top >= innerHeight) return false;
    return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
  };
  const rectOf = (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  };
  const label = (el) => [el.textContent, el.getAttribute("aria-label"), el.getAttribute("title"), el.value].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();

  /** The 3D canvas: the stage's, else the largest visible canvas. */
  e2e.mainCanvas = () =>
    window.__naiwa?.stage?.canvas ??
    [...document.querySelectorAll("canvas")].filter(visible).sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0] ??
    null;
  e2e.canvasRect = () => {
    const c = e2e.mainCanvas();
    return c ? rectOf(c) : null;
  };

  /** The control a user would press: [data-mode=…], or the innermost visible control whose text, aria-label or
   *  title contains the label (or matches the pattern); shortest text first. */
  e2e.findControl = (spec) => {
    const re = spec.re ? new RegExp(spec.re) : null;
    const skip = spec.skip ? new RegExp(spec.skip) : null;
    const sel = "button, [role=button], [role=tab], [role=radio], [role=menuitem], [role=option], [role=switch], a[href], label, input[type=button], input[type=submit], [data-mode]";
    let hits = [...document.querySelectorAll(sel)].filter((el) => {
      if (spec.mode && el.dataset.mode === spec.mode) return true;
      const t = label(el);
      if (skip && skip.test(t)) return false;
      return (spec.label && t.includes(spec.label)) || (re && re.test(t));
    });
    hits = hits.filter(visible).filter((el) => !el.disabled);
    hits = hits.filter((el) => !hits.some((o) => o !== el && el.contains(o)));
    hits.sort((a, b) => label(a).length - label(b).length);
    return hits[0] ?? null;
  };
  /** Is this control shown as selected/on? null when it does not say. */
  e2e.selectedState = (el) => {
    for (const a of ["aria-pressed", "aria-selected", "aria-checked"]) {
      const v = el.getAttribute(a);
      if (v !== null) return v === "true";
    }
    if (el.hasAttribute("aria-current")) return el.getAttribute("aria-current") !== "false";
    const input = el.matches("input") ? el : el.querySelector("input[type=radio],input[type=checkbox]") ?? (el.htmlFor ? document.getElementById(el.htmlFor) : null);
    if (input) return input.checked;
    return null;
  };
  e2e.describe = (el) => ({ text: label(el).slice(0, 40), tag: el.tagName.toLowerCase(), rect: rectOf(el) });

  /** All visible controls (for the phone layout check). */
  e2e.controls = () =>
    [...document.querySelectorAll("button, [role=button], [role=tab], [role=radio], [role=switch], a[href], input, select, label[for]")]
      .filter(visible)
      .map((el) => e2e.describe(el));

  /** The frog's centre on screen (CSS px), from the hook's character and camera. */
  e2e.frogPoint = () => {
    const n = window.__naiwa;
    if (!n?.character?.center || !n?.stage?.camera) return null;
    const V = n.stage.camera.position.constructor;
    const c = n.character.center(new V());
    const p = c.clone().project(n.stage.camera);
    const r = e2e.mainCanvas().getBoundingClientRect();
    return { x: r.left + ((p.x + 1) / 2) * r.width, y: r.top + ((1 - p.y) / 2) * r.height, world: [c.x, c.y, c.z] };
  };
  /** Show or hide the frog (to find its pixels by difference), then wait for frames to be drawn. */
  e2e.setFrogVisible = async (on) => {
    const o = window.__naiwa?.character?.object;
    if (!o) return false;
    o.visible = on;
    for (let i = 0; i < 3; i++) await new Promise((r) => raf(r));
    return true;
  };

  /** World matrices of these bones as rendered (to measure how the pose changes). */
  e2e.boneSample = (names) => {
    const bones = window.__naiwa?.character?.rig?.bones;
    if (!bones) return null;
    const out = {};
    for (const k of names) {
      const b = bones.get(k);
      if (b) out[k] = Array.from(b.matrixWorld.elements);
    }
    return out;
  };

  e2e.state = () => {
    const s = window.__naiwa?.store?.get();
    return s ? { sound: s.sound, playback: s.playback, lang: s.lang, mode: s.mode, tool: s.tool, dance: s.dance, dances: s.dances, mirror: s.mirror, canSaveDance: s.canSaveDance, recordLayout: s.recordLayout, motion: s.motion, recording: s.recording, stats: s.stats, loading: s.loading, lastRecording: s.lastRecording ? { mimeType: s.lastRecording.mimeType, durationMs: s.lastRecording.durationMs, fileName: s.lastRecording.fileName, size: s.lastRecording.blob?.size } : null } : null;
  };

  e2e.videos = () =>
    [...document.querySelectorAll("video")].map((v) => ({
      stream: v.srcObject instanceof MediaStream,
      src: (v.currentSrc || "").slice(0, 60),
      ready: v.readyState,
      paused: v.paused,
      w: v.videoWidth,
      h: v.videoHeight,
      t: v.currentTime,
      shown: visible(v),
      rect: rectOf(v),
    }));
  /** The uploaded video playing in the preview, and whether its sound can be heard (and so recorded). */
  e2e.playingVideo = () => [...document.querySelectorAll("video")].find((v) => !v.srcObject && v.currentSrc && v.readyState >= 2) ?? null;
  e2e.music = () => {
    const v = e2e.playingVideo();
    if (!v) return null;
    let mirrored = false;
    for (let el = v; el; el = el.parentElement) {
      const t = getComputedStyle(el).transform;
      if (t && t !== "none" && new DOMMatrix(t).a < 0) mirrored = !mirrored;
    }
    return { routed: e2e.routed.includes(v), muted: v.muted, volume: v.volume, paused: v.paused, rate: v.playbackRate, t: v.currentTime, duration: v.duration, loop: v.loop, mirrored, shown: visible(v) };
  };

  /** Sample the playing video's time and the frog's bone positions every `ms` (for the follow and sync checks). */
  e2e.startSampler = (names, ms = 100) => {
    e2e.samples = [];
    clearInterval(e2e.sampler);
    e2e.sampler = setInterval(() => {
      const v = e2e.playingVideo();
      const bones = window.__naiwa?.character?.rig?.bones;
      const pos = {};
      if (bones) for (const k of names) {
        const e = bones.get(k)?.matrixWorld.elements;
        if (e) pos[k] = [e[12], e[13], e[14]];
      }
      e2e.samples.push({ t: performance.now(), vt: v && !v.paused ? v.currentTime : null, pos });
    }, ms);
  };
  e2e.stopSampler = () => {
    clearInterval(e2e.sampler);
    return e2e.samples;
  };

  /** Text a visitor sees (text nodes and aria-label/title/placeholder/alt) that is not in `lang`: Chinese characters
   *  in English (the brand 奶蛙 aside), or English words with no Chinese in Chinese (brand and unit words aside). */
  e2e.textAudit = (lang) => {
    const CJK = /[\u3400-\u9fff\uf900-\ufaff]/;
    const okWords = /^(naiwa|motion|lab|duang|vs|fps|gpu|webgl|mediapipe|ok|q|ios|android|mp4|webm|mb|kb)$/i;
    const found = new Map();
    const test = (text, el, where) => {
      const t = text.replace(/\s+/g, " ").trim();
      if (!t) return;
      const bad = lang === "en" ? CJK.test(t.replace(/奶蛙/g, "")) : !CJK.test(t) && (t.match(/[A-Za-z]{2,}/g) ?? []).some((w) => !okWords.test(w));
      if (bad && !found.has(t)) found.set(t, `${where}${el.id ? `#${el.id}` : el.className && typeof el.className === "string" ? `.${el.className.split(" ")[0]}` : ` <${el.tagName.toLowerCase()}>`}`);
    };
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n; (n = walker.nextNode()); ) {
      const el = n.parentElement;
      if (el && !el.closest("script,style,noscript") && visible(el)) test(n.textContent, el, "text");
    }
    for (const el of document.querySelectorAll("[aria-label],[title],[placeholder],[alt],[data-tip]")) {
      if (!visible(el)) continue;
      for (const a of ["aria-label", "title", "placeholder", "alt", "data-tip"]) if (el.hasAttribute(a)) test(el.getAttribute(a), el, a);
    }
    return [...found].map(([text, where]) => ({ text: text.slice(0, 60), where }));
  };

  /** Elements whose own text spills out of their box, or that stick out of the screen. */
  e2e.overflowAudit = () => {
    const out = [];
    const name = (el) => `${el.tagName.toLowerCase()}${el.className && typeof el.className === "string" ? `.${el.className.split(" ")[0]}` : ""} "${label(el).slice(0, 24)}"`;
    for (const el of document.querySelectorAll("body *")) {
      if (el.closest("canvas,svg,video") || !visible(el)) continue;
      const s = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      const ownText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
      if (r.right > innerWidth + 1 || r.left < -1) out.push({ kind: "off screen", el: name(el), detail: `${Math.round(r.left)}…${Math.round(r.right)} of ${innerWidth}` });
      if (!ownText || s.display === "inline" || /auto|scroll/.test(s.overflowX + s.overflowY)) continue;
      if (el.scrollWidth > el.clientWidth + 1) out.push({ kind: s.textOverflow === "ellipsis" ? "cut off" : "text spills", el: name(el), detail: `${el.scrollWidth} px of text in ${el.clientWidth} px` });
      else if (el.scrollHeight > el.clientHeight + 2 && s.overflowY !== "visible") out.push({ kind: "cut off", el: name(el), detail: `${el.scrollHeight} px tall in ${el.clientHeight} px` });
    }
    return out;
  };

  /** The simulated body surface (every 10th vertex), kept in the page under a name, to compare later. */
  e2e.snaps = {};
  e2e.snap = (name) => {
    const body = window.__naiwa?.sim?.readBody();
    if (!body) return false;
    const sub = new Float32Array(Math.ceil(body.length / 30) * 3);
    for (let i = 0, j = 0; i < body.length; i += 30, j += 3) sub.set(body.subarray(i, i + 3), j);
    e2e.snaps[name] = sub;
    return true;
  };
  /** Mean distance (m) the surface vertices moved between two snapshots. */
  e2e.delta = (a, b) => {
    const A = e2e.snaps[a], B = e2e.snaps[b];
    let s = 0;
    for (let i = 0; i < A.length; i += 3) s += Math.hypot(B[i] - A[i], B[i + 1] - A[i + 1], B[i + 2] - A[i + 2]);
    return s / (A.length / 3);
  };
  /** How fast the surface moves (m/s: path length of the mean vertex) over `ms`, sampled every frame. */
  e2e.surfaceSpeed = async (ms) => {
    const t0 = performance.now();
    let path = 0, k = 0;
    e2e.snap("speed0");
    while (performance.now() - t0 < ms) {
      await new Promise((r) => raf(r));
      e2e.snap(`speed${(k + 1) % 2}`);
      path += e2e.delta(`speed${k % 2}`, `speed${(k + 1) % 2}`);
      k++;
    }
    return { speed: path / ((performance.now() - t0) / 1000), frames: k };
  };

  /** Rects to leave out of frame differences: the camera/video preview and its drawn skeleton. */
  e2e.overlayRects = () => {
    const main = e2e.mainCanvas();
    return [...document.querySelectorAll("video, canvas")].filter((el) => el !== main && visible(el)).map(rectOf);
  };

  /** Frames per second and main-thread work per frame (ms) between two performance.now() times. */
  e2e.frameStats = (t0, t1) => {
    const perFrame = new Map();
    for (const [ts, d] of e2e.frames) if (ts >= t0 && ts <= t1) perFrame.set(ts, (perFrame.get(ts) ?? 0) + d);
    const work = [...perFrame.values()].sort((a, b) => a - b);
    const q = (f) => (work.length ? work[Math.min(work.length - 1, Math.floor(work.length * f))] : 0);
    const phys = e2e.physics.filter(([t]) => t >= t0 && t <= t1).map(([, d]) => d).sort((a, b) => a - b);
    const pq = (f) => (phys.length ? phys[Math.min(phys.length - 1, Math.floor(phys.length * f))] : null);
    return {
      fps: work.length / ((t1 - t0) / 1000),
      workP50: q(0.5),
      workP95: q(0.95),
      workMax: q(1),
      longTasks: e2e.longTasks.filter(([s]) => s >= t0 && s <= t1).length,
      physicsP50: pq(0.5),
      physicsP95: pq(0.95),
      physicsSteps: phys.length,
    };
  };

  /** The newest recorded video blob, as base64 (the Blob is kept, so a revoked URL does not matter). */
  e2e.lastVideoBlob = async () => {
    const b = [...e2e.blobs].reverse().find((x) => /^video\//.test(x.type) && x.blob);
    if (!b) return null;
    const data = await new Promise((resolve) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result).split(",")[1]);
      fr.readAsDataURL(b.blob);
    });
    return { type: b.type, size: b.size, data };
  };
})();
