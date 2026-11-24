/**
 * Video cleanup pipeline (Stage 2, milestone 4): removes an object from a short clip, in the browser, with no upload and no AI service.
 *
 *   1. refuse anything over the limits BEFORE doing work (length, frames, fps, size, region, memory, projected time);
 *   2. ffmpeg.wasm extracts only the working region as raw frames, ~2 s at a time (bounds the engine's in-memory filesystem);
 *   3. the tracker follows the object from the user's keyframes (worker). Anything it is unsure about stops the run;
 *   4. chunks (~2 s plus a few frames of context on each side) are reconstructed in a pool of workers (temporal median of the real
 *      background, see inpaint/temporal.ts). Every pixel outside the selection is checked to be identical to the input;
 *   5. each chunk is re-encoded by ffmpeg with the ORIGINAL picture underneath: only pixels inside the selection are overlaid;
 *   6. chunks are joined without re-encoding and the ORIGINAL audio stream is copied over untouched.
 *
 * The user's File is only read. A failure or cancel produces no result at all: nothing partial is returned or saved.
 * Cancel = one AbortSignal: every worker is terminated and the ffmpeg instance is torn down (a later run starts a fresh one).
 */
import { VideoEngine, VideoError, explainFailure, videoProfile, type VideoInfo, type VideoProfile } from "./videoEngine";
import { WorkerPool, PoolError } from "./inpaint/pool";
import type { ReconTask, TrackTask, WorkerReply } from "./inpaint/temporalWorker";

const MB = 1024 * 1024;
export const CLEANUP_VIDEO_VERSION = 1;

export type CleanupVideoErrorCode =
  | "too_long" | "too_many_frames" | "fps_too_high" | "unknown_fps" | "resolution_too_high" | "file_too_large" | "region_invalid" | "region_too_large"
  | "too_many_keyframes" | "bad_input" | "would_be_too_slow" | "too_slow" | "output_too_large" | "tracking_unresolved" | "insufficient_background"
  | "frame_mismatch" | "unsupported" | "corrupt" | "memory" | "cancelled" | "failed";
export class VideoCleanupError extends Error {
  code: CleanupVideoErrorCode; details?: Record<string, unknown>;
  constructor(code: CleanupVideoErrorCode, message: string, details?: Record<string, unknown>) { super(message); this.name = "VideoCleanupError"; this.code = code; this.details = details; }
}

export type CleanupVideoLimits = {
  mobile: boolean; maxSeconds: number; maxFrames: number; maxFps: number; maxWidth: number; maxHeight: number; maxRegionPixels: number;
  rawBudgetBytes: number;      // region frames of the whole range held in memory (tracking needs them all)
  chunkBudgetBytes: number;    // frames in flight in the workers + patch handed to ffmpeg
  maxKeyframes: number; maxMinutes: number; maxFileBytes: number; bucketBytes: number; workers: number;
};
export function cleanupVideoLimits(profile: VideoProfile = videoProfile(), hardwareConcurrency = typeof navigator !== "undefined" ? navigator.hardwareConcurrency || 2 : 2): CleanupVideoLimits {
  return profile.mobile
    ? { mobile: true, maxSeconds: 5, maxFrames: 150, maxFps: 30, maxWidth: 1280, maxHeight: 720, maxRegionPixels: 500_000, rawBudgetBytes: 72 * MB, chunkBudgetBytes: 40 * MB, maxKeyframes: 8, maxMinutes: 6, maxFileBytes: profile.maxFileBytes, bucketBytes: 50 * MB, workers: Math.max(1, Math.min(2, hardwareConcurrency - 1)) }
    : { mobile: false, maxSeconds: 10, maxFrames: 300, maxFps: 30, maxWidth: 1920, maxHeight: 1080, maxRegionPixels: 2_000_000, rawBudgetBytes: 240 * MB, chunkBudgetBytes: 120 * MB, maxKeyframes: 8, maxMinutes: 10, maxFileBytes: profile.maxFileBytes, bucketBytes: 50 * MB, workers: Math.max(1, Math.min(4, hardwareConcurrency - 1)) };
}

