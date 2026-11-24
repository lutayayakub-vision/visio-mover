// Stage 2 / Milestone 4: the video-cleanup pipeline in real headless Chrome with the real ffmpeg.wasm and real Web Workers.
// Every produced MP4 is judged by the Python metrics against exact ground truth (M1 harness); limits, errors, cancel and faults are exercised for real.
//   node tests/video-cleanup-pipeline.test.mjs      (needs ffmpeg/ffprobe, python3+numpy, Chrome; ~8 min)
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { startVite, launch } from "./lib.mjs";

const ROOT = new URL("..", import.meta.url).pathname, OUT = ROOT + "tests/out/vc-m4/", RAW = ROOT + "tests/out/vc-raw/", LIM = ROOT + "tests/out/vc-limits/", FIX = ROOT + "tests/fixtures/";
rmSync(OUT, { recursive: true, force: true }); mkdirSync(OUT, { recursive: true }); mkdirSync(LIM, { recursive: true });
const sh = (c, a) => { const r = spawnSync(c, a, { encoding: "utf8", maxBuffer: 1 << 28 }); if (r.status !== 0) throw new Error(`${c} ${a.join(" ")}\n${r.stderr}`); return r.stdout; };
if (!existsSync(RAW + "long_track/info.json")) sh("python3", [ROOT + "tests/video-cleanup/gen.py", "--export-raw", "--out", RAW]);
// fixtures for the limit/format tests (generated natively, deterministic)
const gen = (file, size, rate, secs, extra = []) => { if (!existsSync(LIM + file)) sh("ffmpeg", ["-hide_banner", "-v", "error", "-y", "-f", "lavfi", "-i", `testsrc2=size=${size}:rate=${rate}`, "-t", String(secs), "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", ...extra, LIM + file]); };
gen("long12.mp4", "320x180", 30, 12); gen("fps60.mp4", "320x180", 60, 3); gen("big1440.mp4", "2560x1440", 24, 1); gen("hd1080.mp4", "1920x1080", 30, 3);
if (!existsSync(LIM + "yuv444.mp4")) sh("ffmpeg", ["-hide_banner", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30", "-t", "3", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv444p", LIM + "yuv444.mp4"]);
if (!existsSync(LIM + "bt709.mp4")) sh("ffmpeg", ["-hide_banner", "-v", "error", "-y", "-i", FIX + "video-cleanup/moving_object/input.mp4", "-vf", "scale=out_color_matrix=bt709:flags=accurate_rnd+full_chroma_int,format=yuv420p", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-c:v", "libx264", "-preset", "veryfast", "-crf", "14", "-pix_fmt", "yuv420p", LIM + "bt709.mp4"]);
writeFileSync(LIM + "trunc.mp4", readFileSync(FIX + "clip.mp4").subarray(0, 120000));
const sha = (f) => createHash("sha256").update(readFileSync(f)).digest("hex");
const shaBeforeAll = Object.fromEntries(["moving_object", "long_track", "static_logo", "shot_cut", "lowlight_noise", "camera_pan", "occlusion"].map((n) => [n, sha(FIX + `video-cleanup/${n}/input.mp4`)]));

const server = await startVite(); const browser = await launch();
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("PAGE ERROR", e.message));
// vite may re-optimise dependencies on first load and reload the page once: load, let it settle, reload, then wait for ready
await page.goto(server.base + "/tests/harness/cleanup.html"); await new Promise((r) => setTimeout(r, 4000));
await page.goto(server.base + "/tests/harness/cleanup.html"); await page.waitForFunction("window.ready === true", { timeout: 60000 });

let total = 0, bad = 0; const failures = [];
const ok = (name, cond, detail = "") => { total++; if (!cond) { bad++; failures.push(name); } console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? "  [" + detail + "]" : ""}`); };
const probe = (f) => JSON.parse(execFileSync("ffprobe", ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", f], { encoding: "utf8" }));
const evalPy = (scenario, file) => JSON.parse(sh("python3", [ROOT + "tests/video-cleanup/metrics.py", "evaluate", "--scenario", scenario, "--result", file, "--crf", "23"]));
const workerTargets = () => browser.targets().filter((t) => t.type() === "worker" || t.type() === "service_worker").length;
const rssNow = () => { const r = spawnSync("ps", ["-eo", "rss,comm"], { encoding: "utf8" }).stdout.split("\n").filter((l) => /chrom/i.test(l)).reduce((n, l) => n + parseInt(l, 10), 0); return r / 1024; };
const bench = [];

function regionFor(name, pad = 40) {
  const { w, h, frames } = JSON.parse(readFileSync(RAW + name + "/info.json")), m = readFileSync(RAW + name + "/mask.u8");
  let x0 = w, y0 = h, x1 = 0, y1 = 0;
  for (let t = 0; t < frames; t++) for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (m[t * w * h + y * w + x]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  const X0 = Math.max(0, x0 - pad), Y0 = Math.max(0, y0 - pad), X1 = Math.min(w, x1 + pad), Y1 = Math.min(h, y1 + pad);
  return { x: X0, y: Y0, w: X1 - X0, h: Y1 - Y0 };
}
async function run(label, cfg) {
  let peak = rssNow(); const base = peak; const timer = setInterval(() => { peak = Math.max(peak, rssNow()); }, 300);
  const r = await page.evaluate((c) => window.cleanScenario(c), cfg);
  clearInterval(timer); r.rssPeakMB = Math.round(peak); r.rssBaseMB = Math.round(base);
  if (r.ok) { r.file = OUT + label.replace(/[^a-z0-9]+/gi, "_") + ".mp4"; writeFileSync(r.file, Buffer.from(r.b64, "base64")); r.b64 = undefined; }
  return r;
}
const kf0 = [0];

// ───────────── 1. real clips: the full set of gates ─────────────
const CLEAN = ["moving_object", "long_track", "static_logo", "shot_cut", "lowlight_noise"];
for (const name of CLEAN) {
  const meta = JSON.parse(readFileSync(FIX + `video-cleanup/${name}/meta.json`));
  const r = await run(name, { name, region: regionFor(name), keyframes: kf0 });
  if (!r.ok) { ok(`${name}: pipeline succeeds`, false, `${r.code}: ${r.message}`); continue; }
  ok(`${name}: pipeline succeeds, status ok, ${r.frames} frames in ${(r.totalMs / 1000).toFixed(1)} s`, r.status === "ok" && r.frames === meta.frames);
  ok(`${name}: pixels outside the selection identical BEFORE encoding (${r.hook.outsideDiff} differ over ${r.hook.frames} frames), selection actually changed (${r.hook.insideChanged} px)`, r.hook.outsideDiff === 0 && r.hook.insideChanged > 0 && r.hook.frames === meta.frames);
  const p = probe(r.file), v = p.streams.find((s) => s.codec_type === "video"), a = p.streams.find((s) => s.codec_type === "audio");
  const src = probe(FIX + `video-cleanup/${name}/input.mp4`), sv = src.streams.find((s) => s.codec_type === "video");
  ok(`${name}: frame count, fps, size unchanged (${v.nb_frames} frames, ${v.r_frame_rate}, ${v.width}x${v.height})`, +v.nb_frames === +sv.nb_frames && v.r_frame_rate === sv.r_frame_rate && v.width === sv.width && v.height === sv.height);
  ok(`${name}: duration unchanged (${(+p.format.duration).toFixed(3)} vs ${(+src.format.duration).toFixed(3)} s)`, Math.abs(+p.format.duration - +src.format.duration) < 0.1);
  ok(`${name}: audio ${meta.audio ? "stream preserved (AAC copied untouched)" : "absent as in the source"}`, meta.audio ? a?.codec_name === "aac" : !a);
  const ev = evalPy(name, r.file);
  ok(`${name}: object removed (residual ${ev.removal.residual_ratio.toFixed(3)} ≤ ${ev.limits.residual_max}, red left ${ev.removal.red_remaining})`, ev.pass.removed && ev.pass.red_gone);
  ok(`${name}: outside the selection still matches a codec-matched original (PSNR ${ev.outside_vs_reencoded_original.psnr_outside.toFixed(1)} ≥ ${ev.limits.outside_psnr_min.toFixed(1)} dB)`, ev.pass.outside_ok);
  ok(`${name}: no flicker beyond codec noise (excess ${ev.flicker.excess.toFixed(3)} ≤ ${ev.limits.flicker_max.toFixed(3)})`, ev.pass.stable);
  ok(`${name}: A/V parity incl. ${meta.audio ? "audio data bit-identical" : "no audio"}`, ev.pass.av_ok, ev.av.failures.join("; "));
  ok(`${name}: original file unchanged (SHA-256 in the browser before/after, and on disk)`, r.shaBefore === r.shaAfter && sha(FIX + `video-cleanup/${name}/input.mp4`) === shaBeforeAll[name] && r.shaBefore === shaBeforeAll[name]);
  ok(`${name}: all workers gone after the run (pool alive ${r.pool.alive}, spawned ${r.pool.spawned})`, r.pool.alive === 0 && r.pool.terminated && r.pool.spawned >= 1);
  bench.push({ scenario: name, frames: r.frames, region: regionFor(name), chunks: r.stats.chunks, chunkFrames: r.stats.chunkFrames, workers: r.stats.workers, estimateMs: Math.round(r.stats.estimateMs), totalMs: Math.round(r.totalMs), ms: Object.fromEntries(Object.entries(r.stats.ms).map(([k, x]) => [k, Math.round(x)])), jsHeapPeakMB: Math.round(r.heapPeak / 1048576), chromeRssPeakMB: r.rssPeakMB, chromeRssBaseMB: r.rssBaseMB, outBytes: r.stats.bytes, warnings: r.warnings.map((w) => w.code) });
  if (name === "shot_cut") ok("shot_cut: cut reported", r.warnings.some((w) => w.code === "shot_cut"));
  if (name === "static_logo") ok("static_logo: scene motion reported, still status ok", r.warnings.some((w) => w.code === "scene_in_motion") && r.status === "ok");
}

// ───────────── 2. camera pan: refuse, never invent ─────────────
{
  const r = await run("camera_pan", { name: "camera_pan", region: regionFor("camera_pan"), keyframes: kf0 });
  ok("camera_pan: refused with insufficient_background (no output produced)", !r.ok && r.code === "insufficient_background" && !r.b64, r.message?.slice(0, 100));
  ok("camera_pan: message says nothing was changed and names the camera pan", /Nothing was changed/.test(r.message) && /camera pan|move together/.test(r.message));
  ok("camera_pan: workers all gone after the refusal", r.pool.alive === 0 && r.pool.terminated);
  const d = await run("camera_pan_spatial", { name: "camera_pan", region: regionFor("camera_pan"), keyframes: kf0, req: { allowSpatialFallback: true } });
  ok("camera_pan with explicit opt-in: result is 'degraded' with spatial_fallback + object_moves_with_background warnings, never 'ok'", d.ok && d.status === "degraded" && d.warnings.some((w) => w.code === "spatial_fallback") && d.warnings.some((w) => w.code === "object_moves_with_background"), d.ok ? "" : d.message);
  ok("camera_pan opt-in: pixels outside the selection still identical before encoding", d.ok && d.hook.outsideDiff === 0 && d.hook.insideChanged > 0);
  ok("camera_pan opt-in: edit metadata records status 'degraded' and a moving camera", d.ok && d.editParams.cleanup.status === "degraded" && d.editParams.cleanup.tracking.camera === "moving");
  if (d.ok) bench.push({ scenario: "camera_pan (opt-in, degraded)", frames: d.frames, totalMs: Math.round(d.totalMs), ms: Object.fromEntries(Object.entries(d.stats.ms).map(([k, x]) => [k, Math.round(x)])), jsHeapPeakMB: Math.round(d.heapPeak / 1048576), chromeRssPeakMB: d.rssPeakMB, chromeRssBaseMB: d.rssBaseMB });
}

// ───────────── 3. occlusion / exit: unresolved tracking must stop the run ─────────────
{
  const u = await run("occlusion_unresolved", { name: "occlusion", region: regionFor("occlusion"), keyframes: kf0 });
  ok("occlusion with one keyframe: refused (tracking_unresolved), frames listed, 'Nothing was cleaned up'", !u.ok && u.code === "tracking_unresolved" && u.details?.frames?.length > 20 && /Nothing was cleaned up/.test(u.message), u.message?.slice(0, 120));
  ok("occlusion unresolved: no output, workers gone, original unchanged", !u.b64 && u.pool.alive === 0 && u.shaBefore === u.shaAfter);
  const r = await run("occlusion_range", { name: "occlusion", region: regionFor("occlusion"), keyframes: [0, 25, 37], range: { startFrame: 0, endFrame: 60 } });
  if (!r.ok) ok("occlusion with keyframes before/after the bar: succeeds", false, `${r.code}: ${r.message}`); else {
    const p = probe(r.file), v = p.streams.find((s) => s.codec_type === "video");
    ok(`occlusion with 3 keyframes (range 0–60): succeeds (status ${r.status}), ${v.nb_frames} frames @ ${v.r_frame_rate}, audio ${p.streams.some((s) => s.codec_type === "audio") ? "kept" : "missing"}`, r.status === "ok" && +v.nb_frames === 60 && v.r_frame_rate === "30/1" && p.streams.some((s) => s.codec_type === "audio"));
    const ev = evalPy("occlusion", r.file);
    ok(`occlusion range: object removed (residual ${ev.removal.residual_ratio.toFixed(3)}), outside ok (${ev.outside_vs_reencoded_original.psnr_outside.toFixed(1)} dB), stable (${ev.flicker.excess.toFixed(3)})`, ev.pass.removed && ev.pass.red_gone && ev.pass.outside_ok && ev.pass.stable);
    ok(`occlusion range: pixels outside the selection identical before encoding (${r.hook.outsideDiff})`, r.hook.outsideDiff === 0 && r.hook.insideChanged > 0);
    ok("occlusion range: metadata records the keyframes and the sub-range", JSON.stringify(r.editParams.cleanup.range) === '{"startFrame":0,"endFrame":60}' && r.editParams.cleanup.tracking.keyframes.length === 3);
    bench.push({ scenario: "occlusion (range 0-60, 3 keyframes)", frames: 60, totalMs: Math.round(r.totalMs), ms: Object.fromEntries(Object.entries(r.stats.ms).map(([k, x]) => [k, Math.round(x)])), jsHeapPeakMB: Math.round(r.heapPeak / 1048576), chromeRssPeakMB: r.rssPeakMB, chromeRssBaseMB: r.rssBaseMB });
  }
}

// ───────────── 4. colour handling: BT.709-tagged source ─────────────
{
  const r = await run("bt709", { name: "moving_object", fixture: "../out/vc-limits/bt709.mp4", region: regionFor("moving_object"), keyframes: kf0 });
  if (!r.ok) ok("BT.709-tagged source: succeeds", false, `${r.code}: ${r.message}`); else {
    const ev = evalPy("moving_object", r.file);
    ok(`BT.709-tagged source: object removed with correct colours (residual ${ev.removal.residual_ratio.toFixed(3)} ≤ 0.35, inside PSNR ${ev.removal.psnr_inside.toFixed(1)} dB ≥ 28)`, ev.pass.removed && ev.pass.red_gone && ev.removal.psnr_inside >= 28);
    ok("BT.709-tagged source: output keeps the BT.709 tag", probe(r.file).streams.find((s) => s.codec_type === "video").color_space !== "bt601", probe(r.file).streams.find((s) => s.codec_type === "video").color_space ?? "untagged");
  }
}

// ───────────── 5. limits: every one refused up front, with the right message ─────────────
const box = [{ frame: 0, box: { x: 20, y: 20, w: 30, h: 30 } }];
const lim = async (label, cfg) => { const r = await page.evaluate((c) => window.cleanScenario(c), { boxKeyframes: box, region: { x: 0, y: 0, w: 160, h: 90 }, ...cfg }); return r; };
{
  let r = await lim("long", { fixture: "../out/vc-limits/long12.mp4" });
  ok("limit: 12 s clip refused on desktop (too_long, 10 s)", !r.ok && r.code === "too_long" && /10 seconds/.test(r.message) && /Trim/.test(r.message), r.message);
  r = await lim("long range", { fixture: "../out/vc-limits/long12.mp4", range: { startFrame: 0, endFrame: 300 } });
  ok("limit: exactly 10 s (300 frames) of the long clip is accepted by the pre-flight (fails later only on the bogus mask)", !(r.code === "too_long" || r.code === "too_many_frames"), r.code);
  r = await lim("long range 301", { fixture: "../out/vc-limits/long12.mp4", range: { startFrame: 0, endFrame: 301 } });
  ok("limit: 301 frames refused (too_long)", !r.ok && r.code === "too_long");
  r = await lim("frames", { fixture: "../out/vc-limits/long12.mp4", range: { startFrame: 0, endFrame: 120 }, opts: { limits: { maxFrames: 100 } } });
  ok("limit: frame-count cap refused (too_many_frames) with the numbers", !r.ok && r.code === "too_many_frames" && /120 frames/.test(r.message) && /100/.test(r.message), r.message);
  r = await lim("fps", { fixture: "../out/vc-limits/fps60.mp4" });
  ok("limit: 60 fps refused (fps_too_high) with advice to convert", !r.ok && r.code === "fps_too_high" && /60/.test(r.message) && /30/.test(r.message), r.message);
  r = await lim("res", { fixture: "../out/vc-limits/big1440.mp4" });
  ok("limit: 2560×1440 refused (resolution_too_high) naming the sizes", !r.ok && r.code === "resolution_too_high" && /2560×1440/.test(r.message) && /1920×1080/.test(r.message), r.message);
  r = await lim("region", { fixture: "../out/vc-limits/hd1080.mp4", region: { x: 0, y: 0, w: 1920, h: 1080 } });
  ok("limit: full-HD working area refused (region_too_large, 2 MP)", !r.ok && r.code === "region_too_large" && /megapixels/.test(r.message), r.message);
  r = await lim("region budget", { fixture: "../out/vc-limits/hd1080.mp4", region: { x: 0, y: 0, w: 1600, h: 900 }, range: { startFrame: 0, endFrame: 90 }, opts: { limits: { maxRegionPixels: 2_000_000 } } });
  ok("limit: 1.4 MP area over 90 frames refused by the memory budget (region_too_large, smaller area advised)", !r.ok && r.code === "region_too_large" && /at most/.test(r.message), r.message);
  r = await lim("keyframes", { fixture: "../out/vc-limits/long12.mp4", range: { startFrame: 0, endFrame: 60 }, boxKeyframes: Array.from({ length: 9 }, (_, i) => ({ frame: i * 5, box: { x: 20, y: 20, w: 30, h: 30 } })) });
  ok("limit: 9 manual keyframes refused (too_many_keyframes)", !r.ok && r.code === "too_many_keyframes" && /limit is 8/.test(r.message), r.message);
  r = await lim("file", { fakeBytes: 51 * 1048576, info: { duration: 3, width: 320, height: 180, fps: 30, hasAudio: false, vcodec: "h264", acodec: null } });
  ok("limit: 51 MB file refused (file_too_large, 50 MB)", !r.ok && r.code === "file_too_large" && /50 MB/.test(r.message), r.message);
  r = await lim("mobile long", { fixture: "../out/vc-limits/long12.mp4", range: { startFrame: 0, endFrame: 180 }, opts: { mobile: true } });
  ok("limit: mobile profile refuses 6 s (too_long, 5 s)", !r.ok && r.code === "too_long" && /5 seconds/.test(r.message) && /On this device/.test(r.message), r.message);
  r = await lim("mobile res", { fixture: "../out/vc-limits/hd1080.mp4", opts: { mobile: true } });
  ok("limit: mobile profile refuses 1080p (resolution_too_high, 1280×720)", !r.ok && r.code === "resolution_too_high" && /1280×720/.test(r.message), r.message);
  r = await lim("slow", { fixture: "../out/vc-limits/long12.mp4", range: { startFrame: 0, endFrame: 150 }, opts: { limits: { maxMinutes: 0.001 } } });
  ok("limit: projected time over the cap refused before any work (would_be_too_slow), no worker ever created", !r.ok && r.code === "would_be_too_slow" && /minutes/.test(r.message) && r.pool === null, r.message);
  r = await lim("sel outside", { fixture: "../out/vc-limits/long12.mp4", range: { startFrame: 0, endFrame: 30 }, region: { x: 100, y: 100, w: 100, h: 60 } });
  ok("input: selection outside the working area refused (region_invalid) with a count", !r.ok && r.code === "region_invalid" && /outside the working area/.test(r.message), r.message);
  r = await lim("region tiny", { fixture: "../out/vc-limits/long12.mp4", range: { startFrame: 0, endFrame: 30 }, region: { x: 10, y: 10, w: 4, h: 4 } });
  ok("input: tiny working area refused (region_invalid)", !r.ok && r.code === "region_invalid");
  r = await lim("no kf", { fixture: "../out/vc-limits/long12.mp4", range: { startFrame: 0, endFrame: 30 }, boxKeyframes: [] });
  ok("input: no keyframe refused (bad_input)", !r.ok && r.code === "bad_input" && /Mark the object/.test(r.message));
  r = await lim("bad range", { fixture: "../out/vc-limits/long12.mp4", range: { startFrame: 50, endFrame: 20 } });
  ok("input: reversed range refused (bad_input)", !r.ok && r.code === "bad_input");
  r = await lim("444", { fixture: "../out/vc-limits/yuv444.mp4", region: { x: 0, y: 0, w: 320, h: 180 } });
  ok("format: 4:4:4 video refused (unsupported) with an explanation", !r.ok && r.code === "unsupported" && /4:2:0/.test(r.message), r.message);
  r = await lim("corrupt", { fixture: "../out/vc-limits/trunc.mp4", info: { duration: 6, width: 640, height: 360, fps: 30, hasAudio: true, vcodec: "h264", acodec: "aac" }, region: { x: 0, y: 0, w: 320, h: 180 }, range: { startFrame: 0, endFrame: 60 } });
  ok("corrupt: truncated file refused (corrupt), nothing produced, workers gone", !r.ok && (r.code === "corrupt" || r.code === "unsupported" || r.code === "failed") && r.pool?.alive === 0, `${r.code}: ${r.message}`);
  r = await lim("fake", { fixture: "fake.mp4", info: { duration: 3, width: 640, height: 360, fps: 30, hasAudio: false, vcodec: "h264", acodec: null }, region: { x: 0, y: 0, w: 320, h: 180 }, range: { startFrame: 0, endFrame: 30 } });
  ok("corrupt: a text file named .mp4 refused with a clear message (corrupt/unsupported)", !r.ok && (r.code === "corrupt" || r.code === "unsupported") && r.pool?.alive === 0, `${r.code}: ${r.message}`);
}

// ───────────── 6. faults and cancel: reliable cleanup, then a fresh run works ─────────────
async function fresh(label) {
  const r = await run(label, { name: "moving_object", region: regionFor("moving_object"), keyframes: kf0, range: { startFrame: 0, endFrame: 45 } });
  return r.ok && r.status === "ok" && r.hook.outsideDiff === 0;
}
{
  const base = { name: "moving_object", region: regionFor("moving_object"), keyframes: kf0 };
  for (const [phase, kind, code] of [["extract", "oom", "memory"], ["clean", "oom", "memory"], ["encode", "error", "failed"], ["track", "oom", "memory"], ["join", "error", "failed"]]) {
    const r = await run(`fault_${phase}`, { ...base, range: { startFrame: 0, endFrame: 45 }, opts: { debug: { fail: { phase, kind } } } });
    ok(`simulated ${kind === "oom" ? "out-of-memory" : "failure"} in '${phase}': clear ${code} error, no output, workers gone, original unchanged`, !r.ok && r.code === code && !r.b64 && r.pool?.alive === 0 && r.shaBefore === r.shaAfter && /Nothing was (changed|saved)|memory|couldn't|failed/i.test(r.message), `${r.code}: ${r.message?.slice(0, 90)}`);
    ok(`after the '${phase}' fault the SAME engine runs a new job successfully (45 frames, outside identical)`, await fresh(`after_${phase}`));
  }
  // cancel during extraction, during cleaning (workers busy), and during tracking
  for (const [label, abort, clip] of [["extract", { phase: "extract", afterMs: 200 }, "long_track"], ["track", { phase: "track", afterMs: 100 }, "long_track"], ["clean", { phase: "clean", minFraction: 0.2, afterMs: 150 }, "long_track"]]) {
    const before = workerTargets();
    const r = await run(`cancel_${label}`, { name: clip, region: regionFor(clip), keyframes: kf0, abort });
    await new Promise((s) => setTimeout(s, 300));
    ok(`cancel during '${label}': rejected as 'cancelled' within 2 s of the request (${r.rejectMs === null ? "n/a" : Math.round(r.rejectMs)} ms)`, !r.ok && r.code === "cancelled" && r.rejectMs !== null && r.rejectMs < 2000);
    ok(`cancel during '${label}': every worker terminated (pool ${r.pool?.alive}, browser workers ${workerTargets()} vs ${before} before), ffmpeg engine torn down`, r.pool?.alive === 0 && r.pool?.terminated && r.engineReady === false && workerTargets() <= before);
    ok(`cancel during '${label}': no output, original file unchanged (SHA-256)`, !r.b64 && r.shaBefore === r.shaAfter && sha(FIX + `video-cleanup/${clip}/input.mp4`) === shaBeforeAll[clip]);
    bench.push({ scenario: `cancel during ${label}`, rejectMs: Math.round(r.rejectMs ?? -1) });
    ok(`after the cancel during '${label}' a new run succeeds on the same engine`, await fresh(`after_cancel_${label}`));
  }
  // slower than projected: stop and say so
  const s = await run("too_slow", { ...base, range: { startFrame: 0, endFrame: 90 }, opts: { debug: { delayMsPerChunk: 2500, timeModelScale: 0.02, slowFloorMs: 1000 } } });
  ok("a run far slower than projected is stopped (too_slow) with a plain explanation, nothing produced", !s.ok && s.code === "too_slow" && /longer than expected/.test(s.message) && !s.b64 && s.pool?.alive === 0, `${s.code}: ${s.message?.slice(0, 80)}`);
}

// final: all originals byte-identical on disk
ok("all original fixtures byte-identical on disk after the whole suite", Object.entries(shaBeforeAll).every(([n, h]) => sha(FIX + `video-cleanup/${n}/input.mp4`) === h));

writeFileSync(ROOT + "tests/out/vc-m4-bench.json", JSON.stringify(bench, null, 1));
console.log("\nBENCH (real Chrome + ffmpeg.wasm, this sandbox)"); console.table(bench.map((b) => ({ scenario: b.scenario, frames: b.frames ?? "", "total ms": b.totalMs ?? "", est: b.estimateMs ?? "", extract: b.ms?.extract ?? "", track: b.ms?.track ?? "", clean: b.ms?.clean ?? "", join: b.ms?.join ?? "", "heap MB": b.jsHeapPeakMB ?? "", "chrome RSS peak MB": b.chromeRssPeakMB ?? "", "base MB": b.chromeRssBaseMB ?? "", "cancel ms": b.rejectMs ?? "" })));
console.log(`\n${total - bad}/${total} passed${bad ? "  FAILED: " + failures.join("; ") : ""}`);
await browser.close(); server.stop();
process.exit(bad ? 1 : 0);
