/**
 * Stage 2 / Milestone 2 tests: temporal reconstruction (motion-compensated background, camera-move and cut handling, exact outside copy).
 * Part A runs every ground-truth scenario from the M1 harness in its OWN process (so time and peak memory are real) and judges the
 * raw frames with the Python metrics (evaluate-raw). Part B uses small synthetic clips for behaviours that need controlled inputs.
 *   npx tsx tests/temporal.test.ts        (needs python3 + numpy; writes tests/out/vc-m2-bench.json)
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { reconstructVideo, dilateMask, estimateMotion, TemporalError, type Frame } from "../src/lib/inpaint/temporal";

let pass = 0, fail = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, extra = "") => { if (ok) pass++; else { fail++; failures.push(name); } console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`); };
const sh = (cmd: string, args: string[]) => { const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 1 << 28 }); if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")}\n${r.stderr}`); return r.stdout; };

const RAW = "tests/out/vc-raw";
mkdirSync(RAW, { recursive: true });
if (!existsSync(`${RAW}/long_track/input.rgb`)) sh("python3", ["tests/video-cleanup/gen.py", "--export-raw", "--out", RAW]);

type Run = { ok: boolean; status?: string; warnings?: string[]; segments?: number[][]; minCoverage?: number; code?: string; message?: string; details?: any; wallMs: number; maxRssMB: number; rssBeforeMB: number; frames: number; stats?: any };
const runScenario = (name: string, opts: object = {}, out = true): Run => JSON.parse(sh("npx", ["tsx", "tests/helpers/temporal-run.ts", `${RAW}/${name}`, out ? `${RAW}/${name}/out.rgb` : "-", JSON.stringify(opts)]).trim().split("\n").pop()!);
const evalRaw = (name: string) => JSON.parse(sh("python3", ["tests/video-cleanup/metrics.py", "evaluate-raw", "--scenario", name, "--result", `${RAW}/${name}/out.rgb`]));
const bench: Record<string, unknown>[] = [];

// ───────────── Part A: ground-truth scenarios ─────────────
const GOOD: Array<[string, string, string[]]> = [
  ["moving_object", "fixed camera, object moves over a static background", []],
  ["long_track", "fixed camera, long figure-8 track (150 frames)", []],
  ["static_logo", "moving background, fixed overlay (motion-compensated)", ["scene_in_motion"]],
  ["occlusion", "object leaves and re-enters behind an occluder", []],
  ["lowlight_noise", "low light, sensor noise σ=9", []],
  ["shot_cut", "shot cut in the middle", ["shot_cut"]],
];
for (const [name, label, wantWarn] of GOOD) {
  const r = runScenario(name);
  check(`A/${name}: succeeds (${label})`, r.ok, r.ok ? `status=${r.status}` : r.message);
  if (!r.ok) continue;
  const ev = evalRaw(name);
  const P = ev.pass;
  check(`A/${name}: object removed (residual ${ev.removal.residual_ratio.toFixed(3)} ≤ 0.35, red left ${ev.removal.red_remaining ?? "n/a"})`, P.removed && P.red_gone);
  check(`A/${name}: every pixel outside the selection identical to input (${ev.outside.differing_pixels} differ of ${ev.outside.checked_pixels})`, P.outside_exact);
  check(`A/${name}: temporally stable (excess ${ev.flicker.excess.toFixed(3)}, instability ${ev.instability_ratio.toFixed(3)})`, P.stable);
  check(`A/${name}: all frames returned`, P.all_frames);
  check(`A/${name}: status ok and no false alarm`, r.status === "ok" && !r.warnings!.some((w) => w === "unreliable_motion" || w === "object_moves_with_background"), `warnings=[${r.warnings}]`);
  for (const w of wantWarn) check(`A/${name}: warns '${w}'`, r.warnings!.includes(w));
  bench.push({ scenario: name, frames: r.frames, ok: true, status: r.status, ms: r.wallMs, msPerFrame: +(r.wallMs / r.frames).toFixed(1), peakRssMB: r.maxRssMB, baselineRssMB: r.rssBeforeMB, phases: r.stats.ms, spatialPixels: r.stats.spatialFilled, maskedPixels: r.stats.maskedPixels });
}
{ const r = runScenario("shot_cut"); check("A/shot_cut: two segments split exactly at the cut [0-44][45-89]", JSON.stringify(r.segments) === "[[0,44],[45,89]]", JSON.stringify(r.segments)); }
{ const r = runScenario("lowlight_noise"); check("A/lowlight_noise: no false shot cut or camera-motion alarm", r.segments!.length === 1 && !r.warnings!.includes("shot_cut")); }

// camera pan: the object is fixed in the scene, so the background behind it is never visible → must refuse
{
  const r = runScenario("camera_pan", {}, false);
  check("A/camera_pan: refused with insufficient_background (no invented result)", !r.ok && r.code === "insufficient_background", r.message?.slice(0, 120));
  check("A/camera_pan: message says nothing was changed and names the cause", !!r.message && /Nothing was changed/.test(r.message) && /camera pan|move together/.test(r.message));
  check("A/camera_pan: detail reports camera motion and 0% coverage", r.details?.moving === true && r.details?.worstCoverage === 0);
  bench.push({ scenario: "camera_pan (refused)", frames: r.frames, ok: false, code: r.code, ms: r.wallMs, msPerFrame: +(r.wallMs / r.frames).toFixed(1), peakRssMB: r.maxRssMB, baselineRssMB: r.rssBeforeMB });
  const d = runScenario("camera_pan", { onInsufficient: "spatial" });
  check("A/camera_pan opt-in: result is 'degraded', never 'ok'", d.ok && d.status === "degraded", `status=${d.status}`);
  check("A/camera_pan opt-in: warns spatial_fallback + object_moves_with_background", !!d.warnings?.includes("spatial_fallback") && !!d.warnings?.includes("object_moves_with_background"));
  const ev = evalRaw("camera_pan");
  check("A/camera_pan opt-in: still exact outside the selection", ev.pass.outside_exact, `${ev.outside.differing_pixels} differ`);
  bench.push({ scenario: "camera_pan (opt-in spatial, degraded)", frames: d.frames, ok: true, status: d.status, ms: d.wallMs, msPerFrame: +(d.wallMs / d.frames).toFixed(1), peakRssMB: d.maxRssMB, baselineRssMB: d.rssBeforeMB, phases: d.stats.ms, seededFrames: d.stats.seeded });
}

// ───────────── Part B: controlled synthetic clips ─────────────
function rngf(seed: number) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
/** smooth value-noise texture, W*H*3, plenty of structure for motion estimation */
function texture(seed: number, W: number, H: number): Uint8Array {
  const r = rngf(seed), G = 10, gw = Math.ceil(W / G) + 2, gh = Math.ceil(H / G) + 2;
  const grid = Array.from({ length: 3 }, () => Float32Array.from({ length: gw * gh }, () => r() * 255));
  const out = new Uint8Array(W * H * 3);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) for (let c = 0; c < 3; c++) {
    const gx = x / G, gy = y / G, x0 = gx | 0, y0 = gy | 0, fx = gx - x0, fy = gy - y0, g = grid[c];
    const v = g[y0 * gw + x0] * (1 - fx) * (1 - fy) + g[y0 * gw + x0 + 1] * fx * (1 - fy) + g[(y0 + 1) * gw + x0] * (1 - fx) * fy + g[(y0 + 1) * gw + x0 + 1] * fx * fy;
    out[(y * W + x) * 3 + c] = Math.max(0, Math.min(255, v + (((x * 7 + y * 13 + c * 5) % 5) - 2)));
  }
  return out;
}
const W = 320, H = 240;
const crop = (tex: Uint8Array, tw: number, ox: number, oy: number): Frame => { const f = new Uint8Array(W * H * 3); for (let y = 0; y < H; y++) f.set(tex.subarray(((y + oy) * tw + ox) * 3, ((y + oy) * tw + ox + W) * 3), y * W * 3); return f; };
const rect = (x0: number, y0: number, x1: number, y1: number): Uint8Array => { const m = new Uint8Array(W * H); for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) m[y * W + x] = 1; return m; };
const paint = (f: Frame, m: Uint8Array, rgb: [number, number, number]) => { for (let i = 0; i < W * H; i++) if (m[i]) { f[i * 3] = rgb[0]; f[i * 3 + 1] = rgb[1]; f[i * 3 + 2] = rgb[2]; } };
const clone = (fs: Frame[]) => fs.map((f) => Uint8Array.from(f));
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

