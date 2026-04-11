import { Resend } from "resend";
import { buildPaidOrderReceiptHtml } from "./order-receipt-email-html.js";

/**
 * Resend expects `email@domain.com` or `Display Name <email@domain.com>`.
 * .env lines like RESEND_FROM="Name <x@y.com>" often keep literal quote characters — strip them.
 */
export function normalizeResendFrom(raw) {
  let s = String(raw ?? "")
    .replace(/[\u201C\u201D\u201E]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1).trim();
  }
  return s.trim();
}

/** @deprecated Use {@link buildPaidOrderReceiptHtml}; kept for scripts and callers that import this name. */
export function buildOrderConfirmationHtml(args) {
  return buildPaidOrderReceiptHtml(args);
}

/**
 * Sends the post-payment receipt email via Resend (non-blocking callers should `.catch`).
 * Requires RESEND_API_KEY and RESEND_FROM (verified domain in Resend).
 * `pending` may include `shipping_address` (object) and/or `customer_address` (formatted string) for the receipt.
 */
export async function sendResendOrderConfirmation({ pending, quote, customerEmail, customerName }) {
  const key = process.env.RESEND_API_KEY?.trim();
  const from = normalizeResendFrom(process.env.RESEND_FROM);
  if (!key || !from || !customerEmail?.trim()) {
    return;
  }

  const html = buildPaidOrderReceiptHtml({ pending, quote, customerName });
  const resend = new Resend(key);
  const subjectLabel = pending?.order_ref || "SAI Goods";

  const { error } = await resend.emails.send({
    from,
    to: [customerEmail.trim()],
    subject: `Receipt — ${subjectLabel}`,
    html,
  });

  if (error) {
    console.error("Resend order receipt failed:", error);
  }
}

/** True when customer post-payment email is handled by Resend (webhook should not SendGrid duplicate). */
export function isResendCustomerEmailEnabled() {
  return Boolean(process.env.RESEND_API_KEY?.trim() && normalizeResendFrom(process.env.RESEND_FROM));
}
