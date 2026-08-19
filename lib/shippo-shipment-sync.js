import { getShippoApiBaseUrl } from "./shippo.js";
import { resolveParcelsForFulfillment } from "./shippo-order-parcels.js";
import { normalizeRatesForStorage, sortRatesForAdminDisplay } from "./shippo-rate-utils.js";
import { buildShippoAddressesForShipment } from "./shippo-order-sync.js";
import { warehouseAddressFingerprint, withRuntimeWarehouseAddress } from "./warehouse-settings.js";
import { getOrderByIdForService, updateOrderShippoShipmentState } from "./orders.js";
import { isShippoCarrierRateLimited } from "./shippo-rate-limit.js";

const SHIPPO_API_VERSION = "2018-02-08";
const DEFAULT_SHIPMENT_TIMEOUT_MS = 20_000;
const DEFAULT_EMPTY_RATES_RETRY_COUNT = 8;
const DEFAULT_EMPTY_RATES_RETRY_DELAY_MS = 1_000;
const DEFAULT_RATE_LIMIT_RETRY_COUNT = 2;
const DEFAULT_RATE_LIMIT_RETRY_DELAY_MS = 1_500;

function parseShipmentTimeoutMs() {
  const n = Math.round(Number(process.env.SHIPPO_RATE_TIMEOUT_MS || ""));
  if (Number.isFinite(n) && n >= 1_000 && n <= 120_000) {
    return n;
  }
  return DEFAULT_SHIPMENT_TIMEOUT_MS;
}

function parseEmptyRatesRetryCount() {
  const raw = String(process.env.SHIPPO_RATE_EMPTY_RETRY_COUNT ?? "").trim();
  if (!raw) {
    return DEFAULT_EMPTY_RATES_RETRY_COUNT;
  }
  const n = Math.round(Number(raw));
  if (Number.isFinite(n) && n >= 0 && n <= 12) {
    return n;
  }
  return DEFAULT_EMPTY_RATES_RETRY_COUNT;
}

function parseEmptyRatesRetryDelayMs() {
  const n = Math.round(Number(process.env.SHIPPO_RATE_EMPTY_RETRY_DELAY_MS || ""));
  if (Number.isFinite(n) && n >= 100 && n <= 5_000) {
    return n;
  }
  return DEFAULT_EMPTY_RATES_RETRY_DELAY_MS;
}

function parseRateLimitRetryCount() {
  const raw = String(process.env.SHIPPO_RATE_LIMIT_RETRY_COUNT ?? "").trim();
  if (!raw) return DEFAULT_RATE_LIMIT_RETRY_COUNT;
  const n = Math.round(Number(raw));
  return Number.isFinite(n) && n >= 0 && n <= 4 ? n : DEFAULT_RATE_LIMIT_RETRY_COUNT;
}

function parseRateLimitRetryDelayMs() {
  const n = Math.round(Number(process.env.SHIPPO_RATE_LIMIT_RETRY_DELAY_MS || ""));
  return Number.isFinite(n) && n >= 100 && n <= 10_000 ? n : DEFAULT_RATE_LIMIT_RETRY_DELAY_MS;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function storedRateCount(raw) {
  let value = raw;
  if (typeof value === "string" && value.trim()) {
    try {
      value = JSON.parse(value);
    } catch {
      return 0;
    }
  }
  if (Array.isArray(value)) {
    return value.length;
  }
  return Array.isArray(value?.rates) ? value.rates.length : 0;
}

async function requestShippoShipment(url, options, timeoutMs) {
  const res = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = {};
  }
  return { res, json };
}

async function pollShippoShipmentRates({ shipmentId, token, timeoutMs, retryCount, retryDelayMs, onPoll }) {
  let result = null;
  const shipmentUrl = `${getShippoApiBaseUrl()}/shipments/${encodeURIComponent(shipmentId)}/`;
  for (let attempt = 0; attempt < retryCount; attempt += 1) {
    await sleep(retryDelayMs);
    onPoll?.(attempt + 1, shipmentUrl);
    result = await requestShippoShipment(
      shipmentUrl,
      {
        method: "GET",
        headers: {
          Authorization: `ShippoToken ${token}`,
          "SHIPPO-API-VERSION": SHIPPO_API_VERSION,
        },
      },
      timeoutMs,
    );
    const rates = Array.isArray(result.json?.rates) ? result.json.rates : [];
    if (!result.res.ok || rates.length) {
      break;
    }
  }
  return result;
}

/**
 * Prefer UPS for operations: set SHIPPO_UPS_CARRIER_ACCOUNT_ID and/or SHIPPO_CARRIER_ACCOUNT_IDS (comma-separated Shippo carrier account object_ids).
 */
