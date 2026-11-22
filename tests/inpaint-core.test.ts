// Unit tests for the inpainting core and the selection-stroke mask (pure code, runs in Node).  npm run test:inpaint
import { createHash } from "node:crypto";
import { inpaintRoi, InpaintError } from "../src/lib/inpaint/core.ts";
import { rasterMask, strokeBounds, maskBounds, maskCount, describeStrokes, type Stroke } from "../src/lib/inpaint/strokes.ts";
import { stripes, bricks, scene, discMask, withObject, mae, meanFill } from "./helpers/synth.ts";

let total = 0, bad = 0;
const ok = (name: string, cond: boolean, detail = "") => { total++; if (!cond) bad++; console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  [" + detail + "]" : ""}`); };
const sha = (a: ArrayBufferView) => createHash("sha256").update(Buffer.from(a.buffer, a.byteOffset, a.byteLength)).digest("hex");
const errCode = (fn: () => unknown): string => { try { fn(); return "no error"; } catch (e) { return e instanceof InpaintError ? e.code : "other:" + (e as Error).message; } };

// ───────── mask creation and editing ─────────
{
  const W = 200, H = 120, full = { x: 0, y: 0, w: W, h: H };
  const dot: Stroke = { erase: false, r: 10, pts: [100, 60] };
  const m = rasterMask([dot], full);
  const area = maskCount(m);
  ok("Brush dot makes a disc of the right area", Math.abs(area - Math.PI * 100) < 0.06 * Math.PI * 100, `${area} px vs ${(Math.PI * 100).toFixed(0)}`);

  const line = (r: number): Stroke => ({ erase: false, r, pts: [30, 60, 170, 60] });
  const small = rasterMask([line(5)], full), big = rasterMask([line(15)], full);
  let superset = true; for (let i = 0; i < small.length; i++) if (small[i] && !big[i]) superset = false;
  ok("Brush-size change: larger brush covers everything the smaller one did", superset);
  const cap = (r: number) => 2 * r * 140 + Math.PI * r * r; // exact capsule area for a 140 px long stroke
  ok("Brush-size change: areas match the exact capsule geometry for radius 5 and 15 (within 3%)", Math.abs(maskCount(small) / cap(5) - 1) < 0.03 && Math.abs(maskCount(big) / cap(15) - 1) < 0.03, `${maskCount(small)} vs ${cap(5).toFixed(0)}, ${maskCount(big)} vs ${cap(15).toFixed(0)}`);
  const tiny = rasterMask([{ erase: false, r: 0.2, pts: [50, 50] }], full);
  ok("Smallest brush still selects at least one pixel", maskCount(tiny) >= 1);

  const painted: Stroke = { erase: false, r: 20, pts: [60, 60, 140, 60] };
  const eraser: Stroke = { erase: true, r: 8, pts: [100, 60] };
  const withErase = rasterMask([painted, eraser], full);
  ok("Eraser removes selection under it", withErase[60 * W + 100] === 0 && withErase[60 * W + 70] === 255);
  ok("Eraser only removes what it touches", maskCount(rasterMask([painted], full)) - maskCount(withErase) > 100 && maskCount(rasterMask([painted], full)) - maskCount(withErase) < 260);
  ok("A later paint stroke re-adds an erased spot", rasterMask([painted, eraser, { erase: false, r: 10, pts: [100, 60] }], full)[60 * W + 100] === 255);
  ok("An eraser with nothing under it changes nothing", sha(rasterMask([painted, { erase: true, r: 5, pts: [10, 10] }], full)) === sha(rasterMask([painted], full)));

  const strokes = [painted, eraser, { erase: false, r: 6, pts: [20, 20, 40, 30] }];
  ok("Undo = dropping the last stroke restores the earlier mask exactly", sha(rasterMask(strokes.slice(0, 2), full)) === sha(withErase));
  ok("Redo = putting it back restores the later mask exactly", sha(rasterMask([...strokes.slice(0, 2), strokes[2]], full)) === sha(rasterMask(strokes, full)));

  const sb = strokeBounds([painted], W, H)!, mb = maskBounds(rasterMask([painted], full), W, H)!;
  ok("strokeBounds contains the whole selection", sb.x <= mb.x && sb.y <= mb.y && sb.x + sb.w >= mb.x + mb.w && sb.y + sb.h >= mb.y + mb.h);
  ok("maskBounds is tight (x 40..159, y 40..79)", mb.x === 40 && mb.w === 120 && mb.y === 40 && mb.h === 40, JSON.stringify(mb));
  ok("Eraser-only strokes select nothing", strokeBounds([eraser], W, H) === null && maskBounds(rasterMask([eraser], full), W, H) === null);
  ok("Strokes outside the image are clipped safely", maskCount(rasterMask([{ erase: false, r: 30, pts: [-20, -20, 5, 5] }], full)) > 0 && strokeBounds([{ erase: false, r: 30, pts: [-500, -500] }], W, H) === null);

  // resolution independence (preview mask vs full-size mask)
  const half = rasterMask([painted, eraser], { x: 0, y: 0, w: W / 2, h: H / 2 }, 0.5);
  let inter = 0, uni = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const a = withErase[y * W + x] > 127, b = half[((y >> 1) * (W / 2)) + (x >> 1)] > 127; if (a && b) inter++; if (a || b) uni++; }
  ok("Mask at half resolution matches the full-size mask (IoU > 0.93)", inter / uni > 0.93, (inter / uni).toFixed(3));
  const d = describeStrokes(strokes);
  ok("Edit record summary counts strokes and brush sizes", d.paintStrokes === 2 && d.eraseStrokes === 1 && d.brushMin === 6 && d.brushMax === 20, JSON.stringify(d));
}

