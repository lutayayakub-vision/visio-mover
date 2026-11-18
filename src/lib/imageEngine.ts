/**
 * VISIOMOVER image engine. Runs entirely in the browser (Canvas 2D), so original files never leave the device
 * until the user chooses "Save to workspace". The original File/bitmap is never modified; every export is a new Blob.
 *
 * Pipeline (single canvas pass): rotate -> flip -> crop -> resize  =>  brightness/contrast/saturation  =>  encode.
 */

export type Rotation = 0 | 90 | 180 | 270;
/** Crop rectangle, normalised 0..1, in the frame AFTER rotation and flipping. */
export type Crop = { x: number; y: number; w: number; h: number };
export type ImageOps = {
  rotate: Rotation;
  flipH: boolean;
  flipV: boolean;
  crop: Crop | null;
  /** Explicit output size in pixels. null = keep the cropped size. */
  resize: { width: number; height: number } | null;
  /** -100..100 (0 = unchanged) */
  brightness: number;
  contrast: number;
  saturation: number;
};

export const DEFAULT_OPS: ImageOps = { rotate: 0, flipH: false, flipV: false, crop: null, resize: null, brightness: 0, contrast: 0, saturation: 0 };

export type OutFormat = "jpg" | "jpeg" | "png" | "webp";
export const FORMATS: Record<OutFormat, { mime: string; ext: string; label: string; lossy: boolean }> = {
  jpg: { mime: "image/jpeg", ext: "jpg", label: "JPG", lossy: true },
  jpeg: { mime: "image/jpeg", ext: "jpeg", label: "JPEG", lossy: true },
  png: { mime: "image/png", ext: "png", label: "PNG", lossy: false },
  webp: { mime: "image/webp", ext: "webp", label: "WEBP", lossy: true },
};

export type ImageErrorCode = "unsupported" | "corrupt" | "too_large" | "decode_failed" | "format_unsupported" | "cancelled" | "memory";
export class ImageError extends Error {
  code: ImageErrorCode;
  constructor(code: ImageErrorCode, message: string) { super(message); this.code = code; this.name = "ImageError"; }
}

const MP = 1_000_000;

export type DeviceProfile = { mobile: boolean; maxSourcePixels: number; maxOutputPixels: number; previewSide: number };

/** Conservative limits so phones do not run out of memory or hit canvas size caps (iOS caps canvases near 16.7 MP). */
export function deviceProfile(): DeviceProfile {
  const nav = typeof navigator !== "undefined" ? navigator : undefined;
  const ua = nav?.userAgent ?? "";
  const mem = (nav as unknown as { deviceMemory?: number } | undefined)?.deviceMemory;
  const mobile = /Android|iPhone|iPad|iPod/i.test(ua) || (!!nav && nav.maxTouchPoints > 1 && /Mac/i.test(nav.platform ?? "")) || (mem !== undefined && mem <= 2);
  return mobile
    ? { mobile, maxSourcePixels: 36 * MP, maxOutputPixels: 16 * MP, previewSide: 1100 }
    : { mobile, maxSourcePixels: 100 * MP, maxOutputPixels: 64 * MP, previewSide: 1600 };
}

// ───────────────────────── file inspection (before any decoding) ─────────────────────────

const at = (b: Uint8Array, o: number, s: string) => s.split("").every((c, i) => b[o + i] === c.charCodeAt(0));

export type ImageKind = "jpeg" | "png" | "webp";

export function sniffImageKind(b: Uint8Array): ImageKind | null {
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (b[0] === 0x89 && at(b, 1, "PNG")) return "png";
  if (at(b, 0, "RIFF") && at(b, 8, "WEBP")) return "webp";
  return null;
}

