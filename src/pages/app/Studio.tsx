import { useCallback, useEffect, useRef, useState } from "react";
import { Link, Outlet, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { useToast } from "../../components/ui/Toast";
import ImageEditor from "../../components/studio/ImageEditor";
import VideoEditor from "../../components/studio/VideoEditor";
import { MediaPicker, ProgressBar, type Source } from "../../components/studio/common";
import { fetchOriginal } from "../../lib/editing";
import { supabase } from "../../lib/supabase";
import { type Category, type FileRecord } from "../../lib/files";

type Tool = "image" | "video";
const COPY: Record<Tool, { title: string; accept: string; hint: string; formats: string }> = {
  image: { title: "Image Editor", accept: ".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp", hint: "Crop, resize, rotate, flip, adjust colour, compress and convert between JPG, PNG and WEBP, and remove unwanted objects.", formats: "JPG, PNG or WEBP" },
  video: { title: "Video Editor", accept: ".mp4,.mov,.webm,video/mp4,video/quicktime,video/webm", hint: "Trim, cut, compress and export your videos, and capture thumbnails. Processing happens on your device.", formats: "MP4, MOV or WEBM" },
};

function Chooser({ tool, onFile, onPick, busy }: { tool: Tool; onFile: (f: File) => void; onPick: () => void; busy: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const c = COPY[tool];
  return (
    <section className="panel card">
      <div className={`dropzone st-drop ${over ? "over" : ""}`}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); const f = e.dataTransfer.files?.[0]; if (f) onFile(f); }}>
        <h3>Open a {tool}</h3>
        <p>{c.formats}. Your original is never changed; edits are saved as new copies.</p>
        <div className="st-btnrow st-center">
          <button className="btn btn-primary btn-md" onClick={() => input.current?.click()} disabled={busy}><span>From this device</span></button>
          <button className="btn btn-ghost btn-md" onClick={onPick} disabled={busy}><span>From my workspace</span></button>
        </div>
        <input ref={input} type="file" hidden accept={c.accept} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) onFile(f); }} />
      </div>
    </section>
  );
}

export default function Studio() {
  const { pathname } = useLocation();
  const tool: Tool = pathname.startsWith("/video") ? "video" : "image";
  const nav = useNavigate();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const [sources, setSources] = useState<Record<Tool, Source | null>>({ image: null, video: null });
  const [picker, setPicker] = useState<Tool | null>(null);
  const [loading, setLoading] = useState<{ name: string; p: number } | null>(null);
  const [notFound, setNotFound] = useState<string | null>(null);
  const ctl = useRef<AbortController | null>(null);
  const fileId = params.get("file");

  const setSource = (t: Tool, s: Source | null) => setSources((p) => ({ ...p, [t]: s }));

  const openRecord = useCallback(async (rec: FileRecord) => {
    const t: Tool | null = rec.category === "image" ? "image" : rec.category === "video" ? "video" : null;
    if (!t) { toast("error", "Only images and videos can be edited here."); return; }
    ctl.current?.abort();
    const c = new AbortController(); ctl.current = c;
    setNotFound(null); setLoading({ name: rec.original_name, p: 0 });
    try {
      const file = await fetchOriginal(rec, (p) => setLoading({ name: rec.original_name, p }), c.signal);
      setSource(t, { file, record: rec });
      if (t !== tool) nav(`/${t}-editor`, { replace: true });
    } catch (e) {
      if (!c.signal.aborted) toast("error", e instanceof Error ? e.message : "Couldn't open that file.");
    } finally { setLoading(null); }
  }, [nav, tool, toast]);

  // ?file=<id>: row-level security means only the signed-in owner's rows come back; anything else is "not found"
  useEffect(() => {
    if (!fileId) return;
    let alive = true;
    (async () => {
      const { data, error } = await supabase.from("files").select("id, owner_id, storage_path, original_name, category, mime_type, size_bytes, created_at, source_file_id, edit_kind").eq("id", fileId).maybeSingle();
      if (!alive) return;
      setParams((p) => { p.delete("file"); return p; }, { replace: true });
      if (error || !data) { setNotFound("That file wasn't found in your workspace."); return; }
      void openRecord(data as FileRecord);
    })();
    return () => { alive = false; };
  }, [fileId, openRecord, setParams]);

  useEffect(() => () => ctl.current?.abort(), []);

  const onDeviceFile = (t: Tool) => (f: File) => { setNotFound(null); setSource(t, { file: f, record: null }); };
  const c = COPY[tool];

  return (
    <>
      <div className="page-head">
        <h1>{c.title.split(" ")[0]} <span className="gradient-text">{c.title.split(" ")[1]}</span></h1>
        <p>{c.hint}</p>
      </div>

      <div className="st-tabs" role="tablist" aria-label="Editor type">
        {(["image", "video"] as Tool[]).map((t) => (
          <Link key={t} to={`/${t}-editor`} role="tab" aria-selected={tool === t} className={`st-tab ${tool === t ? "on" : ""}`} replace>{t === "image" ? "Image" : "Video"}</Link>
        ))}
      </div>

      {notFound && <p className="st-err" role="alert">{notFound}</p>}
      {loading && (
        <section className="panel card st-loading" aria-live="polite">
          <ProgressBar value={loading.p} label={`Opening “${loading.name}” from your workspace`} />
          <button className="btn btn-ghost btn-sm" onClick={() => ctl.current?.abort()}><span>Cancel</span></button>
        </section>
      )}

      {(["image", "video"] as Tool[]).map((t) => {
        const s = sources[t];
        const visible = tool === t && !loading;
        return (
          <div key={t} hidden={!visible} data-tool={t}>
            {s ? (
              <>
                <div className="st-file">
                  <span className="st-file-name" title={s.file.name}>{s.record?.original_name ?? s.file.name}</span>
                  <span className="st-muted">{s.record ? "from your workspace" : "from this device"}</span>
                  <button className="btn btn-ghost btn-sm" onClick={() => setSource(t, null)}><span>Close</span></button>
                </div>
                {t === "image"
                  ? <ImageEditor source={s} active={tool === t} onReplace={() => setSource(t, null)} />
                  : <VideoEditor source={s} active={tool === t} onReplace={() => setSource(t, null)} />}
              </>
            ) : <Chooser tool={t} onFile={onDeviceFile(t)} onPick={() => setPicker(t)} busy={!!loading} />}
          </div>
        );
      })}

      {picker && <MediaPicker category={picker as Category} onClose={() => setPicker(null)} onPick={(r) => { setPicker(null); void openRecord(r); }} />}
      <Outlet />
    </>
  );
}
