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
  const boxesSoldEl = document.getElementById("inv-sum-boxes-sold");
  const note = document.getElementById("inv-baseline-note");

  soldEl.textContent =
    s.totalCartonsSold != null ? fmtIntTracked(s.totalCartonsSold) : "—";
  boxesSoldEl.textContent =
    s.totalBoxesSold != null ? fmtIntTracked(s.totalBoxesSold) : "—";

  if (s.totalCartonsSold != null && s.totalBoxesSold != null) {
    note.hidden = true;
    note.textContent = "";
  } else if (s.totalCartonsSold == null && s.totalBoxesSold == null) {
    note.hidden = false;
    note.textContent =
      "Cases sold and boxes sold appear after baselines are set: original cases on case lines " +
      "and/or original boxes on box lines. Until then, those totals cannot be derived from inventory alone.";
  } else {
    note.hidden = false;
    const parts = [];
    if (s.totalCartonsSold == null) {
      parts.push("cases sold needs original cases on case lines");
    }
    if (s.totalBoxesSold == null) {
      parts.push("boxes sold needs original boxes on box lines");
    }
    note.textContent = `${parts.join("; ")}.`;
  }

  document.getElementById("inv-sum-cases-left").textContent = fmtIntTracked(s.totalCartonsLeft ?? 0);
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
    tbody.innerHTML = `<tr><td colspan="7" class="admin-muted">
      No inventory rows match the catalog yet. Add case and/or box lines per product and size (tracked counts roll into the totals above).
    </td></tr>`;
    return;
  }

  const rows = [];
  for (const p of products) {
    const slugPart = `<span class="admin-muted">(${escapeHtml(p.productSlug)})</span>`;
    rows.push(
      `<tr class="inv-section"><td colspan="7">${escapeHtml(p.productName)} ${slugPart}</td></tr>`,
    );

    for (const z of p.sizes) {
      rows.push(`<tr>
        <td></td>
        <td>${escapeHtml(z.size)}</td>
        <td class="inv-num">${fmtIntTracked(z.cartonsLeft)}</td>
        <td class="inv-num">${fmtIntTracked(z.boxesLeft)}</td>
        <td class="inv-num">${fmtEquiv(z.cartonEquivalent)}</td>
        <td class="inv-num">${z.cartonsSold != null ? fmtIntTracked(z.cartonsSold) : "—"}</td>
        <td class="inv-num">${z.boxesSold != null ? fmtIntTracked(z.boxesSold) : "—"}</td>
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
      <td class="inv-num">${st.boxesSold != null ? fmtIntTracked(st.boxesSold) : "—"}</td>
    </tr>`);
  }

  tbody.innerHTML = rows.join("");
}

/**
 * @param {object | null | undefined} editor
 */
