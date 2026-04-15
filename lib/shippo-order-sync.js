import { getShippoApiBaseUrl, isShippoConfigured } from "./shippo.js";
import {
  getOrderByIdForService,
  markOrderShippoSyncFailed,
  markOrderShippoSynced,
  tryBeginShippoOrderSync,
} from "./orders.js";

const DEFAULT_WEIGHT_LB = 1;
const DEFAULT_WEIGHT_UNIT = "lb";
const SHIPPO_API_VERSION = "2018-02-08";

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

function normalizeShippoAddress(address, fallbackName, fallbackEmail, fallbackPhone) {
  const addr = address && typeof address === "object" ? address : {};
  const name = String(fallbackName || "").trim() || "Customer";
  const out = {
    name,
    street1: String(addr.line1 || "").trim(),
    city: String(addr.city || "").trim(),
    state: String(addr.state || "").trim().toUpperCase().slice(0, 2),
    zip: String(addr.postalCode || "").trim(),
    country: String(addr.country || "US").trim().toUpperCase() || "US",
  };
  const line2 = String(addr.line2 || "").trim();
  if (line2) {
    out.street2 = line2;
  }
  const em = String(fallbackEmail || "").trim();
  if (em) {
    out.email = em;
  }
  const ph = String(fallbackPhone || "").trim();
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
  const toAddress = normalizeShippoAddress(
    orderRow?.shipping_address,
    orderRow?.customer_name,
    orderRow?.customer_email,
    orderRow?.customer_phone,
  );

  if (!toAddress.street1 || !toAddress.city || !toAddress.state || !toAddress.zip) {
    throw new Error("Order is missing a complete shipping_address for Shippo sync.");
  }

  const lineItems = buildShippoLineItems(orderRow);
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
    metadata: `order_id:${orderId}`.slice(0, 100),
    weight_unit: DEFAULT_WEIGHT_UNIT,
  };

  const fromAddress = buildOptionalFromAddress();
  if (fromAddress) {
    payload.from_address = fromAddress;
  }
  return payload;
}

function extractShippoErrorMessage(json, status) {
  if (!json || typeof json !== "object") {
    return `Shippo order sync failed (HTTP ${status}).`;
  }
  if (typeof json.detail === "string" && json.detail.trim()) {
    return json.detail.trim();
  }
  if (typeof json.error === "string" && json.error.trim()) {
    return json.error.trim();
  }
  if (Array.isArray(json.__all__) && json.__all__.length) {
    return String(json.__all__[0] || "").trim() || `Shippo order sync failed (HTTP ${status}).`;
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

  if (!res.ok) {
    throw new Error(extractShippoErrorMessage(json, res.status));
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
 */
export async function syncWebsiteOrderToShippo(orderId) {
  if (!isShippoConfigured()) {
    return { ok: false, skipped: true, reason: "shippo_not_configured" };
  }
  const snapshot = await getOrderByIdForService(orderId);
  if (!snapshot) {
    return { ok: false, skipped: true, reason: "order_not_found" };
  }
  if (String(snapshot.order_source || "") !== "web" || String(snapshot.order_type || "") !== "online") {
    return { ok: true, skipped: true, reason: "not_eligible" };
  }
  if (snapshot.shippo_order_id) {
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
    return { ok: true, shippoOrderId: created.shippoOrderId };
  } catch (err) {
    const message = String(err?.message || "Shippo order sync failed.");
    console.error("[shippo] Order sync failed", {
      orderId: String(order.id),
      orderRef: order.order_ref,
      error: message,
    });
    await markOrderShippoSyncFailed(order.id, message);
    return { ok: false, error: message };
  }
}
