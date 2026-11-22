/**
 * Main-thread side of image cleanup: turns brush strokes into a mask, cuts out the working region around the selection,
 * runs the PatchMatch inpainting core in a Web Worker, and pastes the result back into a NEW image. The source image
 * (and the user's original file) is never modified.
 *
 * Engine: multi-scale PatchMatch exemplar-based inpainting. This is a classical (non-AI) algorithm that copies real
 * patches from the surrounding picture. It is not a neural network. It runs entirely in the browser: no upload, no API
 * key, no cost. See docs/IMAGE_CLEANUP.md for what it can and cannot do.
 */
import { InpaintError, type InpaintStats } from "./inpaint/core";
import { maskBounds, maskCount, rasterMask, strokeBounds, type Rect, type Stroke } from "./inpaint/strokes";
import type { WorkerIn, WorkerOut } from "./inpaint/worker";
import { deviceProfile, type DeviceProfile } from "./imageEngine";

export const ENGINE_NAME = "patchmatch-inpaint";
export const ENGINE_VERSION = 1;

export type CleanupErrorCode = "empty_mask" | "too_much" | "no_source" | "cancelled" | "failed" | "bad_input" | "too_large" | "memory" | "no_worker";
export class CleanupError extends Error {
  code: CleanupErrorCode;
  constructor(code: CleanupErrorCode, message: string) { super(message); this.name = "CleanupError"; this.code = code; }
}

export type CleanupLimits = { maxImagePixels: number; maxRoiPixels: number; maxWorkPixels: number };
export function cleanupLimits(profile: DeviceProfile = deviceProfile()): CleanupLimits {
  const MP = 1_000_000;
  return profile.mobile
    ? { maxImagePixels: 16 * MP, maxRoiPixels: 5 * MP, maxWorkPixels: 500_000 }
    : { maxImagePixels: 50 * MP, maxRoiPixels: 16 * MP, maxWorkPixels: 1_400_000 };
}

/**
 * How many cleanups may be applied (stacked) in one editing session. Every applied cleanup keeps one full-size bitmap in
 * memory so it can be undone, so the cap is the lower of a fixed 5 and what a per-device pixel budget allows
 * (always at least 1). Desktop: 150 MP of stored bitmaps (~600 MB worst case). Mobile: 48 MP (~190 MB).
 */
export const MAX_CLEANUPS = 5;
export function maxCleanups(imgW: number, imgH: number, profile: DeviceProfile = deviceProfile()): number {
  const budget = profile.mobile ? 48_000_000 : 150_000_000;
  return Math.max(1, Math.min(MAX_CLEANUPS, Math.floor(budget / Math.max(1, imgW * imgH))));
}

export type CleanupResult = {
  bitmap: ImageBitmap;
  stats: InpaintStats;
  roi: Rect;
  maskPixels: number;
  ms: number;
};

type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;
function makeCanvas(w: number, h: number): AnyCanvas {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
  const c = document.createElement("canvas"); c.width = w; c.height = h; return c;
}
function ctx2d(c: AnyCanvas) {
  const x = c.getContext("2d", { willReadFrequently: true }) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (!x) throw new CleanupError("memory", "The browser couldn't allocate enough memory for this image. Try a smaller image.");
  return x;
}

/** Working region: the selection plus enough surrounding picture to copy from (shrunk if needed to respect the device budget). */
export function planRoi(bounds: Rect, imgW: number, imgH: number, limits: CleanupLimits): Rect {
  const big = Math.max(bounds.w, bounds.h);
  let m = Math.max(48, Math.round(0.8 * big));
  const clip = (mm: number): Rect => {
    const x0 = Math.max(0, bounds.x - mm), y0 = Math.max(0, bounds.y - mm);
    const x1 = Math.min(imgW, bounds.x + bounds.w + mm), y1 = Math.min(imgH, bounds.y + bounds.h + mm);
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  };
  let roi = clip(m);
  while (roi.w * roi.h > limits.maxRoiPixels && m > 24) { m = Math.max(24, Math.floor(m * 0.7)); roi = clip(m); }
  if (roi.w * roi.h > limits.maxRoiPixels) throw new CleanupError("too_large", "The selected area is too large to reconstruct on this device. Select a smaller area.");
  return roi;
}

