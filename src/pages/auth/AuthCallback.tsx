import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import AuthShell from "../../components/auth/AuthShell";
import Spinner from "../../components/ui/Spinner";
import { useAuth } from "../../auth/AuthContext";
import { useToast } from "../../components/ui/Toast";

/** Landing page for email-verification (and OAuth) links. supabase-js exchanges the ?code= automatically. */
export default function AuthCallback() {
  const { session, loading } = useAuth();
  const nav = useNavigate();
  const toast = useToast();
  const [failed, setFailed] = useState(false);
  const params = new URLSearchParams(window.location.search);
  const urlError = params.get("error_description");

  useEffect(() => {
    if (session) { toast("success", "Email verified. Welcome to VISIOMOVER!"); nav("/dashboard", { replace: true }); return; }
    if (loading) return;
    const t = setTimeout(() => setFailed(true), 3000);
    return () => clearTimeout(t);
  }, [session, loading, nav, toast]);

  if (failed || urlError) {
    return (
      <AuthShell title="Verification link problem" subtitle="This link is invalid, expired or was already used.">
        <p className="muted">If you already verified your email, just log in. Otherwise, log in and we can resend the verification email.</p>
        <Link to="/login" className="btn btn-primary btn-lg auth-submit"><span>Go to login</span></Link>
      </AuthShell>
    );
  }
  return <AuthShell title="Verifying your email…"><div className="center"><Spinner size={34} label="Verifying" /></div></AuthShell>;
}
