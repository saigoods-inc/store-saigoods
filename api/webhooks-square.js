import { markOrderPaid } from "../lib/orders.js";
import { sendCustomerEmail, sendVendorEmail } from "../lib/email.js";
import { verifySquareSignature } from "../lib/square.js";

export const config = {
  api: {
    bodyParser: false,
  },
};

export default async function handler(req, res) {
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

    const notificationUrl = `${baseUrl}/api/webhooks/square`;

    const valid = verifySquareSignature({
      body: rawBody,
      signature,
      notificationUrl,
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

    // Matches bigint (e.g. Order 42 from) or uuid (Order d88b... from)
    const orderIdMatch = note.match(/Order\s+(\S+)\s+from/i);
    const orderId = orderIdMatch ? orderIdMatch[1] : null;

    if (!orderId) {
      res.status(200).json({ ok: true });
      return;
    }

    const order = await markOrderPaid({ orderId, paymentId });

    // If no order was updated, it was already handled; avoid duplicate emails.
    if (!order) {
      res.status(200).json({ ok: true });
      return;
    }

    const orderForEmail = {
      id: order.id,
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

    await Promise.all([sendCustomerEmail(orderForEmail), sendVendorEmail(orderForEmail)]);

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

