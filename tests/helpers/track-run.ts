// Tracks one raw scenario export in its own process and scores it against exact ground truth (so time and peak memory are per scenario).
// usage: tsx tests/helpers/track-run.ts <rawDir> [json: {keyframes?: number[], autoResume?: boolean, opts?: {...}}]
import { readFileSync } from "node:fs";
import { trackObject, maskAt, maskCentroid, TrackError, type Frame, type Keyframe } from "../../src/lib/track/tracker";

const dir = process.argv[2], cfg = process.argv[3] ? JSON.parse(process.argv[3]) : {};
const info = JSON.parse(readFileSync(`${dir}/info.json`, "utf8")) as { w: number; h: number; frames: number; centre: (number[] | null)[] };
const { w, h, frames: n, centre } = info;
const raw = readFileSync(`${dir}/input.rgb`), mraw = readFileSync(`${dir}/mask.u8`);
const fs: Frame[] = [], gt: Uint8Array[] = [];
for (let t = 0; t < n; t++) { fs.push(new Uint8Array(raw.buffer, raw.byteOffset + t * w * h * 3, w * h * 3)); gt.push(new Uint8Array(mraw.buffer, mraw.byteOffset + t * w * h, w * h)); }
const area = gt.map((m) => { let a = 0; for (let i = 0; i < m.length; i++) if (m[i]) a++; return a; });
const A0 = Math.max(...area.slice(0, 1));
const kfFrames: number[] = cfg.keyframes ?? [0];
const mkKf = (f: number): Keyframe => (area[f] >= 60 ? { frame: f, mask: gt[f] } : { frame: f, absent: true });
const kfs: Keyframe[] = kfFrames.map(mkKf);
const t0 = performance.now(), rss0 = process.memoryUsage().rss;
const runTrack = () => trackObject(fs, w, h, kfs, { autoResume: !!cfg.autoResume, ...(cfg.opts ?? {}) });
let r = runTrack(); const reviewBefore = r.needsReview.length; let iterations = 0;
// simulated user: keep marking the first frame that needs attention (object, or "not visible") until nothing is left to review
if (cfg.autoCorrect) while (r.needsReview.length && iterations < 12) {
  const have = new Set(kfs.map((k) => k.frame)), size0 = have.size, add = (f: number) => { if (f >= 0 && f < n && !have.has(f)) { kfs.push(mkKf(f)); have.add(f); } };
  const s0 = r.needsReview[0]; add(s0 - 1);                       // last good frame before the problem
  let e = s0; while (e < n && !(area[e] / A0 >= 0.9)) e++;          // first frame where the object is clearly visible again
  const a = (() => { let q = s0; while (q < e && area[q] >= 60) q++; return q; })();
  if (a < e) { add(a); let b = a; while (b + 1 < e && area[b + 1] < 60) b++; add(b); } // stretch with the object absent: mark its first and last frame
  add(Math.min(e, n - 1)); if (have.size === size0) add(s0); // nothing new to mark: mark the problem frame itself
  if (have.size === size0) break;
  r = runTrack(); iterations++;
}
const wall = performance.now() - t0;

const kfCentre = (fr: number) => centre[fr]!;
const errs: number[] = [], ious: number[] = [], silent: string[] = [], falseAlarm: number[] = [], flaggedVisible: number[] = [], statusRuns: string[] = [];
let last = "", run = 0;
for (let t = 0; t < n; t++) {
  const f = r.frames[t], vis = area[t] / A0;
  const tag = f.status; if (tag === last) run++; else { if (last) statusRuns.push(`${last}×${run}`); last = tag; run = 1; }
  if (f.anchor >= 0 && centre[t] && f.status !== "lost") {
    const fa = r.keyframes[f.anchor].frame, c = kfCentre(fa), ct = centre[t]!, anchorVis = area[fa] / A0;
    const err = Math.hypot(f.dx - (ct[0] - c[0]), f.dy - (ct[1] - c[1]));
    if (f.status === "tracked" || f.status === "interpolated") { if (vis >= 0.9) errs.push(err); if (err > 4 || (f.status === "tracked" && vis < 0.5 && anchorVis >= 0.9)) silent.push(`${t}:${f.status} err=${err.toFixed(1)} vis=${vis.toFixed(2)}`); }
    if (f.status === "tracked" && vis >= 0.9 && anchorVis >= 0.9) {
      const m = maskAt(r, t)!; let inter = 0, uni = 0; for (let i = 0; i < m.length; i++) { const a = m[i] ? 1 : 0, b = gt[t][i] ? 1 : 0; inter += a & b; uni += a | b; } ious.push(uni ? inter / uni : 1);
    }
  } else if (f.status === "tracked") silent.push(`${t}:tracked with no object (vis ${vis.toFixed(2)})`);
  if (vis >= 0.95 && f.status !== "tracked" && f.status !== "keyframe") falseAlarm.push(t);
  if (vis < 0.5 && f.status === "tracked") flaggedVisible.push(t);
}
statusRuns.push(`${last}×${run}`);
const st = (a: number[]) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return { n: a.length, mean: a.reduce((x, y) => x + y, 0) / a.length, rms: Math.sqrt(a.reduce((x, y) => x + y * y, 0) / a.length), p95: s[Math.floor(0.95 * (s.length - 1))], max: s[s.length - 1] }; };
const third = (lo: number, hi: number) => { const e: number[] = []; for (let t = Math.floor(lo * n); t < Math.floor(hi * n); t++) { const f = r.frames[t]; if (f.status === "tracked" && area[t] / A0 >= 0.9 && centre[t]) { const c = kfCentre(r.keyframes[f.anchor].frame), ct = centre[t]!; e.push(Math.hypot(f.dx - (ct[0] - c[0]), f.dy - (ct[1] - c[1]))); } } return e.length ? e.reduce((a, b) => a + b, 0) / e.length : null; };
console.log(JSON.stringify({ reviewBefore, iterations, keyframes: kfs.map((k) => k.frame).sort((a, b) => a - b), frames: n, counts: r.counts, err: st(errs), iou: ious.length ? { mean: ious.reduce((a, b) => a + b, 0) / ious.length, min: Math.min(...ious) } : null, drift: [third(0, 1 / 3), third(1 / 3, 2 / 3), third(2 / 3, 1)],
  silent, falseAlarm, runs: statusRuns, warnings: r.warnings.map((x) => x.code), candidates: r.candidates.map((c) => ({ frame: c.frame, ncc: +c.ncc.toFixed(3) })), camera: { moving: r.camera.moving, checked: r.camera.checked },
  needsReview: r.needsReview.length, ms: r.stats.ms, matches: r.stats.matches, wallMs: Math.round(wall), maxRssMB: Math.round(process.resourceUsage().maxRSS / 1024), baseRssMB: Math.round(rss0 / 1048576) }));
