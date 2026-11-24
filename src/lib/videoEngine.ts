/**
 * VISIOMOVER video engine: FFmpeg compiled to WebAssembly (single-thread build, so no special server headers are needed).
 * Everything runs in the user's browser, on their device. The original File is only read, never changed.
 *
 * Why not a server: Netlify functions are capped at a 6 MB request/response and 60 s (15 min background, 256 KB payload),
 * so video cannot be uploaded, processed and returned there. Browser-side processing is free and keeps files private.
 */
import { FFmpeg } from "@ffmpeg/ffmpeg";
import coreJsUrl from "@ffmpeg/core?url";
import coreWasmUrl from "@ffmpeg/core/wasm?url";

export type VideoErrorCode = "unsupported" | "corrupt" | "too_large" | "memory" | "engine_load" | "cancelled" | "failed" | "bad_range";
export class VideoError extends Error {
  code: VideoErrorCode;
  constructor(code: VideoErrorCode, message: string) { super(message); this.code = code; this.name = "VideoError"; }
}

const MB = 1024 * 1024;
export type VideoProfile = { mobile: boolean; maxFileBytes: number; maxMinutesComfortable: number };

/** Limits for in-browser video work. 50 MB matches the storage bucket's per-file cap; phones get a lower, safer ceiling. */
export function videoProfile(): VideoProfile {
  const nav = typeof navigator !== "undefined" ? navigator : undefined;
  const ua = nav?.userAgent ?? "";
  const mem = (nav as unknown as { deviceMemory?: number } | undefined)?.deviceMemory;
  const mobile = /Android|iPhone|iPad|iPod/i.test(ua) || (!!nav && nav.maxTouchPoints > 1 && /Mac/i.test(nav.platform ?? "")) || (mem !== undefined && mem <= 2);
  return mobile ? { mobile, maxFileBytes: 30 * MB, maxMinutesComfortable: 2 } : { mobile, maxFileBytes: 50 * MB, maxMinutesComfortable: 5 };
}

export type VideoInfo = { duration: number; width: number; height: number; fps: number | null; hasAudio: boolean; vcodec: string | null; acodec: string | null };

/** Pulls stream details out of ffmpeg's `-i` banner. */
export function parseFfmpegInfo(log: string): VideoInfo | null {
  const d = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(log);
  const v = /Stream #\d+:\d+[^\n]*?: Video: ([A-Za-z0-9_]+)[^\n]*?\b(\d{2,5})x(\d{2,5})\b[^\n]*/.exec(log);
  if (!v) return null;
  const a = /Stream #\d+:\d+[^\n]*?: Audio: ([A-Za-z0-9_]+)/.exec(log);
  const fps = /(\d+(?:\.\d+)?) fps/.exec(v[0]);
  const duration = d ? +d[1] * 3600 + +d[2] * 60 + +d[3] : 0;
  return { duration, width: +v[2], height: +v[3], fps: fps ? +fps[1] : null, hasAudio: !!a, vcodec: v[1], acodec: a ? a[1] : null };
}

export type QualityPreset = "high" | "balanced" | "small";
export const QUALITY: Record<QualityPreset, { label: string; crf: number; audioK: number; hint: string }> = {
  high: { label: "High", crf: 20, audioK: 160, hint: "Best looks, larger file" },
  balanced: { label: "Balanced", crf: 26, audioK: 128, hint: "Good looks, much smaller" },
  small: { label: "Small", crf: 32, audioK: 96, hint: "Smallest file, softer picture" },
};
export const RESOLUTIONS = [{ id: 0, label: "Original size" }, { id: 1080, label: "1080p" }, { id: 720, label: "720p" }, { id: 480, label: "480p" }, { id: 360, label: "360p" }];

export type Segment = { start: number; end: number };
export type VideoSettings = {
  segments: Segment[];
  quality: QualityPreset;
  /** Optional override of the preset's CRF (18 best .. 36 smallest). */
  crf?: number;
  /** Cap the height (0 = keep). Never enlarges. */
  maxHeight: number;
  removeAudio: boolean;
  /** "fast" copies the streams without re-encoding (instant, but starts at the nearest keyframe). Falls back to precise when not possible. */
  trimMode: "precise" | "fast";
};

