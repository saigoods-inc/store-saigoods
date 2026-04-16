import { getOrderByIdForService } from "../lib/orders.js";
import { assertReportsAuthorized } from "../lib/reports-auth.js";
import { refreshShippoStatusForWebsiteOrder } from "../lib/shippo-status-refresh.js";

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

    const result = await refreshShippoStatusForWebsiteOrder(order.id);
    const refreshed = await getOrderByIdForService(order.id);
    res.status(200).json({ ok: true, ...result, order: refreshed });
  } catch (error) {
    console.error(error);
    const code = error.statusCode || 500;
    res.status(code).json({
      error: error.message || "Could not refresh Shippo status.",
    });
  }
}
