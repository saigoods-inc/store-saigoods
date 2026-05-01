import { getShippoApiBaseUrl, isShippoConfigured } from "./shippo.js";
import {
  getOrderByIdForService,
  markOrderShippoSyncFailed,
  markOrderShippoSynced,
  tryBeginShippoOrderSync,
} from "./orders.js";
import { buildParcelsForOrder } from "./shippo-order-parcels.js";

const DEFAULT_WEIGHT_LB = 1;
const DEFAULT_WEIGHT_UNIT = "lb";
const SHIPPO_API_VERSION = "2018-02-08";

const SHIPPO_REQUIRED_ADDRESS_FIELDS = ["name", "street1", "city", "state", "zip", "country"];

function usd(cents) {
  return (Math.max(0, Number(cents) || 0) / 100).toFixed(2);
}

function parseEnvWeightLb() {
  const raw = process.env.SHIPPO_DEFAULT_ITEM_WEIGHT_LB?.trim();
  if (!raw) {
    return DEFAULT_WEIGHT_LB;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    return DEFAULT_WEIGHT_LB;
  }
  return n;
}

function normalizeCountry(value) {
  return String(value || "").trim().toUpperCase();
}

function normalizeZip(value) {
  return String(value || "").trim();
}

/** JSONB sometimes arrives as a string; admin client may also stringify. */
export function coerceJsonObject(value) {
  if (value == null) {
    return null;
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    return value;
  }
  if (typeof value === "string") {
    const t = value.trim();
    if (!t) {
      return null;
    }
    try {
      const p = JSON.parse(t);
      if (p && typeof p === "object" && !Array.isArray(p)) {
        return p;
      }
    } catch {
      return null;
    }
  }
  return null;
}

function parseCustomerAddressText(text) {
  const raw = String(text || "").trim();
  if (!raw) {
    return null;
  }
  const lines = raw
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!lines.length) {
    return null;
  }

  let line1 = lines[0] || "";
  let line2 = "";
  let cityLine = "";
  let country = "";
  if (lines.length >= 4) {
    line2 = lines[1] || "";
    cityLine = lines[2] || "";
    country = lines[3] || "";
  } else if (lines.length === 3) {
    cityLine = lines[1] || "";
    country = lines[2] || "";
  } else if (lines.length === 2) {
    cityLine = lines[1] || "";
  }

  const m1 = cityLine.match(/^(.*?),\s*([A-Za-z]{2})\s*,\s*(\d{5}(?:-\d{4})?)$/);
  const m2 = cityLine.match(/^(.*?),\s*([A-Za-z]{2})\s+(\d{5}(?:-\d{4})?)$/);
  const m = m1 || m2;

  return {
    line1,
    line2,
    city: m ? String(m[1] || "").trim() : "",
    state: m ? String(m[2] || "").trim().toUpperCase().slice(0, 2) : "",
    postalCode: m ? normalizeZip(m[3]) : "",
    country: normalizeCountry(country),
  };
}

function normalizeAddressObject(raw) {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const line1 = String(raw.line1 || raw.street1 || raw.address_line_1 || raw.address1 || "").trim();
  const line2 = String(raw.line2 || raw.street2 || raw.address_line_2 || raw.address2 || "").trim();
  const city = String(raw.city || raw.locality || "").trim();
  const state = String(raw.state || raw.province || raw.region || raw.administrative_district_level_1 || "")
    .trim()
    .toUpperCase()
    .slice(0, 2);
  const postalCode = normalizeZip(raw.postalCode || raw.zip || raw.zip_code || raw.postal_code);
  const country = normalizeCountry(raw.country || raw.country_code);
  return { line1, line2, city, state, postalCode, country };
}

function requiredAddressMissingFields(addr) {
  const a = addr && typeof addr === "object" ? addr : {};
  const missing = [];
  if (!String(a.name || "").trim()) missing.push("name");
  if (!String(a.line1 || "").trim()) missing.push("street1");
  if (!String(a.city || "").trim()) missing.push("city");
  if (!String(a.state || "").trim()) missing.push("state");
  if (!String(a.postalCode || "").trim()) missing.push("zip");
  if (!String(a.country || "").trim()) missing.push("country");
  return missing;
}