/** Rough time model, measured on real runs (see docs / tests/out/vc-m4-bench.json) and kept conservative on purpose. */
export const TIME_MODEL = { reconMsPerMpFrame: 1500, reconFixedMsPerFrame: 20, ffmpegMsPerMpFrame: 150, ffmpegFixedMsPerFrame: 25, startupMs: 2500 };
export function estimateCleanupMs(frames: number, regionPixels: number, framePixels: number, workers: number): number {
  const recon = frames * (TIME_MODEL.reconMsPerMpFrame * regionPixels / 1e6 + TIME_MODEL.reconFixedMsPerFrame) / Math.max(1, Math.min(workers, 4));
  const ff = frames * (TIME_MODEL.ffmpegMsPerMpFrame * (framePixels + regionPixels) / 1e6 + TIME_MODEL.ffmpegFixedMsPerFrame);
  return TIME_MODEL.startupMs + recon + ff;
}

export type Region = { x: number; y: number; w: number; h: number };
export type KeyframeIn = { frame: number; mask?: Uint8Array; absent?: boolean };
export type CleanupVideoRequest = {
  /** working region in full-frame pixels; must contain the object on every frame of the range (rounded outwards to even numbers) */
  region: Region;
  /** frame numbers count from the start of the processed range; masks are full-frame sized (width*height), non-zero = object */
  keyframes: KeyframeIn[];
  range?: { startFrame: number; endFrame: number };   // endFrame exclusive; default: the whole clip
  crf?: number;                 // default 23
  maskMargin?: number;          // extra pixels around the tracked mask (default 4)
  allowSpatialFallback?: boolean; // default false: refuse when other frames do not show the background
};
export type CleanupVideoProgress = { phase: "prepare" | "extract" | "track" | "clean" | "join"; fraction: number; label: string; etaSeconds: number | null };
export type CleanupVideoOptions = {
  signal?: AbortSignal; onProgress?: (p: CleanupVideoProgress) => void; profile?: VideoProfile; limits?: Partial<CleanupVideoLimits>; workerFactory?: () => Worker;
  debug?: {
    fail?: { phase: "extract" | "track" | "clean" | "encode" | "join"; chunk?: number; kind: "oom" | "error" };
    onChunk?: (c: { chunk: number; start: number; end: number; before: Uint8Array[]; after: Uint8Array[]; masks: Uint8Array[]; w: number; h: number }) => void;
    delayMsPerChunk?: number; timeModelScale?: number; slowFloorMs?: number; chunkFrames?: number; onPool?: (pool: WorkerPool) => void;
  };
};
export type CleanupVideoResult = {
  blob: Blob; mime: "video/mp4"; ext: "mp4"; frames: number; fps: number; seconds: number; status: "ok" | "degraded";
  warnings: Array<{ code: string; message: string }>; editParams: Record<string, unknown>;
  stats: { estimateMs: number; ms: Record<string, number>; chunks: number; chunkFrames: number; contextFrames: number; workers: number; bytes: number; retriedChunks: number; peakRegionBytes: number };
};

// ───────────────────────── pre-flight ─────────────────────────
export const fpsRational = (fps: number): string => (Math.abs(fps - 29.97) < 0.01 ? "30000/1001" : Math.abs(fps - 23.976) < 0.01 ? "24000/1001" : Math.abs(fps - 59.94) < 0.01 ? "60000/1001" : String(Math.round(fps * 1000) / 1000));
const fpsNumber = (fps: number): number => { const r = fpsRational(fps); const [a, b] = r.split("/"); return b ? +a / +b : +a; };

