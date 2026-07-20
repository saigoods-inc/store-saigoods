import { assertReportsAuthorized } from "../lib/reports-auth.js";
import { sendAdminShippingNotifyEmail } from "../lib/admin-shipping-notify-email.js";
import { resolveBuyerShippingNotifyForOrder } from "../lib/admin-shipping-notify-resolve.js";
import { getOrderByIdForService, markAdminBuyerShippingNotifySent } from "../lib/orders.js";

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
    if (String(order.order_status || "") === "cancelled") {
      res.status(400).json({ error: "Cancelled orders cannot receive shipping notifications." });
      return;
    }
    if (!String(order.customer_email || "").trim()) {
      res.status(400).json({ error: "Order has no customer email." });
      return;
    }

    const fulfillment = await resolveBuyerShippingNotifyForOrder(order);
    if (!fulfillment.ok) {
      const msg =
        fulfillment.error ||
        "A complete label or tracking record is required before sending a buyer notification.";
      res.status(400).json({ error: msg });
      return;
    }
    if (!fulfillment.trackings?.length) {
      res.status(400).json({
        error: "Tracking number is required before sending a buyer notification.",
      });
      return;
    }

    const result = await sendAdminShippingNotifyEmail(order, fulfillment);
    if (!result.sent) {
      res.status(503).json({
        error:
          result.reason === "missing_customer_email"
            ? "Order has no customer email."
            : result.reason === "missing_tracking"
              ? "Tracking number is required before sending a buyer notification."
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
