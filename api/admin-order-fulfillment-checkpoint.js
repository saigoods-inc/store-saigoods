import { assertReportsAuthorized } from "../lib/reports-auth.js";
import { getOrderByIdForService, updateAdminFulfillmentCheckpoint } from "../lib/orders.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed." });
    return;
  }
  try {
    await assertReportsAuthorized(req);
    const orderId = String(req.body?.orderId || "").trim();
    const checkpoint = String(req.body?.checkpoint || "").trim();
    if (!orderId) {
      res.status(400).json({ error: "orderId is required." });
      return;
    }
    const updated = await updateAdminFulfillmentCheckpoint(orderId, checkpoint);
    res.status(200).json({ ok: true, order: updated });
  } catch (error) {
    console.error(error);
    res.status(error.statusCode || 500).json({
      error: error.message || "Could not update checkpoint.",
    });
  }
}
