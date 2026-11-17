import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import Spinner from "../ui/Spinner";
import { useToast } from "../ui/Toast";
import { useHistory } from "../../hooks/useHistory";
import { ProgressBar, type Source } from "./common";
import {
  QUALITY, RESOLUTIONS, VideoEngine, VideoError, captureFrame, describeVideoOps, formatClock, loadVideoElement, parseClock, validateSegments, videoProfile,
  type QualityPreset, type Segment, type VideoExportResult, type VideoInfo, type VideoSettings,
} from "../../lib/videoEngine";
import { EditingError, downloadBlob, editedName, saveEditedCopy } from "../../lib/editing";
import { formatBytes } from "../../lib/files";

const MIN = 0.1;

function TimeInput({ label, value, max, onCommit }: { label: string; value: number; max: number; onCommit: (v: number) => void }) {
  const [text, setText] = useState(formatClock(value));
  const [bad, setBad] = useState(false);
  useEffect(() => { setText(formatClock(value)); setBad(false); }, [value]);
  const commit = () => {
    const v = parseClock(text);
    if (v === null || v < 0 || v > max + 0.001) { setBad(true); return; }
    setBad(false); onCommit(Math.min(v, max));
  };
  return (
    <label className="st-num"><span>{label}</span>
      <input type="text" inputMode="decimal" value={text} aria-invalid={bad} className={bad ? "bad" : ""}
        onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === "Enter") commit(); }} />
    </label>
  );
}

