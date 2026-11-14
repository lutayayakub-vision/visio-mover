import { createClient } from "@supabase/supabase-js";

const rawUrl = (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.trim();
// Accept a bare project ref (e.g. "abcd1234") or a host without a scheme, and turn it into a full URL.
const envUrl = !rawUrl ? undefined
  : /^https?:\/\//.test(rawUrl) ? rawUrl
  : rawUrl.includes(".") ? `https://${rawUrl}`
  : `https://${rawUrl}.supabase.co`;
const envKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;

/** False when the Supabase env vars were not present at build time. Public pages still render; auth calls will fail. */
export const supabaseConfigured = Boolean(envUrl && envKey);

if (!supabaseConfigured) {
  // Don't throw here: a throw at import time blanks the whole site, including public pages.
  console.error("Missing VITE_SUPABASE_URL or VITE_SUPABASE_PUBLISHABLE_KEY. Set them in Netlify env vars (or .env.local) and rebuild.");
}

const url = envUrl || "https://placeholder.supabase.co";
const key = envKey || "missing-key";

const REMEMBER_KEY = "vm_remember";

/** "Remember me" on → session in localStorage (survives browser restarts). Off → sessionStorage (ends with the tab). */
export const setRemember = (remember: boolean) => {
  try { localStorage.setItem(REMEMBER_KEY, remember ? "1" : "0"); } catch { /* storage unavailable */ }
};

const wantsPersist = () => {
  try { return localStorage.getItem(REMEMBER_KEY) !== "0"; } catch { return false; }
};

const storage = {
  getItem: (k: string) => {
    try { return sessionStorage.getItem(k) ?? localStorage.getItem(k); } catch { return null; }
  },
  setItem: (k: string, v: string) => {
    try {
      const persist = wantsPersist();
      (persist ? localStorage : sessionStorage).setItem(k, v);
      (persist ? sessionStorage : localStorage).removeItem(k);
    } catch { /* storage unavailable */ }
  },
  removeItem: (k: string) => {
    try { sessionStorage.removeItem(k); localStorage.removeItem(k); } catch { /* storage unavailable */ }
  },
};

export const supabase = createClient(url, key, {
  auth: {
    flowType: "pkce",
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    storage,
  },
});

export const supabaseUrl = url;
export const supabaseKey = key;
export const siteUrl = window.location.origin;
