import { isStrictUsZip } from "./address-validation.js";
import { getCheckoutResidentialSurchargeCents } from "./checkout-surcharge.js";
import { computeCheckoutSalesTaxSync } from "./sales-tax.js";
import { buildQuote, formatCurrency } from "./quote.js";
import { normalizeUsStateCode } from "./tax-us.js";
import { buildFulfillmentPackingPlan } from "./fulfillment-cartonization.js";
import { getLiveShippingQuote } from "./live-shipping-quote.js";
import { applyManualOrderDiscountToQuote } from "./manual-order-discount.js";
import { evaluateFreeDelivery } from "./free-delivery-settings.js";
import { applyB2BNegotiatedPricingToQuote } from "./b2b-negotiated-pricing.js";

export { getCheckoutResidentialSurchargeCents };

function buildMerchandiseQuote(items, opts = {}) {
  const pricingTier = opts.pricingTier === "hardin" ? "hardin" : "standard";
  let quote = buildQuote(items, { omitShippingEstimate: true, pricingTier });
  if (opts.manualDiscount && typeof opts.manualDiscount === "object") {
    quote = applyManualOrderDiscountToQuote(quote, opts.manualDiscount).quote;
  }
  return quote;
}

export function evaluateFreeDeliveryForItems(items, address, opts = {}) {
  const quote = buildMerchandiseQuote(items, opts);
  return evaluateFreeDelivery(opts.freeDeliveryConfig, {
    address,
    subtotalCents: quote.subtotalCents,
    items: quote.items,
  });
}

export function getShippingQuoteMode() {
  const raw = String(process.env.SHIPPING_QUOTE_MODE || "")
    .trim()
    .toLowerCase();
  if (raw === "baked_in") {
    return "baked_in";
  }
  return "live_ups";
}

/**
 * Storefront POST /api/checkout builds a receipt-rebuild quote (no live carrier rating).
 * That path is only safe when shipping is baked into merchandise (`baked_in`).
 * Under `live_ups` (default), address-based embedded checkout is required instead.
 */
export function isStorefrontPaymentLinkCompatibleWithShippingMode() {
  return getShippingQuoteMode() === "baked_in";
}

/** Cents added to the provider’s live line (e.g. $2.00 = 200). Not applied in baked_in / non-rated paths. */
export function getShippingBufferCents() {
  const raw = process.env.SHIPPING_BUFFER_CENTS;
  if (raw == null || String(raw).trim() === "") {
    return 200;
  }
  const n = parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(n) || n < 0) {
    return 200;
  }
  return n;
}

function normalizeFlow(flow) {
  const f = String(flow || "")
    .trim()
    .toLowerCase();
  if (
    f === "checkout" ||
    f === "admin_manual" ||
    f === "admin_walk_in" ||
    f === "admin_send_link"
  ) {
    return f;
  }
  return "checkout";
}

function mapAddressValidationShape(validationResult, fallbackStatus = "not_requested") {
  if (!validationResult || typeof validationResult !== "object") {
    return {
      status: fallbackStatus,
      normalizedAddress: null,
      suggestion: null,
      fieldErrors: {},
      messages: [],
      addressErrors: null,
      bannerMessage: null,
    };
  }

  const status = validationResult.ok
    ? "valid"
    : String(validationResult?.addressValidation?.code || "").trim().toLowerCase() === "unavailable"
      ? "unavailable"
      : "invalid";
  const messages = [];
  if (!validationResult.ok && validationResult.error) {
    messages.push(String(validationResult.error));
  }
  if (Array.isArray(validationResult?.addressValidation?.messages)) {
    messages.push(...validationResult.addressValidation.messages.map((m) => String(m || "")).filter(Boolean));
  }

  const av = validationResult.addressValidation && typeof validationResult.addressValidation === "object"
    ? validationResult.addressValidation
    : null;

  return {
    status,
    normalizedAddress: validationResult.normalizedAddress || null,
    suggestion: validationResult.addressSuggestion || null,
    submittedAddress:
      validationResult.submittedAddress && typeof validationResult.submittedAddress === "object"
        ? validationResult.submittedAddress
        : null,
    isResidential:
      validationResult.shippingContext && typeof validationResult.shippingContext === "object"
        ? validationResult.shippingContext.applyResidentialSurcharge === true
        : false,
    fieldErrors:
      validationResult.fieldErrors && typeof validationResult.fieldErrors === "object"
        ? validationResult.fieldErrors
        : {},
    messages,
    ...(av?.addressErrors && typeof av.addressErrors === "object" ? { addressErrors: av.addressErrors } : {}),
    ...(typeof av?.bannerMessage === "string" && av.bannerMessage.trim()
      ? { bannerMessage: av.bannerMessage.trim() }
      : {}),
  };
}

