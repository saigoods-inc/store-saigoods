import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";

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

export async function createPendingOrder({ quote, customer }) {
  const client = getClient();

  // Do not send `id`: your table may use bigint identity or uuid default — DB assigns it.
  const payload = {
    order_ref: generateOrderRef(),
    status: "pending",
    customer_name: customer.name || null,
    customer_email: customer.email || null,
    customer_phone: customer.phone || null,
    customer_address: customer.address || null,
    items: quote.items,
    subtotal_cents: quote.subtotalCents,
    shipping_cents: quote.shippingCents,
    tax_cents: quote.taxCents,
    total_cents: quote.totalCents,
  };

  const { data, error } = await client.from("orders").insert(payload).select().single();

  if (error) {
    throw error;
  }

  return data;
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

