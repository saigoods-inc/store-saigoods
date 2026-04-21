import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.8";
import {
  clearAdminSessionUser,
  fetchReportJson,
  fetchSupabasePublicConfig,
  primeAdminSessionUser,
  renderAdminNav,
  shouldBootstrapAdminSignedIn,
} from "./admin-shared.js";

/** @type {import("@supabase/supabase-js").SupabaseClient | null} */
let supabase = null;
/** @type {{ products?: { slug: string, name?: string }[] }} */
let storeCache = null;

function showLogin() {
  document.getElementById("admin-login").hidden = false;
  document.getElementById("admin-app").hidden = true;
}

function showApp() {
  document.getElementById("admin-login").hidden = true;
  document.getElementById("admin-app").hidden = false;
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function productLabel(slug) {
  const p = storeCache?.products?.find((x) => x.slug === slug);
  return p?.name ? `${p.name} (${slug})` : slug;
}

function channelLabel(ch) {
  const c = String(ch || "").toLowerCase();
  if (c === "case") return "case";
  if (c === "box") return "box";
  return c || "—";
}

function sortLines(lines) {
  return [...lines].sort((a, b) => {
    const ka = `${a.productSlug}\t${a.size}\t${a.channel}`;
    const kb = `${b.productSlug}\t${b.size}\t${b.channel}`;
    return ka.localeCompare(kb);
  });
}

function renderStockTable(lines) {
  const tbody = document.getElementById("inv-stock-tbody");
  const list = sortLines(Array.isArray(lines) ? lines : []);
  if (!list.length) {
    tbody.innerHTML = `<tr><td colspan="3" class="admin-muted">No inventory rows yet.</td></tr>`;
    return;
  }
  tbody.innerHTML = list
    .map((row) => {
      const slug = String(row.productSlug || "").trim();
      const size = String(row.size || "").trim();
      const unit = channelLabel(row.channel);
      const sizeCell = `${size} (${unit})`;
      const qty = Math.max(0, Math.floor(Number(row.onHand) || 0));
      return `<tr>
        <td>${escapeHtml(productLabel(slug))}</td>
        <td>${escapeHtml(sizeCell)}</td>
        <td>${escapeHtml(String(qty))}</td>
      </tr>`;
    })
    .join("");
}

async function loadStore() {
  const data = await fetch("/api/products").then((r) => r.json());
  storeCache = data;
}

async function loadStock(session) {
  const errEl = document.getElementById("admin-load-error");
  const loading = document.getElementById("admin-loading");
  errEl.hidden = true;
  loading.hidden = false;
  try {
    const stock = await fetchReportJson("/api/admin-stock", session.access_token);
    renderStockTable(stock?.lines);
  } catch (e) {
    errEl.textContent = e.message || "Could not load stock.";
    errEl.hidden = false;
  }
  loading.hidden = true;
}

async function bootstrap(session) {
  document.getElementById("admin-user-email").textContent = session.user.email || "";
  renderAdminNav("inventory");
  await loadStore();
  await loadStock(session);
}

async function init() {
  let config;
  try {
    config = await fetchSupabasePublicConfig();
  } catch (e) {
    document.getElementById("admin-load-error").textContent =
      e.message || "Add SUPABASE_URL and SUPABASE_ANON_KEY to the server environment.";
    document.getElementById("admin-load-error").hidden = false;
    showLogin();
    document.getElementById("login-form").style.display = "none";
    return;
  }

  supabase = createClient(config.supabaseUrl, config.supabaseAnonKey, {
    auth: { persistSession: true, autoRefreshToken: true },
  });

  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (session?.user) {
    primeAdminSessionUser(session);
    showApp();
    await bootstrap(session);
  } else {
    showLogin();
  }

  supabase.auth.onAuthStateChange(async (event, sess) => {
    if (event === "SIGNED_IN" && sess?.user) {
      if (!shouldBootstrapAdminSignedIn(sess)) {
        return;
      }
      showApp();
      await bootstrap(sess);
    }
    if (event === "SIGNED_OUT") {
      clearAdminSessionUser();
      showLogin();
    }
  });

  document.getElementById("login-form")?.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const errEl = document.getElementById("login-error");
    errEl.hidden = true;
    const fd = new FormData(ev.target);
    const email = String(fd.get("email") || "").trim();
    const password = String(fd.get("password") || "");
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      errEl.textContent = error.message;
      errEl.hidden = false;
      return;
    }
    const { data: afterLogin } = await supabase.auth.getSession();
    primeAdminSessionUser(afterLogin.session);
    showApp();
    await bootstrap(afterLogin.session);
  });

  document.getElementById("admin-logout")?.addEventListener("click", async () => {
    await supabase.auth.signOut();
  });

  document.getElementById("admin-refresh")?.addEventListener("click", async () => {
    const { data: s } = await supabase.auth.getSession();
    if (s?.session) await bootstrap(s.session);
  });
}

document.addEventListener("DOMContentLoaded", () => void init());
