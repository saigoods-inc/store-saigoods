import { markWalkInOrderPaid } from "../lib/orders.js";
import { assertReportsAuthorized } from "../lib/reports-auth.js";
import { sendPaidOrderReceiptResendIfConfigured } from "../lib/send-paid-order-receipt-resend.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed." });
    return;
  }

  try {
    await assertReportsAuthorized(req);
    const orderId = String(req.body?.orderId ?? "").trim();
    const paymentMethod = String(req.body?.paymentMethod ?? "").trim().toLowerCase();
    const sendReceipt = req.body?.sendReceipt === true;

    if (!orderId) {
      res.status(400).json({ error: "orderId is required." });
      return;
    }
    if (paymentMethod !== "cash" && paymentMethod !== "check") {
      res.status(400).json({ error: "paymentMethod must be cash or check." });
      return;
    }

    const order = await markWalkInOrderPaid({ orderId, paymentMethod });

    let receipt = { sent: false, reason: "skipped" };
    if (sendReceipt) {
      receipt = await sendPaidOrderReceiptResendIfConfigured(order);
    }

    res.status(200).json({
      ok: true,
      orderId: order.id,
      orderRef: order.order_ref,
      paymentMethod: order.payment_method,
      receiptEmailAttempted: sendReceipt,
      receiptEmailSent: receipt.sent === true,
      receiptEmailReason: receipt.reason || null,
    });
  } catch (error) {
    console.error(error);
    res.status(error.statusCode || 500).json({ error: error.message || "Could not mark order paid." });
  }
}
