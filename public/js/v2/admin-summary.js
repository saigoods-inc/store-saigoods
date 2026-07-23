/*
 * SAI Goods admin-v2 — Summary page controller.
 *
 * Reuses the existing auth + API helpers from ../admin-shared.js and reads the
 * unchanged GET /api/admin-summary endpoint. UI is built from the vanilla
 * primitives in ./ui.js. The current /admin dashboard is untouched.
 */

import { fetchReportJson, formatUsdCents } from "../admin-shared.js";

import {
  card,
  emptyState,
  escapeHtml,
  filterToolbar,
  icon,
  kpiCard,
  miniCard,
  placeholderTag,
  statusChip,
  tableShell,
  toast,
} from "./ui.js";

import { bootAdminV2Page } from "./page-boot.js";

let getToken = async () => undefined;
let currentPreset = "last30";

const PRESET_OPTIONS = [
  { value: "today", label: "Today" },
  { value: "last7", label: "Last 7 days" },
  { value: "last30", label: "Last 30 days" },
  { value: "month", label: "This month" },
  { value: "all", label: "All time" },
];

/* --------------------------------------------------------------- helpers */

function fmtCents(cents) {
  return formatUsdCents(Number(cents) || 0);
}

function fmtDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

function fmtBucketLabel(iso) {
  if (!iso) return "";
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
}

function shortRef(ref) {
  const s = String(ref || "—");
  return s.length > 16 ? `${s.slice(0, 15)}…` : s;
}

/** Map an order's fulfillment status to a chip. */
function orderStatusChip(orderStatus) {
  const s = String(orderStatus || "").toLowerCase();
  if (s === "shipped") return statusChip("Shipped", "success");
  if (s === "label_purchased") return statusChip("Label purchased", "info");
  if (s === "ready_to_ship") return statusChip("Ready to ship", "info");
  return statusChip("Paid", "brand");
}

function getEl(id) {
  return document.getElementById(id);
}

/* ---------------------------------------------------------------- sections */

function renderKpis(kpis) {
  const hasProfit = Number(kpis.currentProfitSnapshotOrders) > 0;
  const cards = [
    kpiCard({
      label: "Current Profit",
      value: hasProfit ? fmtCents(kpis.currentProfitCents) : "—",
      sub: hasProfit ? "Net after variable costs" : "No profit snapshots yet",
      iconName: "dollar-sign",
      danger: hasProfit && Number(kpis.currentProfitCents) < 0,
    }),
    kpiCard({
      label: "Total Orders",
      value: String(Number(kpis.totalOrders) || 0),
      sub: "Paid orders in range",
      iconName: "shopping-cart",
    }),
    kpiCard({
      label: "Total Revenue",
      value: fmtCents(kpis.totalRevenueCents),
      sub: "Gross paid revenue",
      iconName: "trending-up",
    }),
    kpiCard({
      label: "Average Order Value",
      value: fmtCents(kpis.averageOrderValueCents),
      sub: "Per paid order",
      iconName: "bar-chart-3",
    }),
  ];
  return `<div class="sg-grid sg-grid--kpi">${cards.join("")}</div>`;
}

function renderShippingMiniCards(kpis) {
  const hasVariance = Number(kpis.shippingVarianceOrders) > 0;
  const cards = [
    miniCard({
      label: "Shipping Expense",
      value: fmtCents(kpis.totalShippingExpenseCents),
      sub: `In selected range · ${Number(kpis.shippingKnownOrders) || 0} orders with label cost`,
      iconName: "truck",
    }),
    miniCard({
      label: "Profit from Shipping",
      value: hasVariance ? fmtCents(kpis.totalShippingVarianceCents) : "—",
      sub: hasVariance ? "In selected range · Charged minus label cost" : "In selected range · No variance data",
      iconName: "trending-up",
    }),
    miniCard({
      label: "Avg. Shipping Cost",
      value: fmtCents(kpis.averageShippingPerOrderCents),
      sub: "In selected range · Per order with known label cost",
      iconName: "dollar-sign",
    }),
  ];
  return `<div class="sg-stack">${cards.join("")}</div>`;
}

