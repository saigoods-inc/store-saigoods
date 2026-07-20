import { validateShippingAddressForCheckout } from "./address-validation.js";
import { buildFullCheckoutQuote } from "./checkout-totals.js";
import { parseEstimateAddressBody } from "./checkout-validation.js";
import { assertDiscountCodeAvailable, normalizeDiscountCode } from "./discount-codes.js";
import { isHardinCountyTnDelivery, validateLocalDeliveryServiceArea } from "./hardin-county.js";
import {
  PICKUP_ADDRESS_FOR_ORDER,
  buildLocalOrCarrierAddressForQuote,
  hasAnyAddressFields,
} from "./manual-order-fulfillment.js";
import { assertCartItemsHaveValidSupportedSizeAllocation } from "./quote.js";
import { assertStockAvailableForItems } from "./stock.js";

function throwHttpError(message, statusCode = 400, addressValidation, fieldErrors, flowExtras = null) {
  const e = new Error(message);
  e.statusCode = statusCode;
  if (addressValidation) {
    e.addressValidation = addressValidation;
  }
  if (fieldErrors && typeof fieldErrors === "object" && Object.keys(fieldErrors).length) {
    e.fieldErrors = fieldErrors;
  }
  if (flowExtras && typeof flowExtras === "object") {
    if (flowExtras.addressSuggestion && typeof flowExtras.addressSuggestion === "object") {
      e.addressSuggestion = flowExtras.addressSuggestion;
    }
    if (flowExtras.submittedAddress && typeof flowExtras.submittedAddress === "object") {
      e.submittedAddress = flowExtras.submittedAddress;
    }
  }
  throw e;
}

