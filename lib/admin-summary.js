import { createClient } from "@supabase/supabase-js";
import { coerceOrderIdForQuery } from "./orders.js";

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

function shippingExpenseCentsForOrder(row) {
  const ext = Number(row?.admin_external_label_cost_cents);
  if (Number.isFinite(ext) && ext >= 0) {
    return Math.round(ext);
  }
  const shippo = findSelectedShippoRateAmountCents(row);
  if (Number.isFinite(shippo) && shippo >= 0) {
    return Math.round(shippo);
  }
  return null;
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

function isOrderShipped(row) {
  return String(row?.order_status || "") === "shipped" || Boolean(row?.admin_handoff_at);
}

export async function fetchAdminSummary(input = {}) {
  const range = buildSummaryDateRange(input);
  const client = getClient();

  // Pull only fields used by summary calculations and drilldowns.
  const { data, error } = await client
    .from("orders")
    .select(
      "id,order_ref,customer_name,customer_email,status,order_status,total_cents,subtotal_cents,paid_at,created_at,admin_external_label_cost_cents,admin_external_carrier,shippo_label_carrier,shippo_selected_rate_object_id,shippo_shipment_rates_json,shippo_label_url,shippo_transaction_status,admin_handoff_at,merchandise_list_subtotal_cents,merchandise_discount_loss_cents,expected_profit_cents,built_in_shipping_allowance_cents",
    )
    .eq("status", "paid")
    .order("created_at", { ascending: false });

  if (error) {
    throw error;
  }

  const paidRows = (Array.isArray(data) ? data : [])
    .filter((row) => hasPaidStatus(row))
    .filter((row) => {
      const paidAt = paidAtDateForRow(row);
      return paidAt && paidAt >= range.start && paidAt < range.endExclusive;
    });

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

  const latestShippingEntries = [];
  const carrierMap = new Map();
  const recentOrders = [];
  const missingShipping = [];
  const paidNotFulfilled = [];
  const feeCalcIssues = [];
  const unusuallyHighShipping = [];

  const trendMap = new Map();
  const dayCount = Math.max(1, Math.ceil((range.endExclusive.getTime() - range.start.getTime()) / (24 * 60 * 60 * 1000)));
  const bucketMode = bucketModeForDays(dayCount);

  for (const row of paidRows) {
    const paidAt = paidAtDateForRow(row);
    if (!paidAt) {
      continue;
    }

    const revenueCents = orderRevenueCents(row);
    const shippingExpenseCents = shippingExpenseCentsForOrder(row);
    const feeCents = platformFeeCentsForOrder(row);
    const netCents = revenueCents - (shippingExpenseCents || 0) - feeCents;

    const expProf =
      row?.expected_profit_cents != null && Number.isFinite(Number(row.expected_profit_cents))
        ? Math.round(Number(row.expected_profit_cents))
        : null;
    const builtInShip =
      row?.built_in_shipping_allowance_cents != null && Number.isFinite(Number(row.built_in_shipping_allowance_cents))
        ? Math.round(Number(row.built_in_shipping_allowance_cents))
        : null;
    const discLoss =
      row?.merchandise_discount_loss_cents != null && Number.isFinite(Number(row.merchandise_discount_loss_cents))
        ? Math.max(0, Math.round(Number(row.merchandise_discount_loss_cents)))
        : 0;

    let shippingVarianceCents = null;
    let actualRealizedProfitCents = null;
    let actualRealizedProfitPending = false;
    if (expProf != null && builtInShip != null) {
      profitSnapshotOrders += 1;
      totalExpectedProfitCents += expProf;
      totalBuiltInShippingAllowanceCents += builtInShip;
      totalDiscountLossCents += discLoss;
      if (shippingExpenseCents != null) {
        shippingVarianceCents = builtInShip - shippingExpenseCents;
        totalShippingVarianceCents += shippingVarianceCents;
        shippingVarianceOrders += 1;
        actualRealizedProfitCents = expProf + shippingVarianceCents - discLoss;
        totalActualRealizedProfitCents += actualRealizedProfitCents;
        realizedProfitOrders += 1;
      } else {
        actualRealizedProfitPending = true;
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
    if (!carrierMap.has(carrier)) {
      carrierMap.set(carrier, { carrier, orders: 0, shippingExpenseCents: 0, knownShippingOrders: 0 });
    }
    const carrierStats = carrierMap.get(carrier);
    carrierStats.orders += 1;
    if (shippingExpenseCents != null) {
      carrierStats.shippingExpenseCents += shippingExpenseCents;
      carrierStats.knownShippingOrders += 1;
    }

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
      shippingVarianceCents,
      discountLossCents: discLoss,
      actualRealizedProfitCents,
      actualRealizedProfitPending,
    };
    recentOrders.push(recentRow);

    if (shippingExpenseCents != null) {
      latestShippingEntries.push({
        orderRef: recentRow.orderRef,
        paidAt: recentRow.paidAt,
        carrier,
        shippingExpenseCents,
      });
    } else {
      missingShipping.push({
        orderRef: recentRow.orderRef,
        paidAt: recentRow.paidAt,
        reason: "No external label cost or selected Shippo rate amount found.",
      });
    }

    if (!isOrderShipped(row)) {
      paidNotFulfilled.push({
        orderRef: recentRow.orderRef,
        paidAt: recentRow.paidAt,
        orderStatus: recentRow.orderStatus || "paid",
      });
    }

    if (!Number.isFinite(Number(row?.total_cents)) || Number(row?.total_cents) < 0) {
      feeCalcIssues.push({
        orderRef: recentRow.orderRef,
        paidAt: recentRow.paidAt,
        reason: "Invalid total_cents; platform fee calculation may be unreliable.",
      });
    }

    if (shippingExpenseCents != null) {
      const highThreshold = Math.max(5000, Math.round(revenueCents * 0.35));
      if (shippingExpenseCents > highThreshold) {
        unusuallyHighShipping.push({
          orderRef: recentRow.orderRef,
          paidAt: recentRow.paidAt,
          shippingExpenseCents,
          revenueCents,
        });
      }
    }
  }

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

  const carriers = [...carrierMap.values()].sort((a, b) => b.shippingExpenseCents - a.shippingExpenseCents);

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
        carriers,
        latestEntries: latestShippingEntries.slice(0, 10),
      },
      platformFees: {
        totalPlatformFeesCents,
        averagePlatformFeePerOrderCents,
        formula: "fee_cents = round(order_total_cents * 0.029 + 30)",
      },
      recentFinancialActivity: recentOrders.slice(0, 20),
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
    },
  };
}
