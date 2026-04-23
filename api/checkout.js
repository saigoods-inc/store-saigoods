import { buildFullCheckoutQuote } from "../lib/checkout-totals.js";
import { createPendingOrder } from "../lib/orders.js";
import { createPaymentLink } from "../lib/square.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed." });
    return;
  }

  try {
    const { items, customer: rawCustomer } = req.body || {};
    const customer =
      rawCustomer && typeof rawCustomer === "object" && !Array.isArray(rawCustomer) ? rawCustomer : {};

    if (!Array.isArray(items) || items.length === 0) {
      res.status(400).json({ error: "Your cart is empty." });
      return;
    }

    const quote = await buildFullCheckoutQuote(items, customer?.address || {}, {
      flow: "checkout",
      receiptRebuild: true,
      shippingContext: null,
    });

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
