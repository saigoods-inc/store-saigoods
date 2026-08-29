import { createClient } from "@supabase/supabase-js";
import {
  computeCurrentProfitContributionCents,
  computeLandedPlusSuppliesCents,
  computeShippingProfitCents,
  impliedPaidShippingCents,
  orderMissingQuotedShippingRevenue,
  resolveShippingExpenseForProfit,
  resolveShippingChargedToCustomerCents,
} from "./admin-summary-order-profit.js";
import { listIncomingInventoryBatches } from "./incoming-inventory-batches.js";
import { buildSummaryInventoryAlerts, readInventorySnapshot } from "./stock.js";
import { loadStore } from "./store.js";
import { coerceOrderIdForQuery } from "./orders.js";
import { extractZipFromText, normalizeUsZip, resolveShippingZip } from "./shipping.js";
import { getShippingZone } from "./shipping-zone-legacy.js";
import { marketplaceFinancialContribution } from "./marketplace-orders.js";

let cachedClient = null;

function getClient() {
  if (cachedClient) {
    return cachedClient;
  }
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("Supabase credentials are not configured.");
  }
  cachedClient = createClient(url, key, { auth: { persistSession: false } });
  return cachedClient;
}

function bundleUnitPriceCents(product, kind) {
  const bundles = Array.isArray(product?.bundles) ? product.bundles : [];
  const preferred = bundles.find((bundle) => bundle?.kind === kind && Number(bundle?.units) === 1);
  const cents = Number(preferred?.priceCents);
  return Number.isFinite(cents) ? Math.max(0, Math.round(cents)) : 0;
}

async function buildInventorySellThroughRevenueSummary() {
  const store = loadStore();
  const products = new Map((Array.isArray(store?.products) ? store.products : []).map((product) => [String(product.slug || ""), product]));
  const stock = await readInventorySnapshot();
  const lines = Array.isArray(stock?.lines) ? stock.lines : [];

  let totalRevenueCents = 0;
  let caseUnits = 0;
  let boxUnits = 0;

  for (const line of lines) {
    if (!line || typeof line !== "object") continue;
    if (line.track !== true || line.active === false) continue;
    const product = products.get(String(line.productSlug || "").trim());
    if (!product) continue;
    const channel = String(line.channel || "").trim().toLowerCase();
    const available = Math.max(0, Math.floor(Number(line.onHand || 0) - Number(line.reserved || 0)));
    if (available < 1) continue;
    if (channel === "case" || channel === "cases") {
      const priceCents = bundleUnitPriceCents(product, "case");
      totalRevenueCents += available * priceCents;
      caseUnits += available;
    } else if (channel === "box" || channel === "boxes") {
      const priceCents = bundleUnitPriceCents(product, "box");
      totalRevenueCents += available * priceCents;
      boxUnits += available;
    }
  }

  return { totalRevenueCents, caseUnits, boxUnits };
}

const SUMMARY_TIME_ZONE = "America/Chicago";
const summaryDateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: SUMMARY_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function calendarDatePartsFromIso(s) {
  const raw = String(s || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return null;
  }
  const [year, month, day] = raw.split("-").map(Number);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    return null;
  }
  return { year, month, day };
}

function calendarDatePartsAt(date) {
  const values = Object.fromEntries(summaryDateFormatter.formatToParts(date).map((part) => [part.type, part.value]));
  return { year: Number(values.year), month: Number(values.month), day: Number(values.day) };
}

function isoFromCalendarDate(parts) {
  return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function addCalendarDays(parts, days) {
  const d = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

function zonedMidnight(parts) {
  const desiredUtc = Date.UTC(parts.year, parts.month - 1, parts.day, 0, 0, 0);
  let candidate = new Date(desiredUtc);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const values = Object.fromEntries(summaryDateFormatter.formatToParts(candidate).map((part) => [part.type, part.value]));
    const representedUtc = Date.UTC(
      Number(values.year),
      Number(values.month) - 1,
      Number(values.day),
      Number(values.hour),
      Number(values.minute),
      Number(values.second),
    );
    candidate = new Date(candidate.getTime() + desiredUtc - representedUtc);
  }
  return candidate;
}

/**
 * Business reporting date range in America/Chicago.
 * `endExclusive` is used for filtering.
 */
export function buildSummaryDateRange(input = {}) {
  const now = input.now instanceof Date ? input.now : new Date(input.now || Date.now());
  const today = calendarDatePartsAt(now);
  const preset = String(input.preset || "last30").trim();

  let startParts = null;
  let endExclusiveParts = addCalendarDays(today, 1);
  let resolvedPreset = preset;

  if (preset === "today") {
    startParts = today;
  } else if (preset === "last7") {
    startParts = addCalendarDays(today, -6);
  } else if (preset === "last30") {
    startParts = addCalendarDays(today, -29);
  } else if (preset === "month") {
    startParts = { ...today, day: 1 };
  } else if (preset === "all") {
    startParts = { year: 1970, month: 1, day: 1 };
  } else if (preset === "custom") {
    const startCustom = calendarDatePartsFromIso(input.start);
    const endCustom = calendarDatePartsFromIso(input.end);
    if (!startCustom || !endCustom) {
      const e = new Error("Custom range requires valid start and end dates (YYYY-MM-DD).");
      e.statusCode = 400;
      throw e;
    }
    if (isoFromCalendarDate(endCustom) < isoFromCalendarDate(startCustom)) {
      const e = new Error("Custom range end date must be on or after start date.");
      e.statusCode = 400;
      throw e;
    }
    startParts = startCustom;
    endExclusiveParts = addCalendarDays(endCustom, 1);
  } else {
    resolvedPreset = "last30";
    startParts = addCalendarDays(today, -29);
  }

  const start = zonedMidnight(startParts);
  const endExclusive = zonedMidnight(endExclusiveParts);

  return {
    preset: resolvedPreset,
    start,
    endExclusive,
    startIsoDate: isoFromCalendarDate(startParts),
    endIsoDate: isoFromCalendarDate(addCalendarDays(endExclusiveParts, -1)),
  };
}

function paidAtDateForRow(row) {
  const raw = row?.paid_at || row?.created_at;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) {
    return null;
  }
  return d;
}

