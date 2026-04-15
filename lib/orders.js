import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { releaseDiscountCodeForOrder } from "./discount-codes.js";

function generateOrderRef() {
  return `SAI-${crypto.randomUUID().replace(/-/g, "").slice(0, 12).toUpperCase()}`;
}

let cachedClient = null;

function getClient() {
  if (cachedClient) return cachedClient;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error("Supabase credentials are not configured.");
  }

  cachedClient = createClient(url, key, {
    auth: { persistSession: false },
  });

  return cachedClient;
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

function normalizeDestinationState(raw) {
  const s = String(raw || "")
    .trim()
    .toUpperCase();
  if (s.length === 2 && /^[A-Z]{2}$/.test(s)) {
    return s;
  }
  return null;
}

export async function createPendingOrder({ quote, customer, hardinDiscount, shippingAddress }) {
  const client = getClient();

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
    order_status: "awaiting_payment",
    order_source: "web",
    order_type: "online",
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
    discount_code_used: hardinOn && hardinDiscount.code ? String(hardinDiscount.code) : null,
    is_hardin_discount: hardinOn,
    updated_at: orderRowNowIso(),
  };

  const { data, error } = await client.from("orders").insert(payload).select().single();

  if (error) {
    throw error;
  }

  return data;
}

/**
 * Staff-created phone / manual order — saved as draft until a payment link is emailed.
 * Discount code is validated at creation but not claimed until send-payment-link.
 */
export async function createManualOrderDraft({ quote, customer, hardinDiscount, shippingAddress }) {
  const client = getClient();

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
    discount_code_used: hardinOn && hardinDiscount.code ? String(hardinDiscount.code) : null,
    is_hardin_discount: hardinOn,
    admin_local_discount_override: Boolean(hardinDiscount?.adminOverride === true),
    updated_at: orderRowNowIso(),
  };

  const { data, error } = await client.from("orders").insert(payload).select().single();

  if (error) {
    throw error;
  }

  return data;
}

/**
 * Replace an existing manual draft with a new quote + customer snapshot (staff only; service role).
 */
export async function updateManualOrderDraft(orderId, { quote, customer, hardinDiscount, shippingAddress }) {
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

  const payload = {
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
    discount_code_used: hardinOn && hardinDiscount.code ? String(hardinDiscount.code) : null,
    is_hardin_discount: hardinOn,
    admin_local_discount_override: Boolean(hardinDiscount?.adminOverride === true),
    updated_at: orderRowNowIso(),
  };

  const { data, error } = await client.from("orders").update(payload).eq("id", idFilter).select().single();

  if (error) {
    throw error;
  }
  return data;
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
 */
export async function createWalkInOrderDraft({ quote, customer, hardinDiscount, shippingAddress }) {
  const client = getClient();

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
    order_source: "walk_in",
    order_type: "walk_in",
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
    discount_code_used: hardinOn && hardinDiscount.code ? String(hardinDiscount.code) : null,
    is_hardin_discount: hardinOn,
    admin_local_discount_override: Boolean(hardinDiscount?.adminOverride === true),
    updated_at: orderRowNowIso(),
  };

  const { data, error } = await client.from("orders").insert(payload).select().single();

  if (error) {
    throw error;
  }

  return data;
}

/**
 * Update an existing walk-in draft (staff only; service role).
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
    discount_code_used: hardinOn && hardinDiscount.code ? String(hardinDiscount.code) : null,
    is_hardin_discount: hardinOn,
    admin_local_discount_override: Boolean(hardinDiscount?.adminOverride === true),
    updated_at: orderRowNowIso(),
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
 * Record cash/check payment for a walk-in draft. Sets `status` and `order_status` to paid, `paid_at`, `payment_method`.
 * @param {{ orderId: string, paymentMethod: "cash" | "check" }} args
 */
export async function markWalkInOrderPaid({ orderId, paymentMethod }) {
  const method = String(paymentMethod || "").toLowerCase();
  if (method !== "cash" && method !== "check") {
    const e = new Error("paymentMethod must be cash or check.");
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
  if (String(existing.order_source || "") !== "walk_in") {
    const e = new Error("Only walk-in orders can be marked paid here.");
    e.statusCode = 400;
    throw e;
  }
  if (String(existing.order_status || "") !== "draft") {
    const e = new Error("Only walk-in drafts awaiting payment can be marked paid.");
    e.statusCode = 400;
    throw e;
  }
  if (String(existing.status || "") === "paid") {
    return existing;
  }

  const paidAt = orderRowNowIso();
  const paymentId = `walk_in:${method}`;

  const { data, error } = await client
    .from("orders")
    .update({
      status: "paid",
      order_status: "paid",
      payment_method: method,
      payment_id: paymentId,
      paid_at: paidAt,
      provider: "walk_in",
      updated_at: paidAt,
    })
    .eq("id", idFilter)
    .eq("order_status", "draft")
    .select()
    .maybeSingle();

  if (error) {
    throw error;
  }
  if (!data) {
    const e = new Error("Order could not be updated (it may have already been paid).");
    e.statusCode = 409;
    throw e;
  }
  return data;
}

export async function getOrderByIdForService(orderId) {
  const client = getClient();
  const idFilter = coerceOrderIdForQuery(orderId);
  const { data, error } = await client.from("orders").select("*").eq("id", idFilter).maybeSingle();
  if (error) {
    throw error;
  }
  return data || null;
}

export async function updateOrderPaymentLinkSent(orderId, paymentLinkUrl) {
  const client = getClient();
  const idFilter = coerceOrderIdForQuery(orderId);
  const { data, error } = await client
    .from("orders")
    .update({
      order_status: "payment_link_sent",
      payment_link_url: String(paymentLinkUrl || "").trim() || null,
      updated_at: orderRowNowIso(),
    })
    .eq("id", idFilter)
    .select()
    .maybeSingle();

  if (error) {
    throw error;
  }
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
    .eq("order_status", "awaiting_payment")
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
 * When `paidTotalCents` is set (Square amount actually charged), `total_cents` and `shipping_cents`
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
}) {
  const client = getClient();
  const idFilter = coerceOrderIdForQuery(orderId);

  const { data: existingRows, error: fetchError } = await client
    .from("orders")
    .select("id,status,subtotal_cents,tax_cents,shipping_cents")
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
    return null;
  }

  const subtotal = Math.max(0, Number(existing.subtotal_cents) || 0);
  const tax = Math.max(0, Number(existing.tax_cents) || 0);
  let shippingCents = Math.max(0, Number(existing.shipping_cents) || 0);
  let totalCents = subtotal + shippingCents + tax;

  if (paidTotalCents != null && Number.isFinite(Number(paidTotalCents))) {
    totalCents = Math.round(Number(paidTotalCents));
    shippingCents = Math.max(0, totalCents - subtotal - tax);
  }

  const updatePayload = {
    status: "paid",
    order_status: "ready_to_ship",
    payment_id: paymentId,
    total_cents: totalCents,
    shipping_cents: shippingCents,
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
    .select();

  if (error) {
    throw error;
  }

  if (!data || data.length === 0) {
    return null;
  }

  return data[0];
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

export async function markOrderShippoSyncFailed(orderId, message) {
  if (orderId == null || orderId === "") {
    return null;
  }
  const client = getClient();
  const idFilter = coerceOrderIdForQuery(orderId);
  const now = orderRowNowIso();
  const { data, error } = await client
    .from("orders")
    .update({
      shippo_sync_status: "pending",
      shippo_sync_error: String(message || "Shippo sync failed."),
      shippo_last_sync_at: now,
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

