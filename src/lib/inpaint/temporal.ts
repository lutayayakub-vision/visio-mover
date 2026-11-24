/**
 * Temporal reconstruction for video (Stage 2, milestone 2). Pure, DOM-free, deterministic.
 *
 * Idea: when the camera is fixed, the picture behind an unwanted object is usually visible in OTHER frames.
 *  1. estimate the global (translation) motion of the background between consecutive frames, ignoring the masked areas;
 *  2. split the clip at shot cuts (nothing is ever borrowed across a cut);
 *  3. for every masked pixel, collect the same background content from other frames (following the motion) and take the median;
 *  4. only where that is impossible, optionally fall back to the Stage 1 spatial PatchMatch, seeded from the previous frame's fill;
 *  5. everything outside the mask is copied from the input unchanged (verified before returning).
 *
 * It never reports success it cannot back up: if the background behind the object is not visible in enough frames (typical for a
 * camera pan with an object fixed in the scene, or a single frame), it throws TemporalError("insufficient_background") by default,
 * or - only when explicitly allowed - returns status "degraded" with warnings.
 *
 * Frames are RGB, row-major, 3 bytes per pixel. Masks are w*h bytes, non-zero = pixel to reconstruct.
 */
import { inpaintRoi, InpaintError } from "./core";

export type Frame = Uint8Array;
export type TemporalErrorCode = "insufficient_background" | "bad_input" | "cancelled" | "failed";
export class TemporalError extends Error {
  code: TemporalErrorCode;
  details?: Record<string, unknown>;
  constructor(code: TemporalErrorCode, message: string, details?: Record<string, unknown>) { super(message); this.name = "TemporalError"; this.code = code; this.details = details; }
}
export type WarningCode = "shot_cut" | "unreliable_motion" | "object_moves_with_background" | "partial_coverage" | "spatial_fallback" | "scene_in_motion";
export type TemporalWarning = { code: WarningCode; message: string; frames?: number[]; value?: number };

export type TemporalOptions = {
  /** search radius for background motion, px per frame */ searchRadius?: number;
  /** other frames considered on each side of a frame */ window?: number;
  /** how many observations are combined per pixel (median) */ maxObs?: number;
  /** observations needed before a pixel counts as covered */ minObs?: number;
  /** pixels around other frames' masks that are not trusted as background */ obsMargin?: number;
  /** per frame: fraction of masked pixels the video itself must be able to supply */ minCoverage?: number;
  /** "error" (default): refuse. "spatial": fill the rest with Stage 1 PatchMatch and mark the result degraded. */ onInsufficient?: "error" | "spatial";
  /** seed the spatial fallback from the previous frame's result (default true) */ seedFromPrevious?: boolean;
  /** treat the clip as one shot (testing / explicit user choice) */ detectCuts?: boolean;
  /** reconstruct only these frames (inclusive); the others serve as observations only and are returned untouched (used for chunked processing) */ range?: [number, number];
  seed?: number; verify?: boolean;
  onProgress?: (fraction: number, label: string) => void; shouldCancel?: () => boolean;
};

export type MotionEstimate = {
  dx: number; dy: number;        // frame t(p) ~= frame t-1(p + d)
  residual: number;              // mean |difference| after compensation, outside masks (levels)
  gap: number;                   // how much better the best shift is than any clearly different one
  blocks: { used: number; agree: number };
  cutScore: number;              // blur-robust mismatch after compensation; large = different picture
  valid: boolean; reason?: string;
};

export type TemporalResult = {
  frames: Frame[];               // reconstructed frames (frames with an empty mask are returned as the same arrays, untouched)
  status: "ok" | "degraded";
  warnings: TemporalWarning[];
  segments: Array<[number, number]>;
  motion: MotionEstimate[];      // motion[t] relates frame t-1 -> t (motion[0] is zero)
  coverage: number[];            // per frame: fraction of masked pixels supplied by other frames (1 if nothing masked)
  stats: { maskedPixels: number; plateFilled: number; spatialFilled: number; ms: { motion: number; cuts: number; plate: number; spatial: number; total: number }; seeded: number };
};

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