function missingAddressMessage(missing) {
  const m = Array.isArray(missing) ? missing : [];
  if (!m.length) {
    return "Order is missing a complete shipping_address for Shippo sync.";
  }
  const labels = {
    name: "shipping name",
    street1: "shipping street1",
    city: "city",
    state: "state",
    zip: "ZIP",
    country: "country",
  };
  return `Missing ${m.map((k) => labels[k] || k).join(", ")} for Shippo sync.`;
}

function resolveOrderShippingAddress(orderRow) {
  const shipRaw = coerceJsonObject(orderRow?.shipping_address) ?? {};
  const addrObj = normalizeAddressObject(shipRaw);
  const parsedText = parseCustomerAddressText(orderRow?.customer_address);
  const shipName = String(shipRaw.name || shipRaw.full_name || "").trim();
  const shipEmail = String(shipRaw.email || "").trim();
  const shipPhone = String(shipRaw.phone || "").trim();
  const merged = {
    name: String(shipName || orderRow?.customer_name || "").trim(),
    email: String(shipEmail || orderRow?.customer_email || "").trim(),
    phone: String(shipPhone || orderRow?.customer_phone || "").trim(),
    line1: String(addrObj?.line1 || parsedText?.line1 || "").trim(),
    line2: String(addrObj?.line2 || parsedText?.line2 || "").trim(),
    city: String(addrObj?.city || parsedText?.city || "").trim(),
    state: String(addrObj?.state || parsedText?.state || "").trim().toUpperCase().slice(0, 2),
    postalCode: normalizeZip(addrObj?.postalCode || parsedText?.postalCode || ""),
    country: normalizeCountry(addrObj?.country || parsedText?.country || ""),
  };
  return merged;
}

function normalizeShippoAddress(address, fallbackName, fallbackEmail, fallbackPhone) {
  const addr = address && typeof address === "object" ? address : {};
  const name = String(addr.name || fallbackName || "").trim() || "Customer";
  const out = {
    name,
    street1: String(addr.line1 || "").trim(),
    city: String(addr.city || "").trim(),
    state: String(addr.state || "").trim().toUpperCase().slice(0, 2),
    zip: String(addr.postalCode || "").trim(),
    country: normalizeCountry(addr.country),
  };
  const line2 = String(addr.line2 || "").trim();
  if (line2) {
    out.street2 = line2;
  }
  const em = String(addr.email || fallbackEmail || "").trim();
  if (em) {
    out.email = em;
  }
  const ph = String(addr.phone || fallbackPhone || "").trim();
  if (ph) {
    out.phone = ph;
  }
  return out;
}

function buildOptionalFromAddress() {
  const street1 = String(process.env.SHIPPO_FROM_STREET1 || "").trim();
  const city = String(process.env.SHIPPO_FROM_CITY || "").trim();
  const state = String(process.env.SHIPPO_FROM_STATE || "")
    .trim()
    .toUpperCase()
    .slice(0, 2);
  const zip = String(process.env.SHIPPO_FROM_ZIP || "").trim();
  const country = String(process.env.SHIPPO_FROM_COUNTRY || "US")
    .trim()
    .toUpperCase();

  if (!street1 || !city || !state || !zip) {
    return null;
  }

  const out = {
    name: String(process.env.SHIPPO_FROM_NAME || "SAI Goods").trim() || "SAI Goods",
    street1,
    city,
    state,
    zip,
    country: country || "US",
  };
  const company = String(process.env.SHIPPO_FROM_COMPANY || "").trim();
  if (company) {
    out.company = company;
  }
  const email = String(process.env.SHIPPO_FROM_EMAIL || "").trim();
  if (email) {
    out.email = email;
  }
  const phone = String(process.env.SHIPPO_FROM_PHONE || "").trim();
  if (phone) {
    out.phone = phone;
  }
  return out;
}

