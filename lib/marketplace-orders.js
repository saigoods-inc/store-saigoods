import { createClient } from "@supabase/supabase-js";
import { loadStore } from "./store.js";

const MARKETPLACES = new Set(["amazon", "walmart"]);
const STATUSES = new Set(["new", "packed", "shipped", "cancelled"]);

function moneyCents(value, label, { required = false } = {}) {
  if (value == null || value === "") {
    if (required) throw Object.assign(new Error(`${label} is required.`), { statusCode: 400 });
    return required ? null : 0;
  }
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) {
    throw Object.assign(new Error(`${label} must be a non-negative amount.`), { statusCode: 400 });
  }
  return Math.round(amount);
}

function marketplaceUnitCostCents(productSlug, unitType) {
  const product = (loadStore()?.products || []).find((candidate) => String(candidate?.slug || "") === productSlug);
  const bundle = (product?.bundles || []).find((candidate) => candidate?.kind === unitType && Number(candidate?.units) === 1);
  if (!bundle) {
    throw Object.assign(new Error(`Cost is not configured for ${productSlug} / ${unitType}.`), { statusCode: 400 });
  }
  const listPrice = Math.max(0, Math.round(Number(bundle.priceCents) || 0));
  const expectedProfit = Math.max(0, Math.round(Number(bundle.expectedProfitCents) || 0));
  const builtInShipping = Math.max(0, Math.round(Number(bundle.builtInShippingTotalCents) || 0));
  return Math.max(0, listPrice - expectedProfit - builtInShipping);
}

export function marketplaceFinancialContribution(order) {
  const merchandiseSubtotalCents = Math.max(0, Math.round(Number(order?.merchandise_subtotal_cents) || 0));
  const shippingChargedCents = Math.max(0, Math.round(Number(order?.shipping_charged_cents) || 0));
  const discountCents = Math.max(0, Math.round(Number(order?.discount_cents) || 0));
  const refundCents = Math.max(0, Math.round(Number(order?.refund_cents) || 0));
  const marketplaceFeeCents = Math.max(0, Math.round(Number(order?.marketplace_fee_cents) || 0));
  const paymentProcessingFeeCents = Math.max(0, Math.round(Number(order?.payment_processing_fee_cents) || 0));
  const shippingCostCents = Math.max(0, Math.round(Number(order?.shipping_cost_cents) || 0));
  const otherCostCents = Math.max(0, Math.round(Number(order?.other_cost_cents) || 0));
  const cogsCents = (order?.lines || []).reduce(
    (sum, line) => sum + Math.max(0, Math.round(Number(line?.line_cost_cents) || 0)),
    0,
  );
  const revenueCents = Math.max(0, merchandiseSubtotalCents - discountCents - refundCents + shippingChargedCents);
  const platformFeesCents = marketplaceFeeCents + paymentProcessingFeeCents;
  return {
    merchandiseSubtotalCents,
    netMerchandiseRevenueCents: Math.max(0, merchandiseSubtotalCents - discountCents - refundCents),
    revenueCents,
    cogsCents,
    platformFeesCents,
    shippingChargedCents,
    shippingCostCents,
    discountCents,
    refundCents,
    taxCollectedCents: Math.max(0, Math.round(Number(order?.tax_collected_cents) || 0)),
    otherCostCents,
    shippingProfitCents: shippingChargedCents - shippingCostCents,
    currentProfitCents: revenueCents - cogsCents - platformFeesCents - shippingCostCents - otherCostCents,
  };
}

