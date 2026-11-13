import { Link } from "react-router-dom";
import { useAuth } from "../../auth/AuthContext";

const entries = [
  { to: "/image-editor", label: "Images", types: "JPG · PNG · WEBP", stage: "Stage 4", icon: "M3 4h18v16H3zM3 16l5-5 4 4 3-3 6 6M9 9a1 1 0 1 0 0 .01" },
  { to: "/video-editor", label: "Videos", types: "MP4 · MOV · WEBM", stage: "Stage 5", icon: "M3 6h12v12H3zM15 10l6-3v10l-6-3" },
  { to: "/document-editor", label: "Documents", types: "PDF · DOCX · PPTX", stage: "Stage 6", icon: "M7 3h8l4 4v14H7zM15 3v4h4M10 12h6M10 16h6" },
];

export default function Dashboard() {
  const { profile, user } = useAuth();
  const first = (profile?.full_name || user?.email?.split("@")[0] || "there").split(" ")[0];

  return (
    <>
      <div className="page-head">
        <h1>Welcome, <span className="gradient-text">{first}</span></h1>
        <p>Your workspace is ready. Uploading and editing arrive in the next stages.</p>
      </div>

      <section className="panel card" aria-labelledby="up-h">
        <div className="panel-head"><h2 id="up-h">Upload workspace</h2><span className="badge soon">Opens in later stages</span></div>
        <p className="muted">Choose where you'll start. Private file storage and the editors are not built yet, so these open placeholders.</p>
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

      <section className="panel card" aria-labelledby="rp-h">
        <div className="panel-head"><h2 id="rp-h">Recent projects</h2><Link to="/projects" className="small-link">View all</Link></div>
        <div className="empty">
          <svg width="52" height="52" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>
          <h3>No projects yet</h3>
          <p>When you upload your first file, it will appear here.</p>
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
