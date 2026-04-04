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

export async function markOrderPaid({ orderId, paymentId }) {
  const client = getClient();
  const idFilter = coerceOrderIdForQuery(orderId);

  const { data, error } = await client
    .from("orders")
    .update({
      status: "paid",
      payment_id: paymentId,
    })
    .eq("id", idFilter)
    .neq("status", "paid")
    .select();

  if (error) {
    throw error;
  }

  if (!data || data.length === 0) {
    // Order was already marked as paid; treat as idempotent no-op.
    return null;
  }

  return data[0];
}

