import { assertReportsAuthorized } from "../lib/reports-auth.js";
import { getOrderByIdForService, listWalkInDraftOrders } from "../lib/orders.js";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed." });
    return;
  }

  try {
    await assertReportsAuthorized(req);
    const rawUrl = req.url || "/api/admin-walk-in-order-drafts";
    const url = new URL(rawUrl, "http://localhost");
    const id = url.searchParams.get("id");

    if (id) {
      const order = await getOrderByIdForService(id);
      if (!order) {
        res.status(404).json({ error: "Order not found." });
        return;
      }
      if (String(order.order_source || "") !== "walk_in" || String(order.order_status || "") !== "draft") {
        res.status(400).json({ error: "Not a walk-in draft order." });
        return;
      }
      res.status(200).json({ order });
      return;
    }

    const drafts = await listWalkInDraftOrders();
    res.status(200).json({ drafts });
  } catch (error) {
    console.error(error);
    res.status(error.statusCode || 500).json({ error: error.message || "Could not load drafts." });
  }
}
