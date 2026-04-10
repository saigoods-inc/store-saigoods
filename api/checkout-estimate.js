import { validateShippingAddressForCheckout } from "../lib/address-validation.js";
import { buildFullCheckoutQuote } from "../lib/checkout-totals.js";
import { parseEstimateAddressBody } from "../lib/checkout-validation.js";
import { assertDiscountCodeAvailable, normalizeDiscountCode } from "../lib/discount-codes.js";
import { isHardinCountyTnDelivery } from "../lib/hardin-county.js";

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

    const discountRaw = String(req.body?.discountCode ?? "").trim();
    const normalizedCode = discountRaw ? normalizeDiscountCode(discountRaw) : null;
    if (discountRaw && !normalizedCode) {
      res.status(400).json({
        error: "Enter a valid discount code (format HC-XXXXX, letters and numbers only).",
      });
      return;
    }

    let pricingTier = "standard";
    let hardinDiscountApplied = false;

    if (normalizedCode) {
      if (parsed.partial) {
        const quote = await buildFullCheckoutQuote(items, parsed.address, { pricingTier: "standard" });
        const warnings = [];
        res.status(200).json({
          ...quote,
          warnings,
          hardinDiscountApplied: false,
          hardinDiscountBlocked: "incomplete_address",
        });
        return;
      }

      if (!isHardinCountyTnDelivery(parsed.address)) {
        res.status(400).json({
          error: "This discount only applies to orders shipped to an eligible address.",
        });
        return;
      }

      try {
        await assertDiscountCodeAvailable(normalizedCode);
      } catch (err) {
        const status = err.statusCode || 400;
        res.status(status).json({ error: err.message || "Discount code is not valid." });
        return;
      }

      pricingTier = "hardin";
      hardinDiscountApplied = true;
    }

    const quote = await buildFullCheckoutQuote(items, parsed.address, { pricingTier });
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

    res.status(200).json({ ...quote, warnings, hardinDiscountApplied });
  } catch (error) {
    console.error(error);
    res.status(error.statusCode || 500).json({ error: error.message || "Estimate failed." });
  }
}
