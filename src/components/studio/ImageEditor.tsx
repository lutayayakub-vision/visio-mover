import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import CompareSlider from "../compare/CompareSlider";
import Spinner from "../ui/Spinner";
import { useToast } from "../ui/Toast";
import { useHistory } from "../../hooks/useHistory";
import { ProgressBar, Slider, type Source } from "./common";
import {
  DEFAULT_OPS, FORMATS, ImageError, decodeImage, deviceProfile, exportImage, fitKeepingAspect, flipVisible, formatExtFromName, isDefaultOps,
  makeWorkingCopy, outputSize, renderImage, rotateVisible, rotatedSize, cropRectPx, describeOps,
  type Crop, type DecodedImage, type ExportResult, type ImageOps, type OutFormat,
} from "../../lib/imageEngine";
import { EditingError, downloadBlob, editedName, saveEditedCopy } from "../../lib/editing";
import { formatBytes } from "../../lib/files";
import CleanupStage, { useStrokes } from "./CleanupStage";
import { CleanupError, ENGINE_NAME, ENGINE_VERSION, cleanupLimits, maxCleanups, reconstruct, type CleanupResult } from "../../lib/inpaintEngine";
import { describeStrokes } from "../../lib/inpaint/strokes";

type Version = { bitmap: ImageBitmap; work: ImageBitmap | HTMLCanvasElement; info: Record<string, unknown> };
type Candidate = { res: CleanupResult; work: ImageBitmap | HTMLCanvasElement; info: Record<string, unknown> };

type State = { ops: ImageOps; format: OutFormat; quality: number };
const QUALITY_PRESETS = [{ id: "high", label: "High", v: 0.9 }, { id: "balanced", label: "Balanced", v: 0.75 }, { id: "small", label: "Small", v: 0.55 }];
const RATIOS: { id: string; label: string; r: number | null }[] = [
  { id: "free", label: "Free", r: null }, { id: "1:1", label: "1:1", r: 1 }, { id: "4:3", label: "4:3", r: 4 / 3 }, { id: "3:2", label: "3:2", r: 3 / 2 }, { id: "16:9", label: "16:9", r: 16 / 9 }, { id: "9:16", label: "9:16", r: 9 / 16 },
];
const MIN_CROP = 0.03;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Largest centred rectangle with pixel aspect `r` inside a frame of fw x fh (normalised result). */
function centredCrop(r: number, fw: number, fh: number): Crop {
  let w = 1, h = fw / r / fh;
  if (h > 1) { h = 1; w = (fh * r) / fw; }
  return { x: (1 - w) / 2, y: (1 - h) / 2, w, h };
}

type Handle = "move" | "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
const HANDLES: Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

function dragCrop(start: Crop, handle: Handle, dx: number, dy: number, lockPx: number | null, fw: number, fh: number): Crop {
  if (handle === "move") return { ...start, x: clamp(start.x + dx, 0, 1 - start.w), y: clamp(start.y + dy, 0, 1 - start.h) };
  let l = start.x, t = start.y, r = start.x + start.w, b = start.y + start.h;
  if (handle.includes("w")) l = clamp(l + dx, 0, r - MIN_CROP);
  if (handle.includes("e")) r = clamp(r + dx, l + MIN_CROP, 1);
  if (handle.includes("n")) t = clamp(t + dy, 0, b - MIN_CROP);
  if (handle.includes("s")) b = clamp(b + dy, t + MIN_CROP, 1);
  if (lockPx) {
    const a = (lockPx * fh) / fw; // normalised width / height
    const vertical = handle === "n" || handle === "s";
    const horizontal = handle === "e" || handle === "w";
    let w = r - l, h = b - t;
    if (vertical) w = h * a; else h = w / a;
    const anchorRight = handle.includes("w"); // dragging a west edge keeps the right edge fixed
    const anchorBottom = handle.includes("n");
    const cx = start.x + start.w / 2, cy = start.y + start.h / 2;
    const maxW = vertical ? Math.min(2 * cx, 2 * (1 - cx)) : anchorRight ? r : 1 - l;
    const maxH = horizontal ? Math.min(2 * cy, 2 * (1 - cy)) : anchorBottom ? b : 1 - t;
    const k = Math.min(1, maxW / w, maxH / h);
    w *= k; h *= k;
    if (vertical) { l = cx - w / 2; r = l + w; } else if (anchorRight) l = r - w; else r = l + w;
    if (horizontal) { t = cy - h / 2; b = t + h; } else if (anchorBottom) t = b - h; else b = t + h;
  }
  return { x: l, y: t, w: r - l, h: b - t };
}

