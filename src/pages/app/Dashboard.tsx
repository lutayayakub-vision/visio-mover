import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../../auth/AuthContext";
import FileIcon from "../../components/workspace/FileIcon";
import { QUOTA_BYTES, extOf, formatBytes, formatDate, getUsedBytes, listFiles, type FileRecord } from "../../lib/files";

const entries = [
  { to: "/image-editor", label: "Images", types: "JPG · PNG · WEBP", stage: "Ready", icon: "M3 4h18v16H3zM3 16l5-5 4 4 3-3 6 6M9 9a1 1 0 1 0 0 .01" },
  { to: "/video-editor", label: "Videos", types: "MP4 · MOV · WEBM", stage: "Ready", icon: "M3 6h12v12H3zM15 10l6-3v10l-6-3" },
  { to: "/document-editor", label: "Documents", types: "PDF · DOCX · PPTX", stage: "Stage 6", icon: "M7 3h8l4 4v14H7zM15 3v4h4M10 12h6M10 16h6" },
];

export default function Dashboard() {
  const { profile, user } = useAuth();
  const first = (profile?.full_name || user?.email?.split("@")[0] || "there").split(" ")[0];
  const [recent, setRecent] = useState<FileRecord[] | null>(null);
  const [total, setTotal] = useState(0);
  const [used, setUsed] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    listFiles({ search: "", category: "all", sort: "newest", from: 0, to: 2 })
      .then((r) => { if (alive) { setRecent(r.rows); setTotal(r.total); } })
      .catch(() => { if (alive) setFailed(true); });
    getUsedBytes().then((b) => { if (alive) setUsed(b); }).catch(() => undefined);
    return () => { alive = false; };
  }, []);

  const pct = used === null ? 0 : Math.min(100, (used / QUOTA_BYTES) * 100);

  return (
    <>
      <div className="page-head">
        <h1>Welcome, <span className="gradient-text">{first}</span></h1>
        <p>Your private workspace is ready. Upload files and manage them in one place.</p>
      </div>

      <section className="panel card" aria-labelledby="up-h">
        <div className="panel-head"><h2 id="up-h">Upload workspace</h2><Link to="/workspace" className="btn btn-primary btn-md"><span>Open workspace</span></Link></div>
        <p className="muted">Upload images, videos and documents. Only you can see, download or delete them.</p>
        <div className="usage">
          <div className="usage-top"><span>Storage used</span><b>{used === null ? "—" : `${formatBytes(used)} of ${formatBytes(QUOTA_BYTES)}`}</b></div>
          <div className="bar" role="progressbar" aria-label="Storage used" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)}><i style={{ width: `${pct}%` }} /></div>
        </div>
      </section>

      <section className="panel card" aria-labelledby="rp-h">
        <div className="panel-head"><h2 id="rp-h">Recent uploads{recent ? ` (${total})` : ""}</h2><Link to="/workspace" className="small-link">View all</Link></div>
        {recent === null && !failed && <p className="muted" aria-busy="true">Loading…</p>}
        {failed && <p className="muted" role="alert">Couldn't load your files. Open the workspace to retry.</p>}
        {recent && recent.length === 0 && (
          <div className="empty">
            <svg width="52" height="52" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>
            <h3>No uploads yet</h3>
            <p>When you upload your first file, it will appear here.</p>
            <Link to="/workspace" className="btn btn-primary btn-md"><span>Upload a file</span></Link>
          </div>
        )}
        {recent && recent.length > 0 && (
          <ul className="files">
            {recent.map((f) => (
              <li key={f.id} className="frow">
                <FileIcon category={f.category} />
                <div className="f-main">
                  <span className="f-name" title={f.original_name}>{f.original_name}</span>
                  <span className="f-meta"><span className={`tag tag-${f.category}`}>{extOf(f.original_name).toUpperCase()}</span><span>{formatBytes(f.size_bytes)}</span><span>{formatDate(f.created_at)}</span></span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel card" aria-labelledby="ed-h">
        <div className="panel-head"><h2 id="ed-h">Editors</h2><span className="badge soon">Documents coming in Stage 6</span></div>
        <p className="muted">Image and video editing run in your browser. The document editor is not built yet.</p>
        <div className="entry-grid">
          {entries.map((e) => (
            <Link key={e.to} to={e.to} className="entry">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={e.icon} /></svg>
              <b>{e.label}</b>
              <span>{e.types}</span>
              <em>{e.stage}</em>
            </Link>
          ))}
        </div>
      </section>

      <section className="panel card" aria-labelledby="ac-h">
        <div className="panel-head"><h2 id="ac-h">Account</h2><Link to="/settings" className="small-link">Account settings</Link></div>
        <dl className="kv">
          <div><dt>Name</dt><dd>{profile?.full_name || "—"}</dd></div>
          <div><dt>Email</dt><dd>{user?.email}</dd></div>
        </dl>
      </section>
    </>
  );
}
