import { assertReportsAuthorized } from "../lib/reports-auth.js";
import { sendAdminShippingNotifyEmail } from "../lib/admin-shipping-notify-email.js";
import { getOrderByIdForService, markAdminBuyerShippingNotifySent } from "../lib/orders.js";
import { resolveBuyerShippingNotifyForOrder } from "../lib/admin-shipping-notify-resolve.js";

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
    const fulfillment = await resolveBuyerShippingNotifyForOrder(order);
    if (!fulfillment.ok) {
      res.status(400).json({ error: fulfillment.error || "Purchase a label before notifying the buyer.", order });
      return;
    }

    const result = await sendAdminShippingNotifyEmail(order, fulfillment);
    if (!result.sent) {
      res.status(503).json({
        error:
          result.reason === "missing_customer_email"
            ? "Order has no customer email."
            : "Email is not configured (set RESEND_API_KEY and RESEND_FROM) or sending failed.",
        reason: result.reason,
        order,
      });
      return;
    }

    const updated = await markAdminBuyerShippingNotifySent(orderId);
    res.status(200).json({ ok: true, order: updated || order });
  } catch (error) {
    console.error(error);
    res.status(error.statusCode || 500).json({
      error: error.message || "Could not send notification.",
    });
  }
}