async function fetchMarketplaceSummaryRows(client, range, channel) {
  if (channel === "website") return [];
  let query = client.from("marketplace_orders").select("*").neq("status", "cancelled").order("sold_at", { ascending: false, nullsFirst: false });
  if (channel === "amazon" || channel === "walmart") query = query.eq("marketplace", channel);
  const { data: orders, error } = await query;
  if (error) {
    if (/PGRST20[25]|schema cache|marketplace_orders/i.test(String(error.message || ""))) return [];
    throw error;
  }
  const inRange = (orders || []).filter((order) => {
    const soldAt = new Date(order?.sold_at || order?.created_at);
    return !Number.isNaN(soldAt.getTime()) && soldAt >= range.start && soldAt < range.endExclusive;
  });
  const ids = inRange.map((order) => order.id).filter(Boolean);
  if (!ids.length) return [];
  const { data: lines, error: linesError } = await client.from("marketplace_order_lines").select("*").in("marketplace_order_id", ids);
  if (linesError) throw linesError;
  const byOrder = new Map();
  for (const line of lines || []) {
    const key = String(line.marketplace_order_id);
    byOrder.set(key, [...(byOrder.get(key) || []), line]);
  }
  return inRange.map((order) => ({ ...order, lines: byOrder.get(String(order.id)) || [] }));
}

export function orderGrossChargeCents(row) {
  const n = Number(row?.total_cents);
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
}

export function salesRevenueCentsForOrder(row) {
  const grossChargeCents = orderGrossChargeCents(row);
  const taxCents = Number(row?.tax_cents);
  const collectedTaxCents = Number.isFinite(taxCents) ? Math.max(0, Math.round(taxCents)) : 0;
  return Math.max(0, grossChargeCents - collectedTaxCents);
}

function orderRevenueCents(row) {
  return salesRevenueCentsForOrder(row);
}

/**
 * Payment processing fee only. Prefer Square's settled fee, then the frozen
 * order estimate, with the current online default only for legacy rows.
 */
export function platformFeeCentsForOrder(row) {
  const actual = Number(row?.actual_processing_fee_cents);
  if (row?.actual_processing_fee_cents != null && Number.isFinite(actual) && actual >= 0) {
    return Math.round(actual);
  }
  const estimated = Number(row?.estimated_processing_fee_cents);
  if (row?.estimated_processing_fee_cents != null && Number.isFinite(estimated) && estimated >= 0) {
    return Math.round(estimated);
  }
  const source = String(row?.order_source || "").trim().toLowerCase();
  const method = String(row?.payment_method || "").trim().toLowerCase();
  // Walk-in cash/check are in-person POS settlements without online processor fee.
  // Legacy walk-in paid rows may have null payment_method; treat them as in-person (fee 0) too.
  // Future card_present should use a dedicated fee profile (not online checkout fee).
  if (source === "walk_in" && (method === "" || method === "cash" || method === "check")) {
    return 0;
  }
  const grossCharge = orderGrossChargeCents(row);
  return Math.round(grossCharge * 0.033 + 30);
}

export function isSquareProcessedOrder(row) {
  const profile = String(row?.processing_fee_profile || "").trim().toLowerCase();
  if (profile.startsWith("square_")) return true;
  if (String(row?.payment_id || "").trim()) return true;
  const method = String(row?.payment_method || row?.manual_payment_method || "").trim().toLowerCase();
  return method.includes("square") || method === "card" || method === "card_present";
}

export function squareFeeQualityForOrder(row) {
  const actual = Number(row?.actual_processing_fee_cents);
  return row?.actual_processing_fee_cents != null && Number.isFinite(actual) && actual >= 0
    ? "actual"
    : "estimated";
}

/** Quality of the processing-fee value used in profit reporting. */
export function profitFeeQualityForOrder(row) {
  const actual = Number(row?.actual_processing_fee_cents);
  if (row?.actual_processing_fee_cents != null && Number.isFinite(actual) && actual >= 0) {
    return "actual";
  }
  const estimated = Number(row?.estimated_processing_fee_cents);
  if (row?.estimated_processing_fee_cents != null && Number.isFinite(estimated) && estimated >= 0) {
    return "estimated";
  }
  const source = String(row?.order_source || "").trim().toLowerCase();
  const method = String(row?.payment_method || "").trim().toLowerCase();
  return source === "walk_in" && (method === "" || method === "cash" || method === "check")
    ? "actual"
    : "estimated";
}

export function sumPurchasedShippoLabelCostCents(labelRows) {
  if (!Array.isArray(labelRows) || !labelRows.length) {
    return null;
  }
  let sum = 0;
  let purchasedCount = 0;
  for (const r of labelRows) {
    if (String(r?.status || "") !== "purchased") {
      continue;
    }
    purchasedCount += 1;
    const raw = r.label_cost_cents != null ? r.label_cost_cents : r.amount_cents;
    const cost = Number(raw);
    // A purchased carrier label cannot genuinely cost $0. Treat zero/missing
    // values as unreconciled so reporting can use the frozen selected-rate
    // estimate instead of silently understating shipping expense.
    if (!Number.isFinite(cost) || cost <= 0) {
      return null;
    }
    sum += Math.round(cost);
  }
  return purchasedCount > 0 ? sum : null;
}

/** Actual label spend: Shippo purchased rows, else an admin-recorded external label cost. */
function actualLabelCostCentsForOrder(row, labelRowsForOrder) {
  const fromShippo = sumPurchasedShippoLabelCostCents(labelRowsForOrder);
  if (fromShippo != null) {
    return fromShippo;
  }
  const ext = Number(row?.admin_external_label_cost_cents);
  if (Number.isFinite(ext) && ext > 0) {
    return Math.round(ext);
  }
  return null;
}

function allShippoLabelsPurchased(row, labelRowsForOrder) {
  const rows = Array.isArray(labelRowsForOrder) ? labelRowsForOrder : [];
  if (!rows.length) {
    return false;
  }
  const n = rows[0]?.parcel_count;
  const target = n != null && Number.isFinite(Number(n)) ? Math.max(0, Math.round(Number(n))) : rows.length;
  if (target <= 0) {
    return false;
  }
  const purchased = rows.filter((r) => String(r?.status || "") === "purchased").length;
  return purchased >= target;
}

function excludeFromPaidNotFulfilledAlert(row, labelRowsForOrder) {
  if (String(row?.order_status || "") === "label_purchased") {
    return true;
  }
  return allShippoLabelsPurchased(row, labelRowsForOrder);
}

async function fetchShippoLabelRowsByOrderId(client, orderIds) {
  const map = new Map();
  const ids = [...new Set(orderIds.map((id) => coerceOrderIdForQuery(id)).filter((id) => id != null && id !== ""))];
  if (!ids.length) {
    return map;
  }
  const chunkSize = 100;
  for (let i = 0; i < ids.length; i += chunkSize) {
    const slice = ids.slice(i, i + chunkSize);
    const { data, error } = await client
      .from("order_shippo_labels")
      .select("order_id,status,amount_cents,parcel_index,parcel_count")
      .in("order_id", slice);
    if (error) {
      break;
    }
    for (const lab of Array.isArray(data) ? data : []) {
      const oid = String(lab.order_id);
      if (!map.has(oid)) {
        map.set(oid, []);
      }
      map.get(oid).push(lab);
    }
  }
  for (const arr of map.values()) {
    arr.sort((a, b) => (Number(a.parcel_index) || 0) - (Number(b.parcel_index) || 0));
  }
  return map;
}

