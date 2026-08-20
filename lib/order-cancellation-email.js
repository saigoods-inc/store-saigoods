import { Resend } from "resend";
import { normalizeResendFrom } from "./resend-order-confirmation.js";

export async function sendOrderCancellationEmail(order, squareResult) {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = normalizeResendFrom(process.env.RESEND_FROM);
  const to = String(order?.customer_email || "").trim();
  if (!apiKey || !from || !to) return { sent: false, reason: to ? "not_configured" : "missing_customer_email" };
  const total = (Math.max(0, Number(order.total_cents) || 0) / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
  const reference = String(order.order_ref || order.id || "your order");
  const pending = String(squareResult?.status || "").toUpperCase() === "PENDING";
  const resend = new Resend(apiKey);
  const { error } = await resend.emails.send({
    from,
    to: [to],
    subject: `Order cancelled — ${reference}`,
    text: `Your SAI Goods order ${reference} has been cancelled. ${pending ? `Your ${total} refund was submitted to Square and is processing.` : `A ${total} refund has been issued.`} Your bank may take several business days to post the credit.`,
  }, { idempotencyKey: `order-cancelled/${String(order.payment_id || order.id)}`.slice(0, 256) });
  if (error) throw new Error(error.message || "Cancellation email failed.");
  return { sent: true };
}
