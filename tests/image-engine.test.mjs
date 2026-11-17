// Real-browser test of the image engine. Exports are written to tests/out and then verified by PIL (verify_image.py).
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { startVite, launch } from "./lib.mjs";

const OUT = new URL("./out/image/", import.meta.url).pathname;
let caseNo = 0;
rmSync(OUT, { recursive: true, force: true }); mkdirSync(OUT, { recursive: true });
const server = await startVite();
const browser = await launch();
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("PAGE ERROR", e.message));
await page.goto(server.base + "/tests/harness/image.html");
await page.waitForFunction("window.ready === true");

let logical = 0, logicalFail = 0;
const ok = (name, cond, detail = "") => { logical++; if (!cond) logicalFail++; console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? "  [" + detail + "]" : ""}`); };
const manifest = [];

/** Runs an export in the page and records the resulting file for PIL verification. */
async function exportCase(name, fixture, mime, ops, settings, expect = {}, profile = null) {
  const r = await page.evaluate(async (fixture, mime, ops, settings, profile) => {
    try {
      const f = await window.loadFixture(fixture, mime);
      const dec = await window.E.decodeImage(f, profile ?? undefined);
      const events = [];
      const res = await window.E.exportImage(dec.bitmap, { ...window.E.DEFAULT_OPS, ...ops }, settings, { onProgress: (p) => events.push(p), profile: profile ?? undefined });
      return { ok: true, b64: await window.blobToB64(res.blob), w: res.width, h: res.height, mime: res.mime, ms: res.ms, limited: res.limited, events };
    } catch (e) { return { ok: false, code: e.code, message: e.message }; }
  }, fixture, mime, ops, settings, profile);
  if (!r.ok) { ok(name, false, `${r.code}: ${r.message}`); return r; }
  const file = OUT + String(++caseNo).padStart(2, "0") + "_" + name.replace(/[^a-z0-9]+/gi, "_") + "." + (settings.format === "jpeg" ? "jpeg" : settings.format);
  const bytes = Buffer.from(r.b64, "base64"); writeFileSync(file, bytes);
  manifest.push({ name, file, bytes: bytes.length, ...expect });
  r.bytes = bytes.length;
  return r;
}

const RED = [255, 0, 0], GRN = [0, 255, 0], BLU = [0, 0, 255], YEL = [255, 255, 0];
const q4 = (w, h, tl, tr, bl, br) => [
  { xy: [Math.round(w * 0.25), Math.round(h * 0.25)], rgb: tl }, { xy: [Math.round(w * 0.75), Math.round(h * 0.25)], rgb: tr },
  { xy: [Math.round(w * 0.25), Math.round(h * 0.75)], rgb: bl }, { xy: [Math.round(w * 0.75), Math.round(h * 0.75)], rgb: br }];
const PNG = { format: "png", quality: 1 };

// 1-5 rotation and flipping (pixel-exact quadrant checks on a lossless PNG)
await exportCase("rotate 90 cw", "quad.png", "image/png", { rotate: 90 }, PNG, { format: "PNG", size: [300, 400], pixels: q4(300, 400, BLU, RED, YEL, GRN) });
await exportCase("rotate 180", "quad.png", "image/png", { rotate: 180 }, PNG, { format: "PNG", size: [400, 300], pixels: q4(400, 300, YEL, BLU, GRN, RED) });
await exportCase("rotate 270", "quad.png", "image/png", { rotate: 270 }, PNG, { format: "PNG", size: [300, 400], pixels: q4(300, 400, GRN, YEL, RED, BLU) });
await exportCase("flip horizontal", "quad.png", "image/png", { flipH: true }, PNG, { format: "PNG", size: [400, 300], pixels: q4(400, 300, GRN, RED, YEL, BLU) });
await exportCase("flip vertical", "quad.png", "image/png", { flipV: true }, PNG, { format: "PNG", size: [400, 300], pixels: q4(400, 300, BLU, YEL, RED, GRN) });
await exportCase("flip both = rotate 180", "quad.png", "image/png", { flipH: true, flipV: true }, PNG, { format: "PNG", size: [400, 300], pixels: q4(400, 300, YEL, BLU, GRN, RED) });
await exportCase("rotate 90 then flip horizontal", "quad.png", "image/png", { rotate: 90, flipH: true }, PNG, { format: "PNG", size: [300, 400], pixels: q4(300, 400, RED, BLU, GRN, YEL) });

// 6-7 cropping
await exportCase("crop top-right quadrant", "quad.png", "image/png", { crop: { x: 0.5, y: 0, w: 0.5, h: 0.5 } }, PNG,
  { format: "PNG", size: [200, 150], pixels: [{ xy: [5, 5], rgb: GRN }, { xy: [100, 75], rgb: GRN }, { xy: [195, 145], rgb: GRN }] });
await exportCase("rotate 90 then crop right half", "quad.png", "image/png", { rotate: 90, crop: { x: 0.5, y: 0, w: 0.5, h: 1 } }, PNG,
  { format: "PNG", size: [150, 400], pixels: [{ xy: [75, 100], rgb: RED }, { xy: [75, 300], rgb: GRN }] });

// 8 resize with aspect ratio
await exportCase("resize 200x150", "quad.png", "image/png", { resize: { width: 200, height: 150 } }, PNG, { format: "PNG", size: [200, 150], pixels: q4(200, 150, RED, GRN, BLU, YEL) });
await exportCase("crop + resize", "quad.png", "image/png", { crop: { x: 0, y: 0, w: 0.5, h: 0.5 }, resize: { width: 100, height: 75 } }, PNG, { format: "PNG", size: [100, 75], pixels: [{ xy: [50, 37], rgb: RED }] });
const fit = await page.evaluate(() => [window.E.fitKeepingAspect(400, 300, { width: 200 }), window.E.fitKeepingAspect(400, 300, { height: 90 }), window.E.fitKeepingAspect(333, 111, { width: 100 })]);
ok("aspect-ratio helper keeps proportions", JSON.stringify(fit) === JSON.stringify([{ width: 200, height: 150 }, { width: 120, height: 90 }, { width: 100, height: 33 }]), JSON.stringify(fit));

// 9-11 colour adjustments (maths verified against known source values)
await exportCase("brightness +50 on gray 100", "gray.png", "image/png", { brightness: 50 }, PNG, { format: "PNG", pixels: [{ xy: [50, 50], rgb: [150, 150, 150], tol: 2 }] });
await exportCase("brightness -50 on gray 100", "gray.png", "image/png", { brightness: -50 }, PNG, { format: "PNG", pixels: [{ xy: [50, 50], rgb: [50, 50, 50], tol: 2 }] });
await exportCase("contrast +50 on gray 100", "gray.png", "image/png", { contrast: 50 }, PNG, { format: "PNG", pixels: [{ xy: [50, 50], rgb: [86, 86, 86], tol: 2 }] });
await exportCase("saturation -100 = grayscale", "quad.png", "image/png", { saturation: -100 }, PNG, { format: "PNG", pixels: [{ xy: [100, 75], rgb: [54, 54, 54], tol: 2 }, { xy: [300, 75], rgb: [182, 182, 182], tol: 2 }] });
await exportCase("no-op edits leave pixels untouched", "quad.png", "image/png", {}, PNG, { format: "PNG", size: [400, 300], pixels: q4(400, 300, RED, GRN, BLU, YEL) , });

// 7/12 compression + quality
const hi = await exportCase("jpeg quality 90", "photo.jpg", "image/jpeg", {}, { format: "jpg", quality: 0.9 }, { format: "JPEG", size: [1200, 800] });
const lo = await exportCase("jpeg quality 40", "photo.jpg", "image/jpeg", {}, { format: "jpg", quality: 0.4 }, { format: "JPEG", size: [1200, 800] });
ok("lower quality gives a smaller file", lo.ok && hi.ok && lo.bytes < hi.bytes * 0.7, `q40=${lo.bytes} B, q90=${hi.bytes} B`);
const orig = readFileSync(new URL("./fixtures/photo.jpg", import.meta.url));
const small = await exportCase("compress + downsize 600px", "photo.jpg", "image/jpeg", { resize: { width: 600, height: 400 } }, { format: "webp", quality: 0.6 }, { format: "WEBP", size: [600, 400] });
ok("compressed copy is much smaller than the original", small.ok && small.bytes < orig.length * 0.3, `${small.bytes} B vs ${orig.length} B original`);

// 8 format conversion
await exportCase("png -> jpg", "quad.png", "image/png", {}, { format: "jpg", quality: 0.95 }, { format: "JPEG", size: [400, 300], pixels: q4(400, 300, RED, GRN, BLU, YEL).map((p) => ({ ...p, tol: 14 })) });
await exportCase("png -> jpeg ext", "quad.png", "image/png", {}, { format: "jpeg", quality: 0.95 }, { format: "JPEG", size: [400, 300] });
await exportCase("png -> webp", "quad.png", "image/png", {}, { format: "webp", quality: 0.95 }, { format: "WEBP", size: [400, 300], pixels: q4(400, 300, RED, GRN, BLU, YEL).map((p) => ({ ...p, tol: 14 })) });
await exportCase("jpg -> png", "quad.jpg", "image/jpeg", {}, PNG, { format: "PNG", size: [400, 300], pixels: q4(400, 300, RED, GRN, BLU, YEL).map((p) => ({ ...p, tol: 14 })) });
await exportCase("webp -> jpg", "quad.webp", "image/webp", {}, { format: "jpg", quality: 0.9 }, { format: "JPEG", size: [400, 300] });
await exportCase("transparent png -> jpg becomes white", "alpha.png", "image/png", {}, { format: "jpg", quality: 0.9 }, { format: "JPEG", pixels: [{ xy: [10, 10], rgb: [255, 255, 255], tol: 3 }] });
await exportCase("transparent png -> png keeps alpha", "alpha.png", "image/png", {}, PNG, { format: "PNG", mode: "RGBA" });

// EXIF orientation
await exportCase("EXIF orientation 6 applied", "oriented.jpg", "image/jpeg", {}, PNG, { format: "PNG", size: [200, 300], pixels: [{ xy: [150, 75], rgb: RED, tol: 14 }, { xy: [50, 200], rgb: BLU, tol: 14 }] });

// visible-frame rotation / flip helpers (what the editor buttons use) — verified against real pixels
const seq = async (name, steps, expectColors, expectSize) => {
  const ops = await page.evaluate((steps) => { let o = window.E.DEFAULT_OPS; for (const s of steps) o = s === "cw" || s === "ccw" ? window.E.rotateVisible(o, s) : window.E.flipVisible(o, s); return o; }, steps);
  await exportCase(name, "quad.png", "image/png", ops, PNG, { format: "PNG", size: expectSize, pixels: q4(expectSize[0], expectSize[1], ...expectColors) });
};
await seq("visible: cw", ["cw"], [BLU, RED, YEL, GRN], [300, 400]);
await seq("visible: ccw", ["ccw"], [GRN, YEL, RED, BLU], [300, 400]);
await seq("visible: flip h then cw", ["h", "cw"], [YEL, GRN, BLU, RED], [300, 400]);
await seq("visible: cw then flip h", ["cw", "h"], [RED, BLU, GRN, YEL], [300, 400]);
await seq("visible: flip v then ccw", ["v", "ccw"], [YEL, GRN, BLU, RED], [300, 400]);
await seq("visible: cw cw = 180", ["cw", "cw"], [YEL, BLU, GRN, RED], [400, 300]);
await seq("visible: flip h + flip v then cw", ["h", "v", "cw"], [GRN, YEL, RED, BLU], [300, 400]);
const rtrip = await page.evaluate(() => { const E = window.E; let o = { ...E.DEFAULT_OPS, crop: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 } }; const start = JSON.stringify(o.crop); for (const s of ["cw", "h", "ccw", "v", "cw", "cw", "cw"]) o = s === "cw" || s === "ccw" ? E.rotateVisible(o, s) : E.flipVisible(o, s); o = E.rotateVisible(E.flipVisible(E.flipVisible(o, "h"), "h"), "ccw"); return { start, end: JSON.stringify(o.crop) }; });
ok("crop rectangle stays inside 0..1 through rotations/flips", (() => { const c = JSON.parse(rtrip.end); return c.x >= -1e-9 && c.y >= -1e-9 && c.x + c.w <= 1 + 1e-9 && c.y + c.h <= 1 + 1e-9 && Math.abs(c.w * c.h - 0.12) < 1e-9; })(), rtrip.end);
// the crop follows the picture: crop the red quadrant, rotate/flip, the exported pixels must still be red
const cropFollow = await page.evaluate(() => { const E = window.E; let o = { ...E.DEFAULT_OPS, crop: { x: 0, y: 0, w: 0.5, h: 0.5 } }; o = E.rotateVisible(o, "cw"); o = E.flipVisible(o, "h"); o = E.rotateVisible(o, "ccw"); return o; });
await exportCase("crop follows the image through rotate/flip", "quad.png", "image/png", cropFollow, PNG, { format: "PNG", size: [200, 150], pixels: [{ xy: [20, 20], rgb: RED }, { xy: [100, 75], rgb: RED }, { xy: [180, 130], rgb: RED }] });

// large image + progress
const big = await exportCase("24 MP photo -> 1920 wide", "big.jpg", "image/jpeg", { resize: { width: 1920, height: 1280 }, brightness: 10, contrast: 10, saturation: 10 }, { format: "jpg", quality: 0.8 }, { format: "JPEG", size: [1920, 1280] });
ok("24 MP image processed", big.ok, big.ok ? `${big.ms} ms` : "");
if (big.ok) {
  const ev = big.events;
  ok("progress is reported, monotonic and reaches 100%", ev.length >= 3 && ev.every((v, i) => i === 0 || v >= ev[i - 1]) && ev[ev.length - 1] === 1, `${ev.length} updates`);
}
const bigFull = await exportCase("24 MP full-size adjust + export", "big.jpg", "image/jpeg", { brightness: 20, saturation: -20 }, { format: "jpg", quality: 0.7 }, { format: "JPEG", size: [6000, 4000] });
ok("full-resolution 24 MP export with adjustments", bigFull.ok, bigFull.ok ? `${bigFull.ms} ms, ${bigFull.bytes} B` : "");

// limits and error handling
const err = async (fixture, mime, profile) => page.evaluate(async (fixture, mime, profile) => {
  try { const f = await window.loadFixture(fixture, mime); await window.E.decodeImage(f, profile ?? undefined); return { ok: true }; } catch (e) { return { ok: false, code: e.code, message: e.message }; }
}, fixture, mime, profile);
let e1 = await err("fake.png", "image/png"); ok("fake .png is rejected as unsupported", !e1.ok && e1.code === "unsupported", e1.message);
let e2 = await err("huge.jpg", "image/jpeg"); ok("108 MP image refused on desktop with clear message", !e2.ok && e2.code === "too_large" && /megapixels/.test(e2.message), e2.message);
let e3 = await err("big.jpg", "image/jpeg", { mobile: true, maxSourcePixels: 16_000_000, maxOutputPixels: 8_000_000, previewSide: 1100 }); ok("24 MP image refused under a phone-sized limit", !e3.ok && e3.code === "too_large" && /phone/.test(e3.message), e3.message);
const trunc = await page.evaluate(async () => { try { await window.E.decodeImage(new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0])], { type: "image/png" })); return { ok: true }; } catch (e) { return { ok: false, code: e.code, message: e.message }; } });
ok("truncated PNG header is rejected as corrupt", !trunc.ok && trunc.code === "corrupt", trunc.message);
const lim = await exportCase("output over limit is scaled down", "big.jpg", "image/jpeg", { resize: { width: 6000, height: 4000 } }, { format: "jpg", quality: 0.5 }, { format: "JPEG" }, { mobile: false, maxSourcePixels: 100e6, maxOutputPixels: 10e6, previewSide: 1600 });
ok("oversized output is reduced to the limit keeping aspect ratio", lim.ok && lim.limited && lim.w * lim.h <= 10e6 && Math.abs(lim.w / lim.h - 1.5) < 0.01, lim.ok ? `${lim.w}x${lim.h}` : "");

// cancel mid-export
const cancel = await page.evaluate(async () => {
  const f = await window.loadFixture("big.jpg", "image/jpeg"); const dec = await window.E.decodeImage(f);
  const ctl = new AbortController(); let n = 0;
  try { await window.E.exportImage(dec.bitmap, { ...window.E.DEFAULT_OPS, brightness: 30 }, { format: "jpg", quality: 0.8 }, { signal: ctl.signal, onProgress: () => { if (++n === 3) ctl.abort(); } }); return { ok: true }; }
  catch (e) { return { ok: false, code: e.code }; }
});
ok("export can be cancelled while running", !cancel.ok && cancel.code === "cancelled");

// original preserved
const sha = (b) => createHash("sha256").update(b).digest("hex");
const before = sha(orig);
const after = await page.evaluate(async () => { const f = await window.loadFixture("photo.jpg", "image/jpeg"); const dec = await window.E.decodeImage(f); await window.E.exportImage(dec.bitmap, { ...window.E.DEFAULT_OPS, rotate: 90, brightness: 40 }, { format: "png", quality: 1 }); const u = new Uint8Array(await f.arrayBuffer()); const h = await crypto.subtle.digest("SHA-256", u); return [...new Uint8Array(h)].map((x) => x.toString(16).padStart(2, "0")).join(""); });
ok("original file bytes are unchanged after editing", before === after);

writeFileSync(OUT + "manifest.json", JSON.stringify(manifest, null, 1));
await browser.close(); server.stop();

console.log("\n--- independent verification of exported files (PIL) ---");
let pilOk = true;
try { console.log(execFileSync("python3", [new URL("./verify_image.py", import.meta.url).pathname, OUT + "manifest.json"], { encoding: "utf8" })); } catch (e) { pilOk = false; console.log(e.stdout); }
console.log(`Engine checks: ${logical - logicalFail} passed, ${logicalFail} failed`);
process.exit(logicalFail || !pilOk ? 1 : 0);
