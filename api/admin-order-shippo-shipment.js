import { assertReportsAuthorized } from "../lib/reports-auth.js";
import { getOrderByIdForService } from "../lib/orders.js";
import { createShippoShipmentForWebsiteOrder } from "../lib/shippo-shipment-sync.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed." });
    return;
  }

  try {
    await assertReportsAuthorized(req);
    const orderId = String(req.body?.orderId || "").trim();
    const force = req.body?.force === true;
    if (!orderId) {
      res.status(400).json({ error: "orderId is required." });
      return;
    }

    const order = await getOrderByIdForService(orderId);
    if (!order) {
      res.status(404).json({ error: "Order not found." });
      return;
    }
    if (!order.shippo_order_id) {
      res.status(400).json({ error: "Order is not linked to a Shippo Order yet. Sync the order first." });
      return;
    }

    const result = await createShippoShipmentForWebsiteOrder(order, { force });
    const refreshed = await getOrderByIdForService(orderId);
    res.status(200).json({ ok: true, result, order: refreshed });
  } catch (error) {
    console.error(error);
    res.status(error.statusCode || 500).json({
      error: error.message || "Could not create Shippo shipment.",
    });
  }
}
