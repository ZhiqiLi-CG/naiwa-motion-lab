// Serve a build like the static hosts do: files by path, content types by extension, the build's own `_headers`
// rules, 404.html for anything missing, ETag revalidation.
import { createServer } from "node:http";
import { readFileSync, statSync, existsSync } from "node:fs";
import { join, extname, normalize } from "node:path";
import { createHash } from "node:crypto";
import { MIME, parseCloudflareHeaders, headersFor } from "./deploy.mjs";

/** mounts: extra URL prefixes served from other places (the harness' own pages), e.g. {"/__e2e/": dir}. */
export function serve(dist, port, mounts = {}) {
  const rulesFile = join(dist, "_headers");
  const rules = existsSync(rulesFile) ? parseCloudflareHeaders(readFileSync(rulesFile, "utf8")) : [];
  const served = [];
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
    const mount = Object.keys(mounts).sort((a, b) => b.length - a.length).find((m) => path.startsWith(m));
    // normalised like the file path (on Windows a base given with forward slashes would never match)
    const base = normalize(mount ? mounts[mount] : dist);
    let file = mount ? normalize(join(base, path.slice(mount.length))) : normalize(join(dist, path === "/" ? "index.html" : path));
    let status = 200;
    if (!file.startsWith(base) || !existsSync(file) || statSync(file).isDirectory()) {
      file = join(dist, "404.html");
      status = 404;
    }
    if (!existsSync(file)) {
      res.writeHead(404, { "content-type": "text/plain" }).end("not found");
      served.push({ path, status: 404, size: 0 });
      return;
    }
    const body = readFileSync(file);
    const etag = `"${createHash("sha1").update(body).digest("hex").slice(0, 16)}"`;
    const headers = {
      "content-type": MIME[extname(file).toLowerCase()] ?? "application/octet-stream",
      etag,
      ...(status === 200 ? headersFor(rules, path).headers : {}),
    };
    if (status === 200 && req.headers["if-none-match"] === etag) {
      res.writeHead(304, headers).end();
      served.push({ path, status: 304, size: 0 });
      return;
    }
    res.writeHead(status, { ...headers, "content-length": body.length });
    res.end(req.method === "HEAD" ? undefined : body);
    served.push({ path, status, size: body.length });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve({ server, served, url: `http://127.0.0.1:${port}/`, close: () => new Promise((r) => server.close(r)) }));
  });
}
