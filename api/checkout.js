import { buildQuote } from "../lib/quote.js";
import { createPendingOrder } from "../lib/orders.js";
import { createPaymentLink } from "../lib/square.js";
import { normalizeUsZip } from "../lib/shipping.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed." });
    return;
  }

  try {
    const { items, customer } = req.body || {};

    if (!Array.isArray(items) || items.length === 0) {
      res.status(400).json({ error: "Your cart is empty." });
      return;
    }

    if (!customer || !customer.email) {
      res.status(400).json({ error: "Customer details are required." });
      return;
    }

    if (!normalizeUsZip(customer.zipCode)) {
      res.status(400).json({
        error: "Enter a valid 5-digit U.S. ZIP code.",
      });
      return;
    }

    const quote = buildQuote(items, { omitShippingEstimate: true });

    if (!quote.items.length) {
      res.status(400).json({ error: "Your cart is empty." });
      return;
    }

    const pendingOrder = await createPendingOrder({ quote, customer });
    const paymentLink = await createPaymentLink({
      quote,
      customer,
      orderId: pendingOrder.id,
    });

    res.status(200).json({
      checkoutUrl: paymentLink.checkoutUrl,
      quote,
      orderId: pendingOrder.id,
      orderRef: pendingOrder.order_ref,
      squareReady: true,
    });
  } catch (error) {
    console.error(error);
    res
      .status(error.statusCode || 500)
      .json({ error: error.message || "Checkout could not be created." });
  }
}

