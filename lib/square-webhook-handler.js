import { buildFullCheckoutQuote } from "./checkout-totals.js";
import { markOrderPaid } from "./orders.js";
import { sendCustomerEmail, sendVendorEmail } from "./email.js";
import { isResendCustomerEmailEnabled, sendResendOrderConfirmation } from "./resend-order-confirmation.js";
import {
  extractBuyerContactFromPayment,
  formatPaymentShippingAddress,
  verifySquareSignature,
} from "./square.js";

export const config = {
  api: {
    bodyParser: false,
  },
};

/**
 * Shared Square webhook logic for production and sandbox URLs.
 * @param {import("http").IncomingMessage} req
 * @param {import("http").ServerResponse} res
 * @param {{ notificationPath: string, signatureKey: string }} opts
 *   notificationPath — path only, e.g. "/api/webhooks/square" (must match Square subscription URL)
 *   signatureKey — HMAC key from Square for this subscription
 */
export async function handleSquareWebhook(req, res, { notificationPath, signatureKey }) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed." });
    return;
  }

  try {
    const chunks = [];

    for await (const chunk of req) {
      chunks.push(chunk);
    }

    const rawBody = Buffer.concat(chunks).toString("utf8");
    const signature = req.headers["x-square-hmacsha256-signature"];

    const baseUrl = process.env.PUBLIC_BASE_URL?.replace(/\/$/, "");
    if (!baseUrl) {
      res.status(500).json({ error: "PUBLIC_BASE_URL is not configured." });
      return;
    }

    const notificationUrl = `${baseUrl}${notificationPath.startsWith("/") ? "" : "/"}${notificationPath}`;

    const valid = verifySquareSignature({
      body: rawBody,
      signature,
      notificationUrl,
      signatureKey,
    });

    if (!valid) {
      res.status(403).json({ error: "Invalid signature." });
      return;
    }

    let event;
    try {
      event = JSON.parse(rawBody);
    } catch {
      res.status(400).json({ error: "Invalid JSON body." });
      return;
    }

    const eventType = String(event?.type || "");
    if (eventType && !eventType.startsWith("payment.")) {
      res.status(200).json({ ok: true, ignored: true });
      return;
    }

    const payment = extractPaymentFromSquareEvent(event);
    if (!payment) {
      res.status(200).json({ ok: true, ignored: true });
      return;
    }

    if (payment.status !== "COMPLETED") {
      res.status(200).json({ ok: true });
      return;
    }

    const paymentId = payment.id;
    const note = payment.note || "";

    const orderIdMatch = note.match(/Order\s+(\S+)\s+from/i);
    const orderId = orderIdMatch ? orderIdMatch[1] : null;

    if (!orderId) {
      res.status(200).json({ ok: true });
      return;
    }

    const paidTotalCents = payment.amount_money?.amount;
    const contact = extractBuyerContactFromPayment(payment);
    const order = await markOrderPaid({
      orderId,
      paymentId,
      paidTotalCents:
        paidTotalCents != null && Number.isFinite(Number(paidTotalCents))
          ? Number(paidTotalCents)
          : undefined,
      customerAddress: formatPaymentShippingAddress(payment),
      buyerEmail: contact.email,
      buyerPhone: contact.phone,
      buyerName: contact.name,
    });

    if (!order) {
      res.status(200).json({ ok: true });
      return;
    }

    const orderForEmail = {
      id: order.id,
      orderRef: order.order_ref,
      paymentId,
      customer: {
        name: order.customer_name,
        email: order.customer_email,
        phone: order.customer_phone,
        address: order.customer_address,
      },
      items: order.items || [],
      subtotalCents: order.subtotal_cents,
      shippingCents: order.shipping_cents,
      taxCents: order.tax_cents,
      totalCents: order.total_cents,
      subtotalFormatted: formatCurrency(order.subtotal_cents),
      shippingFormatted: formatCurrency(order.shipping_cents),
      taxFormatted: formatCurrency(order.tax_cents),
      totalFormatted: formatCurrency(order.total_cents),
    };

    const emailTasks = [sendVendorEmail(orderForEmail)];
    if (!isResendCustomerEmailEnabled()) {
      emailTasks.push(sendCustomerEmail(orderForEmail));
    } else if (String(order.order_source || "") === "manual") {
      /** Website card checkout already sends Resend from checkout-pay; payment-link / staff orders do not. */
      emailTasks.push(
        sendResendConfirmationForPaidOrder(order).catch((err) => {
          console.error("[square webhook] Resend order confirmation failed:", err);
        }),
      );
    }
    await Promise.all(emailTasks);

    res.status(200).json({ ok: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Webhook handling failed." });
  }
}

function formatCurrency(cents) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format((Number(cents) || 0) / 100);
}