function alertMiniPanel(title, count, variant, rowsHtml) {
  return `<div class="sg-alert sg-alert--${variant}">
    <div class="sg-alert__head">
      <span class="sg-alert__title">${escapeHtml(title)}</span>
      <span class="sg-alert__count">${Number(count) || 0}</span>
    </div>
    <ul class="sg-alert__list">${rowsHtml}</ul>
  </div>`;
}

function renderAlerts(alerts) {
  const paidNotFulfilled = alerts.paidNotFulfilled || { count: 0, rows: [] };
  const outOfStock = alerts.inventoryOutOfStock || { count: 0, rows: [] };
  const lowStock = alerts.lowInventory || { count: 0, rows: [] };
  const onHold = alerts.incomingBatchesOnHold || { count: 0, rows: [] };

  const pnfRows =
    paidNotFulfilled.rows.slice(0, 4).map((r) =>
      `<li class="sg-alert__row"><span class="sg-mono">${escapeHtml(shortRef(r.orderRef))}</span>${orderStatusChip(
        r.orderStatus,
      )}</li>`,
    ).join("") || `<li class="sg-alert__row sg-muted">All caught up</li>`;

  const oosRows =
    outOfStock.rows.slice(0, 4).map((r) =>
      `<li class="sg-alert__row"><span>${escapeHtml(r.productName || r.displayText || "—")}</span><span class="sg-muted">${escapeHtml(
        r.size || "",
      )}</span></li>`,
    ).join("") || `<li class="sg-alert__row sg-muted">None</li>`;

  const lowRows =
    lowStock.rows.slice(0, 4).map((r) =>
      `<li class="sg-alert__row"><span>${escapeHtml(r.productName || "—")} / ${escapeHtml(
        r.size || "",
      )}</span><span class="sg-muted">${Number(r.availableBoxes) || 0} boxes</span></li>`,
    ).join("") || `<li class="sg-alert__row sg-muted">None</li>`;

  const holdRows =
    onHold.rows.slice(0, 4).map((r) =>
      `<li class="sg-alert__row"><span>${escapeHtml(r.batchName || r.containerNumber || "Batch")}</span><span class="sg-muted">${escapeHtml(
        r.etaDate || "—",
      )}</span></li>`,
    ).join("") || `<li class="sg-alert__row sg-muted">None</li>`;

  const grid = `<div class="sg-alert-grid">
    ${alertMiniPanel("Paid · Not Fulfilled", paidNotFulfilled.count, "warning", pnfRows)}
    ${alertMiniPanel("Out of Stock", outOfStock.count, "danger", oosRows)}
    ${alertMiniPanel("Low Stock", lowStock.count, "warning", lowRows)}
    ${alertMiniPanel("Incoming On Hold", onHold.count, "info", holdRows)}
  </div>`;

  return card({
    title: "Alerts & Watchouts",
    subtitle: "Current operational issues across all paid orders",
    bodyHtml: grid,
  });
}

function renderSalesOverview(summary) {
  const trend = Array.isArray(summary?.charts?.revenueTrend) ? summary.charts.revenueTrend : [];
  const totalRevenue = fmtCents(summary?.kpis?.totalRevenueCents);
  const bucketMode = summary?.dateRange?.bucketMode === "week" ? "Weekly" : "Daily";

  let body;
  if (!trend.length) {
    body = emptyState({ title: "No sales in this range", text: "Revenue will appear here once orders are paid." });
  } else {
    const max = Math.max(1, ...trend.map((p) => Number(p.revenueCents) || 0));
    const bars = trend
      .map((p) => {
        const h = Math.max(2, Math.round(((Number(p.revenueCents) || 0) / max) * 100));
        const label = fmtBucketLabel(p.bucketStart);
        const title = `${label}: ${fmtCents(p.revenueCents)}`;
        return `<div class="sg-chart__col" title="${escapeHtml(title)}">
          <div class="sg-chart__bar" style="height:${h}%"></div>
          <span class="sg-chart__x">${escapeHtml(label)}</span>
        </div>`;
      })
      .join("");
    body = `<div class="sg-chart">${bars}</div>
      <div class="sg-chart-legend">
        <span class="sg-legend__item"><span class="sg-legend__swatch" style="background:var(--sg-chart-1)"></span>Revenue (${escapeHtml(
          bucketMode,
        )})</span>
      </div>`;
  }

  return card({
    title: "Sales Overview",
    subtitle: `${totalRevenue} total paid revenue`,
    bodyHtml: body,
  });
}

