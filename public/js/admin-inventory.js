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

/**
 * @param {number} cases
 * @param {number} boxes
 * @param {string} [suffix] e.g. "sold" or "left"
 */
function formatCasesBoxesLine(cases, boxes, suffix) {
  const c = Math.max(0, Math.floor(Number(cases) || 0));
  const b = Math.max(0, Math.floor(Number(boxes) || 0));
  const cLabel = c === 1 ? "Case" : "Cases";
  const bLabel = b === 1 ? "Box" : "Boxes";
  const tail = suffix ? ` ${suffix}` : "";
  return `${c} ${cLabel} ${b} ${bLabel}${tail}`;
}

/** Physical on-hand string for read-only stock column (e.g. "20 Cases 2 Boxes"). */
function formatCasesBoxesInStock(cases, boxes) {
  return formatCasesBoxesLine(cases, boxes, "");
}

/**
 * @param {object | null | undefined} editor
 */
function renderStockReadOnlyTable(editor) {
  const tbody = document.getElementById("inv-stock-readonly-tbody");
  if (!tbody) {
    return;
  }
  const groups = Array.isArray(editor?.groups) ? editor.groups : [];

  if (!groups.length) {
    tbody.innerHTML = `<tr><td colspan="3" class="admin-muted">No catalog products.</td></tr>`;
    return;
  }

  const rows = [];
  for (const g of groups) {
    const productName = escapeHtml(g.catalogProductName ?? g.productSlug ?? "");
    const list = Array.isArray(g.rows) ? g.rows : [];
    const n = list.length;
    if (!n) {
      continue;
    }

    for (let i = 0; i < n; i++) {
      const r = list[i];
      const size = escapeHtml(r.size);
      const c = Math.max(0, Math.floor(Number(r.casesOnHand) || 0));
      const b = Math.max(0, Math.floor(Number(r.boxesOnHand) || 0));
      const stockStr = escapeHtml(formatCasesBoxesInStock(c, b));

      if (i === 0) {
        rows.push(`<tr>
        <td class="inv-stock-readonly-product" rowspan="${n}">${productName}</td>
        <td class="inv-stock-readonly-size">${size}</td>
        <td class="inv-stock-readonly-qty">${stockStr}</td>
      </tr>`);
      } else {
        rows.push(`<tr>
        <td class="inv-stock-readonly-size">${size}</td>
        <td class="inv-stock-readonly-qty">${stockStr}</td>
      </tr>`);
      }
    }
  }

  tbody.innerHTML = rows.length ? rows.join("") : `<tr><td colspan="3" class="admin-muted">No rows.</td></tr>`;
}

/**
 * @param {object | null | undefined} overview
 * @param {number} [lineFallback]
 */
function renderSummary(overview, lineFallback = 0) {
  const s = overview?.summary || {};
  const soldEl = document.getElementById("inv-sum-sold");
  const remainingEl = document.getElementById("inv-sum-remaining");
  const toShipEl = document.getElementById("inv-sum-to-ship");
  const orderNote = document.getElementById("inv-order-metrics-note");

  if (soldEl) {
    soldEl.textContent = formatCasesBoxesLine(s.soldCases ?? 0, s.soldBoxes ?? 0, "sold");
    if (s.soldMixedPackSizes) {
      soldEl.title = "Products use different boxes-per-case; totals sum per product before display.";
    } else {
      soldEl.title = "";
    }
  }
  if (remainingEl) {
    remainingEl.textContent = formatCasesBoxesLine(s.remainingCases ?? 0, s.remainingBoxes ?? 0, "left");
    remainingEl.title = "";
  }
  if (toShipEl) {
    toShipEl.textContent = formatCasesBoxesLine(s.toShipCases ?? 0, s.toShipBoxes ?? 0, "");
    if (s.toShipMixedPackSizes) {
      toShipEl.title = "Products use different boxes-per-case; totals sum per product before display.";
    } else {
      toShipEl.title = "";
    }
  }

  if (orderNote) {
    if (s.orderMetricsAvailable === false) {
      orderNote.hidden = false;
      orderNote.textContent =
        "Sold and to-be-shipped totals need Supabase server credentials (SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY).";
    } else {
      orderNote.hidden = true;
      orderNote.textContent = "";
    }
  }

  const variants = s.activeVariantRows ?? 0;
  const lines = s.stockLineCount ?? lineFallback;
  const variantsEl = document.getElementById("inv-sum-variants");
  if (variantsEl) {
    variantsEl.textContent = `${variants} / ${lines}`;
  }
}