export function normalizeRegion(r: Region, W: number, H: number): Region {
  if (![r.x, r.y, r.w, r.h].every(Number.isFinite) || r.w <= 0 || r.h <= 0) throw new VideoCleanupError("region_invalid", "Choose a working area around the object (it has no size).");
  const x0 = Math.max(0, Math.floor(r.x / 2) * 2), y0 = Math.max(0, Math.floor(r.y / 2) * 2);
  const x1 = Math.min(W, Math.ceil((r.x + r.w) / 2) * 2), y1 = Math.min(H, Math.ceil((r.y + r.h) / 2) * 2);
  if (x1 - x0 < 16 || y1 - y0 < 16) throw new VideoCleanupError("region_invalid", "The working area is too small or outside the video. Make it at least 16×16 pixels and inside the picture.");
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export type Plan = { frames: number; startFrame: number; fps: number; fpsExpr: string; seconds: number; region: Region; limits: CleanupVideoLimits; estimateMs: number };
/** Every up-front refusal. Throws VideoCleanupError with a specific, actionable message; returns the plan when all limits are met. */
export function planCleanup(file: { size: number }, info: VideoInfo, req: CleanupVideoRequest, limits: CleanupVideoLimits, timeScale = 1): Plan {
  const who = limits.mobile ? "On this device" : "In the browser";
  if (file.size > limits.maxFileBytes) throw new VideoCleanupError("file_too_large", `This video is ${(file.size / MB).toFixed(1)} MB. ${who} the limit for editing is ${limits.maxFileBytes / MB} MB.`);
  if (!info.fps || !isFinite(info.fps)) throw new VideoCleanupError("unknown_fps", "The frame rate of this video couldn't be read, so object removal can't be planned. Re-save it as a standard MP4 (H.264) and try again.");
  if (info.fps > limits.maxFps + 0.01) throw new VideoCleanupError("fps_too_high", `This video runs at ${info.fps} frames per second. Object removal supports up to ${limits.maxFps}. Convert it to ${limits.maxFps} fps or lower first.`);
  if (info.width > limits.maxWidth || info.height > limits.maxHeight) throw new VideoCleanupError("resolution_too_high", `This video is ${info.width}×${info.height}. ${who} object removal supports up to ${limits.maxWidth}×${limits.maxHeight}. Lower the resolution first.`);
  const total = Math.max(1, Math.ceil(info.duration * info.fps - 0.001));
  const start = req.range?.startFrame ?? 0, end = req.range?.endFrame ?? total;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || (req.range && end > total)) throw new VideoCleanupError("bad_input", `The chosen range (frames ${start}–${end}) isn't inside the video (${total} frames).`);
  const frames = end - start, seconds = frames / fpsNumber(info.fps);
  if (seconds > limits.maxSeconds + 0.001) throw new VideoCleanupError("too_long", `The selected part is ${seconds.toFixed(1)} seconds. ${who} object removal supports up to ${limits.maxSeconds} seconds at a time. Trim it first.`, { seconds, max: limits.maxSeconds });
  if (frames > limits.maxFrames) throw new VideoCleanupError("too_many_frames", `The selected part has ${frames} frames; the limit is ${limits.maxFrames}. Trim it first.`, { frames, max: limits.maxFrames });
  if (req.keyframes.length === 0) throw new VideoCleanupError("bad_input", "Mark the object on at least one frame first.");
  if (req.keyframes.length > limits.maxKeyframes) throw new VideoCleanupError("too_many_keyframes", `${req.keyframes.length} manual keyframes were given; the limit is ${limits.maxKeyframes}. Use fewer, or split the clip.`);
  const region = normalizeRegion(req.region, info.width, info.height);
  const rp = region.w * region.h, rawLimit = Math.floor(limits.rawBudgetBytes / (frames * 3));
  if (rp > limits.maxRegionPixels) throw new VideoCleanupError("region_too_large", `The working area is ${(rp / 1e6).toFixed(2)} megapixels; the limit is ${(limits.maxRegionPixels / 1e6).toFixed(1)}. Make it smaller (just around where the object moves).`, { pixels: rp, max: limits.maxRegionPixels });
  if (rp > rawLimit) throw new VideoCleanupError("region_too_large", `For ${frames} frames the working area can be at most ${(rawLimit / 1e6).toFixed(2)} megapixels on this device (it is ${(rp / 1e6).toFixed(2)}). Make it smaller or trim the clip.`, { pixels: rp, max: rawLimit });
  const estimateMs = estimateCleanupMs(frames, rp, info.width * info.height, limits.workers) * timeScale;
  if (estimateMs > limits.maxMinutes * 60_000) throw new VideoCleanupError("would_be_too_slow", `This would take about ${Math.round(estimateMs / 60_000)} minutes on this device (the limit is ${limits.maxMinutes}). Use a shorter clip or a smaller working area.`, { estimateMs, maxMs: limits.maxMinutes * 60_000 });
  return { frames, startFrame: start, fps: fpsNumber(info.fps), fpsExpr: fpsRational(info.fps), seconds, region, limits, estimateMs };
}

