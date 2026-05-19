import { createClient } from "@supabase/supabase-js";
import {
  computeCurrentProfitContributionCents,
  computeLandedPlusSuppliesCents,
  computeShippingProfitCents,
  impliedPaidShippingCents,
  isCurrentProfitShippingEstimated,
  orderMissingQuotedShippingRevenue,
  resolveShippingChargedToCustomerCents,
} from "./admin-summary-order-profit.js";
import { listIncomingInventoryBatches } from "./incoming-inventory-batches.js";
import { buildSummaryInventoryAlerts } from "./stock.js";
import { coerceOrderIdForQuery } from "./orders.js";
import { extractZipFromText, normalizeUsZip, resolveShippingZip } from "./shipping.js";
import { getShippingZone } from "./shipping-zone-legacy.js";

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

function startOfUtcDay(d) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function addUtcDays(date, days) {
  const out = new Date(date);
  out.setUTCDate(out.getUTCDate() + days);
  return out;
}

function parseIsoDateOnly(s) {
  const raw = String(s || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return null;
  }
  const d = new Date(`${raw}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) {
    return null;
  }
  return d;
}

/**
 * Date range in UTC.
 * `endExclusive` is used for filtering.
 */
export function buildSummaryDateRange(input = {}) {
  const now = new Date();
  const todayStart = startOfUtcDay(now);
  const preset = String(input.preset || "last30").trim();

  let start = null;
  let endExclusive = addUtcDays(todayStart, 1);
  let resolvedPreset = preset;

  if (preset === "today") {
    start = todayStart;
  } else if (preset === "last7") {
    start = addUtcDays(todayStart, -6);
  } else if (preset === "last30") {
    start = addUtcDays(todayStart, -29);
  } else if (preset === "month") {
    start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  } else if (preset === "all") {
    start = new Date(Date.UTC(1970, 0, 1));
  } else if (preset === "custom") {
    const startCustom = parseIsoDateOnly(input.start);
    const endCustom = parseIsoDateOnly(input.end);
    if (!startCustom || !endCustom) {
      const e = new Error("Custom range requires valid start and end dates (YYYY-MM-DD).");
      e.statusCode = 400;
      throw e;
    }
    if (endCustom < startCustom) {
      const e = new Error("Custom range end date must be on or after start date.");
      e.statusCode = 400;
      throw e;
    }
    start = startCustom;
    endExclusive = addUtcDays(endCustom, 1);
  } else {
    resolvedPreset = "last30";
    start = addUtcDays(todayStart, -29);
  }

  return {
    preset: resolvedPreset,
    start,
    endExclusive,
    startIsoDate: start.toISOString().slice(0, 10),
    endIsoDate: addUtcDays(endExclusive, -1).toISOString().slice(0, 10),
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

function orderRevenueCents(row) {
  const n = Number(row?.total_cents);
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
}

/**
 * Payment processing fee only.
 * Business rule: 2.9% + $0.30 per paid transaction.
 */
export function platformFeeCentsForOrder(row) {
  const source = String(row?.order_source || "").trim().toLowerCase();
  const method = String(row?.payment_method || "").trim().toLowerCase();
  // Walk-in cash/check are in-person POS settlements without online processor fee.
  // Legacy walk-in paid rows may have null payment_method; treat them as in-person (fee 0) too.
  // Future card_present should use a dedicated fee profile (not online checkout fee).
  if (source === "walk_in" && (method === "" || method === "cash" || method === "check")) {
    return 0;
  }
  const revenue = orderRevenueCents(row);
  return Math.round(revenue * 0.029 + 30);
}

function findSelectedShippoRateAmountCents(row) {
  const selectedId = String(row?.shippo_selected_rate_object_id || "").trim();
  if (!selectedId) {
    return null;
  }
  const raw = row?.shippo_shipment_rates_json;
  const list = Array.isArray(raw) ? raw : raw && typeof raw === "object" && Array.isArray(raw.rates) ? raw.rates : [];
  const hit = list.find((r) => r && String(r.object_id || "").trim() === selectedId);
  if (!hit) {
    return null;
  }
  const amount = Number.parseFloat(String(hit.amount ?? ""));
  if (!Number.isFinite(amount) || amount < 0) {
    return null;
  }
  return Math.round(amount * 100);
}

function sumPurchasedShippoLabelCostCents(labelRows) {
  if (!Array.isArray(labelRows) || !labelRows.length) {
    return null;
  }
  let sum = 0;
  let anyPurchased = false;
  for (const r of labelRows) {
    if (String(r?.status || "") !== "purchased") {
      continue;
    }
    anyPurchased = true;
    const raw = r.label_cost_cents != null ? r.label_cost_cents : r.amount_cents;
    if (raw != null && Number.isFinite(Number(raw))) {
      sum += Math.max(0, Math.round(Number(raw)));
    }
  }
  return anyPurchased ? sum : null;
}

/** Actual label spend: Shippo purchased rows, else external upload, else legacy single-rate estimate. */
function actualLabelCostCentsForOrder(row, labelRowsForOrder) {
  const fromShippo = sumPurchasedShippoLabelCostCents(labelRowsForOrder);
  if (fromShippo != null) {
    return fromShippo;
  }
  const ext = Number(row?.admin_external_label_cost_cents);
  if (Number.isFinite(ext) && ext > 0) {
    return Math.round(ext);
  }
  const shippo = findSelectedShippoRateAmountCents(row);
  if (Number.isFinite(shippo) && shippo >= 0) {
    return Math.round(shippo);
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
  if (mode === "week") {
    const day = d.getUTCDay(); // 0=Sun
    const daysToMonday = day === 0 ? 6 : day - 1;
    const monday = addUtcDays(startOfUtcDay(d), -daysToMonday);
    return monday.toISOString().slice(0, 10);
  }
  return d.toISOString().slice(0, 10);
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
  for (const line of items) {
    if (!line || typeof line !== "object") continue;
    const slug = String(line.slug || "").trim();
    if (!slug) continue;
    const displayName = String(line.name || line.shortName || slug).trim() || slug;
    const rev = Math.max(0, Math.round(Number(line.lineTotalCents) || 0));
    const cases = Math.max(0, Math.floor(Number(line.lineCases) || 0));
    const boxes = Math.max(0, Math.floor(Number(line.lineBoxCount) || 0));
    const qty = cases + boxes;
    const prev = bySlug.get(slug) || { slug, name: displayName, revenueCents: 0, quantityUnits: 0 };
    prev.revenueCents += rev;
    prev.quantityUnits += qty;
    if (displayName.length > (prev.name?.length || 0)) prev.name = displayName;
    bySlug.set(slug, prev);
  }
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

  for (const row of paidRows) {
    const paidAt = paidAtDateForRow(row);
    if (!paidAt) {
      continue;
    }

    const revenueCents = orderRevenueCents(row);
    const oid = String(row.id);
    const labelRowsForOrder = labelRowsByOrderId.get(oid) || [];
    const shippingExpenseCents = actualLabelCostCentsForOrder(row, labelRowsForOrder);
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

    if (!isOrderShipped(row) && !excludeFromPaidNotFulfilledAlert(row, labelRowsForOrder)) {
      paidNotFulfilled.push({
        orderRef,
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

  return { missingShipping, paidNotFulfilled, feeCalcIssues, unusuallyHighShipping };
}

export async function fetchAdminSummary(input = {}) {
  const range = buildSummaryDateRange(input);
  const client = getClient();

  // Pull only fields used by summary calculations and drilldowns.
  const { data, error } = await client
    .from("orders")
    .select(
      "id,order_ref,order_source,customer_name,customer_email,customer_address,status,order_status,total_cents,subtotal_cents,tax_cents,shipping_cents,paid_shipping_amount_cents,quoted_shipping_amount_cents,quoted_shipping_base_amount_cents,quoted_shipping_residential_surcharge_cents,quoted_shipping_total_cents,quoted_shipping_mode,quoted_shipping_status,paid_at,created_at,items,shipping_address,shippo_parcel_audit_json,admin_external_label_cost_cents,admin_external_carrier,shippo_label_carrier,shippo_selected_rate_object_id,shippo_shipment_rates_json,shippo_label_url,shippo_transaction_status,admin_handoff_at,merchandise_list_subtotal_cents,merchandise_discount_loss_cents,expected_profit_cents,built_in_shipping_allowance_cents",
    )
    .eq("status", "paid")
    .order("created_at", { ascending: false });

  if (error) {
    throw error;
  }

  const allPaidRows = (Array.isArray(data) ? data : []).filter((row) => hasPaidStatus(row));

  const paidRows = allPaidRows.filter((row) => {
    const paidAt = paidAtDateForRow(row);
    return paidAt && paidAt >= range.start && paidAt < range.endExclusive;
  });

  const labelRowsByOrderId = await fetchShippoLabelRowsByOrderId(
    client,
    allPaidRows.map((r) => r.id),
  );

  let totalRevenueCents = 0;
  let totalOrders = 0;
  let totalShippingExpenseCents = 0;
  let shippingKnownCount = 0;
  let totalPlatformFeesCents = 0;
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

  const latestShippingEntries = [];
  const zoneMap = new Map();
  const recentOrders = [];
  const productBySlug = new Map();

  const trendMap = new Map();
  const dayCount = Math.max(1, Math.ceil((range.endExclusive.getTime() - range.start.getTime()) / (24 * 60 * 60 * 1000)));
  const bucketMode = bucketModeForDays(dayCount);

  for (const row of paidRows) {
    const paidAt = paidAtDateForRow(row);
    if (!paidAt) {
      continue;
    }

    const revenueCents = orderRevenueCents(row);
    const oid = String(row.id);
    const labelRowsForOrder = labelRowsByOrderId.get(oid) || [];
    const shippingExpenseCents = actualLabelCostCentsForOrder(row, labelRowsForOrder);
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
      if (shippingExpenseCents != null && shippingVarianceCents != null) {
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
      if (isCurrentProfitShippingEstimated(row, shippingExpenseCents)) {
        currentProfitEstimatedOrders += 1;
      }
    }

    const zip5 = shippingZip5FromOrderRow(row);
    if (zip5) {
      const zNum = getShippingZone(zip5);
      if (!zoneMap.has(zNum)) {
        zoneMap.set(zNum, { zone: zNum, orders: 0, totalWeightLb: 0, ordersWithWeight: 0 });
      }
      const zst = zoneMap.get(zNum);
      zst.orders += 1;
      const wlb = totalShipmentWeightLbFromOrder(row);
      if (wlb != null) {
        zst.totalWeightLb += wlb;
        zst.ordersWithWeight += 1;
      }
    }

    totalOrders += 1;
    totalRevenueCents += revenueCents;
    totalPlatformFeesCents += feeCents;
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
        currentContribution != null && isCurrentProfitShippingEstimated(row, shippingExpenseCents),
      shippingChargedToCustomerCents: shippingCharged,
      actualLabelCostCents: shippingExpenseCents,
      impliedPaidShippingCents: impliedPaidShippingCents(row),
      landedPlusSuppliesCents: computeLandedPlusSuppliesCents(row),
      shippingCostCents: shippingExpenseCents,
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

  const { missingShipping, paidNotFulfilled, feeCalcIssues, unusuallyHighShipping } = collectSummaryOrderAlerts(
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

  latestShippingEntries.sort((a, b) => b.paidAt.localeCompare(a.paidAt));
  recentOrders.sort((a, b) => b.paidAt.localeCompare(a.paidAt));

  const zones = [...zoneMap.values()]
    .sort((a, b) => b.orders - a.orders)
    .map((r) => ({
      zone: r.zone,
      orders: r.orders,
      totalWeightLb: r.ordersWithWeight > 0 ? Math.round(r.totalWeightLb * 10) / 10 : null,
    }));

  const productRanking = [...productBySlug.values()]
    .sort((a, b) => b.revenueCents - a.revenueCents)
    .slice(0, 40);

  const incomingBatchesOnHold = await fetchIncomingBatchesOnHoldSummary();

  let inventoryAlerts = {
    inventoryOutOfStock: { count: 0, rows: [] },
    lowInventory: { count: 0, rows: [] },
  };
  try {
    inventoryAlerts = await buildSummaryInventoryAlerts();
  } catch (e) {
    console.error("[admin-summary] buildSummaryInventoryAlerts", e);
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
    },
    kpis: {
      totalRevenueCents,
      totalOrders,
      totalShippingExpenseCents,
      totalPlatformFeesCents,
      currentProfitCents,
      currentProfitSnapshotOrders,
      currentProfitEstimatedOrders,
      netAfterVariableCostsCents: totalRevenueCents - totalShippingExpenseCents - totalPlatformFeesCents,
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
        formula: "fee_cents = round(order_total_cents * 0.029 + 30)",
      },
      recentFinancialActivity: recentOrders.slice(0, 20),
      productRanking,
    },
    alerts: {
      missingShippingCost: {
        count: missingShipping.length,
        rows: missingShipping.slice(0, 15),
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
      inventoryOutOfStock: inventoryAlerts.inventoryOutOfStock,
      lowInventory: inventoryAlerts.lowInventory,
    },
  };
}
