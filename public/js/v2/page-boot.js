/*
 * SAI Goods admin-v2 — shared page boot helper.
 *
 * Centralizes the identical login/session/shell/refresh wiring that every
 * admin-v2 page controller previously duplicated. Behavior is intentionally
 * byte-for-byte equivalent to the old per-page boot():
 *   - fetch Supabase public config (/api/supabase-public-config)
 *   - create the shared Supabase admin client (localStorage session)
 *   - check the existing session, show login when signed out
 *   - mount the shell (sidebar + topbar) and enter the app when signed in
 *   - wire Sign out + the topbar Refresh button
 *   - handle onAuthStateChange (SIGNED_IN / SIGNED_OUT)
 *   - expose getAccessToken() and getSupabaseClient() to page controllers via ctx
 *
 * getSupabaseClient() returns the shared admin-v2 Supabase client so pages that
 * need direct table reads (e.g. Orders reading public.orders / order_shippo_labels,
 * matching the old /admin dashboard) reuse one client instead of creating another.
 *
 * Only affects /admin-v2 pages. No backend, lib/, or API contract is touched.
 */

import {
  clearAdminSessionUser,
  createSupabaseAdminClient,
  fetchSupabasePublicConfig,
  primeAdminSessionUser,
  shouldBootstrapAdminSignedIn,
} from "../admin-shared.js";

import { initShellInteractions, shell } from "./ui.js";

function getEl(id) {
  return document.getElementById(id);
}

function showLogin() {
  getEl("sg-login")?.classList.remove("sg-hide");
  getEl("sg-root")?.classList.add("sg-hide");
}

function showApp() {
  getEl("sg-login")?.classList.add("sg-hide");
  getEl("sg-root")?.classList.remove("sg-hide");
}

/**
 * Boot an admin-v2 page.
 *
 * @param {object} opts
 * @param {string} opts.activeNav Sidebar id to highlight (e.g. "summary", "inventory").
 * @param {(session: object, ctx: { getAccessToken: () => Promise<string|undefined>, getSupabaseClient: () => object|null }) => (void|Promise<void>)} opts.onEnter
 *        Called after the shell mounts and the user is signed in. Do initial render + data load here.
 * @param {(ctx: { getAccessToken: () => Promise<string|undefined>, getSupabaseClient: () => object|null }) => (void|Promise<void>)} [opts.onRefresh]
 *        Called when the topbar Refresh button is clicked. Defaults to re-running onEnter's load if omitted.
 * @param {() => void} [opts.onSignedOut] Optional cleanup when the user signs out.
 * @param {string} [opts.topbarLeftHtml] Optional custom topbar content shown next to the mobile menu button.
 * @returns {{ getAccessToken: () => Promise<string|undefined>, getSupabaseClient: () => object|null }} ctx (also passed to callbacks).
 */
export function bootAdminV2Page({ activeNav, onEnter, onRefresh, onSignedOut, topbarLeftHtml = "" }) {
  let supabase = null;

  async function getAccessToken() {
    if (!supabase) return undefined;
    const {
      data: { session },
    } = await supabase.auth.getSession();
    return session?.access_token;
  }

  /** Shared admin-v2 Supabase client (null until config loads). For direct table reads. */
  function getSupabaseClient() {
    return supabase;
  }

  const ctx = { getAccessToken, getSupabaseClient };

  function mountShell(email) {
    const root = getEl("sg-root");
    if (!root) return;
    root.innerHTML = shell({ active: activeNav, email: email || "", meta: "", topbarLeftHtml });
    initShellInteractions();

    getEl("sg-logout")?.addEventListener("click", async () => {
      if (supabase) await supabase.auth.signOut();
      else showLogin();
    });
    getEl("sg-refresh")?.addEventListener("click", () => {
      if (typeof onRefresh === "function") onRefresh(ctx);
    });
  }

  async function enterApp(session) {
    showApp();
    mountShell(session?.user?.email || "");
    if (typeof onEnter === "function") await onEnter(session, ctx);
  }

  async function boot() {
    let config = null;
    try {
      config = await fetchSupabasePublicConfig();
    } catch (e) {
      const err = getEl("login-error");
      if (err) {
        err.textContent = e?.message || "Add SUPABASE_URL and SUPABASE_ANON_KEY to the server environment.";
        err.hidden = false;
      }
      showLogin();
      return;
    }

    if (config?.supabaseUrl && config?.supabaseAnonKey) {
      supabase = createSupabaseAdminClient(config.supabaseUrl, config.supabaseAnonKey);
    }
    if (!supabase) {
      showLogin();
      return;
    }

    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (session?.user) {
      primeAdminSessionUser(session);
      await enterApp(session);
    } else {
      showLogin();
    }

    supabase.auth.onAuthStateChange(async (event, sessionAfter) => {
      if (event === "SIGNED_IN" && sessionAfter?.user) {
        if (!shouldBootstrapAdminSignedIn(sessionAfter)) return;
        await enterApp(sessionAfter);
      }
      if (event === "SIGNED_OUT") {
        clearAdminSessionUser();
        if (typeof onSignedOut === "function") onSignedOut();
        showLogin();
      }
    });

    getEl("login-form")?.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const errEl = getEl("login-error");
      if (errEl) errEl.hidden = true;
      if (!supabase) return;
      const fd = new FormData(ev.target);
      const email = String(fd.get("email") || "").trim();
      const password = String(fd.get("password") || "");
      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) {
        if (errEl) {
          errEl.textContent = error.message;
          errEl.hidden = false;
        }
        return;
      }
      const s = data?.session || (await supabase.auth.getSession()).data?.session || null;
      if (s) primeAdminSessionUser(s);
      await enterApp(s);
    });
  }

  boot();
  return ctx;
}
