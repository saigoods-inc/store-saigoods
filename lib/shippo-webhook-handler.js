import crypto from "node:crypto";
import {
  findOrderByShippoOrderId,
  findOrderByShippoTransactionId,
  recordShippoWebhookEvent,
  updateOrderFromShippoWebhook,
} from "./orders.js";
import {
  allowInsecureLocalShippoWebhook,
} from "./security-runtime.js";

function getWebhookTokenFromRequest(req) {
  const queryToken =
    (req?.query && typeof req.query.token === "string" ? req.query.token : null) ||
    (req?.url ? new URL(req.url, "http://localhost").searchParams.get("token") : null);
  const headerToken =
    (typeof req?.headers?.["x-shippo-webhook-token"] === "string" && req.headers["x-shippo-webhook-token"]) ||
    (typeof req?.headers?.["X-Shippo-Webhook-Token"] === "string" && req.headers["X-Shippo-Webhook-Token"]);
  return String(queryToken || headerToken || "").trim();
}

function timingSafeEqualStrings(a, b) {
  const left = Buffer.from(String(a), "utf8");
  const right = Buffer.from(String(b), "utf8");
  if (left.length !== right.length) {
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}

/**
 * Authorize inbound Shippo webhook requests before parsing or persisting events.
 * @param {import("http").IncomingMessage & { query?: Record<string, string>, url?: string }} req
 * @returns {{ ok: true } | { ok: false, status: number, error: string }}
 */
export function evaluateShippoWebhookAuth(req) {
  if (allowInsecureLocalShippoWebhook()) {
    return { ok: true };
  }

  const expectedToken = String(process.env.SHIPPO_WEBHOOK_TOKEN || "").trim();
  if (!expectedToken) {
    return {
      ok: false,
      status: 503,
      error: "Shippo webhook authentication is not configured.",
    };
  }

  const providedToken = getWebhookTokenFromRequest(req);
  if (!providedToken) {
    return { ok: false, status: 401, error: "Unauthorized." };
  }
  if (!timingSafeEqualStrings(providedToken, expectedToken)) {
    return { ok: false, status: 403, error: "Forbidden." };
  }

  return { ok: true };
}

function parseBodyObject(req) {
  const raw = req?.body;
  if (raw && typeof raw === "object") {
    return raw;
  }
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return null;
}

function buildEventFingerprint(eventType, data) {
  const event = String(eventType || "").trim().toLowerCase();
  const d = data && typeof data === "object" ? data : {};
  const objectId = String(d.object_id || "").trim();
  const trackStatus = String(d?.tracking_status?.status || "").trim();
  const statusDate = String(d?.tracking_status?.status_date || "").trim();
  const trackingNo = String(d?.tracking_number || "").trim();
  const transaction = String(d?.transaction || "").trim();
  const shippoOrder = String(d?.order || "").trim();
  const key = [event, objectId, trackStatus, statusDate, trackingNo, transaction, shippoOrder]
    .filter(Boolean)
    .join(":");
  return {
    eventKey: key || `${event}:unknown`,
    shippoObjectId: objectId || trackingNo || transaction || shippoOrder || null,
  };
}

function normalizeTrackShipmentStatus(status) {
  const s = String(status || "").trim().toUpperCase();
  if (!s) {
    return "tracking_unknown";
  }
  if (s === "PRE_TRANSIT") return "label_purchased";
  if (s === "TRANSIT") return "in_transit";
  if (s === "OUT_FOR_DELIVERY") return "out_for_delivery";
  if (s === "DELIVERED") return "delivered";
  if (s === "RETURNED") return "returned";
  if (s === "FAILURE") return "delivery_exception";
  return `tracking_${s.toLowerCase()}`;
}

function parseOrderIdFromMetadata(metadata) {
  const m = String(metadata || "").trim();
  if (!m) {
    return null;
  }
  const match = m.match(/order_id:([a-zA-Z0-9_-]+)/);
  return match?.[1] || null;
}

async function handleTransactionEvent(data) {
  const shippoOrderId = String(data?.order || "").trim();
  const txId = String(data?.object_id || "").trim();
  if (!shippoOrderId && !txId) {
    return { ok: true, ignored: true, reason: "missing_order_and_transaction_ids" };
  }

  let order = shippoOrderId ? await findOrderByShippoOrderId(shippoOrderId) : null;
  if (!order && txId) {
    order = await findOrderByShippoTransactionId(txId);
  }
  if (!order) {
    console.warn("[shippo webhook] Transaction event could not be matched", { shippoOrderId, txId });
    return { ok: true, ignored: true, reason: "order_not_found" };
  }

  const txStatus = String(data?.status || "").trim().toUpperCase();
  const trackingStatusRaw = String(data?.tracking_status || "").trim().toUpperCase();
  const promoteToShipped = txStatus === "SUCCESS";
  const syncError =
    txStatus === "ERROR"
      ? String(data?.messages?.[0]?.text || "Shippo transaction failed.").slice(0, 4000)
      : null;

  await updateOrderFromShippoWebhook(order.id, {
    shippo_transaction_id: txId || undefined,
    shippo_shipment_status: txStatus === "SUCCESS" ? "label_purchased" : txStatus === "ERROR" ? "label_error" : "label_pending",
    shippo_tracking_number: String(data?.tracking_number || "").trim() || undefined,
    shippo_tracking_status: trackingStatusRaw || undefined,
    shippo_tracking_status_detail: String(data?.messages?.[0]?.text || "").trim() || undefined,
    shippo_sync_status: txStatus === "ERROR" ? "error" : "synced",
    shippo_sync_error: syncError,
    promoteToShipped,
  });

  return { ok: true, orderId: order.id };
}

async function handleTrackingEvent(data) {
  const transactionId = String(data?.transaction || "").trim();
  const shippoOrderId = String(data?.order || "").trim();
  const orderIdFromMetadata = parseOrderIdFromMetadata(data?.metadata);

  let order = transactionId ? await findOrderByShippoTransactionId(transactionId) : null;
  if (!order && shippoOrderId) {
    order = await findOrderByShippoOrderId(shippoOrderId);
  }
  if (!order && orderIdFromMetadata) {
    order = { id: orderIdFromMetadata };
  }
  if (!order) {
    console.warn("[shippo webhook] Tracking event could not be matched", {
      transactionId,
      shippoOrderId,
      metadata: data?.metadata || null,
    });
    return { ok: true, ignored: true, reason: "order_not_found" };
  }

  const trackingStatusRaw = String(data?.tracking_status?.status || "").trim().toUpperCase();
  const promoteToShipped = ["PRE_TRANSIT", "TRANSIT", "OUT_FOR_DELIVERY", "DELIVERED"].includes(trackingStatusRaw);
  await updateOrderFromShippoWebhook(order.id, {
    shippo_tracking_number: String(data?.tracking_number || "").trim() || undefined,
    shippo_tracking_status: trackingStatusRaw || undefined,
    shippo_tracking_status_detail: String(data?.tracking_status?.status_details || "").trim() || undefined,
    shippo_shipment_status: normalizeTrackShipmentStatus(trackingStatusRaw),
    shippo_sync_status: "synced",
    shippo_sync_error: null,
    promoteToShipped,
  });

  return { ok: true, orderId: order.id };
}

export async function handleShippoWebhook(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed." });
    return;
  }

  try {
    const authResult = evaluateShippoWebhookAuth(req);
    if (!authResult.ok) {
      res.status(authResult.status).json({ error: authResult.error });
      return;
    }

    const body = parseBodyObject(req);
    if (!body || typeof body !== "object") {
      res.status(400).json({ error: "Invalid JSON body." });
      return;
    }

    const eventType = String(body?.event || "").trim().toLowerCase();
    const data = body?.data && typeof body.data === "object" ? body.data : {};
    if (!eventType) {
      res.status(200).json({ ok: true, ignored: true, reason: "missing_event_type" });
      return;
    }

    const fp = buildEventFingerprint(eventType, data);
    const dedupe = await recordShippoWebhookEvent({
      eventKey: fp.eventKey,
      eventType,
      shippoObjectId: fp.shippoObjectId,
      payload: body,
    });
    if (!dedupe.inserted) {
      res.status(200).json({ ok: true, duplicate: true });
      return;
    }

    let result = { ok: true, ignored: true };
    if (eventType === "transaction_created" || eventType === "transaction_updated") {
      result = await handleTransactionEvent(data);
    } else if (eventType === "track_updated") {
      result = await handleTrackingEvent(data);
    } else {
      result = { ok: true, ignored: true, reason: "unsupported_event_type" };
    }

    console.info("[shippo webhook] processed", {
      eventType,
      eventKey: fp.eventKey,
      ...result,
    });
    res.status(200).json({ ok: true, ...result });
  } catch (error) {
    console.error("[shippo webhook] failed", error);
    res.status(500).json({ error: "Shippo webhook handling failed." });
  }
}
