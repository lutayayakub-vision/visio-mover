/**
 * VISIOMOVER inpainting core: multi-scale PatchMatch image completion (a non-AI, exemplar-based algorithm in the family
 * used by "content-aware fill").
 *
 *   1. Build an image pyramid. The selected region (the "hole") is only a few patch-widths wide at the coarsest level.
 *   2. Fill the coarse hole by diffusion, then refine it with an EM loop: for every patch that overlaps the hole, PatchMatch
 *      finds the best-matching patch that lies completely OUTSIDE the hole; each hole pixel is then re-estimated as the
 *      weighted average of what its overlapping patches say it should be. Real image content is copied, never invented or blurred.
 *   3. Move to the next finer level (upsample the estimate and the patch map) and repeat, down to full resolution.
 *   4. Correct colour seams along the hole boundary with a decaying offset field (a cheap Poisson-style blend).
 *
 * Guarantees: pixels outside the selection are returned bit-for-bit unchanged; failures are reported as InpaintError and
 * never replaced by a blur or flat fill.
 *
 * Pure TypeScript with no DOM access, so it runs in a Web Worker, on the main thread and in Node tests.
 */

export type InpaintErrorCode = "bad_input" | "empty_mask" | "too_much" | "no_source" | "cancelled" | "failed";
export class InpaintError extends Error {
  code: InpaintErrorCode;
  constructor(code: InpaintErrorCode, message: string) { super(message); this.name = "InpaintError"; this.code = code; }
}

export type Progress = (fraction: number, label: string) => void;
export type InpaintOptions = {
  /** Optional starting estimate for the hole (RGBA, same size as the region). When given, the coarse-to-fine pyramid is skipped and
   *  the finest level is refined from this estimate, so a video frame stays close to the previous frame's fill (temporal seeding). */
  init?: Uint8ClampedArray;
  seed?: number;
  /** patch radius, 3 = 7x7 patches */
  patchRadius?: number;
  /** if the region has more pixels than this it is synthesised at reduced resolution and upsampled (detail inside the hole is lower) */
  maxWorkPixels?: number;
  onProgress?: Progress;
  shouldCancel?: () => boolean;
};
export type InpaintStats = {
  holePixels: number; roiPixels: number; workScale: number; levels: number; iterations: number; validSources: number;
  meanPatchError: number; seamCorrected: boolean; ms: number; seeded: boolean;
};

type Level = { w: number; h: number; img: Uint8ClampedArray; hole: Uint8Array };

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

function rgbaToRgb(rgba: Uint8ClampedArray, n: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(n * 3);
  for (let i = 0, j = 0, k = 0; i < n; i++, j += 4, k += 3) { out[k] = rgba[j]; out[k + 1] = rgba[j + 1]; out[k + 2] = rgba[j + 2]; }
  return out;
}

function downsample2(l: Level): Level {
  const w2 = (l.w + 1) >> 1, h2 = (l.h + 1) >> 1;
  const img = new Uint8ClampedArray(w2 * h2 * 3), hole = new Uint8Array(w2 * h2);
  for (let y2 = 0; y2 < h2; y2++) for (let x2 = 0; x2 < w2; x2++) {
    let r = 0, g = 0, b = 0, n = 0, any = 0;
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
      const x = 2 * x2 + dx, y = 2 * y2 + dy;
      if (x >= l.w || y >= l.h) continue;
      const i = y * l.w + x;
      if (l.hole[i]) { any = 1; continue; }
      r += l.img[i * 3]; g += l.img[i * 3 + 1]; b += l.img[i * 3 + 2]; n++;
    }
    const o = y2 * w2 + x2;
    hole[o] = any;
    if (n) { img[o * 3] = r / n; img[o * 3 + 1] = g / n; img[o * 3 + 2] = b / n; }
  }
  return { w: w2, h: h2, img, hole };
}

