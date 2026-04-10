import { validateShippingAddressForCheckout } from "./address-validation.js";
import { buildFullCheckoutQuote } from "./checkout-totals.js";
import { parseEstimateAddressBody } from "./checkout-validation.js";
import { assertDiscountCodeAvailable, normalizeDiscountCode } from "./discount-codes.js";
import { isHardinCountyTnDelivery } from "./hardin-county.js";

/**
 * Shared checkout quote computation (embedded checkout + admin manual order).
 * @param {object} body - { items, address, discountCode?, applyEligibleLocalDiscount? }
 * @param {{ requireCompleteAddress?: boolean, adminLocalDiscount?: boolean }} [opts]
 *   When `adminLocalDiscount` is true, `discountCode` is ignored; use `applyEligibleLocalDiscount` only.
 * @returns {Promise<object>} API-shaped estimate JSON
 */
export async function computeCheckoutEstimate(body, opts = {}) {
  const requireCompleteAddress = opts.requireCompleteAddress === true;
  const adminLocalDiscount = opts.adminLocalDiscount === true;

  const items = Array.isArray(body?.items) ? body.items : [];
  if (!items.length) {
    const e = new Error("Your cart is empty.");
    e.statusCode = 400;
    throw e;
  }

  const parsed = parseEstimateAddressBody(body || {});
  if (parsed.error) {
    const e = new Error(parsed.error);
    e.statusCode = 400;
    throw e;
  }

  if (requireCompleteAddress && parsed.partial) {
    const e = new Error("Please provide a complete shipping address.");
    e.statusCode = 400;
    throw e;
  }

  const discountRaw = adminLocalDiscount ? "" : String(body?.discountCode ?? "").trim();
  const normalizedCode = discountRaw ? normalizeDiscountCode(discountRaw) : null;
  if (discountRaw && !normalizedCode) {
    const e = new Error("Enter a valid discount code (format HC-XXXXX, letters and numbers only).");
    e.statusCode = 400;
    throw e;
  }

  const requestAdminLocal = adminLocalDiscount && body?.applyEligibleLocalDiscount === true;

  let pricingTier = "standard";
  let hardinDiscountApplied = false;

  if (requestAdminLocal) {
    if (!isHardinCountyTnDelivery(parsed.address)) {
      const quote = await buildFullCheckoutQuote(items, parsed.address, { pricingTier: "standard" });
      const warnings = [
        "Local discount was not applied: shipping ZIP is outside the eligible local delivery area (Hardin County, TN).",
      ];
      if (!parsed.partial) {
        const v = await validateShippingAddressForCheckout(parsed.address);
        if (!v.ok) {
          const e = new Error(v.error);
          e.statusCode = 400;
          throw e;
        }
        if (v.warning) {
          warnings.push(v.warning);
        }
      }
      return {
        ...quote,
        warnings,
        hardinDiscountApplied: false,
        adminLocalDiscountDeclined: true,
      };
    }

    pricingTier = "hardin";
    hardinDiscountApplied = true;
  } else if (normalizedCode) {
    if (parsed.partial) {
      const quote = await buildFullCheckoutQuote(items, parsed.address, { pricingTier: "standard" });
      return {
        ...quote,
        warnings: [],
        hardinDiscountApplied: false,
        hardinDiscountBlocked: "incomplete_address",
      };
    }

    if (!isHardinCountyTnDelivery(parsed.address)) {
      const e = new Error("This discount code is invalid or not applicable to this address.");
      e.statusCode = 400;
      throw e;
    }

    try {
      await assertDiscountCodeAvailable(normalizedCode);
    } catch (err) {
      const e = new Error(err.message || "Discount code is not valid.");
      e.statusCode = err.statusCode || 400;
      throw e;
    }

    pricingTier = "hardin";
    hardinDiscountApplied = true;
  }

  const quote = await buildFullCheckoutQuote(items, parsed.address, { pricingTier });
  const warnings = [];

  if (!parsed.partial) {
    const v = await validateShippingAddressForCheckout(parsed.address);
    if (!v.ok) {
      const e = new Error(v.error);
      e.statusCode = 400;
      throw e;
    }
    if (v.warning) {
      warnings.push(v.warning);
    }
  }

  return { ...quote, warnings, hardinDiscountApplied };
}
