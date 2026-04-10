import { Resend } from "resend";
import { normalizeResendFrom } from "./resend-order-confirmation.js";

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function buildManualPaymentLinkHtml({ customerName, orderRef, totalFormatted, checkoutUrl }) {
  const name = (customerName || "").trim() || "there";
  const ref = escapeHtml(orderRef || "your order");
  const total = escapeHtml(totalFormatted || "—");
  const url = escapeHtml(checkoutUrl);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Complete your payment — SAI Goods</title>
</head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f4f4f5;padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" style="max-width:520px;background:#fff;border-radius:12px;padding:32px 28px;box-shadow:0 1px 3px rgba(0,0,0,.08);">
          <tr>
            <td>
              <p style="margin:0 0 16px;font-size:16px;color:#18181b;line-height:1.5;">Hi ${escapeHtml(name)},</p>
              <p style="margin:0 0 16px;font-size:16px;color:#3f3f46;line-height:1.6;">
                Thank you for your order with <strong>SAI Goods</strong>. Your order reference is
                <strong>${ref}</strong>. The total due is <strong>${total}</strong>.
              </p>
              <p style="margin:0 0 24px;font-size:16px;color:#3f3f46;line-height:1.6;">
                Please complete payment securely using the link below. You will receive a confirmation once your payment is processed.
              </p>
              <p style="margin:0 0 28px;text-align:center;">
                <a href="${url}" style="display:inline-block;background:#18181b;color:#fff;text-decoration:none;padding:14px 28px;border-radius:8px;font-size:16px;font-weight:600;">
                  Pay now
                </a>
              </p>
              <p style="margin:0;font-size:13px;color:#71717a;line-height:1.5;">
                If the button does not work, copy and paste this URL into your browser:<br />
                <span style="word-break:break-all;color:#3f3f46;">${url}</span>
              </p>
            </td>
          </tr>
        </table>
        <p style="margin:24px 0 0;font-size:12px;color:#a1a1aa;">SAI Goods · Questions? Reply to this email or contact us at sales@saigoods.com</p>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/**
 * @returns {Promise<boolean>} true if send attempted (check Resend logs for delivery)
 */
export async function sendManualOrderPaymentLinkEmail({
  customerEmail,
  customerName,
  orderRef,
  totalFormatted,
  checkoutUrl,
}) {
  const key = process.env.RESEND_API_KEY?.trim();
  const from = normalizeResendFrom(process.env.RESEND_FROM);
  const to = String(customerEmail || "").trim();
  if (!key || !from || !to || !checkoutUrl) {
    return false;
  }

  const html = buildManualPaymentLinkHtml({
    customerName,
    orderRef,
    totalFormatted,
    checkoutUrl,
  });
  const resend = new Resend(key);
  const refLabel = orderRef || "SAI Goods order";

  const { error } = await resend.emails.send({
    from,
    to: [to],
    subject: `Complete your payment — ${refLabel}`,
    html,
  });

  if (error) {
    console.error("[manual-order] Resend payment link email failed:", error);
    return false;
  }

  return true;
}
