import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import AuthShell from "../../components/auth/AuthShell";
import TextField from "../../components/auth/TextField";
import PasswordField from "../../components/auth/PasswordField";
import Spinner from "../../components/ui/Spinner";
import { supabase, siteUrl } from "../../lib/supabase";
import { checkPassword, cleanName, isValidEmail, normalizeEmail } from "../../auth/validation";
import { friendlyAuthError } from "../../auth/errors";
import { useResendVerification } from "../../auth/useResendVerification";
import { useToast } from "../../components/ui/Toast";

type Errors = Partial<Record<"name" | "email" | "password" | "confirm" | "terms" | "form", string>>;

export default function Register() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [terms, setTerms] = useState(false);
  const [errors, setErrors] = useState<Errors>({});
  const [busy, setBusy] = useState(false);
  const [doneEmail, setDoneEmail] = useState<string | null>(null);
  const rv = useResendVerification();
  const toast = useToast();

  const validate = (): Errors => {
    const e: Errors = {};
    const n = cleanName(name);
    if (n.length < 2) e.name = "Please enter your full name (at least 2 characters).";
    if (!isValidEmail(normalizeEmail(email))) e.email = "Enter a valid email address.";
    if (!checkPassword(password).valid) e.password = "Choose a stronger password that meets every requirement below.";
    if (confirm !== password) e.confirm = "Passwords do not match.";
    if (!terms) e.terms = "You must accept the Terms of Service and Privacy Policy.";
    return e;
  };

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    const e = validate();
    setErrors(e);
    if (Object.keys(e).length) return;
    setBusy(true);
    const clean = normalizeEmail(email);
    const { error } = await supabase.auth.signUp({
      email: clean,
      password,
      options: { data: { full_name: cleanName(name) }, emailRedirectTo: `${siteUrl}/auth/callback` },
    });
    setBusy(false);
    if (error) { setErrors({ form: friendlyAuthError(error) }); return; }
    // For an address that already exists, Supabase deliberately returns a normal-looking response (prevents account enumeration)
    // and no new account is created, so we show the same confirmation either way.
    setDoneEmail(clean);
  };

  const resendNow = async () => {
    if (!doneEmail || !rv.canResend) return;
    const r = await rv.resend(doneEmail);
    toast(r.ok ? "success" : "error", r.message);
  };

  if (doneEmail) {
    return (
      <AuthShell title="Check your email" subtitle="One more step to activate your account.">
        <div className="success-panel" role="status">
          <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="3" /><path d="M3 7l9 6 9-6" /></svg>
          <p>If <b>{doneEmail}</b> can be registered, we've sent a verification link to it. Open the email and follow the link, then log in.</p>
          <p className="muted">If you already have an account with this address, no new account is created. Try logging in or resetting your password.</p>
          <p className="muted">Didn't get it? It can take a few minutes — check your spam or promotions folder.</p>
          <button type="button" className="text-btn" onClick={resendNow} disabled={!rv.canResend}>
            {rv.sending ? "Sending…" : rv.cooldown > 0 ? `Resend in ${rv.cooldown}s` : "Resend verification email"}
          </button>
        </div>
        <Link to="/login" className="btn btn-primary btn-lg auth-submit"><span>Go to login</span></Link>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="Create your account"
      subtitle="Private by design. Your files will only ever be yours."
      footer={<>Already have an account? <Link to="/login">Log in</Link></>}
    >
      <form onSubmit={submit} noValidate className="auth-form">
        {errors.form && <p className="notice error" role="alert">{errors.form}</p>}
        <TextField label="Full name" value={name} onChange={setName} autoComplete="name" error={errors.name} maxLength={80} disabled={busy} />
        <TextField label="Email address" type="email" value={email} onChange={setEmail} autoComplete="email" error={errors.email} maxLength={254} disabled={busy} />
        <PasswordField label="Password" value={password} onChange={setPassword} autoComplete="new-password" error={errors.password} showStrength disabled={busy} />
        <PasswordField label="Confirm password" value={confirm} onChange={setConfirm} autoComplete="new-password" error={errors.confirm} disabled={busy} />
        <div className="check-field">
          <label className="check">
            <input type="checkbox" checked={terms} onChange={(e) => setTerms(e.target.checked)} disabled={busy} aria-invalid={!!errors.terms} />
            <span>I agree to the <Link to="/terms" target="_blank">Terms of Service</Link> and <Link to="/privacy" target="_blank">Privacy Policy</Link>, and I will only edit content I own or am authorized to edit.</span>
          </label>
          {errors.terms && <p className="field-error" role="alert">{errors.terms}</p>}
        </div>
        <button className="btn btn-primary btn-lg auth-submit" type="submit" disabled={busy}>
          <span>{busy ? <><Spinner size={18} /> Creating account…</> : "Create account"}</span>
        </button>
      </form>
    </AuthShell>
  );
}