function holeBounds(l: Level): { w: number; h: number } {
  let x0 = l.w, y0 = l.h, x1 = -1, y1 = -1;
  for (let y = 0; y < l.h; y++) for (let x = 0; x < l.w; x++) if (l.hole[y * l.w + x]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  return x1 < 0 ? { w: 0, h: 0 } : { w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** Onion-peel fill: each ring of unknown pixels takes the mean of its known 8-neighbours. Gives the EM loop a plausible start. */
function diffuseFill(l: Level) {
  const { w, h, img, hole } = l;
  const unknown = Uint8Array.from(hole);
  for (;;) {
    const idx: number[] = [], col: number[] = [];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!unknown[i]) continue;
      let r = 0, g = 0, b = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const j = yy * w + xx;
        if (unknown[j]) continue;
        r += img[j * 3]; g += img[j * 3 + 1]; b += img[j * 3 + 2]; n++;
      }
      if (n) { idx.push(i); col.push(r / n, g / n, b / n); }
    }
    if (!idx.length) break;
    for (let k = 0; k < idx.length; k++) { const i = idx[k]; img[i * 3] = col[k * 3]; img[i * 3 + 1] = col[k * 3 + 1]; img[i * 3 + 2] = col[k * 3 + 2]; unknown[i] = 0; }
  }
}

type Geometry = { valid: Uint8Array; validList: Int32Array; isTarget: Uint8Array; targets: Int32Array; holeList: Int32Array };

function buildGeometry(l: Level, pr: number): Geometry {
  const { w, h, hole } = l;
  const W = w + 1;
  const I = new Int32Array(W * (h + 1));
  for (let y = 0; y < h; y++) { let row = 0; for (let x = 0; x < w; x++) { row += hole[y * w + x]; I[(y + 1) * W + x + 1] = I[y * W + x + 1] + row; } }
  const valid = new Uint8Array(w * h), isTarget = new Uint8Array(w * h);
  const vl: number[] = [], tl: number[] = [], hl: number[] = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (hole[y * w + x]) hl.push(y * w + x);
  for (let cy = pr; cy <= h - 1 - pr; cy++) for (let cx = pr; cx <= w - 1 - pr; cx++) {
    const c = I[(cy + pr + 1) * W + cx + pr + 1] - I[(cy - pr) * W + cx + pr + 1] - I[(cy + pr + 1) * W + cx - pr] + I[(cy - pr) * W + cx - pr];
    const i = cy * w + cx;
    if (c === 0) { valid[i] = 1; vl.push(i); } else { isTarget[i] = 1; tl.push(i); }
  }
  return { valid, validList: Int32Array.from(vl), isTarget, targets: Int32Array.from(tl), holeList: Int32Array.from(hl) };
}

function patchCost(img: Uint8ClampedArray, w: number, qx: number, qy: number, sx: number, sy: number, pr: number, best: number): number {
  let sum = 0;
  const span = (2 * pr + 1) * 3;
  for (let dy = -pr; dy <= pr; dy++) {
    let qi = ((qy + dy) * w + qx - pr) * 3, si = ((sy + dy) * w + sx - pr) * 3;
    for (let k = 0; k < span; k++) { const d = img[qi++] - img[si++]; sum += d * d; }
    if (sum >= best) return sum;
  }
  return sum;
}

type Field = { nnf: Int32Array; cost: Float32Array };

function randomValid(g: Geometry, rnd: () => number): number { return g.validList[(rnd() * g.validList.length) | 0]; }

function patchMatchPass(l: Level, img: Uint8ClampedArray, g: Geometry, f: Field, pr: number, rnd: () => number, reverse: boolean) {
  const { w, h } = l;
  const n = g.targets.length;
  const maxR = Math.max(w, h);
  for (let k = 0; k < n; k++) {
    const q = g.targets[reverse ? n - 1 - k : k];
    const qx = q % w, qy = (q / w) | 0;
    let cur = f.nnf[q];
    let best = patchCost(img, w, qx, qy, cur % w, (cur / w) | 0, pr, Infinity);
    // propagation: a neighbour's match, shifted by one pixel, is a good guess for this patch
    for (let t = 0; t < 2; t++) {
      const nx = t === 0 ? (reverse ? qx + 1 : qx - 1) : qx, ny = t === 1 ? (reverse ? qy + 1 : qy - 1) : qy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const nq = ny * w + nx;
      if (!g.isTarget[nq]) continue;
      const ns = f.nnf[nq];
      const sx = (ns % w) + (qx - nx), sy = ((ns / w) | 0) + (qy - ny);
      if (sx < 0 || sy < 0 || sx >= w || sy >= h) continue;
      const si = sy * w + sx;
      if (!g.valid[si] || si === cur) continue;
      const c = patchCost(img, w, qx, qy, sx, sy, pr, best);
      if (c < best) { best = c; cur = si; }
    }
    // random search in shrinking windows around the current best match
    const cx0 = cur % w, cy0 = (cur / w) | 0;
    for (let r = maxR; r >= 1; r >>= 1) {
      const sx = cx0 + Math.round((rnd() * 2 - 1) * r), sy = cy0 + Math.round((rnd() * 2 - 1) * r);
      if (sx < pr || sy < pr || sx >= w - pr || sy >= h - pr) continue;
      const si = sy * w + sx;
      if (!g.valid[si]) continue;
      const c = patchCost(img, w, qx, qy, sx, sy, pr, best);
      if (c < best) { best = c; cur = si; }
    }
    f.nnf[q] = cur; f.cost[q] = best;
  }
}

