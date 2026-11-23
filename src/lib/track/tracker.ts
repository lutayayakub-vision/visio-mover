/**
 * Object tracker for video cleanup (Stage 2, milestone 3). Pure, DOM-free, deterministic.
 *
 * The user marks the object with a mask on one frame (a "keyframe"). The tracker follows it with masked normalised cross-correlation
 * against that keyframe's picture (so the background showing through or changing around the object does not matter), refines the
 * position to sub-pixel accuracy and translates the mask along.
 *
 * Every frame gets an honest status. A frame is only "tracked" when ALL of these hold: strong match, the match is unambiguous, enough of
 * the object is visible and inside the frame, the pixels agree with the keyframe (no occluder), and a forward-backward check returns to
 * where it started (against the previous frame and against the keyframe, so slow drift cannot accumulate unnoticed).
 * Otherwise the frame is "uncertain" (a guessed mask is shown for review), and after a few of those "lost" (no mask). A later
 * re-acquisition is reported as "reentry" and also needs review. Nothing flagged is ever treated as resolved:
 * resolveMasks() throws until every frame is tracked, a keyframe, interpolated between keyframes, or declared absent by the user.
 *
 * Manual keyframes re-anchor the template, are tracked from in both directions, and where tracking cannot decide between two
 * keyframes the positions are interpolated (status "interpolated", always reported).
 * Frames are RGB, row-major, 3 bytes per pixel. Masks are w*h bytes, non-zero = object.
 */
import { estimateMotion, dilateMask } from "../inpaint/temporal";

export type Frame = Uint8Array;
export type TrackStatus = "keyframe" | "tracked" | "interpolated" | "reentry" | "uncertain" | "lost" | "absent";
export type TrackReason = "low_match" | "ambiguous" | "fb_mismatch" | "occluded" | "leaving_frame" | "search_edge" | "gap_too_long";
export type TrackErrorCode = "bad_input" | "cancelled" | "unresolved_tracking" | "failed";
export class TrackError extends Error {
  code: TrackErrorCode; details?: Record<string, unknown>;
  constructor(code: TrackErrorCode, message: string, details?: Record<string, unknown>) { super(message); this.name = "TrackError"; this.code = code; this.details = details; }
}
export type Keyframe = { frame: number; mask?: Uint8Array; absent?: boolean };
export type TrackOptions = {
  radius?: number; nccMin?: number; ambiguityMin?: number; inlierMin?: number; inlierTol?: number; visMin?: number; fbMax?: number;
  coastMax?: number; reacquireNcc?: number; searchEvery?: number; autoResume?: boolean; agreeTol?: number; maxInterpolation?: number; erode?: number; minArea?: number;
  checkCamera?: boolean; cameraStride?: number;
  onProgress?: (fraction: number, label: string) => void; shouldCancel?: () => boolean;
};
export type TrackFrame = {
  status: TrackStatus; anchor: number; dx: number; dy: number; needsReview: boolean;
  ncc?: number; margin?: number; inlier?: number; fb?: number; visible?: number; reason?: TrackReason;
};
export type TrackWarning = { code: "camera_moving" | "uncertain_frames" | "lost_frames" | "reentry" | "interpolated" | "flat_object"; message: string; frames?: number[] };
export type Candidate = { frame: number; anchor: number; dx: number; dy: number; ncc: number; inlier: number; fb: number };
export type TrackResult = {
  frames: TrackFrame[]; keyframes: Array<{ frame: number; mask: Uint8Array | null }>; w: number; h: number;
  needsReview: number[]; warnings: TrackWarning[]; candidates: Candidate[];
  camera: { checked: number; moving: boolean; samples: Array<{ frame: number; dx: number; dy: number; valid: boolean }> };
  counts: Record<TrackStatus, number>;
  stats: { ms: { gray: number; track: number; merge: number; camera: number; total: number }; matches: number };
};

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
const DEF = { radius: 28, nccMin: 0.6, ambiguityMin: 0.03, inlierMin: 0.7, inlierTol: 28, visMin: 0.6, fbMax: 1.5, coastMax: 8, reacquireNcc: 0.8, searchEvery: 3, autoResume: false, agreeTol: 2.5, maxInterpolation: 30, erode: 2, minArea: 60, checkCamera: true, cameraStride: 10 };