// ───────────────────────── small helpers (exported for the pipeline and tests) ─────────────────────────
export function dilateMask(mask: Uint8Array, w: number, h: number, r: number): Uint8Array {
  let cur = mask;
  for (let k = 0; k < r; k++) {
    const nx = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (cur[i] || (x > 0 && cur[i - 1]) || (x < w - 1 && cur[i + 1])) nx[i] = 1;
    }
    const ny = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (nx[i] || (y > 0 && nx[i - w]) || (y < h - 1 && nx[i + w])) ny[i] = 1;
    }
    cur = ny;
  }
  return cur === mask ? Uint8Array.from(mask, (v) => (v ? 1 : 0)) : cur;
}

function gray(f: Frame, n: number): Uint8Array {
  const g = new Uint8Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 3) g[i] = (f[j] * 77 + f[j + 1] * 150 + f[j + 2] * 29) >> 8;
  return g;
}

// ───────────────────────── global motion ─────────────────────────
type Cand = { dx: number; dy: number };
function candidates(R: number): Cand[] {
  const c: Cand[] = [];
  for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) c.push({ dx, dy });
  return c.sort((a, b) => a.dx * a.dx + a.dy * a.dy - (b.dx * b.dx + b.dy * b.dy)); // ties resolve toward "no motion"
}

/** mean |b(p) - a(p+d)| over sampled pixels usable in both frames; Infinity when too few pixels overlap */
function shiftCost(a: Uint8Array, b: Uint8Array, okA: Uint8Array, okB: Uint8Array, w: number, h: number, dx: number, dy: number, stride: number, x0 = 0, y0 = 0, x1 = w, y1 = h, minCount = 400): number {
  let sum = 0, n = 0;
  const ys = Math.max(y0, -dy), ye = Math.min(y1, h - dy), xs = Math.max(x0, -dx), xe = Math.min(x1, w - dx);
  for (let y = ys + ((stride - (ys % stride)) % stride); y < ye; y += stride) {
    const row = y * w, row2 = (y + dy) * w + dx;
    for (let x = xs + ((stride - (xs % stride)) % stride); x < xe; x += stride) {
      const i = row + x, j = row2 + x;
      if (okB[i] && okA[j]) { const d = b[i] - a[j]; sum += d < 0 ? -d : d; n++; }
    }
  }
  return n >= minCount ? sum / n : Infinity;
}

