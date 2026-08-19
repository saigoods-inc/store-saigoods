import crypto from "node:crypto";
import { hasExternalShippingLabel, manualFulfillmentRecordComplete } from "./admin-external-fulfillment.js";
import { releaseDiscountCodeForOrder } from "./discount-codes.js";
import { computeEconomicsSnapshotForOrder } from "./order-economics.js";
import {
  commitWebsiteOrderStockOnPayment,
  decrementOnHandForShippedItems,
  decrementWalkInPaidStock,
  fulfillWebsiteOrderShippedStock,
  assertStockAvailableForItems,
} from "./stock.js";
import * as inventoryService from "./inventory-service.js";
import * as inventoryRepo from "./inventory-repo.js";
import { getSupabaseServiceRoleClient, isSupabaseInventoryBackend } from "./supabase-admin.js";
import { MANUAL_PAYMENT_LINK_VALID_MS } from "./manual-payment-link-access.js";
import {
  actualProcessingFeeFromSquarePayment,
  loadPaymentFeeConfig,
  processingFeeSnapshotForOrder,
} from "./payment-processing-fees.js";

function generateOrderRef() {
  return `SAI-${crypto.randomUUID().replace(/-/g, "").slice(0, 12).toUpperCase()}`;
}

import {
  defaultManualOrderLifecycleFields,
  lifecycleForFulfillment,
  normalizePaymentFlow,
} from "./manual-order-fulfillment.js";

function getClient() {
  return (walkInTestDeps?.getClient || getSupabaseServiceRoleClient)();
}

function missingProcessingFeeColumns(error) {
  return error?.code === "42703" || error?.code === "PGRST204" || /processing_fee/i.test(String(error?.message || ""));
}

export async function updateOrderProcessingFee(orderId, values) {
  const client = getClient();
  const payload = { ...values, processing_fee_synced_at: new Date().toISOString(), updated_at: orderRowNowIso() };
  const { data, error } = await client.from("orders").update(payload).eq("id", coerceOrderIdForQuery(orderId)).select("*").maybeSingle();
  if (error) {
    if (missingProcessingFeeColumns(error)) return null;
    throw error;
  }
  return data;
}

async function snapshotEstimatedProcessingFee(order) {
  try {
    const { config } = await loadPaymentFeeConfig();
    const snapshot = processingFeeSnapshotForOrder(order, config);
    return (await updateOrderProcessingFee(order.id, snapshot)) || { ...order, ...snapshot };
  } catch (error) {
    console.error("[payment-fees] Could not snapshot estimate.", { orderId: order?.id, code: error?.code || "unknown" });
    return order;
  }
}

/** @type {null | {
 *   getClient?: () => any,
 *   getOrderByIdForService?: (id: string) => Promise<object|null>,
 *   isSupabaseInventoryBackend?: () => boolean,
 *   buildWalkInSaleOps?: Function,
 *   rpcWalkInOrderComplete?: Function,
 *   assertStockAvailableForItems?: Function,
 *   decrementWalkInPaidStock?: Function,
 * }} */
let walkInTestDeps = null;

/** Test-only dependency injection for Walk-in completion / handoff. */
export function __setWalkInCompleteDepsForTests(deps) {
  walkInTestDeps = deps && typeof deps === "object" ? deps : null;
}

export function __resetWalkInCompleteDepsForTests() {
  walkInTestDeps = null;
}

/** PostgREST: bigint id must be a number in filters; uuid stays a string. */
export function coerceOrderIdForQuery(orderId) {
  if (orderId == null || orderId === "") {
    return orderId;
  }

  const s = String(orderId).trim();

  if (/^\d+$/.test(s)) {
    return Number(s);
  }

  return s;
}

function orderRowNowIso() {
  return new Date().toISOString();
}

function isMissingSchemaColumnError(error, columnName) {
  const needle = String(columnName || "").trim();
  if (!needle) return false;
  const raw = [error?.message, error?.details, error?.hint].filter(Boolean).join(" ");
  const text = String(raw || "");
  return /schema cache/i.test(text) && /column/i.test(text) && text.includes(`'${needle}'`);
}

function normalizeDestinationState(raw) {
  const s = String(raw || "")
    .trim()
    .toUpperCase();
  if (s.length === 2 && /^[A-Z]{2}$/.test(s)) {
    return s;
  }
  return null;
}

function merchandiseEconomicsColumnsFromQuote(quote) {
  const items = Array.isArray(quote?.items) ? quote.items : [];
  return computeEconomicsSnapshotForOrder(items, quote);
}

function normalizeOptionalText(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

function normalizeNonNegativeCents(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return 0;
  }
  return Math.max(0, Math.round(num));
}