/** Re-estimate every hole pixel as the similarity-weighted mean of the pixels its overlapping patches map to. Returns mean change. */
function vote(l: Level, img: Uint8ClampedArray, g: Geometry, f: Field, pr: number): number {
  const { w, h } = l;
  // robust weight scale: median patch error
  const sample: number[] = [];
  const step = Math.max(1, Math.floor(g.targets.length / 1500));
  for (let k = 0; k < g.targets.length; k += step) sample.push(f.cost[g.targets[k]]);
  sample.sort((a, b) => a - b);
  const sigma2 = Math.max(25, sample.length ? sample[sample.length >> 1] : 25);
  const inv = 1 / (2 * sigma2);
  const wt = new Float32Array(w * h);
  for (let k = 0; k < g.targets.length; k++) { const q = g.targets[k]; wt[q] = Math.exp(-f.cost[q] * inv); }
  let change = 0;
  for (let k = 0; k < g.holeList.length; k++) {
    const p = g.holeList[k];
    const px = p % w, py = (p / w) | 0;
    let r = 0, gg = 0, b = 0, ws = 0;
    for (let dy = -pr; dy <= pr; dy++) {
      const qy = py + dy;
      if (qy < pr || qy > h - 1 - pr) continue;
      for (let dx = -pr; dx <= pr; dx++) {
        const qx = px + dx;
        if (qx < pr || qx > w - 1 - pr) continue;
        const q = qy * w + qx;
        const s = f.nnf[q] - dy * w - dx;
        const wq = wt[q] + 1e-9;
        r += wq * img[s * 3]; gg += wq * img[s * 3 + 1]; b += wq * img[s * 3 + 2]; ws += wq;
      }
    }
    if (ws <= 0) continue;
    const nr = r / ws, ng = gg / ws, nb = b / ws;
    change += Math.abs(nr - img[p * 3]) + Math.abs(ng - img[p * 3 + 1]) + Math.abs(nb - img[p * 3 + 2]);
    img[p * 3] = nr; img[p * 3 + 1] = ng; img[p * 3 + 2] = nb;
  }
  return g.holeList.length ? change / (3 * g.holeList.length) : 0;
}

function bilinear(src: Uint8ClampedArray, sw: number, sh: number, fx: number, fy: number, out: Float32Array | Uint8ClampedArray, o: number) {
  const x0 = Math.max(0, Math.min(sw - 1, Math.floor(fx))), y0 = Math.max(0, Math.min(sh - 1, Math.floor(fy)));
  const x1 = Math.min(sw - 1, x0 + 1), y1 = Math.min(sh - 1, y0 + 1);
  const ax = Math.max(0, Math.min(1, fx - x0)), ay = Math.max(0, Math.min(1, fy - y0));
  for (let c = 0; c < 3; c++) {
    const a = src[(y0 * sw + x0) * 3 + c] * (1 - ax) + src[(y0 * sw + x1) * 3 + c] * ax;
    const b = src[(y1 * sw + x0) * 3 + c] * (1 - ax) + src[(y1 * sw + x1) * 3 + c] * ax;
    out[o + c] = a * (1 - ay) + b * ay;
  }
}