// fixed camera, object sweeping across a static background
const TEX = texture(5, W + 80, H + 40), BGF = crop(TEX, W + 80, 20, 10);
const sweep = (n: number) => { const fr: Frame[] = [], ms: Uint8Array[] = []; for (let t = 0; t < n; t++) { const x = 20 + t * 8, m = rect(x, 90, x + 40, 130); const f = Uint8Array.from(BGF); paint(f, m, [220, 30, 30]); fr.push(f); ms.push(dilateMask(m, W, H, 2)); } return { fr, ms }; };

{ // exactness + immutability + determinism
  const { fr, ms } = sweep(24), before = clone(fr), msBefore = ms.map((m) => Uint8Array.from(m));
  const a = reconstructVideo(fr, ms, W, H), b = reconstructVideo(fr, ms, W, H);
  check("B/fixed camera: result status ok, plate reproduces the true background exactly", a.status === "ok" && a.frames.every((f, t) => { const m = ms[t]; for (let i = 0; i < W * H; i++) if (m[i] && (f[i * 3] !== BGF[i * 3] || f[i * 3 + 1] !== BGF[i * 3 + 1] || f[i * 3 + 2] !== BGF[i * 3 + 2])) return false; return true; }));
  check("B/inputs are never modified (frames and masks byte-identical afterwards)", fr.every((f, t) => same(f, before[t])) && ms.every((m, t) => same(m, msBefore[t])));
  check("B/outside the selection: every byte equals the input, all frames", a.frames.every((f, t) => { for (let i = 0; i < W * H; i++) if (!ms[t][i] && (f[i * 3] !== fr[t][i * 3] || f[i * 3 + 1] !== fr[t][i * 3 + 1] || f[i * 3 + 2] !== fr[t][i * 3 + 2])) return false; return true; }));
  check("B/deterministic: two runs give byte-identical frames", a.frames.every((f, t) => same(f, b.frames[t])));
}
{ // frames with empty masks come back untouched
  const { fr, ms } = sweep(12); ms[5] = new Uint8Array(W * H); const r = reconstructVideo(fr, ms, W, H);
  check("B/a frame with nothing selected is returned unchanged", same(r.frames[5], fr[5]));
}
{ // a single frame has no other frame to learn from
  const { fr, ms } = sweep(1);
  let e: any; try { reconstructVideo(fr, ms, W, H); } catch (x) { e = x; }
  check("B/one frame only: refuses (insufficient_background), invents nothing", e instanceof TemporalError && e.code === "insufficient_background");
}
{ // object that never moves: background never visible → refuse; opt-in → degraded
  const m = dilateMask(rect(100, 80, 150, 130), W, H, 2), fr: Frame[] = [], ms: Uint8Array[] = [];
  for (let t = 0; t < 10; t++) { const f = Uint8Array.from(BGF); paint(f, rect(100, 80, 150, 130), [220, 30, 30]); fr.push(f); ms.push(m); }
  let e: any; try { reconstructVideo(fr, ms, W, H); } catch (x) { e = x; }
  check("B/static object on a static scene: refused with a clear message", e instanceof TemporalError && e.code === "insufficient_background" && /Nothing was changed/.test(e.message) && e.details.worstCoverage === 0, e?.message?.slice(0, 100));
  const r = reconstructVideo(fr, ms, W, H, { onInsufficient: "spatial" });
  check("B/…opt-in spatial: status 'degraded' with spatial_fallback warning, never 'ok'", r.status === "degraded" && r.warnings.some((w) => w.code === "spatial_fallback"));
  check("B/…opt-in spatial: pixels outside the selection still exact", r.frames.every((f, t) => { for (let i = 0; i < W * H; i++) if (!ms[t][i] && f[i * 3] !== fr[t][i * 3]) return false; return true; }));
}
{ // partial coverage: the object sits still for the first half, then leaves. Early frames are covered by later ones.
  const fr: Frame[] = [], ms: Uint8Array[] = [], m = rect(100, 80, 150, 130);
  for (let t = 0; t < 16; t++) { const f = Uint8Array.from(BGF); if (t < 8) paint(f, m, [220, 30, 30]); fr.push(f); ms.push(t < 8 ? dilateMask(m, W, H, 2) : new Uint8Array(W * H)); }
  const r = reconstructVideo(fr, ms, W, H);
  check("B/object that later leaves: background taken from the later frames (exact)", r.status === "ok" && r.frames.slice(0, 8).every((f, t) => { for (let i = 0; i < W * H; i++) if (ms[t][i] && f[i * 3] !== BGF[i * 3]) return false; return true; }));
}
{ // moving background (integer pan 3 px/frame), fixed overlay: motion-compensated plate recovers it
  const TW = W + 3 * 30 + 4, T2 = texture(9, TW, H + 4), fr: Frame[] = [], ms: Uint8Array[] = [], truth: Frame[] = [], m = rect(130, 100, 180, 140), dm = dilateMask(m, W, H, 2);
  for (let t = 0; t < 30; t++) { const f = crop(T2, TW, 3 * t, 2); truth.push(Uint8Array.from(f)); paint(f, m, [30, 30, 220]); fr.push(f); ms.push(dm); }
  const r = reconstructVideo(fr, ms, W, H);
  let bad = 0, tot = 0; r.frames.forEach((f, t) => { for (let i = 0; i < W * H; i++) if (dm[i]) { tot++; if (Math.abs(f[i * 3] - truth[t][i * 3]) + Math.abs(f[i * 3 + 1] - truth[t][i * 3 + 1]) + Math.abs(f[i * 3 + 2] - truth[t][i * 3 + 2]) > 6) bad++; } });
  check(`B/moving background: motion measured as 3 px/frame in every step`, r.motion.slice(1).every((x) => x.dx === 3 && x.dy === 0 && x.valid) , JSON.stringify(r.motion.slice(1, 4).map((x) => [x.dx, x.dy])));
  check(`B/moving background: ${(100 * (1 - bad / tot)).toFixed(2)}% of hidden pixels recovered within 6 levels (≥ 98%)`, bad / tot < 0.02 && r.warnings.some((w) => w.code === "scene_in_motion"));
}
{ // zoom: not a rigid shift → unreliable motion is reported, and nothing is invented
  const big = texture(21, 640, 480), fr: Frame[] = [], ms: Uint8Array[] = [];
  for (let t = 0; t < 12; t++) { const s = 1 + 0.03 * t, f = new Uint8Array(W * H * 3); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const sx = Math.min(639, Math.round(160 + (x - W / 2) / s + W / 2)), sy = Math.min(479, Math.round(120 + (y - H / 2) / s + H / 2)); f.set(big.subarray((sy * 640 + sx) * 3, (sy * 640 + sx) * 3 + 3), (y * W + x) * 3); } const m = rect(140, 100, 180, 140); paint(f, m, [220, 30, 30]); fr.push(f); ms.push(dilateMask(m, W, H, 2)); }
  let e: any, r: any; try { r = reconstructVideo(fr, ms, W, H); } catch (x) { e = x; }
  check("B/zoom: refused (insufficient_background) and flags unreliable motion", e instanceof TemporalError && e.code === "insufficient_background" && e.details.unreliableMotion.length > 0 && /Nothing was changed/.test(e.message), e ? `unreliable at ${e.details.unreliableMotion.length} steps` : `status=${r?.status}`);
  const d = reconstructVideo(fr, ms, W, H, { onInsufficient: "spatial" });
  check("B/zoom opt-in: degraded with unreliable_motion + spatial_fallback warnings", d.status === "degraded" && d.warnings.some((w) => w.code === "unreliable_motion") && d.warnings.some((w) => w.code === "spatial_fallback"));
}
{ // shot cut: scene A has a static object (background never visible), scene B shows that area clean. Nothing may be borrowed across the cut.
  const A = texture(31, W, H), Bt = texture(32, W, H), fr: Frame[] = [], ms: Uint8Array[] = [], m = rect(100, 80, 150, 130), dm = dilateMask(m, W, H, 2);
  for (let t = 0; t < 14; t++) { const f = Uint8Array.from(A); paint(f, m, [220, 30, 30]); fr.push(f); ms.push(dm); }
  for (let t = 0; t < 14; t++) { fr.push(Uint8Array.from(Bt)); ms.push(new Uint8Array(W * H)); }
  let e: any; try { reconstructVideo(fr, ms, W, H); } catch (x) { e = x; }
  check("B/shot cut: scene A is NOT filled from scene B (refused; cut reported at frame 14)", e instanceof TemporalError && e.code === "insufficient_background" && e.details.cuts.includes(14) && e.details.worstCoverage === 0);
  let e2: any; try { reconstructVideo(fr, ms, W, H, { detectCuts: false }); } catch (x) { e2 = x; }
  check("B/shot cut: even with cut detection off, unmeasurable motion stops information crossing the cut", e2 instanceof TemporalError && e2.code === "insufficient_background" && e2.details.unreliableMotion.length > 0);
  // and with two usable shots both get their own result
  const fr2: Frame[] = [], ms2: Uint8Array[] = [];
  for (let t = 0; t < 12; t++) { const f = Uint8Array.from(A), mm = rect(20 + t * 10, 90, 60 + t * 10, 130); paint(f, mm, [220, 30, 30]); fr2.push(f); ms2.push(dilateMask(mm, W, H, 2)); }
  for (let t = 0; t < 12; t++) { const f = Uint8Array.from(Bt), mm = rect(20 + t * 10, 90, 60 + t * 10, 130); paint(f, mm, [30, 220, 30]); fr2.push(f); ms2.push(dilateMask(mm, W, H, 2)); }
  const r = reconstructVideo(fr2, ms2, W, H);
  const exactA = r.frames.slice(0, 12).every((f, t) => { for (let i = 0; i < W * H; i++) if (ms2[t][i] && f[i * 3] !== A[i * 3]) return false; return true; });
  const exactB = r.frames.slice(12).every((f, t) => { for (let i = 0; i < W * H; i++) if (ms2[t + 12][i] && f[i * 3] !== Bt[i * 3]) return false; return true; });
  check("B/shot cut: each shot reconstructed from its own frames only (exact), cut at 12 reported", exactA && exactB && JSON.stringify(r.segments) === "[[0,11],[12,23]]" && r.warnings.some((w) => w.code === "shot_cut"), JSON.stringify(r.segments));
}
{ // motion estimator unit checks
  const T = texture(41, W + 40, H + 40), a = crop(T, W + 40, 10, 10), b = crop(T, W + 40, 14, 7), ok = new Uint8Array(W * H).fill(1);
  const e = estimateMotion(a, b, ok, ok, W, H, 10);
  check("B/estimateMotion: finds a (4,-3) shift exactly", e.dx === 4 && e.dy === -3 && e.valid, `got (${e.dx},${e.dy}) valid=${e.valid}`);
  const z = estimateMotion(a, a, ok, ok, W, H, 10);
  check("B/estimateMotion: identical frames → no motion, valid", z.dx === 0 && z.dy === 0 && z.valid);
  const flat = new Uint8Array(W * H * 3).fill(100), f2 = estimateMotion(flat, flat, ok, ok, W, H, 10);
  check("B/estimateMotion: a flat picture is treated as still (nothing to follow)", f2.dx === 0 && f2.dy === 0);
}
{ // previous-frame seeding: deterministic, and steadier than independent fills (camera pan, opt-in spatial)
  const TW = W + 2 * 12 + 4, T2 = texture(51, TW, H + 16), fr: Frame[] = [], ms: Uint8Array[] = [], truth: Frame[] = [], m = rect(120, 90, 190, 150), dm = dilateMask(m, W, H, 2);
  for (let t = 0; t < 10; t++) { const f = crop(T2, TW, 2 * t, 8 - t); truth.push(Uint8Array.from(f)); paint(f, m, [220, 30, 30]); fr.push(f); ms.push(dm); }
  const seeded = reconstructVideo(fr, ms, W, H, { onInsufficient: "spatial", seedFromPrevious: true });
  const seeded2 = reconstructVideo(fr, ms, W, H, { onInsufficient: "spatial", seedFromPrevious: true });
  const indep = reconstructVideo(fr, ms, W, H, { onInsufficient: "spatial", seedFromPrevious: false });
  const flick = (fs: Frame[]) => { let s = 0, n = 0; for (let t = 1; t < fs.length; t++) for (let i = 0; i < W * H; i++) if (dm[i]) { for (let c = 0; c < 3; c++) s += Math.abs((fs[t][i * 3 + c] - fs[t - 1][i * 3 + c]) - (truth[t][i * 3 + c] - truth[t - 1][i * 3 + c])); n += 3; } return s / n; };
  const fs = flick(seeded.frames), fi = flick(indep.frames);
  check("B/seeding: deterministic (two seeded runs byte-identical)", seeded.frames.every((f, t) => same(f, seeded2.frames[t])));
  check("B/seeding: later frames were actually seeded from the previous result", seeded.stats.seeded === 9 && indep.stats.seeded === 0, `seeded frames=${seeded.stats.seeded}`);
  check(`B/seeding: flicker vs true motion not worse than independent fills (seeded ${fs.toFixed(2)} vs independent ${fi.toFixed(2)})`, fs <= fi, "");
  bench.push({ scenario: "seeding comparison (synthetic pan)", seededFlicker: +fs.toFixed(3), independentFlicker: +fi.toFixed(3) });
}