/** Reads width/height from the file header without decoding pixels (so oversized images are refused before they can exhaust memory). */
export function parseImageSize(b: Uint8Array, kind: ImageKind): { width: number; height: number } | null {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  try {
    if (kind === "png") return { width: dv.getUint32(16), height: dv.getUint32(20) };
    if (kind === "jpeg") {
      let o = 2;
      while (o + 9 < b.length) {
        if (b[o] !== 0xff) { o++; continue; }
        const m = b[o + 1];
        if (m === 0xff) { o++; continue; }
        if ((m >= 0xc0 && m <= 0xcf) && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { height: dv.getUint16(o + 5), width: dv.getUint16(o + 7) };
        if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01) { o += 2; continue; }
        o += 2 + dv.getUint16(o + 2);
      }
      return null;
    }
    // webp
    if (at(b, 12, "VP8X")) return { width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
    if (at(b, 12, "VP8L")) { const v = dv.getUint32(21, true); return { width: (v & 0x3fff) + 1, height: ((v >> 14) & 0x3fff) + 1 }; }
    if (at(b, 12, "VP8 ")) return { width: dv.getUint16(26, true) & 0x3fff, height: dv.getUint16(28, true) & 0x3fff };
  } catch { /* fall through */ }
  return null;
}

export type DecodedImage = { bitmap: ImageBitmap; width: number; height: number; kind: ImageKind };

/** Validates then decodes a user file. EXIF orientation is applied so what the user sees is what is edited. */
export async function decodeImage(file: Blob, profile = deviceProfile()): Promise<DecodedImage> {
  let head: Uint8Array;
  try { head = new Uint8Array(await file.slice(0, 512 * 1024).arrayBuffer()); }
  catch { throw new ImageError("decode_failed", "This image couldn't be read. Try selecting it again."); }
  const kind = sniffImageKind(head);
  if (!kind) throw new ImageError("unsupported", "This isn't a supported image. Use JPG, PNG or WEBP.");
  const size = parseImageSize(head, kind);
  if (!size || size.width < 1 || size.height < 1) throw new ImageError("corrupt", "This image looks damaged, so it can't be edited.");
  if (size.width * size.height > profile.maxSourcePixels) {
    throw new ImageError("too_large", `This image is ${size.width} × ${size.height} (${(size.width * size.height / MP).toFixed(0)} megapixels). ${profile.mobile ? "On a phone" : "In the browser"} the limit is ${profile.maxSourcePixels / MP} megapixels. Resize it on a computer first, or pick a smaller image.`);
  }
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    return { bitmap, width: bitmap.width, height: bitmap.height, kind };
  } catch (e) {
    if (e instanceof Error && /memory|allocation/i.test(e.message)) throw new ImageError("memory", "Not enough memory to open this image. Close other tabs or use a smaller image.");
    throw new ImageError("decode_failed", "This image couldn't be opened. It may be damaged or use an unsupported variant.");
  }
}

// ───────────────────────── geometry ─────────────────────────

export const rotatedSize = (w: number, h: number, r: Rotation) => (r === 90 || r === 270 ? { w: h, h: w } : { w, h });

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function cropRectPx(crop: Crop | null, rw: number, rh: number) {
  if (!crop) return { x: 0, y: 0, w: rw, h: rh };
  const x = clamp(Math.round(crop.x * rw), 0, rw - 1);
  const y = clamp(Math.round(crop.y * rh), 0, rh - 1);
  const w = clamp(Math.round(crop.w * rw), 1, rw - x);
  const h = clamp(Math.round(crop.h * rh), 1, rh - y);
  return { x, y, w, h };
}

