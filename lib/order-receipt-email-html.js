import { formatShippingAddressForOrder } from "./checkout-totals.js";
import { buildPricingBreakdownTableHtml, buildProductLineItemsBlocksHtml } from "./payment-link-email-order-details.js";

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatOrderDate(iso) {
  try {
    const d = iso ? new Date(iso) : new Date();
    if (Number.isNaN(d.getTime())) {
      return new Intl.DateTimeFormat("en-US", { dateStyle: "long", timeStyle: "short" }).format(new Date());
    }
    return new Intl.DateTimeFormat("en-US", { dateStyle: "long", timeStyle: "short" }).format(d);
  } catch {
    return String(iso || "");
  }
}

/**
 * Full HTML document: post-payment receipt (Resend). Uses real `quote` and `pending` row fields only.
 * @param {{ customerName?: string, pending?: object, quote?: object }} args
 */
export function buildPaidOrderReceiptHtml({ customerName, pending, quote }) {
  const greet = (customerName || "").trim() || "there";
  const orderRef = String(pending?.order_ref || pending?.id || "").trim() || "—";
  const orderDate = formatOrderDate(pending?.created_at);
  const totalPaid = quote?.totalFormatted != null ? String(quote.totalFormatted) : "—";

  const shipObj = pending?.shipping_address && typeof pending.shipping_address === "object" ? pending.shipping_address : null;
  const fromStructured = formatShippingAddressForOrder(shipObj);
  const addrFallback = String(pending?.customer_address || "").trim();
  const shipDisplay = (fromStructured && String(fromStructured).trim()) || addrFallback || "";

  const lineItemsHtml = buildProductLineItemsBlocksHtml(quote || {});
  const productSection = lineItemsHtml
    ? `<div style="margin:22px 0 0;padding:18px 16px;background:#fafafa;border-radius:10px;border:1px solid #e4e4e7;">
        <p style="margin:0 0 12px;font-size:12px;font-weight:700;letter-spacing:0.04em;color:#52525b;text-transform:uppercase;">Order details</p>
        ${lineItemsHtml}
      </div>`
    : "";

  const pricingSection = `<div style="margin:18px 0 0;padding:18px 16px;background:#fafafa;border-radius:10px;border:1px solid #e4e4e7;">
      <p style="margin:0 0 12px;font-size:12px;font-weight:700;letter-spacing:0.04em;color:#52525b;text-transform:uppercase;">Pricing summary</p>
      ${buildPricingBreakdownTableHtml(quote || {}, { taxLabel: "Tax", totalLabel: "Total paid" })}
    </div>`;

  const shippingSection = shipDisplay
    ? `<div style="margin:18px 0 0;padding:18px 16px;background:#fafafa;border-radius:10px;border:1px solid #e4e4e7;">
        <p style="margin:0 0 8px;font-size:12px;font-weight:700;letter-spacing:0.04em;color:#52525b;text-transform:uppercase;">Shipping address</p>
        <p style="margin:0;font-size:14px;color:#27272a;line-height:1.55;white-space:pre-wrap;">${escapeHtml(shipDisplay)}</p>
      </div>`
    : "";

  const summaryRows = [
    ["Order reference", orderRef],
    ["Order date", orderDate],
    ["Total paid", totalPaid],
  ]
    .map(
      ([k, v]) => `<tr>
      <td style="padding:6px 12px 6px 0;font-size:14px;color:#52525b;vertical-align:top;">${escapeHtml(k)}</td>
      <td style="padding:6px 0;font-size:14px;font-weight:600;color:#18181b;text-align:right;vertical-align:top;">${escapeHtml(v)}</td>
    </tr>`,
    )
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Receipt — SAI Goods</title>
</head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f4f4f5;padding:28px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" style="max-width:560px;background:#fff;border-radius:12px;padding:32px 26px;box-shadow:0 1px 3px rgba(0,0,0,.08);">
          <tr>
            <td>
              <p style="margin:0 0 4px;font-size:13px;font-weight:700;letter-spacing:0.04em;color:#52525b;text-transform:uppercase;">Receipt / order confirmed</p>
              <h1 style="margin:0 0 6px;font-size:22px;font-weight:700;color:#BF5841;line-height:1.25;">Payment received — thank you for your order</h1>

              <p style="margin:0 0 14px;font-size:16px;color:#18181b;line-height:1.5;">Hi ${escapeHtml(greet)},</p>
              <p style="margin:0 0 22px;font-size:16px;color:#3f3f46;line-height:1.6;">
                Your payment went through successfully. The summary below matches what we charged; keep this email as your proof of payment.
              </p>

              <div style="margin:0;padding:18px 16px;background:#fafafa;border-radius:10px;border:1px solid #e4e4e7;">
                <p style="margin:0 0 12px;font-size:12px;font-weight:700;letter-spacing:0.04em;color:#52525b;text-transform:uppercase;">Order summary</p>
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;">
                  ${summaryRows}
                </table>
              </div>

              ${productSection}
              ${pricingSection}
              ${shippingSection}

              <p style="margin:28px 0 0;font-size:14px;color:#52525b;line-height:1.55;">
                If anything looks incorrect, reply to this email or contact <a href="mailto:sales@saigoods.com" style="color:#BF5841;">sales@saigoods.com</a>.
              </p>
              <p style="margin:16px 0 0;font-size:13px;color:#a1a1aa;line-height:1.5;">SAI Goods</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}
