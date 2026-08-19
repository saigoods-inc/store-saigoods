import { assertReportsAuthorized } from "../lib/reports-auth.js";
import { getOrderByIdForService } from "../lib/orders.js";
import { getWarehouseShipFromLines } from "../lib/warehouse-address.js";
import { withRuntimeWarehouseAddress } from "../lib/warehouse-settings.js";

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
    let order = await getOrderByIdForService(orderId);
    if (!order) {
      res.status(404).json({ error: "Order not found." });
      return;
    }
    order = await withRuntimeWarehouseAddress(order);
    const lines = getWarehouseShipFromLines(order);
    res.status(200).json({
      ok: true,
      lines,
      formatted: lines.join("\n"),
    });
  } catch (error) {
    console.error(error);
    res.status(error.statusCode || 500).json({
      error: error.message || "Could not load ship-from address.",
    });
  }
}