// ───────────── bad inputs, cancellation ─────────────
{
  const { fr, ms } = sweep(6);
  const code = (f: () => unknown) => { try { f(); return "none"; } catch (e) { return e instanceof TemporalError ? e.code : "other:" + (e as Error).message; } };
  check("B/bad input: nothing selected anywhere → bad_input", code(() => reconstructVideo(fr, fr.map(() => new Uint8Array(W * H)), W, H)) === "bad_input");
  check("B/bad input: no frames → bad_input", code(() => reconstructVideo([], [], W, H)) === "bad_input");
  check("B/bad input: mask count ≠ frame count → bad_input", code(() => reconstructVideo(fr, ms.slice(1), W, H)) === "bad_input");
  check("B/bad input: wrong frame size → bad_input", code(() => reconstructVideo([new Uint8Array(10), ...fr.slice(1)], ms, W, H)) === "bad_input");
  check("B/bad input: wrong mask size → bad_input", code(() => reconstructVideo(fr, [new Uint8Array(5), ...ms.slice(1)], W, H)) === "bad_input");
  let calls = 0;
  const c = code(() => reconstructVideo(fr, ms, W, H, { shouldCancel: () => ++calls > 3 }));
  check("B/cancel: stops promptly with code 'cancelled'", c === "cancelled" && calls <= 6, `checks=${calls}`);
  const t0 = Date.now(); let cancelled = false; let e: any;
  const s40 = sweep(40); try { reconstructVideo(s40.fr, s40.ms, W, H, { shouldCancel: () => (cancelled = Date.now() - t0 > 300) }); } catch (x) { e = x; }
  check("B/cancel: a running job stops within ~1 s of the request", cancelled && e?.code === "cancelled" && Date.now() - t0 < 2500, `${Date.now() - t0} ms`);
  const big = sweep(24), prog: number[] = []; reconstructVideo(big.fr, big.ms, W, H, { onProgress: (f) => prog.push(f) });
  check("B/progress: monotonic and ends at 1", prog.length > 3 && prog.every((v, i) => i === 0 || v >= prog[i - 1]) && prog[prog.length - 1] === 1);
}

mkdirSync("tests/out", { recursive: true });
writeFileSync("tests/out/vc-m2-bench.json", JSON.stringify(bench, null, 1));
console.log("\nBENCH (each scenario in its own process; ms includes motion search, plate and composition; RSS is the process peak):");
console.table(bench.filter((b) => "ms" in b).map((b: any) => ({ scenario: b.scenario, frames: b.frames, ms: b.ms, "ms/frame": b.msPerFrame, "peak RSS MB": b.peakRssMB, "baseline RSS MB": b.baselineRssMB })));
console.log(`\n${pass}/${pass + fail} passed${fail ? "  FAILED: " + failures.join("; ") : ""}`);
process.exit(fail ? 1 : 0);
