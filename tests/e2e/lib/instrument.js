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
    // every simulation the page builds (it is rebuilt when the simulator, and now and then the motion, changes)
    if (n.sim?.onEvent && !(e2e.hookedSims ??= new WeakSet()).has(n.sim)) {
      n.sim.onEvent((e) => e2e.events.push({ kind: e.kind, strength: e.strength, region: e.region, t: performance.now() }));
      e2e.hookedSims.add(n.sim);
    }
    // the pose targets the page hands the simulation each frame (bone world matrices from the motion source)
    if (n.sim?.setTargets && !n.sim.setTargets.__e2e) {
      const setTargets = n.sim.setTargets.bind(n.sim);
      n.sim.setTargets = Object.assign((targets) => {
        e2e.lastTargets = targets;
        return setTargets(targets);
      }, { __e2e: true });
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
      // a control marked with its mode (not a container such as #ui, which carries the current mode)
      if (spec.mode && el.dataset.mode === spec.mode && el.matches("button, [role=button], [role=tab], [role=radio]")) return true;
      const t = label(el);
      if (skip && skip.test(t)) return false;
      if (t.length > 60) return false; // a container of many controls, not one
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
  /** What a click at the control's centre would really hit, when that is not the control itself. */
  e2e.coveredBy = (el) => {
    const r = el.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    if (!top || el.contains(top) || top.contains(el) || (el.htmlFor && top.id === el.htmlFor)) return null;
    return `${top.tagName.toLowerCase()}${top.className && typeof top.className === "string" ? `.${top.className.split(" ")[0]}` : ""} "${label(top).slice(0, 24)}"`;
  };

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
    return s ? { sound: s.sound, playback: s.playback, lang: s.lang, mode: s.mode, tool: s.tool, dance: s.dance, dances: s.dances, mirror: s.mirror, canSaveDance: s.canSaveDance, recordLayout: s.recordLayout, simulator: s.simulator, retargeter: s.retargeter, motion: s.motion, recording: s.recording, stats: s.stats, loading: s.loading, lastRecording: s.lastRecording ? { mimeType: s.lastRecording.mimeType, durationMs: s.lastRecording.durationMs, fileName: s.lastRecording.fileName, size: s.lastRecording.blob?.size } : null } : null;
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

  /** Sample the playing video's time and the frog's bone positions every `ms` (for the follow and sync checks), at
   *  three stages: the pose targets the motion hands the simulation (targets), the simulated skeleton
   *  (sim.readBones) and the rendered rig (pos); plus where the rendered hands are on screen (CSS px). The video is
   *  the one the page routes through its sound mix (the motion source's own), else the first one playing. */
  e2e.startSampler = (names, ms = 100) => {
    e2e.samples = [];
    clearInterval(e2e.sampler);
    e2e.sampler = setInterval(() => {
      const n = window.__naiwa;
      const v = [...e2e.routed].reverse().find((x) => x.isConnected && x.currentSrc) ?? e2e.playingVideo();
      const at = (get) => {
        const out = {};
        for (const k of names) {
          const e = get(k)?.elements;
          if (e) out[k] = [e[12], e[13], e[14]];
        }
        return out;
      };
      const bones = n?.character?.rig?.bones;
      const pos = bones ? at((k) => bones.get(k)?.matrixWorld) : {};
      const targets = e2e.lastTargets ? at((k) => e2e.lastTargets.get(k)) : {};
      let sim = {};
      if (n?.sim?.readBones) {
        const m = new Map();
        n.sim.readBones(m);
        sim = at((k) => m.get(k));
      }
      let screen = null;
      if (bones && n.stage?.camera) {
        const r = e2e.mainCanvas().getBoundingClientRect();
        const V = n.stage.camera.position.constructor;
        const sx = (k) => { const p = new V().setFromMatrixPosition(bones.get(k).matrixWorld).project(n.stage.camera); return r.left + ((p.x + 1) / 2) * r.width; };
        screen = { hand_L: sx("hand_L"), hand_R: sx("hand_R") };
      }
      e2e.samples.push({ t: performance.now(), vt: v && !v.paused ? v.currentTime : null, pos, targets, sim, screen });
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
    const okWords = /^(naiwa|motion|lab|vs|fps|gpu|cpu|fem|webgl|mediapipe|ok|ios|android|mp4|webm|mb|kb|ms|cm|mm|px|hz|kg)$/i;
    // The language switch names the other language in that language; a cited source keeps its own title.
    const langNames = /^(EN|En|English|中|中文|Switch to English|切换到中文|Language|语言)(\s+\S)?$/;
    const dances = window.__naiwa?.store?.get().dances ?? [];
    // a cited source keeps its title; a dance whose name is the same in both languages ("Nae Nae") is a name
    const credits = [...dances.map((d) => d.credit), ...dances.filter((d) => d.nameEn && d.name === d.nameEn).map((d) => d.name)].filter(Boolean);
    const found = new Map();
    const test = (text, el, where) => {
      const t = text.replace(/\s+/g, " ").trim();
      if (!t || langNames.test(t) || credits.some((c) => t.includes(c)) || el.closest("[lang]")?.getAttribute("lang")?.slice(0, 2) === (lang === "en" ? "zh" : "en")) return;
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
  /** How fast the surface moves (m/s: path length of the mean vertex) over `ms`, measured between snapshots every
   *  100 ms (frame-to-frame differences would count the flesh's jitter, which does not slow with the motion); also
   *  the frames drawn meanwhile. */
  e2e.surfaceSpeed = async (ms) => {
    const t0 = performance.now();
    let path = 0, k = 0, n = 0, last = t0;
    e2e.snap("speed0");
    while (performance.now() - t0 < ms) {
      await new Promise((r) => raf(r));
      k++;
      if (performance.now() - last < 100) continue;
      last = performance.now();
      e2e.snap(`speed${(n + 1) % 2}`);
      path += e2e.delta(`speed${n % 2}`, `speed${(n + 1) % 2}`);
      n++;
    }
    return { speed: path / ((last - t0) / 1000), frames: k };
  };

  /* ---- Interpenetration: limb flesh inside the Body, and the head's shape ---- */

  /** Point-in-closed-mesh by ray parity along +x, +y and +z (majority), each ray tested against the triangles of
   *  its grid cell only. */
  const insideTester = (pos, idx) => {
    const N = 48;
    let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < pos.length; i += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], pos[i + k]); hi[k] = Math.max(hi[k], pos[i + k]); }
    const grids = [0, 1, 2].map((axis) => {
      const [u, v] = [(axis + 1) % 3, (axis + 2) % 3];
      const cells = Array.from({ length: N * N }, () => []);
      const cu = (x) => Math.min(N - 1, Math.max(0, Math.floor(((x - lo[u]) / (hi[u] - lo[u] || 1)) * N)));
      const cv = (x) => Math.min(N - 1, Math.max(0, Math.floor(((x - lo[v]) / (hi[v] - lo[v] || 1)) * N)));
      for (let t = 0; t < idx.length; t += 3) {
        const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
        const u0 = cu(Math.min(pos[a + u], pos[b + u], pos[c + u])), u1 = cu(Math.max(pos[a + u], pos[b + u], pos[c + u]));
        const v0 = cv(Math.min(pos[a + v], pos[b + v], pos[c + v])), v1 = cv(Math.max(pos[a + v], pos[b + v], pos[c + v]));
        for (let i = u0; i <= u1; i++) for (let j = v0; j <= v1; j++) cells[i * N + j].push(t);
      }
      return { axis, u, v, cells, cu, cv };
    });
    const crosses = (g, p) => {
      let n = 0;
      const pu = p[g.u] + 1.3e-7, pv = p[g.v] + 0.7e-7; // off any shared edge
      for (const t of g.cells[g.cu(pu) * N + g.cv(pv)]) {
        const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
        const au = pos[a + g.u] - pu, av = pos[a + g.v] - pv, bu = pos[b + g.u] - pu, bv = pos[b + g.v] - pv, cu_ = pos[c + g.u] - pu, cv_ = pos[c + g.v] - pv;
        const d1 = au * bv - av * bu, d2 = bu * cv_ - bv * cu_, d3 = cu_ * av - cv_ * au;
        if (!((d1 > 0 && d2 > 0 && d3 > 0) || (d1 < 0 && d2 < 0 && d3 < 0))) continue;
        // Where the ray meets the triangle's plane along the axis (barycentric weights of the 2D test).
        const w = d1 + d2 + d3;
        const hit = (d2 * pos[a + g.axis] + d3 * pos[b + g.axis] + d1 * pos[c + g.axis]) / w;
        if (hit > p[g.axis]) n++;
      }
      return n % 2 === 1;
    };
    return {
      inside: (p) => {
        if (p[0] < lo[0] || p[0] > hi[0] || p[1] < lo[1] || p[1] > hi[1] || p[2] < lo[2] || p[2] > hi[2]) return false;
        return grids.reduce((k, g) => k + (crosses(g, p) ? 1 : 0), 0) >= 2;
      },
    };
  };
  /** Distance from a point to a triangle mesh (closest point on its triangles, Ericson 5.1.5), with a hash grid. */
  const distanceTester = (pos, idx, cell = 0.04) => {
    const map = new Map();
    const key = (x, y, z) => `${x},${y},${z}`;
    for (let t = 0; t < idx.length; t += 3) {
      const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
      const lo = [0, 1, 2].map((k) => Math.floor(Math.min(pos[a + k], pos[b + k], pos[c + k]) / cell));
      const hi = [0, 1, 2].map((k) => Math.floor(Math.max(pos[a + k], pos[b + k], pos[c + k]) / cell));
      for (let x = lo[0]; x <= hi[0]; x++) for (let y = lo[1]; y <= hi[1]; y++) for (let z = lo[2]; z <= hi[2]; z++) {
        const k = key(x, y, z);
        (map.get(k) ?? map.set(k, []).get(k)).push(t);
      }
    }
    const sub = (u, v) => [u[0] - v[0], u[1] - v[1], u[2] - v[2]];
    const dot = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
    const at = (i) => [pos[i], pos[i + 1], pos[i + 2]];
    const closest = (p, a, b, c) => {
      const ab = sub(b, a), ac = sub(c, a), ap = sub(p, a);
      const d1 = dot(ab, ap), d2 = dot(ac, ap);
      if (d1 <= 0 && d2 <= 0) return a;
      const bp = sub(p, b), d3 = dot(ab, bp), d4 = dot(ac, bp);
      if (d3 >= 0 && d4 <= d3) return b;
      const vc = d1 * d4 - d3 * d2;
      if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); return [a[0] + v * ab[0], a[1] + v * ab[1], a[2] + v * ab[2]]; }
      const cp = sub(p, c), d5 = dot(ab, cp), d6 = dot(ac, cp);
      if (d6 >= 0 && d5 <= d6) return c;
      const vb = d5 * d2 - d1 * d6;
      if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); return [a[0] + w * ac[0], a[1] + w * ac[1], a[2] + w * ac[2]]; }
      const va = d3 * d6 - d5 * d4;
      if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { const w = (d4 - d3) / (d4 - d3 + (d5 - d6)); return [b[0] + w * (c[0] - b[0]), b[1] + w * (c[1] - b[1]), b[2] + w * (c[2] - b[2])]; }
      const den = 1 / (va + vb + vc), v = vb * den, w = vc * den;
      return [a[0] + ab[0] * v + ac[0] * w, a[1] + ab[1] * v + ac[1] * w, a[2] + ab[2] * v + ac[2] * w];
    };
    return (p) => {
      let best = Infinity;
      const cx = Math.floor(p[0] / cell), cy = Math.floor(p[1] / cell), cz = Math.floor(p[2] / cell);
      for (let r = 0; r <= 6 && best > r * cell; r++) {
        const seen = new Set();
        for (let x = cx - r; x <= cx + r; x++) for (let y = cy - r; y <= cy + r; y++) for (let z = cz - r; z <= cz + r; z++) {
          if (Math.max(Math.abs(x - cx), Math.abs(y - cy), Math.abs(z - cz)) !== r) continue;
          for (const t of map.get(key(x, y, z)) ?? []) {
            if (seen.has(t)) continue;
            seen.add(t);
            const q = closest(p, at(idx[t] * 3), at(idx[t + 1] * 3), at(idx[t + 2] * 3));
            best = Math.min(best, Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]));
          }
        }
      }
      return best;
    };
  };

  /** How far a point set is from a rigid copy of another (best rotation + translation, Horn's quaternion method):
   *  the shape change with the motion taken out. Returns per-point residuals (m). */
  const rigidResidual = (A, B) => {
    const n = A.length / 3;
    const ca = [0, 0, 0], cb = [0, 0, 0];
    for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) { ca[k] += A[i * 3 + k] / n; cb[k] += B[i * 3 + k] / n; }
    const S = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (let i = 0; i < n; i++) for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) S[r][c] += (A[i * 3 + r] - ca[r]) * (B[i * 3 + c] - cb[c]);
    const [[xx, xy, xz], [yx, yy, yz], [zx, zy, zz]] = S;
    const N = [
      [xx + yy + zz, yz - zy, zx - xz, xy - yx],
      [yz - zy, xx - yy - zz, xy + yx, zx + xz],
      [zx - xz, xy + yx, -xx + yy - zz, yz + zy],
      [xy - yx, zx + xz, yz + zy, -xx - yy + zz],
    ];
    // Jacobi eigen-decomposition of the symmetric 4×4.
    const V = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
    for (let sweep = 0; sweep < 30; sweep++) {
      for (let p = 0; p < 3; p++) for (let q = p + 1; q < 4; q++) {
        if (Math.abs(N[p][q]) < 1e-15) continue;
        const th = (N[q][q] - N[p][p]) / (2 * N[p][q]);
        const t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1));
        const c = 1 / Math.sqrt(t * t + 1), s_ = t * c;
        for (let k = 0; k < 4; k++) { const a = N[k][p], b = N[k][q]; N[k][p] = c * a - s_ * b; N[k][q] = s_ * a + c * b; }
        for (let k = 0; k < 4; k++) { const a = N[p][k], b = N[q][k]; N[p][k] = c * a - s_ * b; N[q][k] = s_ * a + c * b; }
        for (let k = 0; k < 4; k++) { const a = V[k][p], b = V[k][q]; V[k][p] = c * a - s_ * b; V[k][q] = s_ * a + c * b; }
      }
    }
    let best = 0;
    for (let k = 1; k < 4; k++) if (N[k][k] > N[best][best]) best = k;
    const [w, x, y, z] = [V[0][best], V[1][best], V[2][best], V[3][best]];
    const R = [
      [w * w + x * x - y * y - z * z, 2 * (x * y - w * z), 2 * (x * z + w * y)],
      [2 * (x * y + w * z), w * w - x * x + y * y - z * z, 2 * (y * z - w * x)],
      [2 * (x * z - w * y), 2 * (y * z + w * x), w * w - x * x - y * y + z * z],
    ];
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const a = [A[i * 3] - ca[0], A[i * 3 + 1] - ca[1], A[i * 3 + 2] - ca[2]];
      let d = 0;
      for (let r = 0; r < 3; r++) d += (R[r][0] * a[0] + R[r][1] * a[1] + R[r][2] * a[2] + cb[r] - B[i * 3 + r]) ** 2;
      out[i] = Math.sqrt(d);
    }
    return out;
  };
  const REGION_NAMES = ["belly", "body", "head", "arm", "hand", "leg", "foot"];
  /** This frame: limb vertices inside the Body that were outside it at rest (count and depth per region), and how
   *  far the head's vertices are from their rest shape once the head bone's motion is taken out. */
  e2e.penetration = (tol = 0.01) => {
    const n = window.__naiwa;
    const spec = n?.character?.spec;
    if (!spec || !n.sim?.readLimbs || !spec.limbs?.length) return null;
    if (!e2e.restInside) {
      const rest = insideTester(spec.body.positions, spec.body.indices);
      e2e.restInside = spec.limbs.map((l) => {
        const out = new Uint8Array(l.positions.length / 3);
        for (let i = 0; i < out.length; i++) out[i] = rest.inside([l.positions[i * 3], l.positions[i * 3 + 1], l.positions[i * 3 + 2]]) ? 1 : 0;
        return out;
      });
    }
    const body = n.sim.readBody();
    const limbs = new Map();
    n.sim.readLimbs(limbs);
    // Non-finite positions (a simulation that blew up): count them instead of measuring.
    const bad = (a) => { let k = 0; for (const v of a) if (!Number.isFinite(v)) k++; return k / 3; };
    const nonFinite = { body: bad(body) };
    for (const [k, v] of limbs) if (bad(v)) nonFinite[k] = bad(v);
    if (Object.values(nonFinite).some((x) => x > 0)) return { per: {}, head: null, nonFinite };
    const tester = insideTester(body, spec.body.indices);
    const dist = distanceTester(body, spec.body.indices);
    const per = {};
    spec.limbs.forEach((l, li) => {
      const p = limbs.get(l.name);
      if (!p) return;
      for (let i = 0; i < p.length / 3; i++) {
        const region = REGION_NAMES[l.regions?.[i] ?? 3] ?? "arm";
        const r = (per[region] ??= { vertices: 0, inside: 0, deep: 0, maxDepth: 0 });
        r.vertices++;
        if (e2e.restInside[li][i]) continue;
        const q = [p[i * 3], p[i * 3 + 1], p[i * 3 + 2]];
        if (!tester.inside(q)) continue;
        const depth = dist(q);
        r.inside++;
        if (depth > tol) r.deep++;
        r.maxDepth = Math.max(r.maxDepth, depth);
      }
    });
    // Head shape: the head's vertices against their rest shape, best rigid fit taken out.
    let head = null;
    const regions = spec.body.regions;
    if (regions) {
      const ids = [];
      for (let i = 0; i < regions.length; i++) if (regions[i] === 2) ids.push(i);
      const A = new Float64Array(ids.length * 3), B = new Float64Array(ids.length * 3);
      ids.forEach((v, j) => { for (let k = 0; k < 3; k++) { A[j * 3 + k] = spec.body.positions[v * 3 + k]; B[j * 3 + k] = body[v * 3 + k]; } });
      const d = Array.from(rigidResidual(A, B)).sort((x, y) => x - y);
      head = { vertices: d.length, rms: Math.sqrt(d.reduce((s2, x) => s2 + x * x, 0) / d.length), p95: d[Math.floor(d.length * 0.95)], max: d[d.length - 1] };
    }
    return { per, head };
  };

  /** The simulation's own quality numbers (docs/soft-binding.md) when it exposes them. */
  e2e.simMetrics = () => {
    const sim = window.__naiwa?.sim;
    const m = sim?.metrics?.() ?? sim?.quality?.() ?? null;
    if (m) return m;
    const st = sim?.stats?.();
    if (!st) return null;
    const keys = ["deviation", "deviationMax", "invertedCells", "volume", "penetration", "jitter"];
    return keys.some((k) => k in st) ? Object.fromEntries(keys.filter((k) => k in st).map((k) => [k, st[k]])) : null;
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

  /** The head bone's height (m) as rendered and in the rest pose, and the hips' ground position: does it stand? */
  e2e.stance = () => {
    const n = window.__naiwa;
    const bones = n?.character?.rig?.bones;
    const head = bones?.get("head")?.matrixWorld.elements;
    const hips = bones?.get("hips")?.matrixWorld.elements;
    const rest = n?.character?.spec?.bones.find((b) => b.name === "head")?.restWorld.elements;
    if (!head || !rest || !hips) return null;
    return { head: head[13], rest: rest[13], hips: [hips[12], hips[13], hips[14]], finite: [head[13], hips[12], hips[14]].every(Number.isFinite) };
  };

  /** The UI's floating panels (to see that the frog is framed beside them, not under them). */
  e2e.panelRects = () => [...document.querySelectorAll("#ui .nw-panel")].filter(visible).map(rectOf);

  /** Largest distance (m) any sampled surface vertex is from where it was in a snapshot. */
  e2e.maxDisp = (a, b) => {
    const A = e2e.snaps[a], B = e2e.snaps[b];
    let m = 0;
    for (let i = 0; i < A.length; i += 3) m = Math.max(m, Math.hypot(B[i] - A[i], B[i + 1] - A[i + 1], B[i + 2] - A[i + 2]));
    return m;
  };
  /** The body surface now, then the largest distance any of its vertices gets from there over `ms` (every frame,
   *  every vertex: a poke's dent is local). */
  e2e.peakDisp = async (ms) => {
    const read = () => window.__naiwa?.sim?.readBody();
    const a = read() && Float32Array.from(read());
    if (!a) return null;
    let m = 0;
    const t0 = performance.now();
    while (performance.now() - t0 < ms) {
      await new Promise((r) => raf(r));
      const b = read();
      if (b.length !== a.length) return null;
      for (let i = 0; i < a.length; i += 3) m = Math.max(m, Math.hypot(b[i] - a[i], b[i + 1] - a[i + 1], b[i + 2] - a[i + 2]));
    }
    return m;
  };

  /** The tongue (MouthInside vertices coloured tongue-red) against the rendered Body surface: for each tongue vertex
   *  the distance to the nearest Body vertex (m). A tongue left behind when the head moves shows as a large gap. */
  e2e.tongueGap = () => {
    const obj = window.__naiwa?.character?.object;
    const mouth = obj?.getObjectByName("MouthInside");
    const body = obj?.getObjectByName("Body");
    const col = mouth?.geometry?.attributes?.color;
    if (!mouth?.getVertexPosition || !body || !col) return null;
    const V = window.__naiwa.stage.camera.position.constructor;
    const tongue = [];
    for (let i = 0; i < col.count; i++) if (col.getX(i) > 0.35 && col.getX(i) > 1.8 * col.getY(i)) tongue.push(i);
    if (!tongue.length) return { vertices: 0 };
    mouth.updateMatrixWorld(true);
    body.updateMatrixWorld(true);
    // The Body's positions are the simulated surface; read them as rendered (world).
    const bp = body.geometry.attributes.position;
    const bw = new Float32Array(bp.count * 3);
    const v = new V();
    for (let j = 0; j < bp.count; j++) {
      body.getVertexPosition ? body.getVertexPosition(j, v) : v.fromBufferAttribute(bp, j);
      v.applyMatrix4(body.matrixWorld);
      bw[j * 3] = v.x; bw[j * 3 + 1] = v.y; bw[j * 3 + 2] = v.z;
    }
    let max = 0, sum = 0;
    for (const i of tongue) {
      mouth.getVertexPosition(i, v).applyMatrix4(mouth.matrixWorld);
      let d = Infinity;
      for (let j = 0; j < bp.count; j++) d = Math.min(d, (bw[j * 3] - v.x) ** 2 + (bw[j * 3 + 1] - v.y) ** 2 + (bw[j * 3 + 2] - v.z) ** 2);
      d = Math.sqrt(d);
      max = Math.max(max, d);
      sum += d;
    }
    return { vertices: tongue.length, max, mean: sum / tongue.length };
  };

  /** Each foot's heel (ankle) and toe (the foot bone's tail) as rendered, every frame for `ms`: how fast each moves
   *  sideways while it is down on the floor (within 1.5 cm of its rest-pose height). */
  e2e.footSlide = async (ms) => {
    const n = window.__naiwa;
    const bones = n?.character?.rig?.bones;
    if (!bones?.get("foot_L")) return null;
    const V = n.stage.camera.position.constructor;
    const feet = ["foot_L", "foot_R"].map((k) => {
      const b = n.character.spec.bones.find((x) => x.name === k);
      // the toe in the foot bone's own frame; heel and toe heights in the rest pose (standing on the floor)
      const heelRest = new V().setFromMatrixPosition(b.restWorld).y;
      return { k, toe: b.tail.clone().applyMatrix4(b.restWorld.clone().invert()), rest: [heelRest, b.tail.y], s: [] };
    });
    const t0 = performance.now();
    while (performance.now() - t0 < ms) {
      await new Promise((r) => raf(r));
      const t = performance.now();
      for (const f of feet) {
        const m = bones.get(f.k).matrixWorld;
        const ankle = new V().setFromMatrixPosition(m), toe = f.toe.clone().applyMatrix4(m);
        f.s.push([t, ankle.x, ankle.y, ankle.z, toe.x, toe.y, toe.z]);
      }
    }
    // The heel (ankle) and the toe each count while they are down, so a foot rolling over its toe does not slide.
    // Each stretch of contact counts by how far the point ends up from where it touched down (not the frame-to-frame
    // path, which would count the flesh's jitter as sliding).
    // A point is down while it is within 1.5 cm of its height in the rest pose, i.e. on the floor (a foot hovering a
    // couple of centimetres up is not standing).
    let dist = 0, time = 0;
    for (const { s, rest } of feet) for (const [o, floor] of [[1, rest[0]], [4, rest[1]]]) {
      const down = (i) => s[i][o + 1] <= floor + 0.015;
      for (let i = 0; i < s.length; ) {
        if (!down(i)) { i++; continue; }
        let j = i;
        while (j + 1 < s.length && down(j + 1)) j++;
        if (j > i) {
          dist += Math.hypot(s[j][o] - s[i][o], s[j][o + 2] - s[i][o + 2]);
          time += (s[j][0] - s[i][0]) / 1000;
        }
        i = j + 1;
      }
    }
    return { speed: time ? dist / time : 0, standing: time / 4 / (ms / 1000) };
  };

  /** The frog's surface speed over one stretch of the playing video, video time a → b (waits for the video to reach
   *  a, then 100 ms snapshots until it passes b): the same content at any playback speed, so speeds compare. */
  e2e.surfaceOverVideo = async (a, b, timeoutMs = 30000) => {
    const v = [...e2e.routed].reverse().find((x) => x.isConnected && x.currentSrc) ?? e2e.playingVideo();
    if (!v) return null;
    const t0 = performance.now();
    while (!(v.currentTime >= a && v.currentTime < a + 0.15)) {
      if (performance.now() - t0 > timeoutMs) return null;
      await new Promise((r) => raf(r));
    }
    const start = performance.now(), vt0 = v.currentTime;
    let path = 0, n = 0, last = start;
    e2e.snap("ov0");
    while (v.currentTime < b && v.currentTime >= vt0 - 0.01) {
      await new Promise((r) => raf(r));
      if (performance.now() - last < 100) continue;
      last = performance.now();
      e2e.snap(`ov${(n + 1) % 2}`);
      path += e2e.delta(`ov${n % 2}`, `ov${(n + 1) % 2}`);
      n++;
      if (performance.now() - start > timeoutMs) return null;
    }
    const wall = (last - start) / 1000;
    return { speed: path / wall, path, wall, vt0, vt1: v.currentTime };
  };

  /** The newest recorded video blob, as base64 (the Blob is kept, so a revoked URL does not matter). */
  e2e.lastVideoBlob = async () => {
    const rec = window.__naiwa?.store?.get().lastRecording;
    const b = rec?.blob ? { blob: rec.blob, type: rec.blob.type || rec.mimeType, size: rec.blob.size } : [...e2e.blobs].reverse().find((x) => /^video\//.test(x.type) && x.blob && x.size > 1024);
    if (!b) return null;
    const data = await new Promise((resolve) => {
      const fr = new FileReader();
      // after "base64,": the type itself may hold commas (video/mp4;codecs=avc1.4d0020,mp4a.40.2)
      fr.onload = () => { const s = String(fr.result); resolve(s.slice(s.indexOf(";base64,") + 8)); };
      fr.readAsDataURL(b.blob);
    });
    return { type: b.type, size: b.size, data };
  };
})();
