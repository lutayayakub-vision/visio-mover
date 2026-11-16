import { useCallback, useEffect, useState } from "react";
import { supabase, siteUrl } from "../lib/supabase";
import { friendlyAuthError } from "./errors";

/** Supabase allows one auth email per address every 60s; mirror that so users don't burn their hourly quota. */
const COOLDOWN = 60;

export function useResendVerification() {
  const [cooldown, setCooldown] = useState(0);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  const resend = useCallback(async (email: string): Promise<{ ok: boolean; message: string }> => {
    setSending(true);
    const { error } = await supabase.auth.resend({ type: "signup", email, options: { emailRedirectTo: `${siteUrl}/auth/callback` } });
    setSending(false);
    if (error) {
      if ((error as { status?: number }).status === 429) setCooldown(COOLDOWN);
      return { ok: false, message: friendlyAuthError(error) };
    }
    setCooldown(COOLDOWN);
    return { ok: true, message: "Verification email sent. It can take a few minutes — check your spam or promotions folder too." };
  }, []);

  return { resend, cooldown, sending, canResend: cooldown <= 0 && !sending };
}
