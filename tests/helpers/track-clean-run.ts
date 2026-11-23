// Integration: track an object from ONE mask, refuse unless tracking is fully resolved, then clean with the milestone-2 temporal core.
// usage: tsx tests/helpers/track-clean-run.ts <rawDir> <outFile>
import { readFileSync, writeFileSync } from "node:fs";
import { trackObject, resolveMasks, TrackError, type Frame } from "../../src/lib/track/tracker";
import { reconstructVideo, dilateMask, TemporalError } from "../../src/lib/inpaint/temporal";
const [dir, outFile] = process.argv.slice(2);
const { w, h, frames: n } = JSON.parse(readFileSync(`${dir}/info.json`, "utf8")) as { w: number; h: number; frames: number };
const raw = readFileSync(`${dir}/input.rgb`), mraw = readFileSync(`${dir}/mask.u8`);
const fs: Frame[] = []; for (let t = 0; t < n; t++) fs.push(new Uint8Array(raw.buffer, raw.byteOffset + t * w * h * 3, w * h * 3));
const t0 = performance.now();
try {
  const tr = trackObject(fs, w, h, [{ frame: 0, mask: new Uint8Array(mraw.buffer, mraw.byteOffset, w * h) }], { checkCamera: false });
  const masks = resolveMasks(tr).map((m) => dilateMask(m ?? new Uint8Array(w * h), w, h, 4));
  const r = reconstructVideo(fs, masks, w, h);
  const buf = Buffer.alloc(n * w * h * 3); r.frames.forEach((f, t) => buf.set(f, t * w * h * 3)); writeFileSync(outFile, buf);
  console.log(JSON.stringify({ ok: true, status: r.status, trackMs: Math.round(tr.stats.ms.total), totalMs: Math.round(performance.now() - t0), maxRssMB: Math.round(process.resourceUsage().maxRSS / 1024) }));
} catch (e) {
  if (e instanceof TrackError || e instanceof TemporalError) console.log(JSON.stringify({ ok: false, code: e.code, message: e.message }));
  else throw e;
}