function hasPaidStatus(row) {
  return String(row?.status || "").toLowerCase() === "paid";
}

function bucketModeForDays(days) {
  return days > 60 ? "week" : "day";
}

function bucketKeyForDate(d, mode) {
  const local = calendarDatePartsAt(d);
  if (mode === "week") {
    const day = new Date(Date.UTC(local.year, local.month - 1, local.day)).getUTCDay(); // 0=Sun
    const daysToMonday = day === 0 ? 6 : day - 1;
    return isoFromCalendarDate(addCalendarDays(local, -daysToMonday));
  }
  return isoFromCalendarDate(local);
}

function blankTrendEntry() {
  return { revenueCents: 0, shippingExpenseCents: 0, platformFeesCents: 0, netCents: 0, orders: 0 };
}

function trimCustomerLabel(row) {
  const n = String(row?.customer_name || "").trim();
  const e = String(row?.customer_email || "").trim();
  return n || e || "—";
}

/** One-line product / quantity summary for recent-purchases table cells. */
function summarizeOrderItemsPreview(items) {
  const arr = Array.isArray(items) ? items : [];
  if (!arr.length) return { product: "—", quantity: "—" };
  if (arr.length === 1) {
    const L = arr[0];
    const name = String(L?.name || L?.shortName || L?.slug || "—").trim() || "—";
    const cases = Math.max(0, Math.floor(Number(L?.lineCases) || 0));
    const boxes = Math.max(0, Math.floor(Number(L?.lineBoxCount) || 0));
    let qty = "—";
    if (cases && boxes) qty = `${cases} cases, ${boxes} boxes`;
    else if (cases) qty = `${cases} cases`;
    else if (boxes) qty = `${boxes} boxes`;
    return { product: name, quantity: qty };
  }
  const totalCases = arr.reduce((s, L) => s + Math.max(0, Math.floor(Number(L?.lineCases) || 0)), 0);
  const totalBoxes = arr.reduce((s, L) => s + Math.max(0, Math.floor(Number(L?.lineBoxCount) || 0)), 0);
  const label = `${arr.length} line items`;
  let qty = "—";
  if (totalCases || totalBoxes) qty = `${totalCases} cases, ${totalBoxes} boxes`;
  return { product: label, quantity: qty };
}

/** Roll up quote line items by product slug for ranking + donut. */
function coerceJsonb(value) {
  if (value == null) {
    return null;
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    return value;
  }
  if (typeof value === "string") {
    const t = value.trim();
    if (!t) {
      return null;
    }
    try {
      const p = JSON.parse(t);
      if (p && typeof p === "object" && !Array.isArray(p)) {
        return p;
      }
    } catch {
      return null;
    }
  }
  return null;
}

/** US ZIP5 from structured ship-to or free-text customer address. */
function shippingZip5FromOrderRow(row) {
  const addr = coerceJsonb(row?.shipping_address);
  if (addr && typeof addr === "object") {
    const country = String(addr.country || addr.countryCode || "US")
      .trim()
      .toUpperCase();
    if (country && country !== "US" && country !== "USA" && country !== "UNITED STATES") {
      return null;
    }
    const fromStructured = normalizeUsZip(resolveShippingZip(addr) || addr.postalCode || addr.zip || addr.zipCode);
    if (fromStructured) {
      return fromStructured;
    }
  }
  const ca = String(row?.customer_address || "").trim();
  if (ca) {
    return extractZipFromText(ca);
  }
  return null;
}

/** Two-letter US ship-to state from structured address, with a legacy text fallback. */
function shippingStateFromOrderRow(row) {
  const addr = coerceJsonb(row?.shipping_address);
  const structured = String(addr?.state || addr?.stateCode || addr?.region || "").trim().toUpperCase();
  if (/^[A-Z]{2}$/.test(structured)) return structured;
  const legacy = String(row?.customer_address || "").toUpperCase().match(/(?:,|\s)([A-Z]{2})\s+\d{5}(?:-\d{4})?\b/);
  return legacy ? legacy[1] : null;
}

/**
 * Allocate order-level marketplace discount/refund cents over merchandise lines.
 * Uses largest remainders so the adjusted lines reconcile exactly to net merchandise.
 */
export function allocateMarketplaceNetLineRevenue(lines, discountCents = 0, refundCents = 0) {
  const source = Array.isArray(lines) ? lines : [];
  const gross = source.map((line) => Math.max(0, Math.round(Number(line?.line_revenue_cents) || 0)));
  const grossTotal = gross.reduce((sum, cents) => sum + cents, 0);
  const adjustment = Math.min(
    grossTotal,
    Math.max(0, Math.round(Number(discountCents) || 0)) + Math.max(0, Math.round(Number(refundCents) || 0)),
  );
  const netTarget = grossTotal - adjustment;
  if (grossTotal <= 0 || netTarget <= 0) return gross.map(() => 0);

  const allocations = gross.map((cents, index) => {
    const exact = (netTarget * cents) / grossTotal;
    const floor = Math.floor(exact);
    return { index, cents: floor, remainder: exact - floor };
  });
  let remaining = netTarget - allocations.reduce((sum, entry) => sum + entry.cents, 0);
  allocations
    .slice()
    .sort((left, right) => right.remainder - left.remainder || left.index - right.index)
    .forEach((entry) => {
      if (remaining > 0) {
        allocations[entry.index].cents += 1;
        remaining -= 1;
      }
    });
  return allocations.map((entry) => entry.cents);
}

/** Sum parcel weights (lb) from last Shippo parcel plan when present. */
function totalShipmentWeightLbFromOrder(row) {
  const audit = coerceJsonb(row?.shippo_parcel_audit_json);
  const parcels = audit?.requestParcels;
  if (!Array.isArray(parcels) || !parcels.length) {
    return null;
  }
  let sum = 0;
  let n = 0;
  for (const p of parcels) {
    const w = Number(p?.weight);
    if (!Number.isFinite(w) || w <= 0) {
      continue;
    }
    const unit = String(p?.mass_unit || "lb").trim().toLowerCase();
    const lb = unit === "oz" ? w / 16 : unit === "kg" ? w * 2.20462 : w;
    sum += lb;
    n += 1;
  }
  return n > 0 ? sum : null;
}