/** Output size for a given source and ops; scales down (keeping aspect ratio) if limits would be exceeded. */
export function outputSize(sw: number, sh: number, ops: ImageOps, limits: { maxOutputPixels?: number; maxSide?: number } = {}) {
  const r = rotatedSize(sw, sh, ops.rotate);
  const c = cropRectPx(ops.crop, r.w, r.h);
  let w = ops.resize ? Math.max(1, Math.round(ops.resize.width)) : c.w;
  let h = ops.resize ? Math.max(1, Math.round(ops.resize.height)) : c.h;
  let limited = false;
  // floor (not round) so the limit is never exceeded by rounding
  const shrink = (f: number) => { w = Math.max(1, Math.floor(w * f)); h = Math.max(1, Math.floor(h * f)); limited = true; };
  if (limits.maxOutputPixels && w * h > limits.maxOutputPixels) shrink(Math.sqrt(limits.maxOutputPixels / (w * h)));
  if (limits.maxSide && Math.max(w, h) > limits.maxSide) shrink(limits.maxSide / Math.max(w, h));
  return { w, h, crop: c, rotated: r, limited };
}

/** Width/height after an edit that keeps the aspect ratio. */
export function fitKeepingAspect(baseW: number, baseH: number, edit: { width?: number; height?: number }) {
  if (edit.width !== undefined) return { width: Math.max(1, Math.round(edit.width)), height: Math.max(1, Math.round((edit.width * baseH) / baseW)) };
  if (edit.height !== undefined) return { width: Math.max(1, Math.round((edit.height * baseW) / baseH)), height: Math.max(1, Math.round(edit.height)) };
  return { width: baseW, height: baseH };
}

// ───────────────────────── rendering ─────────────────────────

type Progress = (fraction: number) => void;
export type RenderOptions = {
  maxOutputPixels?: number;
  maxSide?: number;
  /** Fill colour painted first (JPEG has no transparency). */
  background?: string | null;
  /** Skip colour adjustments (used while cropping). */
  skipAdjust?: boolean;
  onProgress?: Progress;
  signal?: AbortSignal;
};

const yieldToUi = () => new Promise<void>((r) => setTimeout(r, 0));
const checkAbort = (s?: AbortSignal) => { if (s?.aborted) throw new ImageError("cancelled", "Cancelled."); };

function newCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  return c;
}

export function buildLut(brightness: number, contrast: number): Uint8ClampedArray {
  const b = 1 + brightness / 100;
  const c = 1 + contrast / 100;
  const lut = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i++) lut[i] = Math.round(((i / 255) * b - 0.5) * c * 255 + 127.5);
  return lut;
}

/** Brightness + contrast via lookup table, then saturation via the standard luminance matrix. Works in every browser (no reliance on ctx.filter). */
export async function applyAdjustments(canvas: HTMLCanvasElement, ops: Pick<ImageOps, "brightness" | "contrast" | "saturation">, onProgress?: Progress, signal?: AbortSignal) {
  if (!ops.brightness && !ops.contrast && !ops.saturation) { onProgress?.(1); return; }
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  const lut = buildLut(ops.brightness, ops.contrast);
  const useLut = ops.brightness !== 0 || ops.contrast !== 0;
  const s = 1 + ops.saturation / 100;
  const useSat = ops.saturation !== 0;
  const m00 = 0.213 + 0.787 * s, m01 = 0.715 - 0.715 * s, m02 = 0.072 - 0.072 * s;
  const m10 = 0.213 - 0.213 * s, m11 = 0.715 + 0.285 * s, m12 = 0.072 - 0.072 * s;
  const m20 = 0.213 - 0.213 * s, m21 = 0.715 - 0.715 * s, m22 = 0.072 + 0.928 * s;
  const { width, height } = canvas;
  const band = Math.max(1, Math.floor(1_000_000 / width));
  for (let y = 0; y < height; y += band) {
    checkAbort(signal);
    const hh = Math.min(band, height - y);
    const img = ctx.getImageData(0, y, width, hh);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      let r = d[i], g = d[i + 1], b = d[i + 2];
      if (useLut) { r = lut[r]; g = lut[g]; b = lut[b]; }
      if (useSat) {
        const nr = m00 * r + m01 * g + m02 * b;
        const ng = m10 * r + m11 * g + m12 * b;
        const nb = m20 * r + m21 * g + m22 * b;
        d[i] = nr; d[i + 1] = ng; d[i + 2] = nb; // Uint8ClampedArray clamps and rounds
      } else { d[i] = r; d[i + 1] = g; d[i + 2] = b; }
    }
    ctx.putImageData(img, 0, y);
    onProgress?.(Math.min(1, (y + hh) / height));
    await yieldToUi();
  }
}

