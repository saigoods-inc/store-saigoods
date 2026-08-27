/**
 * Admin summary profit: merchandise + shipping charged − catalog cost snapshot − fees − actual labels.
 * `order_shippo_labels.amount_cents` on purchased rows is the label purchase cost (same as optional `label_cost_cents` if you add that column).
 */

/** Shipping portion implied by order total (customer paid shipping + tax + merch). */
export function impliedPaidShippingCents(row) {
  const total = Math.max(0, Math.round(Number(row?.total_cents) || 0));
  const sub = Math.max(0, Math.round(Number(row?.subtotal_cents) || 0));
  const tax = Math.max(0, Math.round(Number(row?.tax_cents) || 0));
  return Math.max(0, total - sub - tax);
}

/**
 * Customer-paid shipping line used for shipping profit (not carrier cost).
 * Prefers frozen quote line; falls back to paid/total/shipping columns.
 * @param {object} row orders row
 * @returns {number | null} cents, or null if unknown (caller may treat implied-only as missing quote)
 */
export function resolveShippingChargedToCustomerCents(row) {
  const qTotal = row?.quoted_shipping_total_cents;
  if (qTotal != null && Number.isFinite(Number(qTotal)) && Number(qTotal) > 0) {
    return Math.max(0, Math.round(Number(qTotal)));
  }
  const q = row?.quoted_shipping_amount_cents;
  if (q != null && Number.isFinite(Number(q)) && Number(q) > 0) {
    const rs = Number(row?.quoted_shipping_residential_surcharge_cents);
    const surcharge = Number.isFinite(rs) && rs > 0 ? Math.round(rs) : 0;
    return Math.max(0, Math.round(Number(q)) + surcharge);
  }
  const paid = row?.paid_shipping_amount_cents;
  if (paid != null && Number.isFinite(Number(paid)) && Number(paid) > 0) {
    return Math.max(0, Math.round(Number(paid)));
  }
  const qt = row?.quoted_shipping_total_cents;
  if (qt != null && Number.isFinite(Number(qt)) && Number(qt) > 0) {
    return Math.max(0, Math.round(Number(qt)));
  }
  const sc = row?.shipping_cents;
  if (sc != null && Number.isFinite(Number(sc)) && Number(sc) > 0) {
    return Math.max(0, Math.round(Number(sc)));
  }
  if (impliedPaidShippingCents(row) === 0) {
    return 0;
  }
  return null;
}

/**
 * Landed catalog cost + supplies proxy from quote-time snapshot:
 * list subtotal − expected profit − built-in shipping allowance (allowance is legacy baked-in reference, often 0 after catalog update).
 */
export function computeLandedPlusSuppliesCents(row) {
  const list = row?.merchandise_list_subtotal_cents;
  const exp = row?.expected_profit_cents;
  const built = row?.built_in_shipping_allowance_cents;
  if (list == null || exp == null || built == null) {
    return null;
  }
  if (!Number.isFinite(Number(list)) || !Number.isFinite(Number(exp)) || !Number.isFinite(Number(built))) {
    return null;
  }
  return Math.max(0, Math.round(Number(list)) - Math.round(Number(exp)) - Math.round(Number(built)));
}

/**
 * @param {object} row
 * @param {number} platformFeeCents full-order processing fee (2.9% + $0.30)
 */
export function computeProductProfitCents(row, platformFeeCents) {
  const landed = computeLandedPlusSuppliesCents(row);
  if (landed == null) {
    return null;
  }
  const merchRev = Math.max(0, Math.round(Number(row.subtotal_cents) || 0));
  const fee = Math.max(0, Math.round(Number(platformFeeCents) || 0));
  // subtotal_cents is already net of volume pricing, discount codes, and
  // authorized admin/B2B price overrides. merchandise_discount_loss_cents is
  // retained for audit only; subtracting it here would count the reduction twice.
  return merchRev - landed - fee;
}

/**
 * Shipping margin: what the customer paid for the carrier line minus actual label spend.
 * @returns {number | null}
 */