function accumulateProductRankingFromOrder(row, bySlug) {
  const items = Array.isArray(row?.items) ? row.items : [];
  const countedOrderSlugs = new Set();
  for (const line of items) {
    if (!line || typeof line !== "object") continue;
    const slug = String(line.slug || "").trim();
    if (!slug) continue;
    const displayName = String(line.name || line.shortName || slug).trim() || slug;
    const rev = Math.max(0, Math.round(Number(line.lineTotalCents) || 0));
    const cases = Math.max(0, Math.floor(Number(line.lineCases) || 0));
    const boxes = Math.max(0, Math.floor(Number(line.lineBoxCount) || 0));
    const qty = cases + boxes;
    const prev = bySlug.get(slug) || { slug, name: displayName, revenueCents: 0, quantityUnits: 0, orderCount: 0 };
    prev.revenueCents += rev;
    prev.quantityUnits += qty;
    if (!countedOrderSlugs.has(slug)) {
      prev.orderCount += 1;
      countedOrderSlugs.add(slug);
    }
    if (displayName.length > (prev.name?.length || 0)) prev.name = displayName;
    bySlug.set(slug, prev);
  }
}

function accumulateProductBucketSeriesFromOrder(row, bucketKey, byBucket) {
  const key = String(bucketKey || "").trim();
  if (!key) return;
  const items = Array.isArray(row?.items) ? row.items : [];
  if (!items.length) return;
  if (!byBucket.has(key)) {
    byBucket.set(key, new Map());
  }
  const bucket = byBucket.get(key);
  for (const line of items) {
    if (!line || typeof line !== "object") continue;
    const slug = String(line.slug || "").trim();
    if (!slug) continue;
    const displayName = String(line.name || line.shortName || slug).trim() || slug;
    const rev = Math.max(0, Math.round(Number(line.lineTotalCents) || 0));
    const prev = bucket.get(slug) || { slug, name: displayName, revenueCents: 0 };
    prev.revenueCents += rev;
    if (displayName.length > (prev.name?.length || 0)) prev.name = displayName;
    bucket.set(slug, prev);
  }
}

function productLegendLabel(name, slug) {
  const raw = String(name || slug || "Product").trim();
  if (/heavy\s*duty/i.test(raw)) return "Heavy Duty";
  if (/general/i.test(raw)) return "General";
  if (/exam/i.test(raw) || /standard/i.test(raw)) return "Exam Gloves";
  return raw
    .replace(/^Black\s+Nitrile\s+[–-]\s+/i, "")
    .replace(/^Nitrile(?:\s+Examination\s+Gloves?)?\s+[–-]\s+/i, "")
    .trim();
}

function isOrderShipped(row) {
  return String(row?.order_status || "") === "shipped" || Boolean(row?.admin_handoff_at);
}

/** @param {object} b raw incoming_inventory_batches row */
function mapIncomingBatchOnHoldSummaryRow(b) {
  const etaRaw = b?.eta_date != null ? String(b.eta_date).trim() : "";
  const arrivalRaw = b?.arrival_date != null ? String(b.arrival_date).trim() : "";
  const containerRaw = b?.container_number != null ? String(b.container_number).trim() : "";
  return {
    id: String(b?.id ?? ""),
    batchName: b?.batch_name != null ? String(b.batch_name) : "",
    status: String(b?.status ?? "on_hold"),
    containerNumber: containerRaw || null,
    etaDate: etaRaw ? etaRaw.slice(0, 10) : null,
    arrivalDate: arrivalRaw ? arrivalRaw.slice(0, 10) : null,
  };
}

async function fetchIncomingBatchesOnHoldSummary() {
  try {
    const raw = await listIncomingInventoryBatches({ status: "on_hold" });
    const rows = (Array.isArray(raw) ? raw : []).map(mapIncomingBatchOnHoldSummaryRow).filter((r) => r.id);
    return { count: rows.length, rows: rows.slice(0, 25) };
  } catch {
    return { count: 0, rows: [] };
  }
}

/**
 * Operational alerts for the summary dashboard — current unresolved issues across all paid orders.
 * Not scoped to the selected report date range (see `fetchAdminSummary` range filter for KPIs).
 *
 * @param {object[]} paidRows all paid orders (`status === paid`)
 * @param {Map<string, object[]>} labelRowsByOrderId Shippo label rows keyed by order id
 */
export function collectSummaryOrderAlerts(paidRows, labelRowsByOrderId) {
  const missingShipping = [];
  const paidNotFulfilled = [];
  const feeCalcIssues = [];
  const unusuallyHighShipping = [];
  const pendingShippingCost = [];

  for (const row of paidRows) {
    const paidAt = paidAtDateForRow(row);
    if (!paidAt) {
      continue;
    }

    const revenueCents = orderRevenueCents(row);
    const oid = String(row.id);
    const labelRowsForOrder = labelRowsByOrderId.get(oid) || [];
    const actualLabelCostCents = actualLabelCostCentsForOrder(row, labelRowsForOrder);
    const shippingExpense = resolveShippingExpenseForProfit(row, actualLabelCostCents);
    const shippingExpenseCents = shippingExpense.costCents;
    const orderRef = String(row.order_ref || "—");
    const paidAtIso = paidAt.toISOString();
    const orderStatus = String(row.order_status || "");

    if (orderMissingQuotedShippingRevenue(row)) {
      missingShipping.push({
        orderRef,
        paidAt: paidAtIso,
        reason: "Customer paid shipping (total − subtotal − tax) but quoted_shipping_amount_cents / base is missing or zero.",
      });
    }

    if (shippingExpense.quality === "pending") {
      pendingShippingCost.push({
        orderRef,
        paidAt: paidAtIso,
        fulfillmentMethod: String(row?.fulfillment_method || "carrier"),
        reason: "Carrier order has neither a purchased label cost nor a frozen selected rate.",
      });
    }

    if (!isOrderShipped(row) && !excludeFromPaidNotFulfilledAlert(row, labelRowsForOrder)) {
      paidNotFulfilled.push({
        orderRef,
        customer: trimCustomerLabel(row),
        paidAt: paidAtIso,
        orderStatus: orderStatus || "paid",
      });
    }

    if (!Number.isFinite(Number(row?.total_cents)) || Number(row?.total_cents) < 0) {
      feeCalcIssues.push({
        orderRef,
        paidAt: paidAtIso,
        reason: "Invalid total_cents; platform fee calculation may be unreliable.",
      });
    }

    if (shippingExpenseCents != null) {
      const highThreshold = Math.max(5000, Math.round(revenueCents * 0.35));
      if (shippingExpenseCents > highThreshold) {
        unusuallyHighShipping.push({
          orderRef,
          paidAt: paidAtIso,
          shippingExpenseCents,
          revenueCents,
        });
      }
    }
  }

  return { missingShipping, paidNotFulfilled, feeCalcIssues, unusuallyHighShipping, pendingShippingCost };
}