/** Same completeness rule as {@link parseEstimateAddressBody} — do not call UPS until the shopper has a full ship-to. */
function isAddressCompleteForLiveUpsQuote(addr) {
  const a = addr && typeof addr === "object" ? addr : {};
  const line1 = String(a.line1 || "").trim();
  const city = String(a.city || "").trim();
  const state = String(a.state || "").trim().toUpperCase();
  const postalCode = String(a.postalCode || "").trim();
  const country = String(a.country || "US").trim().toUpperCase() || "US";
  const coreFilled = line1.length > 0 && city.length > 0 && /^[A-Z]{2}$/.test(state) && country === "US";
  return coreFilled && isStrictUsZip(postalCode);
}

function tryBuildParcelSummary(items) {
  try {
    const plan = buildFulfillmentPackingPlan({ items: Array.isArray(items) ? items : [] });
    const parcels = Array.isArray(plan.parcels) ? plan.parcels : [];
    return {
      parcelSummary: {
        source: plan.source || "cartonization",
        planId: plan.planId || null,
        parcelCount: parcels.length,
        parcels,
        fulfillmentUnits: Array.isArray(plan.fulfillmentUnits) ? plan.fulfillmentUnits : [],
        parcelContents: Array.isArray(plan.parcelContents) ? plan.parcelContents : [],
        candidates: Array.isArray(plan.candidates) ? plan.candidates : [],
      },
      warning: null,
    };
  } catch (err) {
    return {
      parcelSummary: {
        source: "cartonization",
        parcelCount: 0,
        parcels: [],
      },
      warning: String(err?.message || "Could not build parcel summary."),
    };
  }
}

/**
 * Full cart quote: merchandise from catalog, live carrier line + buffer when SHIPPING_QUOTE_MODE is live (default), optional residential surcharge, TN sales tax.
 * @param {Array} items - cart lines
 * @param {{ line1?: string, line2?: string, city?: string, state?: string, postalCode?: string, country?: string }} address
 * @param {{
 *   pricingTier?: "standard" | "hardin",
 *   shippingContext?: { applyResidentialSurcharge: boolean, shippoUnavailable: boolean } | null,
 *   receiptRebuild?: boolean,
 *   selectedShippingRateObjectId?: string | null,
 *   selectedShippingServiceCode?: string | null,
 *   selectedShippingServiceLabel?: string | null,
 *   selectedShippingProvider?: string | null,
 *   selectedShippingAmountCents?: number | null,
 *   selectedShippingParcelCount?: number | null,
 *   selectedShippingResidentialSurchargeCents?: number | null,
 *   strictShippoForLiveQuote?: boolean,
 *   addressValidationResult?: object | null,
 *   manualShippingAmountCents?: number | null,
 *   freeDeliveryConfig?: object | null,
 * }} [opts]
 *   `selectedShippingRateObjectId` — Shippo rate `object_id` (or `ups:…` id) from a prior `shippingRateOptions` list; live quote only.
 *   `selectedShippingServiceCode` / `selectedShippingServiceLabel` / `selectedShippingProvider` / `selectedShippingAmountCents`
 *   (and optional parcel/surcharge hints) — manual order only: re-match when Shippo returns new rate `object_id`s for the same service line.
 *   `strictShippoForLiveQuote` — if set, overrides per-flow Shippo address strictness inside the live-rating call (rare; prefer flow + provider config).
 *   `shippingContext` — from {@link validateShippingAddressForCheckout}; `null` = no fee lines (partial / walk-in).
 *   `receiptRebuild` — merchandise + tax math only; shipping cents stay zero here (caller overlays paid totals).
 */
