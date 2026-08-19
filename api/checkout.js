import {
  buildFullCheckoutQuote,
  isStorefrontPaymentLinkCompatibleWithShippingMode,
} from "../lib/checkout-totals.js";
import { createPendingOrder } from "../lib/orders.js";
import { createPaymentLink } from "../lib/square.js";
import { primeRuntimeStoreForItems } from "../lib/runtime-store.js";

/** Deterministic body when live shipping makes the payment-link fallback unsafe. */
export const STOREFRONT_PAYMENT_LINK_UNAVAILABLE_BODY = {
  error:
    "Address-based checkout is required. The payment-link fallback is unavailable.",
};

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed." });
    return;
  }

  try {
    if (!isStorefrontPaymentLinkCompatibleWithShippingMode()) {
      // 503: capability unavailable under active shipping config (same family as
      // Square/embedded-checkout "not configured" responses). Not a client input error.
      res.status(503).json(STOREFRONT_PAYMENT_LINK_UNAVAILABLE_BODY);
      return;
    }

    const { items, customer: rawCustomer } = req.body || {};
    const customer =
      rawCustomer && typeof rawCustomer === "object" && !Array.isArray(rawCustomer) ? rawCustomer : {};

    if (!Array.isArray(items) || items.length === 0) {
      res.status(400).json({ error: "Your cart is empty." });
      return;
    }

    await primeRuntimeStoreForItems(items);

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
