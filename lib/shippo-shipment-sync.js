import { getShippoApiBaseUrl } from "./shippo.js";
import { buildParcelsForOrder } from "./shippo-order-parcels.js";
import { normalizeRatesForStorage, sortRatesForAdminDisplay } from "./shippo-rate-utils.js";
import { buildShippoAddressesForShipment } from "./shippo-order-sync.js";
import { getOrderByIdForService, updateOrderShippoShipmentState } from "./orders.js";

const SHIPPO_API_VERSION = "2018-02-08";

/**
 * Prefer UPS for operations: set SHIPPO_UPS_CARRIER_ACCOUNT_ID and/or SHIPPO_CARRIER_ACCOUNT_IDS (comma-separated Shippo carrier account object_ids).
 */
function parseShippoCarrierAccountIds() {
  const ups = process.env.SHIPPO_UPS_CARRIER_ACCOUNT_ID?.trim();
  const multi = process.env.SHIPPO_CARRIER_ACCOUNT_IDS?.trim();
  const ids = [];
  if (multi) {
    for (const p of multi.split(",")) {
      const x = String(p || "").trim();
      if (x) {
        ids.push(x);
      }
    }
  }
  if (ups && !ids.includes(ups)) {
    ids.unshift(ups);
  }
  return ids.length ? ids : null;
}

function extractShipmentErrorMessage(json, status) {
  if (!json || typeof json !== "object") {
    return `Shippo shipment failed (HTTP ${status}).`;
  }
  if (typeof json.detail === "string" && json.detail.trim()) {
    return json.detail.trim();
  }
  if (typeof json.message === "string" && json.message.trim()) {
    return json.message.trim();
  }
  try {
    const s = JSON.stringify(json);
    if (s && s !== "{}") {
      return `Shippo shipment (HTTP ${status}): ${s.slice(0, 1500)}`;
    }
  } catch {
    /* ignore */
  }
  return `Shippo shipment failed (HTTP ${status}).`;
}

/**
 * Creates a Shippo **Shipment** (rates + parcels) after a Shippo **Order** exists.
 * Orders = line items / CRM; Shipments = carrier rating + labels (parcels required).
 *
 * @param {object} orderRow — DB row with items, addresses, shippo_order_id
 * @param {{ force?: boolean }} [options] — recreate even if shippo_shipment_object_id is set
 */
export async function createShippoShipmentForWebsiteOrder(orderRow, options = {}) {
  const force = options.force === true;
  if (!orderRow?.shippo_order_id) {
    return { ok: false, skipped: true, reason: "no_shippo_order" };
  }
  if (orderRow.shippo_shipment_object_id && !force) {
    return { ok: true, skipped: true, reason: "already_has_shipment" };
  }

  const token = process.env.SHIPPO_API_TOKEN?.trim();
  if (!token) {
    throw new Error("SHIPPO_API_TOKEN is not configured.");
  }

  const { toAddress, fromAddress } = buildShippoAddressesForShipment(orderRow);
  if (!fromAddress) {
    const msg = "Cannot create Shippo shipment: set SHIPPO_FROM_STREET1, SHIPPO_FROM_CITY, SHIPPO_FROM_STATE, SHIPPO_FROM_ZIP.";
    await updateOrderShippoShipmentState(orderRow.id, {
      shippo_shipment_sync_error: msg,
    });
    return { ok: false, skipped: true, reason: "missing_from_address_env" };
  }

  const { parcels, audit, source } = buildParcelsForOrder(orderRow);

  const body = {
    address_from: fromAddress,
    address_to: toAddress,
    parcels,
    metadata: `website_order:${String(orderRow.id)}`.slice(0, 100),
    async: false,
  };
  const carrierAccounts = parseShippoCarrierAccountIds();
  if (carrierAccounts?.length) {
    body.carrier_accounts = carrierAccounts;
  }

  const url = `${getShippoApiBaseUrl()}/shipments/`;
  console.info("[shippo] create shipment", {
    orderId: String(orderRow.id),
    parcelCount: parcels.length,
    url,
  });
  console.info("[shippo] shipment request JSON", JSON.stringify(body));

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `ShippoToken ${token}`,
      "Content-Type": "application/json",
      "SHIPPO-API-VERSION": SHIPPO_API_VERSION,
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = {};
  }

  if (!res.ok) {
    const msg = extractShipmentErrorMessage(json, res.status);
    const multiNote =
      parcels.length > 1
        ? "Multiple parcels: carrier support varies (UPS vs USPS). See successful shipment audit for details."
        : null;
    await updateOrderShippoShipmentState(orderRow.id, {
      shippo_shipment_sync_error: msg,
      shippo_parcel_audit_json: {
        parcels: audit,
        source,
        parcelCount: parcels.length,
        requestParcels: parcels,
        multiPieceCarrierNote: multiNote,
      },
    });
    const err = new Error(msg);
    err.shippoResponseJson = json;
    err.shippoPayload = body;
    throw err;
  }

  const shipmentId = String(json.object_id || "").trim();
  const rates = Array.isArray(json.rates) ? json.rates : [];
  const rateStatus = rates.length ? "rates_available" : "no_rates";

  const normalizedRates = sortRatesForAdminDisplay(normalizeRatesForStorage(rates));
  const multiPieceCarrierNote =
    parcels.length > 1
      ? "Multiple parcels in one Shippo shipment. UPS often supports multi-piece shipments with one label flow; USPS and other carriers may not consolidate multiple parcels the same way—compare carrier messages and rates. Do not assume USPS supports multi-piece like UPS."
      : null;

  await updateOrderShippoShipmentState(orderRow.id, {
    shippo_shipment_object_id: shipmentId || null,
    shippo_parcel_audit_json: {
      parcels: audit,
      source,
      parcelCount: parcels.length,
      shippoOrderId: orderRow.shippo_order_id,
      multiPieceCarrierNote,
    },
    shippo_shipment_rates_json: {
      rates: normalizedRates,
      rateCount: rates.length,
      shipmentObjectId: shipmentId || null,
    },
    shippo_shipment_rate_status: rateStatus,
    shippo_shipment_sync_error: null,
  });

  console.info("[shippo] shipment created", {
    orderId: String(orderRow.id),
    shipmentId,
    rateCount: rates.length,
  });

  return {
    ok: true,
    shipmentId,
    rateCount: rates.length,
    rateStatus,
    parcelCount: parcels.length,
  };
}

/**
 * Called after a successful Shippo Order sync. Does not throw to callers of checkout.
 */
export async function tryCreateShippoShipmentAfterOrderSync(orderId) {
  const row = await getOrderByIdForService(orderId);
  if (!row?.shippo_order_id) {
    return { ok: false, skipped: true };
  }
  try {
    return await createShippoShipmentForWebsiteOrder(row);
  } catch (e) {
    console.error("[shippo] tryCreateShippoShipmentAfterOrderSync", orderId, e?.message || e);
    return { ok: false, error: String(e?.message || e) };
  }
}