// ───────────────────────── mask helpers ─────────────────────────
export function maskCentroid(mask: Uint8Array, w: number, h: number): { x: number; y: number; area: number } {
  let sx = 0, sy = 0, n = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (mask[y * w + x]) { sx += x; sy += y; n++; }
  return { x: n ? sx / n : 0, y: n ? sy / n : 0, area: n };
}
/** translate a mask by a (sub-pixel) offset: bilinear sample of the binary mask, then threshold at 0.5 (exact for whole-pixel shifts) */
export function shiftMask(mask: Uint8Array, w: number, h: number, dx: number, dy: number): Uint8Array {
  const out = new Uint8Array(w * h);
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (mask[y * w + x]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (x1 < 0) return out;
  const sx0 = Math.max(0, Math.floor(x0 + dx) - 1), sx1 = Math.min(w - 1, Math.ceil(x1 + dx) + 1), sy0 = Math.max(0, Math.floor(y0 + dy) - 1), sy1 = Math.min(h - 1, Math.ceil(y1 + dy) + 1);
  const m = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : mask[y * w + x] ? 1 : 0);
  for (let y = sy0; y <= sy1; y++) for (let x = sx0; x <= sx1; x++) {
    const fx = x - dx, fy = y - dy, ix = Math.floor(fx), iy = Math.floor(fy), ax = fx - ix, ay = fy - iy;
    const v = m(ix, iy) * (1 - ax) * (1 - ay) + m(ix + 1, iy) * ax * (1 - ay) + m(ix, iy + 1) * (1 - ax) * ay + m(ix + 1, iy + 1) * ax * ay;
    if (v >= 0.5) out[y * w + x] = 1;
  }
  return out;
}
function erodeMask(mask: Uint8Array, w: number, h: number, r: number): Uint8Array {
  if (r <= 0) return mask;
  const out = new Uint8Array(w * h);
  for (let y = r; y < h - r; y++) for (let x = r; x < w - r; x++) {
    if (!mask[y * w + x]) continue;
    let ok = true;
    for (let j = -r; j <= r && ok; j++) for (let i = -r; i <= r; i++) if (!mask[(y + j) * w + x + i]) { ok = false; break; }
    if (ok) out[y * w + x] = 1;
  }
  return out;
}
function gray(f: Frame, n: number): Uint8Array { const g = new Uint8Array(n); for (let i = 0, j = 0; i < n; i++, j += 3) g[i] = (f[j] * 77 + f[j + 1] * 150 + f[j + 2] * 29) >> 8; return g; }