export function estimateMotion(a: Frame, b: Frame, okA: Uint8Array, okB: Uint8Array, w: number, h: number, R: number): MotionEstimate {
  const n = w * h, ga = gray(a, n), gb = gray(b, n);
  const cands = candidates(R);
  const coarse = new Float64Array(cands.length);
  let bi = 0, best = Infinity;
  for (let k = 0; k < cands.length; k++) {
    const c = shiftCost(ga, gb, okA, okB, w, h, cands[k].dx, cands[k].dy, 3);
    coarse[k] = c;
    if (c < best - 1e-9) { best = c; bi = k; }
  }
  if (!isFinite(best)) return { dx: 0, dy: 0, residual: Infinity, gap: 0, blocks: { used: 0, agree: 0 }, cutScore: Infinity, valid: false, reason: "too little unmasked picture to measure motion" };
  let second = Infinity;
  for (let k = 0; k < cands.length; k++) if (Math.max(Math.abs(cands[k].dx - cands[bi].dx), Math.abs(cands[k].dy - cands[bi].dy)) >= 2 && coarse[k] < second) second = coarse[k];
  // refine at full resolution around the coarse winner
  let dx = cands[bi].dx, dy = cands[bi].dy, fine = Infinity;
  for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
    const tx = cands[bi].dx + ox, ty = cands[bi].dy + oy;
    if (Math.abs(tx) > R || Math.abs(ty) > R) continue;
    const c = shiftCost(ga, gb, okA, okB, w, h, tx, ty, 1);
    if (c < fine - 1e-9 || (Math.abs(c - fine) <= 1e-9 && tx * tx + ty * ty < dx * dx + dy * dy)) { fine = c; dx = tx; dy = ty; }
  }
  // "no motion" wins whenever it explains the picture about as well as the best shift: in flat or noisy footage a 1 px shift changes
  // nothing visible, so declaring the camera still costs no quality (and avoids chasing noise).
  if (dx !== 0 || dy !== 0) {
    const c0 = shiftCost(ga, gb, okA, okB, w, h, 0, 0, 1);
    if (c0 <= fine * 1.03 + 0.15) { dx = 0; dy = 0; fine = c0; }
  }
  const gap = (second - best) / Math.max(best, 1);
  const still = dx === 0 && dy === 0;
  const distinct = gap >= 0.05 || still;

  // block agreement: a single global translation must explain (nearly) every textured block
  const BS = 64; let used = 0, agree = 0;
  for (let by = 0; by + BS <= h; by += BS) for (let bx = 0; bx + BS <= w; bx += BS) {
    let ok = 0, s = 0, s2 = 0;
    for (let y = by; y < by + BS; y += 2) for (let x = bx; x < bx + BS; x += 2) { const i = y * w + x; if (okB[i]) { ok++; const v = gb[i]; s += v; s2 += v * v; } }
    if (ok < 0.6 * (BS / 2) * (BS / 2)) continue;
    const mean = s / ok, sd = Math.sqrt(Math.max(0, s2 / ok - mean * mean));
    if (sd < 2.5) continue; // flat: carries no motion information
    used++;
    let bb = Infinity, gl = Infinity;
    for (let oy = -3; oy <= 3; oy++) for (let ox = -3; ox <= 3; ox++) {
      const c = shiftCost(ga, gb, okA, okB, w, h, dx + ox, dy + oy, 2, bx, by, bx + BS, by + BS, 150);
      if (ox === 0 && oy === 0) gl = c;
      if (c < bb) bb = c;
    }
    if (isFinite(gl) && gl <= bb * 1.03 + 0.3) agree++;
  }
  const consistent = used < 4 || agree / used >= 0.8;

  // blur-robust mismatch after compensation (8x8 block means) - separates "different picture" from sensor noise
  let cs = 0, cn = 0;
  for (let by = 0; by + 8 <= h; by += 8) for (let bx = 0; bx + 8 <= w; bx += 8) {
    if (bx + dx < 0 || by + dy < 0 || bx + dx + 8 > w || by + dy + 8 > h) continue;
    let sb = 0, sa = 0, good = true;
    for (let y = 0; y < 8 && good; y++) for (let x = 0; x < 8; x++) {
      const i = (by + y) * w + bx + x, j = (by + y + dy) * w + bx + x + dx;
      if (!okB[i] || !okA[j]) { good = false; break; }
      sb += gb[i]; sa += ga[j];
    }
    if (good) { cs += Math.abs(sb - sa) / 64; cn++; }
  }
  const cutScore = cn > 20 ? cs / cn : Infinity;
  const valid = distinct && consistent;
  return { dx, dy, residual: fine, gap, blocks: { used, agree }, cutScore, valid,
    reason: valid ? undefined : !distinct ? "the picture has no distinct motion (too flat or ambiguous)" : "the picture does not move as one rigid shift (zoom, rotation or depth parallax)" };
}