/** Area-average resample of an RGB image to (tw x th). */
function resizeRgb(src: Uint8ClampedArray, sw: number, sh: number, tw: number, th: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(tw * th * 3);
  for (let y = 0; y < th; y++) {
    const sy0 = (y * sh) / th, sy1 = ((y + 1) * sh) / th;
    for (let x = 0; x < tw; x++) {
      const sx0 = (x * sw) / tw, sx1 = ((x + 1) * sw) / tw;
      let r = 0, g = 0, b = 0, a = 0;
      for (let yy = Math.floor(sy0); yy < Math.min(sh, Math.ceil(sy1)); yy++) {
        const wy = Math.min(yy + 1, sy1) - Math.max(yy, sy0);
        for (let xx = Math.floor(sx0); xx < Math.min(sw, Math.ceil(sx1)); xx++) {
          const wgt = wy * (Math.min(xx + 1, sx1) - Math.max(xx, sx0));
          const i = (yy * sw + xx) * 3;
          r += src[i] * wgt; g += src[i + 1] * wgt; b += src[i + 2] * wgt; a += wgt;
        }
      }
      const o = (y * tw + x) * 3;
      out[o] = r / a; out[o + 1] = g / a; out[o + 2] = b / a;
    }
  }
  return out;
}

function resizeMaskAny(mask: Uint8Array, sw: number, sh: number, tw: number, th: number): Uint8Array {
  const out = new Uint8Array(tw * th);
  for (let y = 0; y < th; y++) {
    const y0 = Math.floor((y * sh) / th), y1 = Math.max(y0 + 1, Math.ceil(((y + 1) * sh) / th));
    for (let x = 0; x < tw; x++) {
      const x0 = Math.floor((x * sw) / tw), x1 = Math.max(x0 + 1, Math.ceil(((x + 1) * sw) / tw));
      let any = 0;
      for (let yy = y0; yy < Math.min(sh, y1) && !any; yy++) for (let xx = x0; xx < Math.min(sw, x1); xx++) if (mask[yy * sw + xx]) { any = 1; break; }
      out[y * tw + x] = any;
    }
  }
  return out;
}

/**
 * Seam correction. Where the synthesised hole meets known pixels there can be a small colour step. Solve a screened
 * diffusion for a per-pixel offset that closes the step at the boundary and fades out over a few pixels.
 */
function seamCorrect(orig: Uint8ClampedArray, res: Uint8ClampedArray, hole: Uint8Array, w: number, h: number): boolean {
  const holeIdx: number[] = [];
  for (let i = 0; i < w * h; i++) if (hole[i]) holeIdx.push(i);
  if (!holeIdx.length) return false;
  const F = new Float32Array(w * h * 3);
  const decay = 0.965, iters = 90;
  const nb = [-1, 1, -w, w];
  for (let it = 0; it < iters; it++) {
    for (let k = 0; k < holeIdx.length; k++) {
      const i = holeIdx[k], x = i % w;
      for (let c = 0; c < 3; c++) {
        let sum = 0, cnt = 0;
        for (let t = 0; t < 4; t++) {
          const j = i + nb[t];
          if (t === 0 && x === 0) continue;
          if (t === 1 && x === w - 1) continue;
          if (j < 0 || j >= w * h) continue;
          cnt++;
          sum += hole[j] ? F[j * 3 + c] : orig[j * 3 + c] - res[i * 3 + c];
        }
        F[i * 3 + c] = cnt ? (decay * sum) / cnt : 0;
      }
    }
  }
  let moved = false;
  for (let k = 0; k < holeIdx.length; k++) {
    const i = holeIdx[k];
    for (let c = 0; c < 3; c++) { const v = res[i * 3 + c] + F[i * 3 + c]; if (Math.abs(F[i * 3 + c]) > 0.5) moved = true; res[i * 3 + c] = v; }
  }
  return moved;
}

/**
 * Reconstruct the masked pixels of an RGBA region.
 * @param rgba   w*h*4 pixels (not modified)
 * @param mask   w*h bytes, >127 = reconstruct this pixel
 * @returns a new RGBA array: unmasked pixels identical to the input, masked pixels synthesised from the rest of the region
 */