// ───────────────────────── templates and matching ─────────────────────────
type Tpl = { n: number; xs: Int16Array; ys: Int16Array; v: Uint8Array; rgb: Uint8Array; lats: Map<number, Int32Array>; flat: boolean };
function tplFrom(g: Uint8Array, f: Frame, w: number, h: number, xs: number[] | Int16Array, ys: number[] | Int16Array): Tpl {
  const kx: number[] = [], ky: number[] = [];
  for (let i = 0; i < xs.length; i++) if (xs[i] >= 0 && ys[i] >= 0 && xs[i] < w && ys[i] < h) { kx.push(xs[i]); ky.push(ys[i]); }
  const n = kx.length, v = new Uint8Array(n), rgb = new Uint8Array(n * 3); let s = 0, s2 = 0;
  for (let i = 0; i < n; i++) { const q = ky[i] * w + kx[i]; rgb[i * 3] = f[q * 3]; rgb[i * 3 + 1] = f[q * 3 + 1]; rgb[i * 3 + 2] = f[q * 3 + 2]; v[i] = g[q]; s += v[i]; s2 += v[i] * v[i]; }
  const varc = n ? s2 / n - (s / n) * (s / n) : 0;
  return { n, xs: Int16Array.from(kx), ys: Int16Array.from(ky), v, rgb, lats: new Map(), flat: varc < 9 };
}
function lattice(t: Tpl, L: number): Int32Array | null {
  if (L <= 1) return null;
  let a = t.lats.get(L);
  if (!a) { const l: number[] = []; for (let i = 0; i < t.n; i++) if (t.xs[i] % L === 0 && t.ys[i] % L === 0) l.push(i); a = Int32Array.from(l.length >= 12 ? l : Array.from({ length: t.n }, (_, i) => i)); t.lats.set(L, a); }
  return a;
}
/** masked NCC of template at offset (ox,oy) using only pixels inside the frame; -2 = not enough of the object inside, -1 = no variance */
function nccAt(t: Tpl, idx: Int32Array | null, g: Uint8Array, w: number, h: number, ox: number, oy: number, minIn: number): number {
  let n = 0, st = 0, stt = 0, sf = 0, sff = 0, stf = 0;
  const cnt = idx ? idx.length : t.n, xs = t.xs, ys = t.ys, v = t.v;
  for (let k = 0; k < cnt; k++) {
    const i = idx ? idx[k] : k, x = xs[i] + ox, y = ys[i] + oy;
    if (x < 0 || y < 0 || x >= w || y >= h) continue;
    const f = g[y * w + x], a = v[i]; n++; st += a; stt += a * a; sf += f; sff += f * f; stf += a * f;
  }
  if (n < 8 || n < minIn * cnt) return -2;
  const dt = stt - (st * st) / n, df = sff - (sf * sf) / n;
  if (dt < 1e-6 || df < 1e-6) return -1;
  return (stf - (st * sf) / n) / Math.sqrt(dt * df);
}
type Match = { x: number; y: number; ix: number; iy: number; ncc: number; margin: number };
/** search offsets in [ox0,ox1]x[oy0,oy1]: coarse grid -> integer refinement -> parabolic sub-pixel */
function match(t: Tpl, g: Uint8Array, w: number, h: number, ox0: number, ox1: number, oy0: number, oy1: number, cstep: number, lat: number, minIn: number): Match | null {
  const L = lattice(t, lat), nx = Math.floor((ox1 - ox0) / cstep) + 1, ny = Math.floor((oy1 - oy0) / cstep) + 1;
  if (nx < 1 || ny < 1) return null;
  const sc = new Float32Array(nx * ny).fill(-2);
  let best = -2, bgx = 0, bgy = 0;
  for (let gy = 0; gy < ny; gy++) for (let gx = 0; gx < nx; gx++) {
    const s = nccAt(t, L, g, w, h, ox0 + gx * cstep, oy0 + gy * cstep, minIn); sc[gy * nx + gx] = s;
    if (s > best) { best = s; bgx = gx; bgy = gy; }
  }
  if (best <= -1) return null;
  // second peak = another LOCAL maximum well away from the best (a smooth shoulder of the main peak is not a rival)
  let second = 0;
  for (let gy = 0; gy < ny; gy++) for (let gx = 0; gx < nx; gx++) {
    if (Math.max(Math.abs(gx - bgx), Math.abs(gy - bgy)) <= 3) continue;
    const s = sc[gy * nx + gx]; if (s <= second) continue;
    let isMax = true;
    for (let j = -1; j <= 1 && isMax; j++) for (let i = -1; i <= 1; i++) { if (!i && !j) continue; const xx = gx + i, yy = gy + j; if (xx >= 0 && yy >= 0 && xx < nx && yy < ny && sc[yy * nx + xx] > s) { isMax = false; break; } }
    if (isMax) second = s;
  }
  let cx = ox0 + bgx * cstep, cy = oy0 + bgy * cstep;
  if (cstep > 1) { // integer refinement around the coarse winner
    const L2 = lattice(t, 2); let bb = -2, bx = cx, by = cy;
    for (let y = cy - cstep; y <= cy + cstep; y++) for (let x = cx - cstep; x <= cx + cstep; x++) { const s = nccAt(t, L2, g, w, h, x, y, minIn); if (s > bb) { bb = s; bx = x; by = y; } }
    cx = bx; cy = by;
  }
  // full-density 3x3, recentre until the centre is the maximum, then sub-pixel
  let grid = new Float64Array(9);
  for (let it = 0; it < 4; it++) {
    for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) grid[j * 3 + i] = nccAt(t, null, g, w, h, cx + i - 1, cy + j - 1, minIn);
    let bi = 4; for (let k = 0; k < 9; k++) if (grid[k] > grid[bi]) bi = k;
    if (bi === 4) break;
    cx += (bi % 3) - 1; cy += ((bi / 3) | 0) - 1;
  }
  const c = grid[4]; if (c <= -1) return null;
  const par = (l: number, m: number, r: number) => { if (l <= -1 || r <= -1) return 0; const d = l - 2 * m + r; return d < -1e-9 ? Math.max(-0.5, Math.min(0.5, (0.5 * (l - r)) / d)) : 0; };
  return { x: cx + par(grid[3], c, grid[5]), y: cy + par(grid[1], c, grid[7]), ix: cx, iy: cy, ncc: c, margin: best - second };
}
/** fraction of object pixels whose COLOUR agrees with the template (low = something else covers the object).
 *  A robust per-channel brightness/contrast fit (median offset, then least squares on the agreeing pixels) lets lighting change
 *  without hiding an occluder the way a plain normalisation would. tol is in colour levels. */
