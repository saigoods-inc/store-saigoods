/*
 * SAI Goods admin-v2 — Nexus by State page controller.
 *
 * Reuses ../admin-shared.js auth/API helpers and ./ui.js primitives. Reads the
 * unchanged GET /api/nexus-summary endpoint (cumulative paid revenue + order
 * count by destination state). Activity labels below are RELATIVE to observed
 * order volume only — they are NOT a legal nexus determination and no legal
 * thresholds are hard-coded.
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
  statusChip,
  tableShell,
  toast,
} from "./ui.js";

import { bootAdminV2Page } from "./page-boot.js";

let getToken = async () => undefined;
let nexusData = null;

/* --------------------------------------------------------------- helpers */

function fmtCents(cents) {
  return formatUsdCents(Number(cents) || 0);
}

function getEl(id) {
  return document.getElementById(id);
}

function nexusRows() {
  return Array.isArray(nexusData?.summary) ? nexusData.summary : [];
}

function maxOrders() {
  return Math.max(1, ...nexusRows().map((r) => Number(r.total_orders) || 0));
}

/**
 * Relative activity chip derived from observed order volume only.
 * Not a compliance signal.
 */
function activityChip(orders) {
  const n = Number(orders) || 0;
  if (n <= 0) return statusChip("No recent activity", "neutral");
  if (n >= 0.25 * maxOrders()) return statusChip("Higher volume", "success");
  return statusChip("Lower volume", "warning");
}

/* --------------------------------------------------------------- sections */

function renderKpis() {
  const rows = nexusRows();
  const states = rows.length;
  const revenue = rows.reduce((s, r) => s + (Number(r.total_revenue) || 0), 0);
  const orders = rows.reduce((s, r) => s + (Number(r.total_orders) || 0), 0);
  const top = [...rows].sort((a, b) => (Number(b.total_revenue) || 0) - (Number(a.total_revenue) || 0))[0];

  const cards = [
    kpiCard({ label: "States with Activity", value: String(states), sub: "Destinations with paid orders", iconName: "map-pin" }),
    kpiCard({ label: "Total Revenue", value: fmtCents(revenue), sub: "Cumulative paid", iconName: "dollar-sign" }),
    kpiCard({ label: "Total Orders", value: String(orders), sub: "Across all states", iconName: "shopping-cart" }),
    kpiCard({
      label: "Top State",
      value: top ? String(top.state) : "—",
      sub: top ? `${fmtCents(top.total_revenue)} paid` : "No data",
      iconName: "trending-up",
    }),
  ];
  return `<div class="sg-grid sg-grid--kpi">${cards.join("")}</div>`;
}

function renderBasisCard() {
  const generated = nexusData?.generated_at ? new Date(nexusData.generated_at).toLocaleString() : "";
  return card({
    title: "Monitoring basis",
    bodyHtml: `<div class="sg-meta-list">
        <div class="sg-meta-item">
          <p class="sg-meta-item__label">Scope</p>
          <p class="sg-meta-item__value">Cumulative paid revenue by destination state · ${escapeHtml(
            nexusData?.currency || "USD",
          )}</p>
        </div>
        ${generated ? `<div class="sg-meta-item"><p class="sg-meta-item__label">Snapshot</p><p class="sg-meta-item__value">${escapeHtml(generated)}</p></div>` : ""}
      </div>
      <p class="sg-meta-note">Activity labels are relative to observed order volume only. They are not a legal nexus determination and do not reflect any statutory thresholds.</p>`,
  });
}

function sortedNexusRows() {
  return [...nexusRows()].sort((a, b) => (Number(b.total_revenue) || 0) - (Number(a.total_revenue) || 0));
}

function tableRowsHtml() {
  return sortedNexusRows()
    .map(
      (r, idx) => `<tr class="sg-clickable" data-idx="${idx}" tabindex="0" aria-haspopup="dialog" aria-label="Open details dialog for ${escapeHtml(
        String(r.state || ""),
      )}">
        <td><strong>${escapeHtml(r.state)}</strong></td>
        <td class="sg-table__num">${fmtCents(r.total_revenue)}</td>
        <td class="sg-table__num">${Number(r.total_orders) || 0}</td>
        <td>${activityChip(r.total_orders)}</td>
      </tr>`,
    )
    .join("");
}

