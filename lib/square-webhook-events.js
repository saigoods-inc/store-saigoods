import { getSupabaseServiceRoleClient } from "./supabase-admin.js";

function coerceOrderId(orderId) {
  const value = String(orderId ?? "").trim();
  return /^\d+$/.test(value) ? Number(value) : value;
}

export async function recordSquareWebhookEvent({ eventId, paymentId, orderId }, injectedClient) {
  const key = String(eventId || `payment:${paymentId}:order:${orderId}`).trim();
  if (!key || !paymentId || !orderId) return { inserted: false };
  const client = injectedClient || getSupabaseServiceRoleClient();
  const { data, error } = await client
    .from("square_webhook_events")
    .upsert(
      {
        event_id: key,
        payment_id: String(paymentId),
        order_id: coerceOrderId(orderId),
        processed_at: new Date().toISOString(),
      },
      { onConflict: "event_id", ignoreDuplicates: true },
    )
    .select("event_id");
  if (error) throw error;
  return { inserted: Array.isArray(data) && data.length > 0 };
}