// ───────────────────────── reconstruction ─────────────────────────
function validate(frames: Frame[], masks: Uint8Array[], w: number, h: number) {
  if (!(w > 0 && h > 0) || frames.length === 0) throw new TemporalError("bad_input", "There are no frames to process.");
  if (masks.length !== frames.length) throw new TemporalError("bad_input", "Every frame needs a selection (an empty one is fine).");
  let any = false;
  for (let t = 0; t < frames.length; t++) {
    if (frames[t].length !== w * h * 3) throw new TemporalError("bad_input", `Frame ${t} has the wrong size.`);
    if (masks[t].length !== w * h) throw new TemporalError("bad_input", `The selection for frame ${t} has the wrong size.`);
    if (!any) for (let i = 0; i < masks[t].length; i++) if (masks[t][i]) { any = true; break; }
  }
  if (!any) throw new TemporalError("bad_input", "Nothing is selected in any frame. Mark the object you want to remove first.");
}

export function reconstructVideo(frames: Frame[], masks: Uint8Array[], w: number, h: number, opts: TemporalOptions = {}): TemporalResult {
  const T0 = now();
  const o = { searchRadius: 10, window: 45, maxObs: 15, minObs: 2, obsMargin: 3, minCoverage: 0.85, onInsufficient: "error" as const, seedFromPrevious: true, detectCuts: true, seed: 1337, verify: true, ...opts };
  const progress = o.onProgress ?? (() => {});
  const cancelled = () => { if (o.shouldCancel?.()) throw new TemporalError("cancelled", "Reconstruction was cancelled. Nothing was changed."); };
  validate(frames, masks, w, h);
  const N = frames.length, npix = w * h;
  const ms = { motion: 0, cuts: 0, plate: 0, spatial: 0, total: 0 };

  // pixels that may be trusted as real background in each frame
  const ok: Uint8Array[] = masks.map((m) => {
    let any = false; for (let i = 0; i < npix; i++) if (m[i]) { any = true; break; }
    const d = any ? dilateMask(m, w, h, o.obsMargin) : m;
    const t = new Uint8Array(npix); for (let i = 0; i < npix; i++) t[i] = d[i] ? 0 : 1; return t;
  });

  // 1. motion between consecutive frames
  let t0 = now();
  const motion: MotionEstimate[] = [{ dx: 0, dy: 0, residual: 0, gap: 0, blocks: { used: 0, agree: 0 }, cutScore: 0, valid: true }];
  for (let t = 1; t < N; t++) { cancelled(); motion.push(estimateMotion(frames[t - 1], frames[t], ok[t - 1], ok[t], w, h, o.searchRadius)); progress(0.15 * t / N, "Measuring motion"); }
  ms.motion = now() - t0;

  // 2. shot cuts and unusable motion split the clip into segments that never share information
  t0 = now();
  const warnings: TemporalWarning[] = [];
  const scores = motion.slice(1).map((m) => m.cutScore).filter((v) => isFinite(v)).sort((a, b) => a - b);
  const base = scores.length ? scores[scores.length >> 1] : 0;
  const cutLevel = Math.max(4, 4 * base);
  const cutFrames: number[] = [], brokenMotion: number[] = [];
  const breaks = new Set<number>();
  for (let t = 1; t < N; t++) {
    const m = motion[t];
    if (o.detectCuts && (m.cutScore > cutLevel || !isFinite(m.cutScore))) { cutFrames.push(t); breaks.add(t); }
    else if (!m.valid) { brokenMotion.push(t); breaks.add(t); }
  }
  const segments: Array<[number, number]> = [];
  { let s = 0; for (let t = 1; t <= N; t++) if (t === N || breaks.has(t)) { segments.push([s, t - 1]); s = t; } }
  if (cutFrames.length) warnings.push({ code: "shot_cut", frames: cutFrames, message: `Shot ${cutFrames.length > 1 ? "cuts" : "cut"} found at frame${cutFrames.length > 1 ? "s" : ""} ${cutFrames.join(", ")}. Each shot is reconstructed on its own; nothing is borrowed across a cut.` });
  if (brokenMotion.length) warnings.push({ code: "unreliable_motion", frames: brokenMotion, message: `The background motion could not be measured reliably at frame${brokenMotion.length > 1 ? "s" : ""} ${brokenMotion.slice(0, 8).join(", ")}${brokenMotion.length > 8 ? "…" : ""} (${motion[brokenMotion[0]].reason}). Information is not shared across those points.` });
  const V: Array<[number, number]> = new Array(N);
  for (const [s, e] of segments) { V[s] = [0, 0]; for (let t = s + 1; t <= e; t++) V[t] = [V[t - 1][0] + motion[t].dx, V[t - 1][1] + motion[t].dy]; }
  ms.cuts = now() - t0;
  const moving = motion.slice(1).filter((m) => m.valid && (m.dx !== 0 || m.dy !== 0)).length > 0.5 * Math.max(1, N - 1);

  // 3. background from other frames (motion-compensated median)
  t0 = now();
  const segOf = new Int32Array(N); segments.forEach(([s, e], k) => { for (let t = s; t <= e; t++) segOf[t] = k; });
  type Plate = { idx: Int32Array; val: Uint8Array; covered: Uint8Array };
  const plates: Array<Plate | null> = new Array(N).fill(null);
  const coverage = new Array<number>(N).fill(1);
  let maskedTotal = 0;
  const vals = new Uint8Array(o.maxObs), tmpv = new Uint8Array(o.maxObs);
  for (let t = 0; t < N; t++) {
    cancelled(); progress(0.15 + 0.5 * t / N, "Collecting background from other frames");
    if (o.range && (t < o.range[0] || t > o.range[1])) continue;
    const idxList: number[] = []; for (let i = 0; i < npix; i++) if (masks[t][i]) idxList.push(i);
    if (!idxList.length) continue;
    const idx = Int32Array.from(idxList), m = idx.length; maskedTotal += m;
    const smp = new Uint8Array(o.maxObs * m * 3), cnt = new Uint8Array(m);
    const [s, e] = segments[segOf[t]];
    let open = m;
    for (let dist = 1; dist <= o.window && open > 0; dist++) {
      for (const t2 of [t - dist, t + dist]) {
        if (t2 < s || t2 > e) continue;
        const ox = V[t][0] - V[t2][0], oy = V[t][1] - V[t2][1], f2 = frames[t2], k2 = ok[t2];
        for (let q = 0; q < m; q++) {
          if (cnt[q] >= o.maxObs) continue;
          const p = idx[q], x = p % w + ox, y = ((p / w) | 0) + oy;
          if (x < 0 || y < 0 || x >= w || y >= h) continue;
          const p2 = y * w + x;
          if (!k2[p2]) continue;
          const k = cnt[q]++, b = (k * m + q) * 3;
          smp[b] = f2[p2 * 3]; smp[b + 1] = f2[p2 * 3 + 1]; smp[b + 2] = f2[p2 * 3 + 2];
          if (cnt[q] === o.maxObs) open--;
        }
      }
    }
    const val = new Uint8Array(m * 3), covered = new Uint8Array(m); let cov = 0;
    for (let q = 0; q < m; q++) {
      const c = cnt[q]; if (c < o.minObs) continue;
      covered[q] = 1; cov++;
      for (let ch = 0; ch < 3; ch++) {
        for (let k = 0; k < c; k++) vals[k] = smp[(k * m + q) * 3 + ch];
        tmpv.set(vals.subarray(0, c)); const arr = tmpv.subarray(0, c).sort();
        val[q * 3 + ch] = c & 1 ? arr[c >> 1] : (arr[(c >> 1) - 1] + arr[c >> 1] + 1) >> 1;
      }
    }
    plates[t] = { idx, val, covered };
    coverage[t] = cov / m;
  }
  ms.plate = now() - t0;

  // 4. is there enough background to answer honestly?
  const low = coverage.map((c, t) => ({ c, t })).filter((x) => plates[x.t] && x.c < o.minCoverage);
  if (low.length && o.onInsufficient === "error") {
    const worst = Math.min(...low.map((x) => x.c));
    const why = moving
      ? "The object seems to move together with the scene (for example a camera pan), so the picture behind it is never visible in other frames."
      : brokenMotion.length || cutFrames.length ? "The clip is cut into short shots or its motion could not be measured, so there are too few frames showing the area behind the object."
      : "The area behind the object is hidden in (almost) every frame, so the video has no picture of it to reuse.";
    throw new TemporalError("insufficient_background", `Can't reconstruct reliably: ${why} ${low.length} frame${low.length > 1 ? "s have" : " has"} less than ${Math.round(o.minCoverage * 100)}% of the selected area available from other frames (worst: ${Math.round(worst * 100)}%). Nothing was changed.`,
      { frames: low.map((x) => x.t), worstCoverage: worst, minCoverage: o.minCoverage, moving, cuts: cutFrames, unreliableMotion: brokenMotion });
  }

  // 5. compose: plate where covered, optional spatial fallback elsewhere, input everywhere else
  t0 = now();
  const out: Frame[] = new Array(N);
  let plateFilled = 0, spatialFilled = 0, seededFrames = 0;
  const spatialFrames: number[] = [];
  for (let t = 0; t < N; t++) {
    cancelled(); progress(0.65 + 0.33 * t / N, "Filling the selected area");
    const pl = plates[t];
    if (!pl) { out[t] = frames[t]; continue; }
    const f = Uint8Array.from(frames[t]);
    const hole: number[] = [];
    for (let q = 0; q < pl.idx.length; q++) {
      const p = pl.idx[q];
      if (pl.covered[q]) { f[p * 3] = pl.val[q * 3]; f[p * 3 + 1] = pl.val[q * 3 + 1]; f[p * 3 + 2] = pl.val[q * 3 + 2]; plateFilled++; }
      else hole.push(p);
    }
    if (hole.length) {
      const sp = now();
      try {
        const prev = t > 0 && segOf[t - 1] === segOf[t] ? out[t - 1] : null;
        const used = spatialFill(f, hole, w, h, o.seed, o.seedFromPrevious && prev ? { prev, dx: motion[t].dx, dy: motion[t].dy } : null);
        if (used) seededFrames++;
      } catch (e) {
        if (e instanceof InpaintError) throw new TemporalError(e.code === "cancelled" ? "cancelled" : "insufficient_background", `The remaining area in frame ${t} can't be filled: ${e.message} Nothing was changed.`, { frame: t, inpaintCode: e.code });
        throw e;
      }
      spatialFilled += hole.length; spatialFrames.push(t);
      ms.spatial += now() - sp;
    }
    out[t] = f;
  }
  ms.plate += 0;

  // 6. the guarantee: outside the selection, every byte equals the input
  if (o.verify) {
    for (let t = 0; t < N; t++) {
      if (out[t] === frames[t]) continue;
      const a = frames[t], b = out[t], m = masks[t];
      for (let i = 0; i < npix; i++) if (!m[i] && (a[i * 3] !== b[i * 3] || a[i * 3 + 1] !== b[i * 3 + 1] || a[i * 3 + 2] !== b[i * 3 + 2]))
        throw new TemporalError("failed", `Internal check failed: a pixel outside the selection changed in frame ${t}. Nothing was saved.`, { frame: t, pixel: i });
    }
  }

  // 7. honest status
  if (spatialFrames.length) {
    const part = low.length === 0;
    warnings.push({ code: "spatial_fallback", frames: spatialFrames, value: spatialFilled / Math.max(1, maskedTotal), message: part
      ? `${spatialFilled} pixel${spatialFilled > 1 ? "s" : ""} could not be taken from other frames and were filled from the surrounding picture instead.`
      : "Other frames do not show the area behind the object, so it was filled from the surrounding picture only (like a still photo). Expect visible flicker or smearing. This is not a reliable reconstruction." });
    if (low.length && moving) warnings.push({ code: "object_moves_with_background", frames: low.map((x) => x.t), message: "The object moves together with the scene (camera pan?), so the picture behind it is never visible in other frames." });
  }
  if (moving && !low.length) warnings.push({ code: "scene_in_motion", message: "The scene moves; the background was followed frame to frame. This works while the object moves differently from the scene." });
  const spatialShare = spatialFilled / Math.max(1, maskedTotal);
  if (!low.length && spatialShare > 0 && spatialShare <= 0.01) { /* a few seam pixels: still ok */ }
  const status: "ok" | "degraded" = spatialShare > 0.01 || low.length ? "degraded" : "ok";
  ms.total = now() - T0;
  progress(1, "Done");
  return { frames: out, status, warnings, segments, motion, coverage, stats: { maskedPixels: maskedTotal, plateFilled, spatialFilled, ms, seeded: seededFrames } };
}

