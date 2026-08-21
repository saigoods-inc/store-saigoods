import { cancelPaidOrder } from "../lib/order-cancellation.js";
import { assertReportsAuthorized, getReportsActor } from "../lib/reports-auth.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed." });
  try {
    await assertReportsAuthorized(req);
    const actor = await getReportsActor(req);
    const result = await cancelPaidOrder({
      orderId: String(req.body?.orderId || "").trim(),
      reason: String(req.body?.reason || "").trim(),
      actor: actor?.email || actor?.id || actor?.kind || "admin",
    });
    return res.status(200).json(result);
  } catch (error) {
    console.error("[order-cancel]", { code: error.code || "unknown", message: error.message });
    return res.status(error.statusCode || 500).json({ error: error.message || "Could not cancel the order.", code: error.code || null });
  }
}
