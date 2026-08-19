/*
 * SAI Goods admin-v2 — Discount Codes page controller.
 *
 * Reuses ../admin-shared.js auth/API helpers and ./ui.js primitives. Reads the
 * unchanged GET /api/admin-discount-codes endpoint (read-only). Filtering,
 * search, and sort are client-side over the full returned set. No backend
 * mutations are performed here (the endpoint does not expose any).
 */

import { fetchReportJson } from "../admin-shared.js";

import { card, escapeHtml, icon, kpiCard, statusChip, toast } from "./ui.js";

import { bootAdminV2Page } from "./page-boot.js";

let getToken = async () => undefined;
/** @type {Array<{code:string,is_used:boolean,used_at?:string,used_by_order_id?:string,created_at?:string}>} */
let codesCache = [];

const SORT_OPTIONS = [
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
  { value: "code_az", label: "Code A–Z" },
  { value: "code_za", label: "Code Z–A" },
];

/* --------------------------------------------------------------- helpers */

function getEl(id) {
  return document.getElementById(id);
}

function fmtDateTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

function filterState() {
  return {
    status: getEl("sg-status-filter")?.value || "all",
    search: (getEl("sg-search")?.value || "").trim().toUpperCase(),
    sort: getEl("sg-sort")?.value || "newest",
  };
}

function filtersActive() {
  const { status, search, sort } = filterState();
  return status !== "all" || search !== "" || sort !== "newest";
}

function applyFilters() {
  const { status, search, sort } = filterState();
  let out = [...codesCache];

  if (status === "unused") out = out.filter((r) => !r.is_used);
  else if (status === "used") out = out.filter((r) => r.is_used);

  if (search) {
    out = out.filter(
      (r) =>
        String(r.code || "").toUpperCase().includes(search) ||
        String(r.used_by_order_id || "").toUpperCase().includes(search),
    );
  }

  out.sort((a, b) => {
    const ca = String(a.code || "");
    const cb = String(b.code || "");
    const ta = a.created_at ? new Date(a.created_at).getTime() : 0;
    const tb = b.created_at ? new Date(b.created_at).getTime() : 0;
    switch (sort) {
      case "oldest":
        return ta - tb;
      case "code_az":
        return ca.localeCompare(cb);
      case "code_za":
        return cb.localeCompare(ca);
      default:
        return tb - ta;
    }
  });

  return out;
}

/* --------------------------------------------------------------- sections */

function renderKpis() {
  const total = codesCache.length;
  const used = codesCache.filter((r) => r.is_used).length;
  const unused = total - used;
  const rate = total > 0 ? `${Math.round((used / total) * 100)}%` : "0%";

  const cards = [
    kpiCard({ label: "Total Codes", value: String(total), sub: "All generated codes", iconName: "tag" }),
    kpiCard({ label: "Unused Codes", value: String(unused), sub: "Available to redeem", iconName: "inbox" }),
    kpiCard({ label: "Used Codes", value: String(used), sub: "Already redeemed", iconName: "receipt" }),
    kpiCard({ label: "Usage Rate", value: rate, sub: "Used of total", iconName: "bar-chart-3" }),
    kpiCard({ label: "Local Discount Area", value: "Hardin County", sub: "Tennessee (TN)", iconName: "map-pin" }),
  ];
  return `<div class="sg-grid sg-grid--kpi-5">${cards.join("")}</div>`;
}

function toolbarHtml() {
  const statusOpts = [
    { value: "all", label: "All statuses" },
    { value: "unused", label: "Unused" },
    { value: "used", label: "Used" },
  ]
    .map((o) => `<option value="${o.value}">${escapeHtml(o.label)}</option>`)
    .join("");
  const sortOpts = SORT_OPTIONS.map(
    (o) => `<option value="${o.value}">${escapeHtml(o.label)}</option>`,
  ).join("");

  return `<div class="sg-toolbar" style="margin-bottom:16px">
    <select class="sg-select" id="sg-status-filter" aria-label="Filter by status">${statusOpts}</select>
    <input class="sg-input" id="sg-search" type="search" placeholder="Search code or order ID" aria-label="Search codes" />
    <select class="sg-select" id="sg-sort" aria-label="Sort codes">${sortOpts}</select>
    <button type="button" class="sg-btn sg-btn--ghost sg-btn--sm" id="sg-codes-refresh">${icon(
      "refresh-cw",
      14,
    )}<span>Refresh</span></button>
  </div>`;
}

function tableCard() {
  const table = `<div class="sg-table-wrap">
    <table class="sg-table">
      <thead>
        <tr>
          <th>Code</th>
          <th>Status</th>
          <th>Used At</th>
          <th>Order ID</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody id="sg-codes-tbody"></tbody>
    </table>
  </div>`;

  return card({ titleHtml: `${icon("tag", 16)}<span>Discount codes</span>`, bodyHtml: toolbarHtml() + table });
}

