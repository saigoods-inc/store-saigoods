import { createClient } from "@supabase/supabase-js";
import { processAutomaticManualLabels } from "../lib/automatic-manual-label-worker.js";

function authorized(req) {
  const expected = String(process.env.CRON_SECRET || "").trim();
  return Boolean(expected) && String(req.headers?.authorization || "") === `Bearer ${expected}`;
}

export async function recoverAutomaticManualLabels(dependencies = {}) {
  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  const client = dependencies.client || (url && key ? createClient(url, key, { auth: { persistSession: false } }) : null);
  if (!client) throw Object.assign(new Error("Supabase is not configured."), { statusCode: 503 });
  const processOrder = dependencies.processOrder || processAutomaticManualLabels;
  const orderId = String(dependencies.orderId || "").trim();
  let query = client
    .from("orders")
    .select("id")
    .eq("order_source", "manual")
    .eq("status", "paid")
    .eq("payment_flow", "square_payment_link")
    .eq("fulfillment_method", "carrier")
    .or("shippo_label_required.is.null,shippo_label_required.eq.true")
    .is("shippo_label_purchased_at", null)
    .limit(orderId ? 1 : 10);
  if (orderId) {
    // Admin surfaces expose order_ref values such as SAI-ABC123, while the
    // orders table uses a bigint primary key. Never send an order reference to
    // the bigint filter; Supabase/Postgres rejects it before the worker runs.
    const targetColumn = /^\d+$/.test(orderId) ? "id" : "order_ref";
    query = query.eq(targetColumn, orderId);
  }
  const { data, error } = await query;
  if (error) throw error;
  const outcomes = [];
  for (const row of data || []) {
    try {
      outcomes.push({ orderId: row.id, ...(await processOrder(row.id)) });
    } catch (error) {
      outcomes.push({ orderId: row.id, ok: false, reason: String(error?.code || "worker_failed") });
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
    const rawOrderId = Array.isArray(req.query?.orderId) ? req.query.orderId[0] : req.query?.orderId;
    const outcomes = await recoverAutomaticManualLabels({ orderId: String(rawOrderId || "").trim() });
    res.status(200).json({ ok: true, processed: outcomes.length, outcomes });
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message || "Automatic label recovery failed." });
  }
}