/**
 * Admin override shape: { name, line1, line2?, city, state, postalCode, country, email?, phone? }
 * @param {object} orderRow
 * @returns {ReturnType<typeof normalizeShippoAddress> | null}
 */
function shippoFromOverrideToNormalizedShippo(orderRow) {
  const ov = coerceJsonObject(orderRow?.shippo_from_address_override_json);
  if (!ov) {
    return null;
  }
  const merged = {
    name: String(ov.name || "").trim(),
    line1: String(ov.line1 || "").trim(),
    line2: String(ov.line2 || "").trim(),
    city: String(ov.city || "").trim(),
    state: String(ov.state || "").trim().toUpperCase().slice(0, 2),
    postalCode: normalizeZip(ov.postalCode || ov.zip),
    country: normalizeCountry(ov.country || "US"),
    email: String(ov.email || "").trim(),
    phone: String(ov.phone || "").trim(),
  };
  if (!merged.line1 || !merged.city || !merged.state || !merged.postalCode || !merged.country) {
    return null;
  }
  const nm = merged.name || String(process.env.SHIPPO_FROM_NAME || "SAI Goods").trim() || "SAI Goods";
  return normalizeShippoAddress(merged, nm, merged.email, merged.phone);
}

/**
 * Sender for Shippo: DB override when complete, otherwise env-based from address.
 * @param {object} orderRow
 */
export function buildFromAddressForOrder(orderRow) {
  const fromOverride = shippoFromOverrideToNormalizedShippo(orderRow);
  if (fromOverride) {
    return fromOverride;
  }
  return buildOptionalFromAddress();
}

/**
 * Return address for Shippo shipment (optional). When unset, Shippo defaults return to sender.
 * @param {object} orderRow
 */
export function buildReturnAddressForOrder(orderRow) {
  const ov = coerceJsonObject(orderRow?.shippo_return_address_override_json);
  if (!ov) {
    return null;
  }
  const merged = {
    name: String(ov.name || "").trim(),
    line1: String(ov.line1 || "").trim(),
    line2: String(ov.line2 || "").trim(),
    city: String(ov.city || "").trim(),
    state: String(ov.state || "").trim().toUpperCase().slice(0, 2),
    postalCode: normalizeZip(ov.postalCode || ov.zip),
    country: normalizeCountry(ov.country || "US"),
    email: String(ov.email || "").trim(),
    phone: String(ov.phone || "").trim(),
  };
  if (!merged.line1 || !merged.city || !merged.state || !merged.postalCode || !merged.country) {
    return null;
  }
  const nm = merged.name || "Return";
  return normalizeShippoAddress(merged, nm, merged.email, merged.phone);
}

function buildShippoLineItems(orderRow) {
  const lines = Array.isArray(orderRow?.items) ? orderRow.items : [];
  const defaultWeight = parseEnvWeightLb();
  return lines.map((line, idx) => {
    const cases = Math.max(0, Math.floor(Number(line?.lineCases) || 0));
    const boxes = Math.max(0, Math.floor(Number(line?.lineBoxCount) || 0));
    const qty = Math.max(1, cases + boxes);
    const linePrice = Number(line?.lineTotalCents);
    const totalCents = Number.isFinite(linePrice) && linePrice > 0 ? linePrice : 0;
    const weightLb = qty * defaultWeight;
    return {
      title: String(line?.name || line?.slug || `Item ${idx + 1}`).slice(0, 250),
      sku: String(line?.slug || `item-${idx + 1}`).slice(0, 100),
      quantity: qty,
      total_price: usd(totalCents),
      currency: "USD",
      weight: weightLb.toFixed(2),
      weight_unit: DEFAULT_WEIGHT_UNIT,
    };
  });
}