/** Stage 1 PatchMatch on the pixels the other frames could not supply, optionally seeded from the previous frame. */
function spatialFill(f: Frame, hole: number[], w: number, h: number, seed: number, prev: { prev: Frame; dx: number; dy: number } | null): boolean {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (const p of hole) { const x = p % w, y = (p / w) | 0; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  const margin = Math.max(48, Math.round(0.8 * Math.max(x1 - x0 + 1, y1 - y0 + 1)));
  const rx0 = Math.max(0, x0 - margin), ry0 = Math.max(0, y0 - margin), rx1 = Math.min(w - 1, x1 + margin), ry1 = Math.min(h - 1, y1 + margin);
  const rw = rx1 - rx0 + 1, rh = ry1 - ry0 + 1;
  const rgba = new Uint8ClampedArray(rw * rh * 4), mask = new Uint8Array(rw * rh);
  for (let y = 0; y < rh; y++) for (let x = 0; x < rw; x++) { const s = ((y + ry0) * w + x + rx0) * 3, d = (y * rw + x) * 4; rgba[d] = f[s]; rgba[d + 1] = f[s + 1]; rgba[d + 2] = f[s + 2]; rgba[d + 3] = 255; }
  for (const p of hole) mask[((((p / w) | 0) - ry0) * rw) + (p % w) - rx0] = 255;
  let init: Uint8ClampedArray | undefined;
  if (prev) {
    init = new Uint8ClampedArray(rw * rh * 4);
    let mr = 0, mg = 0, mb = 0, mn = 0;
    for (let i = 0; i < rw * rh; i++) if (!mask[i]) { mr += rgba[i * 4]; mg += rgba[i * 4 + 1]; mb += rgba[i * 4 + 2]; mn++; }
    mr /= Math.max(1, mn); mg /= Math.max(1, mn); mb /= Math.max(1, mn);
    for (const p of hole) {
      const x = p % w, y = (p / w) | 0, sx = x + prev.dx, sy = y + prev.dy, d = (((y - ry0) * rw) + x - rx0) * 4;
      if (sx >= 0 && sy >= 0 && sx < w && sy < h) { const s = (sy * w + sx) * 3; init[d] = prev.prev[s]; init[d + 1] = prev.prev[s + 1]; init[d + 2] = prev.prev[s + 2]; }
      else { init[d] = mr; init[d + 1] = mg; init[d + 2] = mb; }
      init[d + 3] = 255;
    }
  }
  const r = inpaintRoi(rgba, mask, rw, rh, { seed, init });
  for (const p of hole) { const s = ((((p / w) | 0) - ry0) * rw + (p % w) - rx0) * 4, d = p * 3; f[d] = r.rgba[s]; f[d + 1] = r.rgba[s + 1]; f[d + 2] = r.rgba[s + 2]; }
  return !!init;
}
