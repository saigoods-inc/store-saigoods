import { sendOrderCancellationEmail } from "./order-cancellation-email.js";
import { getOrderByIdForService } from "./orders.js";
import { getSquarePayment } from "./square-cancellation.js";

function normalized(value) {
  return String(value || "").trim().toLowerCase();
}

export function cancellationEmailSquareResult(order, payment) {
  const paymentStatus = String(payment?.status || "").toUpperCase();
  if (paymentStatus === "CANCELED") return { action: "void", status: "CANCELED" };

  const totalCents = Math.max(0, Math.round(Number(order?.total_cents) || 0));
  const refundedCents = Math.max(0, Math.round(Number(payment?.refunded_money?.amount) || 0));
  if (normalized(order?.status) === "refunded" || (totalCents > 0 && refundedCents >= totalCents)) {
    return { action: "refund", status: "COMPLETED" };
  }
  return { action: "refund", status: "PENDING" };
}

/** Send a cancellation/refund status email without changing payment, shipping, order, or inventory state. */
export async function sendCancelledOrderRefundEmail({ orderId, requestId }, dependencies = {}) {
  const loadOrder = dependencies.loadOrder || getOrderByIdForService;
  const getPayment = dependencies.getPayment || getSquarePayment;
  const sendEmail = dependencies.sendEmail || sendOrderCancellationEmail;

  const cleanRequestId = String(requestId || "").trim();
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(cleanRequestId)) {
    throw Object.assign(new Error("A valid email request ID is required."), { statusCode: 400 });
  }

  const order = await loadOrder(orderId);
  if (!order) throw Object.assign(new Error("Order not found."), { statusCode: 404 });
  if (normalized(order.order_status) !== "cancelled") {
    throw Object.assign(new Error("Refund emails can only be sent for cancelled orders."), { statusCode: 409 });
  }
  if (!String(order.customer_email || "").trim()) {
    throw Object.assign(new Error("This order does not have a customer email address."), { statusCode: 409 });
  }

  let payment = null;
  const paymentId = String(order.payment_id || "").trim();
  if (paymentId) {
    try {
      payment = await getPayment(paymentId);
    } catch {
      // The stored order status still produces a truthful pending/completed message.
    }
  }

  const squareResult = cancellationEmailSquareResult(order, payment);
  const email = await sendEmail(order, squareResult, {
    idempotencyKey: `order-cancelled-resend/${String(order.id)}/${cleanRequestId}`,
  });
  if (!email?.sent) {
    throw Object.assign(new Error(
      email?.reason === "not_configured"
        ? "Cancellation email is not configured."
        : "Cancellation email could not be sent.",
    ), { statusCode: email?.reason === "not_configured" ? 503 : 409 });
  }

  return { ok: true, order, email, square: squareResult };
}