export async function reconstruct(
  source: ImageBitmap,
  strokes: Stroke[],
  opts: { profile?: DeviceProfile; onProgress?: (fraction: number, label: string) => void; signal?: AbortSignal; seed?: number } = {},
): Promise<CleanupResult> {
  const t0 = performance.now();
  const limits = cleanupLimits(opts.profile);
  const W = source.width, H = source.height;
  if (W * H > limits.maxImagePixels) {
    throw new CleanupError("too_large", `This image is ${(W * H / 1e6).toFixed(0)} megapixels. Cleanup on this device supports up to ${limits.maxImagePixels / 1e6} megapixels. Resize it first (use the Resize control, save the copy, then open the copy for cleanup).`);
  }
  if (typeof Worker === "undefined") throw new CleanupError("no_worker", "This browser can't run background processing, so cleanup is unavailable here. Try a current version of Chrome, Edge, Firefox or Safari.");
  if (opts.signal?.aborted) throw new CleanupError("cancelled", "Reconstruction was cancelled.");

  const bounds = strokeBounds(strokes, W, H);
  if (!bounds) throw new CleanupError("empty_mask", "Nothing is selected. Paint over the object you want to remove first.");
  const roi = planRoi(bounds, W, H, limits);
  const mask = rasterMask(strokes, roi, 1);
  const maskPixels = maskCount(mask);
  if (maskPixels === 0 || !maskBounds(mask, roi.w, roi.h)) throw new CleanupError("empty_mask", "Nothing is selected. Paint over the object you want to remove first.");

  // cut out the region
  let rgba: Uint8ClampedArray;
  try {
    const c = makeCanvas(roi.w, roi.h), g = ctx2d(c);
    g.drawImage(source, roi.x, roi.y, roi.w, roi.h, 0, 0, roi.w, roi.h);
    rgba = g.getImageData(0, 0, roi.w, roi.h).data;
  } catch (e) {
    if (e instanceof CleanupError) throw e;
    throw new CleanupError("memory", "The browser couldn't read this image region. Try a smaller image or selection.");
  }

  // run the core in a worker
  const done = await new Promise<{ rgba: Uint8ClampedArray; stats: InpaintStats }>((resolve, reject) => {
    let worker: Worker;
    try { worker = new Worker(new URL("./inpaint/worker.ts", import.meta.url), { type: "module" }); }
    catch { reject(new CleanupError("no_worker", "The background processor couldn't start in this browser.")); return; }
    const cleanup = () => { opts.signal?.removeEventListener("abort", onAbort); worker.terminate(); };
    const onAbort = () => { cleanup(); reject(new CleanupError("cancelled", "Reconstruction was cancelled.")); };
    opts.signal?.addEventListener("abort", onAbort);
    worker.onmessage = (e: MessageEvent<WorkerOut>) => {
      const m = e.data;
      if (m.type === "progress") opts.onProgress?.(m.fraction, m.label);
      else if (m.type === "done") { cleanup(); resolve({ rgba: new Uint8ClampedArray(m.rgba), stats: m.stats }); }
      else { cleanup(); reject(new CleanupError(m.code as CleanupErrorCode, m.message)); }
    };
    worker.onerror = () => { cleanup(); reject(new CleanupError("failed", "The background processor stopped unexpectedly. Nothing was changed.")); };
    // the mask is transferred to the worker (detaching it), so send a copy and keep ours for the paste-back step
    const msg: WorkerIn = { rgba: rgba.buffer as ArrayBuffer, mask: mask.slice().buffer as ArrayBuffer, w: roi.w, h: roi.h, seed: opts.seed ?? 1337, maxWorkPixels: limits.maxWorkPixels };
    worker.postMessage(msg, [msg.rgba, msg.mask]);
  });

  // Paste back. Only selected pixels are drawn (fully opaque, source-over), so every other pixel keeps the source's exact bytes.
  let bitmap: ImageBitmap;
  try {
    const patch = new Uint8ClampedArray(done.rgba.length);
    for (let i = 0; i < mask.length; i++) {
      if (mask[i] > 127) { const o = i * 4; patch[o] = done.rgba[o]; patch[o + 1] = done.rgba[o + 1]; patch[o + 2] = done.rgba[o + 2]; patch[o + 3] = 255; }
    }
    const full = makeCanvas(W, H), fg = ctx2d(full);
    fg.drawImage(source, 0, 0);
    const pc = makeCanvas(roi.w, roi.h), pg = ctx2d(pc);
    pg.putImageData(new ImageData(patch, roi.w, roi.h), 0, 0);
    fg.drawImage(pc as CanvasImageSource, roi.x, roi.y);
    bitmap = await createImageBitmap(full as ImageBitmapSource);
    full.width = full.height = 0; pc.width = pc.height = 0;
  } catch (e) {
    if (e instanceof CleanupError) throw e;
    throw new CleanupError("memory", "The browser ran out of memory while building the result. Nothing was changed.");
  }
  if (opts.signal?.aborted) { bitmap.close(); throw new CleanupError("cancelled", "Reconstruction was cancelled."); }
  return { bitmap, stats: done.stats, roi, maskPixels, ms: Math.round(performance.now() - t0) };
}

export { InpaintError };
