/// <reference lib="webworker" />
// Runs tracking and temporal reconstruction off the main thread. Cancelling = terminating this worker (see pool.ts).
import { reconstructVideo, dilateMask, TemporalError, type TemporalOptions } from "./temporal";
import { trackObject, resolveMasks, TrackError } from "../track/tracker";

export type TrackTask = { kind: "track"; w: number; h: number; frames: ArrayBuffer[]; keyframes: Array<{ frame: number; mask: ArrayBuffer | null; absent?: boolean }>; margin: number };
export type ReconTask = { kind: "reconstruct"; w: number; h: number; frames: ArrayBuffer[]; masks: ArrayBuffer[]; range: [number, number]; opts: Pick<TemporalOptions, "onInsufficient" | "seed"> };
export type WorkerTask = TrackTask | ReconTask;
export type WarnOut = { code: string; message: string };
export type WorkerReply =
  | { type: "progress"; fraction: number; label: string }
  | { type: "done"; kind: "track"; masks: ArrayBuffer[]; warnings: WarnOut[]; counts: Record<string, number>; cameraMoving: boolean; ms: number }
  | { type: "done"; kind: "reconstruct"; frames: ArrayBuffer[]; status: "ok" | "degraded"; warnings: WarnOut[]; coverageMin: number; stats: { maskedPixels: number; plateFilled: number; spatialFilled: number; ms: Record<string, number> } }
  | { type: "error"; code: string; message: string; details?: unknown };

const ctx = self as unknown as DedicatedWorkerGlobalScope;
const reply = (m: WorkerReply, transfer: Transferable[] = []) => ctx.postMessage(m, transfer);
let last = 0;
const progress = (fraction: number, label: string) => { const t = Date.now(); if (t - last > 100 || fraction >= 1) { last = t; reply({ type: "progress", fraction, label }); } };

ctx.onmessage = (e: MessageEvent<WorkerTask>) => {
  const m = e.data;
  try {
    if (m.kind === "track") {
      const frames = m.frames.map((b) => new Uint8Array(b));
      const kfs = m.keyframes.map((k) => (k.absent ? { frame: k.frame, absent: true } : { frame: k.frame, mask: new Uint8Array(k.mask!) }));
      const r = trackObject(frames, m.w, m.h, kfs, { onProgress: progress });
      const masks = resolveMasks(r).map((x) => dilateMask(x ?? new Uint8Array(m.w * m.h), m.w, m.h, m.margin));
      const bufs = masks.map((x) => x.buffer as ArrayBuffer);
      reply({ type: "done", kind: "track", masks: bufs, warnings: r.warnings.map((w) => ({ code: w.code, message: w.message })), counts: r.counts, cameraMoving: r.camera.moving, ms: r.stats.ms.total }, bufs);
    } else {
      const frames = m.frames.map((b) => new Uint8Array(b)), masks = m.masks.map((b) => new Uint8Array(b));
      const r = reconstructVideo(frames, masks, m.w, m.h, { ...m.opts, range: m.range, onProgress: progress });
      const out = r.frames.slice(m.range[0], m.range[1] + 1).map((f) => f.slice().buffer as ArrayBuffer);
      reply({ type: "done", kind: "reconstruct", frames: out, status: r.status, warnings: r.warnings.map((w) => ({ code: w.code, message: w.message })), coverageMin: Math.min(...r.coverage.slice(m.range[0], m.range[1] + 1)), stats: { maskedPixels: r.stats.maskedPixels, plateFilled: r.stats.plateFilled, spatialFilled: r.stats.spatialFilled, ms: r.stats.ms } }, out);
    }
  } catch (err) {
    if (err instanceof TrackError || err instanceof TemporalError) reply({ type: "error", code: err.code, message: err.message, details: err.details });
    else if (err instanceof RangeError) reply({ type: "error", code: "memory", message: "The device ran out of memory while reconstructing. Try a smaller working region or a shorter range." });
    else reply({ type: "error", code: "failed", message: "Reconstruction failed unexpectedly. Nothing was changed." });
  }
};