function renderProductPerformance(summary) {
  const ranking = Array.isArray(summary?.breakdown?.productRanking) ? summary.breakdown.productRanking : [];
  if (!ranking.length) {
    return card({
      title: "Product Performance",
      bodyHtml: emptyState({ title: "No product sales yet", text: "Top products by revenue will appear here." }),
    });
  }
  const top = ranking.slice(0, 5);
  const max = Math.max(1, ...top.map((p) => Number(p.revenueCents) || 0));
  const items = top
    .map((p, i) => {
      const pct = Math.round(((Number(p.revenueCents) || 0) / max) * 100);
      return `<li>
        <div class="sg-rank__top">
          <span class="sg-rank__name">
            <span class="sg-rank__idx">${i + 1}</span>
            <span class="sg-rank__label">${escapeHtml(p.name || p.slug || "—")}</span>
          </span>
          <span class="sg-rank__value">
            <b>${fmtCents(p.revenueCents)}</b>
            <span>${Number(p.quantityUnits) || 0} units</span>
          </span>
        </div>
        <div class="sg-progress"><div class="sg-progress__fill" style="width:${pct}%"></div></div>
      </li>`;
    })
    .join("");
  return card({
    title: "Product Performance",
    subtitle: "Top products by paid revenue",
    bodyHtml: `<ul class="sg-rank-list">${items}</ul>`,
  });
}

function renderRecentOrders(summary) {
  const rows = Array.isArray(summary?.breakdown?.recentFinancialActivity)
    ? summary.breakdown.recentFinancialActivity
    : [];
  const bodyRows = rows
    .slice(0, 8)
    .map(
      (r) => `<tr>
        <td><span class="sg-mono">${escapeHtml(shortRef(r.orderRef))}</span></td>
        <td>${escapeHtml(r.customer || "—")}</td>
        <td>${orderStatusChip(r.orderStatus)}</td>
        <td class="sg-muted">${escapeHtml(r.quantityPreview || "—")}</td>
        <td class="sg-table__num">${fmtCents(r.revenueCents)}</td>
        <td class="sg-muted">${escapeHtml(fmtDate(r.paidAt))}</td>
      </tr>`,
    )
    .join("");

  const table = tableShell({
    columns: [
      { label: "Order" },
      { label: "Customer" },
      { label: "Status" },
      { label: "Items" },
      { label: "Total", align: "right" },
      { label: "Date" },
    ],
    rowsHtml: bodyRows,
    emptyHtml: emptyState({ title: "No recent orders", text: "Paid orders in this range will appear here." }),
  });

  const action = `<a class="sg-linkbtn" href="/admin-v2/orders">View all ${icon("arrow-up-right", 12)}</a>`;
  return card({ title: "Recent Orders", actionHtml: action, bodyHtml: table });
}

