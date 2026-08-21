import { sendCancelledOrderRefundEmail } from "../lib/admin-order-cancellation-email.js";
import { assertReportsAuthorized } from "../lib/reports-auth.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed." });
  try {
    await assertReportsAuthorized(req);
    const result = await sendCancelledOrderRefundEmail({
      orderId: String(req.body?.orderId || "").trim(),
      requestId: String(req.body?.requestId || "").trim(),
    });
    return res.status(200).json(result);
  } catch (error) {
    console.error("[order-cancellation-email]", { code: error.code || "unknown", message: error.message });
    return res.status(error.statusCode || 500).json({
      error: error.message || "Could not send the refund email.",
      code: error.code || null,
    });
  }
}
