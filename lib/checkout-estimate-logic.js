import { validateShippingAddressForCheckout } from "./address-validation.js";
import { buildFullCheckoutQuote } from "./checkout-totals.js";
import { parseEstimateAddressBody } from "./checkout-validation.js";
import { assertDiscountCodeAvailable, normalizeDiscountCode } from "./discount-codes.js";
import { isHardinCountyTnDelivery } from "./hardin-county.js";
import { assertStockAvailableForItems } from "./stock.js";

function throwHttpError(message, statusCode = 400, addressValidation, fieldErrors) {
  const e = new Error(message);
  e.statusCode = statusCode;
  if (addressValidation) {
    e.addressValidation = addressValidation;
  }
  if (fieldErrors && typeof fieldErrors === "object" && Object.keys(fieldErrors).length) {
    e.fieldErrors = fieldErrors;
  }
  throw e;
}

/** Optional JSON fields for checkout / admin estimate error responses. */
export function checkoutFlowErrorJsonFields(error) {
  if (!error || typeof error !== "object") {
    return {};
  }
  return {
    ...(error.addressValidation ? { addressValidation: error.addressValidation } : {}),
    ...(error.fieldErrors && Object.keys(error.fieldErrors).length ? { fieldErrors: error.fieldErrors } : {}),
    ...(error.stockShortfalls ? { stockShortfalls: error.stockShortfalls } : {}),
  };
}

function withStockOverrideHint(obj, skipped) {
  if (!skipped || !obj || typeof obj !== "object") {
    return obj;
  }
  const w = Array.isArray(obj.warnings) ? [...obj.warnings] : [];
  w.push("Stock availability was not checked (staff override).");
  return { ...obj, stockAssertionSkipped: true, warnings: w };
}

/**
 * Shared checkout quote computation (embedded checkout + admin manual order).
 * @param {object} body - { items, address, discountCode?, applyEligibleLocalDiscount?, forceApplyEligibleLocalDiscount? }
 * @param {{ requireCompleteAddress?: boolean, adminLocalDiscount?: boolean, walkInPickup?: boolean, strictShippo?: boolean, allowForceStockOverride?: boolean }} [opts]
 *   `allowForceStockOverride` — when true, `body.forceStockOverride` skips stock availability checks (staff only).
 *   When `adminLocalDiscount` is true, `discountCode` is ignored; use `applyEligibleLocalDiscount` only.
 *   `forceApplyEligibleLocalDiscount` (with checkbox on) skips ZIP eligibility and applies Hardin tier — staff only.
 *   `walkInPickup` — walk-in admin flow: local discount applies when checked without ZIP checks or override UI.
 * @returns {Promise<object>} API-shaped estimate JSON
 */