export type ChunkPlan = { chunkFrames: number; context: number; concurrency: number; chunks: Array<[number, number]> };
/** ~2 s chunks, shortened when the working region is big so the frames in flight stay inside the memory budget. */
export function planChunks(frames: number, regionPixels: number, limits: CleanupVideoLimits, fps: number): ChunkPlan {
  const perFrame = regionPixels * 4;
  let concurrency = Math.max(1, Math.min(limits.workers, Math.ceil(frames / 15)));
  for (;;) {
    const budgetFrames = Math.floor(limits.chunkBudgetBytes / concurrency / perFrame);
    const context = Math.max(2, Math.min(15, Math.floor(budgetFrames / 4)));
    const chunkFrames = Math.min(Math.round(2 * fps), budgetFrames - 2 * context);
    if (chunkFrames >= 4 || concurrency === 1) {
      const cf = Math.max(1, chunkFrames), chunks: Array<[number, number]> = [];
      for (let s = 0; s < frames; s += cf) chunks.push([s, Math.min(frames, s + cf) - 1]);
      return { chunkFrames: cf, context, concurrency, chunks };
    }
    concurrency--;
  }
}

function mapError(e: unknown, signal?: AbortSignal): VideoCleanupError {
  if (signal?.aborted) return new VideoCleanupError("cancelled", "Cancelled. Nothing was changed.");
  if (e instanceof VideoCleanupError) return e;
  if (e instanceof PoolError) {
    if (e.code === "cancelled") return new VideoCleanupError("cancelled", "Cancelled. Nothing was changed.");
    if (e.code === "unresolved_tracking") return new VideoCleanupError("tracking_unresolved", e.message, e.details as Record<string, unknown>);
    if (e.code === "insufficient_background") return new VideoCleanupError("insufficient_background", e.message, e.details as Record<string, unknown>);
    if (e.code === "memory") return new VideoCleanupError("memory", e.message);
    if (e.code === "bad_input") return new VideoCleanupError("bad_input", e.message);
    return new VideoCleanupError("failed", e.message || "Object removal failed. Nothing was changed.");
  }
  if (e instanceof VideoError) return new VideoCleanupError(e.code === "cancelled" ? "cancelled" : e.code === "corrupt" || e.code === "unsupported" || e.code === "memory" ? e.code : "failed", e.message);
  if (e instanceof RangeError || /out of memory|allocation failed/i.test((e as Error)?.message ?? "")) return new VideoCleanupError("memory", "This device ran out of memory. Try a shorter clip or a smaller working area, and close other tabs. Nothing was changed.");
  return new VideoCleanupError("failed", "Object removal failed unexpectedly. Nothing was changed.");
}

type Color = { matrix: "bt601" | "bt709"; range: "tv" | "pc" };
function readColor(log: string): Color {
  const m = /Video: [^\n]*?, (yuvj?4\d\dp\w*|nv12|p010\w*|gray\w*|rgb\w*|bgr\w*)(?:\(([^)]*)\))?[,\s]/.exec(log);
  if (!m) throw new VideoCleanupError("unsupported", "This video's pixel format couldn't be read.");
  const fmt = m[1], tags = m[2] ?? "";
  if (!/^yuvj?420p$/.test(fmt)) throw new VideoCleanupError("unsupported", `This video uses ${fmt}. Object removal supports standard 8-bit 4:2:0 video (typical MP4/H.264 from phones and cameras).`);
  if (/bt2020|smpte2084|arib/.test(tags)) throw new VideoCleanupError("unsupported", "HDR video isn't supported for object removal. Convert it to standard video first.");
  return { matrix: /bt709/.test(tags) ? "bt709" : "bt601", range: /\bpc\b/.test(tags) || fmt === "yuvj420p" ? "pc" : "tv" };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const keyOf = (mask: Uint8Array, W: number, r: Region): Uint8Array => { const o = new Uint8Array(r.w * r.h); for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) o[y * r.w + x] = mask[(y + r.y) * W + x + r.x] ? 1 : 0; return o; };

