import type { AuthError } from "@supabase/supabase-js";

/** Maps Supabase errors to messages that help the user without leaking account details. */
export function friendlyAuthError(err: AuthError | { message: string; code?: string; status?: number }): string {
  const code = (err as { code?: string }).code ?? "";
  const status = (err as { status?: number }).status;
  switch (code) {
    case "invalid_credentials": return "Incorrect email or password.";
    case "email_not_confirmed": return "Your email address isn't verified yet. Check your inbox for the verification link.";
    case "weak_password": return "That password is too weak or has appeared in known data breaches. Please choose another.";
    case "over_request_rate_limit":
    case "over_email_send_rate_limit": return "Too many attempts. Please wait a few minutes and try again.";
    case "user_banned": return "This account is unavailable. Contact support.";
    case "same_password": return "Your new password must be different from the old one.";
    case "otp_expired": return "This link has expired or was already used. Please request a new one.";
    case "email_address_invalid": return "That email address can't be used. Check it and try again.";
    case "signup_disabled": return "Sign-ups are currently disabled.";
  }
  if (status === 429) return "Too many attempts. Please wait a few minutes and try again.";
  if (status && status >= 500) return "Something went wrong on our side. Please try again shortly.";
  if (/fetch|network/i.test(err.message)) return "Can't reach the server. Check your connection and try again.";
  return "Something went wrong. Please try again.";
}
