import type { ReactNode } from "react";
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { createClient, type Session, type SupabaseClient } from "@supabase/supabase-js";

const STORAGE_KEY = "saigoods-admin-supabase-auth";

interface AuthContextValue {
  client: SupabaseClient | null;
  session: Session | null;
  passwordRecovery: boolean;
  loading: boolean;
  error: string | null;
  email: string;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  requestPasswordReset: (email: string) => Promise<void>;
  updatePassword: (password: string) => Promise<void>;
  finishPasswordRecovery: () => void;
  getAccessToken: () => Promise<string | undefined>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function isPasswordRecoveryUrl() {
  if (typeof window === "undefined") return false;
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const query = new URLSearchParams(window.location.search);
  return hash.get("type") === "recovery" || query.get("type") === "recovery";
}

function clearPasswordRecoveryUrl() {
  if (typeof window === "undefined") return;
  window.history.replaceState({}, "", `${window.location.origin}/admin-v2.5/summary`);
}

async function fetchConfig() {
  const response = await fetch("/api/supabase-public-config");
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(
      (typeof data.hint === "string" && data.hint) ||
        (typeof data.error === "string" && data.error) ||
        "Could not load staff login configuration.",
    );
  }

  return {
    supabaseUrl: String(data.supabaseUrl || ""),
    supabaseAnonKey: String(data.supabaseAnonKey || ""),
  };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [client, setClient] = useState<SupabaseClient | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [passwordRecovery, setPasswordRecovery] = useState(isPasswordRecoveryUrl);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    async function boot() {
      try {
        const config = await fetchConfig();
        if (!config.supabaseUrl || !config.supabaseAnonKey) {
          throw new Error("Supabase public configuration is missing.");
        }

        const supabase = createClient(config.supabaseUrl, config.supabaseAnonKey, {
          auth: {
            persistSession: true,
            autoRefreshToken: true,
            detectSessionInUrl: true,
            storageKey: STORAGE_KEY,
          },
        });

        if (!active) return;
        setClient(supabase);

        const subscription = supabase.auth.onAuthStateChange((event, nextSession) => {
          if (!active) return;
          setSession(nextSession ?? null);
          if (event === "PASSWORD_RECOVERY") {
            setPasswordRecovery(true);
          }
        });

        const existing = await supabase.auth.getSession();
        if (!active) return;
        setSession(existing.data.session ?? null);
        if (isPasswordRecoveryUrl()) {
          setPasswordRecovery(true);
        }
        setLoading(false);

        return () => {
          subscription.data.subscription.unsubscribe();
        };
      } catch (nextError) {
        if (!active) return;
        setError(nextError instanceof Error ? nextError.message : "Could not initialize staff login.");
        setLoading(false);
      }
      return undefined;
    }

    let cleanup: (() => void) | undefined;
    void boot().then((fn) => {
      cleanup = fn;
    });

    return () => {
      active = false;
      cleanup?.();
    };
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      client,
      session,
      passwordRecovery,
      loading,
      error,
      email: session?.user?.email || "",
      async signIn(email, password) {
        if (!client) throw new Error("Supabase client is not ready.");
        const { error: signInError } = await client.auth.signInWithPassword({ email, password });
        if (signInError) throw signInError;
      },
      async signOut() {
        if (!client) return;
        await client.auth.signOut();
      },
      async requestPasswordReset(email) {
        if (!client) throw new Error("Supabase client is not ready.");
        const redirectTo = `${window.location.origin}/admin-v2.5/reset-password`;
        const { error: resetError } = await client.auth.resetPasswordForEmail(email, { redirectTo });
        if (resetError) throw resetError;
      },
      async updatePassword(password) {
        if (!client) throw new Error("Supabase client is not ready.");
        const { error: updateError } = await client.auth.updateUser({ password });
        if (updateError) throw updateError;
        await client.auth.signOut();
      },
      finishPasswordRecovery() {
        setPasswordRecovery(false);
        clearPasswordRecoveryUrl();
      },
      async getAccessToken() {
        if (!client) return undefined;
        const next = await client.auth.getSession();
        return next.data.session?.access_token;
      },
    }),
    [client, error, loading, passwordRecovery, session],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) {
    throw new Error("useAuth must be used inside AuthProvider.");
  }
  return value;
}