export async function computeCheckoutEstimate(body, opts = {}) {
  const requireCompleteAddress = opts.requireCompleteAddress === true;
  const adminLocalDiscount = opts.adminLocalDiscount === true;
  const walkInPickup = opts.walkInPickup === true;
  let adminLocalDiscountForced = false;

  const items = Array.isArray(body?.items) ? body.items : [];
  if (!items.length) {
    throwHttpError("Your cart is empty.", 400);
  }

  const skipStockAssertion =
    opts.allowForceStockOverride === true && body?.forceStockOverride === true;
  if (!skipStockAssertion) {
    await assertStockAvailableForItems(items);
  }

  const parsed = parseEstimateAddressBody(body || {});
  if (parsed.error) {
    throwHttpError(parsed.error, 400, null, parsed.fieldErrors);
  }

  if (requireCompleteAddress && parsed.partial) {
    throwHttpError("Please provide a complete shipping address.", 400);
  }

  const discountRaw = adminLocalDiscount ? "" : String(body?.discountCode ?? "").trim();
  const normalizedCode = discountRaw ? normalizeDiscountCode(discountRaw) : null;
  if (discountRaw && !normalizedCode) {
    throwHttpError("Enter a valid discount code (format HC-XXXXX, letters and numbers only).", 400);
  }

  if (!adminLocalDiscount && normalizedCode && parsed.partial) {
    const quote = await buildFullCheckoutQuote(items, parsed.address, {
      pricingTier: "standard",
      shippingContext: null,
      flow: "checkout",
    });
    return withStockOverrideHint(
      {
        ...quote,
        warnings: Array.isArray(quote.warnings) ? quote.warnings : [],
        hardinDiscountApplied: false,
        hardinDiscountBlocked: "incomplete_address",
      },
      skipStockAssertion,
    );
  }

  let mergedAddress = parsed.address;
  let shippingContext = null;
  const validationWarnings = [];
  let validationResultForQuote = null;
  let addressSuggestion = null;

  if (!walkInPickup && !parsed.partial) {
    const v = await validateShippingAddressForCheckout(parsed.address, {
      strictShippo: opts.strictShippo,
    });
    validationResultForQuote = v;
    if (!v.ok) {
      throwHttpError(v.error, 400, v.addressValidation, v.fieldErrors);
    }
    if (v.warning) {
      validationWarnings.push(v.warning);
    }
    shippingContext = v.shippingContext;
    if (v.normalizedAddress && typeof v.normalizedAddress === "object") {
      mergedAddress = { ...parsed.address, ...v.normalizedAddress };
    }
    if (v.addressSuggestion && typeof v.addressSuggestion === "object") {
      addressSuggestion = v.addressSuggestion;
    }
  }

  const requestAdminLocal = adminLocalDiscount && body?.applyEligibleLocalDiscount === true;
  const forceAdminLocal =
    requestAdminLocal && body?.forceApplyEligibleLocalDiscount === true;

  let pricingTier = "standard";
  let hardinDiscountApplied = false;

  if (requestAdminLocal) {
    if (walkInPickup) {
      pricingTier = "hardin";
      hardinDiscountApplied = true;
      adminLocalDiscountForced = false;
    } else {
      const zipOk = isHardinCountyTnDelivery(mergedAddress);
      if (!zipOk && !forceAdminLocal) {
        const quote = await buildFullCheckoutQuote(items, mergedAddress, {
          pricingTier: "standard",
          shippingContext,
          flow: walkInPickup ? "admin_walk_in" : "admin_manual",
          addressValidationResult: validationResultForQuote,
        });
        const warnings = [
          "Local discount was not applied: shipping ZIP is outside the eligible local delivery area (Hardin County, TN). Use “Continue — apply discount anyway” if you need to override for this order.",
          ...validationWarnings,
        ];
        return withStockOverrideHint(
          {
            ...quote,
            warnings: [...(Array.isArray(quote.warnings) ? quote.warnings : []), ...warnings],
            hardinDiscountApplied: false,
            adminLocalDiscountDeclined: true,
            adminLocalDiscountNeedsOverride: true,
          },
          skipStockAssertion,
        );
      }

      pricingTier = "hardin";
      hardinDiscountApplied = true;
      adminLocalDiscountForced = Boolean(forceAdminLocal && !zipOk);
    }
  } else if (normalizedCode) {
    if (!isHardinCountyTnDelivery(mergedAddress)) {
      throwHttpError("This discount code is invalid or not applicable to this address.", 400);
    }

    try {
      await assertDiscountCodeAvailable(normalizedCode);
    } catch (err) {
      throwHttpError(err.message || "Discount code is not valid.", err.statusCode || 400);
    }

    pricingTier = "hardin";
    hardinDiscountApplied = true;
  }

  const quoteFlow = walkInPickup ? "admin_walk_in" : adminLocalDiscount ? "admin_manual" : "checkout";
  const quoteWithFlow = await buildFullCheckoutQuote(items, mergedAddress, {
    pricingTier,
    shippingContext,
    flow: quoteFlow,
    addressValidationResult: validationResultForQuote,
  });
  const warnings = [
    ...(Array.isArray(quoteWithFlow.warnings) ? quoteWithFlow.warnings : []),
    ...validationWarnings,
  ];

  const out = {
    ...quoteWithFlow,
    warnings,
    hardinDiscountApplied,
    ...(addressSuggestion ? { addressSuggestion } : {}),
  };
  if (adminLocalDiscountForced) {
    out.adminLocalDiscountForced = true;
    out.warnings = [
      ...(Array.isArray(out.warnings) ? out.warnings : []),
      "Staff override: local discount pricing applied even though this ZIP is outside the normal eligible area.",
    ];
  }
  return withStockOverrideHint(out, skipStockAssertion);
}
