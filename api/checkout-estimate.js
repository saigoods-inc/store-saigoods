import { validateShippingAddressForCheckout } from "../lib/address-validation.js";
import { parseEstimateAddressBody } from "../lib/checkout-validation.js";
import { buildFullCheckoutQuote } from "../lib/checkout-totals.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed." });
    return;
  }

  try {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!items.length) {
      res.status(400).json({ error: "Your cart is empty." });
      return;
    }

    const parsed = parseEstimateAddressBody(req.body || {});
    if (parsed.error) {
      res.status(400).json({ error: parsed.error });
      return;
    }

    const quote = await buildFullCheckoutQuote(items, parsed.address);
    const warnings = [];

    if (!parsed.partial) {
      const v = await validateShippingAddressForCheckout(parsed.address);
      if (!v.ok) {
        res.status(400).json({ error: v.error });
        return;
      }
      if (v.warning) {
        warnings.push(v.warning);
      }
    }

    res.status(200).json({ ...quote, warnings });
  } catch (error) {
    console.error(error);
    res.status(error.statusCode || 500).json({ error: error.message || "Estimate failed." });
  }
}
