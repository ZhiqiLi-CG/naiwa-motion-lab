// The two hosts' header rules (Cloudflare Pages `_headers`, Vercel `vercel.json`), the content types the hosts give
// by extension, and the static checks of a build: what it must contain, what it must not load, how it is cached.
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, extname } from "node:path";

export const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".task": "application/octet-stream",
  ".bin": "application/octet-stream",
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".webm": "video/webm",
  ".mp4": "video/mp4",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

const escapeRe = (s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");

/** Cloudflare `_headers`: blocks of a URL pattern (one `*` splat, `:name` placeholders) and indented headers. */
export function parseCloudflareHeaders(text) {
  const rules = [];
  for (const line of text.split("\n")) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    if (!/^\s/.test(line)) {
      const pattern = line.trim();
      const re = "^" + pattern.split("*").map((p) => escapeRe(p).replace(/:\w+/g, "[^/]+")).join(".*") + "$";
      rules.push({ pattern, re: new RegExp(re), headers: [] });
    } else {
      const m = /^\s+(!\s*)?([^:]+?)\s*(?::\s*(.*))?$/.exec(line);
      if (!m || !rules.length) throw new Error(`_headers: cannot read line "${line}"`);
      rules.at(-1).headers.push({ key: m[2], value: m[3] ?? "", remove: !!m[1] });
    }
  }
  return rules;
}

/** Vercel `headers[].source` (path-to-regexp): `(regex)` groups and `:name`, `:name*` parameters. */
function vercelSourceRe(source) {
  let out = "^", i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === "(") {
      let depth = 0, j = i;
      for (; j < source.length; j++) {
        if (source[j] === "(") depth++;
        else if (source[j] === ")" && --depth === 0) break;
      }
      out += source.slice(i, j + 1);
      i = j + 1;
    } else if (ch === ":") {
      const m = /^:(\w+)([*+?])?/.exec(source.slice(i));
      out += m[2] === "*" ? "(.*)" : m[2] === "+" ? "(.+)" : m[2] === "?" ? "([^/]*)" : "([^/]+)";
      i += m[0].length;
    } else {
      out += escapeRe(ch);
      i++;
    }
  }
  return new RegExp(out + "$");
}

export function parseVercelHeaders(json) {
  return (json.headers ?? []).map((h) => ({ pattern: h.source, re: vercelSourceRe(h.source), headers: h.headers }));
}

/** Headers the rules give a URL path; `dup` lists header names set by more than one matching rule. */
export function headersFor(rules, path) {
  const out = {}, seen = {}, dup = [];
  for (const r of rules) {
    if (!r.re.test(path)) continue;
    for (const h of r.headers) {
      const k = h.key.toLowerCase();
      if (h.remove) { delete out[k]; continue; }
      if (seen[k]) dup.push(k);
      seen[k] = true;
      out[k] = out[k] ? `${out[k]}, ${h.value}` : h.value;
    }
  }
  return { headers: out, dup };
}

export function loadHeaderRules(root) {
  const cf = parseCloudflareHeaders(readFileSync(join(root, "public/_headers"), "utf8"));
  const vc = parseVercelHeaders(JSON.parse(readFileSync(join(root, "vercel.json"), "utf8")));
  return { cf, vc };
}

export function listFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const s = statSync(p);
      if (s.isDirectory()) walk(p);
      else out.push({ path: "/" + relative(dir, p).split("\\").join("/"), abs: p, size: s.size });
    }
  };
  walk(dir);
  return out;
}

const GOOGLE = /(^|\.)(google|googleapis|gstatic|googleusercontent|googletagmanager|google-analytics|doubleclick|ggpht|youtube|ytimg)\.(com|cn)$/;
const CDN = /(^|\.)(jsdelivr\.net|unpkg\.com|cdnjs\.cloudflare\.com|esm\.sh|skypack\.dev|jspm\.io|fonts\.bunny\.net)$/;
export const isGoogleHost = (h) => GOOGLE.test(h);
const GOOGLE_ASSETS = /(^|\.)(googleapis|gstatic|googleusercontent|googletagmanager|google-analytics|doubleclick|ggpht|ytimg)\.(com|cn)$/;
const isGoogleAssetHost = (h) => GOOGLE_ASSETS.test(h);
export const isCdnHost = (h) => CDN.test(h);
/** Usage logging built into @mediapipe/tasks-vision (posted every 60 s and when a task closes); the runtime network
 *  check decides whether the app lets it out. */