export function computeShippingProfitCents(shippingChargedCents, actualLabelCostCents) {
  if (shippingChargedCents == null || actualLabelCostCents == null) {
    return null;
  }
  if (!Number.isFinite(Number(shippingChargedCents)) || !Number.isFinite(Number(actualLabelCostCents))) {
    return null;
  }
  return Math.round(Number(shippingChargedCents)) - Math.round(Number(actualLabelCostCents));
}

function normalizeFulfillmentMethod(value) {
  const method = String(value || "carrier").trim().toLowerCase();
  if (method === "local delivery") return "local_delivery";
  if (method === "b2b" || method === "b2b shipping") return "b2b_shipping";
  return method || "carrier";
}

/** Frozen carrier rate selected when the order was built. */
export function selectedShippingRateAmountCents(row) {
  const selectedId = String(row?.shippo_selected_rate_object_id || "").trim();
  if (!selectedId) return null;
  const raw = row?.shippo_shipment_rates_json;
  const rates = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object" && Array.isArray(raw.rates)
      ? raw.rates
      : [];
  const selected = rates.find((rate) => String(rate?.object_id || "").trim() === selectedId);
  const amount = Number.parseFloat(String(selected?.amount ?? ""));
  return Number.isFinite(amount) && amount >= 0 ? Math.round(amount * 100) : null;
}

/**
 * Shipping expense used by Summary profit reporting.
 * - Local delivery and pickup have no carrier-label expense.
 * - Purchased/uploaded labels are actual cost.
 * - A frozen selected carrier rate is an estimate until the label is purchased.
 * - Carrier orders without either are pending and must not silently use $0.
 */
export function resolveShippingExpenseForProfit(row, actualLabelCostCents) {
  const fulfillmentMethod = normalizeFulfillmentMethod(row?.fulfillment_method);
  if (fulfillmentMethod === "local_delivery" || fulfillmentMethod === "pickup") {
    return { costCents: 0, quality: "actual" };
  }
  if (actualLabelCostCents != null && Number.isFinite(Number(actualLabelCostCents))) {
    return { costCents: Math.max(0, Math.round(Number(actualLabelCostCents))), quality: "actual" };
  }
  const estimatedCostCents = selectedShippingRateAmountCents(row);
  if (estimatedCostCents != null) {
    return { costCents: estimatedCostCents, quality: "estimated" };
  }
  return { costCents: null, quality: "pending" };
}

/**
 * @param {object} row
 * @param {number | null} actualLabelCostCents sum purchased Shippo labels + external label cost fallback
 * @param {number} platformFeeCents
 */
export function computeCurrentProfitContributionCents(row, actualLabelCostCents, platformFeeCents) {
  const shipCharged = resolveShippingChargedToCustomerCents(row);
  const product = computeProductProfitCents(row, platformFeeCents);
  if (product == null) {
    return null;
  }
  if (shipCharged == null) {
    return null;
  }
  let labelCost = actualLabelCostCents;
  if (labelCost == null || !Number.isFinite(Number(labelCost))) {
    if (shipCharged === 0) {
      labelCost = 0;
    } else {
      return null;
    }
  }
  labelCost = Math.max(0, Math.round(Number(labelCost)));
  const shipProfit = computeShippingProfitCents(shipCharged, labelCost);
  if (shipProfit == null) {
    return null;
  }
  return product + shipProfit;
}

/** True when we have product snapshot but cannot yet pair shipping charged with label cost. */
export function isCurrentProfitShippingEstimated(row, actualLabelCostCents) {
  return resolveShippingExpenseForProfit(row, actualLabelCostCents).quality === "estimated";
}

/** Web/manual paid orders: customer paid shipping but quote snapshot line not stored. */
export function orderMissingQuotedShippingRevenue(row) {
  const src = String(row?.order_source || "web").trim();
  if (src === "walk_in") {
    return false;
  }
  const implied = impliedPaidShippingCents(row);
  if (implied < 50) {
    return false;
  }
  const q = Number(row?.quoted_shipping_amount_cents);
  const qb = Number(row?.quoted_shipping_base_amount_cents);
  if (Number.isFinite(q) && q > 0) {
    return false;
  }
  if (Number.isFinite(qb) && qb > 0) {
    return false;
  }
  const paid = Number(row?.paid_shipping_amount_cents);
  if (Number.isFinite(paid) && paid > 0) {
    return false;
  }
  return true;
}