/**
 * @param {object | null | undefined} editor
 */
function renderEditorTable(editor) {
  const root = document.getElementById("inv-editor-groups");
  if (!root) {
    return;
  }
  const groups = Array.isArray(editor?.groups) ? editor.groups : [];

  if (!groups.length) {
    root.innerHTML = `<p class="admin-muted inv-editor-groups-empty">No catalog products.</p>`;
    return;
  }

  const thead = `<thead>
    <tr>
      <th scope="col">Size</th>
      <th scope="col" class="inv-editor-num">Cases in stock</th>
      <th scope="col" class="inv-editor-num">Boxes in stock</th>
    </tr>
  </thead>`;

  const html = [];
  for (const g of groups) {
    const title = escapeHtml(g.catalogProductName ?? g.productSlug ?? "");
    const slugSafe = escapeHtml(g.productSlug ?? "");
    const rows = [];
    for (const r of g.rows || []) {
      const slug = escapeHtml(r.productSlug);
      const size = escapeHtml(r.size);
      const cat = escapeHtml(r.catalogProductName ?? "");
      const c = Math.max(0, Math.floor(Number(r.casesOnHand) || 0));
      const b = Math.max(0, Math.floor(Number(r.boxesOnHand) || 0));
      rows.push(`<tr
        class="inv-editor-size-row"
        data-slug="${slug}"
        data-size="${size}"
        data-catalog-name="${cat}"
      >
        <td class="inv-editor-size-cell"><span class="admin-muted">${size}</span></td>
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
      </tr>`);
    }

    html.push(`<details class="inv-editor-accordion" data-product-slug="${slugSafe}">
      <summary class="inv-editor-product-title">
        <span class="inv-editor-product-title__text">${title}</span>
      </summary>
      <div class="inv-editor-accordion__panel">
        <table class="admin-table inv-editor-table inv-editor-subtable">
          ${thead}
          <tbody>${rows.join("")}</tbody>
        </table>
      </div>
    </details>`);
  }
  root.innerHTML = html.join("");
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
          "Customers see sellable stock as zero. Totals below still show physical on-hand for operations.";
      } else {
        banner.hidden = true;
        banner.textContent = "";
      }
    }
    renderSummary(overview, lineCount);
    renderStockReadOnlyTable(stock?.editor || null);
    renderEditorTable(stock?.editor || null);
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
  const root = document.getElementById("inv-editor-groups");
  if (!root) {
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
    for (const tr of root.querySelectorAll("tr.inv-editor-size-row[data-slug][data-size]")) {
      const slug = String(tr.dataset.slug || "").trim();
      const size = String(tr.dataset.size || "").trim();
      if (!slug || !size) {
        continue;
      }
      const caseInput = tr.querySelector('[data-field="cases"]');
      const boxInput = tr.querySelector('[data-field="boxes"]');
      const cases = Math.max(0, Math.floor(Number(caseInput?.value) || 0));
      const boxes = Math.max(0, Math.floor(Number(boxInput?.value) || 0));
      patches.push({
        productSlug: slug,
        size,
        channel: "case",
        setOnHand: cases,
        track: true,
      });
      patches.push({
        productSlug: slug,
        size,
        channel: "box",
        setOnHand: boxes,
        track: true,
      });
    }

    if (!patches.length) {
      if (status) {
        status.textContent = "Nothing to save.";
      }
      return;
    }

    await fetchReportPost("/api/admin-inventory", session.access_token, {
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
    if (s?.session) {
      await bootstrap(s.session);
    }
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
