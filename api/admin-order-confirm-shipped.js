import { resolveBuyerShippingNotifyForOrder } from "../lib/admin-shipping-notify-resolve.js";
import { sendAdminShippingNotifyEmail } from "../lib/admin-shipping-notify-email.js";
import {
  getOrderByIdForService,
  markAdminBuyerShippingNotifySent,
  markAdminOrderHandoffShipped,
} from "../lib/orders.js";
import { assertReportsAuthorized } from "../lib/reports-auth.js";

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

    const marked = await markAdminOrderHandoffShipped(orderId);
    const fresh = (await getOrderByIdForService(orderId)) || marked;
    const fulfillment = await resolveBuyerShippingNotifyForOrder(fresh);
    if (!fulfillment.ok) {
      res.status(200).json({
        ok: true,
        notified: false,
        warning: fulfillment.error || "Order was marked shipped, but buyer notification could not be sent.",
        order: fresh,
      });
      return;
    }

    const result = await sendAdminShippingNotifyEmail(fresh, fulfillment);
    if (!result.sent) {
      res.status(200).json({
        ok: true,
        notified: false,
        warning:
          result.reason === "missing_customer_email"
            ? "Order was marked shipped, but it has no customer email."
            : "Order was marked shipped, but email is not configured or sending failed.",
        reason: result.reason,
        order: fresh,
      });
      return;
    }

    const updated = await markAdminBuyerShippingNotifySent(orderId);
    res.status(200).json({ ok: true, notified: true, order: updated || fresh });
  } catch (error) {
    console.error(error);
    res.status(error.statusCode || 500).json({
      error: error.message || "Could not confirm shipment.",
    });
  }
}