export const MEDIAPIPE_TELEMETRY = "odml.pa.googleapis.com";

/** Hosts named in URLs inside the built code and stylesheets. */
export function externalUrls(files) {
  const hits = [];
  for (const f of files) {
    if (![".js", ".mjs", ".css", ".html", ".json", ".webmanifest"].includes(extname(f.path))) continue;
    const text = readFileSync(f.abs, "utf8");
    for (const m of text.matchAll(/https?:\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)+)[^\s"'`)<>\\]*/gi)) {
      hits.push({ file: f.path, host: m[1].toLowerCase(), url: m[0].slice(0, 120) });
    }
  }
  return hits;
}

/** Static checks of a build in `dist` (a list of {name, status, detail}). */
export function checkBuild(root, dist) {
  const results = [];
  const add = (name, status, detail, data) => results.push({ name, status, detail, data });
  const files = listFiles(dist);
  const byPath = new Map(files.map((f) => [f.path, f]));

  // Self-hosted runtime files: whatever public/ provides must be in the build, and whatever the code names must exist.
  const code = files.filter((f) => /^\/assets\/.*\.(js|mjs)$/.test(f.path)).map((f) => readFileSync(f.abs, "utf8")).join("\n");
  const publicFiles = existsSync(join(root, "public")) ? listFiles(join(root, "public")) : [];
  const notCopied = publicFiles.filter((f) => !byPath.has(f.path)).map((f) => f.path);
  add("build: public/ files in the build", notCopied.length ? "FAIL" : "PASS",
    notCopied.length ? `missing from the build: ${notCopied.join(", ")}` : `${publicFiles.length} files copied`);

  const needs = [
    { what: "MediaPipe wasm (SIMD)", path: "/mediapipe/wasm/vision_wasm_internal.wasm" },
    { what: "MediaPipe wasm loader (SIMD)", path: "/mediapipe/wasm/vision_wasm_internal.js" },
    { what: "MediaPipe wasm (no SIMD)", path: "/mediapipe/wasm/vision_wasm_nosimd_internal.wasm" },
    { what: "MediaPipe wasm loader (no SIMD)", path: "/mediapipe/wasm/vision_wasm_nosimd_internal.js" },
    { what: "frog model", path: "/models/naiwa.glb" },
  ];
  const usesMediapipe = /PoseLandmarker|FilesetResolver|vision_wasm/.test(code);
  const usesGlb = /naiwa\.glb/.test(code);
  for (const n of needs) {
    const used = n.path.startsWith("/mediapipe") ? usesMediapipe : usesGlb;
    const f = byPath.get(n.path);
    if (f) add(`build: ${n.what}`, "PASS", `${n.path} (${mb(f.size)})`);
    else if (!used) add(`build: ${n.what}`, "MISSING", `${n.path} not in the build and not used by the code yet`);
    else add(`build: ${n.what}`, "FAIL", `the code uses it but ${n.path} is not in the build`);
  }
  // The model's name may be put together at run time (lite on phones, full elsewhere): every variant the code
  // could name must be built; which one a page really loads is checked in the browser.
  const variants = [...new Set([...code.matchAll(/pose_landmarker_(lite|full|heavy)\.task/g)].map((m) => m[1]))];
  if (/pose_landmarker_\$\{/.test(code)) for (const v of ["lite", "full", "heavy"]) if (code.includes(`"${v}"`) && !variants.includes(v)) variants.push(v);
  const built = files.filter((f) => /\/pose_landmarker_\w+\.task$/.test(f.path));
  if (!usesMediapipe) add("build: pose model", "MISSING", "no MediaPipe code in the bundle yet");
  else if (!built.length) add("build: pose model", "FAIL", "the bundle uses MediaPipe but the build has no pose_landmarker_*.task");
  else {
    const absent = variants.filter((v) => !built.some((f) => f.path.endsWith(`pose_landmarker_${v}.task`)));
    add("build: pose model", absent.length ? "FAIL" : "PASS",
      absent.length ? `the code can ask for pose_landmarker_${absent.join("/")}.task, not in the build` : built.map((f) => `${f.path} (${mb(f.size)})`).join(", "));
  }
  const usesDances = /dances\/index\.json/.test(code);
  if (usesDances) {
    const idx = byPath.get("/dances/index.json");
    if (!idx) add("build: dance tracks", "FAIL", "the code loads dances/index.json but it is not in the build");
    else {
      const list = JSON.parse(readFileSync(idx.abs, "utf8"));
      const absent = (Array.isArray(list) ? list : list.dances ?? []).map((d) => d.file).filter((p) => p && !byPath.has("/" + p.replace(/^\.?\//, "")));
      add("build: dance tracks", absent.length ? "FAIL" : "PASS", absent.length ? `listed but missing: ${absent.join(", ")}` : `index.json lists ${Array.isArray(list) ? list.length : "?"} tracks`);
    }
  }

  // Nothing from Google or a public CDN.
  const hits = externalUrls(files);
  // Credit links (a dance's YouTube source) are for people to click, not loads; asset hosts are what must not appear.
  const bad = hits.filter((h) => (isGoogleAssetHost(h.host) || isCdnHost(h.host)) && h.host !== MEDIAPIPE_TELEMETRY);
  const telemetry = hits.filter((h) => h.host === MEDIAPIPE_TELEMETRY);
  add("build: no Google/CDN URLs in the bundle", bad.length ? "FAIL" : "PASS",
    bad.length ? bad.map((h) => `${h.file}: ${h.url}`).join("; ") : `${hits.length} URLs in strings, none to a Google asset host or a CDN` +
      (telemetry.length ? ` (except MediaPipe's built-in usage logging to ${MEDIAPIPE_TELEMETRY}, checked at runtime)` : ""),
    { hosts: [...new Set(hits.map((h) => h.host))] });

  // Host limits: Cloudflare Pages serves files up to 25 MiB.
  const big = files.filter((f) => f.size > 25 * 1024 * 1024);
  add("build: every file within Cloudflare's 25 MiB", big.length ? "FAIL" : "PASS",
    big.length ? big.map((f) => `${f.path} ${mb(f.size)}`).join(", ") : `largest ${[...files].sort((a, b) => b.size - a.size).slice(0, 3).map((f) => `${f.path} ${mb(f.size)}`).join(", ")}; total ${mb(files.reduce((s, f) => s + f.size, 0))}`);

  // Caching: both hosts agree, hashed bundles immutable, big unhashed files revalidated, the page never stale.
  const { cf, vc } = loadHeaderRules(root);
  const problems = [];
  const paths = [...files.map((f) => f.path), "/"];
  for (const p of paths) {
    const a = headersFor(cf, p), b = headersFor(vc, p);
    for (const d of new Set([...a.dup, ...b.dup])) if (d === "cache-control") problems.push(`${p}: several rules set Cache-Control`);
    const ca = a.headers["cache-control"] ?? "(host default)", cb = b.headers["cache-control"] ?? "(host default)";
    if (ca !== cb) problems.push(`${p}: Cloudflare "${ca}" vs Vercel "${cb}"`);
    const hashed = /^\/assets\/.+-[A-Za-z0-9_-]{8,}\.\w+$/.test(p);
    if (hashed && !/immutable/.test(ca)) problems.push(`${p}: hashed but not immutable ("${ca}")`);
    if (!hashed && /immutable|max-age=[1-9]/.test(ca)) problems.push(`${p}: unhashed but cached without revalidation ("${ca}")`);
    if ((p === "/" || p === "/index.html") && !/no-cache|max-age=0/.test(ca)) problems.push(`${p}: the page may be served stale ("${ca}")`);
    if (/\.(wasm|task|glb)$/.test(p) && ca === "(host default)") problems.push(`${p}: no cache rule`);
    for (const k of ["cross-origin-opener-policy", "cross-origin-embedder-policy"]) {
      if (a.headers[k] || b.headers[k]) problems.push(`${p}: sets ${k} (not needed: nothing uses SharedArrayBuffer)`);
    }
  }
  add("deploy: Cloudflare and Vercel cache rules", problems.length ? "FAIL" : "PASS",
    problems.length ? problems.slice(0, 12).join("; ") + (problems.length > 12 ? ` … (${problems.length})` : "") : `${paths.length} paths checked against both configs`);
  return { results, files };
}

export const mb = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
