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
  customSelect,
  emptyState,
  escapeHtml,
  filterToolbar,
  initCustomSelectboxes,
  icon,
  kpiCard,
  miniCard,
  statusChip,
  tableShell,
  toast,
} from "./ui.js";

import { bootAdminV2Page } from "./page-boot.js";

let getToken = async () => undefined;
let currentPreset = "all";
let currentProductPreset = "all";
let currentSalesOverviewProduct = "all";
let currentSalesOverviewPreset = "all";
let currentSummaryData = null;
let currentNexusData = null;
const summaryCache = new Map();
let nexusCache = null;

const PRESET_OPTIONS = [
  { value: "today", label: "Today" },
  { value: "last7", label: "Last 7 days" },
  { value: "last30", label: "Last 30 days" },
  { value: "month", label: "This month" },
  { value: "all", label: "All time" },
];

const PRODUCT_PRESET_OPTIONS = [
  { value: "last7", label: "Week" },
  { value: "month", label: "Month" },
  { value: "last30", label: "Last 30 days" },
  { value: "all", label: "All time" },
];

const SALES_OVERVIEW_PRESET_OPTIONS = [
  { value: "last7", label: "Weekly" },
  { value: "month", label: "Monthly" },
  { value: "last30", label: "Last 30 days" },
  { value: "all", label: "All time" },
];

const US_STATE_NAMES = {
  AL: "Alabama",
  AK: "Alaska",
  AZ: "Arizona",
  AR: "Arkansas",
  CA: "California",
  CO: "Colorado",
  CT: "Connecticut",
  DE: "Delaware",
  FL: "Florida",
  GA: "Georgia",
  HI: "Hawaii",
  ID: "Idaho",
  IL: "Illinois",
  IN: "Indiana",
  IA: "Iowa",
  KS: "Kansas",
  KY: "Kentucky",
  LA: "Louisiana",
  ME: "Maine",
  MD: "Maryland",
  MA: "Massachusetts",
  MI: "Michigan",
  MN: "Minnesota",
  MS: "Mississippi",
  MO: "Missouri",
  MT: "Montana",
  NE: "Nebraska",
  NV: "Nevada",
  NH: "New Hampshire",
  NJ: "New Jersey",
  NM: "New Mexico",
  NY: "New York",
  NC: "North Carolina",
  ND: "North Dakota",
  OH: "Ohio",
  OK: "Oklahoma",
  OR: "Oregon",
  PA: "Pennsylvania",
  RI: "Rhode Island",
  SC: "South Carolina",
  SD: "South Dakota",
  TN: "Tennessee",
  TX: "Texas",
  UT: "Utah",
  VT: "Vermont",
  VA: "Virginia",
  WA: "Washington",
  WV: "West Virginia",
  WI: "Wisconsin",
  WY: "Wyoming",
};

/* --------------------------------------------------------------- helpers */

function sectionTitleHtml(iconName, label) {
  return `${icon(iconName, 16)}<span>${escapeHtml(label)}</span>`;
}

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

function fmtBucketRangeLabel(iso, bucketMode) {
  if (!iso) return "";
  if (bucketMode !== "Weekly") {
    return fmtBucketLabel(iso);
  }
  const start = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(start.getTime())) return iso;
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 6);
  const startLabel = `${start.getUTCMonth() + 1}/${start.getUTCDate()}`;
  const endLabel = `${end.getUTCMonth() + 1}/${end.getUTCDate()}`;
  return `${startLabel}–${endLabel}`;
}

function fmtBucketTooltipLabel(iso, bucketMode) {
  if (!iso) return "";
  const start = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(start.getTime())) return fmtBucketRangeLabel(iso, bucketMode);
  if (bucketMode === "Weekly") {
    return fmtBucketRangeLabel(iso, bucketMode);
  }
  const weekday = start.toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
  return `${weekday} ${start.getUTCDate()}`;
}

