/*
 * SAI Goods admin-v2 — Sales Tax page controller.
 *
 * Reuses ../admin-shared.js auth/API helpers and the vanilla primitives in
 * ./ui.js. Reads the unchanged GET /api/tax-summary endpoint. Amounts are in
 * cents; rows are Tennessee (TN) paid orders grouped by UTC month.
 */

import { fetchReportJson, formatUsdCents } from "../admin-shared.js";

import {
  card,
  emptyState,
  escapeHtml,
  icon,
  kpiCard,
  openDrawer,
  placeholderTag,
  tableShell,
  toast,
} from "./ui.js";

import { bootAdminV2Page } from "./page-boot.js";

let getToken = async () => undefined;
let taxData = null; // full API payload
let monthFilter = "all";

/* --------------------------------------------------------------- helpers */

function fmtCents(cents) {
  return formatUsdCents(Number(cents) || 0);
}

function getEl(id) {
  return document.getElementById(id);
}

function taxRows() {
  return Array.isArray(taxData?.summary) ? taxData.summary : [];
}

function filteredRows() {
  const rows = taxRows();
  if (monthFilter === "all") return rows;
  return rows.filter((r) => r.month === monthFilter);
}

function kpiScopeLabel() {
  return monthFilter === "all" ? "All months · TN paid orders" : `${monthFilter} · TN paid orders`;
}

/* --------------------------------------------------------------- sections */

function renderKpis() {
  const rows = filteredRows();
  const taxable = rows.reduce((s, r) => s + (Number(r.taxable_revenue) || 0), 0);
  const collected = rows.reduce((s, r) => s + (Number(r.tax_collected) || 0), 0);
  const orders = rows.reduce((s, r) => s + (Number(r.total_orders) || 0), 0);
  const months = new Set(rows.map((r) => r.month).filter(Boolean)).size;
  const scope = kpiScopeLabel();

  const cards = [
    kpiCard({ label: "Taxable Revenue", value: fmtCents(taxable), sub: scope, iconName: "dollar-sign" }),
    kpiCard({ label: "Tax Collected", value: fmtCents(collected), sub: scope, iconName: "receipt" }),
    kpiCard({ label: "Total Orders", value: String(orders), sub: scope, iconName: "shopping-cart" }),
    kpiCard({
      label: "Months Reported",
      value: String(months),
      sub: monthFilter === "all" ? "With paid TN activity" : "Selected month scope",
      iconName: "bar-chart-3",
    }),
  ];
  return `<div class="sg-grid sg-grid--kpi">${cards.join("")}</div>`;
}

function renderBasisCard() {
  const note = taxData?.note || "Tennessee (TN) paid orders only; months are UTC.";
  const currency = taxData?.currency || "USD";
  const precision = taxData?.amounts_in === "cents" ? "Cents-accurate" : "";
  const generated = taxData?.generated_at ? new Date(taxData.generated_at).toLocaleString() : "";
  return card({
    title: "Reporting basis",
    bodyHtml: `<div class="sg-meta-list">
      <div class="sg-meta-item">
        <p class="sg-meta-item__label">Currency</p>
        <p class="sg-meta-item__value">${escapeHtml(currency)}${precision ? ` · ${escapeHtml(precision)}` : ""}</p>
      </div>
      ${generated ? `<div class="sg-meta-item"><p class="sg-meta-item__label">Snapshot</p><p class="sg-meta-item__value">${escapeHtml(generated)}</p></div>` : ""}
    </div>
    <p class="sg-meta-note">${escapeHtml(note)}</p>`,
  });
}

function monthOptionsHtml() {
  const months = [...new Set(taxRows().map((r) => r.month))].filter(Boolean).sort().reverse();
  const opts = [`<option value="all"${monthFilter === "all" ? " selected" : ""}>All months</option>`]
    .concat(
      months.map(
        (m) => `<option value="${escapeHtml(m)}"${m === monthFilter ? " selected" : ""}>${escapeHtml(m)}</option>`,
      ),
    )
    .join("");
  return `<select class="sg-select" id="sg-month-filter" aria-label="Filter by month">${opts}</select>`;
}

function tableRowsHtml() {
  return filteredRows()
    .map(
      (r, idx) => `<tr class="sg-clickable" data-idx="${idx}" tabindex="0" aria-haspopup="dialog" aria-label="Open details dialog for ${escapeHtml(
        String(r.month || ""),
      )}">
        <td>${escapeHtml(r.month)}</td>
        <td>${escapeHtml(r.state)}</td>
        <td class="sg-table__num">${fmtCents(r.taxable_revenue)}</td>
        <td class="sg-table__num">${fmtCents(r.tax_collected)}</td>
        <td class="sg-table__num">${Number(r.total_orders) || 0}</td>
      </tr>`,
    )
    .join("");
}