function renderInventoryHealth(alerts) {
  const outOfStock = alerts.inventoryOutOfStock || { count: 0, rows: [] };
  const lowStock = alerts.lowInventory || { count: 0, rows: [] };
  const onHold = alerts.incomingBatchesOnHold || { count: 0, rows: [] };

  const tiles = `<div class="sg-stat-tiles">
    <div class="sg-stat-tile sg-stat-tile--danger">
      <div class="sg-stat-tile__count">${Number(outOfStock.count) || 0}</div>
      <div class="sg-stat-tile__label">Out of Stock</div>
    </div>
    <div class="sg-stat-tile sg-stat-tile--warning">
      <div class="sg-stat-tile__count">${Number(lowStock.count) || 0}</div>
      <div class="sg-stat-tile__label">Low Stock</div>
    </div>
    <div class="sg-stat-tile sg-stat-tile--info">
      <div class="sg-stat-tile__count">${Number(onHold.count) || 0}</div>
      <div class="sg-stat-tile__label">Incoming Hold</div>
    </div>
  </div>`;

  const listItems = [
    ...outOfStock.rows.slice(0, 3).map((r) => ({
      name: `${r.productName || "—"} / ${r.size || ""}`,
      note: "Out of stock",
      danger: true,
    })),
    ...lowStock.rows.slice(0, 3).map((r) => ({
      name: `${r.productName || "—"} / ${r.size || ""}`,
      note: `Low — ${Number(r.availableBoxes) || 0} boxes left`,
      danger: false,
    })),
  ];

  const list = listItems.length
    ? `<ul class="sg-alert__list" style="margin-top:16px">${listItems
        .map(
          (it) =>
            `<li class="sg-alert__row"><span>${escapeHtml(it.name)}</span><span class="${
              it.danger ? "sg-chip sg-chip--danger" : "sg-chip sg-chip--warning"
            }">${escapeHtml(it.note)}</span></li>`,
        )
        .join("")}</ul>`
    : `<p class="sg-muted" style="margin-top:16px">All tracked variants are in stock.</p>`;

  const reviewBtn = `<div style="margin-top:16px"><a class="sg-btn sg-btn--primary sg-btn--block" href="/admin-v2/inventory">${icon(
    "package",
    14,
  )}<span>Review inventory</span></a></div>`;

  return card({ title: "Inventory Health", bodyHtml: tiles + list + reviewBtn });
}

function renderShippingZones(summary) {
  const zones = Array.isArray(summary?.breakdown?.shipping?.zones) ? summary.breakdown.shipping.zones : [];
  if (!zones.length) {
    return card({
      title: "Shipping Zone Ranking",
      subtitle: "Paid orders grouped by shipping zone",
      bodyHtml: emptyState({ title: "No US ZIP data", text: "Zones appear once paid orders have a US shipping ZIP." }),
    });
  }
  const maxOrders = Math.max(1, ...zones.map((z) => Number(z.orders) || 0));
  const items = zones
    .slice(0, 10)
    .map((z, i) => {
      const rank = i + 1;
      const pct = Math.round(((Number(z.orders) || 0) / maxOrders) * 100);
      const weight = z.totalWeightLb != null ? `${z.totalWeightLb} lb` : "—";
      return `<li class="sg-zone">
        <span class="sg-zone__rank ${rank === 1 ? "sg-zone__rank--1" : ""}">${rank}</span>
        <span class="sg-zone__name">Zone ${escapeHtml(String(z.zone ?? "—"))}</span>
        <span class="sg-zone__orders sg-table__num">${Number(z.orders) || 0} orders</span>
        <span class="sg-zone__share">
          <span class="sg-progress"><span class="sg-progress__fill ${
            rank === 1 ? "" : "sg-progress__fill--soft"
          }" style="width:${pct}%"></span></span>
        </span>
        <span class="sg-table__num sg-muted">${escapeHtml(weight)}</span>
      </li>`;
    })
    .join("");

  const action = `<a class="sg-linkbtn" href="/admin-v2/nexus">Nexus by state ${icon("arrow-up-right", 12)}</a>`;
  return card({
    title: "Shipping Zone Ranking",
    subtitle: "Paid orders grouped by shipping zone",
    actionHtml: action,
    bodyHtml: `<ul class="sg-zone-list">${items}</ul>`,
  });
}

/* --------------------------------------------------------------- page render */

function renderPage(summary) {
  const page = getEl("sg-page");
  if (!page) return;

  const rangeMeta = summary?.dateRange
    ? `${summary.dateRange.start} → ${summary.dateRange.end}`
    : "";

  // Single Refresh lives in the topbar; the header keeps only the date-range selector.
  const headerActions = filterToolbar({
    id: "sg-preset",
    options: PRESET_OPTIONS,
    selected: currentPreset,
  });

  page.innerHTML = `
    <div class="sg-page-header">
      <div>
        <h1 class="sg-page-header__title">Dashboard</h1>
        <p class="sg-page-header__subtitle">Sales, inventory, and fulfillment overview for SAI Goods online.</p>
        ${rangeMeta ? `<p class="sg-page-header__subtitle sg-muted">${escapeHtml(rangeMeta)}</p>` : ""}
      </div>
      <div class="sg-page-header__actions">${headerActions}</div>
    </div>

    ${renderKpis(summary.kpis || {})}

    <div class="sg-grid sg-grid--2">
      ${renderAlerts(summary.alerts || {})}
      ${renderShippingMiniCards(summary.kpis || {})}
    </div>

    <div class="sg-grid sg-grid--5-3-2">
      ${renderSalesOverview(summary)}
      ${renderProductPerformance(summary)}
    </div>

    <div class="sg-grid sg-grid--5-3-2">
      ${renderRecentOrders(summary)}
      ${renderInventoryHealth(summary.alerts || {})}
    </div>

    ${renderShippingZones(summary)}
  `;

  const presetSel = getEl("sg-preset");
  if (presetSel) {
    presetSel.addEventListener("change", () => {
      currentPreset = presetSel.value || "last30";
      loadSummary();
    });
  }
}

/* --------------------------------------------------------------- data load */

/** Monotonic generation so overlapping loads discard stale responses. */
let summaryLoadGen = 0;

async function loadSummary() {
  const page = getEl("sg-page");
  const alreadyLoaded = Boolean(page?.dataset?.loadedOnce);
  const gen = ++summaryLoadGen;
  if (page && !alreadyLoaded) {
    page.innerHTML = `<div class="sg-loading">Loading summary…</div>`;
  }
  try {
    const token = await getToken();
    const summary = await fetchReportJson(`/api/admin-summary?preset=${encodeURIComponent(currentPreset)}`, token);
    if (gen !== summaryLoadGen) return;
    renderPage(summary);
    if (page) page.dataset.loadedOnce = "1";
    const metaEl = getEl("sg-topbar-meta");
    if (metaEl && summary?.generatedAt) {
      metaEl.textContent = `Updated ${new Date(summary.generatedAt).toLocaleString()}`;
    }
    const warn = getEl("sg-summary-refresh-warn");
    if (warn) warn.remove();
  } catch (error) {
    if (gen !== summaryLoadGen) return;
    const message = error?.message || "Could not load summary.";
    if (!alreadyLoaded) {
      if (page) {
        page.innerHTML = `<div class="sg-error">${escapeHtml(message)}</div>`;
      }
      toast(message, "danger");
      return;
    }
    // Refresh failure: preserve last successful dashboard; toast only.
    toast(message, "danger");
    if (page && !getEl("sg-summary-refresh-warn")) {
      const banner = document.createElement("div");
      banner.id = "sg-summary-refresh-warn";
      banner.className = "sg-inline-warn";
      banner.setAttribute("role", "status");
      banner.style.margin = "0 0 12px";
      banner.innerHTML = `${icon("alert-triangle", 14)}<span>${escapeHtml(message)} Showing previously loaded summary.</span>`;
      page.prepend(banner);
    }
  }
}

/* --------------------------------------------------------------- app boot */

bootAdminV2Page({
  activeNav: "summary",
  onEnter: async (_session, ctx) => {
    getToken = ctx.getAccessToken;
    await loadSummary();
  },
  onRefresh: () => loadSummary(),
});
