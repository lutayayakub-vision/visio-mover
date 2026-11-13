import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import AuthShell from "../../components/auth/AuthShell";
import TextField from "../../components/auth/TextField";
import Spinner from "../../components/ui/Spinner";
import { supabase, siteUrl } from "../../lib/supabase";
import { isValidEmail, normalizeEmail } from "../../auth/validation";
import { friendlyAuthError } from "../../auth/errors";

export default function ForgotPassword() {
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    const clean = normalizeEmail(email);
    if (!isValidEmail(clean)) { setError("Enter a valid email address."); return; }
    setError(undefined);
    setBusy(true);
    const { error: err } = await supabase.auth.resetPasswordForEmail(clean, { redirectTo: `${siteUrl}/reset-password` });
    setBusy(false);
    // Same response whether or not the account exists, to avoid revealing who has an account.
    if (err && (err as { status?: number }).status === 429) { setError(friendlyAuthError(err)); return; }
    setSent(true);
  };

  if (sent) {
    return (
      <AuthShell title="Check your email" subtitle="Password reset requested.">
        <div className="success-panel" role="status">
          <p>If an account exists for <b>{normalizeEmail(email)}</b>, a reset link is on its way. The link expires, and can only be used once.</p>
        </div>
        <Link to="/login" className="btn btn-primary btn-lg auth-submit"><span>Back to login</span></Link>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="Forgot your password?" subtitle="Enter your email and we'll send a reset link."
      footer={<Link to="/login">Back to login</Link>}>
      <form onSubmit={submit} noValidate className="auth-form">
        <TextField label="Email address" type="email" value={email} onChange={setEmail} autoComplete="email" error={error} disabled={busy} />
        <button className="btn btn-primary btn-lg auth-submit" type="submit" disabled={busy}>
          <span>{busy ? <><Spinner size={18} /> Sending…</> : "Send reset link"}</span>
        </button>
      </form>
    </AuthShell>
  );
}
