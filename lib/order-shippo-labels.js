import { getSupabaseServiceRoleClient } from "./supabase-admin.js";
import { randomUUID } from "node:crypto";

function coerceOrderIdForQuery(orderId) {
  const normalized = String(orderId ?? "").trim();
  return /^\d+$/.test(normalized) ? Number(normalized) : normalized;
}

function client() {
  return getSupabaseServiceRoleClient();
}

function nowIso() {
  return new Date().toISOString();
}

/**
 * @param {string|number} orderId
 * @returns {Promise<object[]>}
 */
export async function listOrderShippoLabels(orderId) {
  const c = client();
  const idFilter = coerceOrderIdForQuery(orderId);
  const { data, error } = await c
    .from("order_shippo_labels")
    .select("*")
    .eq("order_id", idFilter)
    .order("parcel_index", { ascending: true });
  if (error) {
    throw error;
  }
  return Array.isArray(data) ? data : [];
}

/**
 * @param {object} row
 */
export function rowToLabelEntry(row) {
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    orderId: row.order_id,
    parcelIndex: row.parcel_index,
    parcelCount: row.parcel_count,
    parcelMetadata: row.parcel_metadata,
    shipmentObjectId: row.shipment_object_id,
    selectedRateObjectId: row.selected_rate_object_id,
    transactionId: row.transaction_id,
    labelUrl: row.label_url,
    trackingNumber: row.tracking_number,
    trackingUrl: row.tracking_url,
    carrier: row.carrier,
    servicelevelToken: row.servicelevel_token,
    servicelevelName: row.servicelevel_name,
    amountCents: row.amount_cents,
    currency: row.currency,
    status: row.status,
    purchaseAttemptId: row.purchase_attempt_id,
    claimId: row.claim_id,
    attemptCount: row.attempt_count,
    nextRetryAt: row.next_retry_at,
    lastErrorCode: row.last_error_code,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function claimOrderShippoLabelPackage({
  orderId,
  parcelIndex,
  parcelCount,
  rateObjectId,
  shipmentObjectId,
  parcelMetadata,
  leaseMs = 2 * 60 * 1000,
  client: injectedClient,
  createId = randomUUID,
  now = () => new Date(),
}) {
  const c = injectedClient || client();
  const nowDate = now();
  const attemptId = createId();
  const claimId = createId();
  const { data, error } = await c.rpc("claim_order_shippo_label_package", {
    p_order_id: coerceOrderIdForQuery(orderId),
    p_parcel_index: parcelIndex,
    p_parcel_count: parcelCount,
    p_attempt_id: attemptId,
    p_claim_id: claimId,
    p_claim_expires_at: new Date(nowDate.getTime() + leaseMs).toISOString(),
    p_rate_object_id: rateObjectId || null,
    p_shipment_object_id: shipmentObjectId || null,
    p_parcel_metadata: parcelMetadata || null,
  });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  return row ? { row, claimId, attemptId: row.purchase_attempt_id || attemptId } : null;
}

/**
 * Compatibility claim used by the manual-order label worker. The unique
 * (order_id, parcel_index) key is the spending guard across webhook and cron workers.
 */
export async function claimOrderShippoLabelPurchase(orderId, parcelIndex, totalParcels, patch = {}) {
  const c = client();
  const idFilter = coerceOrderIdForQuery(orderId);
  const at = nowIso();
  const { data, error } = await c
    .from("order_shippo_labels")
    .insert({
      order_id: idFilter,
      parcel_index: parcelIndex,
      parcel_count: totalParcels,
      status: "processing",
      error_message: null,
      created_at: at,
      updated_at: at,
      ...patch,
    })
    .select()
    .single();
  if (error?.code === "23505") return null;
  if (error) throw error;
  return data || null;
}

export async function transitionClaimedOrderShippoLabelPackage({
  orderId,
  parcelIndex,
  claimId,
  status,
  patch = {},
  client: injectedClient,
}) {
  const c = injectedClient || client();
  const at = nowIso();
  const next = {
    ...patch,
    status,
    claim_id: null,
    claimed_at: null,
    claim_expires_at: null,
    last_transition_at: at,
    updated_at: at,
  };
  if (status === "purchased") next.purchased_at = at;
  const { data, error } = await c
    .from("order_shippo_labels")
    .update(next)
    .eq("order_id", coerceOrderIdForQuery(orderId))
    .eq("parcel_index", parcelIndex)
    .eq("claim_id", claimId)
    .select()
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

export async function setAutomaticLabelOrderStatus(orderId, orderStatus, reasonCode = null, injectedClient) {
  const c = injectedClient || client();
  const at = nowIso();
  const id = coerceOrderIdForQuery(orderId);
  const { data: existing, error: readError } = await c
    .from("orders")
    .select("id, order_status, checkout_quote_correlation_id")
    .eq("id", id)
    .maybeSingle();
  if (readError) throw readError;
  if (!existing || ["shipped", "cancelled"].includes(String(existing.order_status || ""))) return existing || null;
  if (String(existing.order_status || "") === orderStatus) return existing;
  const { data, error } = await c
    .from("orders")
    .update({
      order_status: orderStatus,
      label_workflow_updated_at: at,
      label_workflow_error_code: reasonCode,
      updated_at: at,
    })
    .eq("id", id)
    .select()
    .maybeSingle();
  if (error) throw error;
  const { error: eventError } = await c.from("shipping_state_events").insert({
    order_id: id,
    correlation_id: existing.checkout_quote_correlation_id || null,
    from_status: existing.order_status || null,
    to_status: orderStatus,
    reason_code: reasonCode,
  });
  if (eventError) console.error("[shipping] state event persistence failed", { orderId: id });
  return data || null;
}

export async function listRecoverableAutomaticLabelOrders({ limit = 25, client: injectedClient } = {}) {
  const c = injectedClient || client();
  const cutoff = nowIso();
  const { data, error } = await c
    .from("order_shippo_labels")
    .select("order_id, status, next_retry_at, claim_expires_at")
    .in("status", ["retry", "processing", "unknown"])
    .or(`next_retry_at.is.null,next_retry_at.lte.${cutoff},claim_expires_at.lt.${cutoff}`)
    .limit(Math.max(1, Math.min(100, Number(limit) || 25)));
  if (error) throw error;
  return [...new Set((data || []).map((row) => row.order_id).filter((id) => id != null))];
}

export async function findOrderShippoLabelByTransactionId(transactionId, injectedClient) {
  const id = String(transactionId || "").trim();
  if (!id) return null;
  const c = injectedClient || client();
  const { data, error } = await c
    .from("order_shippo_labels")
    .select("*")
    .eq("transaction_id", id)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

export async function reconcileOrderShippoLabelTransaction(row, transaction, injectedClient) {
  if (!row?.id || !transaction || String(transaction.status || "").toUpperCase() !== "SUCCESS") return null;
  const c = injectedClient || client();
  const rate = transaction.rate && typeof transaction.rate === "object" ? transaction.rate : {};
  const amount = Number.parseFloat(String(rate.amount ?? transaction.amount ?? ""));
  const at = nowIso();
  const { data, error } = await c
    .from("order_shippo_labels")
    .update({
      status: "purchased",
      transaction_id: String(transaction.object_id || row.transaction_id || "").trim() || null,
      label_url: String(transaction.label_url || "").trim() || null,
      tracking_number: String(transaction.tracking_number || "").trim() || null,
      tracking_url: String(transaction.tracking_url_provider || "").trim() || null,
      carrier: String(rate.provider || rate.provider_name || row.carrier || "").trim() || null,
      servicelevel_token: String(rate.servicelevel?.token || row.servicelevel_token || "").trim() || null,
      servicelevel_name: String(rate.servicelevel?.name || row.servicelevel_name || "").trim() || null,
      amount_cents: Number.isFinite(amount) ? Math.round(amount * 100) : row.amount_cents,
      currency: String(rate.currency || row.currency || "USD").toUpperCase(),
      purchased_at: at,
      last_transition_at: at,
      updated_at: at,
      error_message: null,
      last_error_code: null,
      next_retry_at: null,
      claim_id: null,
      claimed_at: null,
      claim_expires_at: null,
    })
    .eq("id", row.id)
    .neq("status", "purchased")
    .select()
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

/**
 * @param {string|number} orderId
 * @param {number} parcelIndex
 * @param {object} patch
 */
export async function upsertOrderShippoLabelRow(orderId, parcelIndex, totalParcels, patch = {}) {
  const c = client();
  const idFilter = coerceOrderIdForQuery(orderId);
  const { data: existing, error: selErr } = await c
    .from("order_shippo_labels")
    .select("id, status")
    .eq("order_id", idFilter)
    .eq("parcel_index", parcelIndex)
    .maybeSingle();
  if (selErr) {
    throw selErr;
  }
  const base = {
    order_id: idFilter,
    parcel_index: parcelIndex,
    parcel_count: totalParcels,
    updated_at: nowIso(),
  };
  const next = { ...base, ...patch };
  if (existing?.id) {
    const { data, error } = await c
      .from("order_shippo_labels")
      .update(next)
      .eq("id", existing.id)
      .select()
      .single();
    if (error) {
      throw error;
    }
    return data;
  }
  const { data, error } = await c
    .from("order_shippo_labels")
    .insert({
      ...next,
      created_at: nowIso(),
    })
    .select()
    .single();
  if (error) {
    throw error;
  }
  return data;
}

/**
 * @param {string|number} orderId
 * @param {number} expectedParcelCount
 */
export async function recomputeOrderStatusForMultiLabels(orderId, expectedParcelCount) {
  const c = client();
  const idFilter = coerceOrderIdForQuery(orderId);
  const rows = await listOrderShippoLabels(orderId);
  const n = Math.max(0, Math.floor(Number(expectedParcelCount) || 0));
  if (n === 0) {
    return { orderStatus: null, purchased: 0, hasRows: false };
  }
  const inScope = rows.filter((r) => r.parcel_index != null && r.parcel_index >= 0 && r.parcel_index < n);
  const purchased = inScope.filter((r) => String(r.status || "") === "purchased").length;
  const hasRows = inScope.length > 0;

  const { data: orderRow, error: oErr } = await c
    .from("orders")
    .select("id, order_status")
    .eq("id", idFilter)
    .maybeSingle();
  if (oErr) {
    throw oErr;
  }
  if (!orderRow) {
    return { orderStatus: null, purchased, hasRows };
  }
  const st = String(orderRow.order_status || "");
  if (st === "shipped" || st === "cancelled") {
    return { orderStatus: st, purchased, hasRows, skipped: true };
  }
  if (!hasRows) {
    return { orderStatus: null, purchased, hasRows };
  }
  let nextStatus;
  if (n > 0 && purchased === n) {
    nextStatus = "label_purchased";
  } else if (n > 0 && purchased > 0 && purchased < n) {
    nextStatus = "partial_label_purchase";
  } else {
    return { orderStatus: st, purchased, hasRows, skipped: true };
  }
  if (nextStatus && nextStatus !== st) {
    const { error: uErr } = await c
      .from("orders")
      .update({ order_status: nextStatus, updated_at: nowIso() })
      .eq("id", idFilter);
    if (uErr) {
      throw uErr;
    }
  }
  return { orderStatus: nextStatus || st, purchased, hasRows };
}

/**
 * @param {object[]|null|undefined} rows
 */
export function expectedShippoPackageCount(rows) {
  const list = Array.isArray(rows) ? rows : [];
  let expected = 0;
  for (const row of list) {
    const count = Number(row?.parcel_count);
    if (Number.isFinite(count) && count > expected) {
      expected = Math.floor(count);
    }
  }
  if (expected > 0) {
    return expected;
  }
  const indexes = list
    .map((row) => Number(row?.parcel_index))
    .filter((index) => Number.isFinite(index) && index >= 0);
  if (!indexes.length) {
    return list.length;
  }
  return Math.max(...indexes) + 1;
}

/**
 * @param {object|null|undefined} row
 */
export function isCompletePurchasedShippoLabelRow(row) {
  return (
    isPurchasedShippoLabelStatus(row?.status) &&
    Boolean(String(row?.label_url || "").trim()) &&
    Boolean(String(row?.tracking_number || "").trim())
  );
}

/**
 * @param {unknown} status
 */
export function isPurchasedShippoLabelStatus(status) {
  const normalized = String(status || "").trim().toLowerCase();
  return normalized === "purchased" || normalized === "success" || normalized === "successful";
}

/**
 * @param {object[]|null|undefined} rows
 * @param {{ orderStatus?: string|null }} [context]
 */
export function orderShippoPackageLabelsComplete(rows, context = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const expected = expectedShippoPackageCount(list);
  if (!expected) {
    return false;
  }
  const byIndex = new Map();
  for (const row of list) {
    const index = Number(row?.parcel_index);
    if (!Number.isFinite(index) || index < 0 || index >= expected) {
      continue;
    }
    byIndex.set(index, row);
  }
  if (byIndex.size < expected) {
    return false;
  }
  for (let i = 0; i < expected; i++) {
    if (!isCompletePurchasedShippoLabelRow(byIndex.get(i))) {
      return false;
    }
  }
  const status = String(context.orderStatus || "");
  return status !== "partial_label_purchase";
}
