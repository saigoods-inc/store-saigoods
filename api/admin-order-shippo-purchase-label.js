import { getOrderByIdForService, updateOrderShippoShipmentState } from "../lib/orders.js";
import { assertReportsAuthorized } from "../lib/reports-auth.js";
import { purchaseShippoLabelWithRate } from "../lib/shippo-transaction.js";

function carrierServiceFromRateLike(rateObj) {
  if (!rateObj || typeof rateObj !== "object") {
    return { carrier: null, service: null };
  }
  return {
    carrier: String(rateObj.provider_name || rateObj.provider || "").trim() || null,
    service: String(rateObj.servicelevel?.name || rateObj.servicelevel_name || rateObj.servicelevel_token || "").trim() || null,
  };
}

function findStoredRateMeta(orderRow, rateObjectId) {
  const raw = orderRow?.shippo_shipment_rates_json;
  let list = [];
  if (Array.isArray(raw)) {
    list = raw;
  } else if (raw && typeof raw === "object" && Array.isArray(raw.rates)) {
    list = raw.rates;
  }
  const id = String(rateObjectId || "").trim();
  return list.find((r) => r && String(r.object_id || "").trim() === id) || null;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed." });
    return;
  }

  try {
    await assertReportsAuthorized(req);
    const orderId = String(req.body?.orderId || "").trim();
    const rateObjectId = String(req.body?.rateObjectId || "").trim();
    if (!orderId) {
      res.status(400).json({ error: "orderId is required." });
      return;
    }
    if (!rateObjectId) {
      res.status(400).json({ error: "rateObjectId is required (Shippo Rate object_id)." });
      return;
    }

    const order = await getOrderByIdForService(orderId);
    if (!order) {
      res.status(404).json({ error: "Order not found." });
      return;
    }
    if (String(order.status || "").toLowerCase() !== "paid") {
      res.status(400).json({ error: "Only paid orders can purchase labels." });
      return;
    }
    if (!String(order.shippo_order_id || "").trim()) {
      res.status(400).json({ error: "Sync the order to Shippo first." });
      return;
    }
    if (!String(order.shippo_shipment_object_id || "").trim()) {
      res.status(400).json({ error: "Create or refresh the Shippo shipment first (sync includes this)." });
      return;
    }

    const labelUrl = String(order.shippo_label_url || "").trim();
    const txStatus = String(order.shippo_transaction_status || "").toUpperCase();
    if (labelUrl && txStatus === "SUCCESS") {
      res.status(400).json({
        error:
          "A label was already purchased for this order. Void or refund the existing Shippo transaction in the Shippo dashboard if you need a different label, then clear label fields in the database or use a new order.",
      });
      return;
    }

    await updateOrderShippoShipmentState(order.id, {
      shippo_label_sync_error: null,
    });

    let purchased;
    try {
      purchased = await purchaseShippoLabelWithRate(rateObjectId, {});
    } catch (e) {
      const msg = String(e?.message || "Label purchase failed.");
      await updateOrderShippoShipmentState(order.id, {
        shippo_label_sync_error: msg.slice(0, 4000),
      });
      res.status(502).json({
        error: msg,
        shippoResponseJson: e?.shippoResponseJson ?? null,
        order: await getOrderByIdForService(order.id),
      });
      return;
    }

    const fromTx = carrierServiceFromRateLike(purchased.rate);
    const fromStored = findStoredRateMeta(order, rateObjectId);
    const fromStoredCs = carrierServiceFromRateLike(fromStored);
    const carrier = fromTx.carrier || fromStoredCs.carrier || fromStored?.provider || null;
    const service = fromTx.service || fromStoredCs.service || fromStored?.servicelevel_name || null;

    const nowIso = new Date().toISOString();
    await updateOrderShippoShipmentState(order.id, {
      shippo_selected_rate_object_id: rateObjectId,
      shippo_transaction_id: purchased.transactionObjectId || null,
      shippo_transaction_status: purchased.transactionStatus || "SUCCESS",
      shippo_label_url: purchased.labelUrl,
      shippo_label_carrier: carrier,
      shippo_label_service: service,
      shippo_tracking_number: purchased.trackingNumber,
      shippo_tracking_status: purchased.trackingStatus,
      shippo_tracking_url_provider: purchased.trackingUrlProvider,
      shippo_label_purchased_at: nowIso,
      shippo_label_sync_error: null,
    });

    const refreshed = await getOrderByIdForService(order.id);
    res.status(200).json({
      ok: true,
      purchase: purchased,
      order: refreshed,
    });
  } catch (error) {
    console.error(error);
    res.status(error.statusCode || 500).json({
      error: error.message || "Could not purchase label.",
    });
  }
}