function agreement(t: Tpl, f: Frame, w: number, h: number, ox: number, oy: number, tol: number): { inlier: number; visible: number } {
  const idx: number[] = [];
  for (let i = 0; i < t.n; i++) { const x = t.xs[i] + ox, y = t.ys[i] + oy; if (x >= 0 && y >= 0 && x < w && y < h) idx.push(i); }
  const n = idx.length, gain = [1, 1, 1], off = [0, 0, 0];
  if (n < 8) return { inlier: 0, visible: n / Math.max(1, t.n) };
  let ok = 0;
  const hist = new Int32Array(511);
  for (let c = 0; c < 3; c++) {
    const T = (i: number) => t.rgb[i * 3 + c], F = (i: number) => f[((t.ys[i] + oy) * w + t.xs[i] + ox) * 3 + c];
    hist.fill(0); for (const i of idx) hist[F(i) - T(i) + 255]++;
    let acc = 0, med = 0; for (let k = 0; k < 511; k++) { acc += hist[k]; if (acc >= n / 2) { med = k - 255; break; } }
    // two starting models (pure brightness shift / least squares on everything), each refined on the pixels it explains; keep the better
    let best = -1, bg = 1, bo = 0;
    for (const start of [0, 1]) {
      let g = 1, o = med;
      if (start) { let sa = 0, sb = 0, saa = 0, sab = 0; for (const i of idx) { const a = T(i), b = F(i); sa += a; sb += b; saa += a * a; sab += a * b; } const va = saa - (sa * sa) / n; if (va > 1e-6) { g = Math.max(0.4, Math.min(2.5, (sab - (sa * sb) / n) / va)); o = (sb - g * sa) / n; } }
      for (let it = 0; it < 4; it++) {
        const lim = it < 3 ? 2 * tol : tol; let m = 0, sa = 0, sb = 0, saa = 0, sab = 0;
        for (const i of idx) { const a = T(i), b = F(i); if (Math.abs(b - (g * a + o)) <= lim) { m++; sa += a; sb += b; saa += a * a; sab += a * b; } }
        if (m < 8) break; const va = saa - (sa * sa) / m; if (va > 1e-6) { g = Math.max(0.4, Math.min(2.5, (sab - (sa * sb) / m) / va)); o = (sb - g * sa) / m; }
      }
      let cnt = 0; for (const i of idx) if (Math.abs(F(i) - (g * T(i) + o)) <= tol) cnt++;
      if (cnt > best) { best = cnt; bg = g; bo = o; }
    }
    gain[c] = bg; off[c] = bo;
  }
  for (const i of idx) {
    const q = ((t.ys[i] + oy) * w + t.xs[i] + ox) * 3; let good = true;
    for (let c = 0; c < 3; c++) if (Math.abs(f[q + c] - (gain[c] * t.rgb[i * 3 + c] + off[c])) > tol) { good = false; break; }
    if (good) ok++;
  }
  return { inlier: ok / n, visible: n / Math.max(1, t.n) };
}

// ───────────────────────── one directional track from one anchor ─────────────────────────
type Anchor = { tol: number; frame: number; mask: Uint8Array; tpl: Tpl; cx: number; cy: number; bbox: [number, number, number, number]; mx: Int16Array; my: Int16Array };
type Dir = { status: "tracked" | "uncertain" | "lost" | "reentry"; ox: number; oy: number; ncc?: number; margin?: number; inlier?: number; fb?: number; visible?: number; reason?: TrackReason };
type Ctx = { w: number; h: number; f: Frame[]; g: Uint8Array[]; o: typeof DEF & TrackOptions; matches: number; cancelled: () => void };