// ───────── inpainting success ─────────
for (const [name, gen, maxRatio] of [["stripes", stripes, 0.3], ["bricks", bricks, 0.6], ["scene", scene, 0.3]] as const) {
  const img = gen(320, 240), mask = discMask(320, 240, 170, 130, 38), input = withObject(img, mask);
  const before = sha(input);
  const progress: number[] = [];
  const r = inpaintRoi(input, mask, 320, 240, { onProgress: (f) => progress.push(f) });
  const err = mae(r.rgba, img.rgba, mask), base = mae(meanFill(input, mask), img.rgba, mask);
  ok(`[${name}] Reconstruction is close to the true background and far better than a flat fill`, err < base * maxRatio, `error ${err.toFixed(1)} vs flat-fill ${base.toFixed(1)}`);
  let redLeft = 0, n = 0; for (let i = 0; i < mask.length; i++) if (mask[i]) { n++; if (r.rgba[i * 4] > 180 && r.rgba[i * 4 + 1] < 80) redLeft++; }
  ok(`[${name}] The unwanted object is gone`, redLeft / n < 0.01, `${redLeft} of ${n} px still object-coloured`);
  let outsideSame = true; for (let i = 0; i < mask.length; i++) if (!mask[i]) for (let c = 0; c < 4; c++) if (r.rgba[i * 4 + c] !== input[i * 4 + c]) outsideSame = false;
  ok(`[${name}] Every pixel outside the selection is bit-identical`, outsideSame);
  ok(`[${name}] The input data is not modified`, sha(input) === before);
  ok(`[${name}] Progress is monotonic and finishes at 100%`, progress.length > 3 && progress.every((v, i) => i === 0 || v >= progress[i - 1] - 1e-9) && progress[progress.length - 1] === 1, progress.length + " updates");
}
{
  const img = stripes(320, 240), mask = discMask(320, 240, 170, 130, 38), input = withObject(img, mask);
  const a = inpaintRoi(input, mask, 320, 240, { seed: 7 }), b = inpaintRoi(input, mask, 320, 240, { seed: 7 }), c = inpaintRoi(input, mask, 320, 240, { seed: 8 });
  ok("Same seed gives the identical result (deterministic)", sha(a.rgba) === sha(b.rgba));
  ok("A different seed still reconstructs (not a degenerate fixed answer)", mae(c.rgba, img.rgba, mask) < 12, mae(c.rgba, img.rgba, mask).toFixed(1));
  let sum = 0, sum2 = 0, cnt = 0; for (let i = 0; i < mask.length; i++) if (mask[i]) { const v = a.rgba[i * 4]; sum += v; sum2 += v * v; cnt++; }
  const sd = Math.sqrt(sum2 / cnt - (sum / cnt) ** 2);
  ok("Result keeps texture (not a blur or flat paint): std-dev of the filled area is high", sd > 40, `std-dev ${sd.toFixed(1)}`);
  // not a diffusion/blur: the stripes continue with the right phase
  ok("Stripe pattern continues through the hole", mae(a.rgba, img.rgba, mask) < 8, mae(a.rgba, img.rgba, mask).toFixed(1));
  const t = img.rgba.slice(); for (let i = 0; i < mask.length; i++) t[i * 4 + 3] = i % 2 ? 128 : 255;
  const ra = inpaintRoi(withObject({ ...img, rgba: t }, mask), mask, 320, 240);
  let alphaOk = true; for (let i = 0; i < mask.length; i++) if (mask[i] ? ra.rgba[i * 4 + 3] !== 255 : ra.rgba[i * 4 + 3] !== t[i * 4 + 3]) alphaOk = false;
  ok("Alpha outside the selection is preserved; filled pixels are opaque", alphaOk);
}
{
  // a hole near the image corner / edge
  const img = bricks(300, 200), mask = discMask(300, 200, 12, 10, 30), input = withObject(img, mask);
  const r = inpaintRoi(input, mask, 300, 200);
  ok("Selection touching the image corner reconstructs", mae(r.rgba, img.rgba, mask) < mae(meanFill(input, mask), img.rgba, mask), `${mae(r.rgba, img.rgba, mask).toFixed(1)} vs ${mae(meanFill(input, mask), img.rgba, mask).toFixed(1)}`);
  // irregular, multi-part selection
  const m2 = new Uint8Array(300 * 200); for (const [cx, cy, rr] of [[80, 60, 14], [200, 120, 18], [220, 50, 10]]) { const d = discMask(300, 200, cx, cy, rr); for (let i = 0; i < d.length; i++) if (d[i]) m2[i] = 255; }
  const in2 = withObject(img, m2), r2 = inpaintRoi(in2, m2, 300, 200);
  ok("Several separate selections are all reconstructed", mae(r2.rgba, img.rgba, m2) < mae(meanFill(in2, m2), img.rgba, m2) * 0.6, `${mae(r2.rgba, img.rgba, m2).toFixed(1)}`);
  // large region at reduced working resolution
  const big = bricks(900, 700), bm = discMask(900, 700, 450, 350, 120), bin = withObject(big, bm);
  const rb = inpaintRoi(bin, bm, 900, 700, { maxWorkPixels: 120_000 });
  let same = true; for (let i = 0; i < bm.length; i++) if (!bm[i]) for (let c = 0; c < 4; c++) if (rb.rgba[i * 4 + c] !== bin[i * 4 + c]) same = false;
  ok("Large region synthesised at reduced resolution: stats say so, outside untouched, better than flat fill", rb.stats.workScale < 0.5 && same && mae(rb.rgba, big.rgba, bm) < mae(meanFill(bin, bm), big.rgba, bm), `scale ${rb.stats.workScale}, ${rb.stats.ms} ms`);
}

