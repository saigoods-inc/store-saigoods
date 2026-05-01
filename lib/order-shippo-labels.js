import { getSupabaseServiceRoleClient } from "./supabase-admin.js";
import { coerceOrderIdForQuery } from "./orders.js";

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
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
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