function buildShippoOrderPayload(orderRow) {
  const orderId = String(orderRow?.id || "").trim();
  const orderRef = String(orderRow?.order_ref || orderId).trim();
  const normalized = resolveOrderShippingAddress(orderRow);
  const missing = requiredAddressMissingFields(normalized);
  if (missing.length > 0) {
    const e = new Error(missingAddressMessage(missing));
    e.code = "SHIPPO_ADDRESS_MISSING_FIELDS";
    const mapToCanonical = { name: "name", street1: "street1", city: "city", state: "state", zip: "zip", country: "country" };
    e.missingFields = missing
      .map((k) => mapToCanonical[k] || k)
      .filter((k) => SHIPPO_REQUIRED_ADDRESS_FIELDS.includes(k));
    throw e;
  }

  const toAddress = normalizeShippoAddress(
    normalized,
    orderRow?.customer_name,
    orderRow?.customer_email,
    orderRow?.customer_phone,
  );
  toAddress.metadata = `order_id:${orderId}`.slice(0, 100);

  const lineItems = buildShippoLineItems(orderRow);
  if (!lineItems.length) {
    const e = new Error(
      "Cannot sync to Shippo: order has no line items (items array is empty). Pack line items before syncing.",
    );
    e.code = "SHIPPO_NO_LINE_ITEMS";
    throw e;
  }
  for (const li of lineItems) {
    const w = Number(li.weight);
    if (!Number.isFinite(w) || w <= 0) {
      const e = new Error(`Cannot sync to Shippo: line item "${li.title}" has invalid weight (${li.weight}).`);
      e.code = "SHIPPO_BAD_WEIGHT";
      throw e;
    }
  }

  const totalWeightLb = lineItems.reduce((sum, li) => sum + (Number(li.weight) || 0), 0);

  const payload = {
    order_number: orderRef,
    order_status: "PAID",
    placed_at: String(orderRow?.paid_at || orderRow?.created_at || new Date().toISOString()),
    to_address: toAddress,
    line_items: lineItems,
    currency: "USD",
    subtotal_price: usd(orderRow?.subtotal_cents),
    shipping_cost: usd(orderRow?.shipping_cents),
    shipping_cost_currency: "USD",
    total_tax: usd(orderRow?.tax_cents),
    total_price: usd(orderRow?.total_cents),
    notes: JSON.stringify({
      website_order_id: orderId,
      order_ref: orderRef,
      residential: Boolean(orderRow?.shipping_cents > 0),
    }),
    weight: totalWeightLb.toFixed(2),
    weight_unit: DEFAULT_WEIGHT_UNIT,
  };

  const fromAddress = buildFromAddressForOrder(orderRow);
  if (fromAddress) {
    payload.from_address = fromAddress;
  }
  return payload;
}

/** When true, `buildShippoAddressesForShipment` sets `address_to.is_residential: true` (default). Set to `false` to omit. */
export function isShippoAddressToResidentialForced() {
  return String(process.env.SHIPPO_ADDRESS_TO_IS_RESIDENTIAL || "true")
    .trim()
    .toLowerCase() !== "false";
}

/**
 * Validated to/from addresses for Shippo Shipments API.
 * @param {object} orderRow
 */
export function buildShippoAddressesForShipment(orderRow) {
  const orderId = String(orderRow?.id || "").trim();
  const normalized = resolveOrderShippingAddress(orderRow);
  const missing = requiredAddressMissingFields(normalized);
  if (missing.length > 0) {
    const e = new Error(missingAddressMessage(missing));
    e.code = "SHIPPO_ADDRESS_MISSING_FIELDS";
    throw e;
  }
  const toAddress = normalizeShippoAddress(
    normalized,
    orderRow?.customer_name,
    orderRow?.customer_email,
    orderRow?.customer_phone,
  );
  if (isShippoAddressToResidentialForced()) {
    toAddress.is_residential = true;
  }
  if (orderId) {
    toAddress.metadata = `order_id:${orderId}`.slice(0, 100);
  }
  return {
    toAddress,
    fromAddress: buildFromAddressForOrder(orderRow),
    returnAddress: buildReturnAddressForOrder(orderRow),
  };
}

