import { getShippoApiBaseUrl } from "./shippo.js";
import { normalizeRatesForStorage, sortRatesForAdminDisplay } from "./shippo-rate-utils.js";
import { getOrderByIdForService, updateOrderFromShippoWebhook, updateOrderShippoShipmentState } from "./orders.js";

const SHIPPO_API_VERSION = "2018-02-08";

function extractGetError(json, status) {
  if (!json || typeof json !== "object") {
    return `Shippo GET failed (HTTP ${status}).`;
  }
  if (typeof json.detail === "string" && json.detail.trim()) {
    return json.detail.trim();
  }
  if (typeof json.message === "string" && json.message.trim()) {
    return json.message.trim();
  }
  return `Shippo GET failed (HTTP ${status}).`;
}

async function shippoGetJson(path, token) {
  const base = getShippoApiBaseUrl().replace(/\/$/, "");
  const p = path.startsWith("/") ? path : `/${path}`;
  const url = `${base}${p}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `ShippoToken ${token}`,
      "SHIPPO-API-VERSION": SHIPPO_API_VERSION,
    },
  });
  const text = await res.text();
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = {};
  }
  if (!res.ok) {
    const err = new Error(extractGetError(json, res.status));
    err.shippoResponseJson = json;
    err.shippoHttpStatus = res.status;
    throw err;
  }
  return json;
}

/**
 * Re-fetch Shippo objects for this order (GET only). Does not POST orders, shipments, or transactions.
 * Updates local DB cache: tracking, transaction status, label URL, shipment rate snapshot from existing IDs.
 *
 * @param {string} orderId
 * @returns {{ ok: boolean, refreshed: string[], error?: string }}
 */
export async function refreshShippoStatusForWebsiteOrder(orderId) {
  const token = process.env.SHIPPO_API_TOKEN?.trim();
  if (!token) {
    throw new Error("SHIPPO_API_TOKEN is not configured.");
  }
  const row = await getOrderByIdForService(orderId);
  if (!row) {
    const e = new Error("Order not found.");
    e.statusCode = 404;
    throw e;
  }
  if (String(row.status || "").toLowerCase() !== "paid") {
    const e = new Error("Only paid orders can refresh Shippo status.");
    e.statusCode = 400;
    throw e;
  }

  const oid = String(row.shippo_order_id || "").trim();
  const sid = String(row.shippo_shipment_object_id || "").trim();
  const tid = String(row.shippo_transaction_id || "").trim();

  if (!oid && !sid && !tid) {
    const e = new Error("Nothing to refresh: order has no Shippo order, shipment, or transaction id yet. Use Sync to Shippo first.");
    e.statusCode = 400;
    throw e;
  }

  const refreshed = [];

  if (sid) {
    const sh = await shippoGetJson(`/shipments/${encodeURIComponent(sid)}/`, token);
    const rates = Array.isArray(sh.rates) ? sh.rates : [];
    const rateStatus = rates.length ? "rates_available" : "no_rates";
    const normalizedRates = sortRatesForAdminDisplay(normalizeRatesForStorage(rates));
    await updateOrderShippoShipmentState(row.id, {
      shippo_shipment_rates_json: {
        rates: normalizedRates,
        rateCount: rates.length,
        shipmentObjectId: sid,
      },
      shippo_shipment_rate_status: rateStatus,
      shippo_shipment_sync_error: null,
    });
    refreshed.push("shipment");
  }

  if (tid) {
    const tx = await shippoGetJson(`/transactions/${encodeURIComponent(tid)}/`, token);
    const st = String(tx.status || "").trim().toUpperCase();
    const trackingStatusRaw = String(tx.tracking_status || "").trim().toUpperCase();
    const syncError =
      st === "ERROR"
        ? String(tx.messages?.[0]?.text || "Shippo transaction error.").slice(0, 4000)
        : null;

    await updateOrderFromShippoWebhook(row.id, {
      shippo_transaction_status: st || undefined,
      shippo_shipment_status:
        st === "SUCCESS" ? "label_purchased" : st === "ERROR" ? "label_error" : "label_pending",
      shippo_tracking_number: String(tx.tracking_number || "").trim() || undefined,
      shippo_tracking_status: trackingStatusRaw || String(tx.tracking_status || "").trim() || undefined,
      shippo_tracking_url_provider: String(tx.tracking_url_provider || "").trim() || undefined,
      shippo_label_url: String(tx.label_url || "").trim() || undefined,
      shippo_sync_status: st === "ERROR" ? "error" : "synced",
      shippo_sync_error: syncError ?? null,
    });
    refreshed.push("transaction");
  } else if (oid) {
    const ord = await shippoGetJson(`/orders/${encodeURIComponent(oid)}/`, token);
    const orderStatus = String(ord.order_status || "").trim();
    const track = String(ord.tracking_number || "").trim();
    const trackSt = String(ord.tracking_status || "").trim();

    const webhookPatch = {
      shippo_sync_status: "synced",
      shippo_sync_error: null,
    };
    if (orderStatus) {
      webhookPatch.shippo_shipment_status = `shippo_order_${orderStatus.toLowerCase()}`;
    }
    if (track) {
      webhookPatch.shippo_tracking_number = track;
    }
    if (trackSt) {
      webhookPatch.shippo_tracking_status = trackSt.toUpperCase();
    }
    await updateOrderFromShippoWebhook(row.id, webhookPatch);
    refreshed.push("order");
  }

  if (!refreshed.includes("transaction") && !refreshed.includes("order")) {
    await updateOrderFromShippoWebhook(row.id, {});
  }

  return { ok: true, refreshed };
}
