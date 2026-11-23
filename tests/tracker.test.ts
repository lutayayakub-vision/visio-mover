/**
 * Stage 2 / Milestone 3 tests: object tracker (src/lib/track/tracker.ts).
 * Part A: the seven M1 ground-truth scenarios, each in its own process (real time + peak memory), scored against exact truth.
 * Part B: controlled synthetic clips (analytic sub-pixel truth) for accuracy, noise, appearance change, occlusion, exit/re-entry,
 *         look-alikes, manual keyframes, interpolation and the "failed tracking is never a result" guarantees.
 *   npx tsx tests/tracker.test.ts      (needs python3 + numpy once, to export the scenario frames)
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { trackObject, resolveMasks, maskAt, shiftMask, maskCentroid, TrackError, type TrackResult, type Keyframe } from "../src/lib/track/tracker";
import { reconstructVideo, dilateMask } from "../src/lib/inpaint/temporal";
import { makeClip, W, H, type Spec } from "./helpers/track-synth";

let pass = 0, fail = 0; const failures: string[] = [];
const check = (name: string, ok: boolean, extra = "") => { if (ok) pass++; else { fail++; failures.push(name); } console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`); };
const sh = (cmd: string, args: string[]) => { const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 1 << 28 }); if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")}\n${r.stderr}`); return r.stdout; };
const RAW = "tests/out/vc-raw";
mkdirSync(RAW, { recursive: true });
if (!existsSync(`${RAW}/long_track/info.json`) || !JSON.parse(readFileSync(`${RAW}/long_track/info.json`, "utf8")).centre) sh("python3", ["tests/video-cleanup/gen.py", "--export-raw", "--out", RAW]);
const f3 = (x: number | undefined | null) => (x == null ? "n/a" : x.toFixed(3));
const bench: Record<string, unknown>[] = [];

// ───────────── Part A: ground-truth scenarios (separate process each) ─────────────
type A = { reviewBefore: number; iterations: number; keyframes: number[]; frames: number; counts: Record<string, number>; err: { n: number; mean: number; rms: number; p95: number; max: number } | null; iou: { mean: number; min: number } | null; drift: (number | null)[]; silent: string[]; falseAlarm: number[]; runs: string[]; warnings: string[]; candidates: { frame: number; ncc: number }[]; camera: { moving: boolean; checked: number }; needsReview: number; ms: Record<string, number>; matches: number; wallMs: number; maxRssMB: number; baseRssMB: number };
const scen = (name: string, cfg: object = {}): A => JSON.parse(sh("npx", ["tsx", "tests/helpers/track-run.ts", `${RAW}/${name}`, JSON.stringify(cfg)]).trim().split("\n").pop()!);

const CLEAN: Array<[string, string, boolean]> = [
  ["long_track", "150-frame figure-8 with sub-pixel motion (drift test)", false],
  ["moving_object", "object crossing a static scene", false],
  ["shot_cut", "background cut in the middle (object keeps moving)", false],
  ["lowlight_noise", "low light, sensor noise σ=9", false],
  ["camera_pan", "camera pans; object fixed in the world", true],
  ["static_logo", "scrolling scene, fixed overlay", true],
];
const results: Record<string, A> = {};
for (const [name, label, cam] of CLEAN) {
  const a = scen(name); results[name] = a;
  check(`A/${name}: every frame tracked, none flagged (${label})`, a.counts.tracked === a.frames - 1 && a.needsReview === 0, JSON.stringify(a.counts));
  check(`A/${name}: position error mean ${f3(a.err?.mean)} / p95 ${f3(a.err?.p95)} / max ${f3(a.err?.max)} px (max ≤ 0.35)`, !!a.err && a.err.max <= 0.35 && a.err.mean <= 0.2);
  check(`A/${name}: mask overlaps the true object (IoU mean ${f3(a.iou?.mean)}, min ${f3(a.iou?.min)}; ≥ 0.95 / 0.9)`, !!a.iou && a.iou.mean >= 0.95 && a.iou.min >= 0.9);
  check(`A/${name}: no silent errors (a 'tracked' frame more than 4 px off or while hidden)`, a.silent.length === 0, a.silent.slice(0, 3).join("; "));
  check(`A/${name}: ${cam ? "camera/scene movement is reported" : "no false camera-movement alarm"}`, a.camera.moving === cam && a.warnings.includes("camera_moving") === cam, `checked ${a.camera.checked} sample pairs`);
  bench.push({ scenario: name, frames: a.frames, trackMs: Math.round(a.ms.track), cameraCheckMs: Math.round(a.ms.camera), totalMs: Math.round(a.ms.total), msPerFrame: +(a.ms.track / a.frames).toFixed(2), matches: a.matches, peakRssMB: a.maxRssMB, baseRssMB: a.baseRssMB });
}
{ const d = results.long_track.drift as number[];
  check(`A/drift over 150 frames: mean error by thirds ${d.map((x) => f3(x)).join(" / ")} px — no growth (last − first ≤ 0.1, all ≤ 0.2)`, d.every((x) => x <= 0.2) && d[2] - d[0] <= 0.1); }

// occlusion / exit / re-entry (the hard case)
const occ = scen("occlusion");
check("A/occlusion: never 'tracked' through a hidden object or a wrong place (0 silent errors)", occ.silent.length === 0, occ.silent.slice(0, 3).join("; "));
check(`A/occlusion: flagged instead — uncertain ${occ.counts.uncertain}, lost ${occ.counts.lost}, re-entry ${occ.counts.reentry}`, occ.counts.uncertain > 0 && occ.counts.lost > 0 && occ.counts.reentry >= 1 && occ.needsReview > 0);
check("A/occlusion: accuracy on the frames it does track is still sub-pixel", !!occ.err && occ.err.max <= 0.35, `max ${f3(occ.err?.max)} px over ${occ.err?.n} frames`);
check("A/occlusion: warns about uncertain/lost frames and re-entry", ["uncertain_frames", "lost_frames", "reentry"].every((w) => occ.warnings.includes(w)));
check("A/occlusion: re-entry detected as a candidate after the object returns (frame ≥ 88), never resumed silently", occ.candidates.length > 0 && occ.candidates[0].frame >= 88 && occ.counts.lost >= 20, `first candidate frame ${occ.candidates[0]?.frame}; lost ${occ.counts.lost}`);
const occR = scen("occlusion", { autoResume: true });
check(`A/occlusion with autoResume: resumes at the re-entry, that frame is flagged for review, accuracy stays sub-pixel (max ${f3(occR.err?.max)})`, occR.counts.reentry >= 2 && occR.silent.length === 0 && !!occR.err && occR.err.max <= 0.35 && occR.needsReview > 0);

// manual keyframe correction on the same hard clip
const fix = scen("occlusion", { autoCorrect: true });
check(`A/manual correction: ${fix.reviewBefore} frames needed attention → ${fix.needsReview} after ${fix.iterations} rounds (${fix.keyframes.length} keyframes: ${fix.keyframes.join(",")})`, fix.reviewBefore > 0 && fix.needsReview === 0);
check(`A/manual correction: every frame resolved (tracked ${fix.counts.tracked}, interpolated ${fix.counts.interpolated}, absent ${fix.counts.absent}, keyframes ${fix.counts.keyframe})`, fix.counts.uncertain === 0 && fix.counts.lost === 0 && fix.counts.reentry === 0);
check(`A/manual correction: tracked/interpolated frames stay on the object (max error ${f3(fix.err?.max)} px, 0 silent, IoU ${f3(fix.iou?.mean)})`, fix.silent.length === 0 && !!fix.err && fix.err.max <= 0.35 && !!fix.iou && fix.iou.mean >= 0.95);
check("A/manual correction: object exit is represented as 'absent', not as a mask", fix.counts.absent >= 15);
bench.push({ scenario: "occlusion (hard)", frames: occ.frames, trackMs: Math.round(occ.ms.track), cameraCheckMs: Math.round(occ.ms.camera), totalMs: Math.round(occ.ms.total), msPerFrame: +(occ.ms.track / occ.frames).toFixed(2), matches: occ.matches, peakRssMB: occ.maxRssMB, baseRssMB: occ.baseRssMB });
bench.push({ scenario: "occlusion + 7 correction rounds", frames: fix.frames, totalMs: fix.wallMs, peakRssMB: fix.maxRssMB, baseRssMB: fix.baseRssMB });

// integration: tracked masks feed the temporal reconstruction (milestone 2) and the result is measured against exact truth
{
  const out = `${RAW}/moving_object/out-track.rgb`;
  const r = JSON.parse(sh("npx", ["tsx", "tests/helpers/track-clean-run.ts", `${RAW}/moving_object`, out]).trim().split("\n").pop()!);
  check("A/integration: one drawn mask → track → resolve → temporal cleanup succeeds", r.ok && r.status === "ok", r.ok ? `track ${r.trackMs} ms, total ${r.totalMs} ms, peak ${r.maxRssMB} MB` : r.message);
  if (r.ok) {
    const ev = JSON.parse(sh("python3", ["tests/video-cleanup/metrics.py", "evaluate-raw", "--scenario", "moving_object", "--result", out]));
    check(`A/integration: object gone (residual ${ev.removal.residual_ratio.toFixed(3)}), red left ${ev.removal.red_remaining}`, ev.pass.removed && ev.pass.red_gone);
    check(`A/integration: pixels outside the selection identical (${ev.outside.differing_pixels} differ)`, ev.pass.outside_exact);
    bench.push({ scenario: "track + clean (moving_object)", frames: 90, totalMs: r.totalMs, peakRssMB: r.maxRssMB });
  }
}

// ───────────── Part B: controlled synthetic clips ─────────────
const lin = (vx: number, vy: number, x0 = 60, y0 = 120) => (t: number): [number, number] => [x0 + vx * t, y0 + vy * t];
type Run = { c: ReturnType<typeof makeClip>; r: TrackResult };
const track = (spec: Spec, kf: number[] = [0], opts: Parameters<typeof trackObject>[4] = {}): Run => {
  const c = makeClip(spec);
  const keys: Keyframe[] = kf.map((f) => (c.masks[f].some((v) => v) && maskCentroid(c.masks[f], W, H).area >= 60 ? { frame: f, mask: c.masks[f] } : { frame: f, absent: true }));
  return { c, r: trackObject(c.frames, W, H, keys, { checkCamera: false, ...opts }) };
};
const errOf = (x: Run, t: number) => { const f = x.r.frames[t], fa = x.r.keyframes[f.anchor].frame; return Math.hypot(f.dx - (x.c.centres[t][0] - x.c.centres[fa][0]), f.dy - (x.c.centres[t][1] - x.c.centres[fa][1])); };
const stats = (a: number[]) => ({ n: a.length, rms: Math.sqrt(a.reduce((s, v) => s + v * v, 0) / Math.max(1, a.length)), max: Math.max(0, ...a) });
const silentCount = (x: Run) => x.r.frames.reduce((n, f, t) => n + ((f.status === "tracked" || f.status === "interpolated") && (errOf(x, t) > 4 || (f.status === "tracked" && x.c.vis[t] < 0.5 && x.r.frames[t].anchor === 0)) ? 1 : 0), 0);

// sub-pixel accuracy at several phases/speeds
for (const [vx, vy] of [[0.37, 0.21], [0.5, 0.5], [1.5, -0.7], [0.05, 0.03], [3.3, 1.9]] as const) {
  const x = track({ n: 60, path: lin(vx, vy) }), e = x.r.frames.map((_, t) => (t ? errOf(x, t) : NaN)).filter((v) => !isNaN(v)), s = stats(e);
  check(`B/sub-pixel v=(${vx},${vy}) px/frame: rms ${f3(s.rms)}, max ${f3(s.max)} px (max ≤ 0.35), all ${e.length} frames tracked`, s.max <= 0.35 && x.r.counts.tracked === 59);
}
{ // mask alignment with the analytic object outline
  const x = track({ n: 60, path: lin(0.37, 0.21) }); let iouSum = 0, cenMax = 0, n = 0;
  for (let t = 1; t < 60; t++) { const m = maskAt(x.r, t)!, g = x.c.masks[t]; let i = 0, u = 0; for (let k = 0; k < m.length; k++) { i += m[k] & g[k]; u += m[k] | g[k]; } iouSum += i / u; const a = maskCentroid(m, W, H), b = maskCentroid(g, W, H); cenMax = Math.max(cenMax, Math.hypot(a.x - b.x, a.y - b.y)); n++; }
  check(`B/mask alignment: IoU ${f3(iouSum / n)} (≥ 0.95), centroid offset to true outline ≤ ${f3(cenMax)} px (≤ 0.6)`, iouSum / n >= 0.95 && cenMax <= 0.6);
}
// noise
for (const sg of [5, 10, 20, 30]) {
  const x = track({ n: 60, path: lin(1.7, 0.6), noise: sg }), e = x.r.frames.map((_, t) => (t ? errOf(x, t) : NaN)).filter((v) => !isNaN(v)), s = stats(e);
  check(`B/noise σ=${sg}: rms ${f3(s.rms)}, max ${f3(s.max)} px (≤ 0.5), ${x.r.counts.tracked}/59 tracked, no silent errors`, s.max <= 0.5 && x.r.counts.tracked >= 56 && silentCount(x) === 0);
}
{ // overwhelming noise must be flagged, never tracked at random
  const x = track({ n: 40, path: lin(1.7, 0.6), noise: 90 });
  check(`B/extreme noise σ=90: no silent errors (tracked ${x.r.counts.tracked}, flagged ${x.r.needsReview.length})`, silentCount(x) === 0);
}
// lighting
{ const x = track({ n: 100, path: lin(1.5, 0.3), gain: (t) => 1 - 0.5 * t / 99 }), s = stats(x.r.frames.map((_, t) => (t ? errOf(x, t) : NaN)).filter((v) => !isNaN(v)));
  check(`B/lighting fades to 50% over 100 frames: still tracked (${x.r.counts.tracked}/99), max ${f3(s.max)} px`, x.r.counts.tracked === 99 && s.max <= 0.35); }
// appearance change / drift protection
{ const x = track({ n: 150, path: (t) => [60 + 1.2 * t, 120], scale: (t) => 1 + 0.8 * t / 149 }), first = x.r.frames.findIndex((f, t) => t > 0 && f.status !== "tracked");
  check(`B/object grows 1.0→1.8× over 150 frames: flagged from frame ${first} instead of drifting (0 silent errors, ${x.r.needsReview.length} frames need review)`, first > 0 && silentCount(x) === 0 && x.r.needsReview.length > 50);
  let threw: any; try { resolveMasks(x.r); } catch (e) { threw = e; }
  check("B/…resolveMasks refuses (unresolved_tracking) and lists the frames; nothing is cleaned", threw instanceof TrackError && threw.code === "unresolved_tracking" && threw.details.frames.length === x.r.needsReview.length && /Nothing was cleaned up/.test(threw.message), threw?.message?.slice(0, 110));
  // manual correction: keyframes every 25 frames
  const y = track({ n: 150, path: (t) => [60 + 1.2 * t, 120], scale: (t) => 1 + 0.8 * t / 149 }, [0, 25, 50, 75, 100, 125, 149]);
  let ok = true; let masks: (Uint8Array | null)[] = []; try { masks = resolveMasks(y.r); } catch { ok = false; }
  const e = y.r.frames.map((f, t) => (f.status === "tracked" || f.status === "interpolated" ? errOf(y, t) : NaN)).filter((v) => !isNaN(v));
  check(`B/manual keyframes every 25 frames: all 150 frames resolved (tracked ${y.r.counts.tracked}, interpolated ${y.r.counts.interpolated}, keyframes ${y.r.counts.keyframe}), max error ${f3(Math.max(...e))} px (≤ 1.0)`, ok && masks.length === 150 && masks.every((m) => m !== null) && Math.max(...e) <= 1.0);
}
// occlusion by a wide foreground bar
{
  const spec: Spec = { n: 90, path: lin(3, 0, 40, 120), occluders: [{ x0: 140, x1: 220 }] };
  const x = track(spec);
  const hiddenTracked = x.r.frames.filter((f, t) => f.status === "tracked" && x.c.vis[t] < 0.5).length;
  check(`B/wide occluder: no frame is 'tracked' while less than half of the object is visible (flagged ${x.r.needsReview.length}, silent 0)`, hiddenTracked === 0 && silentCount(x) === 0 && x.r.needsReview.length > 5);
  check("B/wide occluder: warns and refuses to produce masks", x.r.warnings.some((w) => w.code === "uncertain_frames" || w.code === "lost_frames") && (() => { try { resolveMasks(x.r); return false; } catch (e) { return e instanceof TrackError && e.code === "unresolved_tracking"; } })());
  // recovery after manual correction: mark the object before and after the bar
  const y = track(spec, [0, 25, 70], { maxInterpolation: 50 });
  const tr = y.r.frames.map((f, t) => (f.status === "tracked" && t > 70 ? errOf(y, t) : NaN)).filter((v) => !isNaN(v)), ip = y.r.frames.map((f, t) => (f.status === "interpolated" ? errOf(y, t) : NaN)).filter((v) => !isNaN(v));
  check(`B/recovery after manual correction: all frames resolved; interpolated across the bar (${ip.length} frames, max ${f3(Math.max(0, ...ip))} px ≤ 0.5), tracking after the keyframe max ${f3(Math.max(0, ...tr))} px ≤ 0.35`, y.r.needsReview.length === 0 && ip.length > 10 && Math.max(...ip) <= 0.5 && Math.max(...tr) <= 0.35 && silentCount(y) === 0);
  const m26 = maskAt(y.r, 48)!, truth = y.c.masks[48];
  check("B/…interpolated frame (hidden object) carries a full-size mask at the right place for the cleanup", maskCentroid(m26, W, H).area > 1200 && Math.hypot(maskCentroid(m26, W, H).x - (40 + 3 * 48), maskCentroid(m26, W, H).y - 120) <= 2, `truth visible pixels ${truth.reduce((a, v) => a + v, 0)}`);
}
// exit and re-entry
{
  const path = (t: number): [number, number] => [t < 40 ? 60 - 3 * t : t < 60 ? -60 : -60 + 6.5 * (t - 60), 120];
  const spec: Spec = { n: 110, path };
  const x = track(spec), y = track(spec, [0], { autoResume: true });
  const firstFlag = x.r.frames.findIndex((f, t) => t > 0 && f.status !== "tracked");
  check(`B/object leaves the frame: flagged from frame ${firstFlag} (object half out ≈ 20), never tracked once mostly outside, 0 silent`, firstFlag >= 15 && firstFlag <= 30 && silentCount(x) === 0 && x.r.frames.every((f, t) => !(f.status === "tracked" && x.c.vis[t] < 0.5)));
  check("B/object leaves: it is 'lost' (no mask), not coasted indefinitely", x.r.counts.lost > 20 && x.r.frames.filter((f) => f.status === "lost").every((f) => maskAt(x.r, x.r.frames.indexOf(f)) === null));
  const reFrame = x.r.candidates[0]?.frame;
  check(`B/re-entry detected at frame ${reFrame} (object fully back at ≈ 76); reported as a candidate, not resumed`, !!x.r.candidates.length && reFrame >= 70 && reFrame <= 90 && x.r.warnings.some((w) => w.code === "reentry") && x.r.frames[reFrame].status === "lost");
  const re = y.r.frames.findIndex((f) => f.status === "reentry"), after = y.r.frames.map((f, t) => (t > re && f.status === "tracked" ? errOf(y, t) : NaN)).filter((v) => !isNaN(v));
  check(`B/autoResume: re-entry frame ${re} flagged for review, then tracked accurately (${after.length} frames, max ${f3(Math.max(0, ...after))} px)`, re > 0 && y.r.frames[re].needsReview && after.length > 20 && Math.max(...after) <= 0.35 && silentCount(y) === 0);
}
// look-alike crossing the path
{
  const x = track({ n: 110, path: lin(2, 0, 40, 120), distractor: (t) => [260 - 2 * t, 128] }), s = stats(x.r.frames.map((f, t) => (f.status === "tracked" ? errOf(x, t) : NaN)).filter((v) => !isNaN(v)));
  check(`B/identical object crosses the path: tracker either stays on the right one or flags (0 silent errors; tracked ${x.r.counts.tracked}, flagged ${x.r.needsReview.length}, max error of tracked ${f3(s.max)} px)`, silentCount(x) === 0 && s.max <= 0.5);
}
// interpolation semantics
{
  const c = makeClip({ n: 40, path: lin(1.3, 0.4) }), mk = (f: number): Keyframe => ({ frame: f, mask: c.masks[f] });
  const r = trackObject(c.frames, W, H, [mk(0), mk(20)], { checkCamera: false, nccMin: 2 }); // tracking disabled => interpolation only
  const a = maskCentroid(c.masks[0], W, H), b = maskCentroid(c.masks[20], W, H), m = maskCentroid(maskAt(r, 10)!, W, H);
  check("B/interpolation: midpoint lies exactly halfway between the keyframes", r.frames[10].status === "interpolated" && Math.abs(m.x - (a.x + b.x) / 2) < 0.6 && Math.abs(m.y - (a.y + b.y) / 2) < 0.6, `(${m.x.toFixed(2)},${m.y.toFixed(2)})`);
  check("B/interpolation: reported as a warning with the frame list", r.warnings.some((w) => w.code === "interpolated" && w.frames!.length === 19) && r.counts.interpolated === 19);
  const L = trackObject(c.frames, W, H, [mk(0), mk(39)], { checkCamera: false, nccMin: 2 });
  check("B/interpolation over a gap longer than 30 frames is NOT accepted (uncertain, needs review)", L.counts.interpolated === 0 && L.frames[20].status === "uncertain" && L.frames[20].reason === "gap_too_long" && L.needsReview.length === 38);
  check("B/keyframe frames carry exactly the mask the user drew (byte-identical)", r.frames[0].status === "keyframe" && maskAt(r, 0)!.every((v, i) => v === (c.masks[0][i] ? 1 : 0)) && maskAt(r, 20)!.every((v, i) => v === (c.masks[20][i] ? 1 : 0)));
  // non-linear motion: interpolation error is measured and reported (a limitation, shown to the user as 'interpolated')
  const lt = JSON.parse(readFileSync(`${RAW}/long_track/info.json`, "utf8")), raw = readFileSync(`${RAW}/long_track/input.rgb`), mraw = readFileSync(`${RAW}/long_track/mask.u8`);
  const fr = Array.from({ length: 150 }, (_, t) => new Uint8Array(raw.buffer, raw.byteOffset + t * 640 * 360 * 3, 640 * 360 * 3)), gt = (t: number) => new Uint8Array(mraw.buffer, mraw.byteOffset + t * 640 * 360, 640 * 360);
  for (const step of [10, 20]) {
    const ks: Keyframe[] = []; for (let f = 0; f < 150; f += step) ks.push({ frame: f, mask: gt(f) }); ks.push({ frame: 149, mask: gt(149) });
    const rr = trackObject(fr, 640, 360, ks, { checkCamera: false, nccMin: 2 }); let mx = 0;
    rr.frames.forEach((f, t) => { if (f.status === "interpolated") { const fa = rr.keyframes[f.anchor].frame; mx = Math.max(mx, Math.hypot(f.dx - (lt.centre[t][0] - lt.centre[fa][0]), f.dy - (lt.centre[t][1] - lt.centre[fa][1]))); } });
    bench.push({ scenario: `interpolation only, figure-8, keyframe every ${step}`, frames: 150, maxInterpolationErrorPx: +mx.toFixed(2) });
    check(`B/interpolation-only on a curved figure-8 path, keyframes every ${step} frames: max error ${mx.toFixed(1)} px (reported limitation; sanity ≤ ${step === 10 ? 12 : 40})`, rr.counts.interpolated > 100 && mx <= (step === 10 ? 12 : 40));
  }
}
// absent keyframes
{
  const c = makeClip({ n: 30, path: lin(1, 0) }), kf = (f: number): Keyframe => ({ frame: f, mask: c.masks[f] });
  const a = trackObject(c.frames, W, H, [kf(0), { frame: 10, absent: true }, { frame: 20, absent: true }], { checkCamera: false });
  check("B/'object not visible' on both sides marks the frames between as absent (resolved, no mask)", a.frames.slice(11, 20).every((f) => f.status === "absent") && a.frames[10].status === "absent");
  const b = trackObject(c.frames, W, H, [{ frame: 0, absent: true }, kf(10)], { checkCamera: false, nccMin: 2 });
  check("B/absent on one side and the object on the other: the stretch is NOT decided for the user", b.frames.slice(1, 10).every((f) => f.needsReview));
}
// flat objects
{
  const c = makeClip({ n: 20, path: lin(1, 0) }), m = c.masks[0];
  const flat = c.frames.map((f) => { const g = Uint8Array.from(f); for (let i = 0; i < m.length; i++) if (c.masks[0][i]) { g[i * 3] = 200; g[i * 3 + 1] = 40; g[i * 3 + 2] = 40; } return g; });
  const r = trackObject(flat, W, H, [{ frame: 0, mask: m }], { checkCamera: false });
  check("B/a single-colour object cannot be followed automatically: warned, nothing tracked", r.warnings.some((w) => w.code === "flat_object") && r.counts.tracked === 0 && r.needsReview.length > 0);
}
// input validation
{
  const c = makeClip({ n: 10, path: lin(1, 0) }), m = c.masks[0], code = (f: () => unknown) => { try { f(); return "none"; } catch (e) { return e instanceof TrackError ? e.code : "other:" + (e as Error).message; } };
  const T = (k: Keyframe[], fr = c.frames) => () => trackObject(fr, W, H, k, { checkCamera: false });
  check("B/bad input: no keyframes → bad_input", code(T([])) === "bad_input");
  check("B/bad input: only 'absent' keyframes → bad_input", code(T([{ frame: 0, absent: true }])) === "bad_input");
  check("B/bad input: keyframe outside the clip → bad_input", code(T([{ frame: 99, mask: m }])) === "bad_input" && code(T([{ frame: -1, mask: m }])) === "bad_input");
  check("B/bad input: two keyframes on one frame → bad_input", code(T([{ frame: 0, mask: m }, { frame: 0, mask: m }])) === "bad_input");
  check("B/bad input: empty selection → bad_input with a clear message", code(T([{ frame: 0, mask: new Uint8Array(W * H) }])) === "bad_input");
  check("B/bad input: selection too small to track → bad_input", code(T([{ frame: 0, mask: dilateMask(new Uint8Array(W * H).fill(0).map((_, i) => (i === 5000 ? 1 : 0)), W, H, 1) }])) === "bad_input");
  check("B/bad input: wrong mask or frame size → bad_input", code(T([{ frame: 0, mask: new Uint8Array(5) }])) === "bad_input" && code(T([{ frame: 0, mask: m }], [new Uint8Array(7), ...c.frames.slice(1)])) === "bad_input");
  check("B/bad input: no frames → bad_input", code(() => trackObject([], W, H, [{ frame: 0, mask: m }])) === "bad_input");
}
// determinism, immutability, cancel, progress
{
  const c = makeClip({ n: 40, path: lin(1.1, 0.3), noise: 6 }), before = c.frames.map((f) => Uint8Array.from(f)), mb = c.masks.map((m) => Uint8Array.from(m));
  const a = trackObject(c.frames, W, H, [{ frame: 0, mask: c.masks[0] }], { checkCamera: false }), b = trackObject(c.frames, W, H, [{ frame: 0, mask: c.masks[0] }], { checkCamera: false });
  check("B/deterministic: two runs give identical positions and statuses", JSON.stringify(a.frames) === JSON.stringify(b.frames));
  check("B/inputs (frames, masks) are never modified", c.frames.every((f, t) => f.every((v, i) => v === before[t][i])) && c.masks.every((m, t) => m.every((v, i) => v === mb[t][i])));
  let n = 0, e: any; try { trackObject(c.frames, W, H, [{ frame: 0, mask: c.masks[0] }], { checkCamera: false, shouldCancel: () => ++n > 5 }); } catch (x) { e = x; }
  check("B/cancel: stops promptly with code 'cancelled'", e instanceof TrackError && e.code === "cancelled" && n <= 8, `checks=${n}`);
  const p: number[] = []; trackObject(c.frames, W, H, [{ frame: 0, mask: c.masks[0] }], { checkCamera: true, onProgress: (f) => p.push(f) });
  check("B/progress is monotonic and ends at 1", p.length > 2 && p.every((v, i) => !i || v >= p[i - 1]) && p[p.length - 1] === 1);
  const clean = resolveMasks(a);
  check("B/resolveMasks on a fully tracked clip returns one mask per frame, equal to maskAt", clean.length === 40 && clean.every((m, t) => { const q = maskAt(a, t); return m !== null && q !== null && m.every((v, i) => v === q[i]); }));
  const sm = shiftMask(c.masks[0], W, H, 3, -2);
  check("B/shiftMask: whole-pixel shifts are exact", sm.every((v, i) => { const x = i % W, y = (i / W) | 0, sx = x - 3, sy = y + 2; return v === (sx >= 0 && sy >= 0 && sx < W && sy < H && c.masks[0][sy * W + sx] ? 1 : 0); }));
}
// tracked masks → cleanup: an unresolved track must never reach the cleanup
{
  const x = track({ n: 40, path: (t) => [60 + 1.2 * t, 120], scale: (t) => 1 + 0.8 * t / 39 });
  let cleaned = false; try { const masks = resolveMasks(x.r); reconstructVideo(x.c.frames, masks.map((m) => dilateMask(m!, W, H, 3)), W, H); cleaned = true; } catch (e) { cleaned = false; check("B/failed tracking cannot reach the cleanup: resolveMasks throws before reconstructVideo is called", e instanceof TrackError); }
  check("B/…the pipeline did not produce a 'successful' cleanup from failed tracking", !cleaned);
}

mkdirSync("tests/out", { recursive: true });
writeFileSync("tests/out/vc-m3-bench.json", JSON.stringify(bench, null, 1));
console.log("\nBENCH (scenario runs are separate processes; ms = tracker only unless noted; RSS = process peak, baseline = before tracking):");
console.table(bench.filter((b) => "peakRssMB" in b).map((b: any) => ({ scenario: b.scenario, frames: b.frames, "track ms": b.trackMs ?? "", "camera-check ms": b.cameraCheckMs ?? "", "total ms": b.totalMs ?? "", "ms/frame": b.msPerFrame ?? "", matches: b.matches ?? "", "peak RSS MB": b.peakRssMB, "baseline MB": b.baseRssMB ?? "" })));
console.log(`\n${pass}/${pass + fail} passed${fail ? "  FAILED: " + failures.join("; ") : ""}`);
process.exit(fail ? 1 : 0);