/**
 * Inspect what would be sent to Shippo (for admin/debug). Does not call the API.
 * @param {object} orderRow
 */
export function describeShippoOrderSync(orderRow) {
  const raw = coerceJsonObject(orderRow?.shipping_address);
  const resolved = resolveOrderShippingAddress(orderRow);
  const missing = requiredAddressMissingFields(resolved);
  const lineItems = buildShippoLineItems(orderRow);
  let payload = null;
  let payloadError = null;
  try {
    payload = buildShippoOrderPayload(orderRow);
  } catch (e) {
    payloadError = String(e?.message || e);
  }
  let parcelPlan = null;
  let parcelError = null;
  try {
    parcelPlan = buildParcelsForOrder(orderRow);
  } catch (e) {
    parcelError = String(e?.message || e);
  }
  return {
    rawShippingAddressFromDb: raw ?? orderRow?.shipping_address,
    resolvedShippingForSync: resolved,
    missingAddressFields: missing,
    lineItems,
    /** POST /orders/ — line items + aggregate weight (no per-parcel dimensions). */
    payload,
    /** Same as `payload`; explicit name for admin UI vs shipment payload. */
    orderPayload: payload,
    payloadError,
    parcelPlan,
    parcelError,
  };
}

function extractShippoErrorMessage(json, status) {
  if (!json || typeof json !== "object") {
    return `Shippo order sync failed (HTTP ${status}).`;
  }
  if (typeof json.detail === "string" && json.detail.trim()) {
    return json.detail.trim();
  }
  if (typeof json.message === "string" && json.message.trim()) {
    return json.message.trim();
  }
  if (typeof json.error === "string" && json.error.trim()) {
    return json.error.trim();
  }
  if (Array.isArray(json.__all__) && json.__all__.length) {
    return String(json.__all__[0] || "").trim() || `Shippo order sync failed (HTTP ${status}).`;
  }
  if (Array.isArray(json.non_field_errors) && json.non_field_errors.length) {
    return String(json.non_field_errors[0] || "").trim();
  }
  try {
    const s = JSON.stringify(json);
    if (s && s !== "{}") {
      return `Shippo error (HTTP ${status}): ${s.slice(0, 2000)}`;
    }
  } catch {
    /* ignore */
  }
  return `Shippo order sync failed (HTTP ${status}).`;
}

async function createOrderInShippo(orderRow) {
  const token = process.env.SHIPPO_API_TOKEN?.trim();
  if (!token) {
    throw new Error("SHIPPO_API_TOKEN is not configured.");
  }
  const payload = buildShippoOrderPayload(orderRow);
  const url = `${getShippoApiBaseUrl()}/orders/`;
  console.info("[shippo] create order request", {
    orderId: String(orderRow?.id || ""),
    orderRef: String(orderRow?.order_ref || ""),
    url,
    itemCount: Array.isArray(payload.line_items) ? payload.line_items.length : 0,
    hasFromAddress: Boolean(payload.from_address),
    totalPrice: payload.total_price,
    to_address: payload.to_address,
    from_address: payload.from_address || null,
    line_items: payload.line_items,
    weight: payload.weight,
    weight_unit: payload.weight_unit,
    order_number: payload.order_number,
    notes: payload.notes,
  });
  console.info("[shippo] create order full payload JSON", JSON.stringify(payload));

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `ShippoToken ${token}`,
      "Content-Type": "application/json",
      "SHIPPO-API-VERSION": SHIPPO_API_VERSION,
    },
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = {};
  }

  console.info("[shippo] create order response", {
    orderId: String(orderRow?.id || ""),
    orderRef: String(orderRow?.order_ref || ""),
    httpStatus: res.status,
    ok: res.ok,
    shippoOrderId: String(json.object_id || ""),
    responseBody: text,
    responseJson: json,
  });

  if (!res.ok) {
    const err = new Error(extractShippoErrorMessage(json, res.status));
    err.shippoPayload = payload;
    err.shippoHttpStatus = res.status;
    err.shippoResponseJson = json;
    err.shippoResponseText = text;
    console.error("[shippo] create order HTTP error", {
      orderId: String(orderRow?.id || ""),
      httpStatus: res.status,
      responseJson: json,
      responseText: text,
    });
    throw err;
  }

  const shippoOrderId = String(json.object_id || "").trim();
  if (!shippoOrderId) {
    throw new Error("Shippo did not return an order object_id.");
  }

  return {
    shippoOrderId,
    shippoTrackingNumber: String(json.tracking_number || "").trim() || null,
    shippoTrackingStatus: String(json.tracking_status || "").trim() || null,
  };
}