function infoCard() {
  return card({
    titleHtml: `${icon("info", 16)}<span>How these codes work</span>`,
    bodyHtml: `<p class="sg-meta-note" style="margin-top:0">One-time <code>HC-XXXXX</code> codes for eligible Hardin County (TN) customers. Each code applies once at checkout and is marked used automatically when its order is paid.</p>`,
  });
}

function emptyRowHtml(message, showClear) {
  const clearBtn = showClear
    ? `<div style="margin-top:12px"><button type="button" class="sg-btn sg-btn--ghost sg-btn--sm" id="sg-clear-filters">Clear filters</button></div>`
    : "";
  return `<tr><td colspan="5"><div class="sg-empty">
      <div class="sg-empty__icon">${icon("tag", 22)}</div>
      <p class="sg-empty__title">${escapeHtml(message)}</p>
      ${clearBtn}
    </div></td></tr>`;
}

function renderTableBody() {
  const tbody = getEl("sg-codes-tbody");
  if (!tbody) return;

  if (!codesCache.length) {
    tbody.innerHTML = emptyRowHtml("No discount codes found", false);
    return;
  }

  const rows = applyFilters();
  if (!rows.length) {
    tbody.innerHTML = emptyRowHtml("No codes match your filters", filtersActive());
    getEl("sg-clear-filters")?.addEventListener("click", clearFilters);
    return;
  }

  tbody.innerHTML = rows
    .map((r) => {
      const used = Boolean(r.is_used);
      const chip = used ? statusChip("Used", "success") : statusChip("Unused", "warning");
      const orderId = r.used_by_order_id ? escapeHtml(String(r.used_by_order_id)) : "—";
      const action = used
        ? `<button type="button" class="sg-btn sg-btn--ghost sg-btn--sm" disabled title="Order view isn't available in admin-v2 yet">View order</button>`
        : `<button type="button" class="sg-btn sg-btn--ghost sg-btn--sm" data-copy="${escapeHtml(
            r.code,
          )}">Copy code</button>`;
      return `<tr>
        <td><span class="sg-mono">${escapeHtml(r.code)}</span></td>
        <td>${chip}</td>
        <td class="sg-muted">${escapeHtml(fmtDateTime(r.used_at))}</td>
        <td class="sg-mono">${orderId}</td>
        <td>${action}</td>
      </tr>`;
    })
    .join("");

  tbody.querySelectorAll("button[data-copy]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const code = btn.getAttribute("data-copy") || "";
      try {
        await navigator.clipboard.writeText(code);
        toast("Code copied", "success");
      } catch {
        toast("Could not copy code", "danger");
      }
    });
  });
}

function clearFilters() {
  const statusSel = getEl("sg-status-filter");
  const searchInput = getEl("sg-search");
  const sortSel = getEl("sg-sort");
  if (statusSel) statusSel.value = "all";
  if (searchInput) searchInput.value = "";
  if (sortSel) sortSel.value = "newest";
  renderTableBody();
}

function renderPage() {
  const page = getEl("sg-page");
  if (!page) return;

  const generateBtn = `<button type="button" class="sg-btn sg-btn--ghost sg-btn--sm" disabled title="Code generation isn't supported yet">${icon(
    "tag",
    14,
  )}<span>Generate codes</span></button>`;

  page.innerHTML = `
    <div class="sg-page-header">
      <div>
        <h1 class="sg-page-header__title">Discount Codes</h1>
        <p class="sg-page-header__subtitle">View one-time Hardin County discount codes for eligible local customers (read-only).</p>
      </div>
      <div class="sg-page-header__actions">${generateBtn}</div>
    </div>
    ${renderKpis()}
    ${tableCard()}
    ${infoCard()}
  `;

  renderTableBody();

  getEl("sg-status-filter")?.addEventListener("change", renderTableBody);
  getEl("sg-search")?.addEventListener("input", renderTableBody);
  getEl("sg-sort")?.addEventListener("change", renderTableBody);
  getEl("sg-codes-refresh")?.addEventListener("click", () => loadCodes());
}

/* --------------------------------------------------------------- data load */

async function loadCodes() {
  const page = getEl("sg-page");
  if (page && !page.dataset.loadedOnce) {
    page.innerHTML = `<div class="sg-loading">Loading discount codes…</div>`;
  }
  try {
    const token = await getToken();
    const data = await fetchReportJson("/api/admin-discount-codes", token);
    codesCache = Array.isArray(data?.codes) ? data.codes : [];
    renderPage();
    if (page) page.dataset.loadedOnce = "1";
    const metaEl = getEl("sg-topbar-meta");
    if (metaEl && data?.generated_at) {
      metaEl.textContent = `Updated ${new Date(data.generated_at).toLocaleString()}`;
    }
  } catch (error) {
    if (page) page.innerHTML = `<div class="sg-error">${escapeHtml(error?.message || "Could not load discount codes.")}</div>`;
    toast(error?.message || "Could not load discount codes.", "danger");
  }
}

/* --------------------------------------------------------------- app boot */

bootAdminV2Page({
  activeNav: "discounts",
  onEnter: async (_session, ctx) => {
    getToken = ctx.getAccessToken;
    await loadCodes();
  },
  onRefresh: () => loadCodes(),
});
