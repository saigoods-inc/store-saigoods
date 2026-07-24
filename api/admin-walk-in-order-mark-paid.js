import { markWalkInOrderPaid } from "../lib/orders.js";
import { assertReportsAuthorized, getReportsActor } from "../lib/reports-auth.js";
import { sendPaidOrderReceiptResendIfConfigured } from "../lib/send-paid-order-receipt-resend.js";

const WALK_IN_PAYMENT_METHODS = new Set(["cash", "check"]);

function sanitizePublicError(error) {
  const status = error?.statusCode || 500;
  const msg = String(error?.message || "").trim();
  if (status >= 500) {
    return "Could not complete walk-in order.";
  }
  return msg || "Could not complete walk-in order.";
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed." });
    return;
  }

  try {
    await assertReportsAuthorized(req);
    const actor = await getReportsActor(req);
    const orderId = String(req.body?.orderId ?? "").trim();
    const paymentMethod = String(req.body?.paymentMethod ?? "").trim().toLowerCase();
    const sendReceipt = req.body?.sendReceipt === true;

    if (!orderId) {
      res.status(400).json({ error: "orderId is required." });
      return;
    }
    if (!WALK_IN_PAYMENT_METHODS.has(paymentMethod)) {
      res.status(400).json({ error: "paymentMethod must be cash or check." });
      return;
    }

    const order = await markWalkInOrderPaid({
      orderId,
      paymentMethod,
      actorEmail: actor?.email || null,
    });

    const idempotent = order?.idempotent === true;
    let receipt = { sent: false, reason: "skipped" };
    if (sendReceipt && !idempotent) {
      receipt = await sendPaidOrderReceiptResendIfConfigured(order);
    } else if (sendReceipt && idempotent) {
      receipt = { sent: false, reason: "already_completed" };
    }

    res.status(200).json({
      ok: true,
      orderId: order.id,
      orderRef: order.order_ref,
      paymentMethod: order.payment_method,
      status: order.status,
      orderStatus: order.order_status,
      paidAt: order.paid_at || null,
      adminHandoffAt: order.admin_handoff_at || null,
      inventoryCommitted: order.inventoryCommitted === true || Boolean(order.inventory_committed_at),
      inventoryCommittedAt: order.inventory_committed_at || null,
      completed: true,
      idempotent,
      receiptEmailAttempted: sendReceipt === true && !idempotent,
      receiptEmailSent: receipt.sent === true,
      receiptEmailReason: receipt.reason || null,
      ...(receipt.sent !== true && sendReceipt && !idempotent
        ? { receiptWarning: "Order completed, but the receipt email could not be sent." }
        : {}),
    });
  } catch (error) {
    console.error(error);
    res.status(error.statusCode || 500).json({ error: sanitizePublicError(error) });
  }
}