// ───────────────────────── the pipeline ─────────────────────────
export async function cleanupVideo(engine: VideoEngine, file: File, info: VideoInfo, req: CleanupVideoRequest, opts: CleanupVideoOptions = {}): Promise<CleanupVideoResult> {
  const T0 = performance.now(), ms: Record<string, number> = {};
  const limits: CleanupVideoLimits = { ...cleanupVideoLimits(opts.profile), ...opts.limits };
  const dbg = opts.debug, signal = opts.signal;
  const plan = planCleanup(file, info, req, limits, dbg?.timeModelScale ?? 1); // throws on any limit
  const { region, frames: N, startFrame, fps, fpsExpr } = plan;
  const W = info.width, rp = region.w * region.h, crf = Math.min(36, Math.max(16, Math.round(req.crf ?? 23))), margin = Math.max(0, Math.min(12, Math.round(req.maskMargin ?? 4)));
  if (signal?.aborted) throw new VideoCleanupError("cancelled", "Cancelled. Nothing was changed.");

  // keyframes → region-sized masks (the selection must lie inside the working region)
  const kfs = req.keyframes.map((k) => {
    if (!Number.isInteger(k.frame) || k.frame < 0 || k.frame >= N) throw new VideoCleanupError("bad_input", `Keyframe ${k.frame} is outside the processed range (0–${N - 1}).`);
    if (k.absent) return { frame: k.frame, mask: null as Uint8Array | null, absent: true };
    if (!k.mask || k.mask.length !== W * info.height) throw new VideoCleanupError("bad_input", `The selection on frame ${k.frame} doesn't match the video size.`);
    let outside = 0; for (let y = 0; y < info.height; y++) { const inY = y >= region.y && y < region.y + region.h; for (let x = 0; x < W; x++) if (k.mask[y * W + x] && !(inY && x >= region.x && x < region.x + region.w)) outside++; }
    if (outside) throw new VideoCleanupError("region_invalid", `${outside} selected pixels on frame ${k.frame} are outside the working area. Enlarge the working area so it includes the whole object.`);
    return { frame: k.frame, mask: keyOf(k.mask, W, region), absent: false };
  });

  const progress = (phase: CleanupVideoProgress["phase"], fraction: number, label: string, eta: number | null = null) => opts.onProgress?.({ phase, fraction: Math.min(1, Math.max(0, fraction)), label, etaSeconds: eta });
  const pool = new WorkerPool(opts.workerFactory ?? (() => new Worker(new URL("./inpaint/temporalWorker.ts", import.meta.url), { type: "module" })), limits.workers);
  dbg?.onPool?.(pool);
  const temp = new Set<string>();
  const abort = () => { pool.terminateAll(); void engine.terminate(); };
  signal?.addEventListener("abort", abort, { once: true });
  const check = () => { if (signal?.aborted) throw new VideoCleanupError("cancelled", "Cancelled. Nothing was changed."); };
  const fail = (phase: string, chunk?: number) => {
    const f = dbg?.fail; if (f && f.phase === phase && (f.chunk === undefined || f.chunk === chunk)) { if (f.kind === "oom") throw new RangeError("simulated out of memory"); throw new Error("simulated failure"); }
  };
  let retried = 0, peakRegion = 0;

  try {
    // ── prepare: engine, input, colour handling
    progress("prepare", 0, "Starting the video engine");
    await engine.load();
    const inName = await engine.useInput(file); check();
    const probe = await engine.exec(["-hide_banner", "-i", inName]);
    const color = readColor(probe.log);
    ms.prepare = performance.now() - T0;

    // ── extract the region, a couple of seconds at a time
    const t1 = performance.now();
    const frames: Uint8Array[] = [];
    const perExtract = Math.max(1, Math.min(Math.round(2 * fps), Math.floor((120 * MB) / (rp * 3))));
    const fb = rp * 3;
    for (let a = 0; a < N; a += perExtract) {
      check(); fail("extract", a / perExtract);
      const n = Math.min(perExtract, N - a), ss = Math.max(0, (startFrame + a - 0.5) / fps);
      const r = await engine.exec(["-hide_banner", "-ss", ss.toFixed(6), "-i", inName, "-frames:v", String(n), "-an", "-vsync", "0",
        "-vf", `crop=${region.w}:${region.h}:${region.x}:${region.y},scale=in_color_matrix=${color.matrix}:in_range=${color.range},format=rgb24`, "-f", "rawvideo", "reg.rgb"]);
      temp.add("reg.rgb");
      if (r.code !== 0) throw explainFailure(r.log);
      const raw = await engine.readBytes("reg.rgb"); await engine.removeFile("reg.rgb");
      const got = Math.floor(raw.byteLength / fb);
      if (got !== n) throw new VideoCleanupError("frame_mismatch", `The video returned ${got} of ${n} expected frames at ${(startFrame + a) / fps >= 0 ? ((startFrame + a) / fps).toFixed(2) : 0} s. It may have a variable frame rate or be damaged; re-save it as a standard constant-frame-rate MP4.`);
      for (let i = 0; i < n; i++) frames.push(raw.subarray(i * fb, (i + 1) * fb));
      peakRegion = Math.max(peakRegion, frames.length * fb);
      progress("extract", 0.15 * (a + n) / N, "Reading the video");
    }
    ms.extract = performance.now() - t1;

    // ── track (worker)
    check(); fail("track");
    const t2 = performance.now();
    const trackMsg: TrackTask = { kind: "track", w: region.w, h: region.h, frames: frames.map((f) => f.slice().buffer as ArrayBuffer), margin,
      keyframes: kfs.map((k) => ({ frame: k.frame, mask: k.mask ? (k.mask.slice().buffer as ArrayBuffer) : null, absent: k.absent })) };
    const tr = await pool.run<Extract<WorkerReply, { type: "done"; kind: "track" }>>(trackMsg, [...trackMsg.frames, ...trackMsg.keyframes.map((k) => k.mask).filter((b): b is ArrayBuffer => !!b)], (f) => progress("track", 0.15 + 0.05 * f, "Following the object"));
    const masks = tr.masks.map((b) => new Uint8Array(b));
    ms.track = performance.now() - t2;
    const warnings: Array<{ code: string; message: string }> = [...tr.warnings];

    // ── clean + encode chunk by chunk
    const t3 = performance.now();
    const cp = planChunks(N, rp, limits, fps);
    if (opts.debug?.chunkFrames) { const cf = opts.debug.chunkFrames; cp.chunkFrames = cf; cp.chunks = []; for (let s0 = 0; s0 < N; s0 += cf) cp.chunks.push([s0, Math.min(N, s0 + cf) - 1]); }
    const patchBytes = rp * 4;
    const dispatch = (k: number, ctxFrames: number) => {
      const [cs, ce] = cp.chunks[k], lo = Math.max(0, cs - ctxFrames), hi = Math.min(N - 1, ce + ctxFrames);
      const fr = frames.slice(lo, hi + 1).map((f) => f.slice().buffer as ArrayBuffer), mk = masks.slice(lo, hi + 1).map((m) => m.slice().buffer as ArrayBuffer);
      const msg: ReconTask = { kind: "reconstruct", w: region.w, h: region.h, frames: fr, masks: mk, range: [cs - lo, ce - lo], opts: { onInsufficient: req.allowSpatialFallback ? "spatial" : "error" } };
      return pool.run<Extract<WorkerReply, { type: "done"; kind: "reconstruct" }>>(msg, [...fr, ...mk]);
    };
    const pending = new Map<number, Promise<Extract<WorkerReply, { type: "done"; kind: "reconstruct" }>>>();
    const chunkFiles: string[] = [];
    let status: "ok" | "degraded" = "ok";
    const seen = new Set<string>(warnings.map((w) => w.code + w.message));
    for (let k = 0; k < cp.chunks.length; k++) {
      check();
      for (let j = k; j < Math.min(cp.chunks.length, k + cp.concurrency); j++) if (!pending.has(j)) { fail("clean", j); const p = dispatch(j, cp.context); p.catch(() => undefined); pending.set(j, p); }
      let rec: Extract<WorkerReply, { type: "done"; kind: "reconstruct" }>;
      try { rec = await pending.get(k)!; }
      catch (e) {
        // the area behind the object may only be visible further away than the context: retry this chunk once with a wider window if it fits in memory
        if (e instanceof PoolError && e.code === "insufficient_background" && !signal?.aborted) {
          const wide = Math.min(45, Math.floor((limits.rawBudgetBytes / rp / 4 - (cp.chunks[k][1] - cp.chunks[k][0] + 1)) / 2));
          if (wide > cp.context) { retried++; rec = await dispatch(k, wide); } else throw e;
        } else throw e;
      }
      pending.delete(k); check();
      // a few pixels filled from the surroundings because the context window was short: look further for them once, if memory allows, and keep the better result
      if (rec.status === "degraded" && !signal?.aborted) {
        const share = (r: typeof rec) => r.stats.spatialFilled;
        const wide = Math.min(45, Math.floor((limits.rawBudgetBytes / rp / 4 - (cp.chunks[k][1] - cp.chunks[k][0] + 1)) / 2));
        if (wide > cp.context) {
          try { const r2 = await dispatch(k, wide); retried++; if (share(r2) < share(rec)) rec = r2; }
          catch (e) { if (signal?.aborted) throw e; /* keep the first result */ }
        }
      }
      if (rec.status === "degraded") status = "degraded";
      for (const w of rec.warnings) if (!seen.has(w.code + w.message)) { seen.add(w.code + w.message); warnings.push(w); }
      const [cs, ce] = cp.chunks[k], n = ce - cs + 1, after = rec.frames.map((b) => new Uint8Array(b));
      // independent guarantee, outside the worker: nothing outside the selection changed in the unencoded region frames
      for (let i = 0; i < n; i++) { const a = frames[cs + i], b = after[i], m = masks[cs + i]; for (let p = 0; p < m.length; p++) if (!m[p] && (a[p * 3] !== b[p * 3] || a[p * 3 + 1] !== b[p * 3 + 1] || a[p * 3 + 2] !== b[p * 3 + 2])) throw new VideoCleanupError("failed", `Internal check failed: a pixel outside the selection changed in frame ${cs + i}. Nothing was saved.`);
      }
      dbg?.onChunk?.({ chunk: k, start: cs, end: ce, before: frames.slice(cs, ce + 1), after, masks: masks.slice(cs, ce + 1), w: region.w, h: region.h });
      // patch for ffmpeg: RGB from the result, opaque only on the selection
      fail("encode", k);
      const patch = new Uint8Array(n * patchBytes);
      for (let i = 0; i < n; i++) { const b = after[i], m = masks[cs + i], o = i * patchBytes; for (let p = 0; p < m.length; p++) { patch[o + p * 4] = b[p * 3]; patch[o + p * 4 + 1] = b[p * 3 + 1]; patch[o + p * 4 + 2] = b[p * 3 + 2]; patch[o + p * 4 + 3] = m[p] ? 255 : 0; } }
      await engine.writeBytes("patch.rgba", patch); temp.add("patch.rgba");
      const name = `chunk${k}.mp4`; temp.add(name);
      const e = await engine.exec(["-hide_banner", "-ss", Math.max(0, (startFrame + cs - 0.5) / fps).toFixed(6), "-i", inName,
        "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${region.w}x${region.h}`, "-framerate", fpsExpr, "-i", "patch.rgba",
        "-filter_complex", `[0:v]setpts=N/(${fps}*TB)[b];[1:v]setpts=N/(${fps}*TB),scale=out_color_matrix=${color.matrix}:out_range=${color.range},format=yuva420p[p];[b][p]overlay=${region.x}:${region.y}:format=yuv420:eof_action=pass[v]`,
        "-map", "[v]", "-frames:v", String(n), "-an", "-vsync", "0", "-c:v", "libx264", "-preset", "veryfast", "-crf", String(crf), "-pix_fmt", "yuv420p", "-r", fpsExpr, name]);
      await engine.removeFile("patch.rgba");
      if (e.code !== 0) throw explainFailure(e.log);
      chunkFiles.push(name);
      if (dbg?.delayMsPerChunk) await sleep(dbg.delayMsPerChunk);
      const done = k + 1, elapsed = performance.now() - t3, remaining = (elapsed / done) * (cp.chunks.length - done);
      progress("clean", 0.2 + 0.75 * done / cp.chunks.length, `Removing the object (${done}/${cp.chunks.length})`, remaining / 1000);
      // stop and tell the user when reality is far slower than the projection
      if (elapsed + remaining > 2 * plan.estimateMs && elapsed + remaining > (dbg?.slowFloorMs ?? 60_000)) throw new VideoCleanupError("too_slow", `This is taking much longer than expected (about ${Math.round((elapsed + remaining) / 60_000)} minutes in total). It was stopped. Try a shorter clip or a smaller working area.`, { projectedMs: elapsed + remaining, estimateMs: plan.estimateMs });
    }
    ms.clean = performance.now() - t3;

    // ── join: chunks without re-encoding + the original audio stream, untouched
    check(); fail("join");
    const t4 = performance.now();
    await engine.writeBytes("list.txt", new TextEncoder().encode(chunkFiles.map((c) => `file '${c}'`).join("\n"))); temp.add("list.txt"); temp.add("out.mp4");
    const whole = startFrame === 0 && N >= Math.ceil(info.duration * fps - 0.001);
    const withAudio = info.hasAudio;
    const j = await engine.exec(["-hide_banner", "-f", "concat", "-safe", "0", "-i", "list.txt",
      ...(withAudio ? [...(whole ? [] : ["-ss", (startFrame / fps).toFixed(6)]), "-i", inName] : []),
      "-map", "0:v:0", ...(withAudio ? ["-map", "1:a:0"] : []), "-c", "copy", ...(whole ? [] : ["-t", (N / fps).toFixed(6)]), "-movflags", "+faststart", "out.mp4"]);
    if (j.code !== 0) throw explainFailure(j.log);
    const out = await engine.readBytes("out.mp4");
    if (!out || out.byteLength < 1024) throw new VideoCleanupError("failed", "The result was empty. Nothing was saved.");
    if (out.byteLength > limits.bucketBytes) throw new VideoCleanupError("output_too_large", `The result is ${(out.byteLength / MB).toFixed(1)} MB, over the ${limits.bucketBytes / MB} MB storage limit. Use a shorter clip or a higher compression (a larger CRF).`, { bytes: out.byteLength });
    const blob = new Blob([out.slice().buffer], { type: "video/mp4" });
    ms.join = performance.now() - t4; ms.total = performance.now() - T0;
    progress("join", 1, "Done");

    const camera = tr.cameraMoving ? "moving" : "fixed";
    const editParams = {
      kind: "cleanup",
      cleanup: { media: "video", engine: "patchmatch-inpaint", method: "temporal-median+patchmatch", version: CLEANUP_VIDEO_VERSION, ai: false, status,
        tracking: { method: "template-ncc", keyframes: kfs.map((k) => (k.absent ? -k.frame - 1 : k.frame)), counts: tr.counts, camera },
        range: { startFrame, endFrame: startFrame + N }, fps, frames: N, region, chunkFrames: cp.chunkFrames, contextFrames: cp.context, crf, maskMargin: margin,
        warnings: warnings.map((w) => w.code), ms: Math.round(ms.total) },
    };
    return { blob, mime: "video/mp4", ext: "mp4", frames: N, fps, seconds: N / fps, status, warnings, editParams,
      stats: { estimateMs: plan.estimateMs, ms, chunks: cp.chunks.length, chunkFrames: cp.chunkFrames, contextFrames: cp.context, workers: pool.totalSpawned, bytes: out.byteLength, retriedChunks: retried, peakRegionBytes: peakRegion } };
  } catch (e) {
    throw mapError(e, signal);
  } finally {
    signal?.removeEventListener("abort", abort);
    pool.terminateAll();                       // every worker is gone on success, failure and cancel alike
    if (!signal?.aborted) { for (const t of temp) await engine.removeFile(t); }
    await engine.terminate();                  // a fresh ffmpeg instance per job: wasm memory only grows, so a long-lived one would eventually fail later jobs
  }
}
