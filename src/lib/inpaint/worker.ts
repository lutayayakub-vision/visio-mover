/// <reference lib="webworker" />
// Runs the inpainting core off the main thread so the page stays responsive. Cancelling = terminating this worker.
import { inpaintRoi, InpaintError } from "./core";

export type WorkerIn = { rgba: ArrayBuffer; mask: ArrayBuffer; w: number; h: number; seed: number; maxWorkPixels: number };
export type WorkerOut =
  | { type: "progress"; fraction: number; label: string }
  | { type: "done"; rgba: ArrayBuffer; stats: ReturnType<typeof inpaintRoi>["stats"] }
  | { type: "error"; code: string; message: string };

const ctx = self as unknown as DedicatedWorkerGlobalScope;
ctx.onmessage = (e: MessageEvent<WorkerIn>) => {
  const m = e.data;
  let last = 0;
  try {
    const r = inpaintRoi(new Uint8ClampedArray(m.rgba), new Uint8Array(m.mask), m.w, m.h, {
      seed: m.seed, maxWorkPixels: m.maxWorkPixels,
      onProgress: (fraction, label) => { const t = Date.now(); if (t - last > 80 || fraction >= 1) { last = t; ctx.postMessage({ type: "progress", fraction, label } satisfies WorkerOut); } },
    });
    const buf = r.rgba.buffer as ArrayBuffer;
    ctx.postMessage({ type: "done", rgba: buf, stats: r.stats } satisfies WorkerOut, [buf]);
  } catch (err) {
    if (err instanceof InpaintError) ctx.postMessage({ type: "error", code: err.code, message: err.message } satisfies WorkerOut);
    else if (err instanceof RangeError) ctx.postMessage({ type: "error", code: "memory", message: "The device ran out of memory while reconstructing. Try a smaller selection or a smaller image." } satisfies WorkerOut);
    else ctx.postMessage({ type: "error", code: "failed", message: "Reconstruction failed unexpectedly. Nothing was changed." } satisfies WorkerOut);
  }
};