// ───────── inpainting failure (must be reported, never faked) ─────────
{
  const img = stripes(200, 150), input = withObject(img, new Uint8Array(200 * 150));
  const none = new Uint8Array(200 * 150);
  ok("Empty selection is refused with 'empty_mask'", errCode(() => inpaintRoi(input, none, 200, 150)) === "empty_mask");
  ok("Selecting nearly everything is refused with 'too_much'", errCode(() => inpaintRoi(input, new Uint8Array(200 * 150).fill(255), 200, 150)) === "too_much");
  const small = stripes(48, 48), sm = new Uint8Array(48 * 48); for (let y = 5; y < 43; y++) for (let x = 5; x < 43; x++) sm[y * 48 + x] = 255;
  ok("No usable surrounding picture is refused with 'no_source'", errCode(() => inpaintRoi(small.rgba, sm, 48, 48)) === "no_source");
  ok("A region too small to work with is refused", errCode(() => inpaintRoi(new Uint8ClampedArray(10 * 10 * 4), new Uint8Array(100).fill(255), 10, 10)) !== "no error");
  ok("Mismatched buffers are refused with 'bad_input'", errCode(() => inpaintRoi(new Uint8ClampedArray(16), new Uint8Array(5), 4, 4)) === "bad_input");
  const mask = discMask(200, 150, 100, 75, 20); let calls = 0;
  ok("Cancelling stops the work with 'cancelled'", errCode(() => inpaintRoi(withObject(img, mask), mask, 200, 150, { shouldCancel: () => ++calls > 2 })) === "cancelled");
  const hash = sha(input); try { inpaintRoi(input, none, 200, 150); } catch { /* expected */ }
  ok("After a failure the input is untouched", sha(input) === hash);
  let thrown: unknown = null; try { inpaintRoi(input, none, 200, 150); } catch (e) { thrown = e; }
  ok("Failures carry a readable message for the user", thrown instanceof InpaintError && thrown.message.length > 20, (thrown as Error)?.message);
}

console.log(`\n${total - bad}/${total} passed`);
process.exit(bad ? 1 : 0);
