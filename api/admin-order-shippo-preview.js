import { assertReportsAuthorized } from "../lib/reports-auth.js";
import { getOrderByIdForService } from "../lib/orders.js";
import { describeShippoOrderSync } from "../lib/shippo-order-sync.js";

/**
 * Returns the same merge + payload preview the server uses for Shippo POST /orders/
 * (no API call to Shippo).
 */
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

    const preview = describeShippoOrderSync(order);
    res.status(200).json({ ok: true, order, preview });
  } catch (error) {
    console.error(error);
    res.status(error.statusCode || 500).json({
      error: error.message || "Could not build Shippo preview.",
    });
  }
}