/**
 * Same branded “Order confirmed” email as embedded checkout, for any Square-paid order
 * (manual payment link, etc.) when Resend is configured. Skipped when email missing or no lines.
 */
async function sendResendConfirmationForPaidOrder(order) {
  const email = order?.customer_email != null ? String(order.customer_email).trim() : "";
  if (!email) {
    return;
  }
  const items = Array.isArray(order.items) ? order.items : [];
  if (!items.length) {
    return;
  }

  const addr = order.shipping_address && typeof order.shipping_address === "object" ? order.shipping_address : null;
  const pricingTier = order.is_hardin_discount === true ? "hardin" : "standard";

  let quoteForEmail;
  if (addr && String(addr.postalCode || "").trim()) {
    try {
      const quote = await buildFullCheckoutQuote(items, addr, { pricingTier });
      quoteForEmail = {
        ...quote,
        subtotalCents: Math.max(0, Number(order.subtotal_cents) || 0),
        subtotalFormatted: formatCurrency(order.subtotal_cents),
        shippingCents: Math.max(0, Number(order.shipping_cents) || 0),
        shippingFormatted: formatCurrency(order.shipping_cents),
        taxCents: Math.max(0, Number(order.tax_cents) || 0),
        taxFormatted: formatCurrency(order.tax_cents),
        totalCents: Math.max(0, Number(order.total_cents) || 0),
        totalFormatted: formatCurrency(order.total_cents),
      };
    } catch (err) {
      console.error("[square webhook] buildFullCheckoutQuote for confirmation email:", err);
      quoteForEmail = quoteFromPaidOrderRow(order);
    }
  } else {
    quoteForEmail = quoteFromPaidOrderRow(order);
  }

  await sendResendOrderConfirmation({
    pending: {
      id: order.id,
      order_ref: order.order_ref,
      created_at: order.created_at,
    },
    quote: quoteForEmail,
    customerEmail: email,
    customerName: order.customer_name,
  });
}

function quoteFromPaidOrderRow(order) {
  const items = Array.isArray(order.items) ? order.items : [];
  return {
    items,
    subtotalCents: Math.max(0, Number(order.subtotal_cents) || 0),
    subtotalFormatted: formatCurrency(order.subtotal_cents),
    shippingCents: Math.max(0, Number(order.shipping_cents) || 0),
    shippingFormatted: formatCurrency(order.shipping_cents),
    taxCents: Math.max(0, Number(order.tax_cents) || 0),
    taxFormatted: formatCurrency(order.tax_cents),
    totalCents: Math.max(0, Number(order.total_cents) || 0),
    totalFormatted: formatCurrency(order.total_cents),
  };
}

/** Square webhook payloads nest payment under data.object.payment; tolerate variants. */
function extractPaymentFromSquareEvent(event) {
  if (!event?.data?.object) {
    return null;
  }

  const obj = event.data.object;

  if (obj.payment && typeof obj.payment === "object") {
    return obj.payment;
  }

  if (obj.id && obj.status && obj.amount_money) {
    return obj;
  }

  return null;
}
