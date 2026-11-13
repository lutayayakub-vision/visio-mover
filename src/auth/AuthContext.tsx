import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Session, User } from "@supabase/supabase-js";
import { supabase } from "../lib/supabase";

export type Profile = { id: string; full_name: string; avatar_url: string | null; created_at: string };

type Ctx = {
  session: Session | null;
  user: User | null;
  profile: Profile | null;
  loading: boolean;
  /** true when the session ended without the user pressing Log out (expiry, other device, revoked) */
  sessionEnded: boolean;
  recovering: boolean;
  refreshProfile: () => Promise<void>;
  signOut: (scope?: "local" | "global") => Promise<void>;
};

const AuthContext = createContext<Ctx | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [sessionEnded, setSessionEnded] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const manualSignOut = useRef(false);

  useEffect(() => {
    // Restores the session after a refresh. getSession also processes ?code= from email links (PKCE).
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });

    const { data: sub } = supabase.auth.onAuthStateChange((event, next) => {
      // Never await Supabase calls inside this callback (can deadlock the client).
      setSession(next);
      setLoading(false);
      if (event === "PASSWORD_RECOVERY") setRecovering(true);
      if (event === "SIGNED_IN") { setSessionEnded(false); }
      if (event === "SIGNED_OUT") {
        setProfile(null);
        setRecovering(false);
        setSessionEnded(!manualSignOut.current);
        manualSignOut.current = false;
      }
    });

    // Back/forward cache: when a page is restored from bfcache, re-verify the session.
    const onShow = (e: PageTransitionEvent) => {
      if (e.persisted) supabase.auth.getSession().then(({ data }) => setSession(data.session));
    };
    window.addEventListener("pageshow", onShow);
    return () => { sub.subscription.unsubscribe(); window.removeEventListener("pageshow", onShow); };
  }, []);

  const userId = session?.user.id ?? null;

  const loadProfile = useCallback(async () => {
    if (!userId) { setProfile(null); return; }
    // RLS is the real protection; .eq is only a convenience so we fetch a single row.
    const { data } = await supabase.from("profiles").select("id, full_name, avatar_url, created_at").eq("id", userId).maybeSingle();
    setProfile(data as Profile | null);
  }, [userId]);

  useEffect(() => { void loadProfile(); }, [loadProfile]);

  const signOut = useCallback(async (scope: "local" | "global" = "local") => {
    manualSignOut.current = true;
    await supabase.auth.signOut({ scope });
    setSession(null);
    setProfile(null);
  }, []);

  const value = useMemo<Ctx>(
    () => ({ session, user: session?.user ?? null, profile, loading, sessionEnded, recovering, refreshProfile: loadProfile, signOut }),
    [session, profile, loading, sessionEnded, recovering, loadProfile, signOut]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}
