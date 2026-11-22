/**
 * Selection strokes for the cleanup brush. Strokes are stored as vectors in IMAGE pixel units, so the mask can be rebuilt
 * exactly at any resolution (screen preview, full-size image), undo/redo is just "drop / restore the last stroke",
 * and changing the brush size later never degrades earlier strokes.
 *
 * Pure functions with no DOM access, so they run unchanged in the browser, the worker and Node tests.
 */
export type Stroke = {
  /** true = the eraser (removes selection), false = the selection brush */
  erase: boolean;
  /** brush radius in image pixels */
  r: number;
  /** flat list of x,y points in image pixels. One point = a dot. */
  pts: number[];
};

export type Rect = { x: number; y: number; w: number; h: number };

export const MIN_BRUSH = 1;

/** Largest rectangle (image px) touched by any paint stroke, padded by its radius. Eraser strokes are ignored (they only remove). */
export function strokeBounds(strokes: Stroke[], imgW: number, imgH: number): Rect | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of strokes) {
    if (s.erase) continue;
    for (let i = 0; i + 1 < s.pts.length; i += 2) {
      x0 = Math.min(x0, s.pts[i] - s.r); x1 = Math.max(x1, s.pts[i] + s.r);
      y0 = Math.min(y0, s.pts[i + 1] - s.r); y1 = Math.max(y1, s.pts[i + 1] + s.r);
    }
  }
  if (!isFinite(x0)) return null;
  x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0));
  x1 = Math.min(imgW, Math.ceil(x1)); y1 = Math.min(imgH, Math.ceil(y1));
  if (x1 <= x0 || y1 <= y0) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function fillCapsule(mask: Uint8Array, rw: number, rh: number, ox: number, oy: number, ax: number, ay: number, bx: number, by: number, rad: number, value: number) {
  // ox,oy = origin of the raster in the same (scaled) coordinate system as the points
  const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - rad - ox - 0.5)), x1 = Math.min(rw - 1, Math.ceil(Math.max(ax, bx) + rad - ox - 0.5));
  const y0 = Math.max(0, Math.floor(Math.min(ay, by) - rad - oy - 0.5)), y1 = Math.min(rh - 1, Math.ceil(Math.max(ay, by) + rad - oy - 0.5));
  if (x1 < x0 || y1 < y0) return;
  const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy, r2 = rad * rad;
  for (let y = y0; y <= y1; y++) {
    const py = oy + y + 0.5;
    for (let x = x0; x <= x1; x++) {
      const px = ox + x + 0.5;
      let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const cx = ax + t * dx - px, cy = ay + t * dy - py;
      if (cx * cx + cy * cy <= r2) mask[y * rw + x] = value;
    }
  }
}

/**
 * Rasterise strokes into a 0/255 mask for `rect` (given in raster pixels at `scale` x image resolution).
 * Strokes are applied in order, so an eraser stroke removes what earlier strokes selected and a later paint stroke can re-add it.
 */
export function rasterMask(strokes: Stroke[], rect: Rect, scale = 1): Uint8Array {
  const mask = new Uint8Array(rect.w * rect.h);
  for (const s of strokes) {
    const v = s.erase ? 0 : 255;
    // never smaller than 0.75 raster px, so even the tiniest dot always selects the pixel it was placed on
    const rad = Math.max(0.75, s.r * scale);
    const p = s.pts;
    if (p.length < 2) continue;
    if (p.length < 4) { fillCapsule(mask, rect.w, rect.h, rect.x, rect.y, p[0] * scale, p[1] * scale, p[0] * scale, p[1] * scale, rad, v); continue; }
    for (let i = 0; i + 3 < p.length; i += 2) fillCapsule(mask, rect.w, rect.h, rect.x, rect.y, p[i] * scale, p[i + 1] * scale, p[i + 2] * scale, p[i + 3] * scale, rad, v);
  }
  return mask;
}

/** Tight bounds of the selected pixels (>127) in a mask, or null when nothing is selected. */
export function maskBounds(mask: Uint8Array, w: number, h: number): Rect | null {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (mask[y * w + x] > 127) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

export function maskCount(mask: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i] > 127) n++;
  return n;
}

/** Compact, size-limited description of the selection for the edit record (no raw point data, which could be large). */
export function describeStrokes(strokes: Stroke[]) {
  let paint = 0, erase = 0, rMin = Infinity, rMax = 0;
  for (const s of strokes) { if (s.erase) erase++; else paint++; rMin = Math.min(rMin, s.r); rMax = Math.max(rMax, s.r); }
  return { paintStrokes: paint, eraseStrokes: erase, brushMin: isFinite(rMin) ? Math.round(rMin) : 0, brushMax: Math.round(rMax) };
}