function renderTableCard() {
  const action = `<button type="button" class="sg-btn sg-btn--ghost sg-btn--sm" disabled title="Threshold configuration is not available yet">${icon(
    "arrow-up-right",
    14,
  )}<span>Configure thresholds</span></button>`;

  const table = tableShell({
    columns: [
      { label: "State" },
      { label: "Revenue", align: "right" },
      { label: "Orders", align: "right" },
      { label: "Activity" },
    ],
    rowsHtml: tableRowsHtml(),
    emptyHtml: emptyState({ title: "No paid orders yet", text: "State-by-state activity will appear here." }),
  });

  return card({ title: "State-by-state activity", actionHtml: action, bodyHtml: table });
}

function openStateDrawer(row) {
  if (!row) return;
  openDrawer({
    title: `${row.state}`,
    bodyHtml: `<div class="sg-detail-list">
        <div class="sg-detail-row"><span class="sg-detail-row__label">State</span><span class="sg-detail-row__value">${escapeHtml(
          row.state,
        )}</span></div>
        <div class="sg-detail-row"><span class="sg-detail-row__label">Total revenue</span><span class="sg-detail-row__value">${fmtCents(
          row.total_revenue,
        )}</span></div>
        <div class="sg-detail-row"><span class="sg-detail-row__label">Total orders</span><span class="sg-detail-row__value">${
          Number(row.total_orders) || 0
        }</span></div>
        <div class="sg-detail-row"><span class="sg-detail-row__label">Activity</span><span class="sg-detail-row__value">${activityChip(
          row.total_orders,
        )}</span></div>
      </div>
      <div style="margin-top:16px">${placeholderTag("Order-level detail")}</div>
      <p class="sg-note" style="margin-top:8px">Per-order breakdown for this state is not available from the nexus summary endpoint yet. This drawer shows the aggregated state totals only.</p>`,
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
  const rows = sortedNexusRows();
  document.querySelectorAll("#sg-nexus-table-host tr[data-idx]").forEach((tr) => {
    bindDetailRow(tr, () => {
      const idx = Number(tr.getAttribute("data-idx"));
      openStateDrawer(rows[idx]);
    });
  });
}

function renderPage() {
  const page = getEl("sg-page");
  if (!page) return;
  page.innerHTML = `
    <div class="sg-page-header">
      <div>
        <h1 class="sg-page-header__title">Nexus by State</h1>
        <p class="sg-page-header__subtitle">Monitor paid revenue and order activity by customer destination state.</p>
      </div>
    </div>
    ${renderKpis()}
    <div class="sg-grid sg-grid--2">
      <div id="sg-nexus-table-host">${renderTableCard()}</div>
      ${renderBasisCard()}
    </div>
  `;
  wireTableInteractions();
}

/* --------------------------------------------------------------- data load */

async function loadNexus() {
  const page = getEl("sg-page");
  if (page && !page.dataset.loadedOnce) {
    page.innerHTML = `<div class="sg-loading">Loading nexus monitoring…</div>`;
  }
  try {
    const token = await getToken();
    nexusData = await fetchReportJson("/api/nexus-summary", token);
    renderPage();
    if (page) page.dataset.loadedOnce = "1";
    const metaEl = getEl("sg-topbar-meta");
    if (metaEl && nexusData?.generated_at) {
      metaEl.textContent = `Updated ${new Date(nexusData.generated_at).toLocaleString()}`;
    }
  } catch (error) {
    if (page) page.innerHTML = `<div class="sg-error">${escapeHtml(error?.message || "Could not load nexus summary.")}</div>`;
    toast(error?.message || "Could not load nexus summary.", "danger");
  }
}

/* --------------------------------------------------------------- app boot */

bootAdminV2Page({
  activeNav: "nexus",
  onEnter: async (_session, ctx) => {
    getToken = ctx.getAccessToken;
    await loadNexus();
  },
  onRefresh: () => loadNexus(),
});
