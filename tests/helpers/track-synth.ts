// Synthetic clips with analytic ground truth for tracker tests (sub-pixel exact: the object is a continuous function sampled at fractional centres).
export type Frame = Uint8Array;
export const W = 320, H = 240;
export function rngf(seed: number) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
export function gauss(r: () => number) { return Math.sqrt(-2 * Math.log(Math.max(1e-12, r()))) * Math.cos(2 * Math.PI * r()); }
export function texture(seed: number, tw: number, th: number): Uint8Array {
  const r = rngf(seed), G = 10, gw = Math.ceil(tw / G) + 2, gh = Math.ceil(th / G) + 2;
  const grid = Array.from({ length: 3 }, () => Float32Array.from({ length: gw * gh }, () => 40 + r() * 170));
  const out = new Uint8Array(tw * th * 3);
  for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) for (let c = 0; c < 3; c++) {
    const gx = x / G, gy = y / G, x0 = gx | 0, y0 = gy | 0, fx = gx - x0, fy = gy - y0, g = grid[c];
    out[(y * tw + x) * 3 + c] = g[y0 * gw + x0] * (1 - fx) * (1 - fy) + g[y0 * gw + x0 + 1] * fx * (1 - fy) + g[(y0 + 1) * gw + x0] * (1 - fx) * fy + g[(y0 + 1) * gw + x0 + 1] * fx * fy;
  }
  return out;
}
/** object colour at offset (u,v) from its centre, radius R (continuous function => exact sub-pixel truth) */
export function objectAt(u: number, v: number, R: number): { a: number; rgb: [number, number, number] } {
  const d = Math.hypot(u, v), a = Math.max(0, Math.min(1, R + 0.5 - d));
  if (a <= 0) return { a: 0, rgb: [0, 0, 0] };
  const t = d / R; let rgb: [number, number, number] = [215 * (1 - 0.25 * t), 35 * (1 - 0.25 * t), 40 * (1 - 0.25 * t)];
  if (Math.abs(t - 0.62) < 0.09) rgb = [245, 245, 245];
  if (Math.hypot(u - 0.35 * R, v + 0.25 * R) < 0.17 * R) rgb = [40, 20, 150];
  if (Math.abs(u + 0.45 * R) < 0.07 * R && v > 0) rgb = [30, 200, 60];
  return { a, rgb };
}
export type Spec = {
  n: number; path: (t: number) => [number, number]; R?: number; seed?: number; noise?: number;
  scale?: (t: number) => number; gain?: (t: number) => number;
  occluders?: Array<{ x0: number; x1: number; y0?: number; y1?: number; from?: number; to?: number }>;
  distractor?: (t: number) => [number, number] | null;
};
export type Clip = { frames: Frame[]; masks: Uint8Array[]; centres: Array<[number, number]>; vis: number[]; bg: Frame; R: number };
export function makeClip(s: Spec): Clip {
  const R = s.R ?? 22, bg = texture(s.seed ?? 3, W, H), rn = rngf((s.seed ?? 3) + 1000);
  const frames: Frame[] = [], masks: Uint8Array[] = [], centres: Array<[number, number]> = [], full: number[] = [];
  for (let t = 0; t < s.n; t++) {
    const f = Uint8Array.from(bg), m = new Uint8Array(W * H), [cx, cy] = s.path(t), sc = s.scale ? s.scale(t) : 1, gn = s.gain ? s.gain(t) : 1, r = R * sc;
    const draw = (px: number, py: number, mark: boolean) => {
      for (let y = Math.max(0, Math.floor(py - r - 2)); y <= Math.min(H - 1, Math.ceil(py + r + 2)); y++) for (let x = Math.max(0, Math.floor(px - r - 2)); x <= Math.min(W - 1, Math.ceil(px + r + 2)); x++) {
        const o = objectAt((x - px) / sc, (y - py) / sc, R), i = y * W + x;
        if (o.a > 0) { for (let c = 0; c < 3; c++) f[i * 3 + c] = f[i * 3 + c] * (1 - o.a) + o.rgb[c] * gn * o.a; if (mark && o.a >= 0.5) m[i] = 1; }
      }
    };
    const d = s.distractor?.(t); if (d) draw(d[0], d[1], false);
    draw(cx, cy, true);
    let fullArea = 0; for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (objectAt((x - cx) / sc, (y - cy) / sc, R).a >= 0.5) fullArea++;
    for (const oc of s.occluders ?? []) if ((oc.from ?? 0) <= t && t <= (oc.to ?? s.n)) for (let y = oc.y0 ?? 0; y < (oc.y1 ?? H); y++) for (let x = oc.x0; x < oc.x1; x++) { const i = y * W + x; f[i * 3] = 70 + (x % 3) * 2; f[i * 3 + 1] = 74; f[i * 3 + 2] = 82; m[i] = 0; }
    if (s.noise) for (let i = 0; i < f.length; i++) f[i] = Math.max(0, Math.min(255, Math.round(f[i] + gauss(rn) * s.noise)));
    else for (let i = 0; i < f.length; i++) f[i] = Math.round(f[i]);
    let a = 0; for (let i = 0; i < m.length; i++) a += m[i];
    frames.push(f); masks.push(m); centres.push([cx, cy]); full.push(fullArea);
  }
  const vis = masks.map((m, t) => { let a = 0; for (let i = 0; i < m.length; i++) a += m[i]; return full[t] ? a / full[t] : 0; });
  return { frames, masks, centres, vis, bg, R };
}