export default function VideoEditor({ source, active, onReplace }: { source: Source; active: boolean; onReplace: () => void }) {
  const toast = useToast();
  const profile = useMemo(() => videoProfile(), []);
  const engine = useRef<VideoEngine | null>(null);
  if (!engine.current) engine.current = new VideoEngine();

  const initial: VideoSettings = { segments: [{ start: 0, end: 0 }], quality: "balanced", maxHeight: 0, removeAudio: false, trimMode: "precise" };
  const hist = useHistory<VideoSettings>(initial);
  const { value: st, set, undo, redo, reset, restart, canUndo, canRedo } = hist;

  const [srcUrl, setSrcUrl] = useState<string | null>(null);
  const [duration, setDuration] = useState(0);
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [info, setInfo] = useState<VideoInfo | null>(null);
  const [now, setNow] = useState(0);
  const videoRef = useRef<HTMLVideoElement>(null);

  const [phase, setPhase] = useState<"idle" | "engine" | "working">("idle");
  const [engineProgress, setEngineProgress] = useState(0);
  const [progress, setProgress] = useState(0);
  const [procError, setProcError] = useState<string | null>(null);
  const [result, setResult] = useState<{ r: VideoExportResult; key: string; url: string } | null>(null);
  const ctl = useRef<AbortController | null>(null);

  const [saving, setSaving] = useState(false);
  const [saveProgress, setSaveProgress] = useState(0);
  const [saved, setSaved] = useState<string | null>(null);
  const [thumb, setThumb] = useState<{ blob: Blob; url: string; time: number } | null>(null);
  const [thumbBusy, setThumbBusy] = useState(false);
  const [thumbSaved, setThumbSaved] = useState<string | null>(null);

  const busy = phase !== "idle";
  const tooBig = source.file.size > profile.maxFileBytes;

  // ───── open the chosen video: validate size, then let the browser read its metadata ─────
  useEffect(() => {
    let alive = true;
    const u = URL.createObjectURL(source.file);
    setSrcUrl(u); setDuration(0); setDims(null); setInfo(null); setLoadError(null); setResult(null); setSaved(null); setThumb(null); setThumbSaved(null); setProcError(null);
    if (source.file.size > profile.maxFileBytes) {
      setLoadError(`This video is ${(source.file.size / 1048576).toFixed(1)} MB. ${profile.mobile ? "On a phone" : "In the browser"} the limit for editing is ${profile.maxFileBytes / 1048576} MB. Trim or compress it on a computer first, or choose a smaller file.`);
    } else {
      loadVideoElement(u).then((v) => {
        if (!alive) return;
        const d = v.duration;
        if (!isFinite(d) || d <= 0) { setLoadError("This video has no readable length, so it can't be edited."); return; }
        setDuration(d); setDims({ w: v.videoWidth, h: v.videoHeight });
        restart({ ...initial, segments: [{ start: 0, end: d }] });
      }).catch((e: unknown) => { if (alive) setLoadError(e instanceof VideoError ? e.message : "This video couldn't be opened."); });
    }
    return () => { alive = false; URL.revokeObjectURL(u); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source]);

  useEffect(() => () => { ctl.current?.abort(); engine.current?.dispose(); }, []);
  useEffect(() => { if (!active) videoRef.current?.pause(); }, [active]);
  useEffect(() => () => { if (result) URL.revokeObjectURL(result.url); }, [result]);
  useEffect(() => () => { if (thumb) URL.revokeObjectURL(thumb.url); }, [thumb]);

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

  const key = JSON.stringify(st);
  const stale = !!result && result.key !== key;
  const segs = st.segments;
  const keptSeconds = segs.reduce((n, s) => n + Math.max(0, s.end - s.start), 0);
  let rangeProblem: string | null = null;
  if (duration) { try { validateSegments(segs, duration); } catch (e) { rangeProblem = e instanceof Error ? e.message : "Invalid range."; } }

  const setSegs = (fn: (s: Segment[]) => Segment[], k?: string) => set((s) => ({ ...s, segments: fn(s.segments) }), k);
  const seek = (t: number) => { const v = videoRef.current; if (v) v.currentTime = t; };
  const playhead = () => videoRef.current?.currentTime ?? now;

  const setStart = (i: number, v: number) => setSegs((a) => a.map((s, j) => (j === i ? { ...s, start: v } : s)), `s${i}`);
  const setEnd = (i: number, v: number) => setSegs((a) => a.map((s, j) => (j === i ? { ...s, end: v } : s)), `e${i}`);
  const split = () => {
    const t = playhead();
    const i = segs.findIndex((s) => t > s.start + MIN && t < s.end - MIN);
    if (i < 0) { toast("info", "Move the playhead inside a clip (at least 0.1 s from its edges) to split it."); return; }
    setSegs((a) => [...a.slice(0, i), { start: a[i].start, end: t }, { start: t, end: a[i].end }, ...a.slice(i + 1)]);
  };
  const addClip = () => {
    const t = playhead();
    const start = Math.min(t, Math.max(0, duration - 1));
    setSegs((a) => [...a, { start, end: Math.min(duration, start + Math.max(1, Math.min(5, duration - start))) }]);
  };
  const removeClip = (i: number) => setSegs((a) => (a.length > 1 ? a.filter((_, j) => j !== i) : a));

  // ───── process / export ─────
  const process = async () => {
    setProcError(null); setSaved(null); setProgress(0);
    if (result) { URL.revokeObjectURL(result.url); setResult(null); }
    const c = new AbortController(); ctl.current = c;
    const eng = engine.current!;
    try {
      const valid = validateSegments(segs, duration);
      if (!eng.ready) { setPhase("engine"); setEngineProgress(0); await eng.load(setEngineProgress); }
      if (c.signal.aborted) throw new VideoError("cancelled", "Cancelled.");
      setPhase("working");
      let i = info;
      if (!i) { i = await eng.probe(source.file); setInfo(i); }
      const r = await eng.export(source.file, i, i.height, { ...st, segments: valid }, { onProgress: setProgress, signal: c.signal });
      setResult({ r, key, url: URL.createObjectURL(r.blob) });
    } catch (e) {
      if (e instanceof VideoError && e.code === "cancelled") toast("info", "Processing cancelled.");
      else setProcError(e instanceof Error ? e.message : "Processing failed.");
    } finally { setPhase("idle"); ctl.current = null; }
  };
  const cancel = () => { ctl.current?.abort(); };

  const baseName = source.record?.original_name ?? source.file.name;
  const outName = () => editedName(baseName, "mp4", "edited");
  const download = () => { if (result) { downloadBlob(result.r.blob, outName()); toast("success", `Download started: ${outName()}`); } };
  const save = async () => {
    if (!result || !info) return;
    setSaving(true); setSaveProgress(0); setSaved(null);
    try {
      const { name } = await saveEditedCopy({
        blob: result.r.blob, ext: "mp4", mime: "video/mp4", category: "video", originalName: baseName, sourceId: source.record?.id ?? null, kind: "video",
        params: describeVideoOps(st, info, { bytes: result.r.blob.size, mode: result.r.mode }), onProgress: setSaveProgress, signal: new AbortController().signal,
      });
      setSaved(name); toast("success", `Saved "${name}" to your workspace.`);
    } catch (e) { toast("error", e instanceof EditingError || e instanceof Error ? e.message : "Couldn't save the video."); }
    finally { setSaving(false); }
  };

  // ───── thumbnails ─────
  const grab = async () => {
    const v = videoRef.current; if (!v) return;
    v.pause(); setThumbBusy(true); setThumbSaved(null);
    const t = v.currentTime;
    try {
      let blob: Blob;
      try { blob = await captureFrame(v, t, "image/jpeg", 0.92); }
      catch {
        // the browser can't decode this frame: fall back to ffmpeg
        const eng = engine.current!;
        if (!eng.ready) { setPhase("engine"); await eng.load(setEngineProgress); setPhase("idle"); }
        let i = info; if (!i) { i = await eng.probe(source.file); setInfo(i); }
        blob = await eng.frameToJpeg(source.file, i, t);
      }
      setThumb({ blob, url: URL.createObjectURL(blob), time: t });
    } catch (e) { toast("error", e instanceof Error ? e.message : "Couldn't capture that frame."); setPhase("idle"); }
    finally { setThumbBusy(false); }
  };
  const thumbName = () => editedName(baseName, "jpg", `thumb-${Math.round((thumb?.time ?? 0) * 10) / 10}s`);
  const saveThumb = async () => {
    if (!thumb) return;
    setThumbBusy(true);
    try {
      const { name } = await saveEditedCopy({
        blob: thumb.blob, ext: "jpg", mime: "image/jpeg", category: "image", originalName: baseName, sourceId: source.record?.id ?? null, kind: "thumbnail",
        params: { kind: "thumbnail", atSeconds: +thumb.time.toFixed(3) }, suffix: `thumb-${Math.round(thumb.time * 10) / 10}s`, onProgress: () => {}, signal: new AbortController().signal,
      });
      setThumbSaved(name); toast("success", `Saved "${name}" to your workspace.`);
    } catch (e) { toast("error", e instanceof Error ? e.message : "Couldn't save the thumbnail."); }
    finally { setThumbBusy(false); }
  };

  // ───── render ─────
  if (loadError) return <div className="panel card"><div className="empty" role="alert"><h3>This video can't be edited</h3><p>{loadError}</p><button className="btn btn-primary btn-md" onClick={onReplace}><span>Choose another video</span></button></div></div>;
  if (!srcUrl || !duration || !dims) return <div className="panel card"><div className="st-center" style={{ padding: 48 }}><Spinner size={34} label="Opening video" />{tooBig ? null : <video src={srcUrl ?? undefined} style={{ display: "none" }} />}</div></div>;

  const sizeDelta = result ? Math.round((1 - result.r.blob.size / source.file.size) * 100) : 0;
  const longWarn = duration / 60 > profile.maxMinutesComfortable;
  const canGo = !busy && !rangeProblem;

  return (
    <div className="st-layout">
      <section className="panel card st-preview" aria-label="Video preview">
        <div className="st-bar">
          <div className="st-group" role="toolbar" aria-label="History">
            <button className="btn btn-ghost btn-sm" onClick={undo} disabled={!canUndo || busy}><span>Undo</span></button>
            <button className="btn btn-ghost btn-sm" onClick={redo} disabled={!canRedo || busy}><span>Redo</span></button>
            <button className="btn btn-ghost btn-sm" onClick={reset} disabled={!(canUndo) || busy}><span>Reset all</span></button>
          </div>
          <span className="st-muted" aria-live="polite">{formatClock(now)} / {formatClock(duration)}</span>
        </div>
        <div className="st-videowrap">
          <video ref={videoRef} src={srcUrl} controls playsInline preload="metadata" className="st-video" data-testid="source-video"
            onTimeUpdate={(e) => setNow(e.currentTarget.currentTime)} onSeeked={(e) => setNow(e.currentTarget.currentTime)} />
        </div>
        <dl className="st-facts">
          <div><dt>Original</dt><dd>{dims.w} × {dims.h} · {formatClock(duration)} · {formatBytes(source.file.size)}</dd></div>
          <div><dt>Kept</dt><dd data-testid="kept">{formatClock(keptSeconds)} in {segs.length} clip{segs.length === 1 ? "" : "s"}</dd></div>
        </dl>
        {longWarn && <p className="st-note">This video is long for {profile.mobile ? "a phone" : "the browser"}. Processing may be slow, and shorter clips are safer.</p>}

        <div className="st-thumbs">
          <div className="st-thumbs-head">
            <h3>Thumbnail</h3>
            <button className="btn btn-ghost btn-sm" onClick={grab} disabled={thumbBusy || busy} data-testid="grab"><span>{thumbBusy ? "Capturing…" : `Capture frame at ${formatClock(now)}`}</span></button>
          </div>
          {thumb && (
            <div className="st-result" data-testid="thumb-result">
              <img src={thumb.url} alt={`Frame at ${formatClock(thumb.time)}`} className="st-thumb" />
              <div className="st-btnrow">
                <button className="btn btn-ghost btn-sm" onClick={() => downloadBlob(thumb.blob, thumbName())}><span>Download JPG</span></button>
                <button className="btn btn-ghost btn-sm" onClick={saveThumb} disabled={thumbBusy}><span>Save to workspace</span></button>
              </div>
              {thumbSaved && <p className="st-good" role="status">Saved as “{thumbSaved}”.</p>}
            </div>
          )}
        </div>
      </section>

      <aside className="st-side" aria-label="Video editing controls">
        <section className="panel card st-card">
          <h2>Trim &amp; cut</h2>
          <p className="st-muted">Keep one range to trim, or several to cut parts out. They're joined in order.</p>
          <ul className="st-segs">
            {segs.map((s, i) => (
              <li key={i} className="st-seg" data-testid="segment">
                <span className="st-seg-n">Clip {i + 1}</span>
                <TimeInput label="Start" value={s.start} max={duration} onCommit={(v) => setStart(i, v)} />
                <TimeInput label="End" value={s.end} max={duration} onCommit={(v) => setEnd(i, v)} />
                <div className="st-seg-actions">
                  <button className="st-mini" onClick={() => setStart(i, Math.min(playhead(), s.end - MIN))} disabled={busy} title="Set start to playhead">Start ← now</button>
                  <button className="st-mini" onClick={() => setEnd(i, Math.max(playhead(), s.start + MIN))} disabled={busy} title="Set end to playhead">End ← now</button>
                  <button className="st-mini" onClick={() => seek(s.start)}>Go to start</button>
                  {segs.length > 1 && <button className="st-mini" onClick={() => removeClip(i)} disabled={busy} aria-label={`Remove clip ${i + 1}`}>Remove</button>}
                </div>
              </li>
            ))}
          </ul>
          <div className="st-btnrow">
            <button className="btn btn-ghost btn-sm" onClick={split} disabled={busy} data-testid="split"><span>Split at playhead</span></button>
            <button className="btn btn-ghost btn-sm" onClick={addClip} disabled={busy}><span>Add clip</span></button>
          </div>
          {rangeProblem && <p className="st-err" role="alert">{rangeProblem}</p>}
        </section>

        <section className="panel card st-card">
          <h2>Export settings</h2>
          <div className="chips" role="group" aria-label="Output quality">
            {(Object.keys(QUALITY) as QualityPreset[]).map((q) => (
              <button key={q} className={`chip-btn ${st.quality === q ? "on" : ""}`} aria-pressed={st.quality === q} onClick={() => set((s) => ({ ...s, quality: q }))} disabled={busy}>{QUALITY[q].label}</button>
            ))}
          </div>
          <p className="st-note">{QUALITY[st.quality].hint}</p>
          <label className="st-num"><span>Maximum height</span>
            <select value={st.maxHeight} onChange={(e) => set((s) => ({ ...s, maxHeight: Number(e.target.value) }))} disabled={busy}>
              {RESOLUTIONS.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
            </select>
          </label>
          <label className="st-check"><input type="checkbox" checked={st.removeAudio} onChange={(e) => set((s) => ({ ...s, removeAudio: e.target.checked }))} disabled={busy} /><span>Remove audio</span></label>
          <label className="st-check"><input type="checkbox" checked={st.trimMode === "fast"} onChange={(e) => set((s) => ({ ...s, trimMode: e.target.checked ? "fast" : "precise" }))} disabled={busy} /><span>Fast trim (no re-encode; may start up to a few seconds early)</span></label>

          {!busy && <button className="btn btn-primary btn-md st-wide" onClick={process} disabled={!canGo} data-testid="process"><span>{result && !stale ? "Export again" : "Export video"}</span></button>}
          {phase === "engine" && <ProgressBar value={engineProgress} label="Downloading the video engine (one time, about 31 MB)" />}
          {phase === "working" && <ProgressBar value={progress} label="Processing video" />}
          {busy && <button className="btn btn-ghost btn-sm" onClick={cancel}><span>Cancel</span></button>}
          {procError && <p className="st-err" role="alert">{procError}</p>}

          {result && (
            <div className={`st-result ${stale ? "is-stale" : ""}`} data-testid="result">
              <video src={result.url} controls playsInline preload="metadata" className="st-video st-video-sm" data-testid="result-video" />
              <div className="st-result-meta">
                <b>MP4 · {formatBytes(result.r.blob.size)} · {result.r.mode === "copy" ? "fast trim" : "re-encoded"} · {(result.r.ms / 1000).toFixed(1)} s</b>
                <span className={sizeDelta > 0 ? "st-good" : "st-muted"}>{sizeDelta > 0 ? `${sizeDelta}% smaller than the original` : sizeDelta < 0 ? `${Math.abs(sizeDelta)}% larger than the original` : "Same size as the original"}</span>
                {stale && <span className="st-warn">Settings changed. Export again to update this file.</span>}
              </div>
              <div className="st-btnrow">
                <button className="btn btn-primary btn-sm" onClick={download} disabled={stale || saving} data-testid="download"><span>Download</span></button>
                <button className="btn btn-ghost btn-sm" onClick={save} disabled={stale || saving} data-testid="save"><span>{saving ? "Saving…" : "Save to workspace"}</span></button>
              </div>
              {saving && <ProgressBar value={saveProgress} label="Saving to your workspace" />}
              {saved && <p className="st-good" role="status" data-testid="saved">Saved as “{saved}”. <Link className="link" to="/workspace">View in workspace</Link></p>}
              <p className="st-muted">Your original video is never changed. Edits create a new copy.</p>
            </div>
          )}
        </section>
      </aside>
    </div>
  );
}
