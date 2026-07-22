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

function itemLineCases(item) {
  if (item?.lineCases != null) {
    return item.lineCases;
  }
  if (item?.quantity != null) {
    return item.quantity;
  }
  return "?";
}

/**
 * Plain-text body for the internal vendor paid-order notification.
 * @param {object} order — orders row (snake_case)
 */
export function buildVendorPaidOrderText(order) {
  const lines = [];
  lines.push("New paid order received.");
  lines.push("");
  if (order.order_ref) {
    lines.push(`Order reference: ${order.order_ref}`);
  }
  lines.push(`Order ID: ${order.id}`);
  lines.push("Payment provider: Square");
  lines.push(`Payment ID: ${order.payment_id || "n/a"}`);
  lines.push("");
  lines.push("Customer:");
  lines.push(`- Name: ${order.customer_name || ""}`);
  lines.push(`- Email: ${order.customer_email || ""}`);
  lines.push(`- Phone: ${order.customer_phone || ""}`);
  lines.push(`- Address: ${order.customer_address || ""}`);
  lines.push("");
  lines.push("Items:");
  const items = Array.isArray(order.items) ? order.items : [];
  for (const item of items) {
    lines.push(
      `- ${item.name} (${item.slug}): ${itemLineCases(item)} case(s) - ${itemLineTotalFormatted(item)}`,
    );
  }
  lines.push("");
  lines.push(`Subtotal: ${formatCurrency(order.subtotal_cents)}`);
  lines.push(`Shipping: ${formatCurrency(order.shipping_cents)}`);
  lines.push(`Tax: ${formatCurrency(order.tax_cents)}`);
  lines.push(`Total: ${formatCurrency(order.total_cents)}`);
  lines.push("");
  lines.push("Please log in to the admin systems to manage fulfillment.");
  return lines.join("\n");
}

/**
 * @param {object} order — orders row (snake_case)
 */
export function vendorPaidNotificationIdempotencyKey(order) {
  const key = order.payment_id || order.id;
  return `vendor-paid-order/${key}`;
}

async function defaultSendResend({ apiKey, from, to, subject, text, idempotencyKey }) {
  const resend = new Resend(apiKey);
  return resend.emails.send(
    {
      from,
      to: [to],
      subject,
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
    const subject = `New paid order ${order.order_ref || order.id}`;
    const text = buildVendorPaidOrderText(order);
    const idempotencyKey = vendorPaidNotificationIdempotencyKey(order);

    const { data, error } = await sendResend({
      apiKey,
      from,
      to,
      subject,
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