/**
 * Shippo expects shipment_date as ISO 8601 UTC (e.g. 2014-01-18T00:35:03.463Z).
 * We store only the calendar day (YYYY-MM-DD) in the DB; map to noon UTC for stability.
 * @param {string} ymd
 * @returns {string | null}
 */
export function shipmentDateYmdToShippoIso(ymd) {
  const t = String(ymd || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) {
    return null;
  }
  return `${t}T12:00:00.000Z`;
}

export function parseShippoCarrierAccountIds() {
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

/**
 * Body for Shippo POST /shipments/ (rates + labels). Separate from POST /orders/ (CRM line items).
 * @param {object} orderRow
 * @returns {{ ok: true, body: object, parcels: object[], audit: object[], source: string } | { ok: false, reason: string, body: null }}
 */
function shippoCoreAddressFingerprint(a) {
  if (!a || typeof a !== "object") {
    return "";
  }
  const s2 = a.street2 != null ? String(a.street2) : "";
  return [a.street1, s2, a.city, a.state, a.zip, a.country].map((x) => String(x || "").trim().toUpperCase()).join("|");
}

export function buildShippoShipmentCreateBody(orderRow) {
  const { toAddress, fromAddress, returnAddress } = buildShippoAddressesForShipment(orderRow);
  if (!fromAddress) {
    return { ok: false, reason: "missing_from_address_env", body: null };
  }
  const { parcels, audit, source } = resolveParcelsForFulfillment(orderRow);
  const body = {
    address_from: fromAddress,
    address_to: toAddress,
    parcels,
    metadata: `website_order:${String(orderRow.id)}`.slice(0, 100),
    async: false,
  };
  if (
    returnAddress &&
    typeof returnAddress === "object" &&
    shippoCoreAddressFingerprint(returnAddress) !== shippoCoreAddressFingerprint(fromAddress)
  ) {
    body.address_return = returnAddress;
  }
  const shipIso = shipmentDateYmdToShippoIso(orderRow.shippo_shipment_date);
  if (shipIso) {
    body.shipment_date = shipIso;
  }
  const carrierAccounts = parseShippoCarrierAccountIds();
  if (carrierAccounts?.length) {
    body.carrier_accounts = carrierAccounts;
  }
  return { ok: true, body, parcels, audit, source };
}

/**
 * Same merge as createShippoShipmentForWebsiteOrder (no HTTP). For admin preview / debugging.
 * @param {object} orderRow
 */
export function describeShipmentCreatePreview(orderRow) {
  try {
    const built = buildShippoShipmentCreateBody(orderRow);
    if (!built.ok) {
      const msg =
        built.reason === "missing_from_address_env"
          ? "Cannot build shipment preview: set sender (SHIPPO_FROM_* env) or a complete sender override on the order."
          : "Cannot build shipment preview.";
      return {
        shipmentCreatePayload: null,
        shipmentCreatePayloadError: msg,
        shipmentCreatePayloadSkippedReason: built.reason,
      };
    }
    return {
      shipmentCreatePayload: built.body,
      shipmentCreatePayloadError: null,
      shipmentCreatePayloadSkippedReason: null,
    };
  } catch (e) {
    return {
      shipmentCreatePayload: null,
      shipmentCreatePayloadError: String(e?.message || e),
      shipmentCreatePayloadSkippedReason: "exception",
    };
  }
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
 * Shippo **Order** (POST /orders/) = line items / order CRM; **Shipment** (POST /shipments/) = carrier rating + labels and requires a `parcels` array with dimensions.
 *
 * @param {object} orderRow — DB row with items, addresses, shippo_order_id
 * @param {{ force?: boolean }} [options] — recreate even if shippo_shipment_object_id is set
 */
export async function createShippoShipmentForWebsiteOrder(orderRow, options = {}) {
  orderRow = await withRuntimeWarehouseAddress(orderRow);
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

  let built;
  try {
    built = buildShippoShipmentCreateBody(orderRow);
  } catch (e) {
    const msg = String(e?.message || e);
    await updateOrderShippoShipmentState(orderRow.id, {
      shippo_shipment_sync_error: msg,
    });
    throw e;
  }
  if (!built.ok) {
    const msg =
      built.reason === "missing_from_address_env"
        ? "Cannot create Shippo shipment: set sender (SHIPPO_FROM_* env) or a complete sender override on the order."
        : "Cannot create Shippo shipment: invalid addresses or parcels.";
    await updateOrderShippoShipmentState(orderRow.id, {
      shippo_shipment_sync_error: msg,
    });
    return { ok: false, skipped: true, reason: built.reason };
  }

  const { body, parcels, audit, source } = built;

  const url = `${getShippoApiBaseUrl()}/shipments/`;
  console.info("[shippo] create shipment", {
    orderId: String(orderRow.id),
    parcelCount: parcels.length,
    url,
  });
  if (process.env.SHIPPO_DEBUG_PAYLOADS === "1" && process.env.NODE_ENV !== "production" && !process.env.VERCEL) {
    console.info("[shippo] shipment request JSON", JSON.stringify(body));
  }

  const timeoutMs = parseShipmentTimeoutMs();
  const emptyRatesRetryCount = parseEmptyRatesRetryCount();
  const emptyRatesRetryDelayMs = parseEmptyRatesRetryDelayMs();
  let res;
  let json = {};
  try {
    ({ res, json } = await requestShippoShipment(
      url,
      {
        method: "POST",
        headers: {
          Authorization: `ShippoToken ${token}`,
          "Content-Type": "application/json",
          "SHIPPO-API-VERSION": SHIPPO_API_VERSION,
        },
        body: JSON.stringify(body),
      },
      timeoutMs,
    ));
    const shipmentId = String(json?.object_id || "").trim();
    const currentRates = Array.isArray(json?.rates) ? json.rates : [];
    if (res.ok && !currentRates.length && shipmentId && emptyRatesRetryCount > 0) {
      const polled = await pollShippoShipmentRates({
        shipmentId,
        token,
        timeoutMs,
        retryCount: emptyRatesRetryCount,
        retryDelayMs: emptyRatesRetryDelayMs,
        onPoll: (attempt) => {
          console.info("[shippo] empty rates returned; polling created shipment", {
            orderId: String(orderRow.id),
            attempt,
            maxAttempts: emptyRatesRetryCount,
            shipmentId,
            delayMs: emptyRatesRetryDelayMs,
          });
        },
      });
      if (polled) {
        ({ res, json } = polled);
      }
    }
  } catch (e) {
    const isTimeout = e?.name === "TimeoutError";
    const msg = isTimeout
      ? "Shippo did not respond in time. The original checkout quote is still saved; try refreshing current label rates again."
      : "Could not reach Shippo. The original checkout quote is still saved; try refreshing current label rates again or use an external label.";
    await updateOrderShippoShipmentState(orderRow.id, {
      shippo_shipment_sync_error: msg,
      shippo_parcel_audit_json: {
        parcels: audit,
        source,
        parcelCount: parcels.length,
        requestParcels: parcels,
        lastShipmentCreateRequest: body,
        lastShipmentCreateRequestAt: new Date().toISOString(),
        transportError: String(e?.message || e),
      },
    });
    const err = new Error(msg);
    err.code = isTimeout ? "SHIPPO_SHIPMENT_TIMEOUT" : "SHIPPO_SHIPMENT_FETCH_FAILED";
    err.technicalMessage = String(e?.message || e);
    err.shippoPayload = body;
    throw err;
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
        lastShipmentCreateRequest: body,
        lastShipmentCreateRequestAt: new Date().toISOString(),
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
  const noRatesMessage = rates.length ? null : "Shippo returned no current label rates for this shipment. Try refreshing current rates again.";

  const normalizedRates = sortRatesForAdminDisplay(normalizeRatesForStorage(rates));
  const multiPieceCarrierNote =
    parcels.length > 1
      ? "Multiple parcels in one Shippo shipment. UPS often supports multi-piece shipments with one label flow; USPS and other carriers may not consolidate multiple parcels the same way—compare carrier messages and rates. Do not assume USPS supports multi-piece like UPS."
      : null;

  const preserveStoredRates = !rates.length && storedRateCount(orderRow.shippo_shipment_rates_json) > 0;
  await updateOrderShippoShipmentState(orderRow.id, {
    shippo_shipment_object_id: shipmentId || null,
    shippo_parcel_audit_json: {
      parcels: audit,
      source,
      parcelCount: parcels.length,
      shippoOrderId: orderRow.shippo_order_id,
      lastShipmentCreateRequest: body,
      lastShipmentCreateRequestAt: new Date().toISOString(),
      multiPieceCarrierNote,
    },
    ...(preserveStoredRates
      ? {}
      : {
          shippo_shipment_rates_json: {
            rates: normalizedRates,
            rateCount: rates.length,
            shipmentObjectId: shipmentId || null,
            shipFromFingerprint: warehouseAddressFingerprint(body.address_from),
          },
        }),
    shippo_shipment_rate_status: preserveStoredRates ? "refresh_failed" : rateStatus,
    shippo_shipment_sync_error: noRatesMessage,
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

/**
 * One physical package → one Shipment body (single parcel) for per-label purchase (Approach B).
 * @param {object} orderRow
 * @param {object} singleParcel
 * @param {number} parcelIndex — 0-based
 * @param {number} parcelCount
 * @returns {{ ok: true, body: object } | { ok: false, reason: string, body: null }}
 */
export function buildShippoSingleParcelShipmentCreateBody(orderRow, singleParcel, parcelIndex, parcelCount) {
  const { toAddress, fromAddress, returnAddress } = buildShippoAddressesForShipment(orderRow);
  if (!fromAddress) {
    return { ok: false, reason: "missing_from_address_env", body: null };
  }
  if (!singleParcel || typeof singleParcel !== "object") {
    return { ok: false, reason: "invalid_parcel", body: null };
  }
  const pc = Math.max(1, Math.floor(Number(parcelCount) || 1));
  const pi = Math.max(0, Math.floor(Number(parcelIndex) || 0));
  const body = {
    address_from: fromAddress,
    address_to: toAddress,
    parcels: [singleParcel],
    metadata: `website_order:${String(orderRow.id)}:pkg=${pi + 1}of${pc}`.slice(0, 100),
    async: false,
  };
  if (
    returnAddress &&
    typeof returnAddress === "object" &&
    shippoCoreAddressFingerprint(returnAddress) !== shippoCoreAddressFingerprint(fromAddress)
  ) {
    body.address_return = returnAddress;
  }
  const shipIso = shipmentDateYmdToShippoIso(orderRow.shippo_shipment_date);
  if (shipIso) {
    body.shipment_date = shipIso;
  }
  const carrierAccounts = parseShippoCarrierAccountIds();
  if (carrierAccounts?.length) {
    body.carrier_accounts = carrierAccounts;
  }
  return { ok: true, body };
}

/**
 * POST /shipments/ and return Shipment + rates.
 * @param {object} body
 * @returns {Promise<{ ok: true, json: object, shipmentId: string, rates: object[] } | { ok: false, errorMessage: string, json: object, status: number }>}
 */
export async function postShippoShipmentCreate(body) {
  const token = process.env.SHIPPO_API_TOKEN?.trim();
  if (!token) {
    throw new Error("SHIPPO_API_TOKEN is not configured.");
  }
  const url = `${getShippoApiBaseUrl()}/shipments/`;
  const timeoutMs = parseShipmentTimeoutMs();
  const emptyRatesRetryCount = parseEmptyRatesRetryCount();
  const emptyRatesRetryDelayMs = parseEmptyRatesRetryDelayMs();
  const rateLimitRetryCount = parseRateLimitRetryCount();
  const rateLimitRetryDelayMs = parseRateLimitRetryDelayMs();
  const requestOptions = {
    method: "POST",
    headers: {
      Authorization: `ShippoToken ${token}`,
      "Content-Type": "application/json",
      "SHIPPO-API-VERSION": SHIPPO_API_VERSION,
    },
    body: JSON.stringify(body),
  };
  let { res, json } = await requestShippoShipment(url, requestOptions, timeoutMs);
  for (let attempt = 0; attempt < rateLimitRetryCount; attempt += 1) {
    if (!res.ok || (Array.isArray(json?.rates) && json.rates.length) || !isShippoCarrierRateLimited(json)) break;
    await sleep(rateLimitRetryDelayMs * 2 ** attempt);
    ({ res, json } = await requestShippoShipment(url, requestOptions, timeoutMs));
  }
  if (res.ok && isShippoCarrierRateLimited(json) && !(Array.isArray(json?.rates) && json.rates.length)) {
    return {
      ok: false,
      status: 429,
      errorCode: "SHIPPO_RATE_LIMITED",
      retryable: true,
      errorMessage: "UPS is temporarily limiting rate requests. Automatic label purchase will retry shortly.",
      json,
    };
  }
  const createdShipmentId = String(json?.object_id || "").trim();
  const createdRates = Array.isArray(json?.rates) ? json.rates : [];
  if (res.ok && !createdRates.length && createdShipmentId && emptyRatesRetryCount > 0) {
    const polled = await pollShippoShipmentRates({
      shipmentId: createdShipmentId,
      token,
      timeoutMs,
      retryCount: emptyRatesRetryCount,
      retryDelayMs: emptyRatesRetryDelayMs,
    });
    if (polled) {
      ({ res, json } = polled);
    }
  }
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      errorMessage: extractShipmentErrorMessage(json, res.status),
      json,
    };
  }
  const shipmentId = String(json.object_id || "").trim();
  const rates = Array.isArray(json.rates) ? json.rates : [];
  return { ok: true, json, shipmentId, rates };
}