export async function fetchAdminSummary(input = {}) {
  const range = buildSummaryDateRange(input);
  const client = getClient();
  const channel = String(input.channel || "all").trim().toLowerCase();
  if (!["all", "website", "amazon", "walmart"].includes(channel)) {
    throw Object.assign(new Error("Summary channel must be All, Website, Amazon, or Walmart."), { statusCode: 400 });
  }

  // Pull only fields used by summary calculations and drilldowns.
  const { data, error } = await client
    .from("orders")
    .select(
      "id,order_ref,order_source,payment_id,payment_method,manual_payment_method,fulfillment_method,customer_name,customer_email,customer_address,status,order_status,total_cents,subtotal_cents,tax_cents,shipping_cents,paid_shipping_amount_cents,quoted_shipping_amount_cents,quoted_shipping_base_amount_cents,quoted_shipping_residential_surcharge_cents,quoted_shipping_total_cents,quoted_shipping_mode,quoted_shipping_status,paid_at,created_at,items,shipping_address,shippo_parcel_audit_json,admin_external_label_cost_cents,admin_external_carrier,shippo_label_carrier,shippo_selected_rate_object_id,shippo_shipment_rates_json,shippo_label_url,shippo_transaction_status,admin_handoff_at,merchandise_list_subtotal_cents,merchandise_discount_loss_cents,expected_profit_cents,built_in_shipping_allowance_cents,estimated_processing_fee_cents,actual_processing_fee_cents,processing_fee_status,processing_fee_profile",
    )
    .eq("status", "paid")
    .order("created_at", { ascending: false });

  if (error) {
    throw error;
  }

  const allPaidRows = channel === "all" || channel === "website"
    ? (Array.isArray(data) ? data : []).filter((row) => hasPaidStatus(row))
    : [];

  const paidRows = allPaidRows.filter((row) => {
    const paidAt = paidAtDateForRow(row);
    return paidAt && paidAt >= range.start && paidAt < range.endExclusive;
  });
  const marketplaceRows = await fetchMarketplaceSummaryRows(client, range, channel);

  const labelRowsByOrderId = await fetchShippoLabelRowsByOrderId(
    client,
    allPaidRows.map((r) => r.id),
  );

  let totalRevenueCents = 0;
  let totalNetMerchandiseRevenueCents = 0;
  let totalShippingRevenueCents = 0;
  let totalTaxCollectedCents = 0;
  let totalProductCostCents = 0;
  let totalPricingAdjustmentsCents = 0;
  let totalRefundsCents = 0;
  let totalOtherCostsCents = 0;
  let totalOrders = 0;
  let totalShippingExpenseCents = 0;
  let shippingKnownCount = 0;
  let totalPlatformFeesCents = 0;
  let totalSquareProcessingFeesCents = 0;
  let actualSquareProcessingFeesCents = 0;
  let estimatedSquareProcessingFeesCents = 0;
  let squareFeeOrders = 0;
  let actualSquareFeeOrders = 0;
  let estimatedSquareFeeOrders = 0;
  let profitSnapshotOrders = 0;
  let totalExpectedProfitCents = 0;
  let totalBuiltInShippingAllowanceCents = 0;
  let totalShippingVarianceCents = 0;
  let shippingVarianceOrders = 0;
  let totalDiscountLossCents = 0;
  let totalActualRealizedProfitCents = 0;
  let realizedProfitOrders = 0;
  let currentProfitCents = 0;
  let currentProfitSnapshotOrders = 0;
  let currentProfitEstimatedOrders = 0;
  let currentProfitPendingOrders = 0;
  let websiteOrders = 0;
  let marketplaceOrders = 0;
  let marketplaceProfitCompleteOrders = 0;
  let marketplaceProfitEstimatedOrders = 0;

  const latestShippingEntries = [];
  const zoneMap = new Map();
  const stateRevenueMap = new Map();
  const recentOrders = [];
  const productBySlug = new Map();
  const productRevenueByBucket = new Map();

  const trendMap = new Map();
  const dayCount = Math.max(
    1,
    Math.round(
      (Date.parse(`${range.endIsoDate}T00:00:00.000Z`) - Date.parse(`${range.startIsoDate}T00:00:00.000Z`)) /
        (24 * 60 * 60 * 1000),
    ) + 1,
  );
  const bucketMode = bucketModeForDays(dayCount);

  for (const row of paidRows) {
    const paidAt = paidAtDateForRow(row);
    if (!paidAt) {
      continue;
    }

    const revenueCents = orderRevenueCents(row);
    const oid = String(row.id);
    const labelRowsForOrder = labelRowsByOrderId.get(oid) || [];
    const actualLabelCostCents = actualLabelCostCentsForOrder(row, labelRowsForOrder);
    const shippingExpense = resolveShippingExpenseForProfit(row, actualLabelCostCents);
    const shippingExpenseCents = shippingExpense.costCents;
    const feeCents = platformFeeCentsForOrder(row);
    const netCents = revenueCents - (shippingExpenseCents || 0) - feeCents;

    const expProf =
      row?.expected_profit_cents != null && Number.isFinite(Number(row.expected_profit_cents))
        ? Math.round(Number(row.expected_profit_cents))
        : null;
    const shippingCharged = resolveShippingChargedToCustomerCents(row);
    const builtInShip =
      row?.built_in_shipping_allowance_cents != null && Number.isFinite(Number(row.built_in_shipping_allowance_cents))
        ? Math.round(Number(row.built_in_shipping_allowance_cents))
        : null;
    const discLoss =
      row?.merchandise_discount_loss_cents != null && Number.isFinite(Number(row.merchandise_discount_loss_cents))
        ? Math.max(0, Math.round(Number(row.merchandise_discount_loss_cents)))
        : 0;
    const landedPlusSuppliesCents = computeLandedPlusSuppliesCents(row);
    const shippingRevenueCents = shippingCharged != null
      ? Math.min(revenueCents, Math.max(0, Math.round(shippingCharged)))
      : Math.min(revenueCents, impliedPaidShippingCents(row));
    const netMerchandiseRevenueCents = Math.max(0, revenueCents - shippingRevenueCents);

    const shippingBaselineCents =
      shippingCharged != null ? shippingCharged : builtInShip != null ? builtInShip : null;
    let shippingVarianceCents = null;
    if (shippingBaselineCents != null && shippingExpenseCents != null) {
      shippingVarianceCents = computeShippingProfitCents(shippingBaselineCents, shippingExpenseCents);
      if (shippingVarianceCents != null) {
        totalShippingVarianceCents += shippingVarianceCents;
        shippingVarianceOrders += 1;
      }
    }

    let actualRealizedProfitCents = null;
    let actualRealizedProfitPending = false;
    if (expProf != null && builtInShip != null) {
      profitSnapshotOrders += 1;
      totalExpectedProfitCents += expProf;
      totalBuiltInShippingAllowanceCents += builtInShip;
      totalDiscountLossCents += discLoss;
      if (shippingExpense.quality === "actual" && shippingExpenseCents != null && shippingVarianceCents != null) {
        actualRealizedProfitCents = expProf + shippingVarianceCents - discLoss;
        totalActualRealizedProfitCents += actualRealizedProfitCents;
        realizedProfitOrders += 1;
      } else {
        actualRealizedProfitPending = true;
      }
    }

    const currentContribution = computeCurrentProfitContributionCents(row, shippingExpenseCents, feeCents);
    if (currentContribution != null) {
      currentProfitCents += currentContribution;
      currentProfitSnapshotOrders += 1;
      if (shippingExpense.quality === "estimated" || profitFeeQualityForOrder(row) === "estimated") {
        currentProfitEstimatedOrders += 1;
      }
    } else {
      currentProfitPendingOrders += 1;
    }

    const zip5 = shippingZip5FromOrderRow(row);
    if (zip5) {
      const zNum = getShippingZone(zip5);
      if (!zoneMap.has(zNum)) {
        zoneMap.set(zNum, {
          zone: zNum,
          orders: 0,
          totalWeightLb: 0,
          ordersWithWeight: 0,
          revenueCents: 0,
        });
      }
      const zst = zoneMap.get(zNum);
      zst.orders += 1;
      zst.revenueCents += revenueCents;
      const wlb = totalShipmentWeightLbFromOrder(row);
      if (wlb != null) {
        zst.totalWeightLb += wlb;
        zst.ordersWithWeight += 1;
      }
    }

    const state = shippingStateFromOrderRow(row);
    if (state) {
      const stateEntry = stateRevenueMap.get(state) || { state, total_revenue: 0, total_orders: 0 };
      stateEntry.total_revenue += revenueCents;
      stateEntry.total_orders += 1;
      stateRevenueMap.set(state, stateEntry);
    }

    totalOrders += 1;
    websiteOrders += 1;
    totalRevenueCents += revenueCents;
    totalNetMerchandiseRevenueCents += netMerchandiseRevenueCents;
    totalShippingRevenueCents += shippingRevenueCents;
    totalTaxCollectedCents += Math.max(0, Math.round(Number(row?.tax_cents) || 0));
    totalPricingAdjustmentsCents += discLoss;
    if (landedPlusSuppliesCents != null) totalProductCostCents += landedPlusSuppliesCents;
    totalPlatformFeesCents += feeCents;
    if (isSquareProcessedOrder(row)) {
      totalSquareProcessingFeesCents += feeCents;
      squareFeeOrders += 1;
      if (squareFeeQualityForOrder(row) === "actual") {
        actualSquareProcessingFeesCents += feeCents;
        actualSquareFeeOrders += 1;
      } else {
        estimatedSquareProcessingFeesCents += feeCents;
        estimatedSquareFeeOrders += 1;
      }
    }
    if (shippingExpenseCents != null) {
      totalShippingExpenseCents += shippingExpenseCents;
      shippingKnownCount += 1;
    }

    const bucketKey = bucketKeyForDate(paidAt, bucketMode);
    if (!trendMap.has(bucketKey)) {
      trendMap.set(bucketKey, blankTrendEntry());
    }
    const bucket = trendMap.get(bucketKey);
    bucket.revenueCents += revenueCents;
    bucket.shippingExpenseCents += shippingExpenseCents || 0;
    bucket.platformFeesCents += feeCents;
    bucket.netCents += netCents;
    bucket.orders += 1;

    accumulateProductBucketSeriesFromOrder(row, bucketKey, productRevenueByBucket);

    const carrier = String(row?.admin_external_carrier || row?.shippo_label_carrier || "Unknown").trim() || "Unknown";

    const recentRow = {
      orderId: String(coerceOrderIdForQuery(row.id)),
      orderRef: String(row.order_ref || "—"),
      customer: trimCustomerLabel(row),
      paidAt: paidAt.toISOString(),
      revenueCents,
      shippingExpenseCents,
      platformFeeCents: feeCents,
      netCents,
      orderStatus: String(row.order_status || ""),
      channel: "website",
      listMerchandiseSubtotalCents:
        row?.merchandise_list_subtotal_cents != null && Number.isFinite(Number(row.merchandise_list_subtotal_cents))
          ? Math.round(Number(row.merchandise_list_subtotal_cents))
          : null,
      expectedProfitCents: expProf,
      builtInShippingAllowanceCents: builtInShip,
      shippingChargedCents: shippingCharged,
      shippingVarianceCents,
      discountLossCents: discLoss,
      actualRealizedProfitCents,
      actualRealizedProfitPending,
      currentProfitCents: currentContribution,
      currentProfitEstimated:
        currentContribution != null && (shippingExpense.quality === "estimated" || profitFeeQualityForOrder(row) === "estimated"),
      shippingChargedToCustomerCents: shippingCharged,
      actualLabelCostCents,
      impliedPaidShippingCents: impliedPaidShippingCents(row),
      landedPlusSuppliesCents,
      shippingCostCents: shippingExpenseCents,
      currentProfitStatus:
        currentContribution == null
          ? "pending"
          : shippingExpense.quality === "estimated" || profitFeeQualityForOrder(row) === "estimated"
            ? "estimated"
            : "actual",
      shippingZone: zip5 ? getShippingZone(zip5) : null,
    };
    const itemPreview = summarizeOrderItemsPreview(row.items);
    recentRow.productPreview = itemPreview.product;
    recentRow.quantityPreview = itemPreview.quantity;
    accumulateProductRankingFromOrder(row, productBySlug);
    recentOrders.push(recentRow);

    if (shippingExpenseCents != null) {
      latestShippingEntries.push({
        orderRef: recentRow.orderRef,
        paidAt: recentRow.paidAt,
        carrier,
        shippingExpenseCents,
      });
    }
  }

  const productNames = new Map((loadStore()?.products || []).map((product) => [String(product.slug || ""), String(product.name || product.slug || "Product")]));
  for (const row of marketplaceRows) {
    const soldAt = new Date(row?.sold_at || row?.created_at);
    if (Number.isNaN(soldAt.getTime())) continue;
    const contribution = marketplaceFinancialContribution(row);
    const financialComplete = String(row?.financial_status || "estimated") !== "estimated" &&
      (row.lines || []).length > 0 && (row.lines || []).every((line) => line?.line_cost_cents != null && line?.line_revenue_cents != null);
    const marketplaceName = String(row?.marketplace || "marketplace").toLowerCase();
    const orderRef = `${marketplaceName === "amazon" ? "Amazon" : "Walmart"} · ${String(row?.external_order_id || "—")}`;

    totalOrders += 1;
    marketplaceOrders += 1;
    totalRevenueCents += contribution.revenueCents;
    totalNetMerchandiseRevenueCents += Math.min(contribution.revenueCents, contribution.netMerchandiseRevenueCents);
    totalShippingRevenueCents += Math.max(0, contribution.revenueCents - contribution.netMerchandiseRevenueCents);
    totalTaxCollectedCents += contribution.taxCollectedCents;
    totalPricingAdjustmentsCents += contribution.discountCents;
    totalRefundsCents += contribution.refundCents;
    totalOtherCostsCents += contribution.otherCostCents;
    totalPlatformFeesCents += contribution.platformFeesCents;
    if (financialComplete) {
      totalProductCostCents += contribution.cogsCents;
      totalShippingExpenseCents += contribution.shippingCostCents;
      shippingKnownCount += 1;
      currentProfitCents += contribution.currentProfitCents;
      currentProfitSnapshotOrders += 1;
      marketplaceProfitCompleteOrders += 1;
      totalShippingVarianceCents += contribution.shippingProfitCents;
      shippingVarianceOrders += 1;
    } else {
      currentProfitPendingOrders += 1;
      marketplaceProfitEstimatedOrders += 1;
    }

    const bucketKey = bucketKeyForDate(soldAt, bucketMode);
    if (!trendMap.has(bucketKey)) trendMap.set(bucketKey, blankTrendEntry());
    const bucket = trendMap.get(bucketKey);
    bucket.revenueCents += contribution.revenueCents;
    bucket.shippingExpenseCents += financialComplete ? contribution.shippingCostCents : 0;
    bucket.platformFeesCents += contribution.platformFeesCents;
    bucket.netCents += contribution.revenueCents - contribution.platformFeesCents - (financialComplete ? contribution.shippingCostCents : 0);
    bucket.orders += 1;

    const netLineRevenue = allocateMarketplaceNetLineRevenue(row.lines, row.discount_cents, row.refund_cents);
    const syntheticItems = (row.lines || []).map((line, index) => ({
      slug: String(line.product_slug || ""),
      name: productNames.get(String(line.product_slug || "")) || String(line.product_slug || "Product"),
      lineTotalCents: netLineRevenue[index] || 0,
      lineCases: Number(line.quantity_cases) || 0,
      lineBoxCount: Number(line.quantity_boxes) || 0,
    }));
    const syntheticOrder = { items: syntheticItems };
    accumulateProductRankingFromOrder(syntheticOrder, productBySlug);
    accumulateProductBucketSeriesFromOrder(syntheticOrder, bucketKey, productRevenueByBucket);
    const preview = summarizeOrderItemsPreview(syntheticItems);
    recentOrders.push({
      orderId: String(row.id || ""),
      orderRef,
      customer: marketplaceName === "amazon" ? "Amazon marketplace" : "Walmart marketplace",
      paidAt: soldAt.toISOString(),
      revenueCents: contribution.revenueCents,
      shippingExpenseCents: financialComplete ? contribution.shippingCostCents : null,
      platformFeeCents: contribution.platformFeesCents,
      netCents: contribution.revenueCents - contribution.platformFeesCents - (financialComplete ? contribution.shippingCostCents : 0),
      orderStatus: String(row.status || "new"),
      currentProfitCents: financialComplete ? contribution.currentProfitCents : null,
      currentProfitEstimated: !financialComplete,
      shippingChargedToCustomerCents: contribution.shippingChargedCents,
      actualLabelCostCents: financialComplete ? contribution.shippingCostCents : null,
      productPreview: preview.product,
      quantityPreview: preview.quantity,
      channel: marketplaceName,
    });
    if (financialComplete) {
      latestShippingEntries.push({ orderRef, paidAt: soldAt.toISOString(), carrier: marketplaceName === "amazon" ? "Amazon" : "Walmart", shippingExpenseCents: contribution.shippingCostCents });
    }
  }

  const { missingShipping, paidNotFulfilled, feeCalcIssues, unusuallyHighShipping, pendingShippingCost } = collectSummaryOrderAlerts(
    allPaidRows,
    labelRowsByOrderId,
  );

  const chartPoints = [...trendMap.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([bucketStart, v]) => ({
      bucketStart,
      ...v,
    }));

  const averageOrderValueCents = totalOrders ? Math.round(totalRevenueCents / totalOrders) : 0;
  const averageShippingPerOrderCents = shippingKnownCount ? Math.round(totalShippingExpenseCents / shippingKnownCount) : 0;
  const averagePlatformFeePerOrderCents = totalOrders ? Math.round(totalPlatformFeesCents / totalOrders) : 0;
  const averageSquareProcessingFeeCents = squareFeeOrders
    ? Math.round(totalSquareProcessingFeesCents / squareFeeOrders)
    : 0;
  const reconciliationProfitCents = totalRevenueCents
    - totalProductCostCents
    - totalPlatformFeesCents
    - totalShippingExpenseCents
    - totalOtherCostsCents;
  const reconciliationDifferenceCents = currentProfitPendingOrders > 0
    ? null
    : currentProfitCents - reconciliationProfitCents;

  latestShippingEntries.sort((a, b) => b.paidAt.localeCompare(a.paidAt));
  recentOrders.sort((a, b) => b.paidAt.localeCompare(a.paidAt));

  const zones = [...zoneMap.values()]
    .sort((a, b) => b.orders - a.orders)
    .map((r) => ({
      zone: r.zone,
      orders: r.orders,
      revenueCents: r.revenueCents,
      averageOrderValueCents: r.orders ? Math.round(r.revenueCents / r.orders) : 0,
      totalWeightLb: r.ordersWithWeight > 0 ? Math.round(r.totalWeightLb * 10) / 10 : null,
    }));

  const stateRevenueRows = [...stateRevenueMap.values()].sort(
    (left, right) => right.total_revenue - left.total_revenue || right.total_orders - left.total_orders || left.state.localeCompare(right.state),
  );
  const stateRevenueTotals = stateRevenueRows.reduce(
    (totals, row) => ({
      totalStates: totals.totalStates + 1,
      totalOrders: totals.totalOrders + row.total_orders,
      totalRevenueCents: totals.totalRevenueCents + row.total_revenue,
    }),
    { totalStates: 0, totalOrders: 0, totalRevenueCents: 0 },
  );

  const productRanking = [...productBySlug.values()]
    .sort((a, b) => b.revenueCents - a.revenueCents)
    .slice(0, 40);

  const salesOverviewProducts = productRanking.slice(0, 3).map((product) => ({
    slug: product.slug,
    name: product.name,
    label: productLegendLabel(product.name, product.slug),
  }));
  const salesOverviewSeries = chartPoints.map((point) => {
    const bucketProducts = productRevenueByBucket.get(point.bucketStart) || new Map();
    return {
      bucketStart: point.bucketStart,
      totalRevenueCents: point.revenueCents,
      shippingExpenseCents: point.shippingExpenseCents,
      products: salesOverviewProducts.map((product) => ({
        slug: product.slug,
        name: product.name,
        label: product.label,
        revenueCents: Number(bucketProducts.get(product.slug)?.revenueCents) || 0,
      })),
    };
  });

  const incomingBatchesOnHold = await fetchIncomingBatchesOnHoldSummary();
  let inventoryAlerts = {
    inventoryOutOfStock: { count: 0, rows: [] },
    lowInventory: { count: 0, rows: [] },
  };
  let inventorySellThroughRevenue = {
    totalRevenueCents: 0,
    caseUnits: 0,
    boxUnits: 0,
  };
  try {
    inventoryAlerts = await buildSummaryInventoryAlerts();
  } catch (e) {
    console.error("[admin-summary] buildSummaryInventoryAlerts", e);
  }
  try {
    inventorySellThroughRevenue = await buildInventorySellThroughRevenueSummary();
  } catch (e) {
    console.error("[admin-summary] buildInventorySellThroughRevenueSummary", e);
  }

  return {
    generatedAt: new Date().toISOString(),
    currency: "USD",
    amountsIn: "cents",
    dateRange: {
      preset: range.preset,
      start: range.startIsoDate,
      end: range.endIsoDate,
      bucketMode,
      channel,
    },
    kpis: {
      totalRevenueCents,
      totalOrders,
      totalShippingExpenseCents,
      totalPlatformFeesCents,
      totalSquareProcessingFeesCents,
      actualSquareProcessingFeesCents,
      estimatedSquareProcessingFeesCents,
      squareFeeOrders,
      actualSquareFeeOrders,
      estimatedSquareFeeOrders,
      averageSquareProcessingFeeCents,
      currentProfitCents,
      currentProfitSnapshotOrders,
      currentProfitEstimatedOrders,
      currentProfitPendingOrders,
      currentProfitStatus: currentProfitPendingOrders > 0 ? "pending" : currentProfitEstimatedOrders > 0 ? "estimated" : "actual",
      websiteOrders,
      marketplaceOrders,
      marketplaceProfitCompleteOrders,
      marketplaceProfitEstimatedOrders,
      netAfterVariableCostsCents: totalRevenueCents - totalShippingExpenseCents - totalPlatformFeesCents,
      inventorySellThroughRevenueCents: inventorySellThroughRevenue.totalRevenueCents,
      inventorySellThroughCaseUnits: inventorySellThroughRevenue.caseUnits,
      inventorySellThroughBoxUnits: inventorySellThroughRevenue.boxUnits,
      averageOrderValueCents,
      averageShippingPerOrderCents,
      averagePlatformFeePerOrderCents,
      shippingKnownOrders: shippingKnownCount,
      profitSnapshotOrders,
      totalExpectedProfitCents,
      totalBuiltInShippingAllowanceCents,
      totalShippingVarianceCents,
      shippingVarianceOrders,
      totalDiscountLossCents,
      totalActualRealizedProfitCents,
      realizedProfitOrders,
    },
    charts: {
      revenueTrend: chartPoints.map((p) => ({ bucketStart: p.bucketStart, revenueCents: p.revenueCents })),
      variableCostTrend: chartPoints.map((p) => ({
        bucketStart: p.bucketStart,
        shippingExpenseCents: p.shippingExpenseCents,
        platformFeesCents: p.platformFeesCents,
      })),
      netTrend: chartPoints.map((p) => ({ bucketStart: p.bucketStart, netCents: p.netCents })),
      ordersTrend: chartPoints.map((p) => ({ bucketStart: p.bucketStart, orders: p.orders })),
    },
    breakdown: {
      shipping: {
        totalShippingExpenseCents,
        averageShippingPerOrderCents,
        knownShippingOrders: shippingKnownCount,
        zones,
        latestEntries: latestShippingEntries.slice(0, 10),
      },
      platformFees: {
        totalPlatformFeesCents,
        averagePlatformFeePerOrderCents,
        totalSquareProcessingFeesCents,
        actualSquareProcessingFeesCents,
        estimatedSquareProcessingFeesCents,
        squareFeeOrders,
        actualSquareFeeOrders,
        estimatedSquareFeeOrders,
        averageSquareProcessingFeeCents,
        formula: "Square uses settled fees when available, otherwise the order's frozen estimate; marketplace fees remain separate.",
      },
      channels: { websiteOrders, marketplaceOrders },
      financialReconciliation: {
        totalRevenueCents,
        netMerchandiseRevenueCents: totalNetMerchandiseRevenueCents,
        shippingRevenueCents: totalShippingRevenueCents,
        taxCollectedCents: totalTaxCollectedCents,
        productCostCents: totalProductCostCents,
        platformFeesCents: totalPlatformFeesCents,
        shippingExpenseCents: totalShippingExpenseCents,
        otherCostsCents: totalOtherCostsCents,
        pricingAdjustmentsCents: totalPricingAdjustmentsCents,
        refundsCents: totalRefundsCents,
        currentProfitCents,
        currentProfitStatus: currentProfitPendingOrders > 0 ? "pending" : currentProfitEstimatedOrders > 0 ? "estimated" : "actual",
        pendingProfitOrders: currentProfitPendingOrders,
        reconciliationDifferenceCents,
        formula: "Net merchandise + customer-paid shipping − product cost − processing/marketplace fees − carrier expense − other recorded costs. Collected tax is excluded.",
      },
      stateRevenue: {
        rows: stateRevenueRows,
        ...stateRevenueTotals,
        scope: "website_shipping_address",
      },
      recentFinancialActivity: recentOrders.slice(0, 20),
      productRanking,
      salesOverviewSeries: {
        products: salesOverviewProducts,
        buckets: salesOverviewSeries,
      },
    },
    alerts: {
      missingShippingCost: {
        count: missingShipping.length,
        rows: missingShipping.slice(0, 15),
      },
      pendingShippingCost: {
        count: pendingShippingCost.length,
        rows: pendingShippingCost.slice(0, 15),
      },
      paidNotFulfilled: {
        count: paidNotFulfilled.length,
        rows: paidNotFulfilled.slice(0, 15),
      },
      feeCalculationIssues: {
        count: feeCalcIssues.length,
        rows: feeCalcIssues.slice(0, 15),
      },
      unusuallyHighShipping: {
        count: unusuallyHighShipping.length,
        rows: unusuallyHighShipping.slice(0, 15),
      },
      incomingBatchesOnHold,
      marketplaceFinancialsIncomplete: {
        count: marketplaceProfitEstimatedOrders,
        rows: marketplaceRows
          .filter((order) => String(order?.financial_status || "estimated") === "estimated" || !(order.lines || []).every((line) => line?.line_cost_cents != null && line?.line_revenue_cents != null))
          .slice(0, 15)
          .map((order) => ({ marketplace: order.marketplace, externalOrderId: order.external_order_id })),
      },
      inventoryOutOfStock: inventoryAlerts.inventoryOutOfStock,
      lowInventory: inventoryAlerts.lowInventory,
    },
  };
}
