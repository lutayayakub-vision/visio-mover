import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../../auth/AuthContext";
import { supabase } from "../../lib/supabase";
import { cleanName } from "../../auth/validation";
import TextField from "../../components/auth/TextField";
import Spinner from "../../components/ui/Spinner";
import { useToast } from "../../components/ui/Toast";
import Avatar from "../../components/app/Avatar";

export default function Settings() {
  const { user, profile, refreshProfile, signOut } = useAuth();
  const toast = useToast();
  const nav = useNavigate();
  const [name, setName] = useState("");
  const [err, setErr] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [busyAll, setBusyAll] = useState(false);

  useEffect(() => { setName(profile?.full_name ?? ""); }, [profile?.full_name]);

  const save = async (ev: FormEvent) => {
    ev.preventDefault();
    const clean = cleanName(name);
    if (clean.length < 2) { setErr("Name must be at least 2 characters."); return; }
    if (!user) return;
    setErr(undefined);
    setBusy(true);
    // Only full_name is sent. The database also refuses changes to any other column or any other user's row.
    const { error, data } = await supabase.from("profiles").update({ full_name: clean }).eq("id", user.id).select("id");
    setBusy(false);
    if (error || !data?.length) { toast("error", "Couldn't save your changes. Please try again."); return; }
    await refreshProfile();
    toast("success", "Profile updated.");
  };

  const logoutAll = async () => {
    setBusyAll(true);
    await signOut("global");
    toast("success", "Signed out of all devices.");
    nav("/", { replace: true });
  };

  const created = profile?.created_at ? new Date(profile.created_at).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" }) : "—";

  return (
    <>
      <div className="page-head"><h1>Account settings</h1><p>Manage your profile and sessions.</p></div>

      <section className="panel card">
        <div className="panel-head"><h2>Profile</h2></div>
        <div className="profile-row">
          <Avatar name={profile?.full_name || user?.email || "?"} size={64} />
          <dl className="kv">
            <div><dt>Email</dt><dd>{user?.email}</dd></div>
            <div><dt>Member since</dt><dd>{created}</dd></div>
          </dl>
        </div>
        <form onSubmit={save} noValidate className="auth-form narrow">
          <TextField label="Full name" value={name} onChange={setName} autoComplete="name" error={err} maxLength={80} disabled={busy} />
          <button className="btn btn-primary btn-md" type="submit" disabled={busy || cleanName(name) === (profile?.full_name ?? "")}>
            <span>{busy ? <><Spinner size={16} /> Saving…</> : "Save changes"}</span>
          </button>
        </form>
        <p className="muted small">Profile pictures arrive with private file storage in Stage 3.</p>
      </section>

      <section className="panel card">
        <div className="panel-head"><h2>Sessions</h2></div>
        <p className="muted">Signed in somewhere you don't recognise, or on a shared device? End every session.</p>
        <button className="btn btn-ghost btn-md" onClick={logoutAll} disabled={busyAll}><span>{busyAll ? "Signing out…" : "Sign out of all devices"}</span></button>
      </section>
    </>
  );
}
