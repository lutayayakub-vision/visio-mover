import { useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import AuthShell from "../../components/auth/AuthShell";
import TextField from "../../components/auth/TextField";
import PasswordField from "../../components/auth/PasswordField";
import Spinner from "../../components/ui/Spinner";
import { useToast } from "../../components/ui/Toast";
import { supabase, setRemember, siteUrl } from "../../lib/supabase";
import { isValidEmail, normalizeEmail } from "../../auth/validation";
import { friendlyAuthError } from "../../auth/errors";

const GOOGLE_ENABLED = import.meta.env.VITE_ENABLE_GOOGLE === "true";
const APP_PATHS = ["/dashboard", "/workspace", "/image-editor", "/video-editor", "/document-editor", "/projects", "/settings"];

export default function Login() {
  const nav = useNavigate();
  const loc = useLocation();
  const toast = useToast();
  const state = (loc.state ?? {}) as { from?: string; reason?: string };
  // Only allow redirects to known in-app paths (prevents open-redirect abuse)
  const dest = state.from && APP_PATHS.includes(state.from) ? state.from : "/dashboard";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRem] = useState(true);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<{ email?: string; password?: string; form?: string }>({});
  const [unverified, setUnverified] = useState(false);

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    const clean = normalizeEmail(email);
    const e: typeof errors = {};
    if (!isValidEmail(clean)) e.email = "Enter a valid email address.";
    if (!password) e.password = "Enter your password.";
    setErrors(e);
    setUnverified(false);
    if (Object.keys(e).length) return;

    setBusy(true);
    setRemember(remember);
    const { error } = await supabase.auth.signInWithPassword({ email: clean, password });
    setBusy(false);
    if (error) {
      setUnverified((error as { code?: string }).code === "email_not_confirmed");
      setErrors({ form: friendlyAuthError(error) });
      return;
    }
    toast("success", "Welcome back!");
    nav(dest, { replace: true });
  };

  const resend = async () => {
    const clean = normalizeEmail(email);
    if (!isValidEmail(clean)) return;
    const { error } = await supabase.auth.resend({ type: "signup", email: clean, options: { emailRedirectTo: `${siteUrl}/auth/callback` } });
    toast(error ? "error" : "success", error ? friendlyAuthError(error) : "Verification email sent. Check your inbox.");
  };

  const google = async () => {
    const { error } = await supabase.auth.signInWithOAuth({ provider: "google", options: { redirectTo: `${siteUrl}/auth/callback` } });
    if (error) setErrors({ form: friendlyAuthError(error) });
  };

  return (
    <AuthShell
      title="Welcome back"
      subtitle="Log in to your private workspace."
      footer={<>New to VISIOMOVER? <Link to="/register">Create an account</Link></>}
    >
      {state.reason === "required" && <p className="notice info">Please log in to continue.</p>}
      {state.reason === "expired" && <p className="notice info">Your session has ended. Please log in again.</p>}
      <form onSubmit={submit} noValidate className="auth-form">
        {errors.form && (
          <p className="notice error" role="alert">
            {errors.form}{" "}
            {unverified && <button type="button" className="text-btn" onClick={resend}>Resend verification email</button>}
          </p>
        )}
        <TextField label="Email address" type="email" value={email} onChange={setEmail} autoComplete="email" error={errors.email} disabled={busy} />
        <PasswordField label="Password" value={password} onChange={setPassword} autoComplete="current-password" error={errors.password} disabled={busy} />
        <div className="row-between">
          <label className="check"><input type="checkbox" checked={remember} onChange={(e) => setRem(e.target.checked)} /><span>Remember me</span></label>
          <Link to="/forgot-password" className="small-link">Forgot password?</Link>
        </div>
        <button className="btn btn-primary btn-lg auth-submit" type="submit" disabled={busy}>
          <span>{busy ? <><Spinner size={18} /> Logging in…</> : "Log in"}</span>
        </button>
      </form>
      {GOOGLE_ENABLED && (
        <>
          <div className="divider"><span>or</span></div>
          <button className="btn btn-ghost btn-lg auth-submit" type="button" onClick={google}><span>Continue with Google</span></button>
        </>
      )}
    </AuthShell>
  );
}
