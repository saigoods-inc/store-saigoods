import { Resend } from "resend";
import { MANUAL_PAYMENT_LINK_VALID_MS } from "./manual-payment-link-access.js";
import { buildPaymentLinkOrderDetailsSectionHtml } from "./payment-link-email-order-details.js";
import { normalizeResendFrom } from "./resend-order-confirmation.js";

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function buildManualPaymentLinkHtml({
  customerName,
  orderRef,
  totalFormatted,
  checkoutUrl,
  orderDetailsHtml = "",
}) {
  const name = (customerName || "").trim() || "there";
  const ref = escapeHtml(orderRef || "your order");
  const total = escapeHtml(totalFormatted || "—");
  const url = escapeHtml(checkoutUrl);
  const details = orderDetailsHtml || "";
  const validHours = Math.round(MANUAL_PAYMENT_LINK_VALID_MS / (60 * 60 * 1000));

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Your SAI Goods order is ready — SAI Goods, Inc.</title>
</head>
<body style="margin:0;padding:0;background:#f6f1ed;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f6f1ed;padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" style="max-width:560px;background:#ffffff;border-radius:8px;border:1px solid #eadfd8;box-shadow:0 1px 3px rgba(43,41,39,.08);overflow:hidden;">
          <tr>
            <td style="padding:28px 28px 24px;background:#fffaf7;border-bottom:1px solid #eadfd8;">
              <p style="margin:0 0 14px;font-size:13px;line-height:18px;font-weight:800;color:#cf5849;">SAI Goods, Inc.</p>
              <h1 style="margin:0;font-size:26px;line-height:32px;font-weight:800;color:#2b2927;">Your order is ready</h1>
            </td>
          </tr>
          <tr>
            <td style="padding:28px;">
              <p style="margin:0 0 16px;font-size:16px;color:#2b2927;line-height:1.5;">Hi ${escapeHtml(name)},</p>
              <p style="margin:0 0 22px;font-size:16px;color:#5f5650;line-height:1.6;">
                Thank you for your order. You can review and pay securely for <strong style="color:#2b2927;">${ref}</strong>
                using the link below.
              </p>
              <div style="margin:0 0 22px;padding:16px;background:#fbf8f6;border-radius:8px;border:1px solid #eadfd8;">
                <p style="margin:0 0 6px;font-size:12px;line-height:16px;font-weight:700;color:#8b817b;text-transform:uppercase;">Total due</p>
                <p style="margin:0;font-size:24px;line-height:30px;font-weight:800;color:#2b2927;">${total}</p>
              </div>
              ${details}
              <p style="margin:0 0 24px;font-size:16px;color:#5f5650;line-height:1.6;">
                Use the button below to open Square checkout. We will send a confirmation once everything is processed.
              </p>
              <p style="margin:0 0 28px;text-align:center;">
                <a href="${url}" style="display:inline-block;background:#cf5849;color:#ffffff;text-decoration:none;padding:12px 28px;border-radius:999px;font-size:16px;font-weight:800;">
                  Pay now
                </a>
              </p>
              <p style="margin:0 0 18px;padding:12px 14px;border-radius:8px;background:#fffaf7;color:#5f5650;font-size:13px;line-height:1.55;">
                This secure payment link is available for up to <strong style="color:#2b2927;">${validHours} hours</strong> from when it was first issued. If it expires, contact SAI Goods for a new link.
              </p>
              <p style="margin:0;font-size:13px;color:#8b817b;line-height:1.5;">
                If the button does not open, copy and paste this secure payment link into your browser:<br />
                <a href="${url}" style="word-break:break-all;color:#cf5849;">${url}</a>
              </p>
            </td>
          </tr>
        </table>
        <p style="margin:22px 0 0;font-size:12px;color:#8b817b;">Questions about this order? Email <a href="mailto:sales@saigoods.com" style="color:#cf5849;">sales@saigoods.com</a>.</p>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

export function buildManualPaymentLinkEmailAttachments(invoiceAttachment) {
  if (!invoiceAttachment) return undefined;
  return [{
    filename: invoiceAttachment.filename,
    content: invoiceAttachment.content,
    contentType: "application/pdf",
  }];
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
  quote,
  shippingAddress,
  invoiceAttachment,
}) {
  const key = process.env.RESEND_API_KEY?.trim();
  const from = normalizeResendFrom(process.env.RESEND_FROM);
  const to = String(customerEmail || "").trim();
  if (!key || !from || !to || !checkoutUrl) {
    return false;
  }

  const orderDetailsHtml =
    quote && typeof quote === "object"
      ? buildPaymentLinkOrderDetailsSectionHtml(quote, shippingAddress)
      : "";

  const html = buildManualPaymentLinkHtml({
    customerName,
    orderRef,
    totalFormatted,
    checkoutUrl,
    orderDetailsHtml,
  });
  const resend = new Resend(key);
  const refLabel = orderRef || "SAI Goods order";

  const attachments = buildManualPaymentLinkEmailAttachments(invoiceAttachment);

  const { error } = await resend.emails.send({
    from,
    to: [to],
    subject: `Your SAI Goods order is ready — ${refLabel}`,
    html,
    attachments,
  });

  if (error) {
    console.error("[manual-order] Resend payment link email failed:", error);
    return false;
  }

  return true;
}