function bucketStartForCadence(iso, cadence) {
  if (!iso) return "";
  if (cadence !== "week") {
    return iso;
  }
  const date = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return iso;
  const day = date.getUTCDay();
  const daysToMonday = day === 0 ? 6 : day - 1;
  date.setUTCDate(date.getUTCDate() - daysToMonday);
  return date.toISOString().slice(0, 10);
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

function presetLabel(options, value) {
  return options.find((option) => option.value === value)?.label || options[0]?.label || "All time";
}

function salesOverviewProductOptions(summary) {
  const products = Array.isArray(summary?.breakdown?.salesOverviewSeries?.products)
    ? summary.breakdown.salesOverviewSeries.products
    : [];
  return [
    { value: "all", label: "All Product" },
    ...products.map((product) => ({
      value: String(product.slug || "").trim() || "all",
      label: product.label || product.name || product.slug || "Product",
    })),
  ];
}

function salesOverviewPresetOptions() {
  return SALES_OVERVIEW_PRESET_OPTIONS;
}

function stateNameFromCode(code) {
  const key = String(code || "").trim().toUpperCase();
  return US_STATE_NAMES[key] || key || "—";
}

function signedCurrency(cents) {
  const amount = Number(cents) || 0;
  const abs = fmtCents(Math.abs(amount));
  return `${amount >= 0 ? "+" : "-"}${abs.replace(/^\$/, "$")}`;
}

function percentChangeLabel(currentCents, previousCents) {
  const current = Number(currentCents) || 0;
  const previous = Number(previousCents) || 0;
  if (previous <= 0) return null;
  return Math.round((Math.abs(current - previous) / previous) * 1000) / 10;
}

function growthSummaryFromTrend(trend) {
  const latest = trend.at(-1) || null;
  const previous = trend.at(-2) || null;
  if (!latest || !previous) return null;
  const deltaCents = (Number(latest.revenueCents) || 0) - (Number(previous.revenueCents) || 0);
  const percent = percentChangeLabel(latest.revenueCents, previous.revenueCents);
  if (percent == null) return null;
  return {
    deltaCents,
    percent,
    direction: deltaCents >= 0 ? "up" : "down",
  };
}

function productPerformanceCountLabel(product) {
  const orders = Number(product?.orderCount) || 0;
  if (orders > 0) return `${orders} ${orders === 1 ? "order" : "orders"}`;
  const units = Number(product?.quantityUnits) || 0;
  return `${units} ${units === 1 ? "unit" : "units"}`;
}

function resolveSalesOverviewSummary(summary) {
  if (currentSalesOverviewPreset === currentPreset) {
    return summary;
  }
  return summaryCache.get(currentSalesOverviewPreset) || null;
}

function nexusRows(nexusData) {
  return Array.isArray(nexusData?.summary) ? nexusData.summary : [];
}

function buildSalesOverviewRows(summary) {
  const revenueTrend = Array.isArray(summary?.charts?.revenueTrend) ? summary.charts.revenueTrend : [];
  const ordersTrend = Array.isArray(summary?.charts?.ordersTrend) ? summary.charts.ordersTrend : [];
  const variableCostTrend = Array.isArray(summary?.charts?.variableCostTrend) ? summary.charts.variableCostTrend : [];
  const netTrend = Array.isArray(summary?.charts?.netTrend) ? summary.charts.netTrend : [];
  const rows = new Map();

  const ensure = (bucketStart) => {
    const key = String(bucketStart || "");
    if (!rows.has(key)) {
      rows.set(key, {
        bucketStart: key,
        revenueCents: 0,
        orders: 0,
        shippingExpenseCents: 0,
        platformFeesCents: 0,
        netCents: 0,
      });
    }
    return rows.get(key);
  };

  for (const row of revenueTrend) {
    const hit = ensure(row?.bucketStart);
    hit.revenueCents = Number(row?.revenueCents) || 0;
  }
  for (const row of ordersTrend) {
    const hit = ensure(row?.bucketStart);
    hit.orders = Number(row?.orders) || 0;
  }
  for (const row of variableCostTrend) {
    const hit = ensure(row?.bucketStart);
    hit.shippingExpenseCents = Number(row?.shippingExpenseCents) || 0;
    hit.platformFeesCents = Number(row?.platformFeesCents) || 0;
  }
  for (const row of netTrend) {
    const hit = ensure(row?.bucketStart);
    hit.netCents = Number(row?.netCents) || 0;
  }

  return [...rows.values()].sort((a, b) => a.bucketStart.localeCompare(b.bucketStart));
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
      danger: hasVariance && Number(kpis.totalShippingVarianceCents) < 0,
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
    titleHtml: sectionTitleHtml("alert-triangle", "Alerts & Watchouts"),
    subtitle: "Current operational issues across all paid orders",
    bodyHtml: grid,
  });
}

