import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import AuthShell from "../../components/auth/AuthShell";
import PasswordField from "../../components/auth/PasswordField";
import Spinner from "../../components/ui/Spinner";
import { useAuth } from "../../auth/AuthContext";
import { supabase } from "../../lib/supabase";
import { checkPassword } from "../../auth/validation";
import { friendlyAuthError } from "../../auth/errors";

export default function ResetPassword() {
  const { session, loading, recovering } = useAuth();
  const nav = useNavigate();
  const [pw, setPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [errors, setErrors] = useState<{ pw?: string; confirm?: string; form?: string }>({});
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [waited, setWaited] = useState(false);

  // Give the PKCE code exchange a moment before declaring the link invalid
  useEffect(() => { const t = setTimeout(() => setWaited(true), 2500); return () => clearTimeout(t); }, []);

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    const e: typeof errors = {};
    if (!checkPassword(pw).valid) e.pw = "Choose a stronger password that meets every requirement below.";
    if (confirm !== pw) e.confirm = "Passwords do not match.";
    setErrors(e);
    if (Object.keys(e).length) return;
    setBusy(true);
    const { error } = await supabase.auth.updateUser({ password: pw });
    if (error) { setBusy(false); setErrors({ form: friendlyAuthError(error) }); return; }
    // End the recovery session everywhere so the user logs in fresh with the new password
    await supabase.auth.signOut({ scope: "global" });
    setBusy(false);
    setDone(true);
  };

  if (done) {
    return (
      <AuthShell title="Password updated" subtitle="Your password was changed successfully.">
        <div className="success-panel" role="status"><p>For your security you've been signed out of all devices. Log in with your new password.</p></div>
        <button className="btn btn-primary btn-lg auth-submit" onClick={() => nav("/login", { replace: true })}><span>Go to login</span></button>
      </AuthShell>
    );
  }

  if (loading || (!session && !waited)) {
    return <AuthShell title="Verifying link…"><div className="center"><Spinner size={34} label="Verifying reset link" /></div></AuthShell>;
  }

  if (!session) {
    return (
      <AuthShell title="Link invalid or expired" subtitle="This reset link can't be used.">
        <Link to="/forgot-password" className="btn btn-primary btn-lg auth-submit"><span>Request a new link</span></Link>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="Choose a new password" subtitle={recovering ? "Make it strong and unique." : "You're signed in; set a new password below."}>
      <form onSubmit={submit} noValidate className="auth-form">
        {errors.form && <p className="notice error" role="alert">{errors.form}</p>}
        <PasswordField label="New password" value={pw} onChange={setPw} autoComplete="new-password" error={errors.pw} showStrength disabled={busy} />
        <PasswordField label="Confirm new password" value={confirm} onChange={setConfirm} autoComplete="new-password" error={errors.confirm} disabled={busy} />
        <button className="btn btn-primary btn-lg auth-submit" type="submit" disabled={busy}>
          <span>{busy ? <><Spinner size={18} /> Updating…</> : "Update password"}</span>
        </button>
      </form>
    </AuthShell>
  );
}