/** Draws source through rotate/flip/crop/resize in one pass, then applies adjustments. Returns a new canvas. */
export async function renderImage(
  src: ImageBitmap | HTMLImageElement | HTMLCanvasElement, ops: ImageOps, opts: RenderOptions = {},
): Promise<{ canvas: HTMLCanvasElement; width: number; height: number; limited: boolean }> {
  checkAbort(opts.signal);
  const sw = (src as ImageBitmap).width, sh = (src as ImageBitmap).height;
  const o = outputSize(sw, sh, ops, { maxOutputPixels: opts.maxOutputPixels, maxSide: opts.maxSide });
  let canvas: HTMLCanvasElement;
  try { canvas = newCanvas(o.w, o.h); } catch { throw new ImageError("memory", "Not enough memory for this output size. Choose a smaller size."); }
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new ImageError("memory", "Not enough memory for this output size. Choose a smaller size.");
  if (opts.background) { ctx.fillStyle = opts.background; ctx.fillRect(0, 0, o.w, o.h); }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";

  const { rotated: r, crop: c } = o;
  ctx.save();
  ctx.scale(o.w / c.w, o.h / c.h);
  ctx.translate(-c.x, -c.y);
  ctx.translate(r.w / 2, r.h / 2);
  ctx.scale(ops.flipH ? -1 : 1, ops.flipV ? -1 : 1);
  ctx.translate(-r.w / 2, -r.h / 2);
  ctx.translate(r.w / 2, r.h / 2);
  ctx.rotate((ops.rotate * Math.PI) / 180);
  ctx.translate(-sw / 2, -sh / 2);
  ctx.drawImage(src, 0, 0);
  ctx.restore();
  opts.onProgress?.(0.2);
  await yieldToUi();

  if (!opts.skipAdjust) await applyAdjustments(canvas, ops, (f) => opts.onProgress?.(0.2 + 0.8 * f), opts.signal);
  opts.onProgress?.(1);
  return { canvas, width: o.w, height: o.h, limited: o.limited };
}

function toBlob(canvas: HTMLCanvasElement, mime: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new ImageError("memory", "The browser couldn't create the file (not enough memory). Try a smaller size."))), mime, quality);
    } catch { reject(new ImageError("decode_failed", "The browser couldn't encode this image.")); }
  });
}

export type ExportSettings = { format: OutFormat; /** 0.1 .. 1 */ quality: number };
export type ExportResult = { blob: Blob; width: number; height: number; mime: string; ext: string; ms: number; limited: boolean };

/** Full-resolution export. Progress 0..0.9 covers rendering, the rest the encode step. */
export async function exportImage(
  source: ImageBitmap, ops: ImageOps, settings: ExportSettings,
  opts: { onProgress?: Progress; signal?: AbortSignal; profile?: DeviceProfile } = {},
): Promise<ExportResult> {
  const t0 = performance.now();
  const f = FORMATS[settings.format];
  const profile = opts.profile ?? deviceProfile();
  const { canvas, width, height, limited } = await renderImage(source, ops, {
    maxOutputPixels: profile.maxOutputPixels,
    background: f.lossy && f.mime === "image/jpeg" ? "#ffffff" : null,
    onProgress: (p) => opts.onProgress?.(p * 0.9),
    signal: opts.signal,
  });
  checkAbort(opts.signal);
  opts.onProgress?.(0.92);
  const blob = await toBlob(canvas, f.mime, f.lossy ? clamp(settings.quality, 0.05, 1) : undefined);
  canvas.width = canvas.height = 0; // release the pixel buffer promptly
  if (blob.type !== f.mime) throw new ImageError("format_unsupported", `This browser can't create ${f.label} files. Choose JPG or PNG instead.`);
  opts.onProgress?.(1);
  return { blob, width, height, mime: f.mime, ext: f.ext, ms: Math.round(performance.now() - t0), limited };
}

