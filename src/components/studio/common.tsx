import { useEffect, useRef, useState } from "react";
import Spinner from "../ui/Spinner";
import { listFiles, formatBytes, formatDate, type Category, type FileRecord } from "../../lib/files";
import FileIcon from "../workspace/FileIcon";

export type Source = { file: File; record: FileRecord | null };

export function ProgressBar({ value, label, tone }: { value: number; label: string; tone?: "warn" }) {
  const pct = Math.max(0, Math.min(100, Math.round(value * 100)));
  return (
    <div className="st-progress">
      <div className="st-progress-top"><span>{label}</span><b>{pct}%</b></div>
      <div className={`bar ${tone === "warn" ? "warn" : ""}`} role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}><i style={{ width: `${pct}%` }} /></div>
    </div>
  );
}

export function Slider({ label, value, min, max, step = 1, unit = "", onChange, onReset, disabled, id }: {
  label: string; value: number; min: number; max: number; step?: number; unit?: string; id: string;
  onChange: (v: number) => void; onReset?: () => void; disabled?: boolean;
}) {
  return (
    <div className="st-field">
      <div className="st-field-top">
        <label htmlFor={id}>{label}</label>
        <span className="st-val">
          <output htmlFor={id}>{value > 0 && min < 0 ? "+" : ""}{value}{unit}</output>
          {onReset && value !== 0 && <button type="button" className="st-mini" onClick={onReset} aria-label={`Reset ${label}`}>Reset</button>}
        </span>
      </div>
      <input id={id} type="range" min={min} max={max} step={step} value={value} disabled={disabled} onChange={(e) => onChange(Number(e.target.value))} />
    </div>
  );
}

/** Modal list of the signed-in user's own files (RLS limits the query to them) so one can be opened for editing. */
export function MediaPicker({ category, onPick, onClose }: { category: Category; onPick: (rec: FileRecord) => void; onClose: () => void }) {
  const [rows, setRows] = useState<FileRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [term, setTerm] = useState("");
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => { const t = setTimeout(() => setTerm(q), 250); return () => clearTimeout(t); }, [q]);
  useEffect(() => {
    let alive = true;
    setLoading(true); setErr(null);
    listFiles({ search: term, category, sort: "newest", from: 0, to: 11 })
      .then((r) => { if (alive) { setRows(r.rows); setTotal(r.total); } })
      .catch((e: Error) => { if (alive) setErr(e.message); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [term, category]);
  useEffect(() => {
    closeRef.current?.focus();
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);

  const loadMore = async () => {
    setMore(true);
    try { const r = await listFiles({ search: term, category, sort: "newest", from: rows.length, to: rows.length + 11 }); setRows((p) => [...p, ...r.rows.filter((x) => !p.some((y) => y.id === x.id))]); setTotal(r.total); }
    catch (e) { setErr(e instanceof Error ? e.message : "Couldn't load more."); }
    finally { setMore(false); }
  };

  return (
    <div className="modal-back" role="presentation" onClick={onClose}>
      <div className="modal card st-picker" role="dialog" aria-modal="true" aria-labelledby="pk-t" onClick={(e) => e.stopPropagation()}>
        <h3 id="pk-t">Choose a {category} from your workspace</h3>
        <input className="st-input" type="search" placeholder="Search by name" aria-label="Search your files" value={q} onChange={(e) => setQ(e.target.value)} maxLength={100} />
        <div className="st-picker-list" aria-busy={loading}>
          {loading && <div className="st-center"><Spinner size={26} label="Loading" /></div>}
          {err && <p role="alert" className="st-err">{err}</p>}
          {!loading && !err && rows.length === 0 && <p className="st-muted">{term ? "No matching files." : `You haven't uploaded any ${category}s yet. Upload one in the Upload Workspace, or open one from this device.`}</p>}
          <ul className="files">
            {!loading && rows.map((f) => (
              <li key={f.id}>
                <button type="button" className="frow st-pick" onClick={() => onPick(f)}>
                  <FileIcon category={f.category} />
                  <span className="f-main"><span className="f-name">{f.original_name}</span><span className="f-meta"><span>{formatBytes(f.size_bytes)}</span><span>{formatDate(f.created_at)}</span>{f.edit_kind && <span className="tag">EDITED</span>}</span></span>
                </button>
              </li>
            ))}
          </ul>
          {!loading && rows.length < total && <div className="more"><button className="btn btn-ghost btn-sm" onClick={loadMore} disabled={more}><span>{more ? "Loading…" : `Load more (${total - rows.length} left)`}</span></button></div>}
        </div>
        <div className="modal-actions"><button ref={closeRef} className="btn btn-ghost btn-md" onClick={onClose}><span>Close</span></button></div>
      </div>
    </div>
  );
}