export type VideoExportResult = { blob: Blob; ext: "mp4"; mime: "video/mp4"; ms: number; mode: "reencode" | "copy"; durationExpected: number };

const fmt = (n: number) => n.toFixed(3);
const timeToSec = (h: string, m: string, s: string) => +h * 3600 + +m * 60 + +s;

export function validateSegments(segs: Segment[], duration: number): Segment[] {
  const out = segs.map((s) => ({ start: Math.max(0, s.start), end: Math.min(duration || Infinity, s.end) })).filter((s) => s.end - s.start >= 0.1).sort((a, b) => a.start - b.start);
  if (out.length === 0) throw new VideoError("bad_range", "Choose a start and end at least 0.1 seconds apart.");
  for (let i = 1; i < out.length; i++) if (out[i].start < out[i - 1].end - 0.001) throw new VideoError("bad_range", "Clips overlap. Adjust the start or end times so they don't overlap.");
  return out;
}

/** Plain-language message for a failed ffmpeg run. */
export function explainFailure(log: string, thrown?: unknown): VideoError {
  const t = `${log}\n${thrown instanceof Error ? thrown.message : ""}`;
  if (/moov atom not found|Invalid data found|could not find codec parameters|End of file/i.test(t)) return new VideoError("corrupt", "This video looks damaged or incomplete, so it can't be processed.");
  if (/Unknown decoder|Decoder .* not found|Unsupported codec|Unsupported pixel|not implemented|Could not find tag/i.test(t)) return new VideoError("unsupported", "This video uses a format the editor can't process (try MP4/H.264, MOV or WEBM).");
  // checked last: ffmpeg prints "Aborted()" after ANY fatal error, so only treat it as memory when nothing more specific matched
  if (/out of memory|Cannot allocate|memory access out of bounds|allocation failed|RangeError|Aborted\(OOM/i.test(t)) return new VideoError("memory", "This device ran out of memory while processing. Try a shorter clip, a lower resolution or the Small quality, and close other tabs.");
  return new VideoError("failed", "The video couldn't be processed. Try Balanced quality, a lower resolution, or a shorter clip.");
}

type Progress = (fraction: number) => void;

export class VideoEngine {
  private ff: FFmpeg | null = null;
  private loading: Promise<void> | null = null;
  private log: string[] = [];
  private inputName: string | null = null;
  private inputFile: Blob | null = null;
  private onLogLine: ((l: string) => void) | null = null;

  get ready() { return !!this.ff?.loaded; }

  /** Downloads and starts the engine (about 31 MB, cached by the browser after the first time). */
  async load(onDownload?: Progress): Promise<void> {
    if (this.ready) return;
    if (!this.loading) {
      this.loading = (async () => {
        const base = (import.meta.env.VITE_FFMPEG_CORE_BASE_URL as string | undefined)?.replace(/\/$/, "");
        const coreURL = base ? `${base}/ffmpeg-core.js` : coreJsUrl;
        const wasmURL = base ? `${base}/ffmpeg-core.wasm` : coreWasmUrl;
        try {
          await prefetchWithProgress(wasmURL, onDownload); // visible progress; the next fetch is served from the HTTP cache
          const ff = new FFmpeg();
          ff.on("log", ({ message }) => { if (this.log.length > 400) this.log.splice(0, 200); this.log.push(message); this.onLogLine?.(message); });
          await ff.load({ coreURL, wasmURL });
          this.ff = ff;
        } catch (e) {
          this.ff = null;
          throw new VideoError("engine_load", e instanceof VideoError ? e.message : "The video engine couldn't be loaded. Check your connection and try again.");
        }
      })().finally(() => { this.loading = null; });
    }
    return this.loading;
  }

  private async put(file: Blob, name: string) {
    const ff = this.ff!;
    if (this.inputName === name && this.inputFile === file) return;
    if (this.inputName) { try { await ff.deleteFile(this.inputName); } catch { /* already gone */ } }
    try { await ff.writeFile(name, new Uint8Array(await file.arrayBuffer())); }
    catch (e) { throw explainFailure("", e); }
    this.inputName = name; this.inputFile = file;
  }

  /** Reads duration, size and codecs using ffmpeg itself (works even for formats the browser can't play). */
  async probe(file: File): Promise<VideoInfo> {
    await this.load();
    const ext = (file.name.split(".").pop() || "mp4").toLowerCase().replace(/[^a-z0-9]/g, "");
    const name = `input.${ext || "mp4"}`;
    await this.put(file, name);
    this.log = [];
    try { await this.ff!.exec(["-hide_banner", "-i", name]); } catch { /* ffmpeg exits non-zero without an output file; the banner is what we need */ }
    const info = parseFfmpegInfo(this.log.join("\n"));
    if (!info) throw explainFailure(this.log.join("\n"));
    return info;
  }

  // ── low-level access for the video-cleanup pipeline (additive; the editor does not use these) ──
  /** Copies the user's file into the engine's memory filesystem (read only; the File itself is never modified). */
  async useInput(file: File): Promise<string> {
    await this.load();
    const ext = (file.name.split(".").pop() || "mp4").toLowerCase().replace(/[^a-z0-9]/g, "") || "mp4";
    const name = `input.${ext}`;
    await this.put(file, name);
    return name;
  }
  /** Runs ffmpeg and returns its exit code with the log text. Throws only if the engine itself is gone. */
  async exec(args: string[], onLine?: (line: string) => void): Promise<{ code: number; log: string }> {
    if (!this.ff) throw new VideoError("engine_load", "The video engine is not running.");
    this.log = []; this.onLogLine = onLine ?? null;
    try { const code = await this.ff.exec(args); return { code, log: this.log.join("\n") }; }
    finally { this.onLogLine = null; }
  }
  async writeBytes(name: string, data: Uint8Array) { if (!this.ff) throw new VideoError("engine_load", "The video engine is not running."); try { await this.ff.writeFile(name, data); } catch (e) { throw explainFailure("", e); } }
  async readBytes(name: string): Promise<Uint8Array> { if (!this.ff) throw new VideoError("engine_load", "The video engine is not running."); return (await this.ff.readFile(name)) as Uint8Array; }
  async removeFile(name: string) { try { await this.ff?.deleteFile(name); } catch { /* already gone */ } }

  async terminate() {
    this.ff?.terminate();
    this.ff = null; this.inputName = null; this.inputFile = null;
  }

  async dispose() { await this.terminate(); }

  async export(file: File, info: VideoInfo, srcHeight: number, settings: VideoSettings, opts: { onProgress?: Progress; signal?: AbortSignal } = {}): Promise<VideoExportResult> {
    const t0 = performance.now();
    const prof = videoProfile();
    if (file.size > prof.maxFileBytes) throw new VideoError("too_large", `This video is ${(file.size / MB).toFixed(1)} MB. ${prof.mobile ? "On a phone" : "In the browser"} the limit for editing is ${prof.maxFileBytes / MB} MB.`);
    const segs = validateSegments(settings.segments, info.duration);
    const total = segs.reduce((n, s) => n + (s.end - s.start), 0);
    if (opts.signal?.aborted) throw new VideoError("cancelled", "Cancelled.");
    await this.load();
    const ext = (file.name.split(".").pop() || "mp4").toLowerCase().replace(/[^a-z0-9]/g, "") || "mp4";
    const inName = `input.${ext}`;
    await this.put(file, inName);
    const ff = this.ff!;
    const temp: string[] = [];
    const hasAudio = info.hasAudio && !settings.removeAudio;
    const preset = QUALITY[settings.quality];
    const crf = Math.min(36, Math.max(16, Math.round(settings.crf ?? preset.crf)));
    const scale = settings.maxHeight > 0 && srcHeight > settings.maxHeight ? settings.maxHeight : 0;
    const wantsCopy = settings.trimMode === "fast" && segs.length === 1 && !scale && settings.quality === "high" && settings.crf === undefined
      && (info.vcodec === "h264" || info.vcodec === "hevc") && (!info.acodec || info.acodec === "aac" || info.acodec === "mp3");
    const abort = () => { void this.terminate(); };
    opts.signal?.addEventListener("abort", abort, { once: true });

    let done = 0;
    this.onLogLine = (line) => {
      const m = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(line);
      if (m) opts.onProgress?.(Math.min(0.98, (done + timeToSec(m[1], m[2], m[3])) / total));
    };
    this.log = [];
    const run = async (args: string[]) => {
      const code = await ff.exec(args);
      if (code !== 0) throw explainFailure(this.log.join("\n"));
    };

    try {
      opts.onProgress?.(0);
      if (wantsCopy) {
        const s = segs[0];
        await run(["-hide_banner", "-ss", fmt(s.start), "-i", inName, "-t", fmt(s.end - s.start), ...(hasAudio ? [] : ["-an"]), "-c", "copy", "-avoid_negative_ts", "make_zero", "-movflags", "+faststart", "out.mp4"]);
        temp.push("out.mp4");
      } else {
        const vf = scale ? ["-vf", `scale=-2:${scale}`] : [];
        const enc = ["-c:v", "libx264", "-preset", "veryfast", "-crf", String(crf), "-pix_fmt", "yuv420p", ...vf,
          ...(hasAudio ? ["-c:a", "aac", "-b:a", `${preset.audioK}k`, "-ac", "2"] : ["-an"]), "-movflags", "+faststart"];
        const target = segs.length === 1 ? "out.mp4" : null;
        for (let i = 0; i < segs.length; i++) {
          const s = segs[i];
          const outName = target ?? `seg${i}.mp4`;
          await run(["-hide_banner", "-ss", fmt(s.start), "-i", inName, "-t", fmt(s.end - s.start), ...enc, outName]);
          temp.push(outName);
          done += s.end - s.start;
        }
        if (!target) {
          await ff.writeFile("list.txt", segs.map((_, i) => `file 'seg${i}.mp4'`).join("\n"));
          temp.push("list.txt");
          await run(["-hide_banner", "-f", "concat", "-safe", "0", "-i", "list.txt", "-c", "copy", "-movflags", "+faststart", "out.mp4"]);
          temp.push("out.mp4");
        }
      }
      const data = (await ff.readFile("out.mp4")) as Uint8Array;
      if (!data || data.byteLength < 1024) throw new VideoError("failed", "The exported video was empty. Please try again with different settings.");
      const blob = new Blob([data.slice().buffer], { type: "video/mp4" });
      opts.onProgress?.(1);
      return { blob, ext: "mp4", mime: "video/mp4", ms: Math.round(performance.now() - t0), mode: wantsCopy ? "copy" : "reencode", durationExpected: total };
    } catch (e) {
      if (opts.signal?.aborted) throw new VideoError("cancelled", "Cancelled.");
      if (e instanceof VideoError) throw e;
      throw explainFailure(this.log.join("\n"), e);
    } finally {
      opts.signal?.removeEventListener("abort", abort);
      this.onLogLine = null;
      if (this.ff) { for (const t of temp) { try { await this.ff.deleteFile(t); } catch { /* ignore */ } } }
    }
  }

  /** Single frame via ffmpeg (fallback for videos the browser itself cannot decode). */
  async frameToJpeg(file: File, info: VideoInfo, time: number): Promise<Blob> {
    await this.load();
    const ext = (file.name.split(".").pop() || "mp4").toLowerCase().replace(/[^a-z0-9]/g, "") || "mp4";
    await this.put(file, `input.${ext}`);
    this.log = [];
    const t = Math.min(Math.max(0, time), Math.max(0, info.duration - 0.05));
    const code = await this.ff!.exec(["-hide_banner", "-ss", fmt(t), "-i", `input.${ext}`, "-frames:v", "1", "-q:v", "2", "thumb.jpg"]);
    if (code !== 0) throw explainFailure(this.log.join("\n"));
    const data = (await this.ff!.readFile("thumb.jpg")) as Uint8Array;
    try { await this.ff!.deleteFile("thumb.jpg"); } catch { /* ignore */ }
    return new Blob([data.slice().buffer], { type: "image/jpeg" });
  }
}

async function prefetchWithProgress(url: string, onProgress?: Progress) {
  const res = await fetch(url, { cache: "force-cache" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const total = Number(res.headers.get("content-length")) || 0;
  if (!res.body || !onProgress) { await res.arrayBuffer(); onProgress?.(1); return; }
  const reader = res.body.getReader();
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    got += value.length;
    if (total) onProgress(Math.min(1, got / total));
  }
  onProgress(1);
}

// ───────────────────────── thumbnails (no engine needed) ─────────────────────────

/** Whether the browser can actually play this video (needed for the preview player and frame capture). */
export function loadVideoElement(src: string): Promise<HTMLVideoElement> {
  return new Promise((resolve, reject) => {
    const v = document.createElement("video");
    v.preload = "auto"; v.muted = true; v.playsInline = true;
    const fail = () => reject(new VideoError("unsupported", "Your browser can't play this video, so it can't be previewed. Try an MP4 (H.264) file."));
    v.onerror = fail;
    v.onloadedmetadata = () => resolve(v);
    v.src = src;
  });
}

export async function captureFrame(video: HTMLVideoElement, time: number, mime: "image/jpeg" | "image/png" = "image/jpeg", quality = 0.92): Promise<Blob> {
  const t = Math.min(Math.max(0, time), Math.max(0, (video.duration || 0) - 0.05));
  if (Math.abs(video.currentTime - t) > 0.001 || video.readyState < 2) {
    await new Promise<void>((resolve, reject) => {
      const done = () => { video.removeEventListener("seeked", done); video.removeEventListener("error", bad); resolve(); };
      const bad = () => { video.removeEventListener("seeked", done); video.removeEventListener("error", bad); reject(new VideoError("failed", "Couldn't read that frame.")); };
      video.addEventListener("seeked", done); video.addEventListener("error", bad);
      video.currentTime = t;
    });
  }
  const c = document.createElement("canvas");
  c.width = video.videoWidth; c.height = video.videoHeight;
  c.getContext("2d")!.drawImage(video, 0, 0);
  const blob = await new Promise<Blob | null>((r) => c.toBlob(r, mime, quality));
  c.width = c.height = 0;
  if (!blob) throw new VideoError("memory", "Couldn't create the thumbnail (not enough memory).");
  return blob;
}

export const formatClock = (s: number) => {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60), sec = s - m * 60;
  return `${m}:${sec.toFixed(1).padStart(4, "0")}`;
};
/** Accepts "83", "83.5", "1:23", "1:23.5" and "0:01:23". Returns null when not a time. */
export function parseClock(text: string): number | null {
  const t = text.trim();
  if (!t) return null;
  const parts = t.split(":");
  if (parts.length > 3 || parts.some((p) => !/^\d+(\.\d+)?$/.test(p))) return null;
  return parts.reduce((acc, p) => acc * 60 + parseFloat(p), 0);
}

export function describeVideoOps(settings: VideoSettings, info: VideoInfo, out: { bytes: number; mode: string }): Record<string, unknown> {
  return {
    kind: "video",
    segments: settings.segments.map((s) => ({ start: +s.start.toFixed(3), end: +s.end.toFixed(3) })),
    quality: settings.quality, crf: settings.crf ?? QUALITY[settings.quality].crf,
    maxHeight: settings.maxHeight || null, removeAudio: settings.removeAudio, trimMode: out.mode,
    source: { duration: +info.duration.toFixed(2), width: info.width, height: info.height, vcodec: info.vcodec },
    outputBytes: out.bytes,
  };
}
