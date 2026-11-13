import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;

if (!url || !key) {
  throw new Error("Missing VITE_SUPABASE_URL or VITE_SUPABASE_PUBLISHABLE_KEY. Copy .env.example to .env.local.");
}

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

export const siteUrl = window.location.origin;
