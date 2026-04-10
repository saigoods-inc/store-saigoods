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

function normalizeDestinationState(raw) {
  const s = String(raw || "")
    .trim()
    .toUpperCase();
  if (s.length === 2 && /^[A-Z]{2}$/.test(s)) {
    return s;
  }
  return null;
}

export async function createPendingOrder({ quote, customer, hardinDiscount }) {
  const client = getClient();

  const shippingState =
    normalizeDestinationState(customer.shippingState) ||
    normalizeDestinationState(customer.state) ||
    null;
  const amountCents = Math.max(0, Number(quote.subtotalCents) || 0) + Math.max(0, Number(quote.shippingCents) || 0);
  const taxCollected = Math.max(0, Number(quote.taxCents) || 0);
  const hardinOn = Boolean(
    hardinDiscount?.applied && (hardinDiscount?.code || hardinDiscount?.adminAddressVerified === true),
  );

  // Do not send `id`: your table may use bigint identity or uuid default — DB assigns it.
  const payload = {
    order_ref: generateOrderRef(),
    status: "pending",
    order_status: "awaiting_payment",
    order_source: "web",
    customer_name: customer.name || null,
    customer_email: customer.email || null,
    customer_phone: customer.phone || null,
    customer_address: customer.address || null,
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
    hardinDiscount?.applied && (hardinDiscount?.code || hardinDiscount?.adminAddressVerified === true),
  );

  const payload = {
    order_ref: generateOrderRef(),
    status: "pending",
    order_status: "draft",
    order_source: "manual",
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
    hardinDiscount?.applied && (hardinDiscount?.code || hardinDiscount?.adminAddressVerified === true),
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
      "id, order_ref, customer_name, customer_email, total_cents, created_at, order_status, order_source",
    )
    .eq("order_source", "manual")
    .eq("order_status", "draft")
    .order("created_at", { ascending: false });

  if (error) {
    throw error;
  }
  return Array.isArray(data) ? data : [];
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

