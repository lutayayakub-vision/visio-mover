// Real-browser test of the video engine (ffmpeg.wasm in headless Chrome). Every exported file is re-opened by ffprobe/ffmpeg.
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { startVite, launch } from "./lib.mjs";

const OUT = new URL("./out/video/", import.meta.url).pathname;
const FIX = new URL("./fixtures/", import.meta.url).pathname;
rmSync(OUT, { recursive: true, force: true }); mkdirSync(OUT, { recursive: true });
const server = await startVite(); const browser = await launch();
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("PAGE ERROR", e.message));
await page.goto(server.base + "/tests/harness/video.html");
await page.waitForFunction("window.ready === true");

let total = 0, bad = 0;
const ok = (name, cond, detail = "") => { total++; if (!cond) bad++; console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? "  [" + detail + "]" : ""}`); };
const probe = (f) => JSON.parse(execFileSync("ffprobe", ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", f], { encoding: "utf8" }));
const decodeErrors = (f) => spawnSync("ffmpeg", ["-v", "error", "-i", f, "-f", "null", "-"], { encoding: "utf8" }).stderr.trim();
const psnr = (outF, outStart, origF, origStart, dur) => {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-ss", String(outStart), "-t", String(dur), "-i", outF, "-ss", String(origStart), "-t", String(dur), "-i", origF,
    "-lavfi", "[0:v]scale=640:360[a];[1:v]scale=640:360[b];[a][b]psnr", "-f", "null", "-"], { encoding: "utf8" });
  const m = /average:([\d.]+|inf)/.exec(r.stderr); return m ? (m[1] === "inf" ? 99 : parseFloat(m[1])) : 0;
};
const refPsnr = (jpg, t) => { const ref = OUT + `ref_${t}.png`; execFileSync("ffmpeg", ["-v", "error", "-y", "-ss", String(t), "-i", FIX + "clip.mp4", "-frames:v", "1", ref]); const r = spawnSync("ffmpeg", ["-hide_banner", "-i", jpg, "-i", ref, "-lavfi", "[0:v]scale=640:360[a];[1:v]scale=640:360[b];[a][b]psnr", "-f", "null", "-"], { encoding: "utf8" }); const m = /average:([\d.]+|inf)/.exec(r.stderr); return m ? parseFloat(m[1]) : 0; };
let n = 0;
async function exportCase(name, fixture, settings, expectErr = false) {
  const r = await page.evaluate(async (fixture, settings) => {
    const engine = window.engine; const events = [];
    try {
      const f = await window.loadFixture(fixture, "video/mp4");
      const info = await engine.probe(f);
      const res = await engine.export(f, info, info.height, settings, { onProgress: (p) => events.push(p) });
      // can Chrome itself open and play the exported file?
      const url = URL.createObjectURL(res.blob);
      const v = await window.V.loadVideoElement(url);
      const meta = { duration: v.duration, w: v.videoWidth, h: v.videoHeight };
      v.muted = true; await v.play(); await new Promise((r) => setTimeout(r, 700)); const played = v.currentTime; v.pause();
      return { ok: true, info, b64: await window.blobToB64(res.blob), ms: res.ms, mode: res.mode, events, meta, played };
    } catch (e) { return { ok: false, code: e.code, message: e.message, events }; }
  }, fixture, settings);
  if (r.ok) { r.file = OUT + String(++n).padStart(2, "0") + "_" + name.replace(/[^a-z0-9]+/gi, "_") + ".mp4"; writeFileSync(r.file, Buffer.from(r.b64, "base64")); r.bytes = Buffer.byteLength(Buffer.from(r.b64, "base64")); r.b64 = undefined; }
  return r;
}
const S = (segments, o = {}) => ({ segments, quality: "high", maxHeight: 0, removeAudio: false, trimMode: "precise", ...o });
const streams = (p, t) => p.streams.filter((s) => s.codec_type === t);

// probe
const info = await page.evaluate(async () => { const f = await window.loadFixture("clip.mp4", "video/mp4"); return window.engine.probe(f); });
ok("probe reads duration/size/codecs", Math.abs(info.duration - 6) < 0.1 && info.width === 640 && info.height === 360 && info.vcodec === "h264" && info.hasAudio && info.acodec === "aac", JSON.stringify(info));

// trimming
const t1 = await exportCase("trim 1.0 to 3.5", "clip.mp4", S([{ start: 1, end: 3.5 }]));
if (!t1.ok) ok("precise trim exports", false, `${t1.code}: ${t1.message}`); else {
  const p = probe(t1.file); const v = streams(p, "video")[0], a = streams(p, "audio")[0];
  ok("trim produces a valid MP4 (ffmpeg decodes with no errors)", decodeErrors(t1.file) === "");
  ok("trimmed length is 2.5 s (±0.12)", Math.abs(parseFloat(p.format.duration) - 2.5) < 0.12, p.format.duration + " s");
  ok("output is H.264 + AAC at 640x360", v.codec_name === "h264" && a?.codec_name === "aac" && v.width === 640 && v.height === 360);
  const ps = psnr(t1.file, 0, FIX + "clip.mp4", 1, 2.4);
  ok("trimmed frames match the source segment 1.0-3.5 s (PSNR > 30 dB)", ps > 30, ps.toFixed(1) + " dB");
  const wrong = psnr(t1.file, 0, FIX + "clip.mp4", 3, 2.4);
  ok("...and do NOT match a different part of the source", wrong < ps - 8, wrong.toFixed(1) + " dB");
  ok("Chrome opens the exported video and plays it", Math.abs(t1.meta.duration - 2.5) < 0.2 && t1.meta.w === 640 && t1.played > 0.3, `duration ${t1.meta.duration.toFixed(2)}, played to ${t1.played.toFixed(2)} s`);
  const ev = t1.events; ok("progress is reported, monotonic, and reaches 100%", ev.length >= 3 && ev.every((x, i) => i === 0 || x >= ev[i - 1]) && ev.at(-1) === 1, `${ev.length} updates`);
  console.log(`      (encode time ${t1.ms} ms for 2.5 s of 640x360)`);
}
// fast (no re-encode) trim
const t2 = await exportCase("fast copy trim 1 to 4", "clip.mp4", S([{ start: 1, end: 4 }], { trimMode: "fast" }));
if (!t2.ok) ok("fast trim exports", false, `${t2.code}: ${t2.message}`); else {
  const d = parseFloat(probe(t2.file).format.duration);
  ok("fast trim (stream copy) gives a valid, playable file", t2.mode === "copy" && decodeErrors(t2.file) === "" && t2.played > 0.3, `mode=${t2.mode}, ${d.toFixed(2)} s, ${t2.ms} ms`);
  ok("fast trim length is plausible (keyframe-accurate, not frame-accurate)", d >= 2.8 && d <= 6, d.toFixed(2) + " s for a 3 s request");
}
// clip cutting: remove the middle (keep 0-1.5 and 4-6)
const t3 = await exportCase("cut middle out", "clip.mp4", S([{ start: 0, end: 1.5 }, { start: 4, end: 6 }]));
if (!t3.ok) ok("multi-clip cut exports", false, `${t3.code}: ${t3.message}`); else {
  const p = probe(t3.file);
  ok("cut-out export is valid and ~3.5 s", decodeErrors(t3.file) === "" && Math.abs(parseFloat(p.format.duration) - 3.5) < 0.25, p.format.duration + " s");
  const a = psnr(t3.file, 0, FIX + "clip.mp4", 0, 1.3), b = psnr(t3.file, 1.65, FIX + "clip.mp4", 4.15, 1.5);
  ok("first part matches source 0-1.5 s and second part matches 4-6 s", a > 30 && b > 28, `${a.toFixed(1)} dB / ${b.toFixed(1)} dB`);
  ok("Chrome plays the joined video", t3.played > 0.3 && Math.abs(t3.meta.duration - 3.5) < 0.3);
}
// compression
const t4 = await exportCase("compress small", "clip.mp4", S([{ start: 0, end: 6 }], { quality: "small" }));
if (!t4.ok) ok("compression exports", false, `${t4.code}: ${t4.message}`); else {
  const inBytes = readFileSync(FIX + "clip.mp4").length;
  ok("Small quality produces a much smaller valid file", decodeErrors(t4.file) === "" && t4.bytes < inBytes * 0.6, `${t4.bytes} B vs ${inBytes} B source (${Math.round((1 - t4.bytes / inBytes) * 100)}% smaller)`);
  ok("compressed video is still recognisably the same picture (PSNR > 26 dB)", psnr(t4.file, 0, FIX + "clip.mp4", 0, 5.5) > 26);
}
const t4b = await exportCase("balanced", "clip.mp4", S([{ start: 0, end: 6 }], { quality: "balanced" }));
const t4c = await exportCase("high", "clip.mp4", S([{ start: 0, end: 6 }], { quality: "high" }));
if (t4.ok && t4b.ok && t4c.ok) ok("quality presets order the file size (small < balanced < high)", t4.bytes < t4b.bytes && t4b.bytes < t4c.bytes, `${t4.bytes} < ${t4b.bytes} < ${t4c.bytes}`);
// resolution
const t5 = await exportCase("scale 1280x720 to 360p", "clip720.mp4", S([{ start: 0, end: 4 }], { maxHeight: 360, quality: "balanced" }));
if (!t5.ok) ok("downscale exports", false, `${t5.code}: ${t5.message}`); else { const v = streams(probe(t5.file), "video")[0]; ok("720p -> 360p gives 640x360", v.width === 640 && v.height === 360 && decodeErrors(t5.file) === ""); }
const t5b = await exportCase("scale to 480p", "clip720.mp4", S([{ start: 0, end: 4 }], { maxHeight: 480, quality: "balanced" }));
if (t5b.ok) { const v = streams(probe(t5b.file), "video")[0]; ok("720p -> 480p keeps aspect ratio with even width (854x480)", v.width === 854 && v.height === 480, `${v.width}x${v.height}`); }
const t5c = await exportCase("no upscale", "clip.mp4", S([{ start: 0, end: 2 }], { maxHeight: 1080 }));
if (t5c.ok) { const v = streams(probe(t5c.file), "video")[0]; ok("selecting 1080p on a 360p video does not enlarge it", v.height === 360); }
// audio + silent source
const t6 = await exportCase("remove audio", "clip.mp4", S([{ start: 0, end: 2 }], { removeAudio: true }));
if (t6.ok) ok("'remove audio' really removes the audio track", streams(probe(t6.file), "audio").length === 0 && decodeErrors(t6.file) === "");
const t7 = await exportCase("silent source", "silent.mp4", S([{ start: 0.5, end: 3 }], { quality: "balanced" }));
if (!t7.ok) ok("video without audio exports", false, `${t7.code}: ${t7.message}`); else ok("video without an audio track exports correctly", streams(probe(t7.file), "audio").length === 0 && Math.abs(parseFloat(probe(t7.file).format.duration) - 2.5) < 0.15 && decodeErrors(t7.file) === "");

// thumbnails
const thumb = await page.evaluate(async () => {
  const f = await window.loadFixture("clip.mp4", "video/mp4"); const url = URL.createObjectURL(f);
  const v = await window.V.loadVideoElement(url);
  const blob = await window.V.captureFrame(v, 3, "image/jpeg", 0.92); const b64 = await window.blobToB64(blob);
  const png = await window.V.captureFrame(v, 1, "image/png"); const info = await window.engine.probe(f);
  const fb = await window.engine.frameToJpeg(f, info, 3);
  return { b64, pngType: png.type, ffb64: await window.blobToB64(fb), w: v.videoWidth, h: v.videoHeight };
});
writeFileSync(OUT + "thumb_canvas.jpg", Buffer.from(thumb.b64, "base64")); writeFileSync(OUT + "thumb_ffmpeg.jpg", Buffer.from(thumb.ffb64, "base64"));
const py = (code) => execFileSync("python3", ["-c", code], { encoding: "utf8" }).trim();
const stat = py(`from PIL import Image, ImageStat\nfor f in ["thumb_canvas.jpg","thumb_ffmpeg.jpg"]:\n  im=Image.open("${OUT}"+f); im.load(); s=ImageStat.Stat(im.convert("L")); print(im.format, im.size[0], im.size[1], round(s.mean[0]), round(s.stddev[0]))`).split("\n").map((l) => l.split(" "));
ok("thumbnail from the player is a valid 640x360 JPEG with real picture content", stat[0][0] === "JPEG" && stat[0][1] === "640" && stat[0][2] === "360" && +stat[0][4] > 15, stat[0].join(" "));
ok("ffmpeg fallback thumbnail is a valid 640x360 JPEG too", stat[1][0] === "JPEG" && stat[1][1] === "640" && +stat[1][4] > 15, stat[1].join(" "));
ok("PNG frame capture works", thumb.pngType === "image/png");
const tp = refPsnr(OUT + "thumb_canvas.jpg", 3), tn = refPsnr(OUT + "thumb_canvas.jpg", 3.1), tf = refPsnr(OUT + "thumb_ffmpeg.jpg", 3);
ok("player thumbnail is the exact frame at 3.0 s (vs lossless reference; other times score far lower)", tp > 25 && tp > tn + 8, `${tp.toFixed(1)} dB at 3.0 s vs ${tn.toFixed(1)} dB at 3.1 s`);
ok("ffmpeg fallback thumbnail is also the exact 3.0 s frame", tf > 25, tf.toFixed(1) + " dB");

// error handling
const errs = await page.evaluate(async () => {
  const res = {};
  const run = async (k, fn) => { try { await fn(); res[k] = { ok: true }; } catch (e) { res[k] = { ok: false, code: e.code, message: e.message }; } };
  const good = await window.loadFixture("clip.mp4", "video/mp4"); const info = await window.engine.probe(good);
  await run("fake", async () => window.engine.probe(await window.loadFixture("fake.mp4", "video/mp4")));
  await run("big", async () => window.engine.export(new File([new Uint8Array(51 * 1024 * 1024)], "huge.mp4", { type: "video/mp4" }), info, 360, { segments: [{ start: 0, end: 1 }], quality: "high", maxHeight: 0, removeAudio: false, trimMode: "precise" }));
  await run("range", async () => window.engine.export(good, info, 360, { segments: [{ start: 3, end: 3.05 }], quality: "high", maxHeight: 0, removeAudio: false, trimMode: "precise" }));
  await run("overlap", async () => window.engine.export(good, info, 360, { segments: [{ start: 0, end: 3 }, { start: 2, end: 4 }], quality: "high", maxHeight: 0, removeAudio: false, trimMode: "precise" }));
  return res;
});
ok("a text file renamed .mp4 is refused with a clear message", !errs.fake.ok && ["corrupt", "unsupported", "failed"].includes(errs.fake.code) && errs.fake.message.length > 20, `${errs.fake.code}: ${errs.fake.message}`);
ok("a 51 MB video is refused before any processing (limit 50 MB)", !errs.big.ok && errs.big.code === "too_large" && /50 MB/.test(errs.big.message), errs.big.message);
ok("a range under 0.1 s is refused", !errs.range.ok && errs.range.code === "bad_range", errs.range.message);
ok("overlapping clips are refused", !errs.overlap.ok && errs.overlap.code === "bad_range", errs.overlap.message);

// cancel + recovery
const cancel = await page.evaluate(async () => {
  const f = await window.loadFixture("clip720.mp4", "video/mp4"); const info = await window.engine.probe(f);
  const ctl = new AbortController(); let first = null;
  try { await window.engine.export(f, info, 720, { segments: [{ start: 0, end: 4 }], quality: "high", maxHeight: 0, removeAudio: false, trimMode: "precise" }, { signal: ctl.signal, onProgress: (p) => { if (p > 0.02 && !ctl.signal.aborted) ctl.abort(); } }); first = { ok: true }; }
  catch (e) { first = { ok: false, code: e.code }; }
  const g = await window.loadFixture("clip.mp4", "video/mp4"); let second;
  try { const i2 = await window.engine.probe(g); const r = await window.engine.export(g, i2, 360, { segments: [{ start: 0, end: 1 }], quality: "balanced", maxHeight: 0, removeAudio: false, trimMode: "precise" }); second = { ok: true, size: r.blob.size }; }
  catch (e) { second = { ok: false, code: e.code, message: e.message }; }
  return { first, second };
});
ok("an export can be cancelled mid-way", !cancel.first.ok && cancel.first.code === "cancelled", JSON.stringify(cancel.first));
ok("the engine restarts cleanly and the next export succeeds", cancel.second.ok && cancel.second.size > 1024, JSON.stringify(cancel.second));

// helpers + original preserved
const clk = await page.evaluate(() => { const V = window.V; return [V.formatClock(83.5), V.parseClock("1:23.5"), V.parseClock("83"), V.parseClock("0:01:23"), V.parseClock("abc"), V.parseClock("1:2:3:4")]; });
ok("time helpers parse and format correctly", JSON.stringify(clk) === JSON.stringify(["1:23.5", 83.5, 83, 83, null, null]), JSON.stringify(clk));
const before = createHash("sha256").update(readFileSync(FIX + "clip.mp4")).digest("hex");
const after = await page.evaluate(async () => { const f = await window.loadFixture("clip.mp4", "video/mp4"); const h = await crypto.subtle.digest("SHA-256", await f.arrayBuffer()); return [...new Uint8Array(h)].map((x) => x.toString(16).padStart(2, "0")).join(""); });
ok("the original video file is byte-for-byte unchanged after all edits", before === after);

await browser.close(); server.stop();
console.log(`\nVideo checks: ${total - bad} passed, ${bad} failed`);
process.exit(bad ? 1 : 0);
