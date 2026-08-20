import { reconcileCancelledOrder } from "../lib/order-cancellation-status.js";
import { assertReportsAuthorized } from "../lib/reports-auth.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed." });
  try {
    await assertReportsAuthorized(req);
    const result = await reconcileCancelledOrder(String(req.body?.orderId || "").trim());
    return res.status(200).json(result);
  } catch (error) {
    console.error("[order-cancel-status]", { code: error.code || "unknown", message: error.message });
    return res.status(error.statusCode || 500).json({ error: error.message || "Could not check refund status.", code: error.code || null });
  }
}
