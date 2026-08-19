import { createClient } from "@supabase/supabase-js";
import { resetExpiredManualPaymentLink } from "../lib/orders.js";
import { deletePaymentLink } from "../lib/square.js";

function authorized(req) {
  const expected = String(process.env.CRON_SECRET || "").trim();
  return Boolean(expected) && String(req.headers?.authorization || "") === `Bearer ${expected}`;
}

export async function expireManualPaymentLinks(nowIso = new Date().toISOString(), dependencies = {}) {
  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  const client = dependencies.client || (url && key ? createClient(url, key, { auth: { persistSession: false } }) : null);
  if (!client) throw Object.assign(new Error("Supabase is not configured."), { statusCode: 503 });
  const deleteLink = dependencies.deletePaymentLink || deletePaymentLink;
  const resetLink = dependencies.resetExpiredManualPaymentLink || resetExpiredManualPaymentLink;
  const { data, error } = await client
    .from("orders")
    .select("id,payment_link_id")
    .eq("order_source", "manual")
    .eq("order_status", "payment_link_sent")
    .neq("status", "paid")
    .lte("payment_link_expires_at", nowIso)
    .limit(50);
  if (error) throw error;
  const outcomes = [];
  for (const order of data || []) {
    try {
      const squareId = String(order.payment_link_id || "").trim();
      if (squareId) await deleteLink(squareId);
      await resetLink(order.id);
      outcomes.push({ orderId: order.id, expired: true });
    } catch (error) {
      outcomes.push({ orderId: order.id, expired: false, error: String(error?.code || "expire_failed") });
    }
  }
  return outcomes;
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed." });
    return;
  }
  if (!authorized(req)) {
    res.status(401).json({ error: "Unauthorized." });
    return;
  }
  try {
    const outcomes = await expireManualPaymentLinks();
    res.status(200).json({ ok: true, processed: outcomes.length, outcomes });
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message || "Could not expire payment links." });
  }
}
