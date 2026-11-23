// Runs temporal reconstruction on one raw scenario export in its own process (so peak memory is that scenario's alone).
// usage: tsx tests/helpers/temporal-run.ts <rawDir> <outFile|-> [json options]
import { readFileSync, writeFileSync } from "node:fs";
import { reconstructVideo, dilateMask, TemporalError, type Frame, type TemporalOptions } from "../../src/lib/inpaint/temporal";

const [dir, outFile, optJson] = process.argv.slice(2);
const info = JSON.parse(readFileSync(`${dir}/info.json`, "utf8")) as { w: number; h: number; frames: number };
const { w, h, frames: n } = info;
const raw = readFileSync(`${dir}/input.rgb`), mraw = readFileSync(`${dir}/mask.u8`);
const fs: Frame[] = [], ms: Uint8Array[] = [];
for (let t = 0; t < n; t++) {
  fs.push(new Uint8Array(raw.buffer, raw.byteOffset + t * w * h * 3, w * h * 3));
  ms.push(dilateMask(new Uint8Array(mraw.buffer, mraw.byteOffset + t * w * h, w * h), w, h, 2));
}
const opts: TemporalOptions = optJson ? JSON.parse(optJson) : {};
const t0 = performance.now();
const rssBefore = process.memoryUsage().rss;
let res: Record<string, unknown>;
try {
  const r = reconstructVideo(fs, ms, w, h, opts);
  if (outFile !== "-") { const buf = Buffer.alloc(n * w * h * 3); r.frames.forEach((f, t) => buf.set(f, t * w * h * 3)); writeFileSync(outFile, buf); }
  res = { ok: true, status: r.status, warnings: r.warnings.map((x) => x.code), warningText: r.warnings.map((x) => x.message), segments: r.segments,
    minCoverage: Math.min(...r.coverage), stats: r.stats, seeded: r.stats.seeded };
} catch (e) {
  if (!(e instanceof TemporalError)) throw e;
  res = { ok: false, code: e.code, message: e.message, details: e.details };
}
console.log(JSON.stringify({ ...res, wallMs: Math.round(performance.now() - t0), maxRssMB: Math.round(process.resourceUsage().maxRSS / 1024), rssBeforeMB: Math.round(rssBefore / 1048576), frames: n }));