function normalizeJsonObjectOrNull(value) {
  if (!value) {
    return null;
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    return value;
  }
  if (typeof value === "string") {
    const raw = value.trim();
    if (!raw) {
      return null;
    }
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

function buildQuotedAddressSnapshot(quote, shippingAddress) {
  const quotedNormalizedAddress = normalizeJsonObjectOrNull(quote?.addressValidation?.normalizedAddress);
  const quotedValidation = normalizeJsonObjectOrNull(quote?.addressValidation);
  const inputAddress = normalizeJsonObjectOrNull(shippingAddress);
  const manualDiscount = normalizeJsonObjectOrNull(quote?.manualDiscount);
  const includeManualDiscount =
    manualDiscount && String(manualDiscount.type || "").trim().toLowerCase() !== "none";
  if (!quotedNormalizedAddress && !quotedValidation && !inputAddress && !includeManualDiscount) {
    return null;
  }
  return {
    ...(inputAddress ? { inputAddress } : {}),
    ...(quotedNormalizedAddress ? { normalizedAddress: quotedNormalizedAddress } : {}),
    ...(quotedValidation ? { addressValidation: quotedValidation } : {}),
    ...(includeManualDiscount ? { manualDiscount } : {}),
  };
}

export function buildOrderQuoteSnapshotColumns({ quote, shippingAddress }) {
  const shipping = quote?.shipping && typeof quote.shipping === "object" ? quote.shipping : {};
  const shippingAmountCents = normalizeNonNegativeCents(
    shipping.amountCents != null ? shipping.amountCents : quote?.shippingCents,
  );
  const baseAmountCents = normalizeNonNegativeCents(
    shipping.baseAmountCents != null ? shipping.baseAmountCents : shippingAmountCents,
  );
  const bufferAmountCents = normalizeNonNegativeCents(
    shipping.bufferCents != null ? shipping.bufferCents : 0,
  );
  const residentialSurchargeCents = normalizeNonNegativeCents(shipping.residentialSurchargeCents);
  const shippingTotalCents = normalizeNonNegativeCents(
    shipping.totalCents != null ? shipping.totalCents : shippingAmountCents + residentialSurchargeCents,
  );
  const taxableShippingCents = normalizeNonNegativeCents(shipping.taxableShippingCents);
  const parcelSummary = normalizeJsonObjectOrNull(quote?.parcelSummary);
  const quotedParcelCount =
    parcelSummary?.parcelCount != null && Number.isFinite(Number(parcelSummary.parcelCount))
      ? Math.max(0, Math.round(Number(parcelSummary.parcelCount)))
      : 0;
  const quotedAddressIsResidential =
    shipping?.addressIsResidential === true ||
    quote?.addressValidation?.isResidential === true;
  const residentialSurchargePerPackageCents = normalizeNonNegativeCents(
    shipping.residentialSurchargePerPackageCents != null ? shipping.residentialSurchargePerPackageCents : 650,
  );
  const addressSnapshot = buildQuotedAddressSnapshot(quote, shippingAddress);

  return {
    checkout_quote_correlation_id: normalizeOptionalText(quote?.quoteCorrelationId),
    checkout_quote_expires_at: normalizeOptionalText(quote?.quoteExpiresAt),
    checkout_quote_fingerprint: normalizeOptionalText(quote?.requestFingerprint),
    checkout_quote_snapshot_json: normalizeJsonObjectOrNull(quote),
    selected_shipping_rate_snapshot_json: normalizeJsonObjectOrNull({
      providerQuoteId: shipping.providerQuoteId,
      provider: shipping.provider,
      serviceCode: shipping.serviceCode,
      serviceLabel: shipping.serviceLabel,
      amountCents: shippingAmountCents,
      totalCents: shippingTotalCents,
      currency: shipping.currency || quote?.currency || "USD",
      packageRateObjectIds: shipping.selectedPackageRateObjectIds,
      packageShipmentObjectIds: shipping.selectedPackageShipmentObjectIds,
    }),
    quoted_shipping_mode: normalizeOptionalText(shipping.mode),
    quoted_shipping_status: normalizeOptionalText(shipping.quoteStatus),
    /** Customer-facing carrier line (includes buffer when configured). */
    quoted_shipping_amount_cents: shippingAmountCents,
    /** Provider-quoted line before buffer (e.g. live Shippo/UPS). */
    quoted_shipping_base_amount_cents: baseAmountCents,
    /** Cents added at quote time (e.g. SHIPPING_BUFFER_CENTS). */
    quoted_shipping_buffer_cents: bufferAmountCents,
    quoted_shipping_residential_surcharge_cents: residentialSurchargeCents,
    quoted_shipping_total_cents: shippingTotalCents,
    quoted_shipping_service_code: normalizeOptionalText(shipping.serviceCode),
    quoted_shipping_service_label: normalizeOptionalText(shipping.serviceLabel),
    quoted_shipping_currency: normalizeOptionalText(shipping.currency || quote?.currency || "USD"),
    quoted_shipping_provider: normalizeOptionalText(shipping.provider),
    quoted_shipping_provider_quote_id: normalizeOptionalText(shipping.providerQuoteId),
    quoted_parcel_summary_json: parcelSummary,
    quoted_parcel_count: quotedParcelCount,
    quoted_address_is_residential: quotedAddressIsResidential,
    quoted_residential_surcharge_cents: residentialSurchargeCents,
    quoted_residential_surcharge_per_package_cents: residentialSurchargePerPackageCents,
    quoted_address_snapshot_json: addressSnapshot,
    quoted_taxable_shipping_cents: taxableShippingCents,
    paid_shipping_amount_cents: normalizeNonNegativeCents(quote?.shippingCents),
  };
}

export async function createPendingOrder({ quote, customer, hardinDiscount, shippingAddress, checkoutAttemptId, fulfillmentMethod }) {
  const client = getClient();
  const life = lifecycleForFulfillment(fulfillmentMethod);

  const shippingState =
    normalizeDestinationState(customer.shippingState) ||
    normalizeDestinationState(customer.state) ||
    null;
  const amountCents = Math.max(0, Number(quote.subtotalCents) || 0) + Math.max(0, Number(quote.shippingCents) || 0);
  const taxCollected = Math.max(0, Number(quote.taxCents) || 0);
  const hardinOn = Boolean(
    hardinDiscount?.applied &&
      (hardinDiscount?.code ||
        hardinDiscount?.adminAddressVerified === true ||
        hardinDiscount?.adminOverride === true),
  );

  // Do not send `id`: your table may use bigint identity or uuid default — DB assigns it.
  const payload = {
    order_ref: generateOrderRef(),
    status: "pending",
    order_status: "payment_processing",
    order_source: "web",
    order_type: "online",
    checkout_attempt_id: checkoutAttemptId,
    customer_name: customer.name || null,
    customer_email: customer.email || null,
    customer_phone: customer.phone || null,
    customer_address: customer.address || null,
    shipping_address: shippingAddress && typeof shippingAddress === "object" ? shippingAddress : null,
    items: quote.items,
    subtotal_cents: quote.subtotalCents,
    shipping_cents: quote.shippingCents,
    tax_cents: quote.taxCents,
    total_cents: quote.totalCents,
    state: shippingState,
    amount: amountCents,
    tax_collected: taxCollected,
    ...buildOrderQuoteSnapshotColumns({ quote, shippingAddress }),
    discount_code_used: hardinOn && hardinDiscount.code ? String(hardinDiscount.code) : null,
    is_hardin_discount: hardinOn,
    updated_at: orderRowNowIso(),
    ...merchandiseEconomicsColumnsFromQuote(quote),
    ...life,
  };

  const { data, error } = await client.from("orders").insert(payload).select().single();

  if (error) {
    if (String(error.code || "") === "23505" && checkoutAttemptId) {
      const { data: existing, error: existingError } = await client
        .from("orders")
        .select("*")
        .eq("checkout_attempt_id", checkoutAttemptId)
        .maybeSingle();
      if (existingError) throw existingError;
      if (existing) {
        const sameCheckout =
          String(existing.order_source || "") === "web" &&
          Number(existing.total_cents) === Number(quote.totalCents) &&
          String(existing.customer_email || "").trim().toLowerCase() ===
            String(customer.email || "").trim().toLowerCase();
        if (!sameCheckout) {
          const conflict = new Error("Checkout session no longer matches this order. Refresh and try again.");
          conflict.statusCode = 409;
          throw conflict;
        }
        return existing;
      }
    }
    throw error;
  }

  return snapshotEstimatedProcessingFee(data);
}

/**
 * Staff-created phone / manual order — saved as draft until a payment link is emailed.
 * Discount code is validated at creation but not claimed until send-payment-link.
 * @param {{ paymentFlow?: string, fulfillmentMethod?: string, shipmentDate?: string | null, manualPaymentMethod?: string | null }} [opts]
 */
export async function createManualOrderDraft(
  { quote, customer, hardinDiscount, shippingAddress },
  opts = {},
) {
  const client = getClient();

  const life = lifecycleForFulfillment(opts.fulfillmentMethod);
  const paymentFlow = normalizePaymentFlow(opts.paymentFlow);
  const shipmentDate =
    opts.shipmentDate === null || opts.shipmentDate === undefined || String(opts.shipmentDate).trim() === ""
      ? null
      : String(opts.shipmentDate).trim();

  const shippingState =
    normalizeDestinationState(customer.shippingState) ||
    normalizeDestinationState(customer.state) ||
    null;
  const amountCents = Math.max(0, Number(quote.subtotalCents) || 0) + Math.max(0, Number(quote.shippingCents) || 0);
  const taxCollected = Math.max(0, Number(quote.taxCents) || 0);
  const hardinOn = Boolean(
    hardinDiscount?.applied &&
      (hardinDiscount?.code ||
        hardinDiscount?.adminAddressVerified === true ||
        hardinDiscount?.adminOverride === true),
  );

  const payload = {
    order_ref: generateOrderRef(),
    status: "pending",
    order_status: "draft",
    order_source: "manual",
    order_type: "manual",
    customer_name: customer.name || null,
    customer_email: customer.email || null,
    customer_phone: customer.phone || null,
    customer_address: customer.address || null,
    shipping_address: shippingAddress && typeof shippingAddress === "object" ? shippingAddress : null,
    items: quote.items,
    subtotal_cents: quote.subtotalCents,
    shipping_cents: quote.shippingCents,
    tax_cents: quote.taxCents,
    total_cents: quote.totalCents,
    state: shippingState,
    amount: amountCents,
    tax_collected: taxCollected,
    ...buildOrderQuoteSnapshotColumns({ quote, shippingAddress }),
    discount_code_used: hardinOn && hardinDiscount.code ? String(hardinDiscount.code) : null,
    is_hardin_discount: hardinOn,
    admin_local_discount_override: Boolean(hardinDiscount?.adminOverride === true),
    updated_at: orderRowNowIso(),
    ...merchandiseEconomicsColumnsFromQuote(quote),
    ...life,
    payment_flow: paymentFlow,
    manual_payment_method:
      paymentFlow === "pay_later" && String(opts.manualPaymentMethod || "").trim() === "arrival_payment_link"
        ? "arrival_payment_link"
        : null,
    shippo_shipment_date: shipmentDate,
  };

  const { data, error } = await client.from("orders").insert(payload).select().single();

  if (error) {
    throw error;
  }

  return snapshotEstimatedProcessingFee(data);
}

/**
 * Replace an existing manual draft with a new quote + customer snapshot (staff only; service role).
 * @param {{ paymentFlow?: string, fulfillmentMethod?: string, shipmentDate?: string | null }} [orderOpts]
 */
export async function updateManualOrderDraft(
  orderId,
  { quote, customer, hardinDiscount, shippingAddress },
  orderOpts = {},
) {
  const client = getClient();
  const idFilter = coerceOrderIdForQuery(orderId);
  const existing = await getOrderByIdForService(orderId);
  if (!existing) {
    const e = new Error("Order not found.");
    e.statusCode = 404;
    throw e;
  }
  if (String(existing.order_source || "") !== "manual") {
    const e = new Error("Only manual orders can be updated here.");
    e.statusCode = 400;
    throw e;
  }
  if (String(existing.order_status || "") !== "draft") {
    const e = new Error("Only draft orders can be edited.");
    e.statusCode = 400;
    throw e;
  }

  const shippingState =
    normalizeDestinationState(customer.shippingState) ||
    normalizeDestinationState(customer.state) ||
    null;
  const amountCents = Math.max(0, Number(quote.subtotalCents) || 0) + Math.max(0, Number(quote.shippingCents) || 0);
  const taxCollected = Math.max(0, Number(quote.taxCents) || 0);
  const hardinOn = Boolean(
    hardinDiscount?.applied &&
      (hardinDiscount?.code ||
        hardinDiscount?.adminAddressVerified === true ||
        hardinDiscount?.adminOverride === true),
  );

  const fKey =
    orderOpts.fulfillmentMethod != null ? orderOpts.fulfillmentMethod : existing.fulfillment_method;
  const life = lifecycleForFulfillment(fKey);
  const paymentFlow =
    orderOpts.paymentFlow != null ? normalizePaymentFlow(orderOpts.paymentFlow) : normalizePaymentFlow(existing.payment_flow);
  const shipmentDate =
    orderOpts.shipmentDate === null || orderOpts.shipmentDate === undefined || String(orderOpts.shipmentDate).trim() === ""
      ? null
      : String(orderOpts.shipmentDate).trim();

  const payload = {
    ...life,
    customer_name: customer.name || null,
    customer_email: customer.email || null,
    customer_phone: customer.phone || null,
    customer_address: customer.address || null,
    shipping_address: shippingAddress && typeof shippingAddress === "object" ? shippingAddress : null,
    items: quote.items,
    subtotal_cents: quote.subtotalCents,
    shipping_cents: quote.shippingCents,
    tax_cents: quote.taxCents,
    total_cents: quote.totalCents,
    state: shippingState,
    amount: amountCents,
    tax_collected: taxCollected,
    ...buildOrderQuoteSnapshotColumns({ quote, shippingAddress }),
    discount_code_used: hardinOn && hardinDiscount.code ? String(hardinDiscount.code) : null,
    is_hardin_discount: hardinOn,
    admin_local_discount_override: Boolean(hardinDiscount?.adminOverride === true),
    updated_at: orderRowNowIso(),
    ...merchandiseEconomicsColumnsFromQuote(quote),
    payment_flow: paymentFlow,
    shippo_shipment_date: shipmentDate,
  };

  const { data, error } = await client.from("orders").update(payload).eq("id", idFilter).select().single();

  if (error) {
    throw error;
  }
  return snapshotEstimatedProcessingFee(data);
}

export async function deleteManualOrderDraft(orderId) {
  const client = getClient();
  const idFilter = coerceOrderIdForQuery(orderId);
  const existing = await getOrderByIdForService(orderId);
  if (!existing) {
    const e = new Error("Order not found.");
    e.statusCode = 404;
    throw e;
  }
  if (String(existing.order_source || "") !== "manual") {
    const e = new Error("Only manual drafts can be deleted here.");
    e.statusCode = 400;
    throw e;
  }
  if (String(existing.order_status || "") !== "draft") {
    const e = new Error("Only draft orders can be deleted.");
    e.statusCode = 400;
    throw e;
  }

  const { error } = await client.from("orders").delete().eq("id", idFilter);
  if (error) {
    throw error;
  }
  return { ok: true };
}

export async function listManualDraftOrders() {
  const client = getClient();
  const { data, error } = await client
    .from("orders")
    .select(
      "id, order_ref, customer_name, customer_email, total_cents, created_at, updated_at, order_status, order_source",
    )
    .eq("order_source", "manual")
    .eq("order_status", "draft")
    .order("updated_at", { ascending: false, nullsFirst: false });

  if (error) {
    throw error;
  }
  return Array.isArray(data) ? data : [];
}

/**
 * Walk-in draft (cash/check) — same quote shape as manual; `order_source` / `order_type` are walk_in.
 * Server-owned lifecycle: pickup / no shipping / no Shippo label. Shipping cents forced to $0.
 */
export async function createWalkInOrderDraft({ quote, customer, hardinDiscount, shippingAddress }) {
  const client = getClient();
  const life = lifecycleForFulfillment("pickup");

  const shippingState =
    normalizeDestinationState(customer.shippingState) ||
    normalizeDestinationState(customer.state) ||
    null;
  const taxCollected = Math.max(0, Number(quote.taxCents) || 0);
  const hardinOn = Boolean(
    hardinDiscount?.applied &&
      (hardinDiscount?.code ||
        hardinDiscount?.adminAddressVerified === true ||
        hardinDiscount?.adminOverride === true),
  );

  const zeroShipQuote = {
    ...quote,
    shippingCents: 0,
    shipping:
      quote?.shipping && typeof quote.shipping === "object"
        ? {
            ...quote.shipping,
            amountCents: 0,
            baseAmountCents: 0,
            bufferCents: 0,
            residentialSurchargeCents: 0,
            taxableShippingCents: 0,
            provider: "none",
            quoteStatus: "included_in_merchandise",
          }
        : quote?.shipping,
  };
  const amountCents = Math.max(0, Number(zeroShipQuote.subtotalCents) || 0);

  const payload = {
    order_ref: generateOrderRef(),
    status: "pending",
    order_status: "draft",
    order_source: "walk_in",
    order_type: "walk_in",
    customer_name: customer.name || null,
    customer_email: customer.email || null,
    customer_phone: customer.phone || null,
    customer_address: customer.address || null,
    shipping_address: shippingAddress && typeof shippingAddress === "object" ? shippingAddress : null,
    items: zeroShipQuote.items,
    subtotal_cents: zeroShipQuote.subtotalCents,
    shipping_cents: 0,
    tax_cents: zeroShipQuote.taxCents,
    total_cents: zeroShipQuote.totalCents,
    state: shippingState,
    amount: amountCents,
    tax_collected: taxCollected,
    ...buildOrderQuoteSnapshotColumns({ quote: zeroShipQuote, shippingAddress }),
    discount_code_used: hardinOn && hardinDiscount.code ? String(hardinDiscount.code) : null,
    is_hardin_discount: hardinOn,
    admin_local_discount_override: Boolean(hardinDiscount?.adminOverride === true),
    updated_at: orderRowNowIso(),
    ...merchandiseEconomicsColumnsFromQuote(zeroShipQuote),
    ...life,
  };

  const { data, error } = await client.from("orders").insert(payload).select().single();

  if (error) {
    throw error;
  }

  return data;
}

/**
 * Update an existing walk-in draft (staff only; service role).
 * Re-applies server-owned pickup / no-label lifecycle flags; shipping forced to $0.
 */
export async function updateWalkInOrderDraft(orderId, { quote, customer, hardinDiscount, shippingAddress }) {
  const client = getClient();
  const idFilter = coerceOrderIdForQuery(orderId);
  const existing = await getOrderByIdForService(orderId);
  if (!existing) {
    const e = new Error("Order not found.");
    e.statusCode = 404;
    throw e;
  }
  if (String(existing.order_source || "") !== "walk_in") {
    const e = new Error("Only walk-in orders can be updated here.");
    e.statusCode = 400;
    throw e;
  }
  if (String(existing.order_status || "") !== "draft") {
    const e = new Error("Only draft orders can be edited.");
    e.statusCode = 400;
    throw e;
  }

  const life = lifecycleForFulfillment("pickup");
  const shippingState =
    normalizeDestinationState(customer.shippingState) ||
    normalizeDestinationState(customer.state) ||
    null;
  const taxCollected = Math.max(0, Number(quote.taxCents) || 0);
  const hardinOn = Boolean(
    hardinDiscount?.applied &&
      (hardinDiscount?.code ||
        hardinDiscount?.adminAddressVerified === true ||
        hardinDiscount?.adminOverride === true),
  );

  const zeroShipQuote = {
    ...quote,
    shippingCents: 0,
    shipping:
      quote?.shipping && typeof quote.shipping === "object"
        ? {
            ...quote.shipping,
            amountCents: 0,
            baseAmountCents: 0,
            bufferCents: 0,
            residentialSurchargeCents: 0,
            taxableShippingCents: 0,
            provider: "none",
            quoteStatus: "included_in_merchandise",
          }
        : quote?.shipping,
  };
  const amountCents = Math.max(0, Number(zeroShipQuote.subtotalCents) || 0);

  const payload = {
    customer_name: customer.name || null,
    customer_email: customer.email || null,
    customer_phone: customer.phone || null,
    customer_address: customer.address || null,
    shipping_address: shippingAddress && typeof shippingAddress === "object" ? shippingAddress : null,
    items: zeroShipQuote.items,
    subtotal_cents: zeroShipQuote.subtotalCents,
    shipping_cents: 0,
    tax_cents: zeroShipQuote.taxCents,
    total_cents: zeroShipQuote.totalCents,
    state: shippingState,
    amount: amountCents,
    tax_collected: taxCollected,
    ...buildOrderQuoteSnapshotColumns({ quote: zeroShipQuote, shippingAddress }),
    discount_code_used: hardinOn && hardinDiscount.code ? String(hardinDiscount.code) : null,
    is_hardin_discount: hardinOn,
    admin_local_discount_override: Boolean(hardinDiscount?.adminOverride === true),
    updated_at: orderRowNowIso(),
    ...merchandiseEconomicsColumnsFromQuote(zeroShipQuote),
    ...life,
    order_source: "walk_in",
    order_type: "walk_in",
  };

  const { data, error } = await client.from("orders").update(payload).eq("id", idFilter).select().single();

  if (error) {
    throw error;
  }
  return data;
}

export async function deleteWalkInOrderDraft(orderId) {
  const client = getClient();
  const idFilter = coerceOrderIdForQuery(orderId);
  const existing = await getOrderByIdForService(orderId);
  if (!existing) {
    const e = new Error("Order not found.");
    e.statusCode = 404;
    throw e;
  }
  if (String(existing.order_source || "") !== "walk_in") {
    const e = new Error("Only walk-in drafts can be deleted here.");
    e.statusCode = 400;
    throw e;
  }
  if (String(existing.order_status || "") !== "draft") {
    const e = new Error("Only draft orders can be deleted.");
    e.statusCode = 400;
    throw e;
  }

  const { error } = await client.from("orders").delete().eq("id", idFilter);
  if (error) {
    throw error;
  }
  return { ok: true };
}

export async function listWalkInDraftOrders() {
  const client = getClient();
  const { data, error } = await client
    .from("orders")
    .select(
      "id, order_ref, customer_name, customer_email, total_cents, created_at, updated_at, order_status, order_source, order_type",
    )
    .eq("order_source", "walk_in")
    .eq("order_status", "draft")
    .order("updated_at", { ascending: false, nullsFirst: false });

  if (error) {
    throw error;
  }
  return Array.isArray(data) ? data : [];
}

/**
 * Complete a Walk-in draft: record cash/check payment, commit inventory exactly once, and
 * mark physical handoff complete (`admin_handoff_at` + `order_status=shipped`).
 *
 * Successful response means payment + inventory + handoff are durably consistent.
 * Idempotent when already completed. Never returns inventoryWarning on a successful completion.
 *
 * @param {{ orderId: string, paymentMethod: "cash" | "check", actorEmail?: string | null }} args
 * @returns {Promise<object & { idempotent?: boolean, inventoryCommitted?: boolean }>}
 */
export async function markWalkInOrderPaid({ orderId, paymentMethod, actorEmail = null }) {
  const method = String(paymentMethod || "").toLowerCase();
  if (method !== "cash" && method !== "check") {
    const e = new Error("paymentMethod must be cash or check.");
    e.statusCode = 400;
    throw e;
  }

  const existing = await getOrderByIdForService(orderId);
  if (!existing) {
    const e = new Error("Order not found.");
    e.statusCode = 404;
    throw e;
  }
  if (String(existing.order_source || "") !== "walk_in") {
    const e = new Error("Only walk-in orders can be marked paid here.");
    e.statusCode = 400;
    throw e;
  }
  if (String(existing.order_status || "") === "cancelled") {
    const e = new Error("Cancelled orders cannot be completed.");
    e.statusCode = 400;
    throw e;
  }

  if (isWalkInOrderFullyCompleted(existing)) {
    return {
      ...existing,
      idempotent: true,
      inventoryCommitted: true,
    };
  }

  if (String(existing.order_status || "") !== "draft") {
    const e = new Error("Only walk-in drafts awaiting payment can be marked paid.");
    e.statusCode = 400;
    throw e;
  }

  const items = Array.isArray(existing.items) ? existing.items : [];
  const actor =
    actorEmail != null && String(actorEmail).trim() ? String(actorEmail).trim() : null;

  const useSupabaseInventory =
    typeof walkInTestDeps?.isSupabaseInventoryBackend === "function"
      ? walkInTestDeps.isSupabaseInventoryBackend()
      : isSupabaseInventoryBackend();

  if (useSupabaseInventory) {
    const buildOps = walkInTestDeps?.buildWalkInSaleOps || inventoryService.buildWalkInSaleOps;
    const rpcComplete = walkInTestDeps?.rpcWalkInOrderComplete || inventoryRepo.rpcWalkInOrderComplete;
    const ops = items.length
      ? await buildOps(items, {
          orderId: String(existing.id),
          adminUser: actor,
          reason: "Walk-in sale",
        })
      : [];
    const result = await rpcComplete(String(existing.id), method, ops, actor);
    const order = result.order || (await getOrderByIdForService(orderId));
    if (!order) {
      const e = new Error("Could not complete walk-in order.");
      e.statusCode = 500;
      throw e;
    }
    return {
      ...order,
      idempotent: result.idempotent === true,
      inventoryCommitted: true,
    };
  }

  // File / local inventory backend: process-local stock mutex + conditional order update.
  // Not fully transactional across file+Supabase; Production must use Supabase inventory.
  const assertStock = walkInTestDeps?.assertStockAvailableForItems || assertStockAvailableForItems;
  const decrementStock = walkInTestDeps?.decrementWalkInPaidStock || decrementWalkInPaidStock;
  await assertStock(items);

  if (items.length) {
    await decrementStock(items, {
      orderId: String(existing.id),
      adminUser: actor,
      reason: "Walk-in sale",
    });
  }

  const paidAt = orderRowNowIso();
  const paymentId = `walk_in:${method}`;
  const life = lifecycleForFulfillment("pickup");
  const client = getClient();
  const idFilter = coerceOrderIdForQuery(orderId);

  const { data, error } = await client
    .from("orders")
    .update({
      status: "paid",
      order_status: "shipped",
      payment_method: method,
      payment_id: paymentId,
      paid_at: paidAt,
      provider: "walk_in",
      shipping_cents: 0,
      paid_shipping_amount_cents: 0,
      admin_handoff_at: paidAt,
      inventory_committed_at: paidAt,
      ...life,
      updated_at: paidAt,
    })
    .eq("id", idFilter)
    .eq("order_status", "draft")
    .is("inventory_committed_at", null)
    .select()
    .maybeSingle();

  if (error) {
    throw error;
  }
  if (!data) {
    const again = await getOrderByIdForService(orderId);
    if (again && isWalkInOrderFullyCompleted(again)) {
      return { ...again, idempotent: true, inventoryCommitted: true };
    }
    const e = new Error("Order could not be updated (it may have already been paid).");
    e.statusCode = 409;
    throw e;
  }

  return { ...data, idempotent: false, inventoryCommitted: true };
}

export function isWalkInOrderRow(row) {
  return String(row?.order_type || "") === "walk_in" || String(row?.order_source || "") === "walk_in";
}

export function isAdminHandoffAlreadyComplete(row) {
  return Boolean(row?.admin_handoff_at) || String(row?.order_status || "").toLowerCase() === "shipped";
}

export function isWalkInOrderFullyCompleted(row) {
  if (!row) return false;
  if (!isWalkInOrderRow(row)) return false;
  if (String(row.status || "").toLowerCase() !== "paid") return false;
  if (String(row.order_status || "") !== "shipped") return false;
  if (!row.admin_handoff_at) return false;
  if (!row.inventory_committed_at) return false;
  return true;
}

const MANUAL_IN_PERSON_METHODS = new Set(["cash", "check", "other"]);

/**
 * Mark a pay-later manual draft as paid (cash / check / other in person). Stock uses the same
 * on-hand path as walk-in: {@link decrementWalkInPaidStock} (not web reserve).
 * @param {{ orderId: string, manualPaymentMethod: string, paymentNote?: string | null, recordedByEmail?: string | null }} args
 */
export async function markManualPayLaterOrderRecorded({
  orderId,
  manualPaymentMethod,
  paymentNote = null,
  recordedByEmail = null,
}) {
  const method = String(manualPaymentMethod || "")
    .trim()
    .toLowerCase();
  if (!MANUAL_IN_PERSON_METHODS.has(method)) {
    const e = new Error("manualPaymentMethod must be cash, check, or other.");
    e.statusCode = 400;
    throw e;
  }

  const client = getClient();
  const idFilter = coerceOrderIdForQuery(orderId);
  const existing = await getOrderByIdForService(orderId);
  if (!existing) {
    const e = new Error("Order not found.");
    e.statusCode = 404;
    throw e;
  }
  if (String(existing.order_source || "") !== "manual") {
    const e = new Error("Only manual orders can be recorded with this action.");
    e.statusCode = 400;
    throw e;
  }
  if (String(existing.payment_flow || "") !== "pay_later") {
    const e = new Error("Order is not a pay-later manual order.");
    e.statusCode = 400;
    throw e;
  }
  if (String(existing.status || "") === "paid" || String(existing.order_status || "") === "paid") {
    const e = new Error("This order is already paid.");
    e.statusCode = 409;
    throw e;
  }
  if (String(existing.order_status || "") !== "draft") {
    const e = new Error("Only a draft pay-later order can be recorded (unexpected order state).");
    e.statusCode = 400;
    throw e;
  }

  const fm = String(existing.fulfillment_method || "carrier");
  let nextOrderStatus = "ready_to_ship";
  if (fm === "pickup") {
    nextOrderStatus = "ready_for_pickup";
  } else if (fm === "local_delivery") {
    nextOrderStatus = "ready_for_local_delivery";
  }

  const paidAt = orderRowNowIso();
  const paidShippingCents = Math.max(
    0,
    Number(existing.paid_shipping_amount_cents ?? existing.quoted_shipping_total_cents ?? existing.shipping_cents) || 0,
  );
  const paymentId = `manual_in_person:${method}`;

  const noteTrim = paymentNote != null && String(paymentNote).trim() ? String(paymentNote).trim() : null;
  const by = recordedByEmail != null && String(recordedByEmail).trim() ? String(recordedByEmail).trim() : null;

  const baseUpdates = {
    status: "paid",
    order_status: nextOrderStatus,
    payment_method: method,
    payment_id: paymentId,
    paid_at: paidAt,
    provider: "manual",
    shipping_cents: paidShippingCents,
    paid_shipping_amount_cents: paidShippingCents,
    manual_payment_method: method,
    manual_payment_recorded_at: paidAt,
    manual_payment_recorded_by: by,
    updated_at: paidAt,
  };
  const updates = noteTrim != null ? { ...baseUpdates, manual_payment_note: noteTrim } : baseUpdates;

  let { data, error } = await client
    .from("orders")
    .update(updates)
    .eq("id", idFilter)
    .eq("order_source", "manual")
    .eq("payment_flow", "pay_later")
    .eq("order_status", "draft")
    .neq("status", "paid")
    .select()
    .maybeSingle();

  if (error && noteTrim != null && isMissingSchemaColumnError(error, "manual_payment_note")) {
    ({ data, error } = await client
      .from("orders")
      .update(baseUpdates)
      .eq("id", idFilter)
      .eq("order_source", "manual")
      .eq("payment_flow", "pay_later")
      .eq("order_status", "draft")
      .neq("status", "paid")
      .select()
      .maybeSingle());
  }

  if (error) {
    throw error;
  }
  if (!data) {
    const e = new Error("Order could not be updated (it may have already been paid).");
    e.statusCode = 409;
    throw e;
  }

  try {
    if (Array.isArray(data?.items) && data.items.length) {
      await decrementWalkInPaidStock(data.items, { orderId: String(data.id) });
    }
  } catch (err) {
    console.error("[stock] decrement after markManualPayLaterOrderRecorded failed:", data?.id, err);
  }

  return data;
}

export async function getOrderByIdForService(orderId) {
  if (walkInTestDeps?.getOrderByIdForService) {
    return walkInTestDeps.getOrderByIdForService(orderId);
  }
  const client = getClient();
  const idFilter = coerceOrderIdForQuery(orderId);
  const { data, error } = await client.from("orders").select("*").eq("id", idFilter).maybeSingle();
  if (error) {
    throw error;
  }
  return data || null;
}

export async function updateOrderPaymentLinkSent(orderId, paymentLinkUrl, details = {}) {
  const client = getClient();
  const idFilter = coerceOrderIdForQuery(orderId);
  const existing = await getOrderByIdForService(orderId);
  const url = String(paymentLinkUrl || "").trim() || null;
  const nowIso = orderRowNowIso();
  const lifecycleBackfillForManual =
    url &&
    existing &&
    String(existing.order_source || "") === "manual" &&
    existing.fulfillment_method == null
      ? defaultManualOrderLifecycleFields()
      : {};
  const { data, error } = await client
    .from("orders")
    .update({
      order_status: "payment_link_sent",
      payment_link_url: url,
      payment_link_id: url ? String(details.paymentLinkId || "").trim() || null : null,
      payment_link_created_at: url ? nowIso : null,
      payment_link_status: url ? "active" : null,
      payment_flow: url ? "square_payment_link" : null,
      payment_link_sent_at: url ? nowIso : null,
      payment_link_expires_at: url ? new Date(Date.now() + MANUAL_PAYMENT_LINK_VALID_MS).toISOString() : null,
      ...lifecycleBackfillForManual,
      updated_at: nowIso,
    })
    .eq("id", idFilter)
    .select()
    .maybeSingle();

  if (error) {
    throw error;
  }
  return data || null;
}

export async function resetExpiredManualPaymentLink(orderId) {
  const client = getClient();
  const idFilter = coerceOrderIdForQuery(orderId);
  const { data, error } = await client
    .from("orders")
    .update({
      order_status: "draft",
      payment_link_url: null,
      payment_link_id: null,
      payment_link_status: "expired",
      updated_at: orderRowNowIso(),
    })
    .eq("id", idFilter)
    .eq("order_source", "manual")
    .neq("status", "paid")
    .select()
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

/**
 * After a failed card charge, mark the row cancelled so the dashboard does not show a stray
 * "awaiting payment" order. Only updates rows still awaiting payment with no payment_id.
 */
export async function cancelPendingOrderAfterPaymentFailure(orderId) {
  if (orderId == null || orderId === "") {
    return false;
  }
  const client = getClient();
  const idFilter = coerceOrderIdForQuery(orderId);
  const { data, error } = await client
    .from("orders")
    .update({
      order_status: "cancelled",
      status: "cancelled",
    })
    .eq("id", idFilter)
    .in("order_status", ["awaiting_payment", "payment_processing"])
    .select("id")
    .maybeSingle();

  if (error) {
    console.error("[orders] cancelPendingOrderAfterPaymentFailure", error);
    return false;
  }

  if (data) {
    await releaseDiscountCodeForOrder(idFilter);
  }

  return Boolean(data);
}

/**
 * @param {{ orderId: string, paymentId: string, paidTotalCents?: number, customerAddress?: string | null, buyerEmail?: string | null, buyerPhone?: string | null, buyerName?: string | null }} args
 * When `paidTotalCents` is set (Square amount actually charged), `total_cents` and `paid_shipping_amount_cents`
 * are updated so they reflect shipping/add-ons collected on Square’s checkout.
 */
export async function markOrderPaid({
  orderId,
  paymentId,
  paidTotalCents,
  customerAddress,
  buyerEmail,
  buyerPhone,
  buyerName,
  payment,
}) {
  const client = getClient();
  const idFilter = coerceOrderIdForQuery(orderId);

  const { data: existingRows, error: fetchError } = await client
    .from("orders")
    .select("*")
    .eq("id", idFilter)
    .limit(1);

  if (fetchError) {
    throw fetchError;
  }

  const existing = existingRows?.[0];
  if (!existing) {
    return null;
  }

  if (existing.status === "paid") {
    const actualFee = actualProcessingFeeFromSquarePayment(payment);
    if (actualFee != null) {
      await updateOrderProcessingFee(existing.id, {
        actual_processing_fee_cents: actualFee,
        processing_fee_status: "actual",
        processing_fee_details_json: { source: "square_payment", processingFee: payment.processing_fee || [] },
      });
    }
    return null;
  }

  const expectedTotalCents = Math.max(0, Math.round(Number(existing.total_cents) || 0));
  if (
    paidTotalCents != null &&
    Number.isFinite(Number(paidTotalCents)) &&
    Math.round(Number(paidTotalCents)) !== expectedTotalCents
  ) {
    const mismatch = new Error("Square payment amount does not match the signed order total.");
    mismatch.statusCode = 409;
    mismatch.code = "SQUARE_PAYMENT_AMOUNT_MISMATCH";
    throw mismatch;
  }

  const subtotal = Math.max(0, Number(existing.subtotal_cents) || 0);
  const tax = Math.max(0, Number(existing.tax_cents) || 0);
  let shippingCents = Math.max(
    0,
    Number(existing.paid_shipping_amount_cents ?? existing.quoted_shipping_total_cents ?? existing.shipping_cents) || 0,
  );
  let totalCents = subtotal + shippingCents + tax;

  if (paidTotalCents != null && Number.isFinite(Number(paidTotalCents))) {
    totalCents = expectedTotalCents;
  }

  if (isSupabaseInventoryBackend() && String(existing.order_source || "") === "web") {
    try {
      const inventoryOps = await inventoryService.buildWebsiteOrderPaymentOps(existing.items, {
        orderId: String(existing.id),
        reason: "Online order payment",
      });
      const result = await inventoryRepo.rpcOnlineOrderPaymentComplete({
        orderId: existing.id,
        paymentId,
        paidTotalCents: totalCents,
        inventoryOps,
        customerAddress,
        buyerEmail,
        buyerPhone,
        buyerName,
      });
      const actualFee = actualProcessingFeeFromSquarePayment(payment);
      if (actualFee != null) {
        return (await updateOrderProcessingFee(result.order.id, {
          actual_processing_fee_cents: actualFee,
          processing_fee_status: "actual",
          processing_fee_details_json: { source: "square_payment", processingFee: payment.processing_fee || [] },
        })) || result.order;
      }
      return result.order;
    } catch (error) {
      const { error: reconciliationError } = await client
        .from("orders")
        .update({
          payment_id: paymentId,
          payment_reconciliation_required: true,
          payment_reconciliation_error: "online_payment_finalize_failed",
          updated_at: orderRowNowIso(),
        })
        .eq("id", idFilter)
        .neq("status", "paid");
      if (reconciliationError) {
        console.error("[orders] could not flag paid order for reconciliation", {
          orderId: existing.id,
          code: String(reconciliationError.code || "reconciliation_flag_failed").slice(0, 64),
        });
      }
      throw error;
    }
  }

  const updatePayload = {
    status: "paid",
    order_status: "paid_label_pending",
    payment_id: paymentId,
    total_cents: totalCents,
    shipping_cents: shippingCents,
    paid_shipping_amount_cents: shippingCents,
  };

  const addr = customerAddress != null ? String(customerAddress).trim() : "";
  if (addr) {
    updatePayload.customer_address = addr;
  }

  const em = buyerEmail != null ? String(buyerEmail).trim() : "";
  if (em) {
    updatePayload.customer_email = em;
  }

  const ph = buyerPhone != null ? String(buyerPhone).trim() : "";
  if (ph) {
    updatePayload.customer_phone = ph;
  }

  const nm = buyerName != null ? String(buyerName).trim() : "";
  if (nm) {
    updatePayload.customer_name = nm;
  }

  const { data, error } = await client
    .from("orders")
    .update(updatePayload)
    .eq("id", idFilter)
    .neq("status", "paid")
    .select("*");

  if (error) {
    throw error;
  }

  if (!data || data.length === 0) {
    return null;
  }

  const row = data[0];
  if (String(row.order_source || "") === "web") {
    try {
      const full = (await getOrderByIdForService(row.id)) || row;
      const items = full.items;
      if (Array.isArray(items) && items.length) {
        await commitWebsiteOrderStockOnPayment(items, { orderId: String(full.id) });
      }
    } catch (err) {
      console.error("[stock] reserve after markOrderPaid failed:", row?.id, err);
    }
  }

  const actualFee = actualProcessingFeeFromSquarePayment(payment);
  if (actualFee != null) {
    return (await updateOrderProcessingFee(row.id, {
      actual_processing_fee_cents: actualFee,
      processing_fee_status: "actual",
      processing_fee_details_json: { source: "square_payment", processingFee: payment.processing_fee || [] },
    })) || row;
  }
  if (String(row.provider || "square") === "square") {
    return (await updateOrderProcessingFee(row.id, { processing_fee_status: "awaiting_square" })) || row;
  }
  return row;
}

const VENDOR_PAID_NOTIFICATION_DEFAULT_STALE_MS = 12 * 60 * 60 * 1000;

const ALLOWED_VENDOR_NOTIFICATION_ERRORS = new Set([
  "vendor_notification_config_missing",
  "vendor_notification_send_failed",
  "vendor_notification_persist_failed",
  "vendor_notification_failed",
]);

/**
 * Allowlist-only sanitizer for vendor_paid_notification_error. Never stores raw provider/DB messages.
 * @param {unknown} value
 * @returns {string}
 */
function sanitizeVendorNotificationError(value) {
  if (typeof value === "string" && ALLOWED_VENDOR_NOTIFICATION_ERRORS.has(value)) {
    return value;
  }
  return "vendor_notification_failed";
}

/**
 * Atomically claim the right to send the vendor paid-order notification for a paid order.
 * @returns {Promise<{ order: object, claimedAt: string } | null>}
 */
export async function tryClaimVendorPaidNotification({
  orderId,
  paymentId,
  staleAfterMs = VENDOR_PAID_NOTIFICATION_DEFAULT_STALE_MS,
  client: injectedClient,
  getClient: injectedGetClient,
}) {
  const client = injectedClient ?? (injectedGetClient ? injectedGetClient() : getClient());
  const idFilter = coerceOrderIdForQuery(orderId);
  const claimedAt = orderRowNowIso();
  const staleCutoff = new Date(Date.now() - staleAfterMs).toISOString();

  const { data, error } = await client
    .from("orders")
    .update({
      vendor_paid_notification_claimed_at: claimedAt,
      vendor_paid_notification_error: null,
      updated_at: claimedAt,
    })
    .eq("id", idFilter)
    .eq("status", "paid")
    .eq("payment_id", String(paymentId))
    .is("vendor_paid_notification_sent_at", null)
    .or(`vendor_paid_notification_claimed_at.is.null,vendor_paid_notification_claimed_at.lt.${staleCutoff}`)
    .select("*");

  if (error) {
    throw error;
  }

  if (!data || data.length === 0) {
    return null;
  }

  return { order: data[0], claimedAt };
}

/**
 * Mark vendor paid-order notification sent after a successful Resend delivery.
 * @returns {Promise<boolean>} true when the row was updated
 */
export async function markVendorPaidNotificationSent({ orderId, claimedAt, resendId }) {
  const client = getClient();
  const idFilter = coerceOrderIdForQuery(orderId);
  const nowIso = orderRowNowIso();

  const { data, error } = await client
    .from("orders")
    .update({
      vendor_paid_notification_sent_at: nowIso,
      vendor_paid_notification_resend_id: resendId != null ? String(resendId) : null,
      vendor_paid_notification_claimed_at: null,
      vendor_paid_notification_error: null,
      updated_at: nowIso,
    })
    .eq("id", idFilter)
    .eq("vendor_paid_notification_claimed_at", claimedAt)
    .is("vendor_paid_notification_sent_at", null)
    .select("id");

  if (error) {
    throw error;
  }

  return Boolean(data && data.length > 0);
}

/**
 * Release a vendor notification claim after send failure or missing configuration.
 * @returns {Promise<boolean>} true when the row was updated
 */
export async function releaseVendorPaidNotificationClaim({
  orderId,
  claimedAt,
  error: errorMessage,
  client: injectedClient,
  getClient: injectedGetClient,
}) {
  const client = injectedClient ?? (injectedGetClient ? injectedGetClient() : getClient());
  const idFilter = coerceOrderIdForQuery(orderId);
  const nowIso = orderRowNowIso();

  const { data, error } = await client
    .from("orders")
    .update({
      vendor_paid_notification_claimed_at: null,
      vendor_paid_notification_error: sanitizeVendorNotificationError(errorMessage),
      updated_at: nowIso,
    })
    .eq("id", idFilter)
    .eq("vendor_paid_notification_claimed_at", claimedAt)
    .is("vendor_paid_notification_sent_at", null)
    .select("id");

  if (error) {
    throw error;
  }

  return Boolean(data && data.length > 0);
}

/** @returns {Promise<Array<{ state: string, total_revenue: number, total_orders: number }>>} amounts in cents */
export async function fetchNexusSummaryRows() {
  const client = getClient();
  const { data, error } = await client.rpc("nexus_summary");
  if (error) {
    throw error;
  }
  const rows = Array.isArray(data) ? data : [];
  return rows.map((r) => ({
    state: String(r.state ?? "UNKNOWN"),
    total_revenue: Number(r.total_revenue) || 0,
    total_orders: Number(r.total_orders) || 0,
  }));
}

/**
 * @returns {Promise<Array<{ month: string, state: string, taxable_revenue: number, tax_collected: number, total_orders: number }>>}
 * Revenues and tax in cents; month is YYYY-MM (UTC).
 */
export async function fetchTaxSummaryTnRows() {
  const client = getClient();
  const { data, error } = await client.rpc("tax_summary_tn");
  if (error) {
    throw error;
  }
  const rows = Array.isArray(data) ? data : [];
  return rows.map((r) => ({
    month: String(r.month ?? ""),
    state: String(r.state ?? "TN"),
    taxable_revenue: Number(r.taxable_revenue) || 0,
    tax_collected: Number(r.tax_collected) || 0,
    total_orders: Number(r.total_orders) || 0,
  }));
}

export async function tryBeginShippoOrderSync(orderId) {
  if (orderId == null || orderId === "") {
    return null;
  }
  const client = getClient();
  const idFilter = coerceOrderIdForQuery(orderId);
  const now = orderRowNowIso();
  const { data, error } = await client
    .from("orders")
    .update({
      shippo_sync_status: "syncing",
      shippo_sync_error: null,
      shippo_last_attempt_payload: null,
      shippo_last_error_response: null,
      shippo_last_sync_at: now,
      updated_at: now,
    })
    .eq("id", idFilter)
    .is("shippo_order_id", null)
    .select("*")
    .maybeSingle();

  if (error) {
    throw error;
  }
  return data || null;
}

export async function markOrderShippoSynced(orderId, payload = {}) {
  if (orderId == null || orderId === "") {
    return null;
  }
  const client = getClient();
  const idFilter = coerceOrderIdForQuery(orderId);
  const now = orderRowNowIso();
  const updates = {
    shippo_sync_status: "synced",
    shippo_sync_error: null,
    shippo_last_sync_at: now,
    shippo_synced_at: now,
    updated_at: now,
    shippo_last_attempt_payload: null,
    shippo_last_error_response: null,
  };
  if (payload.shippoOrderId) {
    updates.shippo_order_id = String(payload.shippoOrderId);
  }
  if (payload.shippoShipmentStatus) {
    updates.shippo_shipment_status = String(payload.shippoShipmentStatus);
  }
  if (payload.shippoTrackingNumber) {
    updates.shippo_tracking_number = String(payload.shippoTrackingNumber);
  }
  if (payload.shippoTrackingStatus) {
    updates.shippo_tracking_status = String(payload.shippoTrackingStatus);
  }
  if (payload.shippoTrackingStatusDetail) {
    updates.shippo_tracking_status_detail = String(payload.shippoTrackingStatusDetail);
  }
  const { data, error } = await client.from("orders").update(updates).eq("id", idFilter).select("*").maybeSingle();
  if (error) {
    throw error;
  }
  return data || null;
}

/**
 * @param {string} orderId
 * @param {string} message
 * @param {{ lastPayload?: object | null, shippoErrorResponse?: object | null }} [options]
 */
export async function markOrderShippoSyncFailed(orderId, message, options = {}) {
  if (orderId == null || orderId === "") {
    return null;
  }
  const client = getClient();
  const idFilter = coerceOrderIdForQuery(orderId);
  const now = orderRowNowIso();
  const updates = {
    shippo_sync_status: "error",
    shippo_sync_error: String(message || "Shippo sync failed."),
    shippo_last_sync_at: now,
    updated_at: now,
  };
  if ("lastPayload" in options) {
    updates.shippo_last_attempt_payload = options.lastPayload;
  }
  if ("shippoErrorResponse" in options) {
    updates.shippo_last_error_response = options.shippoErrorResponse;
  }
  const { data, error } = await client
    .from("orders")
    .update(updates)
    .eq("id", idFilter)
    .select("*")
    .maybeSingle();
  if (error) {
    throw error;
  }
  return data || null;
}

/**
 * @param {string} orderId
 * @param {Partial<{
 *   shippo_shipment_object_id: string | null,
 *   shippo_parcel_audit_json: object | null,
 *   shippo_shipment_rates_json: object | null,
 *   shippo_shipment_rate_status: string | null,
 *   shippo_shipment_sync_error: string | null,
 *   shippo_selected_rate_object_id: string | null,
 *   shippo_transaction_id: string | null,
 *   shippo_transaction_status: string | null,
 *   shippo_label_url: string | null,
 *   shippo_label_carrier: string | null,
 *   shippo_label_service: string | null,
 *   shippo_tracking_number: string | null,
 *   shippo_tracking_status: string | null,
 *   shippo_tracking_url_provider: string | null,
 *   shippo_label_purchased_at: string | null,
 *   shippo_label_sync_error: string | null,
 * }>} patch
 */
export async function updateOrderShippoShipmentState(orderId, patch = {}) {
  if (orderId == null || orderId === "") {
    return null;
  }
  const client = getClient();
  const idFilter = coerceOrderIdForQuery(orderId);
  const updates = {
    updated_at: orderRowNowIso(),
  };
  if ("shippo_shipment_object_id" in patch) {
    updates.shippo_shipment_object_id = patch.shippo_shipment_object_id;
  }
  if ("shippo_parcel_audit_json" in patch) {
    updates.shippo_parcel_audit_json = patch.shippo_parcel_audit_json;
  }
  if ("shippo_shipment_rates_json" in patch) {
    updates.shippo_shipment_rates_json = patch.shippo_shipment_rates_json;
  }
  if ("shippo_shipment_rate_status" in patch) {
    updates.shippo_shipment_rate_status = patch.shippo_shipment_rate_status;
  }
  if ("shippo_shipment_sync_error" in patch) {
    updates.shippo_shipment_sync_error = patch.shippo_shipment_sync_error;
  }
  if ("shippo_selected_rate_object_id" in patch) {
    updates.shippo_selected_rate_object_id = patch.shippo_selected_rate_object_id;
  }
  if ("shippo_transaction_id" in patch) {
    updates.shippo_transaction_id = patch.shippo_transaction_id;
  }
  if ("shippo_transaction_status" in patch) {
    updates.shippo_transaction_status = patch.shippo_transaction_status;
  }
  if ("shippo_label_url" in patch) {
    updates.shippo_label_url = patch.shippo_label_url;
  }
  if ("shippo_label_carrier" in patch) {
    updates.shippo_label_carrier = patch.shippo_label_carrier;
  }
  if ("shippo_label_service" in patch) {
    updates.shippo_label_service = patch.shippo_label_service;
  }
  if ("shippo_tracking_number" in patch) {
    updates.shippo_tracking_number = patch.shippo_tracking_number;
  }
  if ("shippo_tracking_status" in patch) {
    updates.shippo_tracking_status = patch.shippo_tracking_status;
  }
  if ("shippo_tracking_url_provider" in patch) {
    updates.shippo_tracking_url_provider = patch.shippo_tracking_url_provider;
  }
  if ("shippo_label_purchased_at" in patch) {
    updates.shippo_label_purchased_at = patch.shippo_label_purchased_at;
  }
  if ("shippo_label_sync_error" in patch) {
    updates.shippo_label_sync_error = patch.shippo_label_sync_error;
  }
  const { data, error } = await client
    .from("orders")
    .update(updates)
    .eq("id", idFilter)
    .select("*")
    .maybeSingle();
  if (error) {
    throw error;
  }
  return data || null;
}

/**
 * @param {string} orderId
 * @param {string | null} shipmentDateYmd YYYY-MM-DD or null to clear
 */
export async function updateOrderShippoShipmentDate(orderId, shipmentDateYmd) {
  if (orderId == null || orderId === "") {
    return null;
  }
  const client = getClient();
  const idFilter = coerceOrderIdForQuery(orderId);
  const value =
    shipmentDateYmd === null || shipmentDateYmd === undefined || String(shipmentDateYmd).trim() === ""
      ? null
      : String(shipmentDateYmd).trim();
  const { data, error } = await client
    .from("orders")
    .update({
      shippo_shipment_date: value,
      updated_at: orderRowNowIso(),
    })
    .eq("id", idFilter)
    .select("*")
    .maybeSingle();
  if (error) {
    throw error;
  }
  return data || null;
}

export async function updateOrderShippoParcelOverride(orderId, override) {
  if (orderId == null || orderId === "") {
    return null;
  }
  const client = getClient();
  const idFilter = coerceOrderIdForQuery(orderId);
  const { data, error } = await client
    .from("orders")
    .update({
      shippo_parcels_override_json: override,
      updated_at: orderRowNowIso(),
    })
    .eq("id", idFilter)
    .select("*")
    .maybeSingle();
  if (error) {
    throw error;
  }
  return data || null;
}

export async function findOrderByShippoOrderId(shippoOrderId) {
  const id = String(shippoOrderId || "").trim();
  if (!id) {
    return null;
  }
  const client = getClient();
  const { data, error } = await client.from("orders").select("*").eq("shippo_order_id", id).limit(1);
  if (error) {
    throw error;
  }
  return data?.[0] || null;
}

export async function findOrderByShippoTransactionId(shippoTransactionId) {
  const id = String(shippoTransactionId || "").trim();
  if (!id) {
    return null;
  }
  const client = getClient();
  const { data, error } = await client.from("orders").select("*").eq("shippo_transaction_id", id).limit(1);
  if (error) {
    throw error;
  }
  return data?.[0] || null;
}

export async function updateOrderFromShippoWebhook(orderId, updates = {}) {
  if (orderId == null || orderId === "") {
    return null;
  }
  const client = getClient();
  const idFilter = coerceOrderIdForQuery(orderId);
  const current = await getOrderByIdForService(orderId);
  if (!current) {
    return null;
  }

  const next = {
    shippo_last_event_at: orderRowNowIso(),
    shippo_last_sync_at: orderRowNowIso(),
    updated_at: orderRowNowIso(),
  };
  for (const [k, v] of Object.entries(updates || {})) {
    if (v !== undefined) {
      next[k] = v;
    }
  }

  if (
    updates.promoteToShipped === true &&
    (String(current.order_status || "") === "ready_to_ship" || String(current.order_status || "") === "paid")
  ) {
    next.order_status = "shipped";
  }

  delete next.promoteToShipped;

  const { data, error } = await client.from("orders").update(next).eq("id", idFilter).select("*").maybeSingle();
  if (error) {
    throw error;
  }
  return data || null;
}

export async function recordShippoWebhookEvent({ eventKey, eventType, shippoObjectId, payload }) {
  const key = String(eventKey || "").trim();
  if (!key) {
    return { inserted: false };
  }
  const client = getClient();
  const { data, error } = await client
    .from("shippo_webhook_events")
    .upsert(
      {
        event_key: key,
        event_type: String(eventType || "").trim() || null,
        shippo_object_id: String(shippoObjectId || "").trim() || null,
        payload: payload && typeof payload === "object" ? payload : {},
      },
      { onConflict: "event_key", ignoreDuplicates: true },
    )
    .select("event_key");
  if (error) {
    throw error;
  }
  return { inserted: Array.isArray(data) && data.length > 0 };
}

export async function updateOrderShippingAddressForAdmin(orderId, shippingAddress, shippingContact = {}) {
  if (orderId == null || orderId === "") {
    const e = new Error("orderId is required.");
    e.statusCode = 400;
    throw e;
  }
  const addr = shippingAddress && typeof shippingAddress === "object" ? shippingAddress : {};
  const line1 = String(addr.line1 || "").trim();
  const line2 = String(addr.line2 || "").trim();
  const city = String(addr.city || "").trim();
  const state = String(addr.state || "").trim().toUpperCase().slice(0, 2);
  const postalCode = String(addr.postalCode || "").trim();
  const country = String(addr.country || "").trim().toUpperCase();
  const name = String(shippingContact.name || "").trim();
  const email = String(shippingContact.email || "").trim();
  const phone = String(shippingContact.phone || "").trim();

  const missing = [];
  if (!line1) missing.push("line1");
  if (!name) missing.push("name");
  if (!city) missing.push("city");
  if (!state) missing.push("state");
  if (!postalCode) missing.push("postalCode");
  if (!country) missing.push("country");
  if (missing.length) {
    const e = new Error(`Missing required shipping fields: ${missing.join(", ")}.`);
    e.statusCode = 400;
    e.fieldErrors = Object.fromEntries(missing.map((m) => [m, "Required."]));
    throw e;
  }

  if (!/^[A-Z]{2}$/.test(state)) {
    const e = new Error("State must be a 2-letter code.");
    e.statusCode = 400;
    e.fieldErrors = { state: "State must be a 2-letter code." };
    throw e;
  }
  if (!/^\d{5}$/.test(postalCode) && !/^\d{5}-\d{4}$/.test(postalCode)) {
    const e = new Error("ZIP must be 5 digits or ZIP+4.");
    e.statusCode = 400;
    e.fieldErrors = { postalCode: "ZIP must be 5 digits or ZIP+4." };
    throw e;
  }

  const normalizedAddress = {
    name,
    ...(email ? { email } : {}),
    ...(phone ? { phone } : {}),
    line1,
    ...(line2 ? { line2 } : {}),
    city,
    state,
    postalCode,
    country,
  };

  const cityLine = [city, state, postalCode].filter(Boolean).join(", ");
  const customerAddressText = [line1, line2, cityLine, country].filter(Boolean).join("\n");

  const client = getClient();
  const idFilter = coerceOrderIdForQuery(orderId);
  const existing = await getOrderByIdForService(orderId);
  if (!existing) {
    const e = new Error("Order not found.");
    e.statusCode = 404;
    throw e;
  }

  const nextSyncStatus = existing.shippo_order_id ? existing.shippo_sync_status : "pending";
  const nextSyncError = existing.shippo_order_id ? existing.shippo_sync_error : null;

  const { data, error } = await client
    .from("orders")
    .update({
      shipping_address: normalizedAddress,
      customer_address: customerAddressText,
      customer_name: name,
      ...(email ? { customer_email: email } : {}),
      ...(phone ? { customer_phone: phone } : {}),
      state: normalizeDestinationState(state),
      shippo_sync_status: nextSyncStatus,
      shippo_sync_error: nextSyncError,
      updated_at: orderRowNowIso(),
    })
    .eq("id", idFilter)
    .select("*")
    .maybeSingle();

  if (error) {
    throw error;
  }
  return data || null;
}

function labelPurchasedOk(row) {
  return (
    Boolean(String(row?.shippo_label_url || "").trim()) &&
    String(row?.shippo_transaction_status || "").toUpperCase() === "SUCCESS"
  );
}

/**
 * Persist optional Shippo sender / return overrides (same shape as shipping_address fields).
 * @param {string} orderId
 * @param {{ shipFromOverride?: object | null, returnOverride?: object | null }} patch
 */
export async function updateOrderShippoAddressOverrides(orderId, patch = {}) {
  if (orderId == null || orderId === "") {
    const e = new Error("orderId is required.");
    e.statusCode = 400;
    throw e;
  }
  const client = getClient();
  const idFilter = coerceOrderIdForQuery(orderId);
  const existing = await getOrderByIdForService(orderId);
  if (!existing) {
    const e = new Error("Order not found.");
    e.statusCode = 404;
    throw e;
  }
  if (labelPurchasedOk(existing) || hasExternalShippingLabel(existing)) {
    const e = new Error("Cannot change sender/return overrides after a shipping label is on file.");
    e.statusCode = 400;
    throw e;
  }

  const updates = {
    updated_at: orderRowNowIso(),
  };
  if ("shipFromOverride" in patch) {
    updates.shippo_from_address_override_json = patch.shipFromOverride;
  }
  if ("returnOverride" in patch) {
    updates.shippo_return_address_override_json = patch.returnOverride;
  }

  const { data, error } = await client.from("orders").update(updates).eq("id", idFilter).select("*").maybeSingle();
  if (error) {
    throw error;
  }
  return data || null;
}

/**
 * @param {string} orderId
 * @param {"print_done" | "summary_done"} checkpoint
 */
export async function updateAdminFulfillmentCheckpoint(orderId, checkpoint) {
  if (orderId == null || orderId === "") {
    const e = new Error("orderId is required.");
    e.statusCode = 400;
    throw e;
  }
  const cp = String(checkpoint || "").trim();
  if (cp !== "print_done" && cp !== "summary_done") {
    const e = new Error("checkpoint must be print_done or summary_done.");
    e.statusCode = 400;
    throw e;
  }
  const client = getClient();
  const idFilter = coerceOrderIdForQuery(orderId);
  const existing = await getOrderByIdForService(orderId);
  if (!existing) {
    const e = new Error("Order not found.");
    e.statusCode = 404;
    throw e;
  }
  if (String(existing.status || "").toLowerCase() !== "paid") {
    const e = new Error("Only paid orders can advance fulfillment checkpoints.");
    e.statusCode = 400;
    throw e;
  }
  if (!labelPurchasedOk(existing)) {
    const e = new Error("Purchase a label before completing the print step.");
    e.statusCode = 400;
    throw e;
  }

  const now = orderRowNowIso();
  const updates = { updated_at: now };
  if (cp === "print_done") {
    updates.admin_fulfillment_print_done_at = now;
  }
  if (cp === "summary_done") {
    if (!existing.admin_fulfillment_print_done_at) {
      const e = new Error("Complete the print step before the summary step.");
      e.statusCode = 400;
      throw e;
    }
    updates.admin_fulfillment_summary_done_at = now;
  }

  const { data, error } = await client.from("orders").update(updates).eq("id", idFilter).select("*").maybeSingle();
  if (error) {
    throw error;
  }
  return data || null;
}

/**
 * Staff physical confirmation: package dropped off / handed to carrier. Does not call Shippo.
 * @param {string} orderId
 */
export async function markAdminOrderHandoffShipped(orderId) {
  if (orderId == null || orderId === "") {
    const e = new Error("orderId is required.");
    e.statusCode = 400;
    throw e;
  }
  const existing = await getOrderByIdForService(orderId);
  if (!existing) {
    const e = new Error("Order not found.");
    e.statusCode = 404;
    throw e;
  }
  if (String(existing.order_status || "") === "cancelled") {
    const e = new Error("Cancelled orders cannot be marked shipped.");
    e.statusCode = 400;
    throw e;
  }

  // Walk-in must be identified before the general already-handed-off early return so
  // partial Walk-in states cannot bypass into carrier handoff / stock decrement.
  if (isWalkInOrderRow(existing)) {
    if (isWalkInOrderFullyCompleted(existing)) {
      return existing;
    }
    const e = new Error(
      "Walk-in orders are completed through Walk-in mark-paid (cash/check). Carrier handoff is not used.",
    );
    e.statusCode = 400;
    throw e;
  }

  // Already handed off / completed — never re-run stock decrement (non-Walk-in only).
  if (existing.admin_handoff_at || String(existing.order_status || "") === "shipped") {
    return existing;
  }

  const fulfillmentMethod = String(existing.fulfillment_method || "").toLowerCase();
  const b2bFulfillment =
    fulfillmentMethod === "b2b_shipping" ||
    fulfillmentMethod === "b2b" ||
    fulfillmentMethod === "b2b shipping";
  const localHandoffOk =
    !b2bFulfillment &&
    (existing.shippo_label_required === false ||
      fulfillmentMethod === "local_delivery" ||
      fulfillmentMethod === "local delivery" ||
      fulfillmentMethod === "pickup");
  const paymentFlow = String(existing.payment_flow || "").toLowerCase();
  const paymentMethod = String(existing.manual_payment_method || existing.payment_method || "").toLowerCase();
  const localPayLaterOk =
    localHandoffOk &&
    String(existing.status || "").toLowerCase() !== "paid" &&
    paymentMethod !== "arrival_payment_link" &&
    (paymentFlow === "pay_later" || paymentMethod === "cash" || paymentMethod === "check");
  if (String(existing.status || "").toLowerCase() !== "paid" && !localPayLaterOk) {
    const e = new Error("Only paid orders can be marked shipped by staff.");
    e.statusCode = 400;
    throw e;
  }
  const manualOk = manualFulfillmentRecordComplete(existing);
  const legacyOk = labelPurchasedOk(existing);
  let packageLabelsOk = false;
  try {
    const { listOrderShippoLabels, orderShippoPackageLabelsComplete } = await import("./order-shippo-labels.js");
    packageLabelsOk = orderShippoPackageLabelsComplete(await listOrderShippoLabels(orderId), {
      orderStatus: existing.order_status,
    });
  } catch (err) {
    console.error("[admin] could not verify package labels before handoff:", orderId, err);
  }
  if (!localHandoffOk && !manualOk && !legacyOk && !packageLabelsOk) {
    const e = new Error(
      "Purchase a shipping label or add a complete external label record, then mark shipped.",
    );
    e.statusCode = 400;
    throw e;
  }

  const client = getClient();
  const idFilter = coerceOrderIdForQuery(orderId);
  const now = orderRowNowIso();
  const updateFields = {
    admin_handoff_at: now,
    order_status: "shipped",
    updated_at: now,
  };
  if (localPayLaterOk) {
    const collectedMethod = paymentMethod === "check" ? "check" : "cash";
    updateFields.status = "paid";
    updateFields.payment_method = collectedMethod;
    updateFields.manual_payment_method = collectedMethod;
    updateFields.paid_at = now;
  }
  const { data, error } = await client
    .from("orders")
    .update(updateFields)
    .eq("id", idFilter)
    .is("admin_handoff_at", null)
    .select("*")
    .maybeSingle();
  if (error) {
    throw error;
  }
  if (!data) {
    return (await getOrderByIdForService(orderId)) || existing;
  }

  const orderSource = String(existing.order_source || "");
  try {
    if (Array.isArray(data.items) && data.items.length) {
      if (orderSource === "web") {
        await fulfillWebsiteOrderShippedStock(data.items, { orderId: String(orderId) });
      } else {
        await decrementOnHandForShippedItems(data.items, { orderId: String(orderId) });
      }
    }
  } catch (err) {
    console.error("[stock] decrement after mark shipped (handoff) failed:", orderId, err);
  }

  return data;
}

export async function markAdminBuyerShippingNotifySent(orderId) {
  const client = getClient();
  const idFilter = coerceOrderIdForQuery(orderId);
  const now = orderRowNowIso();
  const { data, error } = await client
    .from("orders")
    .update({
      admin_buyer_notify_sent_at: now,
      updated_at: now,
    })
    .eq("id", idFilter)
    .select("*")
    .maybeSingle();
  if (error) {
    throw error;
  }
  return data || null;
}