function makeAnchor(ctx: Ctx, frame: number, mask: Uint8Array): Anchor {
  const { w, h } = ctx; const c = maskCentroid(mask, w, h);
  let use = erodeMask(mask, w, h, ctx.o.erode);
  if (maskCentroid(use, w, h).area < 0.3 * c.area) use = mask;
  const xs: number[] = [], ys: number[] = []; let x0 = w, y0 = h, x1 = 0, y1 = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (use[y * w + x]) { xs.push(x); ys.push(y); if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  return { tol: Math.max(ctx.o.inlierTol, 4.6 * noiseSigma(ctx.g[frame], w, h)), frame, mask, tpl: tplFrom(ctx.g[frame], ctx.f[frame], w, h, xs, ys), cx: c.x, cy: c.y, bbox: [x0, y0, x1, y1], mx: Int16Array.from(xs), my: Int16Array.from(ys) };
}
/** robust sensor-noise estimate (grey levels) from the keyframe: median |pixel - mean of 4 neighbours| */
function noiseSigma(g: Uint8Array, w: number, h: number): number {
  const hist = new Int32Array(256); let n = 0;
  for (let y = 1; y < h - 1; y += 2) for (let x = 1; x < w - 1; x += 2) { const i = y * w + x, e = Math.abs(g[i] - (g[i - 1] + g[i + 1] + g[i - w] + g[i + w]) / 4); hist[Math.min(255, Math.round(e))]++; n++; }
  let acc = 0, med = 0; for (let k = 0; k < 256; k++) { acc += hist[k]; if (acc >= n / 2) { med = k; break; } }
  return med / 0.6745 / Math.sqrt(1.25);
}
function lat(n: number) { return n > 1500 ? 3 : n > 400 ? 2 : 1; }

type Meas = { ox: number; oy: number; ix: number; iy: number; ncc: number; margin: number; inlier: number; visible: number; fb: number };
function measure(ctx: Ctx, a: Anchor, t: number, px: number, py: number, R: number, prev: { frame: number; ox: number; oy: number } | null): Meas | null {
  const { w, h, g } = ctx; ctx.matches++;
  const cx = Math.round(px), cy = Math.round(py);
  const m = match(a.tpl, g[t], w, h, cx - R, cx + R, cy - R, cy + R, R > 12 ? 2 : 1, lat(a.tpl.n), 0.5);
  if (!m) return null;
  const ag = agreement(a.tpl, ctx.f[t], w, h, m.ix, m.iy, a.tol);
  // forward-backward: template taken from frame t at the found place must lead back to the keyframe (and to the previous tracked frame)
  const back = tplFrom(g[t], ctx.f[t], w, h, a.mx.map((x) => x + m.ix), a.my.map((y) => y + m.iy));
  let fb = Infinity;
  { const e = { x: -m.x, y: -m.y }, r = match(back, g[a.frame], w, h, Math.round(e.x) - 5, Math.round(e.x) + 5, Math.round(e.y) - 5, Math.round(e.y) + 5, 1, lat(back.n) === 3 ? 2 : lat(back.n), 0.5); ctx.matches++; if (r) fb = Math.hypot(r.x - e.x, r.y - e.y); }
  if (prev) { const e = { x: prev.ox - m.x, y: prev.oy - m.y }, r = match(back, g[prev.frame], w, h, Math.round(e.x) - 5, Math.round(e.x) + 5, Math.round(e.y) - 5, Math.round(e.y) + 5, 1, lat(back.n) === 3 ? 2 : lat(back.n), 0.5); ctx.matches++; fb = Math.max(fb, r ? Math.hypot(r.x - e.x, r.y - e.y) : Infinity); }
  return { ox: m.x, oy: m.y, ix: m.ix, iy: m.iy, ncc: m.ncc, margin: m.margin, inlier: ag.inlier, visible: ag.visible, fb };
}
function visibleAt(a: Anchor, w: number, h: number, ox: number, oy: number): number {
  let n = 0; const rx = Math.round(ox), ry = Math.round(oy);
  for (let i = 0; i < a.mx.length; i++) { const x = a.mx[i] + rx, y = a.my[i] + ry; if (x >= 0 && y >= 0 && x < w && y < h) n++; }
  return n / Math.max(1, a.mx.length);
}

function trackDirection(ctx: Ctx, a: Anchor, dir: 1 | -1, stop: number, cand: Candidate[], anchorIdx: number): Map<number, Dir> {
  const o = ctx.o, { w, h } = ctx, out = new Map<number, Dir>();
  let lx = 0, ly = 0, lf = a.frame, vx = 0, vy = 0, coast = 0, gap = false, searching = false, sinceSearch = 0;
  const flat = a.tpl.flat;
  for (let t = a.frame + dir; dir > 0 ? t < stop : t > stop; t += dir) {
    ctx.cancelled();
    if (!searching) {
      const k = Math.abs(t - lf), px = lx + vx * k, py = ly + vy * k;
      const R = Math.min(60, o.radius + 4 * coast);
      let reason: TrackReason | null = null, m: Meas | null = null;
      if (flat) reason = "low_match";
      else if (visibleAt(a, w, h, px, py) < 0.35) reason = "leaving_frame";
      else {
        m = measure(ctx, a, t, px, py, R, lf === t - dir ? { frame: lf, ox: lx, oy: ly } : null);
        if (!m) reason = "low_match";
        else if (m.visible < o.visMin) reason = "leaving_frame";
        else if (m.inlier < o.inlierMin) reason = "occluded";
        else if (m.ncc < o.nccMin) reason = "low_match";
        else if (m.margin < o.ambiguityMin) reason = "ambiguous";
        else if (m.fb > o.fbMax) reason = "fb_mismatch";
        else if (Math.hypot(m.ox - px, m.oy - py) > R - 2) reason = "search_edge";
      }
      if (!reason && m) {
        out.set(t, { status: gap ? "reentry" : "tracked", ox: m.ox, oy: m.oy, ncc: m.ncc, margin: m.margin, inlier: m.inlier, fb: m.fb, visible: m.visible });
        if (lf === t - dir) { vx = 0.5 * vx + 0.5 * (m.ox - lx); vy = 0.5 * vy + 0.5 * (m.oy - ly); }
        lx = m.ox; ly = m.oy; lf = t; coast = 0; gap = false;
      } else {
        coast++; gap = true;
        const useM = m && m.ncc >= 0.4 && Math.hypot(m.ox - px, m.oy - py) <= 0.8 * R;
        if (coast > o.coastMax) { searching = true; out.set(t, { status: "lost", ox: px, oy: py, reason: reason! }); sinceSearch = 0; }
        else out.set(t, { status: "uncertain", ox: useM ? m!.ox : px, oy: useM ? m!.oy : py, ncc: m?.ncc, margin: m?.margin, inlier: m?.inlier, fb: Number.isFinite(m?.fb ?? NaN) ? m!.fb : undefined, visible: m?.visible, reason: reason! });
      }
    } else {
      out.set(t, { status: "lost", ox: lx, oy: ly, reason: "leaving_frame" });
      if (flat || ++sinceSearch % o.searchEvery !== 0) continue;
      const [bx0, by0, bx1, by1] = a.bbox, bw = bx1 - bx0, bh = by1 - by0;
      const m = match(a.tpl, ctx.g[t], w, h, Math.round(-bx0 - 0.2 * bw), Math.round(w - bx1 + 0.2 * bw), Math.round(-by0 - 0.2 * bh), Math.round(h - by1 + 0.2 * bh), 4, lat(a.tpl.n) === 3 ? 4 : lat(a.tpl.n) * 2, 0.8);
      ctx.matches++;
      if (!m || m.ncc < o.reacquireNcc || m.margin < o.ambiguityMin) continue;
      const ag = agreement(a.tpl, ctx.f[t], w, h, m.ix, m.iy, a.tol);
      if (ag.inlier < 0.85 || ag.visible < 0.85) continue;
      const back = tplFrom(ctx.g[t], ctx.f[t], w, h, a.mx.map((x) => x + m.ix), a.my.map((y) => y + m.iy));
      const r = match(back, ctx.g[a.frame], w, h, Math.round(-m.x) - 5, Math.round(-m.x) + 5, Math.round(-m.y) - 5, Math.round(-m.y) + 5, 1, lat(back.n) === 3 ? 2 : lat(back.n), 0.5);
      const fb = r ? Math.hypot(r.x + m.x, r.y + m.y) : Infinity;
      if (fb > o.fbMax) continue;
      cand.push({ frame: t, anchor: anchorIdx, dx: m.x, dy: m.y, ncc: m.ncc, inlier: ag.inlier, fb });
      if (o.autoResume) { out.set(t, { status: "reentry", ox: m.x, oy: m.y, ncc: m.ncc, margin: m.margin, inlier: ag.inlier, fb, visible: ag.visible }); lx = m.x; ly = m.y; lf = t; vx = vy = 0; coast = 0; gap = false; searching = false; }
    }
  }
  return out;
}

// ───────────────────────── public API ─────────────────────────
export function trackObject(frames: Frame[], w: number, h: number, keyframes: Keyframe[], opts: TrackOptions = {}): TrackResult {
  const T0 = now(), o = { ...DEF, ...opts }, N = frames.length, progress = o.onProgress ?? (() => {});
  const cancelled = () => { if (o.shouldCancel?.()) throw new TrackError("cancelled", "Tracking was cancelled. Nothing was changed."); };
  if (!(w > 0 && h > 0) || N === 0) throw new TrackError("bad_input", "There are no frames to track.");
  for (let t = 0; t < N; t++) if (frames[t].length !== w * h * 3) throw new TrackError("bad_input", `Frame ${t} has the wrong size.`);
  if (!keyframes.length) throw new TrackError("bad_input", "Mark the object on at least one frame first.");
  const kfs = [...keyframes].sort((a, b) => a.frame - b.frame);
  for (let i = 0; i < kfs.length; i++) {
    const k = kfs[i];
    if (!Number.isInteger(k.frame) || k.frame < 0 || k.frame >= N) throw new TrackError("bad_input", `Keyframe ${k.frame} is outside the clip (0–${N - 1}).`);
    if (i && kfs[i - 1].frame === k.frame) throw new TrackError("bad_input", `Two keyframes were given for frame ${k.frame}.`);
    if (k.absent) continue;
    if (!k.mask || k.mask.length !== w * h) throw new TrackError("bad_input", `The selection on frame ${k.frame} has the wrong size.`);
    const area = maskCentroid(k.mask, w, h).area;
    if (area === 0) throw new TrackError("bad_input", `Nothing is selected on frame ${k.frame}. Mark the object, or mark the frame as "object not visible".`);
    if (area < o.minArea) throw new TrackError("bad_input", `The selection on frame ${k.frame} is too small to track (${area} pixels, at least ${o.minArea} needed).`);
  }
  if (kfs.every((k) => k.absent)) throw new TrackError("bad_input", "Mark the object on at least one frame first.");

  let t0 = now();
  const g = frames.map((f) => gray(f, w * h));
  const ctx: Ctx = { w, h, f: frames, g, o, matches: 0, cancelled };
  const msGray = now() - t0;

  // anchors (one per non-absent keyframe) and the directional tracks between them
  t0 = now();
  const anchors: Array<Anchor | null> = kfs.map((k) => (k.absent ? null : makeAnchor(ctx, k.frame, k.mask!)));
  const cand: Candidate[] = [];
  const fwd: Array<Map<number, Dir> | null> = [], bwd: Array<Map<number, Dir> | null> = [];
  for (let i = 0; i < kfs.length; i++) {
    cancelled(); progress(0.7 * i / kfs.length, "Following the object");
    const a = anchors[i];
    fwd.push(a ? trackDirection(ctx, a, 1, i + 1 < kfs.length ? kfs[i + 1].frame : N, cand, i) : null);
    bwd.push(a ? trackDirection(ctx, a, -1, i > 0 ? kfs[i - 1].frame : -1, cand, i) : null);
  }
  const msTrack = now() - t0;

  // merge into one honest status per frame
  t0 = now();
  const res: TrackFrame[] = new Array(N);
  const kfIndexAt = new Map(kfs.map((k, i) => [k.frame, i]));
  const absAt = (ai: number, d: Dir) => ({ x: anchors[ai]!.cx + d.ox, y: anchors[ai]!.cy + d.oy });
  const asFrame = (ai: number, d: Dir, status: TrackStatus): TrackFrame => ({ status, anchor: ai, dx: d.ox, dy: d.oy, needsReview: status === "uncertain" || status === "lost" || status === "reentry", ncc: d.ncc, margin: d.margin, inlier: d.inlier, fb: d.fb, visible: d.visible, reason: d.reason });
  const gapFrame = (): TrackFrame => ({ status: "lost", anchor: -1, dx: 0, dy: 0, needsReview: true, reason: "leaving_frame" });
  for (let t = 0; t < N; t++) {
    const ki = kfIndexAt.get(t);
    if (ki !== undefined) { res[t] = anchors[ki] ? { status: "keyframe", anchor: ki, dx: 0, dy: 0, needsReview: false } : { status: "absent", anchor: -1, dx: 0, dy: 0, needsReview: false }; continue; }
    // neighbouring keyframes
    let lo = -1, hi = -1; for (let i = 0; i < kfs.length; i++) { if (kfs[i].frame < t) lo = i; else if (hi < 0) hi = i; }
    const F = lo >= 0 && fwd[lo] ? { ai: lo, d: fwd[lo]!.get(t) } : null;
    const B = hi >= 0 && bwd[hi] ? { ai: hi, d: bwd[hi]!.get(t) } : null;
    const f = F?.d, b = B?.d;
    if (lo >= 0 && hi >= 0) {
      if (!anchors[lo] && !anchors[hi]) { res[t] = { status: "absent", anchor: -1, dx: 0, dy: 0, needsReview: false }; continue; }
      const ft = f?.status === "tracked", bt = b?.status === "tracked";
      if (ft && bt) {
        const pf = absAt(F!.ai, f!), pb = absAt(B!.ai, b!);
        const near = t - kfs[lo].frame <= kfs[hi].frame - t ? F! : B!, nd = near === F ? f! : b!;
        // two tracks can only be compared when both keyframes outline the same extent of the object (centroids of different shapes differ by construction)
        const aa = maskCentroid(anchors[F!.ai]!.mask, w, h).area, ab = maskCentroid(anchors[B!.ai]!.mask, w, h).area, comparable = Math.abs(aa - ab) <= 0.15 * Math.max(aa, ab);
        res[t] = !comparable || Math.hypot(pf.x - pb.x, pf.y - pb.y) <= o.agreeTol ? asFrame(near.ai, nd, "tracked") : { ...asFrame(near.ai, nd, "uncertain"), reason: "fb_mismatch" };
      } else if (ft || bt) res[t] = ft ? asFrame(F!.ai, f!, "tracked") : asFrame(B!.ai, b!, "tracked");
      else if (anchors[lo] && anchors[hi]) {
        const s = (t - kfs[lo].frame) / (kfs[hi].frame - kfs[lo].frame), A = anchors[lo]!, Bn = anchors[hi]!;
        const px = A.cx + s * (Bn.cx - A.cx), py = A.cy + s * (Bn.cy - A.cy), ai = s <= 0.5 ? lo : hi, an = anchors[ai]!;
        res[t] = kfs[hi].frame - kfs[lo].frame <= o.maxInterpolation
          ? { status: "interpolated", anchor: ai, dx: px - an.cx, dy: py - an.cy, needsReview: false }
          : { status: "uncertain", anchor: ai, dx: px - an.cx, dy: py - an.cy, needsReview: true, reason: "gap_too_long" }; // straight-line guess over a long stretch is not a result
      } else {
        const pick = f && f.status !== "lost" ? { ai: F!.ai, d: f } : b && b.status !== "lost" ? { ai: B!.ai, d: b } : null;
        res[t] = pick ? asFrame(pick.ai, pick.d, pick.d.status === "tracked" ? "uncertain" : pick.d.status) : gapFrame();
        if (pick && pick.d.status === "tracked") res[t].reason = "leaving_frame"; // one end is a declared-absent keyframe: the stretch is not decided by the user
      }
    } else {
      const pick = F ?? B; // before the first / after the last keyframe
      res[t] = pick?.d ? asFrame(pick.ai, pick.d, pick.d.status) : gapFrame();
    }
  }
  const msMerge = now() - t0;

  // camera movement (background shifting) makes the "fixed camera" assumption of the cleanup invalid: warn
  t0 = now();
  const samples: TrackResult["camera"]["samples"] = [];
  if (o.checkCamera && N > 1) {
    for (let t = o.cameraStride; t < N; t += o.cameraStride) {
      cancelled(); progress(0.7 + 0.3 * t / N, "Checking camera movement");
      const okOf = (u: number) => { const k = res[u], m = k.anchor >= 0 && k.status !== "lost" ? dilateMask(shiftMask(anchors[k.anchor]!.mask, w, h, k.dx, k.dy), w, h, 6) : null; const a = new Uint8Array(w * h).fill(1); if (m) for (let i = 0; i < a.length; i++) if (m[i]) a[i] = 0; return a; };
      const e = estimateMotion(frames[t - 1], frames[t], okOf(t - 1), okOf(t), w, h, 10);
      samples.push({ frame: t, dx: e.dx, dy: e.dy, valid: e.valid });
    }
  }
  const camMoving = samples.length > 0 && samples.filter((s) => s.valid && (s.dx !== 0 || s.dy !== 0)).length >= Math.max(1, 0.3 * samples.length);
  const msCam = now() - t0;

  const counts = { keyframe: 0, tracked: 0, interpolated: 0, reentry: 0, uncertain: 0, lost: 0, absent: 0 } as Record<TrackStatus, number>;
  res.forEach((r) => counts[r.status]++);
  const needsReview = res.map((r, t) => (r.needsReview ? t : -1)).filter((t) => t >= 0);
  const warnings: TrackWarning[] = [];
  if (anchors.some((a) => a?.tpl.flat)) warnings.push({ code: "flat_object", message: "The selected object is almost a single flat colour, so it can't be followed automatically. Mark it by hand on more frames." });
  if (camMoving) warnings.push({ code: "camera_moving", message: "The background shifts from frame to frame (moving camera or scrolling scene). The object is followed on screen, but cleaning up a moving camera is not reliable." });
  const unc = res.map((r, t) => (r.status === "uncertain" ? t : -1)).filter((t) => t >= 0), lost = res.map((r, t) => (r.status === "lost" ? t : -1)).filter((t) => t >= 0), re = res.map((r, t) => (r.status === "reentry" ? t : -1)).filter((t) => t >= 0);
  if (unc.length) warnings.push({ code: "uncertain_frames", frames: unc, message: `The object could not be followed with confidence on ${unc.length} frame${unc.length > 1 ? "s" : ""} (first: ${unc[0]}). A best guess is shown; check or correct those frames.` });
  if (lost.length) warnings.push({ code: "lost_frames", frames: lost, message: `The object was lost on ${lost.length} frame${lost.length > 1 ? "s" : ""} (first: ${lost[0]}). Mark it again on a later frame, or mark the frames where it is not visible.` });
  if (re.length || cand.length) warnings.push({ code: "reentry", frames: re.length ? re : cand.map((c) => c.frame).slice(0, 5), message: re.length ? `The object was found again at frame ${re[0]}. Please confirm it is the same object.` : `Something that looks like the object appears again at frame ${cand[0].frame}. Mark it there to continue tracking.` });
  if (counts.interpolated) warnings.push({ code: "interpolated", frames: res.map((r, t) => (r.status === "interpolated" ? t : -1)).filter((t) => t >= 0), message: `${counts.interpolated} frame${counts.interpolated > 1 ? "s were" : " was"} placed by straight-line interpolation between your keyframes, not by tracking.` });
  progress(1, "Done");
  return { frames: res, keyframes: kfs.map((k, i) => ({ frame: k.frame, mask: anchors[i] ? anchors[i]!.mask : null })), w, h, needsReview, warnings, candidates: cand, camera: { checked: samples.length, moving: camMoving, samples }, counts,
    stats: { ms: { gray: msGray, track: msTrack, merge: msMerge, camera: msCam, total: now() - T0 }, matches: ctx.matches } };
}

/** the mask for one frame (null when the object is absent or lost) */
export function maskAt(r: TrackResult, t: number): Uint8Array | null {
  const f = r.frames[t];
  if (f.anchor < 0 || f.status === "lost" || f.status === "absent") return null;
  const km = r.keyframes[f.anchor].mask; if (!km) return null;
  return f.status === "keyframe" ? Uint8Array.from(km) : shiftMask(km, r.w, r.h, f.dx, f.dy);
}
/** Masks for cleanup. REFUSES while any frame is uncertain, lost or a re-entry awaiting confirmation: failed tracking is never a result. */
export function resolveMasks(r: TrackResult): Array<Uint8Array | null> {
  if (r.needsReview.length) {
    const by: Record<string, number> = {}; r.needsReview.forEach((t) => { by[r.frames[t].status] = (by[r.frames[t].status] ?? 0) + 1; });
    const first = r.needsReview[0], why = r.frames[first].reason;
    throw new TrackError("unresolved_tracking", `Tracking is not finished: ${r.needsReview.length} frame${r.needsReview.length > 1 ? "s need" : " needs"} your attention (first: frame ${first}${why ? `, ${why.replace(/_/g, " ")}` : ""}). Mark the object on those frames, or mark them as "object not visible". Nothing was cleaned up.`, { frames: r.needsReview, byStatus: by });
  }
  return r.frames.map((_, t) => maskAt(r, t));
}