function renderEditorTable(editor) {
  const tbody = document.getElementById("inv-editor-tbody");
  if (!tbody) {
    return;
  }
  const rows = Array.isArray(editor?.rows) ? editor.rows : [];

  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="4" class="admin-muted">No catalog products.</td></tr>`;
    return;
  }

  tbody.innerHTML = rows
    .map((r) => {
      const slug = escapeHtml(r.productSlug);
      const size = escapeHtml(r.size);
      const name = escapeHtml(r.productName ?? r.catalogProductName ?? "");
      const cat = escapeHtml(r.catalogProductName ?? "");
      const c = Math.max(0, Math.floor(Number(r.casesOnHand) || 0));
      const b = Math.max(0, Math.floor(Number(r.boxesOnHand) || 0));
      return `<tr
        data-slug="${slug}"
        data-size="${size}"
        data-catalog-name="${cat}"
      >
        <td>
          <input
            class="inv-editor-input inv-editor-input--name"
            type="text"
            data-field="name"
            value="${name}"
            spellcheck="false"
            aria-label="Product name for ${size}"
          />
        </td>
        <td><span class="admin-muted">${size}</span></td>
        <td class="inv-editor-num">
          <input
            class="inv-editor-input inv-editor-input--num"
            type="number"
            inputmode="numeric"
            min="0"
            step="1"
            data-field="cases"
            value="${c}"
            aria-label="Cases in stock for ${size}"
          />
        </td>
        <td class="inv-editor-num">
          <input
            class="inv-editor-input inv-editor-input--num"
            type="number"
            inputmode="numeric"
            min="0"
            step="1"
            data-field="boxes"
            value="${b}"
            aria-label="Boxes in stock for ${size}"
          />
        </td>
      </tr>`;
    })
    .join("");
}

async function loadStock(session) {
  const errEl = document.getElementById("admin-load-error");
  const loading = document.getElementById("admin-loading");
  errEl.hidden = true;
  loading.hidden = false;
  const status = document.getElementById("inv-save-status");
  if (status) {
    status.textContent = "";
  }
  try {
    const stock = await fetchReportJson("/api/admin-stock", session.access_token);
    const overview = stock?.overview || null;
    const lineCount = Array.isArray(stock?.lines) ? stock.lines.length : 0;
    const gOos = Boolean(stock?.storefrontGlobalOutOfStock ?? overview?.storefrontGlobalOutOfStock);
    const banner = document.getElementById("inv-global-oos-banner");
    if (banner) {
      if (gOos) {
        banner.hidden = false;
        banner.textContent =
          "Storefront global out-of-stock is ON (store.json → site.storefrontGlobalOutOfStock). " +
          "Cases/boxes left below match what customers see (sellable counts shown as 0). " +
          "Turn it off in store.json to use the manual stock per size instead.";
      } else {
        banner.hidden = true;
        banner.textContent = "";
      }
    }
    renderSummary(overview, lineCount);
    renderEditorTable(stock?.editor || null);
    renderOverviewTable(overview);
  } catch (e) {
    errEl.textContent = e.message || "Could not load stock.";
    errEl.hidden = false;
  }
  loading.hidden = true;
}

/**
 * @param {import("@supabase/supabase-js").Session} session
 */
async function saveAllInventoryEdits(session) {
  const status = document.getElementById("inv-save-status");
  const btn = document.getElementById("inv-save-all");
  const tbody = document.getElementById("inv-editor-tbody");
  if (!tbody) {
    return;
  }
  if (status) {
    status.textContent = "Saving…";
  }
  if (btn) {
    btn.disabled = true;
  }
  const patches = [];
  try {
    for (const tr of tbody.querySelectorAll("tr[data-slug]")) {
      const slug = String(tr.dataset.slug || "").trim();
      const size = String(tr.dataset.size || "").trim();
      if (!slug || !size) {
        continue;
      }
      const cat = String(tr.dataset.catalogName || "").trim();
      const nameInput = tr.querySelector('[data-field="name"]');
      const caseInput = tr.querySelector('[data-field="cases"]');
      const boxInput = tr.querySelector('[data-field="boxes"]');
      const rawName = String(nameInput?.value != null ? nameInput.value : "").trim();
      const productName = rawName || cat || null;
      const cases = Math.max(0, Math.floor(Number(caseInput?.value) || 0));
      const boxes = Math.max(0, Math.floor(Number(boxInput?.value) || 0));
      patches.push({
        productSlug: slug,
        size,
        channel: "case",
        setOnHand: cases,
        track: true,
        ...(productName ? { productName } : {}),
      });
      patches.push({
        productSlug: slug,
        size,
        channel: "box",
        setOnHand: boxes,
        track: true,
        ...(productName ? { productName } : {}),
      });
    }

    if (!patches.length) {
      if (status) {
        status.textContent = "Nothing to save.";
      }
      return;
    }

    await fetchReportPost("/api/admin/inventory", session.access_token, {
      action: "stock_patch",
      patches,
      reason: "Admin manual on-hand (cases & boxes)",
    });
    if (status) {
      status.textContent = "Saved.";
    }
    await loadStock(session);
  } catch (e) {
    if (status) {
      status.textContent = e?.message || "Save failed.";
    }
    const errEl = document.getElementById("admin-load-error");
    if (errEl) {
      errEl.textContent = e?.message || "Save failed.";
      errEl.hidden = false;
    }
  } finally {
    if (btn) {
      btn.disabled = false;
    }
  }
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

  document.getElementById("inv-save-all")?.addEventListener("click", async () => {
    const { data: s } = await supabase.auth.getSession();
    if (!s?.session) {
      return;
    }
    await saveAllInventoryEdits(s.session);
  });
}

document.addEventListener("DOMContentLoaded", () => void init());
