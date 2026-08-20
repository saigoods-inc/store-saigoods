import { validateShippingAddressForCheckout } from "./address-validation.js";
import { buildFullCheckoutQuote, evaluateFreeDeliveryForItems } from "./checkout-totals.js";
import { parseEstimateAddressBody } from "./checkout-validation.js";
import { assertDiscountCodeAvailable, normalizeDiscountCode } from "./discount-codes.js";
import { isHardinCountyTnDelivery } from "./hardin-county.js";
import {
  PICKUP_ADDRESS_FOR_ORDER,
  buildLocalOrCarrierAddressForQuote,
  hasAnyAddressFields,
} from "./manual-order-fulfillment.js";
import { normalizeManualOrderDiscountInput } from "./manual-order-discount.js";
import { assertCartItemsHaveValidSupportedSizeAllocation } from "./quote.js";
import { assertStockAvailableForItems } from "./stock.js";
import { computeWalkInZeroShippingQuote } from "./walk-in-quote.js";
import { primeRuntimeStoreForItems } from "./runtime-store.js";
import { loadFreeDeliveryConfig } from "./free-delivery-settings.js";

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
    ...(Array.isArray(error.shippingRateOptions) ? { shippingRateOptions: error.shippingRateOptions } : {}),
    ...(error.shippingPackageLimit ? { shippingPackageLimit: error.shippingPackageLimit } : {}),
    ...(error.parcelSummary ? { parcelSummary: error.parcelSummary } : {}),
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
  const manualOrderDiscount = opts.manualOrderDiscount === true;
  const manualDiscount = manualOrderDiscount ? opts.manualDiscount : null;
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
    const a = body?.address;
    if (a && typeof a === "object" && hasAnyAddressFields(a)) {
      mergedAddress = buildLocalOrCarrierAddressForQuote(a);
    } else {
      mergedAddress = buildLocalOrCarrierAddressForQuote({
        line1: "Local delivery (address to be confirmed)",
        city: "Savannah",
        state: "TN",
        postalCode: "38372",
        country: "US",
      });
      validationWarnings.push("Add a delivery address when you have it; tax used a default local zone for now.");
    }
    validationWarnings.push("Local delivery: no carrier or Shippo in this quote — shipping is $0.");
  }

  let pricingTier = "standard";
  let hardinDiscountApplied = false;
  let adminLocalDiscountForced = false;

  const requestAdminLocal = !manualOrderDiscount && adminLocalDiscount && body?.applyEligibleLocalDiscount === true;
  const forceAdminLocal = requestAdminLocal && body?.forceApplyEligibleLocalDiscount === true;
  if (requestAdminLocal) {
    const zipOk = isHardinCountyTnDelivery(mergedAddress);
    if (!zipOk && !forceAdminLocal) {
      const baseQuote = await buildFullCheckoutQuote(items, mergedAddress, {
        pricingTier: "standard",
        shippingContext: null,
        flow: "admin_manual",
        receiptRebuild: true,
        ...(manualDiscount ? { manualDiscount } : {}),
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
    ...(manualDiscount ? { manualDiscount } : {}),
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
 * @param {object} body - { items, address, discountCode?, applyEligibleLocalDiscount?, forceApplyEligibleLocalDiscount?, manualDiscountType?, manualDiscountValue? }
 * @param {{ requireCompleteAddress?: boolean, adminLocalDiscount?: boolean, manualOrderDiscount?: boolean, adminSendLink?: boolean, walkInPickup?: boolean, strictShippo?: boolean, allowForceStockOverride?: boolean, allowManualB2bShipping?: boolean }} [opts]
 *   `allowForceStockOverride` — when true, `body.forceStockOverride` skips stock availability checks (staff only).
 *   When `adminLocalDiscount` is true, `discountCode` is ignored; use `applyEligibleLocalDiscount` only.
 *   `forceApplyEligibleLocalDiscount` (with checkbox on) skips ZIP eligibility and applies Hardin tier — staff only.
 *   When `manualOrderDiscount` is true, ZIP-based manual-order discounting is disabled and the explicit
 *   `manualDiscountType` / `manualDiscountValue` payload is applied to merchandise before tax.
 *   `walkInPickup` — walk-in admin flow: server-owned $0 shipping quote; local discount without ZIP checks.
 * @returns {Promise<object>} API-shaped estimate JSON
 */
export async function computeCheckoutEstimate(body, opts = {}) {
  await primeRuntimeStoreForItems(body?.items);
  let freeDeliveryConfig = opts.freeDeliveryConfig || null;
  async function getFreeDeliveryConfig() {
    if (!freeDeliveryConfig) freeDeliveryConfig = (await loadFreeDeliveryConfig()).config;
    return freeDeliveryConfig;
  }
  const requireCompleteAddress = opts.requireCompleteAddress === true;
  const adminLocalDiscount = opts.adminLocalDiscount === true;
  const manualOrderDiscount = opts.manualOrderDiscount === true;
  const adminSendLink = opts.adminSendLink === true;
  const walkInPickup = opts.walkInPickup === true;
  let adminLocalDiscountForced = false;
  let manualDiscount = null;
  let codeDiscount = null;
  if (manualOrderDiscount) {
    try {
      manualDiscount = normalizeManualOrderDiscountInput(body?.manualDiscountType, body?.manualDiscountValue);
    } catch (error) {
      throwHttpError(error?.message || "Discount selection is invalid.", error?.statusCode || 400);
    }
  }

  // Server-owned Walk-in mode: never trust browser fulfillmentMethod / carrier rate fields.
  if (walkInPickup) {
    return computeWalkInZeroShippingQuote(body || {}, opts);
  }

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
    return buildManualNoCarrierQuote(body, {
      ...opts,
      manualFulfillment: m,
      ...(manualDiscount ? { manualDiscount } : {}),
    });
  }
  const isManualB2b = rawFm === "b2b_shipping";
  let manualShippingAmountCents = null;
  if (isManualB2b) {
    if (opts.allowManualB2bShipping !== true) {
      throwHttpError("B2B shipping is only available in the admin order builder.", 400);
    }
    const value = Number(body?.manualB2bShippingCents);
    if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1 || value > 10_000_000) {
      throwHttpError("Enter a B2B freight charge between $0.01 and $100,000.00.", 400);
    }
    manualShippingAmountCents = value;
  }

  const parsed = parseEstimateAddressBody(body || {});
  if (parsed.error) {
    throwHttpError(parsed.error, 400, null, parsed.fieldErrors);
  }

  if (requireCompleteAddress && parsed.partial) {
    throwHttpError("Please provide a complete shipping address.", 400);
  }

  const discountRaw = adminLocalDiscount || manualOrderDiscount ? "" : String(body?.discountCode ?? "").trim();
  const normalizedCode = discountRaw ? normalizeDiscountCode(discountRaw) : null;
  if (discountRaw && !normalizedCode) {
    throwHttpError("Enter a valid discount code.", 400);
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

  const requestAdminLocal = !manualOrderDiscount && adminLocalDiscount && body?.applyEligibleLocalDiscount === true;
  const forceAdminLocal = requestAdminLocal && body?.forceApplyEligibleLocalDiscount === true;
  const preliminaryPricingTier = requestAdminLocal &&
    (forceAdminLocal || isHardinCountyTnDelivery(parsed.address))
    ? "hardin"
    : "standard";
  if (normalizedCode) {
    if (!isHardinCountyTnDelivery(parsed.address)) {
      throwHttpError("This discount code is invalid or not applicable to this address.", 400);
    }
    try {
      const codeDetails = await assertDiscountCodeAvailable(normalizedCode);
      codeDiscount = normalizeManualOrderDiscountInput("percent", Number(codeDetails?.percentOff) || 7);
    } catch (err) {
      throwHttpError(err.message || "Discount code is not valid.", err.statusCode || 400);
    }
  }
  const preliminaryFreeDelivery = !parsed.partial && !isManualB2b
    ? evaluateFreeDeliveryForItems(items, parsed.address, {
        pricingTier: preliminaryPricingTier,
        manualDiscount: manualDiscount || codeDiscount,
        freeDeliveryConfig: await getFreeDeliveryConfig(),
      })
    : null;

  let mergedAddress = parsed.address;
  let shippingContext = null;
  const validationWarnings = [];
  let validationResultForQuote = null;
  let addressSuggestion = null;

  if (!walkInPickup && !parsed.partial && preliminaryFreeDelivery?.eligible) {
    mergedAddress = parsed.address;
    shippingContext = { applyResidentialSurcharge: false, shippoUnavailable: false };
    validationResultForQuote = {
      ok: true,
      normalizedAddress: parsed.address,
      submittedAddress: parsed.address,
      shippingContext,
      addressValidation: {
        code: "local_delivery_eligible",
        messages: ["Eligible for free local delivery; carrier address validation was bypassed."],
      },
    };
  } else if (!walkInPickup && !parsed.partial) {
    const addressStrict = opts.strictShippo === false ? false : true;
    const quoteFlow = adminSendLink
      ? "admin_send_link"
      : adminLocalDiscount || manualOrderDiscount
        ? "admin_manual"
        : "checkout";
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
          freeDeliveryConfig: await getFreeDeliveryConfig(),
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
    pricingTier = "standard";
    hardinDiscountApplied = true;
  }

  const quoteWithFlow = await buildFullCheckoutQuote(items, mergedAddress, {
    pricingTier,
    shippingContext,
    flow: walkInPickup
      ? "admin_walk_in"
      : adminSendLink
        ? "admin_send_link"
        : adminLocalDiscount || manualOrderDiscount
          ? "admin_manual"
          : "checkout",
    addressValidationResult: validationResultForQuote,
    ...(manualDiscount || codeDiscount ? { manualDiscount: manualDiscount || codeDiscount } : {}),
    ...(manualShippingAmountCents != null ? { manualShippingAmountCents } : {}),
    ...(isManualB2b ? { allowB2BNegotiatedPricing: true } : {}),
    ...rateSelectionFromBody,
    freeDeliveryConfig: await getFreeDeliveryConfig(),
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
