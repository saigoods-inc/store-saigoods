import { getOrderByIdForService } from "../lib/orders.js";
import { assertReportsAuthorized } from "../lib/reports-auth.js";
import { syncWebsiteOrderToShippo } from "../lib/shippo-order-sync.js";
import { createShippoShipmentForWebsiteOrder } from "../lib/shippo-shipment-sync.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed." });
    return;
  }

  try {
    await assertReportsAuthorized(req);
    const orderId = String(req.body?.orderId || "").trim();
    if (!orderId) {
      res.status(400).json({ error: "orderId is required." });
      return;
    }

    const order = await getOrderByIdForService(orderId);
    if (!order) {
      res.status(404).json({ error: "Order not found." });
      return;
    }
    if (String(order.status || "").toLowerCase() !== "paid") {
      res.status(400).json({ error: "Only paid orders can be synced to Shippo." });
      return;
    }

    const result = await syncWebsiteOrderToShippo(order.id, { skipAutoShipment: true });
    let refreshed = await getOrderByIdForService(order.id);

    if (!result.ok && !result.skipped) {
      res.status(502).json({
        error: result.error || "Shippo sync failed.",
        order: refreshed,
        shippo_last_error_response: refreshed?.shippo_last_error_response ?? null,
        shippo_last_attempt_payload: refreshed?.shippo_last_attempt_payload ?? null,
      });
      return;
    }

    if (!refreshed?.shippo_order_id) {
      res.status(502).json({
        error: "Shippo Order was not created; cannot build shipment.",
        order: refreshed,
        sync: result,
      });
      return;
    }

    let shipment = null;
    try {
      shipment = await createShippoShipmentForWebsiteOrder(refreshed, { force: true });
    } catch (e) {
      console.error("[admin] Shippo shipment refresh after sync", e);
      refreshed = await getOrderByIdForService(order.id);
      res.status(502).json({
        error: e?.message || "Shippo shipment could not be created or refreshed.",
        order: refreshed,
        sync: result,
        shipment: { ok: false, error: String(e?.message || e) },
      });
      return;
    }

    refreshed = await getOrderByIdForService(order.id);
    res.status(200).json({
      ok: true,
      ...result,
      shipment,
      order: refreshed,
    });
  } catch (error) {
    console.error(error);
    res.status(error.statusCode || 500).json({
      error: error.message || "Could not sync order to Shippo.",
    });
  }
}
