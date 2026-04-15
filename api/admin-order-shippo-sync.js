import { getOrderByIdForService } from "../lib/orders.js";
import { assertReportsAuthorized } from "../lib/reports-auth.js";
import { syncWebsiteOrderToShippo } from "../lib/shippo-order-sync.js";

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
    if (order.shippo_order_id) {
      res.status(200).json({ ok: true, skipped: true, reason: "already_synced" });
      return;
    }

    const result = await syncWebsiteOrderToShippo(order.id);
    const refreshed = await getOrderByIdForService(order.id);

    if (!result.ok && !result.skipped) {
      res.status(502).json({
        error: result.error || "Shippo sync failed.",
        order: refreshed,
      });
      return;
    }

    res.status(200).json({
      ok: true,
      ...result,
      order: refreshed,
    });
  } catch (error) {
    console.error(error);
    res.status(error.statusCode || 500).json({
      error: error.message || "Could not sync order to Shippo.",
    });
  }
}