function renderSalesOverview(summary, opts = {}) {
  const loading = opts.loading === true;
  const errorMessage = String(opts.errorMessage || "").trim();
  const resolvedSummary = resolveSalesOverviewSummary(summary);
  const activeSummary = resolvedSummary || summary;
  const trend = buildSalesOverviewRows(activeSummary);
  const productOptions = salesOverviewProductOptions(activeSummary);
  const presetOptions = salesOverviewPresetOptions();
  const resolvedProduct = productOptions.some((option) => option.value === currentSalesOverviewProduct)
    ? currentSalesOverviewProduct
    : "all";
  const resolvedPreset = presetOptions.some((option) => option.value === currentSalesOverviewPreset)
    ? currentSalesOverviewPreset
    : "all";
  const series = activeSummary?.breakdown?.salesOverviewSeries;
  const baseLegendProducts = Array.isArray(series?.products) ? series.products : [];
  const stackedBuckets = Array.isArray(series?.buckets) ? series.buckets : [];
  const bucketMode = activeSummary?.dateRange?.bucketMode === "week" ? "Weekly" : "Daily";
  const timeUnit = bucketMode === "Weekly" ? "week" : "day";
  const headerFilters = filterToolbar(
    {
      id: "sg-sales-product",
      options: productOptions,
      selected: resolvedProduct,
      ariaLabel: "Product filter",
    },
    customSelect({
      id: "sg-sales-preset",
      options: presetOptions,
      selected: resolvedPreset,
      ariaLabel: "Sales overview range filter",
    }),
  );

  currentSalesOverviewProduct = resolvedProduct;
  currentSalesOverviewPreset = resolvedPreset;

  if (loading) {
    return card({
      title: "Sales Overview",
      titleHtml: sectionTitleHtml("bar-chart-3", "Sales Overview"),
      actionHtml: headerFilters,
      className: "sg-sales-overview-card",
      bodyHtml: `<div class="sg-loading">Loading sales overview…</div>`,
    });
  }

  if (errorMessage) {
    return card({
      title: "Sales Overview",
      titleHtml: sectionTitleHtml("bar-chart-3", "Sales Overview"),
      actionHtml: headerFilters,
      className: "sg-sales-overview-card",
      bodyHtml: emptyState({ title: "Could not load sales overview", text: errorMessage }),
    });
  }

  const legendProducts =
    resolvedProduct === "all"
      ? baseLegendProducts
      : baseLegendProducts.filter((product) => String(product.slug || "").trim() === resolvedProduct);
  const bucketMap = new Map();
  const ensureBucket = (bucketStart) => {
    const key = String(bucketStart || "").trim();
    if (!bucketMap.has(key)) {
      bucketMap.set(key, {
        bucketStart: key,
        totalRevenueCents: 0,
        shippingExpenseCents: 0,
        orders: 0,
        netCents: 0,
        products: new Map(),
      });
    }
    return bucketMap.get(key);
  };

  for (const point of trend) {
    const bucket = ensureBucket(point.bucketStart);
    bucket.totalRevenueCents += Number(point.revenueCents) || 0;
    bucket.orders += Number(point.orders) || 0;
    bucket.netCents += Number(point.netCents) || 0;
  }

  for (const point of stackedBuckets) {
    const bucket = ensureBucket(point?.bucketStart);
    bucket.shippingExpenseCents += Number(point?.shippingExpenseCents) || 0;
    for (const product of Array.isArray(point?.products) ? point.products : []) {
      const slug = String(product?.slug || "").trim();
      if (!slug) continue;
      bucket.products.set(slug, {
        slug,
        name: product?.name || slug,
        label: product?.label || product?.name || slug,
        revenueCents: Number(product?.revenueCents) || 0,
      });
    }
  }

  const displayedBuckets = [...bucketMap.values()]
    .sort((a, b) => a.bucketStart.localeCompare(b.bucketStart))
    .map((bucket) => ({
      bucketStart: bucket.bucketStart,
      totalRevenueCents: bucket.totalRevenueCents,
      shippingExpenseCents: bucket.shippingExpenseCents,
      orders: bucket.orders,
      netCents: bucket.netCents,
      products: legendProducts.map((product) => ({
        slug: product.slug,
        name: product.name,
        label: product.label,
        revenueCents: Number(bucket.products.get(product.slug)?.revenueCents) || 0,
      })),
    }));

  const displayedTrend = displayedBuckets.map((bucket) => ({
    bucketStart: bucket.bucketStart,
    revenueCents:
      resolvedProduct === "all"
        ? bucket.totalRevenueCents
        : bucket.products.reduce((sum, product) => sum + (Number(product.revenueCents) || 0), 0),
    orders: bucket.orders,
    shippingExpenseCents: bucket.shippingExpenseCents,
    netCents: bucket.netCents,
  }));

  let body;
  if (!displayedTrend.length) {
    body = emptyState({ title: "No sales in this range", text: "Revenue will appear here once orders are paid." });
  } else {
    const totalRevenue = fmtCents(displayedTrend.reduce((sum, point) => sum + (Number(point.revenueCents) || 0), 0));
    const growth = growthSummaryFromTrend(displayedTrend);
    const stackTotals = displayedBuckets.map((bucket) =>
      resolvedProduct === "all"
        ? bucket.products.reduce((sum, product) => sum + (Number(product.revenueCents) || 0), 0) + (Number(bucket.shippingExpenseCents) || 0)
        : bucket.products.reduce((sum, product) => sum + (Number(product.revenueCents) || 0), 0),
    );
    const maxStack = Math.max(1, ...stackTotals, ...displayedTrend.map((point) => Number(point.revenueCents) || 0));
    const bars = displayedTrend
      .map((point, index) => {
        const bucket = displayedBuckets[index] || null;
        const stackTotal =
          resolvedProduct === "all"
            ? bucket?.products?.reduce((sum, product) => sum + (Number(product.revenueCents) || 0), 0) + (Number(bucket?.shippingExpenseCents) || 0)
            : bucket?.products?.reduce((sum, product) => sum + (Number(product.revenueCents) || 0), 0);
        const columnHeight = Math.max(8, Math.round(((stackTotal || Number(point.revenueCents) || 0) / maxStack) * 100));
        const label = fmtBucketLabel(point.bucketStart);
        const tooltipRows = [];
        const segmentParts = [];

        for (const [productIndex, product] of legendProducts.entries()) {
          const cents = Number(bucket?.products?.find((entry) => entry.slug === product.slug)?.revenueCents) || 0;
          tooltipRows.push(
            `<li><span class="sg-chart__tooltip-key"><span class="sg-legend__swatch sg-legend__swatch--${
              productIndex + 1
            }"></span>${escapeHtml(product.label || product.name || product.slug || "Product")}</span><strong>${fmtCents(
              cents,
            )}</strong></li>`,
          );
          if (!stackTotal || cents <= 0) continue;
          const basis = Math.max(4, Math.round((cents / stackTotal) * 1000) / 10);
          segmentParts.push(`<span class="sg-chart__segment sg-chart__segment--${productIndex + 1}" style="flex-basis:${basis}%"></span>`);
        }

        if (resolvedProduct === "all") {
          const shippingCents = Number(bucket?.shippingExpenseCents) || 0;
          tooltipRows.push(
            `<li><span class="sg-chart__tooltip-key"><span class="sg-legend__swatch sg-legend__swatch--shipping"></span>Shipping</span><strong>${fmtCents(
              shippingCents,
            )}</strong></li>`,
          );
          if (stackTotal && shippingCents > 0) {
            const shippingBasis = Math.max(4, Math.round((shippingCents / stackTotal) * 1000) / 10);
            segmentParts.push(`<span class="sg-chart__segment sg-chart__segment--shipping" style="flex-basis:${shippingBasis}%"></span>`);
          }
        }

        const segments = segmentParts.length
          ? segmentParts.join("")
          : `<span class="sg-chart__segment sg-chart__segment--1" style="flex-basis:100%"></span>`;
        const tooltip = `<div class="sg-chart__tooltip" role="presentation">
          <p class="sg-chart__tooltip-title">${escapeHtml(fmtBucketTooltipLabel(point.bucketStart, bucketMode))}</p>
          <ul class="sg-chart__tooltip-list">${tooltipRows.join("")}</ul>
        </div>`;
        return `<div class="sg-chart__col" tabindex="0">
          ${tooltip}
          <div class="sg-chart__stack" style="height:${columnHeight}%">${segments}</div>
          <span class="sg-chart__x">${escapeHtml(label)}</span>
        </div>`;
      })
      .join("");
    const heroMeta = growth
      ? `<div class="sg-sales-overview__trend sg-sales-overview__trend--${escapeHtml(growth.direction)}">
          <span class="sg-sales-overview__trend-pill">${icon(
            growth.direction === "up" ? "trending-up" : "trending-down",
            14,
          )}${escapeHtml(`${growth.percent}%`)}</span>
          <span class="sg-sales-overview__trend-copy">${escapeHtml(
            `${signedCurrency(growth.deltaCents)} vs previous ${timeUnit}`,
          )}</span>
        </div>`
      : `<p class="sg-sales-overview__trend-empty">Builds once there are at least two ${escapeHtml(timeUnit)}s in range.</p>`;
    const legendItems = legendProducts
      .map(
        (product, index) =>
          `<span class="sg-legend__item"><span class="sg-legend__swatch sg-legend__swatch--${index + 1}"></span>${escapeHtml(
            product.label || product.name || product.slug || "Product",
          )}</span>`,
      )
      .join("");
    const shippingLegend = `<span class="sg-legend__item"><span class="sg-legend__swatch sg-legend__swatch--shipping"></span>Shipping</span>`;
    body = `<div class="sg-sales-overview">
      <div class="sg-sales-overview__hero">
        <div class="sg-sales-overview__hero-copy">
          <p class="sg-sales-overview__hero-label">Paid revenue</p>
          <div class="sg-sales-overview__hero-row">
            <p class="sg-sales-overview__hero-value">${escapeHtml(totalRevenue)}</p>
            ${heroMeta}
          </div>
        </div>
      </div>
      <div class="sg-chart sg-chart--stacked" aria-label="Paid revenue by ${escapeHtml(timeUnit)}">${bars}</div>
      <div class="sg-chart-legend">
        ${legendItems}${resolvedProduct === "all" ? shippingLegend : ""}
      </div>
      <p class="sg-sales-overview__note">Showing the latest ${Math.min(displayedTrend.length, 6)} ${escapeHtml(
        timeUnit,
      )}${displayedTrend.length === 1 ? "" : "s"} in the selected range.</p>
    </div>`;
  }

  return card({
    title: "Sales Overview",
    titleHtml: sectionTitleHtml("bar-chart-3", "Sales Overview"),
    actionHtml: headerFilters,
    className: "sg-sales-overview-card",
    bodyHtml: body,
  });
}