/** Optional JSON fields for checkout / admin estimate error responses. */
export function checkoutFlowErrorJsonFields(error) {
  if (!error || typeof error !== "object") {
    return {};
  }
  const av = error.addressValidation && typeof error.addressValidation === "object" ? error.addressValidation : null;
  const out = {
    ...(av ? { addressValidation: av } : {}),
    ...(error?.fieldErrors && typeof error.fieldErrors === "object" && Object.keys(error.fieldErrors).length
      ? { fieldErrors: error.fieldErrors }
      : {}),
    ...(error.stockShortfalls ? { stockShortfalls: error.stockShortfalls } : {}),
  };
  if (av?.addressErrors && typeof av.addressErrors === "object") {
    out.addressErrors = av.addressErrors;
  }
  if (typeof av?.bannerMessage === "string" && av.bannerMessage.trim()) {
    out.message = av.bannerMessage.trim();
  }
  if (error?.addressSuggestion && typeof error.addressSuggestion === "object") {
    out.addressSuggestion = error.addressSuggestion;
  }
  if (error?.submittedAddress && typeof error.submittedAddress === "object") {
    out.submittedAddress = error.submittedAddress;
  }
  return out;
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
 * Pickup / local: no Shippo, no live carrier rates — `receiptRebuild` forces merchandise + tax with $0 shipping.
 */
async function buildManualNoCarrierQuote(body, opts) {
  const kind = String(opts.manualFulfillment || "");
  const adminLocalDiscount = opts.adminLocalDiscount === true;
  const items = Array.isArray(body?.items) ? body.items : [];
  if (!items.length) {
    throwHttpError("Your cart is empty.", 400);
  }

  assertCartItemsHaveValidSupportedSizeAllocation(items);

  const skipStockAssertion =
    opts.allowForceStockOverride === true && body?.forceStockOverride === true;
  if (!skipStockAssertion) {
    await assertStockAvailableForItems(items);
  }

  const validationWarnings = [];
  let mergedAddress;
  if (kind === "pickup") {
    mergedAddress = { ...PICKUP_ADDRESS_FOR_ORDER };
    validationWarnings.push("Pickup: no carrier or Shippo quote for this order — shipping is $0.");
  } else {
    // local_delivery — require approved Hardin/local service area; no silent out-of-area estimates.
    const a = body?.address;
    if (!a || typeof a !== "object" || !hasAnyAddressFields(a)) {
      throwHttpError(
        "Local delivery requires a delivery address in the approved local service area.",
        400,
      );
    }
    const state = String(a.state || "").trim();
    const zip = String(a.postalCode || "").replace(/\D/g, "").slice(0, 5);
    if (!state || zip.length !== 5) {
      throwHttpError(
        "Local delivery requires state and ZIP in the approved local service area.",
        400,
      );
    }
    mergedAddress = buildLocalOrCarrierAddressForQuote(a);
    const area = validateLocalDeliveryServiceArea(mergedAddress);
    if (!area.ok) {
      throwHttpError(area.error, 400);
    }
    validationWarnings.push("Local delivery: no carrier or Shippo in this quote — shipping is $0.");
  }

  const requestAdminLocal = adminLocalDiscount && body?.applyEligibleLocalDiscount === true;
  const forceAdminLocal = requestAdminLocal && body?.forceApplyEligibleLocalDiscount === true;
  let pricingTier = "standard";
  let hardinDiscountApplied = false;
  let adminLocalDiscountForced = false;

  if (requestAdminLocal) {
    const zipOk = isHardinCountyTnDelivery(mergedAddress);
    if (!zipOk && !forceAdminLocal) {
      const baseQuote = await buildFullCheckoutQuote(items, mergedAddress, {
        pricingTier: "standard",
        shippingContext: null,
        flow: "admin_manual",
        receiptRebuild: true,
      });
      return withStockOverrideHint(
        {
          ...baseQuote,
          hardinDiscountApplied: false,
          adminLocalDiscountDeclined: true,
          adminLocalDiscountNeedsOverride: true,
          manualNoCarrierFulfillment: kind,
        },
        skipStockAssertion,
      );
    }
    pricingTier = "hardin";
    hardinDiscountApplied = true;
    adminLocalDiscountForced = Boolean(forceAdminLocal && !isHardinCountyTnDelivery(mergedAddress));
  }

  const quote = await buildFullCheckoutQuote(items, mergedAddress, {
    pricingTier,
    shippingContext: null,
    flow: "admin_manual",
    receiptRebuild: true,
  });

  const w = [
    ...validationWarnings,
    ...(Array.isArray(quote.warnings) ? quote.warnings : []),
  ];
  if (adminLocalDiscountForced) {
    w.push(
      "Staff override: local discount pricing applied even though this ZIP is outside the normal eligible area.",
    );
  }

  return withStockOverrideHint(
    {
      ...quote,
      warnings: w,
      hardinDiscountApplied,
      ...(adminLocalDiscountForced ? { adminLocalDiscountForced: true } : {}),
      manualNoCarrierFulfillment: kind,
    },
    skipStockAssertion,
  );
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
  const selectedShippingRateObjectId = String(body?.selectedShippingRateObjectId || "").trim() || null;
  const selectedShippingServiceCode = String(body?.selectedShippingServiceCode || "").trim() || null;
  const selectedShippingServiceLabel = String(body?.selectedShippingServiceLabel || "").trim() || null;
  const selectedShippingProvider = String(body?.selectedShippingProvider || "").trim() || null;
  const selectedShippingAmountCents =
    body?.selectedShippingAmountCents != null && Number.isFinite(Number(body.selectedShippingAmountCents))
      ? Math.max(0, Math.round(Number(body.selectedShippingAmountCents)))
      : null;
  const selectedShippingParcelCount =
    body?.selectedShippingParcelCount != null && Number.isFinite(Number(body.selectedShippingParcelCount))
      ? Math.max(0, Math.floor(Number(body.selectedShippingParcelCount)))
      : null;
  const selectedShippingResidentialSurchargeCents =
    body?.selectedShippingResidentialSurchargeCents != null &&
    Number.isFinite(Number(body.selectedShippingResidentialSurchargeCents))
      ? Math.max(0, Math.round(Number(body.selectedShippingResidentialSurchargeCents)))
      : null;
  const rateSelectionFromBody = {
    ...(selectedShippingRateObjectId ? { selectedShippingRateObjectId } : {}),
    ...(selectedShippingServiceCode ? { selectedShippingServiceCode } : {}),
    ...(selectedShippingServiceLabel ? { selectedShippingServiceLabel } : {}),
    ...(selectedShippingProvider ? { selectedShippingProvider } : {}),
    ...(selectedShippingAmountCents != null ? { selectedShippingAmountCents } : {}),
    ...(selectedShippingParcelCount != null ? { selectedShippingParcelCount } : {}),
    ...(selectedShippingResidentialSurchargeCents != null
      ? { selectedShippingResidentialSurchargeCents }
      : {}),
  };

  const items = Array.isArray(body?.items) ? body.items : [];
  if (!items.length) {
    throwHttpError("Your cart is empty.", 400);
  }

  assertCartItemsHaveValidSupportedSizeAllocation(items);

  const skipStockAssertion =
    opts.allowForceStockOverride === true && body?.forceStockOverride === true;
  if (!skipStockAssertion) {
    await assertStockAvailableForItems(items);
  }

  const rawFm = String(
    body?.fulfillmentMethod != null
      ? body.fulfillmentMethod
      : opts.manualFulfillment != null
        ? opts.manualFulfillment
        : "",
  )
    .trim()
    .toLowerCase();
  const isManualNoCarrier = rawFm === "pickup" || rawFm === "local_delivery" || rawFm === "local";
  if (isManualNoCarrier) {
    const m = rawFm === "local" ? "local_delivery" : rawFm;
    return buildManualNoCarrierQuote(body, { ...opts, manualFulfillment: m });
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
      ...rateSelectionFromBody,
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
    const addressStrict = opts.strictShippo === false ? false : true;
    const v = await validateShippingAddressForCheckout(parsed.address, {
      strictShippo: addressStrict,
    });
    v.submittedAddress = parsed.address;
    validationResultForQuote = v;
    if (!v.ok) {
      throwHttpError(v.error, 400, v.addressValidation, v.fieldErrors, {
        addressSuggestion: v.addressSuggestion,
        submittedAddress: v.submittedAddress,
      });
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
          ...rateSelectionFromBody,
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
    ...rateSelectionFromBody,
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
