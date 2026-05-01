import { markWalkInOrderPaid } from "../lib/orders.js";
import { assertReportsAuthorized } from "../lib/reports-auth.js";
import { sendPaidOrderReceiptResendIfConfigured } from "../lib/send-paid-order-receipt-resend.js";

// Future seam: `card_present` reserved for Terminal/device flow (not exposed in current UI).
const WALK_IN_PAYMENT_METHODS = new Set(["cash", "check", "card_present"]);

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
    if (!WALK_IN_PAYMENT_METHODS.has(paymentMethod)) {
      res.status(400).json({ error: "paymentMethod is invalid." });
      return;
    }
    // Keep current walk-in POS flow to cash/check only until Terminal/card-present is implemented.
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
      ...(order.inventoryWarning ? { inventoryWarning: String(order.inventoryWarning) } : {}),
      receiptEmailAttempted: sendReceipt,
      receiptEmailSent: receipt.sent === true,
      receiptEmailReason: receipt.reason || null,
    });
  } catch (error) {
    console.error(error);
    res.status(error.statusCode || 500).json({ error: error.message || "Could not mark order paid." });
  }
}
