import { Resend } from "resend";
import {
  markVendorPaidNotificationSent,
  releaseVendorPaidNotificationClaim,
  tryClaimVendorPaidNotification,
} from "./orders.js";
import { normalizeResendFrom } from "./resend-order-confirmation.js";

function formatCurrency(cents) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format((Number(cents) || 0) / 100);
}

function itemLineTotalFormatted(item) {
  if (item?.lineTotalFormatted) {
    return String(item.lineTotalFormatted);
  }
  return formatCurrency(item?.lineTotalCents ?? 0);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function prettySize(size) {
  const raw = String(size || "").trim();
  return { S: "Small", M: "Medium", L: "Large", XL: "X Large" }[raw] || raw;
}

function itemQuantityDetails(item) {
  const quantities = item?.quantities && typeof item.quantities === "object" ? item.quantities : {};
  const boxQuantities =
    item?.boxQuantities && typeof item.boxQuantities === "object" ? item.boxQuantities : {};
  const sizes = [...new Set([...Object.keys(quantities), ...Object.keys(boxQuantities)])];
  const bySize = sizes
    .map((size) => {
      const cartons = Math.max(0, Math.floor(Number(quantities[size]) || 0));
      const boxes = Math.max(0, Math.floor(Number(boxQuantities[size]) || 0));
      const parts = [];
      if (cartons) parts.push(`${cartons} ${cartons === 1 ? "carton" : "cartons"}`);
      if (boxes) parts.push(`${boxes} ${boxes === 1 ? "box" : "boxes"}`);
      return parts.length ? `${prettySize(size)}: ${parts.join(", ")}` : "";
    })
    .filter(Boolean);

  if (bySize.length) {
    return bySize.join(" • ");
  }

  const cartons = Math.max(0, Math.floor(Number(item?.lineCases) || 0));
  const boxes = Math.max(0, Math.floor(Number(item?.lineBoxCount) || 0));
  const parts = [];
  if (cartons) parts.push(`${cartons} ${cartons === 1 ? "carton" : "cartons"}`);
  if (boxes) parts.push(`${boxes} ${boxes === 1 ? "box" : "boxes"}`);
  if (parts.length) {
    return parts.join(" • ");
  }

  const quantity = Math.max(0, Math.floor(Number(item?.quantity) || 0));
  return quantity ? `${quantity} ${quantity === 1 ? "item" : "items"}` : "Quantity not listed";
}

function orderReference(order) {
  return String(order?.order_ref || order?.id || "Order").trim();
}

function customerName(order) {
  return String(order?.customer_name || "Customer").trim() || "Customer";
}

function adminOrdersUrl() {
  return "https://store.saigoods.com/admin-v2.5/orders";
}

export function buildVendorPaidOrderSubject(order) {
  return `Paid order ${formatCurrency(order?.total_cents)} — ${customerName(order)}`;
}

/**
 * Plain-text body for the internal vendor paid-order notification.
 * @param {object} order — orders row (snake_case)
 */
export function buildVendorPaidOrderText(order) {
  const lines = [];
  const reference = orderReference(order);
  const total = formatCurrency(order.total_cents);
  lines.push("NEW ORDER — READY TO FULFILL");
  lines.push("");
  lines.push(`${customerName(order)} paid ${total}.`);
  lines.push(`Order: ${reference}`);
  lines.push("");
  lines.push("ITEMS");
  const items = Array.isArray(order.items) ? order.items : [];
  for (const item of items) {
    lines.push(`- ${item.name || "Product"}`);
    lines.push(`  ${itemQuantityDetails(item)} • ${itemLineTotalFormatted(item)}`);
  }
  lines.push("");
  lines.push("CUSTOMER & DELIVERY");
  lines.push(customerName(order));
  if (order.customer_email) lines.push(order.customer_email);
  if (order.customer_phone) lines.push(order.customer_phone);
  if (order.customer_address) lines.push(order.customer_address);
  lines.push("");
  lines.push("PAYMENT SUMMARY");
  lines.push(`Subtotal: ${formatCurrency(order.subtotal_cents)}`);
  lines.push(`Shipping: ${formatCurrency(order.shipping_cents)}`);
  lines.push(`Tax: ${formatCurrency(order.tax_cents)}`);
  lines.push(`Total paid: ${total}`);
  lines.push("");
  lines.push("NEXT STEP");
  lines.push("Open the order dashboard to review the label, prepare the package, and mark it shipped.");
  lines.push(adminOrdersUrl());
  return lines.join("\n");
}

/**
 * Mobile-friendly HTML body for the internal paid-order notification.
 * It intentionally presents operational details only; provider and database IDs stay out of the UI.
 * @param {object} order — orders row (snake_case)
 */
export function buildVendorPaidOrderHtml(order) {
  const reference = orderReference(order);
  const name = customerName(order);
  const total = formatCurrency(order.total_cents);
  const items = Array.isArray(order.items) ? order.items : [];
  const itemRows = items.length
    ? items
        .map(
          (item) => `<tr>
            <td style="padding:14px 0;border-bottom:1px solid #eadfd8;vertical-align:top;">
              <div style="font-size:15px;line-height:21px;font-weight:800;color:#2b2927;">${escapeHtml(item?.name || "Product")}</div>
              <div style="margin-top:4px;font-size:13px;line-height:19px;color:#6f655f;">${escapeHtml(itemQuantityDetails(item))}</div>
            </td>
            <td style="padding:14px 0 14px 12px;border-bottom:1px solid #eadfd8;text-align:right;vertical-align:top;white-space:nowrap;font-size:15px;line-height:21px;font-weight:800;color:#2b2927;">${escapeHtml(itemLineTotalFormatted(item))}</td>
          </tr>`,
        )
        .join("")
    : `<tr><td style="padding:14px 0;color:#6f655f;font-size:14px;line-height:21px;">No item details available.</td></tr>`;

  const contactRows = [
    order.customer_email
      ? `<a href="mailto:${escapeHtml(order.customer_email)}" style="color:#bf5841;text-decoration:none;font-weight:700;">${escapeHtml(order.customer_email)}</a>`
      : "",
    order.customer_phone
      ? `<a href="tel:${escapeHtml(String(order.customer_phone).replace(/[^+\d]/g, ""))}" style="color:#2b2927;text-decoration:none;">${escapeHtml(order.customer_phone)}</a>`
      : "",
    order.customer_address ? escapeHtml(order.customer_address) : "",
  ].filter(Boolean);

  const pricingRows = [
    ["Merchandise", formatCurrency(order.subtotal_cents)],
    ["Shipping", formatCurrency(order.shipping_cents)],
    ["Tax", formatCurrency(order.tax_cents)],
  ]
    .map(
      ([label, value]) => `<tr>
        <td style="padding:5px 0;font-size:14px;line-height:20px;color:#6f655f;">${escapeHtml(label)}</td>
        <td style="padding:5px 0 5px 12px;text-align:right;font-size:14px;line-height:20px;font-weight:700;color:#2b2927;white-space:nowrap;">${escapeHtml(value)}</td>
      </tr>`,
    )
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Paid order — SAI Goods</title>
</head>
<body style="margin:0;padding:0;background:#f6f1ed;color:#2b2927;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${escapeHtml(`${name} paid ${total}. Order ${reference} is ready to fulfill.`)}</div>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="width:100%;background:#f6f1ed;">
    <tr>
      <td align="center" style="padding:28px 14px;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="width:100%;max-width:600px;background:#ffffff;border:1px solid #eadfd8;border-radius:18px;overflow:hidden;">
          <tr>
            <td style="padding:22px;background:#fffaf7;border-bottom:1px solid #eadfd8;">
              <div style="font-size:13px;line-height:18px;font-weight:800;color:#bf5841;">SAI Goods Operations</div>
              <h1 style="margin:10px 0 0;font-size:27px;line-height:33px;font-weight:800;color:#2b2927;">New order ready to fulfill</h1>
              <p style="margin:9px 0 0;font-size:16px;line-height:24px;color:#5f5650;">${escapeHtml(name)} paid <strong style="color:#2b2927;">${escapeHtml(total)}</strong>.</p>
            </td>
          </tr>
          <tr>
            <td style="padding:22px;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="width:100%;border-collapse:separate;border-spacing:0;">
                <tr>
                  <td style="padding:13px 14px;background:#fbf8f6;border:1px solid #eadfd8;border-radius:10px;">
                    <div style="font-size:11px;line-height:15px;font-weight:800;letter-spacing:.05em;color:#8b817b;text-transform:uppercase;">Order</div>
                    <div style="margin-top:4px;font-size:16px;line-height:22px;font-weight:800;color:#2b2927;word-break:break-word;">${escapeHtml(reference)}</div>
                  </td>
                  <td width="10"></td>
                  <td style="padding:13px 14px;background:#fbf8f6;border:1px solid #eadfd8;border-radius:10px;text-align:right;">
                    <div style="font-size:11px;line-height:15px;font-weight:800;letter-spacing:.05em;color:#8b817b;text-transform:uppercase;">Total paid</div>
                    <div style="margin-top:4px;font-size:21px;line-height:26px;font-weight:800;color:#bf5841;white-space:nowrap;">${escapeHtml(total)}</div>
                  </td>
                </tr>
              </table>

              <div style="margin-top:18px;padding:17px 16px;background:#fff4cf;border:1px solid #f0d98b;border-radius:10px;">
                <div style="font-size:12px;line-height:16px;font-weight:800;letter-spacing:.04em;color:#715600;text-transform:uppercase;">Next step</div>
                <p style="margin:7px 0 14px;font-size:14px;line-height:21px;color:#5c4a11;">Review the shipping label, prepare the package, and mark the order shipped when it is handed to the carrier.</p>
                <a href="${adminOrdersUrl()}" style="display:inline-block;padding:11px 16px;background:#bf5841;border-radius:8px;color:#ffffff;text-decoration:none;font-size:14px;line-height:20px;font-weight:800;">Open order dashboard</a>
              </div>

              <div style="margin-top:18px;padding:17px 16px;background:#fbf8f6;border:1px solid #eadfd8;border-radius:10px;">
                <div style="font-size:12px;line-height:16px;font-weight:800;letter-spacing:.04em;color:#8b817b;text-transform:uppercase;">Items to prepare</div>
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="width:100%;border-collapse:collapse;">${itemRows}</table>
              </div>

              <div style="margin-top:18px;padding:17px 16px;background:#ffffff;border:1px solid #eadfd8;border-radius:10px;">
                <div style="font-size:12px;line-height:16px;font-weight:800;letter-spacing:.04em;color:#8b817b;text-transform:uppercase;">Customer &amp; delivery</div>
                <div style="margin-top:10px;font-size:16px;line-height:22px;font-weight:800;color:#2b2927;">${escapeHtml(name)}</div>
                <div style="margin-top:5px;font-size:14px;line-height:22px;color:#5f5650;word-break:break-word;">${contactRows.join("<br />") || "Contact details not available."}</div>
              </div>

              <div style="margin-top:18px;padding:17px 16px;background:#fbf8f6;border:1px solid #eadfd8;border-radius:10px;">
                <div style="font-size:12px;line-height:16px;font-weight:800;letter-spacing:.04em;color:#8b817b;text-transform:uppercase;">Payment summary</div>
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="width:100%;margin-top:8px;border-collapse:collapse;">
                  ${pricingRows}
                  <tr><td colspan="2" style="padding:9px 0 5px;border-top:1px solid #d9cec8;"></td></tr>
                  <tr>
                    <td style="font-size:16px;line-height:22px;font-weight:800;color:#2b2927;">Total paid</td>
                    <td style="text-align:right;font-size:18px;line-height:24px;font-weight:800;color:#2b2927;white-space:nowrap;">${escapeHtml(total)}</td>
                  </tr>
                </table>
              </div>

              <p style="margin:20px 0 0;font-size:12px;line-height:19px;color:#8b817b;">This notification was sent automatically after payment was confirmed. Payment details are available in Square.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/**
 * @param {object} order — orders row (snake_case)
 */
export function vendorPaidNotificationIdempotencyKey(order) {
  const key = order.payment_id || order.id;
  return `vendor-paid-order/${key}`;
}

async function defaultSendResend({ apiKey, from, to, subject, html, text, idempotencyKey }) {
  const resend = new Resend(apiKey);
  return resend.emails.send(
    {
      from,
      to: [to],
      subject,
      html,
      text,
    },
    { idempotencyKey },
  );
}

/**
 * Send the vendor paid-order notification once per paid order (persistent claim + Resend idempotency).
 * @param {{ orderId: string, paymentId: string }} args
 * @param {object} [dependencies]
 * @returns {Promise<{ sent: boolean, reason?: string, resendId?: string }>}
 */
export async function sendVendorPaidOrderNotificationIfNeeded(
  { orderId, paymentId },
  dependencies = {},
) {
  const claimFn = dependencies.tryClaimVendorPaidNotification ?? tryClaimVendorPaidNotification;
  const markSentFn = dependencies.markVendorPaidNotificationSent ?? markVendorPaidNotificationSent;
  const releaseClaimFn =
    dependencies.releaseVendorPaidNotificationClaim ?? releaseVendorPaidNotificationClaim;
  const sendResend = dependencies.sendResend ?? defaultSendResend;

  const claim = await claimFn({ orderId, paymentId });
  if (!claim) {
    return { sent: false, reason: "already_sent_or_in_progress" };
  }

  const { order, claimedAt } = claim;
  const apiKey = (dependencies.resendApiKey ?? process.env.RESEND_API_KEY)?.trim();
  const from = normalizeResendFrom(dependencies.resendFrom ?? process.env.RESEND_FROM);
  const to = (dependencies.vendorEmail ?? process.env.VENDOR_NOTIFICATION_EMAIL)?.trim();

  if (!apiKey || !from || !to) {
    await releaseClaimFn({
      orderId,
      claimedAt,
      error: "vendor_notification_config_missing",
    });
    const err = new Error("Vendor notification email is not configured.");
    err.code = "VENDOR_NOTIFICATION_CONFIG";
    throw err;
  }

  try {
    const subject = buildVendorPaidOrderSubject(order);
    const html = buildVendorPaidOrderHtml(order);
    const text = buildVendorPaidOrderText(order);
    const idempotencyKey = vendorPaidNotificationIdempotencyKey(order);

    const { data, error } = await sendResend({
      apiKey,
      from,
      to,
      subject,
      html,
      text,
      idempotencyKey,
    });

    if (error) {
      await releaseClaimFn({
        orderId,
        claimedAt,
        error: "vendor_notification_send_failed",
      });
      const err = new Error("Vendor notification email failed to send.");
      err.code = "VENDOR_NOTIFICATION_SEND_FAILED";
      throw err;
    }

    let markedSent = false;
    try {
      markedSent = await markSentFn({ orderId, claimedAt, resendId: data?.id ?? null });
    } catch {
      await releaseClaimFn({
        orderId,
        claimedAt,
        error: "vendor_notification_persist_failed",
      });
      const err = new Error("Vendor notification sent state could not be persisted.");
      err.code = "VENDOR_NOTIFICATION_PERSIST_FAILED";
      throw err;
    }

    if (!markedSent) {
      await releaseClaimFn({
        orderId,
        claimedAt,
        error: "vendor_notification_persist_failed",
      });
      const err = new Error("Vendor notification sent state could not be persisted.");
      err.code = "VENDOR_NOTIFICATION_PERSIST_FAILED";
      throw err;
    }

    return { sent: true, resendId: data?.id };
  } catch (err) {
    if (
      err?.code === "VENDOR_NOTIFICATION_CONFIG" ||
      err?.code === "VENDOR_NOTIFICATION_SEND_FAILED" ||
      err?.code === "VENDOR_NOTIFICATION_PERSIST_FAILED"
    ) {
      throw err;
    }
    await releaseClaimFn({
      orderId,
      claimedAt,
      error: "vendor_notification_send_failed",
    });
    const wrapped = new Error("Vendor notification email failed to send.");
    wrapped.code = "VENDOR_NOTIFICATION_SEND_FAILED";
    throw wrapped;
  }
}
