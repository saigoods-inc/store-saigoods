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

/** @param {number | null | undefined} n */
function fmtIntTracked(n) {
  if (n == null) return "—";
  return String(Math.max(0, Math.floor(Number(n))));
}

/** @param {number | null | undefined} n */
function fmtEquiv(n) {
  if (n == null) return "—";
  const v = Number(n);
  if (!Number.isFinite(v)) return "—";
  const rounded = Math.round(v * 1000) / 1000;
  return String(rounded);
}

/**
 * @param {object | null | undefined} overview
 * @param {number} [lineFallback]
 */
function renderSummary(overview, lineFallback = 0) {
  const s = overview?.summary || {};
  const soldEl = document.getElementById("inv-sum-sold");
  const note = document.getElementById("inv-baseline-note");

  if (s.totalCartonsSold != null) {
    soldEl.textContent = fmtIntTracked(s.totalCartonsSold);
    note.hidden = true;
    note.textContent = "";
  } else {
    soldEl.textContent = "—";
    note.hidden = false;
    note.textContent =
      "Cartons sold will appear after original cartons is set on case lines (baseline). " +
      "Until then, sold totals cannot be derived from inventory alone.";
  }

  document.getElementById("inv-sum-cartons-left").textContent = fmtIntTracked(s.totalCartonsLeft ?? 0);
  document.getElementById("inv-sum-boxes-left").textContent = fmtIntTracked(s.totalBoxesLeft ?? 0);

  const variants = s.activeVariantRows ?? 0;
  const lines = s.stockLineCount ?? lineFallback;
  document.getElementById("inv-sum-variants").textContent = `${variants} / ${lines}`;
}

/**
 * @param {object | null | undefined} overview
 */
function renderOverviewTable(overview) {
  const tbody = document.getElementById("inv-overview-tbody");
  const products = Array.isArray(overview?.products) ? overview.products : [];

  if (!products.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="admin-muted">
      No inventory rows match the catalog yet. Add case and/or box lines per product and size (tracked counts roll into the totals above).
    </td></tr>`;
    return;
  }

  const rows = [];
  for (const p of products) {
    const slugPart = `<span class="admin-muted">(${escapeHtml(p.productSlug)})</span>`;
    rows.push(
      `<tr class="inv-section"><td colspan="6">${escapeHtml(p.productName)} ${slugPart}</td></tr>`,
    );

    for (const z of p.sizes) {
      rows.push(`<tr>
        <td></td>
        <td>${escapeHtml(z.size)}</td>
        <td class="inv-num">${fmtIntTracked(z.cartonsLeft)}</td>
        <td class="inv-num">${fmtIntTracked(z.boxesLeft)}</td>
        <td class="inv-num">${fmtEquiv(z.cartonEquivalent)}</td>
        <td class="inv-num">${z.cartonsSold != null ? fmtIntTracked(z.cartonsSold) : "—"}</td>
      </tr>`);
    }

    const st = p.subtotal || {};
    rows.push(`<tr class="inv-subtotal">
      <td></td>
      <td>Subtotal</td>
      <td class="inv-num">${fmtIntTracked(st.cartonsLeft)}</td>
      <td class="inv-num">${fmtIntTracked(st.boxesLeft)}</td>
      <td class="inv-num">${fmtEquiv(st.cartonEquivalent)}</td>
      <td class="inv-num">${st.cartonsSold != null ? fmtIntTracked(st.cartonsSold) : "—"}</td>
    </tr>`);
  }

  tbody.innerHTML = rows.join("");
}

async function loadStock(session) {
  const errEl = document.getElementById("admin-load-error");
  const loading = document.getElementById("admin-loading");
  errEl.hidden = true;
  loading.hidden = false;
  try {
    const stock = await fetchReportJson("/api/admin-stock", session.access_token);
    const overview = stock?.overview || null;
    const lineCount = Array.isArray(stock?.lines) ? stock.lines.length : 0;
    renderSummary(overview, lineCount);
    renderOverviewTable(overview);
  } catch (e) {
    errEl.textContent = e.message || "Could not load stock.";
    errEl.hidden = false;
  }
  loading.hidden = true;
}

async function bootstrap(session) {
  document.getElementById("admin-user-email").textContent = session.user.email || "";
  renderAdminNav("inventory");
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
