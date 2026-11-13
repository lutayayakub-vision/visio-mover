import { useEffect, useState } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import Logo from "../layout/Logo";
import Avatar from "./Avatar";
import { useAuth } from "../../auth/AuthContext";
import { useToast } from "../ui/Toast";

const nav = [
  { to: "/dashboard", label: "Dashboard", icon: "M4 13h7V4H4zM13 20h7v-9h-7zM13 4v5h7V4zM4 20h7v-5H4z" },
  { to: "/image-editor", label: "Image Editor", icon: "M3 4h18v16H3zM3 16l5-5 4 4 3-3 6 6M9 9a1 1 0 1 0 0 .01" },
  { to: "/video-editor", label: "Video Editor", icon: "M3 6h12v12H3zM15 10l6-3v10l-6-3" },
  { to: "/document-editor", label: "Document Editor", icon: "M7 3h8l4 4v14H7zM15 3v4h4M10 12h6M10 16h6" },
  { to: "/projects", label: "My Projects", icon: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" },
  { to: "/settings", label: "Settings", icon: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19 12a7 7 0 0 0-.1-1.2l2-1.5-2-3.4-2.3 1a7 7 0 0 0-2-1.2L14.2 3h-4l-.4 2.7a7 7 0 0 0-2 1.2l-2.3-1-2 3.4 2 1.5A7 7 0 0 0 5 12c0 .4 0 .8.1 1.2l-2 1.5 2 3.4 2.3-1a7 7 0 0 0 2 1.2l.4 2.7h4l.4-2.7a7 7 0 0 0 2-1.2l2.3 1 2-3.4-2-1.5c.1-.4.1-.8.1-1.2z" },
];

export default function AppLayout() {
  const { user, profile, signOut } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const loc = useLocation();
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => { setOpen(false); }, [loc.pathname]);

  const name = profile?.full_name || user?.email?.split("@")[0] || "there";

  const logout = async () => {
    await signOut("local");
    setConfirming(false);
    toast("success", "You have been logged out.");
    navigate("/", { replace: true });
  };

  return (
    <div className="shell">
      <aside className={`side ${open ? "open" : ""}`} aria-label="App navigation">
        <div className="side-top"><Logo /></div>
        <nav>
          {nav.map((n) => (
            <NavLink key={n.to} to={n.to} className={({ isActive }) => `side-link ${isActive ? "active" : ""}`}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={n.icon} /></svg>
              {n.label}
            </NavLink>
          ))}
          <Link to="/support" className="side-link">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1 .9-1 1.7M12 17v.01" /></svg>
            Help and Support
          </Link>
        </nav>
        <div className="side-user">
          <Avatar name={name} url={profile?.avatar_url} />
          <div className="side-user-meta">
            <b>{name}</b>
            <span title={user?.email}>{user?.email}</span>
          </div>
        </div>
      </aside>
      {open && <button className="scrim" aria-label="Close menu" onClick={() => setOpen(false)} />}

      <div className="main">
        <header className="topbar">
          <button className="burger-app" aria-label="Open menu" aria-expanded={open} onClick={() => setOpen(true)}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16" /></svg>
          </button>
          <span className="topbar-title">Your private workspace</span>
          <button className="btn btn-ghost btn-md" onClick={() => setConfirming(true)}><span>Log out</span></button>
        </header>
        <div className="content"><Outlet /></div>
      </div>

      {confirming && (
        <div className="modal-back" role="presentation" onClick={() => setConfirming(false)}>
          <div className="modal card" role="dialog" aria-modal="true" aria-labelledby="lo-title" onClick={(e) => e.stopPropagation()}>
            <h3 id="lo-title">Log out of VISIOMOVER?</h3>
            <p>You'll need to log in again to access your workspace.</p>
            <div className="modal-actions">
              <button className="btn btn-ghost btn-md" onClick={() => setConfirming(false)} autoFocus><span>Cancel</span></button>
              <button className="btn btn-primary btn-md" onClick={logout}><span>Log out</span></button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
