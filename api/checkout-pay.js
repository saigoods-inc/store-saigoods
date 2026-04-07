import { buildFullCheckoutQuote, formatShippingAddressForOrder } from "../lib/checkout-totals.js";
import { parseCheckoutPayBody } from "../lib/checkout-validation.js";
import { createPendingOrder } from "../lib/orders.js";
import { createCardPayment } from "../lib/square.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed." });
    return;
  }

  try {
    const parsed = parseCheckoutPayBody(req.body || {});
    if (parsed.error) {
      res.status(400).json({ error: parsed.error });
      return;
    }

    const quote = buildFullCheckoutQuote(parsed.items, parsed.address);
    const customer = {
      name: parsed.name,
      email: parsed.email,
      phone: parsed.phone,
      address: formatShippingAddressForOrder(parsed.address),
    };

    const pending = await createPendingOrder({ quote, customer });
    const locationId = process.env.SQUARE_LOCATION_ID?.trim();

    const { paymentId } = await createCardPayment({
      sourceId: parsed.sourceId,
      amountCents: quote.totalCents,
      locationId,
      orderId: pending.id,
      buyerEmail: parsed.email,
      idempotencyKey: `saigoods-pay-${pending.id}`,
    });

    res.status(200).json({
      success: true,
      paymentId,
      orderId: pending.id,
      orderRef: pending.order_ref,
      totalFormatted: quote.totalFormatted,
    });
  } catch (error) {
    console.error(error);
    res
      .status(error.statusCode || 500)
      .json({ error: error.message || "Payment could not be completed." });
  }
}