function Pic({ src, label }: { src: ImageBitmap | HTMLCanvasElement; label: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => { const c = ref.current; if (c) { c.width = src.width; c.height = src.height; c.getContext("2d")!.drawImage(src, 0, 0); } }, [src]);
  return <canvas ref={ref} className="st-canvas" aria-label={label} />;
}

export default function ImageEditor({ source, active, onReplace }: { source: Source; active: boolean; onReplace: () => void }) {
  const toast = useToast();
  const profile = useMemo(() => deviceProfile(), []);
  const hist = useHistory<State>({ ops: DEFAULT_OPS, format: "jpg", quality: 0.8 });
  const { value: st, set, undo, redo, reset, restart, canUndo, canRedo } = hist;
  const { ops } = st;

  const [dec, setDec] = useState<DecodedImage | null>(null);
  const [work, setWork] = useState<ImageBitmap | HTMLCanvasElement | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [view, setView] = useState<"compare" | "after" | "before">("compare");
  const [cropMode, setCropMode] = useState(false);
  const [draft, setDraft] = useState<Crop>({ x: 0, y: 0, w: 1, h: 1 });
  const [ratio, setRatio] = useState("free");
  const [lock, setLock] = useState(true);
  const [prevDims, setPrevDims] = useState<{ w: number; h: number } | null>(null);
  const [rendering, setRendering] = useState(false);

  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<{ r: ExportResult; key: string } | null>(null);
  const [procError, setProcError] = useState<string | null>(null);
  const ctl = useRef<AbortController | null>(null);

  const [saving, setSaving] = useState(false);
  const [saveProgress, setSaveProgress] = useState(0);
  const [saved, setSaved] = useState<string | null>(null);
  const saveCtl = useRef<AbortController | null>(null);

  // ───── intelligent cleanup (inpainting) ─────
  const [mode, setMode] = useState<"adjust" | "cleanup">("adjust");
  const [cleaned, setCleaned] = useState<Version[]>([]);
  const cleanedRef = useRef<Version[]>([]);
  cleanedRef.current = cleaned;
  const sel = useStrokes();
  const [running, setRunning] = useState(false);
  const [clProgress, setClProgress] = useState({ f: 0, label: "" });
  const [clError, setClError] = useState<string | null>(null);
  const [cand, setCand] = useState<Candidate | null>(null);
  const clCtl = useRef<AbortController | null>(null);
  const runSeq = useRef(0);   // bumped whenever a running reconstruction must be ignored (new source, unmount)
  const candRef = useRef<Candidate | null>(null);
  candRef.current = cand;
  const top = cleaned.length ? cleaned[cleaned.length - 1] : null;

  const afterRef = useRef<HTMLCanvasElement>(null);
  const cropFrameRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const url = useRef<string | null>(null);
  const [resultUrl, setResultUrl] = useState<string | null>(null);

  // ───── load + decode the chosen image (validates type, damage and size before decoding pixels) ─────
  useEffect(() => {
    let alive = true;
    let bmp: ImageBitmap | null = null;
    setDec(null); setWork(null); setLoadError(null); setResult(null); setSaved(null); setCropMode(false); setPrevDims(null);
    runSeq.current++; clCtl.current?.abort(); candRef.current?.res.bitmap.close();
    cleanedRef.current.forEach((v) => v.bitmap.close()); setCleaned([]); setCand(null); setRunning(false); setMode("adjust"); setClError(null); sel.clear();
    const base = formatExtFromName(source.file.name);
    restart({ ops: DEFAULT_OPS, format: base ?? "jpg", quality: 0.8 });
    decodeImage(source.file, profile)
      .then(async (d) => {
        bmp = d.bitmap;
        const w = await makeWorkingCopy(d.bitmap, profile.previewSide);
        if (!alive) { d.bitmap.close(); return; }
        setDec(d); setWork(w);
      })
      .catch((e: unknown) => { if (alive) setLoadError(e instanceof ImageError ? e.message : "This image couldn't be opened."); });
    return () => { alive = false; bmp?.close(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, profile, restart]);

  useEffect(() => () => { if (url.current) URL.revokeObjectURL(url.current); runSeq.current++; clCtl.current?.abort(); candRef.current?.res.bitmap.close(); cleanedRef.current.forEach((v) => v.bitmap.close()); }, []);

  // ───── live preview (small working copy; the full-size image is only touched on export) ─────
  const previewOps = useMemo<ImageOps>(() => ({ ...ops, resize: null, crop: cropMode ? null : ops.crop }), [ops, cropMode]);
  useEffect(() => {
    const base = top ? top.work : work;
    if (!base || !active) return;
    const c = new AbortController();
    setRendering(true);
    const t = setTimeout(async () => {
      try {
        const { canvas, width, height } = await renderImage(base, previewOps, { signal: c.signal });
        if (c.signal.aborted) return;
        const target = cropMode ? cropFrameRef.current : afterRef.current;
        if (target) { target.width = width; target.height = height; target.getContext("2d")!.drawImage(canvas, 0, 0); }
        if (!cropMode) setPrevDims({ w: width, h: height });
        canvas.width = canvas.height = 0;
      } catch (e) { if (!(e instanceof ImageError && e.code === "cancelled")) toast("error", "Couldn't update the preview."); }
      finally { if (!c.signal.aborted) setRendering(false); }
    }, 30);
    return () => { c.abort(); clearTimeout(t); };
  }, [work, top, previewOps, cropMode, active, toast, mode, view]);

  const drawBefore = useCallback((el: HTMLCanvasElement | null) => {
    if (el && work) { const w = work as ImageBitmap; el.width = w.width; el.height = w.height; el.getContext("2d")!.drawImage(work, 0, 0); }
  }, [work]);

  // ───── derived sizes (full resolution) ─────
  const size = useMemo(() => (dec ? outputSize(dec.width, dec.height, ops, { maxOutputPixels: profile.maxOutputPixels }) : null), [dec, ops, profile]);
  const baseSize = useMemo(() => {
    if (!dec) return null;
    const r = rotatedSize(dec.width, dec.height, ops.rotate);
    const c = cropRectPx(ops.crop, r.w, r.h);
    return { w: c.w, h: c.h };
  }, [dec, ops.rotate, ops.crop]);

  const key = JSON.stringify(st) + "|c" + cleaned.length;
  const stale = !!result && result.key !== key;

  // ───── editing actions ─────
  const setOps = (fn: (o: ImageOps) => ImageOps, k?: string) => set((s) => ({ ...s, ops: fn(s.ops) }), k);
  const doRotate = (d: "cw" | "ccw") => { setCropMode(false); setOps((o) => rotateVisible(o, d)); };
  const doFlip = (a: "h" | "v") => { setCropMode(false); setOps((o) => flipVisible(o, a)); };

  const frame = useMemo(() => (dec ? rotatedSize(dec.width, dec.height, ops.rotate) : null), [dec, ops.rotate]);

  const startCrop = () => { setDraft(ops.crop ?? { x: 0, y: 0, w: 1, h: 1 }); setRatio("free"); setCropMode(true); };
  const applyCrop = () => {
    const full = draft.w > 0.999 && draft.h > 0.999;
    setOps((o) => ({ ...o, crop: full ? null : draft, resize: null }));
    setCropMode(false);
  };
  const pickRatio = (id: string) => {
    setRatio(id);
    const r = RATIOS.find((x) => x.id === id)?.r;
    if (r && frame) setDraft(centredCrop(r, frame.w, frame.h));
  };
  const lockPx = useMemo(() => {
    const r = RATIOS.find((x) => x.id === ratio)?.r;
    return r ?? null;
  }, [ratio]);

  const drag = useRef<{ h: Handle; sx: number; sy: number; start: Crop } | null>(null);
  const onHandleDown = (h: Handle) => (e: React.PointerEvent) => {
    e.preventDefault(); e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { h, sx: e.clientX, sy: e.clientY, start: draft };
  };
  const onHandleMove = (e: React.PointerEvent) => {
    const d = drag.current, el = stageRef.current;
    if (!d || !el || !frame) return;
    const r = el.getBoundingClientRect();
    setDraft(dragCrop(d.start, d.h, (e.clientX - d.sx) / r.width, (e.clientY - d.sy) / r.height, lockPx, frame.w, frame.h));
  };
  const onHandleUp = () => { drag.current = null; };

  const setSizeFromWidth = (w: number) => {
    if (!baseSize) return;
    const wv = clamp(Math.round(w) || 1, 1, 20000);
    setOps((o) => ({ ...o, resize: lock ? fitKeepingAspect(baseSize.w, baseSize.h, { width: wv }) : { width: wv, height: o.resize?.height ?? baseSize.h } }), "size");
  };
  const setSizeFromHeight = (h: number) => {
    if (!baseSize) return;
    const hv = clamp(Math.round(h) || 1, 1, 20000);
    setOps((o) => ({ ...o, resize: lock ? fitKeepingAspect(baseSize.w, baseSize.h, { height: hv }) : { width: o.resize?.width ?? baseSize.w, height: hv } }), "size");
  };
  const percent = (p: number) => baseSize && setOps((o) => ({ ...o, resize: p === 100 ? null : { width: Math.max(1, Math.round(baseSize.w * p / 100)), height: Math.max(1, Math.round(baseSize.h * p / 100)) } }));

  // keyboard shortcuts (not while typing)
  useEffect(() => {
    if (!active) return;
    const k = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") { e.preventDefault(); redo(); }
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [active, undo, redo]);

  // ───── processing ─────
  const process = async () => {
    if (!dec) return;
    setProcError(null); setSaved(null); setResult(null); setBusy(true); setProgress(0);
    const c = new AbortController(); ctl.current = c;
    try {
      const r = await exportImage(top ? top.bitmap : dec.bitmap, ops, { format: st.format, quality: st.quality }, { onProgress: setProgress, signal: c.signal, profile });
      setResult({ r, key });
      if (url.current) URL.revokeObjectURL(url.current);
      url.current = URL.createObjectURL(r.blob); setResultUrl(url.current);
    } catch (e) {
      if (e instanceof ImageError && e.code === "cancelled") toast("info", "Processing cancelled.");
      else setProcError(e instanceof Error ? e.message : "Processing failed.");
    } finally { setBusy(false); ctl.current = null; }
  };

  const outName = (suffix = "edited") => editedName(source.record?.original_name ?? source.file.name, result ? result.r.ext : FORMATS[st.format].ext, suffix);
  const download = () => { if (result) { downloadBlob(result.r.blob, outName()); toast("success", `Download started: ${outName()}`); } };
  const save = async () => {
    if (!result) return;
    setSaving(true); setSaveProgress(0); setSaved(null);
    const c = new AbortController(); saveCtl.current = c;
    try {
      const { name } = await saveEditedCopy({
        blob: result.r.blob, ext: result.r.ext, mime: result.r.mime, category: "image",
        originalName: source.record?.original_name ?? source.file.name, sourceId: source.record?.id ?? null, kind: cleaned.length ? "cleanup" : "image",
        params: cleaned.length
          ? { ...describeOps(ops, { format: st.format, quality: st.quality }, result.r), kind: "cleanup", cleanup: { engine: ENGINE_NAME, version: ENGINE_VERSION, ai: false, passes: cleaned.map((v) => v.info) } }
          : describeOps(ops, { format: st.format, quality: st.quality }, result.r), onProgress: setSaveProgress, signal: c.signal,
      });
      setSaved(name); toast("success", `Saved "${name}" to your workspace.`);
    } catch (e) {
      if (e instanceof Error && e.message === "Upload cancelled") toast("info", "Save cancelled.");
      else toast("error", e instanceof EditingError || e instanceof Error ? e.message : "Couldn't save the copy.");
    } finally { setSaving(false); saveCtl.current = null; }
  };

  const enterCleanup = () => { setCropMode(false); setClError(null); setMode("cleanup"); };
  const leaveCleanup = () => { if (running) return; setMode("adjust"); };

  const runCleanup = async () => {
    if (!dec) return;
    if (cleaned.length >= cap) { setClError(capMessage); return; }
    const myRun = ++runSeq.current;
    setClError(null); setCand(null); setRunning(true); setClProgress({ f: 0, label: "Starting" });
    const c = new AbortController(); clCtl.current = c;
    try {
      const res = await reconstruct(top ? top.bitmap : dec.bitmap, sel.strokes, { profile, signal: c.signal, onProgress: (f, label) => setClProgress({ f, label }) });
      if (myRun !== runSeq.current) { res.bitmap.close(); return; } // the source changed or the editor closed meanwhile
      const w = await makeWorkingCopy(res.bitmap, profile.previewSide);
      if (myRun !== runSeq.current) { res.bitmap.close(); return; }
      const d = describeStrokes(sel.strokes);
      const info = {
        strokes: d.paintStrokes, erasedStrokes: d.eraseStrokes, brushMin: Math.round(d.brushMin), brushMax: Math.round(d.brushMax),
        maskPixels: res.maskPixels, roi: res.roi, levels: res.stats.levels, iterations: res.stats.iterations, workScale: +res.stats.workScale.toFixed(3),
        meanPatchError: +res.stats.meanPatchError.toFixed(2), ms: Math.round(res.ms), at: new Date().toISOString(),
      };
      setCand({ res, work: w, info });
    } catch (e) {
      if (myRun !== runSeq.current) return;
      if (e instanceof CleanupError && e.code === "cancelled") toast("info", "Reconstruction cancelled. Nothing was changed.");
      else setClError(e instanceof Error ? e.message : "Reconstruction failed. Nothing was changed.");
    } finally { if (myRun === runSeq.current) { setRunning(false); clCtl.current = null; } }
  };
  const acceptCleanup = () => {
    if (!cand) return;
    if (cleaned.length >= cap) { setClError(capMessage); return; }
    setCleaned((v) => (v.length >= cap ? v : [...v, { bitmap: cand.res.bitmap, work: cand.work, info: cand.info }]));
    setCand(null); sel.clear(); setResult(null); setSaved(null);
    toast("success", "Cleanup applied. Your original file is unchanged.");
  };
  const discardCleanup = () => { cand?.res.bitmap.close(); setCand(null); };
  const undoApplied = () => {
    const v = cleanedRef.current[cleanedRef.current.length - 1]; if (!v) return;
    v.bitmap.close(); setCleaned((x) => x.slice(0, -1)); setResult(null); setSaved(null);
  };
  const limits = cleanupLimits(profile);
  const tooBig = !!dec && dec.width * dec.height > limits.maxImagePixels;
  const cap = dec ? maxCleanups(dec.width, dec.height, profile) : 1;
  const atCap = cleaned.length >= cap;
  const capMessage = `You can apply up to ${cap} cleanup${cap > 1 ? "s" : ""} to this image in one session. Save a copy, then open the copy to keep going.`;

  // ───── render ─────
  if (loadError) return <div className="panel card"><div className="empty" role="alert"><h3>This image can't be edited</h3><p>{loadError}</p><button className="btn btn-primary btn-md" onClick={onReplace}><span>Choose another image</span></button></div></div>;
  if (!dec || !work || !size || !baseSize || !frame) return <div className="panel card"><div className="st-center" style={{ padding: 48 }}><Spinner size={34} label="Opening image" /></div></div>;

  const fmt = FORMATS[st.format];
  const outW = ops.resize?.width ?? baseSize.w, outH = ops.resize?.height ?? baseSize.h;
  const changed = !isDefaultOps(ops);
  const sizeDelta = result ? Math.round((1 - result.r.blob.size / source.file.size) * 100) : 0;
  const aspect = prevDims ? `${prevDims.w} / ${prevDims.h}` : `${baseSize.w} / ${baseSize.h}`;

  return (
    <div className="st-layout">
      <section className="panel card st-preview" aria-label="Image preview">
        <div className="st-bar">
          <div className="st-group" role="toolbar" aria-label="History">
            <button className="btn btn-ghost btn-sm" onClick={undo} disabled={!canUndo || busy} aria-label="Undo"><span>Undo</span></button>
            <button className="btn btn-ghost btn-sm" onClick={redo} disabled={!canRedo || busy} aria-label="Redo"><span>Redo</span></button>
            <button className="btn btn-ghost btn-sm" onClick={reset} disabled={!(canUndo || changed) || busy}><span>Reset all</span></button>
          </div>
          {!cropMode && mode === "adjust" && (
            <div className="chips" role="group" aria-label="Preview mode">
              {([["compare", "Before / After"], ["after", "Edited"], ["before", "Original"]] as const).map(([id, l]) => (
                <button key={id} className={`chip-btn ${view === id ? "on" : ""}`} aria-pressed={view === id} onClick={() => setView(id)}>{l}</button>
              ))}
            </div>
          )}
        </div>

        {mode === "cleanup" ? (
          <div className="st-stage cl-wrap" data-testid="cleanup-stage">
            {cand ? (
              <div className="st-fit" style={{ width: `min(100%, ${(66 * (dec.width / dec.height)).toFixed(2)}vh)` }} data-testid="cleanup-compare">
                <CompareSlider aspect={`${dec.width} / ${dec.height}`} before={<Pic src={top ? top.work : work} label="Before cleanup" />} after={<Pic src={cand.work} label="After cleanup (not applied yet)" />} beforeLabel="Before" afterLabel="After" />
              </div>
            ) : (
              <CleanupStage display={top ? top.work : work} imgW={dec.width} imgH={dec.height} api={sel} disabled={running || tooBig} />
            )}
            {running && <div className="cl-busy" role="status"><Spinner size={18} /> {clProgress.label || "Working"}…</div>}
          </div>
        ) : cropMode ? (
          <div className="st-cropwrap">
            <div ref={stageRef} className="st-cropstage" style={{ aspectRatio: `${frame.w} / ${frame.h}`, width: `min(100%, ${(60 * frame.w / frame.h).toFixed(2)}vh)` }}>
              <canvas ref={cropFrameRef} className="st-canvas" aria-label="Image being cropped" />
              <div className="st-shade" style={{ clipPath: `polygon(evenodd, 0 0,100% 0,100% 100%,0 100%,0 0,${draft.x * 100}% ${draft.y * 100}%,${(draft.x + draft.w) * 100}% ${draft.y * 100}%,${(draft.x + draft.w) * 100}% ${(draft.y + draft.h) * 100}%,${draft.x * 100}% ${(draft.y + draft.h) * 100}%,${draft.x * 100}% ${draft.y * 100}%)` }} />
              <div className="st-crop" data-testid="crop-box" style={{ left: `${draft.x * 100}%`, top: `${draft.y * 100}%`, width: `${draft.w * 100}%`, height: `${draft.h * 100}%` }}
                onPointerDown={onHandleDown("move")} onPointerMove={onHandleMove} onPointerUp={onHandleUp} onPointerCancel={onHandleUp}>
                {HANDLES.map((h) => <span key={h} className={`st-h st-h-${h}`} data-handle={h} onPointerDown={onHandleDown(h)} onPointerMove={onHandleMove} onPointerUp={onHandleUp} onPointerCancel={onHandleUp} />)}
              </div>
            </div>
            <div className="st-cropbar">
              <div className="chips" role="group" aria-label="Crop shape">
                {RATIOS.map((r) => <button key={r.id} className={`chip-btn ${ratio === r.id ? "on" : ""}`} aria-pressed={ratio === r.id} onClick={() => pickRatio(r.id)}>{r.label}</button>)}
              </div>
              <span className="st-muted" aria-live="polite">{Math.round(draft.w * frame.w)} × {Math.round(draft.h * frame.h)} px</span>
              <div className="st-group">
                <button className="btn btn-ghost btn-sm" onClick={() => setCropMode(false)}><span>Cancel</span></button>
                <button className="btn btn-primary btn-sm" onClick={applyCrop}><span>Apply crop</span></button>
              </div>
            </div>
          </div>
        ) : (
          <div className="st-stage" data-testid="preview-stage">
            <div className="st-fit" style={{ width: `min(100%, ${(66 * (prevDims ? prevDims.w / prevDims.h : baseSize.w / baseSize.h)).toFixed(2)}vh)` }}>
              {view === "compare" && (
                <CompareSlider aspect={aspect} before={<canvas ref={drawBefore} className="st-canvas" aria-label="Original image" />} after={<canvas ref={afterRef} className="st-canvas" aria-label="Edited image preview" />} beforeLabel="Original" afterLabel="Edited" />
              )}
              {view !== "compare" && <div className="st-single" style={{ aspectRatio: view === "after" ? aspect : `${(work as ImageBitmap).width} / ${(work as ImageBitmap).height}` }}>
                {view === "after" ? <canvas ref={afterRef} className="st-canvas" aria-label="Edited image preview" /> : <canvas ref={drawBefore} className="st-canvas" aria-label="Original image" />}
              </div>}
            </div>
            {rendering && <span className="st-rendering"><Spinner size={16} /> Updating</span>}
          </div>
        )}

        <dl className="st-facts">
          <div><dt>Original</dt><dd>{dec.width} × {dec.height} · {formatBytes(source.file.size)}</dd></div>
          <div><dt>Output</dt><dd data-testid="out-dims">{size.w} × {size.h}{size.limited ? " (reduced to fit this device)" : ""}</dd></div>
        </dl>
      </section>

      <aside className="st-side" aria-label="Editing controls">
        <section className="panel card st-card" data-testid="cleanup-card">
          <h2>Remove objects</h2>
          {mode === "adjust" ? (
            <>
              <p className="st-note">Paint over something you want gone (a stray person, a blemish, a watermark you own). VISIOMOVER rebuilds that area from the rest of the photo. Runs on your device; the image is never uploaded for this.</p>
              <button className="btn btn-primary btn-md st-wide" onClick={enterCleanup} disabled={busy || saving} data-testid="open-cleanup"><span>Select area to remove</span></button>
              {cleaned.length > 0 && (
                <p className="st-good" data-testid="cleanup-count">{cleaned.length} cleanup{cleaned.length > 1 ? "s" : ""} applied.{" "}
                  <button className="link st-linkbtn" onClick={undoApplied} disabled={busy} data-testid="undo-applied">Undo last cleanup</button></p>
              )}
            </>
          ) : (
            <>
              {tooBig && <p className="st-err" role="alert">This image is {(dec.width * dec.height / 1e6).toFixed(0)} megapixels; cleanup here supports up to {limits.maxImagePixels / 1e6}. Resize it, save the copy and open the copy.</p>}
              {atCap && !cand && <p className="st-err" role="alert" data-testid="cleanup-cap">{capMessage}</p>}
              {!cand && !running && (
                <>
                  <p className="st-note">1. Paint the area to remove. 2. Press Reconstruct. 3. Compare, then Apply or Discard.</p>
                  <button className="btn btn-primary btn-md st-wide" onClick={runCleanup} disabled={!sel.strokes.length || tooBig || atCap} data-testid="reconstruct"><span>Reconstruct</span></button>
                  <button className="btn btn-ghost btn-sm" onClick={leaveCleanup} data-testid="cleanup-done"><span>{sel.strokes.length ? "Cancel selection" : "Close cleanup"}</span></button>
                </>
              )}
              {running && (
                <div className="st-busy">
                  <ProgressBar value={clProgress.f} label={`Reconstructing: ${clProgress.label}`} />
                  <button className="btn btn-ghost btn-sm" onClick={() => clCtl.current?.abort()} data-testid="cleanup-cancel"><span>Cancel</span></button>
                </div>
              )}
              {cand && (
                <div className="st-result" data-testid="cleanup-candidate">
                  <b>Preview ready</b>
                  <span className="st-muted">Drag the slider to compare. Only the selected area changed; the rest of the image is untouched. Not applied yet.</span>
                  <div className="st-btnrow">
                    <button className="btn btn-primary btn-sm" onClick={acceptCleanup} data-testid="cleanup-apply"><span>Apply</span></button>
                    <button className="btn btn-ghost btn-sm" onClick={discardCleanup} data-testid="cleanup-discard"><span>Discard</span></button>
                  </div>
                </div>
              )}
              {clError && <p className="st-err" role="alert" data-testid="cleanup-error">{clError}</p>}
            </>
          )}
        </section>

        {mode === "adjust" && <>
        <section className="panel card st-card">
          <h2>Transform</h2>
          <div className="st-btnrow">
            <button className="btn btn-ghost btn-sm" onClick={() => doRotate("ccw")} disabled={busy}><span>⟲ Rotate left</span></button>
            <button className="btn btn-ghost btn-sm" onClick={() => doRotate("cw")} disabled={busy}><span>⟳ Rotate right</span></button>
            <button className="btn btn-ghost btn-sm" onClick={() => doFlip("h")} disabled={busy} aria-pressed={ops.flipH}><span>⇋ Flip horizontal</span></button>
            <button className="btn btn-ghost btn-sm" onClick={() => doFlip("v")} disabled={busy} aria-pressed={ops.flipV}><span>⇅ Flip vertical</span></button>
          </div>
          <div className="st-btnrow">
            <button className={`btn btn-sm ${ops.crop ? "btn-primary" : "btn-ghost"}`} onClick={startCrop} disabled={busy || cropMode}><span>{ops.crop ? "Edit crop" : "Crop"}</span></button>
            {ops.crop && <button className="btn btn-ghost btn-sm" onClick={() => setOps((o) => ({ ...o, crop: null, resize: null }))} disabled={busy}><span>Remove crop</span></button>}
          </div>
        </section>

        <section className="panel card st-card">
          <h2>Resize</h2>
          <div className="st-size">
            <label className="st-num"><span>Width</span><input type="number" inputMode="numeric" min={1} max={20000} value={outW} onChange={(e) => setSizeFromWidth(Number(e.target.value))} disabled={busy} /></label>
            <label className="st-lock"><input type="checkbox" checked={lock} onChange={(e) => setLock(e.target.checked)} /><span>Keep proportions</span></label>
            <label className="st-num"><span>Height</span><input type="number" inputMode="numeric" min={1} max={20000} value={outH} onChange={(e) => setSizeFromHeight(Number(e.target.value))} disabled={busy} /></label>
          </div>
          <div className="chips" role="group" aria-label="Scale presets">
            {[100, 75, 50, 25].map((p) => <button key={p} className="chip-btn" onClick={() => percent(p)} disabled={busy}>{p}%</button>)}
          </div>
        </section>

        <section className="panel card st-card">
          <h2>Adjust</h2>
          {(["brightness", "contrast", "saturation"] as const).map((k) => (
            <Slider key={k} id={`adj-${k}`} label={k[0].toUpperCase() + k.slice(1)} min={-100} max={100} value={ops[k]} disabled={busy}
              onChange={(v) => setOps((o) => ({ ...o, [k]: v }), k)} onReset={() => setOps((o) => ({ ...o, [k]: 0 }))} />
          ))}
        </section>

        </>}

        <section className="panel card st-card">
          <h2>Export</h2>
          <div className="chips" role="group" aria-label="File format">
            {(Object.keys(FORMATS) as OutFormat[]).map((f) => (
              <button key={f} className={`chip-btn ${st.format === f ? "on" : ""}`} aria-pressed={st.format === f} onClick={() => set((s) => ({ ...s, format: f }))} disabled={busy}>{FORMATS[f].label}</button>
            ))}
          </div>
          {fmt.lossy ? (
            <>
              <Slider id="quality" label="Quality" min={10} max={100} step={5} unit="%" value={Math.round(st.quality * 100)} disabled={busy} onChange={(v) => set((s) => ({ ...s, quality: v / 100 }), "quality")} />
              <div className="chips" role="group" aria-label="Quality presets">
                {QUALITY_PRESETS.map((p) => <button key={p.id} className={`chip-btn ${Math.abs(st.quality - p.v) < 0.001 ? "on" : ""}`} onClick={() => set((s) => ({ ...s, quality: p.v }))} disabled={busy}>{p.label}</button>)}
              </div>
              {fmt.mime === "image/jpeg" && source.file.type === "image/png" && <p className="st-note">Transparent areas become white in JPG. Choose PNG or WEBP to keep transparency.</p>}
            </>
          ) : <p className="st-note">PNG is lossless, so there's no quality setting. Choose JPG or WEBP for smaller files.</p>}

          {!busy && <button className="btn btn-primary btn-md st-wide" onClick={process} disabled={running || !!cand} data-testid="process"><span>{result && !stale ? "Process again" : "Process image"}</span></button>}
          {busy && (
            <div className="st-busy">
              <ProgressBar value={progress} label="Processing image" />
              <button className="btn btn-ghost btn-sm" onClick={() => ctl.current?.abort()}><span>Cancel</span></button>
            </div>
          )}
          {procError && <p className="st-err" role="alert">{procError}</p>}

          {result && (
            <div className={`st-result ${stale ? "is-stale" : ""}`} data-testid="result">
              {resultUrl && <img src={resultUrl} alt="Processed result" className="st-thumb" />}
              <div className="st-result-meta">
                <b>{result.r.width} × {result.r.height} · {fmt.label} · {formatBytes(result.r.blob.size)}</b>
                <span className={sizeDelta > 0 ? "st-good" : "st-muted"}>{sizeDelta > 0 ? `${sizeDelta}% smaller than the original` : sizeDelta < 0 ? `${Math.abs(sizeDelta)}% larger than the original` : "Same size as the original"}</span>
                {stale && <span className="st-warn">Settings changed. Process again to update this file.</span>}
              </div>
              <div className="st-btnrow">
                <button className="btn btn-primary btn-sm" onClick={download} disabled={stale || saving} data-testid="download"><span>Download</span></button>
                <button className="btn btn-ghost btn-sm" onClick={save} disabled={stale || saving} data-testid="save"><span>{saving ? <><Spinner size={14} /> Saving…</> : "Save to workspace"}</span></button>
              </div>
              {saving && <ProgressBar value={saveProgress} label="Saving to your workspace" />}
              {saved && <p className="st-good" role="status" data-testid="saved">Saved as “{saved}”. <Link className="link" to="/workspace">View in workspace</Link></p>}
              <p className="st-muted">Your original file is never changed. Edits create a new copy.</p>
            </div>
          )}
        </section>
      </aside>
    </div>
  );
}