function client() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw Object.assign(new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for marketplace orders."), { statusCode: 503 });
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

function actorEmail(actor) {
  return actor?.kind === "user" ? String(actor.email || "").trim() || null : actor?.kind === "service" ? "internal" : null;
}

function marketplaceInventoryError(message, input) {
  const sharedMatch = String(message || "").match(
    /insufficient stock for variant\s+[0-9a-f-]+\s+\(cases\s+(\d+),\s*boxes\s+(\d+),\s*boxes_per_case\s+(\d+),\s*requested_cases\s+(\d+),\s*requested_boxes\s+(\d+)\)/i,
  );
  if (sharedMatch) {
    const availableCases = Number(sharedMatch[1]);
    const availableLooseBoxes = Number(sharedMatch[2]);
    const boxesPerCase = Number(sharedMatch[3]);
    const requestedCases = Number(sharedMatch[4]);
    const requestedBoxes = Number(sharedMatch[5]);
    const matchingLine = input?.lines?.find((line) =>
      Number(line.quantityCases || 0) === requestedCases && Number(line.quantityBoxes || 0) === requestedBoxes
    );
    const item = matchingLine ? `${matchingLine.productSlug} / ${matchingLine.size}` : "the selected item";
    const detail = requestedCases > availableCases
      ? `${availableCases} intact ${availableCases === 1 ? "carton" : "cartons"} available, ${requestedCases} requested`
      : `${(availableCases - requestedCases) * boxesPerCase + availableLooseBoxes} boxes available after carton items, ${requestedBoxes} requested`;
    return Object.assign(new Error(`Not enough stock for ${item}: ${detail}.`), { statusCode: 409 });
  }
  const match = String(message || "").match(
    /negative stock for variant\s+[0-9a-f-]+\s+\(cases\s+(-?\d+)\s*->\s*(-?\d+),\s*boxes\s+(-?\d+)\s*->\s*(-?\d+)\)/i,
  );
  if (!match) return null;
  const availableCases = Number(match[1]);
  const nextCases = Number(match[2]);
  const availableBoxes = Number(match[3]);
  const nextBoxes = Number(match[4]);
  const requestedCases = Math.max(0, availableCases - nextCases);
  const requestedBoxes = Math.max(0, availableBoxes - nextBoxes);
  const matchingLine = input?.lines?.find((line) =>
    Number(line.quantityCases || 0) === requestedCases && Number(line.quantityBoxes || 0) === requestedBoxes
  );
  const item = matchingLine ? `${matchingLine.productSlug} / ${matchingLine.size}` : "the selected item";
  const shortages = [];
  if (nextCases < 0) shortages.push(`${availableCases} ${availableCases === 1 ? "case" : "cases"} available, ${requestedCases} requested`);
  if (nextBoxes < 0) shortages.push(`${availableBoxes} ${availableBoxes === 1 ? "box" : "boxes"} available, ${requestedBoxes} requested`);
  return Object.assign(
    new Error(`Not enough stock for ${item}: ${shortages.join("; ")}. Reduce the quantity or update inventory, then try again.`),
    { statusCode: 409 },
  );
}

function marketplaceStorageError(error, fallbackMessage, input) {
  const message = String(error?.message || "");
  const inventoryError = marketplaceInventoryError(message, input);
  if (inventoryError) return inventoryError;
  if (/PGRST20[25]|schema cache|marketplace_order_record|marketplace_order_transition|marketplace_orders/i.test(message)) {
    return Object.assign(
      new Error("Marketplace order storage is not set up yet. Apply the marketplace database migration, then try again."),
      { statusCode: 503 },
    );
  }
  return Object.assign(new Error(message || fallbackMessage), {
    statusCode: /duplicate/i.test(message) ? 409 : /not found/i.test(message) ? 404 : /stock/i.test(message) ? 409 : 500,
  });
}

export function normaliseMarketplaceOrderInput(raw) {
  const value = raw && typeof raw === "object" ? raw : {};
  const marketplace = String(value.marketplace || "").trim().toLowerCase();
  const externalOrderId = String(value.externalOrderId ?? value.external_order_id ?? "").trim();
  const lines = Array.isArray(value.lines) ? value.lines : [];
  if (!MARKETPLACES.has(marketplace)) throw Object.assign(new Error("Marketplace must be Amazon or Walmart."), { statusCode: 400 });
  if (!externalOrderId) throw Object.assign(new Error("Marketplace order ID is required."), { statusCode: 400 });
  if (!lines.length) throw Object.assign(new Error("Add at least one item to the marketplace order."), { statusCode: 400 });
  const normalizedLines = lines.map((line) => {
    const productSlug = String(line?.productSlug ?? line?.product_slug ?? "").trim();
    const size = String(line?.size ?? "").trim();
    const quantityCases = Math.max(0, Math.floor(Number(line?.quantityCases ?? line?.quantity_cases ?? 0) || 0));
    const quantityBoxes = Math.max(0, Math.floor(Number(line?.quantityBoxes ?? line?.quantity_boxes ?? 0) || 0));
    if (!productSlug || !size || (!quantityCases && !quantityBoxes)) {
      throw Object.assign(new Error("Each marketplace item needs a product, size, and quantity."), { statusCode: 400 });
    }
    if (quantityCases && quantityBoxes) {
      throw Object.assign(new Error("Use a separate line for cartons and boxes of the same item."), { statusCode: 400 });
    }
    const unitType = quantityCases ? "case" : "box";
    const quantity = quantityCases || quantityBoxes;
    const unitSalePriceCents = moneyCents(line?.unitSalePriceCents ?? line?.unit_sale_price_cents, "Unit selling price", { required: true });
    const unitCostCents = marketplaceUnitCostCents(productSlug, unitType);
    return {
      productSlug,
      size,
      quantityCases,
      quantityBoxes,
      unitType,
      unitSalePriceCents,
      unitCostCents,
      lineRevenueCents: quantity * unitSalePriceCents,
      lineCostCents: quantity * unitCostCents,
    };
  });
  const soldAt = value.soldAt || value.sold_at ? new Date(value.soldAt || value.sold_at).toISOString() : null;
  if ((value.soldAt || value.sold_at) && Number.isNaN(Date.parse(String(soldAt)))) {
    throw Object.assign(new Error("Sold date is invalid."), { statusCode: 400 });
  }
  const merchandiseSubtotalCents = normalizedLines.reduce((sum, line) => sum + line.lineRevenueCents, 0);
  const financials = {
    currency: "USD",
    merchandiseSubtotalCents,
    shippingChargedCents: moneyCents(value.shippingChargedCents ?? value.shipping_charged_cents, "Shipping charged", { required: true }),
    discountCents: moneyCents(value.discountCents ?? value.discount_cents, "Discount"),
    taxCollectedCents: moneyCents(value.taxCollectedCents ?? value.tax_collected_cents, "Sales tax"),
    marketplaceFeeCents: moneyCents(value.marketplaceFeeCents ?? value.marketplace_fee_cents, "Marketplace fees", { required: true }),
    paymentProcessingFeeCents: moneyCents(value.paymentProcessingFeeCents ?? value.payment_processing_fee_cents, "Payment processing fees"),
    shippingCostCents: moneyCents(value.shippingCostCents ?? value.shipping_cost_cents, "Shipping cost", { required: true }),
    otherCostCents: moneyCents(value.otherCostCents ?? value.other_cost_cents, "Other costs"),
    refundCents: moneyCents(value.refundCents ?? value.refund_cents, "Refunds"),
    netPayoutCents: value.netPayoutCents == null && value.net_payout_cents == null
      ? null
      : moneyCents(value.netPayoutCents ?? value.net_payout_cents, "Net payout"),
  };
  const grossRevenueBeforeRefundCents = Math.max(0, merchandiseSubtotalCents - financials.discountCents + financials.shippingChargedCents);
  if (financials.refundCents > grossRevenueBeforeRefundCents) {
    throw Object.assign(new Error("Refunds cannot exceed merchandise plus shipping after discounts."), { statusCode: 400 });
  }
  financials.financialStatus = financials.refundCents === 0
    ? "complete"
    : financials.refundCents >= grossRevenueBeforeRefundCents ? "refunded" : "partial_refund";
  return { marketplace, externalOrderId, lines: normalizedLines, financials, soldAt, notes: String(value.notes || "").trim() || null };
}

export async function listMarketplaceOrders() {
  const sb = client();
  const { data: orders, error } = await sb.from("marketplace_orders").select("*").order("sold_at", { ascending: false, nullsFirst: false });
  if (error) throw marketplaceStorageError(error, "Could not load marketplace orders.");
  const ids = (orders || []).map((row) => row.id).filter(Boolean);
  if (!ids.length) return [];
  const { data: lines, error: linesError } = await sb.from("marketplace_order_lines").select("*").in("marketplace_order_id", ids);
  if (linesError) throw marketplaceStorageError(linesError, "Could not load marketplace order items.");
  const linesByOrder = new Map();
  for (const line of lines || []) {
    const key = String(line.marketplace_order_id);
    linesByOrder.set(key, [...(linesByOrder.get(key) || []), line]);
  }
  return (orders || []).map((order) => ({ ...order, lines: linesByOrder.get(String(order.id)) || [] }));
}

export async function createMarketplaceOrder(raw, actor) {
  const input = normaliseMarketplaceOrderInput(raw);
  const { data, error } = await client().rpc("marketplace_order_record", {
    p_marketplace: input.marketplace,
    p_external_order_id: input.externalOrderId,
    p_lines: input.lines.map((line) => ({
      product_slug: line.productSlug,
      size: line.size,
      quantity_cases: line.quantityCases,
      quantity_boxes: line.quantityBoxes,
      unit_type: line.unitType,
      unit_sale_price_cents: line.unitSalePriceCents,
      unit_cost_cents: line.unitCostCents,
      line_revenue_cents: line.lineRevenueCents,
      line_cost_cents: line.lineCostCents,
    })),
    p_financials: {
      currency: input.financials.currency,
      merchandise_subtotal_cents: input.financials.merchandiseSubtotalCents,
      shipping_charged_cents: input.financials.shippingChargedCents,
      discount_cents: input.financials.discountCents,
      tax_collected_cents: input.financials.taxCollectedCents,
      marketplace_fee_cents: input.financials.marketplaceFeeCents,
      payment_processing_fee_cents: input.financials.paymentProcessingFeeCents,
      shipping_cost_cents: input.financials.shippingCostCents,
      other_cost_cents: input.financials.otherCostCents,
      refund_cents: input.financials.refundCents,
      net_payout_cents: input.financials.netPayoutCents,
      financial_status: input.financials.financialStatus,
    },
    p_sold_at: input.soldAt,
    p_notes: input.notes,
    p_actor: actorEmail(actor),
  });
  if (error) throw marketplaceStorageError(error, "Could not record marketplace order.", input);
  return data;
}

export async function transitionMarketplaceOrder(id, status, actor) {
  const nextStatus = String(status || "").trim().toLowerCase();
  if (!STATUSES.has(nextStatus)) throw Object.assign(new Error("Marketplace order status is invalid."), { statusCode: 400 });
  const { data, error } = await client().rpc("marketplace_order_transition", {
    p_marketplace_order_id: String(id || "").trim(), p_status: nextStatus, p_actor: actorEmail(actor),
  });
  if (error) throw marketplaceStorageError(error, "Could not update marketplace order.");
  return data;
}

/** Test seam for safe marketplace RPC error messages. */
export function __classifyMarketplaceRpcErrorForTests(message, input) {
  const error = marketplaceStorageError({ message }, "Marketplace order request failed.", input);
  return { message: error.message, statusCode: error.statusCode };
}
