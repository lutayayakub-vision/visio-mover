import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";

export type Img = { w: number; h: number; rgba: Uint8ClampedArray };
function rng(seed: number) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

/** Diagonal stripes with fine noise: a periodic texture a good inpainter can continue and a blur cannot. */
export function stripes(w: number, h: number, seed = 1): Img {
  const r = rng(seed), rgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const v = Math.sin((x + y) * 0.5) > 0 ? 200 : 60, n = (r() - 0.5) * 14, o = (y * w + x) * 4;
    rgba[o] = v + n; rgba[o + 1] = v * 0.8 + n; rgba[o + 2] = 90 + v * 0.3 + n; rgba[o + 3] = 255;
  }
  return { w, h, rgba };
}

/** Brick wall: rows of bricks with mortar lines and per-brick colour. */
export function bricks(w: number, h: number, seed = 2): Img {
  const r = rng(seed), rgba = new Uint8ClampedArray(w * h * 4);
  const bw = 28, bh = 12, tone = new Map<string, number>();
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const row = Math.floor(y / bh), off = row % 2 ? bw / 2 : 0, col = Math.floor((x + off) / bw);
    const k = row + "," + col; if (!tone.has(k)) tone.set(k, (r() - 0.5) * 40);
    const mortar = y % bh < 2 || (x + off) % bw < 2;
    const base = mortar ? 190 : 150 + tone.get(k)!, n = (r() - 0.5) * 10, o = (y * w + x) * 4;
    rgba[o] = base + n; rgba[o + 1] = (mortar ? 188 : 80 + tone.get(k)! * 0.4) + n; rgba[o + 2] = (mortar ? 180 : 60) + n; rgba[o + 3] = 255;
  }
  return { w, h, rgba };
}

/** Sky gradient over noisy grass with a horizon: tests structure continuing across a region. */
export function scene(w: number, h: number, seed = 3): Img {
  const r = rng(seed), rgba = new Uint8ClampedArray(w * h * 4), hor = Math.floor(h * 0.55);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = (y * w + x) * 4; let R: number, G: number, B: number;
    if (y < hor) { const t = y / hor; R = 90 + 90 * t; G = 150 + 70 * t; B = 235 - 20 * t; }
    else { const n = r(); R = 40 + n * 30; G = 110 + n * 70 + Math.sin(x * 0.9) * 12; B = 30 + n * 25; }
    rgba[o] = R; rgba[o + 1] = G; rgba[o + 2] = B; rgba[o + 3] = 255;
  }
  return { w, h, rgba };
}

export function discMask(w: number, h: number, cx: number, cy: number, rad: number): Uint8Array {
  const m = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if ((x - cx) ** 2 + (y - cy) ** 2 <= rad * rad) m[y * w + x] = 255;
  return m;
}

/** Paint a flat red "unwanted object" into the masked pixels, so the input really contains something to remove. */
export function withObject(img: Img, mask: Uint8Array): Uint8ClampedArray {
  const out = new Uint8ClampedArray(img.rgba);
  for (let i = 0; i < mask.length; i++) if (mask[i] > 127) { out[i * 4] = 220; out[i * 4 + 1] = 30; out[i * 4 + 2] = 40; }
  return out;
}

export function mae(a: Uint8ClampedArray, b: Uint8ClampedArray, mask: Uint8Array): number {
  let s = 0, n = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i] > 127) { for (let c = 0; c < 3; c++) s += Math.abs(a[i * 4 + c] - b[i * 4 + c]); n += 3; }
  return n ? s / n : 0;
}

export function meanFill(rgba: Uint8ClampedArray, mask: Uint8Array): Uint8ClampedArray {
  const out = new Uint8ClampedArray(rgba); let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i] <= 127) { r += rgba[i * 4]; g += rgba[i * 4 + 1]; b += rgba[i * 4 + 2]; n++; }
  for (let i = 0; i < mask.length; i++) if (mask[i] > 127) { out[i * 4] = r / n; out[i * 4 + 1] = g / n; out[i * 4 + 2] = b / n; }
  return out;
}

const crcTable = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
export function writePng(path: string, img: { w: number; h: number; rgba: Uint8ClampedArray }) {
  const raw = Buffer.alloc((img.w * 4 + 1) * img.h);
  for (let y = 0; y < img.h; y++) { raw[y * (img.w * 4 + 1)] = 0; Buffer.from(img.rgba.buffer, img.rgba.byteOffset + y * img.w * 4, img.w * 4).copy(raw, y * (img.w * 4 + 1) + 1); }
  const chunk = (type: string, data: Buffer) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(img.w, 0); ihdr.writeUInt32BE(img.h, 4); ihdr[8] = 8; ihdr[9] = 6;
  writeFileSync(path, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]));
}