function renderTableCard() {
  const toolbar = `<div class="sg-toolbar">${monthOptionsHtml()}
    <button type="button" class="sg-btn sg-btn--ghost sg-btn--sm" disabled title="Export is not available yet">${icon(
      "arrow-up-right",
      14,
    )}<span>Export</span></button>
  </div>`;

  const table = tableShell({
    columns: [
      { label: "Month" },
      { label: "State" },
      { label: "Taxable revenue", align: "right" },
      { label: "Tax collected", align: "right" },
      { label: "Orders", align: "right" },
    ],
    rowsHtml: tableRowsHtml(),
    emptyHtml: emptyState({ title: "No paid TN orders yet", text: "Monthly sales tax rows will appear here." }),
  });

  return card({ title: "Monthly sales tax", actionHtml: toolbar, bodyHtml: table });
}

function openMonthDrawer(row) {
  if (!row) return;
  openDrawer({
    title: `${row.month} · ${row.state}`,
    bodyHtml: `<div class="sg-detail-list">
        <div class="sg-detail-row"><span class="sg-detail-row__label">Month</span><span class="sg-detail-row__value">${escapeHtml(
          row.month,
        )}</span></div>
        <div class="sg-detail-row"><span class="sg-detail-row__label">State</span><span class="sg-detail-row__value">${escapeHtml(
          row.state,
        )}</span></div>
        <div class="sg-detail-row"><span class="sg-detail-row__label">Taxable revenue</span><span class="sg-detail-row__value">${fmtCents(
          row.taxable_revenue,
        )}</span></div>
        <div class="sg-detail-row"><span class="sg-detail-row__label">Tax collected</span><span class="sg-detail-row__value">${fmtCents(
          row.tax_collected,
        )}</span></div>
        <div class="sg-detail-row"><span class="sg-detail-row__label">Orders</span><span class="sg-detail-row__value">${
          Number(row.total_orders) || 0
        }</span></div>
      </div>
      <div style="margin-top:16px">${placeholderTag("Order-level detail")}</div>
      <p class="sg-note" style="margin-top:8px">Per-order breakdown for this month is not available from the tax summary endpoint yet. This drawer shows the aggregated monthly figures only.</p>`,
  });
}

function bindDetailRow(tr, open) {
  tr.addEventListener("click", open);
  tr.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      open();
    } else if (e.key === " " || e.key === "Spacebar") {
      e.preventDefault();
      open();
    }
  });
}

function wireTableInteractions() {
  const monthSel = getEl("sg-month-filter");
  if (monthSel) {
    monthSel.addEventListener("change", () => {
      monthFilter = monthSel.value || "all";
      const kpiHost = getEl("sg-tax-kpi-host");
      if (kpiHost) kpiHost.innerHTML = renderKpis();
      const host = getEl("sg-tax-table-host");
      if (host) {
        host.innerHTML = renderTableCard();
        wireTableInteractions();
      }
    });
  }
  const rows = filteredRows();
  document.querySelectorAll("#sg-tax-table-host tr[data-idx]").forEach((tr) => {
    bindDetailRow(tr, () => {
      const idx = Number(tr.getAttribute("data-idx"));
      openMonthDrawer(rows[idx]);
    });
  });
}

function renderPage() {
  const page = getEl("sg-page");
  if (!page) return;
  page.innerHTML = `
    <div class="sg-page-header">
      <div>
        <h1 class="sg-page-header__title">Sales Tax</h1>
        <p class="sg-page-header__subtitle">Review Tennessee taxable sales, collected tax, and monthly order totals.</p>
      </div>
    </div>
    <div id="sg-tax-kpi-host">${renderKpis()}</div>
    <div class="sg-grid sg-grid--2">
      <div id="sg-tax-table-host">${renderTableCard()}</div>
      ${renderBasisCard()}
    </div>
  `;
  wireTableInteractions();
}

/* --------------------------------------------------------------- data load */

async function loadTax() {
  const page = getEl("sg-page");
  if (page && !page.dataset.loadedOnce) {
    page.innerHTML = `<div class="sg-loading">Loading sales tax…</div>`;
  }
  try {
    const token = await getToken();
    taxData = await fetchReportJson("/api/tax-summary", token);
    renderPage();
    if (page) page.dataset.loadedOnce = "1";
    const metaEl = getEl("sg-topbar-meta");
    if (metaEl && taxData?.generated_at) {
      metaEl.textContent = `Updated ${new Date(taxData.generated_at).toLocaleString()}`;
    }
  } catch (error) {
    if (page) page.innerHTML = `<div class="sg-error">${escapeHtml(error?.message || "Could not load sales tax.")}</div>`;
    toast(error?.message || "Could not load sales tax.", "danger");
  }
}

/* --------------------------------------------------------------- app boot */

bootAdminV2Page({
  activeNav: "tax",
  onEnter: async (_session, ctx) => {
    getToken = ctx.getAccessToken;
    await loadTax();
  },
  onRefresh: () => loadTax(),
});
