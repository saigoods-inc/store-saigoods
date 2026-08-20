import { getOrderByIdForService, resetExpiredManualPaymentLink } from "../lib/orders.js";
import { assertReportsAuthorized } from "../lib/reports-auth.js";
import { deletePaymentLink } from "../lib/square.js";

export function isExpiredManualOrderPaymentLink(order, nowMs = Date.now()) {
  if (String(order?.payment_link_status || "").trim().toLowerCase() === "expired") return true;
  const expiresAt = new Date(order?.payment_link_expires_at || 0).getTime();
  return Number.isFinite(expiresAt) && expiresAt > 0 && expiresAt <= nowMs;
}

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
    if (String(order.order_source || "") !== "manual") {
      res.status(400).json({ error: "Only manual orders can be edited here." });
      return;
    }
    if (String(order.payment_flow || "square_payment_link") !== "square_payment_link") {
      res.status(400).json({ error: "Only Square payment-link orders can use this edit flow." });
      return;
    }
    if (String(order.status || "") === "paid") {
      res.status(400).json({ error: "Paid orders cannot be edited." });
      return;
    }

    if (String(order.order_status || "") === "payment_link_sent") {
      if (!isExpiredManualOrderPaymentLink(order)) {
        res.status(400).json({ error: "The current payment link is still active. Wait for it to expire before editing this order." });
        return;
      }
      const paymentLinkId = String(order.payment_link_id || "").trim();
      if (paymentLinkId) await deletePaymentLink(paymentLinkId);
      order = await resetExpiredManualPaymentLink(order.id);
    }

    if (!order || String(order.order_status || "") !== "draft" || !isExpiredManualOrderPaymentLink(order)) {
      res.status(400).json({ error: "Only an unpaid order with an expired payment link can be edited." });
      return;
    }

    res.status(200).json({ order });
  } catch (error) {
    console.error(error);
    res.status(error.statusCode || 500).json({ error: error.message || "Could not prepare this order for editing." });
  }
}