export function inpaintRoi(rgba: Uint8ClampedArray, mask: Uint8Array, w: number, h: number, opts: InpaintOptions = {}): { rgba: Uint8ClampedArray; stats: InpaintStats } {
  const t0 = now();
  const pr = opts.patchRadius ?? 3;
  const patch = 2 * pr + 1;
  const progress = opts.onProgress ?? (() => {});
  const cancelled = () => { if (opts.shouldCancel?.()) throw new InpaintError("cancelled", "Reconstruction was cancelled."); };

  if (!(w > 0 && h > 0) || rgba.length !== w * h * 4 || mask.length !== w * h) throw new InpaintError("bad_input", "The image region and the selection don't match.");
  let holeCount = 0;
  const fullHole = new Uint8Array(w * h);
  for (let i = 0; i < mask.length; i++) if (mask[i] > 127) { fullHole[i] = 1; holeCount++; }
  if (holeCount === 0) throw new InpaintError("empty_mask", "Nothing is selected. Paint over the object you want to remove first.");
  if (holeCount > 0.7 * w * h) throw new InpaintError("too_much", "The selection covers too much of the image, so there isn't enough surrounding picture to copy from. Select a smaller area.");
  if (w < 4 * patch || h < 4 * patch) throw new InpaintError("no_source", "This part of the image is too small to reconstruct from.");

  const fullRgb = rgbaToRgb(rgba, w * h);

  // optional reduction of the working resolution for very large regions
  const maxWork = opts.maxWorkPixels ?? 1_400_000;
  let ww = w, wh = h, workRgb = fullRgb, workHole: Uint8Array = fullHole, scale = 1;
  if (w * h > maxWork) {
    scale = Math.sqrt(maxWork / (w * h));
    ww = Math.max(4 * patch, Math.round(w * scale)); wh = Math.max(4 * patch, Math.round(h * scale));
    scale = ww / w;
    workRgb = resizeRgb(fullRgb, w, h, ww, wh);
    workHole = resizeMaskAny(fullHole, w, h, ww, wh);
  }

  // pyramid (finest first)
  const levels: Level[] = [{ w: ww, h: wh, img: Uint8ClampedArray.from(workRgb), hole: workHole }];
  for (;;) {
    const top = levels[levels.length - 1];
    const hb = holeBounds(top);
    if (hb.w === 0 || Math.max(hb.w, hb.h) <= 3 * patch || levels.length >= 9) break;
    const nw = (top.w + 1) >> 1, nh = (top.h + 1) >> 1;
    if (nw < 3 * patch || nh < 3 * patch) break;
    levels.push(downsample2(top));
  }
  // every level needs real source patches; drop levels that have none
  const geoms: Geometry[] = [];
  for (let k = 0; k < levels.length; k++) geoms.push(buildGeometry(levels[k], pr));
  while (levels.length > 1 && geoms[levels.length - 1].validList.length < 8) { levels.pop(); geoms.pop(); }
  if (geoms[0].validList.length < 20) throw new InpaintError("no_source", "There isn't enough unselected picture around this area to copy from. Select a smaller area, or one with more background around it.");

  let top = levels.length - 1;
  const seeded = !!opts.init;
  if (opts.init) {
    if (opts.init.length !== w * h * 4) throw new InpaintError("bad_input", "The starting estimate and the image region don't match.");
    const initRgb = rgbaToRgb(opts.init, w * h);
    const wi = scale === 1 ? initRgb : resizeRgb(initRgb, w, h, ww, wh);
    levels.length = 1; geoms.length = 1; top = 0;
    const L0 = levels[0], hl = geoms[0].holeList;
    for (let i = 0; i < hl.length; i++) { const p = hl[i] * 3; L0.img[p] = wi[p]; L0.img[p + 1] = wi[p + 1]; L0.img[p + 2] = wi[p + 2]; }
  } else diffuseFill(levels[top]);
  const rnd = mulberry32(opts.seed ?? 1337);

  // work totals for progress
  const itersFor = (k: number) => (k === 0 ? 4 : k === 1 ? 5 : 7);
  let totalIters = 0; for (let k = 0; k <= top; k++) totalIters += itersFor(k);
  let done = 0, iterCount = 0, lastError = 0;

  let field: Field | null = null;
  let cur: Uint8ClampedArray = levels[top].img;
  for (let k = top; k >= 0; k--) {
    const L = levels[k], g = geoms[k];
    // image for this level: known pixels from the original level, hole pixels from the coarser estimate
    let img: Uint8ClampedArray;
    if (k === top) img = L.img;
    else {
      img = Uint8ClampedArray.from(L.img);
      const C = levels[k + 1];
      const tmp = new Float32Array(3);
      for (let i = 0; i < g.holeList.length; i++) {
        const p = g.holeList[i], x = p % L.w, y = (p / L.w) | 0;
        bilinear(cur, C.w, C.h, (x + 0.5) / 2 - 0.5, (y + 0.5) / 2 - 0.5, tmp, 0);
        img[p * 3] = tmp[0]; img[p * 3 + 1] = tmp[1]; img[p * 3 + 2] = tmp[2];
      }
    }
    // patch map for this level
    const nf: Field = { nnf: new Int32Array(L.w * L.h), cost: new Float32Array(L.w * L.h) };
    for (let i = 0; i < g.targets.length; i++) {
      const q = g.targets[i];
      let s = -1;
      if (field) {
        const C = levels[k + 1];
        const qx = q % L.w, qy = (q / L.w) | 0;
        const cq = (qy >> 1) * C.w + (qx >> 1);
        if (geoms[k + 1].isTarget[cq]) {
          const sc = field.nnf[cq];
          const sx = 2 * (sc % C.w) + (qx & 1), sy = 2 * ((sc / C.w) | 0) + (qy & 1);
          if (sx >= 0 && sy >= 0 && sx < L.w && sy < L.h && g.valid[sy * L.w + sx]) s = sy * L.w + sx;
        }
      }
      nf.nnf[q] = s >= 0 ? s : randomValid(g, rnd);
    }
    field = nf;

    const iters = itersFor(k);
    for (let it = 0; it < iters; it++) {
      cancelled();
      if (g.targets.length) {
        patchMatchPass(L, img, g, nf, pr, rnd, it % 2 === 1);
        const change = vote(L, img, g, nf, pr);
        iterCount++;
        if (k === 0) { let s = 0; for (let i = 0; i < g.targets.length; i += Math.max(1, (g.targets.length / 800) | 0)) s += nf.cost[g.targets[i]]; lastError = s / Math.ceil(g.targets.length / Math.max(1, (g.targets.length / 800) | 0)) / (patch * patch * 3); }
        done++;
        progress(done / totalIters * 0.92, k === 0 ? "Refining detail" : `Building structure (${top - k + 1} of ${top + 1})`);
        if (it >= 1 && change < 0.25) { done += iters - it - 1; break; }
      } else { done += iters; break; }
    }
    cur = img;
  }

  // synthesised region at working resolution -> full resolution
  let outRgb: Uint8ClampedArray;
  if (scale === 1) {
    outRgb = Uint8ClampedArray.from(fullRgb);
    for (let i = 0; i < w * h; i++) if (fullHole[i]) { outRgb[i * 3] = cur[i * 3]; outRgb[i * 3 + 1] = cur[i * 3 + 1]; outRgb[i * 3 + 2] = cur[i * 3 + 2]; }
  } else {
    outRgb = Uint8ClampedArray.from(fullRgb);
    const tmp = new Float32Array(3);
    for (let i = 0; i < w * h; i++) if (fullHole[i]) {
      const x = i % w, y = (i / w) | 0;
      bilinear(cur, ww, wh, ((x + 0.5) * ww) / w - 0.5, ((y + 0.5) * wh) / h - 0.5, tmp, 0);
      outRgb[i * 3] = tmp[0]; outRgb[i * 3 + 1] = tmp[1]; outRgb[i * 3 + 2] = tmp[2];
    }
  }
  progress(0.95, "Blending edges");
  cancelled();
  const seam = seamCorrect(fullRgb, outRgb, fullHole, w, h);

  // compose: unselected pixels are copied from the input untouched
  const out = new Uint8ClampedArray(rgba);
  for (let i = 0; i < w * h; i++) {
    if (!fullHole[i]) continue;
    const o = i * 4, c = i * 3;
    const r = outRgb[c], g = outRgb[c + 1], b = outRgb[c + 2];
    if (!(r >= -1e6 && g >= -1e6 && b >= -1e6)) throw new InpaintError("failed", "Reconstruction produced an invalid result. Nothing was changed.");
    out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = 255;
  }
  progress(1, "Done");
  return { rgba: out, stats: { holePixels: holeCount, roiPixels: w * h, workScale: +scale.toFixed(3), levels: levels.length, iterations: iterCount, validSources: geoms[0].validList.length, meanPatchError: +lastError.toFixed(2), seamCorrected: seam, ms: Math.round(now() - t0), seeded } };
}