/**
 * Best-effort sync of a completed website order to Shippo Orders.
 * Failure is persisted on the order row but never thrown to checkout caller.
 *
 * @param {string} orderId
 * @param {{ skipAutoShipment?: boolean }} [options] — When true, do not create a Shippo Shipment after the Order is created or backfilled (admin dashboard runs a forced shipment refresh separately).
 */
export async function syncWebsiteOrderToShippo(orderId, options = {}) {
  const skipAutoShipment = options.skipAutoShipment === true;
  if (!isShippoConfigured()) {
    return { ok: false, skipped: true, reason: "shippo_not_configured" };
  }
  const snapshot = await getOrderByIdForService(orderId);
  if (!snapshot) {
    return { ok: false, skipped: true, reason: "order_not_found" };
  }
  if (String(snapshot.status || "").toLowerCase() !== "paid") {
    return { ok: true, skipped: true, reason: "order_not_paid" };
  }
  if (snapshot.shippo_order_id) {
    if (!skipAutoShipment && !snapshot.shippo_shipment_object_id) {
      try {
        const { tryCreateShippoShipmentAfterOrderSync } = await import("./shippo-shipment-sync.js");
        const shipment = await tryCreateShippoShipmentAfterOrderSync(orderId);
        return { ok: true, skipped: true, reason: "already_synced", shipment };
      } catch (e) {
        console.error("[shippo] shipment backfill after existing order", e);
        return { ok: true, skipped: true, reason: "already_synced" };
      }
    }
    return { ok: true, skipped: true, reason: "already_synced" };
  }

  const order = await tryBeginShippoOrderSync(orderId);
  if (!order) {
    return { ok: true, skipped: true, reason: "already_synced_or_locked" };
  }

  try {
    const created = await createOrderInShippo(order);
    await markOrderShippoSynced(order.id, {
      shippoOrderId: created.shippoOrderId,
      shippoShipmentStatus: "order_created",
      shippoTrackingNumber: created.shippoTrackingNumber || undefined,
      shippoTrackingStatus: created.shippoTrackingStatus || undefined,
    });
    console.info("[shippo] Order synced", {
      orderId: String(order.id),
      orderRef: order.order_ref,
      shippoOrderId: created.shippoOrderId,
    });
    let shipment = null;
    if (!skipAutoShipment) {
      try {
        const { tryCreateShippoShipmentAfterOrderSync } = await import("./shippo-shipment-sync.js");
        shipment = await tryCreateShippoShipmentAfterOrderSync(order.id);
      } catch (e) {
        console.error("[shippo] shipment after order sync", e?.message || e);
      }
    }
    return { ok: true, shippoOrderId: created.shippoOrderId, shipment };
  } catch (err) {
    const message = String(err?.message || "Shippo order sync failed.");
    console.error("[shippo] Order sync failed", {
      orderId: String(order.id),
      orderRef: order.order_ref,
      error: message,
      shippoHttpStatus: err?.shippoHttpStatus,
      shippoResponseJson: err?.shippoResponseJson,
    });
    await markOrderShippoSyncFailed(order.id, message, {
      lastPayload: err?.shippoPayload ?? null,
      shippoErrorResponse: err?.shippoResponseJson ?? null,
    });
    return { ok: false, error: message };
  }
}
