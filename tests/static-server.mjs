// Static server for dist/ that applies the real public/_headers rules. Used by the UI and live audits.
import http from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { extname, join } from "node:path";
export async function startStatic(root, port) {
  const DIST = join(root, "dist");
  if (!existsSync(DIST)) throw new Error("run npm run build first");
  const hdrText = readFileSync(join(root, "public/_headers"), "utf8");
  const rules = []; let cur = null;
  for (const line of hdrText.split("\n")) {
    if (!line.trim()) continue;
    if (!/^\s/.test(line)) { cur = { pat: line.trim(), h: {} }; rules.push(cur); continue; }
    const i = line.indexOf(":"); cur.h[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".wasm": "application/wasm", ".svg": "image/svg+xml", ".json": "application/json", ".png": "image/png", ".ico": "image/x-icon" };
  const server = http.createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url, "http://x").pathname);
    let f = join(DIST, p);
    if (!f.startsWith(DIST) || !existsSync(f) || statSync(f).isDirectory()) f = join(DIST, "index.html");
    const h = { "Content-Type": MIME[extname(f)] || "application/octet-stream" };
    for (const r of rules) { const re = new RegExp("^" + r.pat.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$"); if (re.test(p)) Object.assign(h, r.h); }
    res.writeHead(200, h); res.end(readFileSync(f));
  });
  await new Promise((r) => server.listen(port, "127.0.0.1", r));
  return { base: `http://127.0.0.1:${port}`, stop: () => server.close() };
}
