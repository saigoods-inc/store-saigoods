import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.8";
import {
  clearAdminSessionUser,
  fetchReportJson,
  fetchReportPost,
  fetchSupabasePublicConfig,
  primeAdminSessionUser,
  renderAdminNav,
  shouldBootstrapAdminSignedIn,
} from "./admin-shared.js";

/** @type {import("@supabase/supabase-js").SupabaseClient | null} */
let supabase = null;
/** @type {{ site?: { sizes?: string[] }, products?: { slug: string, name?: string }[] }} */
let storeCache = null;
/** @type {{ schemaVersion?: number, lines?: object[] }} */
let stockCache = null;

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

function renderStockTable() {
  const tbody = document.getElementById("stock-tbody");
  const lines = Array.isArray(stockCache?.lines) ? stockCache.lines : [];
  if (!lines.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="admin-muted">No stock lines yet. Add one below (set on hand and enable tracking when you want checkout to enforce it).</td></tr>`;
    return;
  }
  tbody.innerHTML = lines
    .map((row) => {
      return `<tr>
        <td>${escapeHtml(productLabel(row.productSlug))}</td>
        <td>${escapeHtml(row.size)}</td>
        <td>${escapeHtml(row.channel)}</td>
        <td>${escapeHtml(String(row.onHand ?? 0))}</td>
        <td>${escapeHtml(String(row.reserved ?? 0))}</td>
        <td>${row.track === true ? "Yes" : "—"}</td>
        <td>${escapeHtml(row.sku || "—")}</td>
      </tr>`;
    })
    .join("");
}

function fillProductSelect() {
  const sel = document.getElementById("edit-slug");
  const products = Array.isArray(storeCache?.products) ? storeCache.products : [];
  sel.innerHTML = products
    .map((p) => `<option value="${escapeHtml(p.slug)}">${escapeHtml(productLabel(p.slug))}</option>`)
    .join("");
}

function fillSizeSelect() {
  const sel = document.getElementById("edit-size");
  const sizes = Array.isArray(storeCache?.site?.sizes) ? storeCache.site.sizes : [];
  sel.innerHTML = sizes.map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join("");
}

async function loadStore() {
  const data = await fetch("/api/products").then((r) => r.json());
  storeCache = data;
  fillProductSelect();
  fillSizeSelect();
}

async function loadStock(session) {
  const errEl = document.getElementById("admin-load-error");
  const loading = document.getElementById("admin-loading");
  errEl.hidden = true;
  loading.hidden = false;
  try {
    stockCache = await fetchReportJson("/api/admin/stock", session.access_token);
    renderStockTable();
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

  document.getElementById("stock-edit-form")?.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const toast = document.getElementById("admin-save-toast");
    const errEl = document.getElementById("admin-load-error");
    toast.hidden = true;
    errEl.hidden = true;
    const { data: sess } = await supabase.auth.getSession();
    if (!sess?.session) {
      errEl.textContent = "Sign in again.";
      errEl.hidden = false;
      return;
    }
    const slug = String(document.getElementById("edit-slug").value || "").trim();
    const size = String(document.getElementById("edit-size").value || "").trim();
    const channel = String(document.getElementById("edit-channel").value || "").trim();
    const onHand = Math.max(0, Math.floor(Number(document.getElementById("edit-on-hand").value) || 0));
    const track = document.getElementById("edit-track").checked === true;
    const skuRaw = String(document.getElementById("edit-sku").value || "").trim();
    const patch = {
      productSlug: slug,
      size,
      channel,
      setOnHand: onHand,
      track,
    };
    if (skuRaw) {
      patch.sku = skuRaw;
    }
    try {
      await fetchReportPost("/api/admin/stock", sess.session.access_token, { patches: [patch] });
      toast.textContent = "Saved.";
      toast.hidden = false;
      await loadStock(sess.session);
    } catch (e) {
      errEl.textContent = e.message || "Save failed.";
      errEl.hidden = false;
    }
  });
}

init();
