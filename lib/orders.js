import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";

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

export function generateOrderId() {
  return crypto.randomUUID();
}

export async function createPendingOrder({ quote, customer }) {
  const client = getClient();
  const id = generateOrderId();

  // Omit `provider` here so inserts work if your `orders` table predates that column;
  // run sql/patch-orders-columns.sql in Supabase to add it (optional).
  const payload = {
    id,
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

  const { error } = await client.from("orders").insert(payload);

  if (error) {
    throw error;
  }

  return { id, ...payload };
}

export async function markOrderPaid({ orderId, paymentId }) {
  const client = getClient();

  const { data, error } = await client
    .from("orders")
    .update({
      status: "paid",
      payment_id: paymentId,
    })
    .eq("id", orderId)
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