function resolveProductPerformanceSummary(summary) {
  if (currentProductPreset === currentPreset) {
    return summary;
  }
  return summaryCache.get(currentProductPreset) || null;
}

function renderProductPerformance(summary, opts = {}) {
  const loading = opts.loading === true;
  const errorMessage = String(opts.errorMessage || "").trim();
  const filter = filterToolbar({
    id: "sg-product-preset",
    options: PRODUCT_PRESET_OPTIONS,
    selected: currentProductPreset,
  });
  const subtitle = `Top products by paid revenue · ${presetLabel(PRODUCT_PRESET_OPTIONS, currentProductPreset)}`;

  if (loading) {
    return card({
      title: "Product Performance",
      titleHtml: sectionTitleHtml("trending-up", "Product Performance"),
      subtitle,
      actionHtml: filter,
      className: "sg-product-performance-card",
      bodyHtml: `<div class="sg-loading">Loading product performance…</div>`,
    });
  }

  if (errorMessage) {
    return card({
      title: "Product Performance",
      titleHtml: sectionTitleHtml("trending-up", "Product Performance"),
      subtitle,
      actionHtml: filter,
      className: "sg-product-performance-card",
      bodyHtml: emptyState({ title: "Could not load product performance", text: errorMessage }),
    });
  }

  const ranking = Array.isArray(summary?.breakdown?.productRanking) ? summary.breakdown.productRanking : [];
  if (!ranking.length) {
    return card({
      title: "Product Performance",
      titleHtml: sectionTitleHtml("trending-up", "Product Performance"),
      subtitle,
      actionHtml: filter,
      className: "sg-product-performance-card",
      bodyHtml: emptyState({ title: "No product sales yet", text: "Top products by revenue will appear here." }),
    });
  }
  const top = ranking.slice(0, 4);
  const max = Math.max(1, ...top.map((p) => Number(p.revenueCents) || 0));
  const totalTrackedRevenue = ranking.reduce((sum, product) => sum + (Number(product.revenueCents) || 0), 0);
  const items = top
    .map((p, i) => {
      const pct = Math.round(((Number(p.revenueCents) || 0) / max) * 100);
      return `<li class="sg-product-performance__item">
        <div class="sg-product-performance__head">
          <span class="sg-product-performance__rank">${i + 1}</span>
          <span class="sg-product-performance__name">${escapeHtml(p.name || p.slug || "—")}</span>
          <span class="sg-product-performance__value">${fmtCents(p.revenueCents)}</span>
        </div>
        <div class="sg-product-performance__meta">${escapeHtml(productPerformanceCountLabel(p))}</div>
        <div class="sg-progress"><div class="sg-progress__fill" style="width:${pct}%"></div></div>
      </li>`;
    })
    .join("");
  return card({
    title: "Product Performance",
    titleHtml: sectionTitleHtml("trending-up", "Product Performance"),
    subtitle,
    actionHtml: filter,
    className: "sg-product-performance-card",
    bodyHtml: `<div class="sg-product-performance">
      <ul class="sg-rank-list sg-rank-list--performance">${items}</ul>
      <div class="sg-product-performance__footer">
        <div class="sg-product-performance__footer-row"><span>Total tracked</span><strong>${fmtCents(totalTrackedRevenue)}</strong></div>
        <div class="sg-product-performance__footer-row"><span>Products with sales</span><strong>${ranking.length}</strong></div>
      </div>
    </div>`,
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

  const action = `<a class="sg-btn sg-btn--ghost sg-btn--sm sg-card__action-link" href="/admin-v2/orders">View all ${icon(
    "arrow-up-right",
    12,
  )}</a>`;
  return card({
    title: "Recent Orders",
    titleHtml: sectionTitleHtml("shopping-cart", "Recent Orders"),
    actionHtml: action,
    className: "sg-summary-orders-card",
    bodyHtml: `<div class="sg-summary-orders">${table}</div>`,
  });
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

  return card({
    title: "Inventory Health",
    titleHtml: sectionTitleHtml("package", "Inventory Health"),
    bodyHtml: tiles + list + reviewBtn,
  });
}

function sortedNexusRevenueRows(nexusData) {
  return [...nexusRows(nexusData)].sort((a, b) => {
    const revenueDiff = (Number(b.total_revenue) || 0) - (Number(a.total_revenue) || 0);
    if (revenueDiff !== 0) return revenueDiff;
    return (Number(b.total_orders) || 0) - (Number(a.total_orders) || 0);
  });
}

function renderShippingZones(summary, nexusData) {
  const stateRows = sortedNexusRevenueRows(nexusData);
  if (stateRows.length) {
    const top = stateRows.slice(0, 7);
    const totalOrders = top.reduce((sum, row) => sum + (Number(row.total_orders) || 0), 0);
    const totalRevenue = top.reduce((sum, row) => sum + (Number(row.total_revenue) || 0), 0);
    const items = top
      .map((row, index) => {
        const stateCode = String(row.state || "").trim().toUpperCase() || "—";
        const revenueCents = Number(row.total_revenue) || 0;
        const orders = Number(row.total_orders) || 0;
        const sharePct = totalRevenue > 0 ? Math.max(0, Math.round((revenueCents / totalRevenue) * 100)) : 0;
        const avgOrder = orders > 0 ? Math.round(revenueCents / orders) : 0;
        return `<li class="sg-zone-state${index === 0 ? " is-top" : ""}">
          <div class="sg-zone-state__identity">
            <span class="sg-zone-state__rank">${index + 1}</span>
            <span class="sg-zone-state__badge">${escapeHtml(stateCode)}</span>
            <span class="sg-zone-state__name">
              <strong>${escapeHtml(stateNameFromCode(stateCode))}</strong>
              <span>${escapeHtml(stateCode)}</span>
            </span>
          </div>
          <span class="sg-zone-state__orders">${orders}</span>
          <span class="sg-zone-state__revenue">${fmtCents(revenueCents)}</span>
          <span class="sg-zone-state__share">
            <span class="sg-progress"><span class="sg-progress__fill ${index === 0 ? "" : "sg-progress__fill--soft"}" style="width:${sharePct}%"></span></span>
            <span>${sharePct}%</span>
          </span>
          <span class="sg-zone-state__avg">${fmtCents(avgOrder)}</span>
        </li>`;
      })
      .join("");
    const action = `<a class="sg-btn sg-btn--ghost sg-btn--sm sg-card__action-link" href="/admin-v2/nexus">View nexus ${icon(
      "arrow-up-right",
      12,
    )}</a>`;
    return card({
      title: "Shipping Zone Ranking",
      titleHtml: sectionTitleHtml("map-pin", "Shipping Zone Ranking"),
      subtitle: "States ranked by order volume and paid revenue",
      actionHtml: action,
      className: "sg-shipping-zone-card",
      bodyHtml: `<div class="sg-zone-state__head">
          <span>State</span>
          <span>Orders</span>
          <span>Revenue</span>
          <span>Share</span>
          <span>Avg. Order</span>
        </div>
        <ul class="sg-zone-state__list">${items}</ul>
        <div class="sg-zone-state__footer">
          <span>${top.length} states · ${totalOrders} total orders</span>
          <strong>${fmtCents(totalRevenue)} total revenue</strong>
        </div>`,
    });
  }

  const zones = Array.isArray(summary?.breakdown?.shipping?.zones) ? summary.breakdown.shipping.zones : [];
  if (!zones.length) {
    return card({
      title: "Shipping Zone Ranking",
      titleHtml: sectionTitleHtml("map-pin", "Shipping Zone Ranking"),
      subtitle: "Paid orders, revenue, and shipment weight by zone",
      bodyHtml: emptyState({ title: "No US ZIP data", text: "Zones appear once paid orders have a US shipping ZIP." }),
    });
  }
  const maxOrders = Math.max(1, ...zones.map((z) => Number(z.orders) || 0));
  const items = zones
    .slice(0, 10)
    .map((z, i) => {
      const rank = i + 1;
      const pct = Math.round(((Number(z.orders) || 0) / maxOrders) * 100);
      const share = `${pct}% share`;
      const weight = z.totalWeightLb != null ? `${z.totalWeightLb} lb shipped` : "Weight n/a";
      const revenue = fmtCents(z.revenueCents);
      const avg = fmtCents(z.averageOrderValueCents);
      return `<li class="sg-zone">
        <span class="sg-zone__rank ${rank === 1 ? "sg-zone__rank--1" : ""}">${rank}</span>
        <span class="sg-zone__name">Zone ${escapeHtml(String(z.zone ?? "—"))}</span>
        <span class="sg-zone__orders sg-table__num">${Number(z.orders) || 0} orders · ${escapeHtml(share)}</span>
        <span class="sg-zone__share">
          <span class="sg-progress"><span class="sg-progress__fill ${
            rank === 1 ? "" : "sg-progress__fill--soft"
          }" style="width:${pct}%"></span></span>
        </span>
        <span class="sg-zone__meta">
          <strong>Revenue ${escapeHtml(revenue)}</strong>
          <span class="sg-muted">Avg. order ${escapeHtml(avg)} · ${escapeHtml(weight)}</span>
        </span>
      </li>`;
    })
    .join("");

  const action = `<a class="sg-btn sg-btn--ghost sg-btn--sm sg-card__action-link" href="/admin-v2/nexus">Nexus by state ${icon(
    "arrow-up-right",
    12,
  )}</a>`;
  return card({
    title: "Shipping Zone Ranking",
    titleHtml: sectionTitleHtml("map-pin", "Shipping Zone Ranking"),
    subtitle: "Paid orders, revenue, and shipment weight by zone",
    actionHtml: action,
    bodyHtml: `<ul class="sg-zone-list">${items}</ul>`,
  });
}

function renderNexusPreview(nexusData) {
  const rows = sortedNexusRevenueRows(nexusData);
  if (!rows.length) return "";
  const top = rows.slice(0, 5);
  const highlightCount = Math.min(3, top.length);
  const action = `<a class="sg-btn sg-btn--ghost sg-btn--sm sg-card__action-link" href="/admin-v2/nexus">Full report ${icon(
    "arrow-up-right",
    12,
  )}</a>`;
  const cards = top
    .map((row, index) => {
      const stateCode = String(row.state || "").trim().toUpperCase() || "—";
      const active = index < highlightCount;
      const badge = active ? "Active" : "Monitor";
      return `<article class="sg-nexus-preview__state${active ? " is-active" : ""}">
        <div class="sg-nexus-preview__state-top">
          <span class="sg-nexus-preview__code">${escapeHtml(stateCode)}</span>
          <span class="sg-nexus-preview__chip">${escapeHtml(badge)}</span>
        </div>
        <p class="sg-nexus-preview__name">${escapeHtml(stateNameFromCode(stateCode))}</p>
        <p class="sg-nexus-preview__value">${fmtCents(row.total_revenue)}</p>
      </article>`;
    })
    .join("");
  return card({
    title: "Nexus by State",
    titleHtml: sectionTitleHtml("map-pin", "Nexus by State"),
    subtitle: "Sales tax nexus monitoring across active states",
    actionHtml: action,
    className: "sg-nexus-preview-card",
    bodyHtml: `<div class="sg-nexus-preview">${cards}</div>`,
  });
}

/* --------------------------------------------------------------- page render */

function renderPage(summary, nexusData = currentNexusData) {
  const page = getEl("sg-page");
  if (!page) return;

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
      </div>
      <div class="sg-page-header__actions">${headerActions}</div>
    </div>

    ${renderKpis(summary.kpis || {})}

    <div class="sg-grid sg-grid--2">
      ${renderAlerts(summary.alerts || {})}
      ${renderShippingMiniCards(summary.kpis || {})}
    </div>

    <div class="sg-grid sg-grid--5-3-2">
      <div id="sg-sales-overview-host">${renderSalesOverview(summary, {
        loading: currentSalesOverviewPreset !== currentPreset && !summaryCache.has(currentSalesOverviewPreset),
      })}</div>
      <div id="sg-product-performance-host">${renderProductPerformance(resolveProductPerformanceSummary(summary), {
        loading: currentProductPreset !== currentPreset && !summaryCache.has(currentProductPreset),
      })}</div>
    </div>

    <div class="sg-grid sg-grid--5-3-2">
      ${renderRecentOrders(summary)}
      ${renderInventoryHealth(summary.alerts || {})}
    </div>

    ${renderShippingZones(summary, nexusData)}
    ${renderNexusPreview(nexusData)}
  `;

  initCustomSelectboxes(page);

  const presetSel = getEl("sg-preset");
  if (presetSel && presetSel.dataset.bound !== "1") {
    presetSel.dataset.bound = "1";
    presetSel.addEventListener("change", () => {
      currentPreset = presetSel.value || "all";
      loadSummary();
    });
  }

  bindSalesOverviewFilters();
  bindProductPerformanceFilter();
}

function renderSalesOverviewHost(summary, opts = {}) {
  const host = getEl("sg-sales-overview-host");
  if (!host) return;
  host.innerHTML = renderSalesOverview(summary, opts);
  initCustomSelectboxes(host);
  bindSalesOverviewFilters();
}

function bindSalesOverviewFilters() {
  const productEl = getEl("sg-sales-product");
  if (productEl && productEl.dataset.bound !== "1") {
    productEl.dataset.bound = "1";
    productEl.addEventListener("change", () => {
      currentSalesOverviewProduct = productEl.value || "all";
      if (currentSummaryData) {
        renderSalesOverviewHost(currentSummaryData);
      }
    });
  }

  const salesPresetEl = getEl("sg-sales-preset");
  if (salesPresetEl && salesPresetEl.dataset.bound !== "1") {
    salesPresetEl.dataset.bound = "1";
    salesPresetEl.addEventListener("change", () => {
      currentSalesOverviewPreset = salesPresetEl.value || "all";
      void loadSalesOverview();
    });
  }
}

/* --------------------------------------------------------------- data load */

/** Monotonic generation so overlapping loads discard stale responses. */
let summaryLoadGen = 0;
let salesOverviewLoadGen = 0;
let productPerformanceLoadGen = 0;

async function loadSalesOverview(opts = {}) {
  if (!currentSummaryData) return;

  const summary = currentSummaryData;
  const force = opts.force === true;
  const gen = ++salesOverviewLoadGen;

  if (currentSalesOverviewPreset === currentPreset) {
    renderSalesOverviewHost(summary);
    return;
  }

  if (!force && summaryCache.has(currentSalesOverviewPreset)) {
    renderSalesOverviewHost(summary);
    return;
  }

  renderSalesOverviewHost(summary, { loading: true });

  try {
    const token = await getToken();
    await fetchSummaryForPreset(currentSalesOverviewPreset, token, { force });
    if (gen !== salesOverviewLoadGen) return;
    renderSalesOverviewHost(currentSummaryData);
  } catch (error) {
    if (gen !== salesOverviewLoadGen) return;
    const message = error?.message || "Could not load sales overview.";
    renderSalesOverviewHost(summary, { errorMessage: message });
    toast(message, "danger");
  }
}

async function fetchSummaryForPreset(preset, token, opts = {}) {
  const key = String(preset || "all");
  if (!opts.force && summaryCache.has(key)) {
    return summaryCache.get(key);
  }
  const summary = await fetchReportJson(`/api/admin-summary?preset=${encodeURIComponent(key)}`, token);
  summaryCache.set(key, summary);
  return summary;
}

function bindProductPerformanceFilter() {
  const productPresetEl = getEl("sg-product-preset");
  if (!productPresetEl || productPresetEl.dataset.bound === "1") return;
  productPresetEl.dataset.bound = "1";
  productPresetEl.addEventListener("change", () => {
    currentProductPreset = productPresetEl.value || "all";
    void loadProductPerformance();
  });
}

function renderProductPerformanceHost(summary, opts = {}) {
  const host = getEl("sg-product-performance-host");
  if (!host) return;
  host.innerHTML = renderProductPerformance(resolveProductPerformanceSummary(summary), opts);
  initCustomSelectboxes(host);
  bindProductPerformanceFilter();
}

async function loadProductPerformance(opts = {}) {
  if (!currentSummaryData) return;

  const summary = currentSummaryData;
  const force = opts.force === true;
  const gen = ++productPerformanceLoadGen;

  if (currentProductPreset === currentPreset) {
    renderProductPerformanceHost(summary);
    return;
  }

  if (!force && summaryCache.has(currentProductPreset)) {
    renderProductPerformanceHost(summary);
    return;
  }

  renderProductPerformanceHost(summary, { loading: true });

  try {
    const token = await getToken();
    await fetchSummaryForPreset(currentProductPreset, token, { force });
    if (gen !== productPerformanceLoadGen) return;
    renderProductPerformanceHost(currentSummaryData);
  } catch (error) {
    if (gen !== productPerformanceLoadGen) return;
    const message = error?.message || "Could not load product performance.";
    renderProductPerformanceHost(summary, { errorMessage: message });
    toast(message, "danger");
  }
}

async function loadSummary(opts = {}) {
  const page = getEl("sg-page");
  const alreadyLoaded = Boolean(page?.dataset?.loadedOnce);
  const gen = ++summaryLoadGen;
  const force = opts.force === true;
  if (page && !alreadyLoaded) {
    page.innerHTML = `<div class="sg-loading">Loading summary…</div>`;
  }
  try {
    const token = await getToken();
    const [summaryResult, nexusResult] = await Promise.allSettled([
      fetchSummaryForPreset(currentPreset, token, { force }),
      fetchNexusSummary(token, { force }),
    ]);
    if (summaryResult.status !== "fulfilled") {
      throw summaryResult.reason;
    }
    const summary = summaryResult.value;
    if (gen !== summaryLoadGen) return;
    currentSummaryData = summary;
    currentNexusData = nexusResult.status === "fulfilled" ? nexusResult.value : currentNexusData;
    renderPage(summary, currentNexusData);
    void loadSalesOverview({ force: force && currentSalesOverviewPreset !== currentPreset });
    void loadProductPerformance({ force: force && currentProductPreset !== currentPreset });
    if (page) page.dataset.loadedOnce = "1";
    const metaEl = getEl("sg-topbar-meta");
    if (metaEl && summary?.generatedAt) {
      metaEl.textContent = `Updated ${new Date(summary.generatedAt).toLocaleString()}`;
    }
    const warn = getEl("sg-summary-refresh-warn");
    if (warn) warn.remove();
    if (nexusResult.status !== "fulfilled" && nexusResult.reason?.message) {
      toast(`Nexus preview unavailable: ${nexusResult.reason.message}`, "danger");
    }
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

async function fetchNexusSummary(token, opts = {}) {
  if (!opts.force && nexusCache) {
    return nexusCache;
  }
  const data = await fetchReportJson("/api/nexus-summary", token);
  nexusCache = data;
  return data;
}

/* --------------------------------------------------------------- app boot */

bootAdminV2Page({
  activeNav: "summary",
  onEnter: async (_session, ctx) => {
    getToken = ctx.getAccessToken;
    await loadSummary();
  },
  onRefresh: () => loadSummary({ force: true }),
});