export async function buildFullCheckoutQuote(items, address, opts = {}) {
  const addr = address && typeof address === "object" ? address : {};
  const pricingTier = opts.pricingTier === "hardin" ? "hardin" : "standard";
  const receiptRebuild = opts.receiptRebuild === true;
  const shippingContext = opts.shippingContext && typeof opts.shippingContext === "object" ? opts.shippingContext : null;
  const requestedFlow = normalizeFlow(opts.flow);
  const shippingMode = getShippingQuoteMode();
  let addressValidationShape = mapAddressValidationShape(
    opts.addressValidationResult,
    shippingContext ? "valid" : "not_requested",
  );

  const quoteOpts = { omitShippingEstimate: true, pricingTier };
  let quote = buildQuote(items, quoteOpts);

  const negotiatedPricing = applyB2BNegotiatedPricingToQuote(quote, items, {
    enabled: opts.allowB2BNegotiatedPricing === true,
  });
  quote = negotiatedPricing.quote;

  let discountBreakdown = {};
  if (opts.manualDiscount && typeof opts.manualDiscount === "object") {
    if (negotiatedPricing.applied) {
      const error = new Error("Negotiated B2B prices cannot be combined with another discount.");
      error.statusCode = 400;
      throw error;
    }
    const blockedByVolumePricing = quote.items?.find(
      (item) => item?.volumePricing && item.volumePricing.allowDiscountStacking !== true,
    );
    if (blockedByVolumePricing) {
      const error = new Error("This automatic volume price cannot be combined with another discount.");
      error.statusCode = 400;
      throw error;
    }
    const manualDiscountResult = applyManualOrderDiscountToQuote(quote, opts.manualDiscount);
    quote = manualDiscountResult.quote;
    discountBreakdown = manualDiscountResult.discountBreakdown;
  } else if (pricingTier === "hardin") {
    const standardQuote = buildQuote(items, { ...quoteOpts, pricingTier: "standard" });
    const originalCents = standardQuote.subtotalCents;
    const discountCents = Math.max(0, originalCents - quote.subtotalCents);
    discountBreakdown = {
      originalMerchandiseSubtotalCents: originalCents,
      originalMerchandiseSubtotalFormatted: formatCurrency(originalCents),
      merchandiseDiscountCents: discountCents,
      merchandiseDiscountFormatted: formatCurrency(discountCents),
    };
  }

  let warningList = [];
  let shippingBlock = null;
  let parcelSummary = null;
  let userFacingError = null;
  let canCheckout = true;
  let shippingRateOptions = [];
  const manualShippingAmountCents =
    opts.manualShippingAmountCents != null && Number.isFinite(Number(opts.manualShippingAmountCents))
      ? Math.max(0, Math.round(Number(opts.manualShippingAmountCents)))
      : null;

  let freeDelivery = evaluateFreeDelivery(opts.freeDeliveryConfig, {
    address: addr,
    subtotalCents: quote.subtotalCents,
    items: quote.items,
  });

  if (!receiptRebuild && manualShippingAmountCents == null && freeDelivery.eligible) {
    shippingBlock = {
      mode: "local_delivery",
      quoteStatus: "local_delivery",
      serviceCode: "local_delivery",
      serviceLabel: "Free local delivery",
      amountCents: 0,
      amountFormatted: formatCurrency(0),
      currency: "USD",
      residentialSurchargeCents: 0,
      residentialSurchargeFormatted: formatCurrency(0),
      taxableShippingCents: 0,
      provider: "local",
      providerQuoteId: "local_delivery",
    };
    const parcels = tryBuildParcelSummary(items);
    parcelSummary = parcels.parcelSummary;
    if (parcels.warning) warningList.push(parcels.warning);
    shippingRateOptions = [{
      id: "local_delivery",
      provider: "local",
      serviceCode: "local_delivery",
      serviceLabel: "Free local delivery",
      amountCents: 0,
      amountFormatted: formatCurrency(0),
      totalAmountCents: 0,
      totalAmountFormatted: formatCurrency(0),
      automatic: true,
      parcelCount: Math.max(0, Number(parcelSummary?.parcelCount) || 0),
    }];
    freeDelivery = {
      ...freeDelivery,
      applied: true,
      fulfillmentMethod: "local_delivery",
      carrierBypassed: true,
      customerShippingDiscountCents: 0,
      customerShippingDiscountFormatted: formatCurrency(0),
    };
  } else if (!receiptRebuild && manualShippingAmountCents != null) {
    shippingBlock = {
      mode: "manual_b2b",
      quoteStatus: "manual",
      serviceCode: "b2b_freight",
      serviceLabel: "B2B freight",
      amountCents: manualShippingAmountCents,
      amountFormatted: formatCurrency(manualShippingAmountCents),
      currency: "USD",
      residentialSurchargeCents: 0,
      residentialSurchargeFormatted: formatCurrency(0),
      taxableShippingCents: manualShippingAmountCents,
      provider: "external",
      providerQuoteId: null,
    };
    const parcels = tryBuildParcelSummary(items);
    parcelSummary = parcels.parcelSummary;
    if (parcels.warning) warningList.push(parcels.warning);
  } else if (!receiptRebuild && shippingMode === "live_ups") {
    if (!isAddressCompleteForLiveUpsQuote(addr)) {
      canCheckout = false;
      userFacingError = null;
      addressValidationShape = mapAddressValidationShape(null, "not_requested");
      shippingBlock = {
        mode: "live_ups",
        quoteStatus: "not_requested",
        serviceCode: null,
        serviceLabel: null,
        amountCents: 0,
        amountFormatted: formatCurrency(0),
        currency: "USD",
        residentialSurchargeCents: 0,
        residentialSurchargeFormatted: formatCurrency(0),
        taxableShippingCents: 0,
        provider: "none",
        providerQuoteId: null,
      };
      const parcels = tryBuildParcelSummary(items);
      parcelSummary = parcels.parcelSummary;
      if (parcels.warning) {
        warningList.push(parcels.warning);
      }
    } else {
      const liveQuote = await getLiveShippingQuote({
        address: addr,
        cartItems: items,
        flow: requestedFlow,
        selectedRateObjectId: opts.selectedShippingRateObjectId || null,
        selectedServiceCode: opts.selectedShippingServiceCode || null,
        selectedServiceLabel: opts.selectedShippingServiceLabel || null,
        selectedProvider: opts.selectedShippingProvider || null,
        selectedAmountCents: opts.selectedShippingAmountCents != null ? Number(opts.selectedShippingAmountCents) : null,
        selectedParcelCount:
          opts.selectedShippingParcelCount != null ? Number(opts.selectedShippingParcelCount) : null,
        selectedResidentialSurchargeCents:
          opts.selectedShippingResidentialSurchargeCents != null
            ? Number(opts.selectedShippingResidentialSurchargeCents)
            : null,
        strictShippo: typeof opts.strictShippoForLiveQuote === "boolean" ? opts.strictShippoForLiveQuote : null,
        addressValidationResult: opts.addressValidationResult || null,
      });
      shippingBlock = liveQuote.shipping;
      parcelSummary = liveQuote.parcelSummary;
      canCheckout = Boolean(liveQuote.canCheckout);
      userFacingError = liveQuote.userFacingError || null;
      shippingRateOptions = Array.isArray(liveQuote.shippingRateOptions) ? liveQuote.shippingRateOptions : [];
      warningList = [...(Array.isArray(liveQuote.warnings) ? liveQuote.warnings : [])];
      if (liveQuote.addressValidation && typeof liveQuote.addressValidation === "object") {
        addressValidationShape = liveQuote.addressValidation;
      }
    }
  } else {
    /** Baked-in mode: merchandise prices include shipping; only explicit surcharge is shown separately. */
    const baseShippingCents = 0;
    let residentialSurchargeCents = 0;
    if (!receiptRebuild && shippingContext?.applyResidentialSurcharge) {
      residentialSurchargeCents = getCheckoutResidentialSurchargeCents();
    }
    const shippingAmountCents = baseShippingCents;
    const shippingTotalCents = shippingAmountCents + residentialSurchargeCents;
    shippingBlock = {
      mode: "baked_in",
      quoteStatus: "included_in_merchandise",
      serviceCode: null,
      serviceLabel: null,
      amountCents: shippingAmountCents,
      amountFormatted: formatCurrency(shippingAmountCents),
      currency: "USD",
      residentialSurchargeCents,
      residentialSurchargeFormatted: formatCurrency(residentialSurchargeCents),
      taxableShippingCents: residentialSurchargeCents,
      provider: "none",
      providerQuoteId: null,
    };
    const parcels = tryBuildParcelSummary(items);
    parcelSummary = parcels.parcelSummary;
    if (parcels.warning) {
      warningList.push(parcels.warning);
    }
  }

  if (shippingBlock && typeof shippingBlock === "object") {
    const prov = String(shippingBlock.provider || "")
      .trim()
      .toLowerCase();
    const liveProvider = prov === "shippo" || prov === "ups";
    if (!receiptRebuild && shippingMode === "live_ups" && String(shippingBlock.quoteStatus) === "rated" && liveProvider) {
      const baseAmountCents = Math.max(0, Math.round(Number(shippingBlock.amountCents) || 0));
      const bufferCents = getShippingBufferCents();
      const finalLineCents = baseAmountCents + bufferCents;
      const res = Math.max(0, Math.round(Number(shippingBlock.residentialSurchargeCents) || 0));
      shippingRateOptions = shippingRateOptions.map((rate) => {
        const rateBaseCents = Math.max(0, Math.round(Number(rate?.amountCents) || 0));
        const rateTotalCents = rateBaseCents + bufferCents + res;
        return {
          ...rate,
          bufferCents,
          bufferFormatted: formatCurrency(bufferCents),
          totalAmountCents: rateTotalCents,
          totalAmountFormatted: formatCurrency(rateTotalCents),
          residentialSurchargeCents: res,
          residentialSurchargeFormatted: formatCurrency(res),
        };
      });
      shippingBlock = {
        ...shippingBlock,
        baseAmountCents,
        bufferCents,
        amountCents: finalLineCents,
        amountFormatted: formatCurrency(finalLineCents),
        taxableShippingCents: finalLineCents + res,
      };
    } else {
      const ac = Math.max(0, Math.round(Number(shippingBlock.amountCents) || 0));
      shippingBlock = {
        ...shippingBlock,
        baseAmountCents: ac,
        bufferCents: 0,
      };
    }
  }

  const state = normalizeUsStateCode(addr.state);
  const shippingCents =
    Math.max(0, Number(shippingBlock?.amountCents) || 0) +
    Math.max(0, Number(shippingBlock?.residentialSurchargeCents) || 0);
  const shippingResidentialApplied = Math.max(0, Number(shippingBlock?.residentialSurchargeCents) || 0) > 0;

  const taxMeta = computeCheckoutSalesTaxSync(
    state,
    quote.subtotalCents,
    Math.max(0, Number(shippingBlock?.taxableShippingCents) || 0),
  );
  const taxCents = taxMeta.taxCents;
  const totalCents = quote.subtotalCents + shippingCents + taxCents;
  const normalizedWarnings = warningList.filter(Boolean);

  const quoteResponse = {
    quoteVersion: "v1",
    flow: requestedFlow,
    currency: "USD",
    merchandise: {
      subtotalCents: quote.subtotalCents,
      subtotalFormatted: formatCurrency(quote.subtotalCents),
      discountCents: Math.max(0, Number(discountBreakdown.merchandiseDiscountCents) || 0),
      discountFormatted: formatCurrency(Math.max(0, Number(discountBreakdown.merchandiseDiscountCents) || 0)),
      originalSubtotalCents:
        discountBreakdown.originalMerchandiseSubtotalCents != null
          ? Math.max(0, Number(discountBreakdown.originalMerchandiseSubtotalCents) || 0)
          : null,
      originalSubtotalFormatted: discountBreakdown.originalMerchandiseSubtotalFormatted || null,
      manualDiscount: quote.manualDiscount || null,
    },
    shipping: {
      ...shippingBlock,
      mode: !receiptRebuild ? shippingBlock?.mode || shippingMode : "baked_in",
      amountFormatted: formatCurrency(Math.max(0, Number(shippingBlock?.amountCents) || 0)),
      residentialSurchargeFormatted: formatCurrency(
        Math.max(0, Number(shippingBlock?.residentialSurchargeCents) || 0),
      ),
    },
    tax: {
      amountCents: taxCents,
      amountFormatted: formatCurrency(taxCents),
      rateBps: taxMeta.taxRateBps,
      source: taxMeta.taxSource,
      taxableBaseCents: taxMeta.taxableBaseCents,
    },
    totals: {
      subtotalCents: quote.subtotalCents,
      shippingCents,
      taxCents,
      totalCents,
      totalFormatted: formatCurrency(totalCents),
    },
    parcelSummary,
    addressValidation: addressValidationShape,
    warnings: normalizedWarnings,
    userFacingError,
    canCheckout: Boolean(canCheckout && !userFacingError),
    shippingRateOptions,
    freeDelivery,
  };

  return {
    ...quoteResponse,
    items: quote.items,
    subtotalCents: quote.subtotalCents,
    subtotalFormatted: formatCurrency(quote.subtotalCents),
    shippingCents,
    shippingFormatted: formatCurrency(shippingCents),
    shippingZone:
      quoteResponse.shipping?.shippingZone != null
        ? Number(quoteResponse.shipping.shippingZone)
        : null,
    shippingMode: quoteResponse.shipping.mode,
    shippingQuoteStatus: quoteResponse.shipping.quoteStatus,
    baseShippingCents: Math.max(0, Number(quoteResponse.shipping.amountCents) || 0),
    baseShippingFormatted: formatCurrency(Math.max(0, Number(quoteResponse.shipping.amountCents) || 0)),
    residentialSurchargeCents: Math.max(0, Number(quoteResponse.shipping.residentialSurchargeCents) || 0),
    residentialSurchargeFormatted: formatCurrency(
      Math.max(0, Number(quoteResponse.shipping.residentialSurchargeCents) || 0),
    ),
    shippingResidentialApplied,
    manualDiscount: quote.manualDiscount || null,
    ...discountBreakdown,
    taxCents,
    taxFormatted: formatCurrency(taxCents),
    totalCents,
    totalFormatted: formatCurrency(totalCents),
    destinationState: state,
    taxRateConfigured: taxMeta.taxRateConfigured,
    taxSource: taxMeta.taxSource,
    taxableBaseCents: taxMeta.taxableBaseCents,
    showTaxAddressHint: false,
    taxHint: null,
    warnings: normalizedWarnings,
    userFacingError,
    canCheckout: quoteResponse.canCheckout,
    shippingRateOptions: quoteResponse.shippingRateOptions,
    freeDelivery,
  };
}

export function formatShippingAddressForOrder(addr) {
  const a = addr && typeof addr === "object" ? addr : {};
  const line1 = String(a.line1 || "").trim();
  const line2 = String(a.line2 || "").trim();
  const city = String(a.city || "").trim();
  const st = String(a.state || "").trim().toUpperCase();
  const zip = String(a.postalCode || "").trim();
  const country = String(a.country || "US").trim() || "US";

  const cityLine = [city, st, zip].filter(Boolean).join(", ");
  const parts = [line1, line2, cityLine, country].filter(Boolean);
  return parts.join("\n").trim() || null;
}