/** Small copy used for live preview while editing. Heavy full-size work only happens on export. */
export async function makeWorkingCopy(bitmap: ImageBitmap, maxSide: number): Promise<ImageBitmap | HTMLCanvasElement> {
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  if (scale >= 1) return bitmap;
  const c = newCanvas(Math.max(1, Math.round(bitmap.width * scale)), Math.max(1, Math.round(bitmap.height * scale)));
  const ctx = c.getContext("2d")!;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, 0, 0, c.width, c.height);
  return c;
}

export function describeOps(ops: ImageOps, settings: ExportSettings, out: { width: number; height: number }): Record<string, unknown> {
  return {
    kind: "image",
    rotate: ops.rotate, flipH: ops.flipH, flipV: ops.flipV,
    crop: ops.crop ? { x: +ops.crop.x.toFixed(4), y: +ops.crop.y.toFixed(4), w: +ops.crop.w.toFixed(4), h: +ops.crop.h.toFixed(4) } : null,
    brightness: ops.brightness, contrast: ops.contrast, saturation: ops.saturation,
    output: { width: out.width, height: out.height, format: settings.format, quality: FORMATS[settings.format].lossy ? Math.round(settings.quality * 100) : null },
  };
}

// ───────────────────────── editor helpers (visible-frame transforms) ─────────────────────────
// The engine applies rotate -> flip -> crop. Users think in what they SEE, so these helpers apply a visible
// rotation/flip on top of existing ops and keep the stored ops (and the crop rectangle) consistent.

const cropCW = (c: Crop): Crop => ({ x: 1 - c.y - c.h, y: c.x, w: c.h, h: c.w });
const cropCCW = (c: Crop): Crop => ({ x: c.y, y: 1 - c.x - c.w, w: c.h, h: c.w });
const cropFlipH = (c: Crop): Crop => ({ ...c, x: 1 - c.x - c.w });
const cropFlipV = (c: Crop): Crop => ({ ...c, y: 1 - c.y - c.h });

/** Rotate what the user currently sees by 90 degrees. A single mirror reverses the sense of rotation in source terms. */
export function rotateVisible(ops: ImageOps, dir: "cw" | "ccw"): ImageOps {
  const singleFlip = ops.flipH !== ops.flipV;
  const sign = (dir === "cw" ? 1 : -1) * (singleFlip ? -1 : 1);
  const rotate = ((((ops.rotate + sign * 90) % 360) + 360) % 360) as Rotation;
  return { ...ops, rotate, crop: ops.crop ? (dir === "cw" ? cropCW(ops.crop) : cropCCW(ops.crop)) : null, resize: ops.resize ? { width: ops.resize.height, height: ops.resize.width } : null };
}

export function flipVisible(ops: ImageOps, axis: "h" | "v"): ImageOps {
  return axis === "h"
    ? { ...ops, flipH: !ops.flipH, crop: ops.crop ? cropFlipH(ops.crop) : null }
    : { ...ops, flipV: !ops.flipV, crop: ops.crop ? cropFlipV(ops.crop) : null };
}

export const isDefaultOps = (o: ImageOps) =>
  o.rotate === 0 && !o.flipH && !o.flipV && !o.crop && !o.resize && !o.brightness && !o.contrast && !o.saturation;

export function formatExtFromName(name: string): OutFormat | null {
  const e = name.split(".").pop()?.toLowerCase();
  return e === "jpg" || e === "jpeg" || e === "png" || e === "webp" ? e : null;
}
