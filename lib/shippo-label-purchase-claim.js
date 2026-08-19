import { randomUUID } from "node:crypto";

import { getSupabaseServiceRoleClient } from "./supabase-admin.js";

const DEFAULT_STALE_MS = 15 * 60 * 1000;
const ALLOWED_OUTCOMES = new Set(["success", "partial", "failed", "claim_release_failed"]);

function coerceOrderIdForQuery(orderId) {
  const normalized = String(orderId ?? "").trim();
  return /^\d+$/.test(normalized) ? Number(normalized) : normalized;
}

export function isShippoLabelDbLockEnabled() {
  const raw = String(process.env.SHIPPO_LABEL_DB_LOCK ?? "1").trim().toLowerCase();
  return !["0", "false", "off", "no", "disabled"].includes(raw);
}

export function sanitizeLabelPurchaseOutcome(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return ALLOWED_OUTCOMES.has(normalized) ? normalized : "failed";
}

function schemaError(error) {
  const message = String(error?.message || "");
  return /shippo_label_purchase_claim|column .* does not exist|schema cache/i.test(message);
}

export async function tryClaimShippoLabelPurchase({
  orderId,
  staleAfterMs = DEFAULT_STALE_MS,
  client: injectedClient,
  now = () => new Date(),
  createClaimId = randomUUID,
}) {
  if (!isShippoLabelDbLockEnabled()) return { disabled: true, claimId: null, claimedAt: null };
  const client = injectedClient || getSupabaseServiceRoleClient();
  const nowDate = now();
  const claimedAt = nowDate.toISOString();
  const claimId = String(createClaimId());
  const staleCutoff = new Date(nowDate.getTime() - staleAfterMs).toISOString();
  const { data, error } = await client
    .from("orders")
    .update({
      shippo_label_purchase_claim_id: claimId,
      shippo_label_purchase_claimed_at: claimedAt,
      shippo_label_purchase_last_error: null,
      updated_at: claimedAt,
    })
    .eq("id", coerceOrderIdForQuery(orderId))
    .eq("status", "paid")
    .or(`shippo_label_purchase_claimed_at.is.null,shippo_label_purchase_claimed_at.lt.${staleCutoff}`)
    .select("id");

  if (error) {
    if (schemaError(error)) {
      const wrapped = new Error("Install sql/patch-shipping-phase6-hardening.sql before purchasing labels.");
      wrapped.statusCode = 503;
      wrapped.code = "SHIPPING_PHASE6_MIGRATION_REQUIRED";
      throw wrapped;
    }
    throw error;
  }
  if (!Array.isArray(data) || data.length === 0) return null;
  return { claimId, claimedAt };
}

export async function releaseShippoLabelPurchaseClaim({ orderId, claimId, outcome, client: injectedClient }) {
  if (!claimId) return true;
  const client = injectedClient || getSupabaseServiceRoleClient();
  const nowIso = new Date().toISOString();
  const { data, error } = await client
    .from("orders")
    .update({
      shippo_label_purchase_claim_id: null,
      shippo_label_purchase_claimed_at: null,
      shippo_label_purchase_last_error: outcome === "success" ? null : sanitizeLabelPurchaseOutcome(outcome),
      updated_at: nowIso,
    })
    .eq("id", coerceOrderIdForQuery(orderId))
    .eq("shippo_label_purchase_claim_id", claimId)
    .select("id");
  if (error) throw error;
  return Boolean(Array.isArray(data) && data.length);
}
