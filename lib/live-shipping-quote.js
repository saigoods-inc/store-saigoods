import { validateShippingAddressForCheckout } from "./address-validation.js";
import { getCheckoutResidentialSurchargeCents } from "./checkout-surcharge.js";
import {
  buildFulfillmentPackingPlan,
  loadRuntimeFulfillmentPackagingConfig,
} from "./fulfillment-cartonization.js";
import { formatCurrency } from "./quote.js";
import { isCheckoutShippoLogEnabled } from "./shippo.js";
import { getShippingRateProviderId, getShippingRateQuote } from "./shipping-rate-provider.js";
import { parseShippoCarrierAccountIds } from "./shippo-shipment-sync.js";
import {
  buildInternalCheckoutShippingQuote,
  isInternalCheckoutPricingEnabled,
} from "./internal-shipping-rate.js";
import { selectCheckoutShippingChoices } from "./checkout-shipping-options.js";
import { shippingPackageLimitState } from "./shipping-package-limit.js";

const UPS_SERVICE_LABEL_FALLBACK = {
  "01": "UPS Next Day Air",
  "02": "UPS 2nd Day Air",
  "03": "UPS Ground",
  "07": "UPS Worldwide Express",
  "08": "UPS Worldwide Expedited",
  "11": "UPS Standard",
  "12": "UPS 3 Day Select",
  "13": "UPS Next Day Air Saver",
  "14": "UPS Next Day Air Early",
  "54": "UPS Worldwide Express Plus",
  "59": "UPS 2nd Day Air A.M.",
  "65": "UPS Saver",
};

/**
 * Per-package residential delivery surcharge × parcel count.
 * Reads CHECKOUT_RESIDENTIAL_SURCHARGE_USD at call time (default $6.50 / 650¢).
 * @param {boolean} isResidential
 * @param {number} parcelCount
 * @returns {number}
 */
export function computeResidentialSurchargeCents(isResidential, parcelCount) {
  const packages = Math.max(0, Math.floor(Number(parcelCount) || 0));
  if (!isResidential || packages < 1) {
    return 0;
  }
  return packages * getCheckoutResidentialSurchargeCents();
}

function normalizeFlow(flow) {
  const f = String(flow || "").trim().toLowerCase();
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

function strictShippoForFlow(flow) {
  const f = normalizeFlow(flow);
  // Match public checkout: invalid street must not pass on ZIP alone; staff carrier quotes use the same Shippo path.
  return f === "checkout" || f === "admin_manual" || f === "admin_send_link";
}

function requiresConfiguredShippoCarrierAccount(flow) {
  const f = normalizeFlow(flow);
  // Public checkout should not expose arbitrary sandbox carrier mixes. Admin quotes need every returned rate while testing.
  return f === "checkout";
}

function isUspsRate(rate) {
  const provider = String(rate?.provider || "").trim().toUpperCase();
  return provider === "USPS" || provider.includes("USPS");
}

function envFlagEnabled(raw, fallback) {
  const v = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (!v) {
    return fallback;
  }
  if (["0", "false", "off", "no", "disabled"].includes(v)) {
    return false;
  }
  if (["1", "true", "on", "yes", "enabled"].includes(v)) {
    return true;
  }
  return fallback;
}

function parseUsdCents(raw, fallbackCents) {
  const n = Number.parseFloat(String(raw ?? ""));
  if (!Number.isFinite(n) || n < 0) {
    return fallbackCents;
  }
  return Math.round(n * 100);
}

function liveShippingFallbackEnabled(flow, hasSelectedShippingRate = false) {
  if (hasSelectedShippingRate) {
    return false;
  }
  // Backup pricing is a business decision and must be explicitly enabled.
  return normalizeFlow(flow) === "checkout" && envFlagEnabled(process.env.CHECKOUT_LIVE_SHIPPING_FALLBACK, false);
}

function publicShippingUnavailableMessage() {
  return "Shipping options are temporarily unavailable. Please try again.";
}

function fallbackShippingAmountCents(parcels) {
  const rows = Array.isArray(parcels) ? parcels : [];
  const parcelCount = Math.max(1, rows.length);
  const totalWeightLb = rows.reduce((sum, parcel) => {
    const unit = String(parcel?.mass_unit || parcel?.massUnit || "lb").trim().toLowerCase();
    const weight = Math.max(0, Number(parcel?.weight) || 0);
    if (unit === "oz" || unit === "ounce" || unit === "ounces") {
      return sum + weight / 16;
    }
    return sum + weight;
  }, 0);
  const baseCents = parseUsdCents(process.env.CHECKOUT_FALLBACK_BASE_USD, 995);
  const extraParcelCents = parseUsdCents(process.env.CHECKOUT_FALLBACK_EXTRA_PARCEL_USD, 500);
  const perPoundCents = parseUsdCents(process.env.CHECKOUT_FALLBACK_PER_LB_USD, 75);
  const minimumCents = parseUsdCents(process.env.CHECKOUT_FALLBACK_MIN_USD, 995);
  const roundedWeightLb = Math.max(1, Math.ceil(totalWeightLb));
  return Math.max(
    minimumCents,
    baseCents + Math.max(0, parcelCount - 1) * extraParcelCents + roundedWeightLb * perPoundCents,
  );
}

function shippingFromFallbackRate({ parcels, parcelSummary, validation, reason }) {
  const amountCents = fallbackShippingAmountCents(parcels);
  const parcelCount = Math.max(0, Math.floor(Number(Array.isArray(parcels) ? parcels.length : 0)));
  const isResidential = validation?.shippingContext?.applyResidentialSurcharge === true;
  return {
    shipping: {
      mode: "live_ups",
      quoteStatus: "rated",
      serviceCode: "FALLBACK_STANDARD_GROUND",
      serviceLabel: "Standard Ground",
      amountCents,
      amountFormatted: formatCurrency(amountCents),
      currency: "USD",
      residentialSurchargeCents: 0,
      residentialSurchargeFormatted: formatCurrency(0),
      taxableShippingCents: amountCents,
      provider: "fallback",
      providerQuoteId: null,
      addressIsResidential: isResidential,
      residentialSurchargePerPackageCents: getCheckoutResidentialSurchargeCents(),
      residentialSurchargePackageCount: parcelCount,
      fallbackReason: String(reason || "carrier_unavailable"),
    },
    shippingRateOptions: [
      {
        id: "fallback:standard_ground",
        provider: "fallback",
        serviceCode: "FALLBACK_STANDARD_GROUND",
        serviceLabel: "Standard Ground",
        amountCents,
        amountFormatted: formatCurrency(amountCents),
        totalAmountCents: amountCents,
        totalAmountFormatted: formatCurrency(amountCents),
        residentialSurchargeCents: 0,
        residentialSurchargeFormatted: formatCurrency(0),
        currency: "USD",
        estimatedDays: null,
      },
    ],
    parcelSummary: {
      ...(parcelSummary && typeof parcelSummary === "object" ? parcelSummary : emptyParcelSummary()),
      source: parcelSummary?.source || "computed",
      fallbackRated: true,
      fallbackReason: String(reason || "carrier_unavailable"),
    },
    userFacingError: null,
    canCheckout: true,
  };
}

function compactAddressSummary(addr) {
  const a = addr && typeof addr === "object" ? addr : {};
  const line1 = String(a.line1 || "").trim();
  return {
    city: String(a.city || "").trim(),
    state: String(a.state || "").trim().toUpperCase(),
    postalCode: String(a.postalCode || "").trim(),
    line1Len: line1.length,
  };
}

function toAddressValidationShape({
  status,
  normalizedAddress = null,
  suggestion = null,
  fieldErrors = {},
  messages = [],
  addressErrors = null,
  bannerMessage = null,
}) {
  return {
    status,
    normalizedAddress,
    suggestion,
    fieldErrors: fieldErrors && typeof fieldErrors === "object" ? fieldErrors : {},
    messages: Array.isArray(messages) ? messages.filter(Boolean) : [],
    ...(addressErrors && typeof addressErrors === "object" ? { addressErrors } : {}),
    ...(typeof bannerMessage === "string" && bannerMessage.trim() ? { bannerMessage: bannerMessage.trim() } : {}),
  };
}

function emptyParcelSummary() {
  return {
    source: "computed",
    parcelCount: 0,
    parcels: [],
  };
}

function buildCheckoutPackingPlan(orderRow, config) {
  const plan = buildFulfillmentPackingPlan(orderRow, { config });
  const parcels = Array.isArray(plan.parcels) ? plan.parcels : [];
  return {
    parcels,
    source: plan.source || "cartonization",
    planId: plan.planId || null,
    fulfillmentUnits: Array.isArray(plan.fulfillmentUnits) ? plan.fulfillmentUnits : [],
    parcelContents: Array.isArray(plan.parcelContents) ? plan.parcelContents : [],
    candidates: Array.isArray(plan.candidates) ? plan.candidates : [],
  };
}

function parcelSummaryFromPlan(parcelPlan, extras = {}) {
  const plan = parcelPlan && typeof parcelPlan === "object" ? parcelPlan : {};
  const parcels = Array.isArray(plan.parcels) ? plan.parcels : [];
  return {
    source: plan.source || "cartonization",
    planId: plan.planId || null,
    parcelCount: parcels.length,
    parcels,
    fulfillmentUnits: Array.isArray(plan.fulfillmentUnits) ? plan.fulfillmentUnits : [],
    parcelContents: Array.isArray(plan.parcelContents) ? plan.parcelContents : [],
    candidates: Array.isArray(plan.candidates) ? plan.candidates : [],
    ...extras,
  };
}

function shippingFromFailure({
  quoteStatus,
  message,
  residentialSurchargeCents = 0,
  residentialSurchargePackageCount = 0,
  addressIsResidential = false,
}) {
  const surcharge = Math.max(0, Math.round(Number(residentialSurchargeCents) || 0));
  const packageCount = Math.max(0, Math.floor(Number(residentialSurchargePackageCount) || 0));
  return {
    shipping: {
      mode: "live_ups",
      quoteStatus,
      serviceCode: null,
      serviceLabel: null,
      amountCents: 0,
      amountFormatted: formatCurrency(0),
      currency: "USD",
      residentialSurchargeCents: surcharge,
      residentialSurchargeFormatted: formatCurrency(surcharge),
      taxableShippingCents: surcharge,
      provider: getShippingRateProviderId(),
      providerQuoteId: null,
      addressIsResidential: addressIsResidential === true,
      residentialSurchargePerPackageCents: getCheckoutResidentialSurchargeCents(),
      residentialSurchargePackageCount: packageCount,
    },
    userFacingError: message || null,
    canCheckout: false,
  };
}

function serviceLabelWithFallback(rate) {
  const code = String(rate?.serviceCode || "").trim();
  const providerLabel = String(rate?.serviceLabel || "").trim();
  if (providerLabel) {
    return providerLabel;
  }
  return UPS_SERVICE_LABEL_FALLBACK[code] || null;
}

function shippingServiceRank(rate) {
  const code = String(rate?.serviceCode || "").trim().toLowerCase();
  const label = String(rate?.serviceLabel || "").trim().toLowerCase();
  const service = `${code} ${label}`;
  if (service.includes("ground saver")) return 10;
  if (service.includes("ground advantage")) return 15;
  if (code === "03" || /(^|\s)ground(®|™)?$/.test(service)) return 20;
  if (service.includes("3 day") || service.includes("3-day")) return 30;
  if (service.includes("2nd day") || service.includes("2 day") || service.includes("2-day")) return 40;
  if (service.includes("next day") && service.includes("saver")) return 50;
  if (service.includes("next day") && service.includes("early")) return 70;
  if (service.includes("next day")) return 60;
  return 100;
}

/** Keep carrier services in a predictable shopper-facing order across fresh Shippo responses. */
export function orderShippingRateOptions(options) {
  return [...(Array.isArray(options) ? options : [])].sort((a, b) => {
    const rankDifference = shippingServiceRank(a) - shippingServiceRank(b);
    if (rankDifference) return rankDifference;

    const daysA = Number.isFinite(Number(a?.estimatedDays)) ? Number(a.estimatedDays) : -1;
    const daysB = Number.isFinite(Number(b?.estimatedDays)) ? Number(b.estimatedDays) : -1;
    if (daysA !== daysB) return daysB - daysA;

    const providerDifference = String(a?.provider || "").localeCompare(String(b?.provider || ""));
    if (providerDifference) return providerDifference;
    const labelDifference = String(a?.serviceLabel || "").localeCompare(String(b?.serviceLabel || ""));
    if (labelDifference) return labelDifference;
    return String(a?.serviceCode || "").localeCompare(String(b?.serviceCode || ""));
  });
}

function buildShippingRateOptions(allRates, residentialSurchargeCents) {
  const surcharge = Math.max(0, Math.round(Number(residentialSurchargeCents) || 0));
  const options = (Array.isArray(allRates) ? allRates : []).map((o) => {
    const baseAmountCents = Math.max(0, Math.round(Number(o?.amountCents) || 0));
    const totalAmountCents = baseAmountCents + surcharge;
    return {
      id: String(o?.id || "").trim(),
      provider: o?.provider,
      serviceCode: o?.serviceCode,
      serviceLabel: o?.serviceLabel,
      amountCents: baseAmountCents,
      amountFormatted: formatCurrency(baseAmountCents),
      totalAmountCents,
      totalAmountFormatted: formatCurrency(totalAmountCents),
      residentialSurchargeCents: surcharge,
      residentialSurchargeFormatted: formatCurrency(surcharge),
      currency: o?.currency,
      estimatedDays: o?.estimatedDays != null && Number.isFinite(Number(o.estimatedDays)) ? Number(o.estimatedDays) : null,
      packageRateObjectIds: Array.isArray(o?.packageRateObjectIds) ? o.packageRateObjectIds : [],
      packageShipmentObjectIds: Array.isArray(o?.packageShipmentObjectIds) ? o.packageShipmentObjectIds : [],
    };
  });
  return orderShippingRateOptions(options);
}

/**
 * Shared live UPS quote component (Phase 2B, no totals/tax integration yet).
 * Returns QuoteResponseV1-aligned sections used by the future shared quote engine.
 * @param {object} p
 * @param {string} [p.selectedRateObjectId] Shippo rate `object_id` or `ups:…` id; must exist in the latest allRates
 * @param {string} [p.selectedServiceCode] When re-rating, Shippo may return new rate `object_id`s; manual order can match by this + {@link p.selectedProvider} (same list row).
 * @param {string} [p.selectedServiceLabel] Manual-order fallback service label when service code is not enough.
 * @param {string} [p.selectedProvider] e.g. `ups` / `usps`
 * @param {number} [p.selectedAmountCents] Disambiguate duplicate service lines (optional)
 * @param {number} [p.selectedParcelCount] Optional hint from the selected rate context.
 * @param {number} [p.selectedResidentialSurchargeCents] Optional hint from selected residential surcharge.
 * @param {boolean} [p.strictShippo] Override strict Shippo address validation (default: per-flow)
 * @param {object} [p.addressValidationResult] Already-completed validation from the calling checkout flow.
 */
export async function getLiveShippingQuote({
  address,
  cartItems,
  flow,
  selectedRateObjectId: selectedRateIdRaw = null,
  selectedServiceCode: selectedServiceCodeRaw = null,
  selectedServiceLabel: selectedServiceLabelRaw = null,
  selectedProvider: selectedProviderRaw = null,
  selectedAmountCents: selectedAmountCentsRaw = null,
  selectedParcelCount: selectedParcelCountRaw = null,
  selectedResidentialSurchargeCents: selectedResidentialSurchargeCentsRaw = null,
  strictShippo: strictOverride = null,
  addressValidationResult: prevalidatedAddress = null,
}) {
  const requestedFlow = normalizeFlow(flow);
  const strictShippo =
    typeof strictOverride === "boolean" ? strictOverride : strictShippoForFlow(requestedFlow);
  const selectedRateObjectId = String(selectedRateIdRaw || "").trim() || null;
  const selectedServiceCode = String(selectedServiceCodeRaw || "").trim() || null;
  const selectedServiceLabel = String(selectedServiceLabelRaw || "").trim() || null;
  const selectedProvider = String(selectedProviderRaw || "").trim() || null;
  const selectedAmountCents = Math.max(0, Math.round(Number(selectedAmountCentsRaw) || 0)) || null;
  const selectedParcelCount = Math.max(0, Math.floor(Number(selectedParcelCountRaw) || 0)) || null;
  const selectedResidentialSurchargeCents =
    Math.max(0, Math.round(Number(selectedResidentialSurchargeCentsRaw) || 0)) || null;
  const hasSelectedShippingRate = Boolean(
    selectedRateObjectId ||
      selectedServiceCode ||
      selectedServiceLabel ||
      selectedProvider ||
      selectedAmountCents,
  );
  const items = Array.isArray(cartItems) ? cartItems : [];

  const validation =
    prevalidatedAddress && typeof prevalidatedAddress === "object"
      ? prevalidatedAddress
      : await validateShippingAddressForCheckout(address, { strictShippo });
  if (isCheckoutShippoLogEnabled()) {
    console.log("[checkout-estimate] validation called", {
      called: true,
      strictShippo,
      flow: requestedFlow,
      addressSummary: compactAddressSummary(address),
    });
  }
  const validationWarnings = [];

  if (!validation.ok) {
    const code = String(validation?.addressValidation?.code || "").trim().toLowerCase();
    const status = code === "unavailable" ? "unavailable" : "invalid";
    const quoteStatus = code === "unavailable" ? "provider_unavailable" : "invalid_address";

    return {
      shipping: shippingFromFailure({
        quoteStatus,
        message: validation.error || "Please enter a valid shipping address.",
      }).shipping,
      parcelSummary: emptyParcelSummary(),
      addressValidation: toAddressValidationShape({
        status,
        normalizedAddress: validation.normalizedAddress || null,
        suggestion: validation.addressSuggestion || null,
        fieldErrors: validation.fieldErrors || {},
        messages: [
          validation.error,
          ...(validation?.addressValidation?.messages || []),
        ].filter(Boolean),
        addressErrors: validation.addressValidation?.addressErrors || null,
        bannerMessage: validation.addressValidation?.bannerMessage || null,
      }),
      warnings: [],
      userFacingError: validation.error || "Please enter a valid shipping address.",
      canCheckout: false,
    };
  }

  if (validation.warning) {
    validationWarnings.push(String(validation.warning));
  }

  const normalizedAddress =
    validation.normalizedAddress && typeof validation.normalizedAddress === "object"
      ? { ...address, ...validation.normalizedAddress }
      : { ...(address || {}) };

  if (isCheckoutShippoLogEnabled()) {
    console.log("[checkout-estimate] validation status", {
      ok: validation.ok,
      isResidential: validation?.shippingContext?.applyResidentialSurcharge === true,
      suggested: Boolean(validation.addressSuggestion),
      normalized: Boolean(validation.normalizedAddress),
    });
  }

  let parcelPlan;
  try {
    const packagingConfig = await loadRuntimeFulfillmentPackagingConfig();
    parcelPlan = buildCheckoutPackingPlan({ items }, packagingConfig);
  } catch (err) {
    const providerMsg = String(err?.message || "Could not build parcel plan for shipping quote.");
    const publicMsg = "We could not calculate shipping for this cart. Please try again or contact us for help.";
    return {
      shipping: shippingFromFailure({
        quoteStatus: "error",
        message: publicMsg,
      }).shipping,
      parcelSummary: emptyParcelSummary(),
      addressValidation: toAddressValidationShape({
        status: "valid",
        normalizedAddress: validation.normalizedAddress || null,
        suggestion: validation.addressSuggestion || null,
        messages: [],
      }),
      warnings: [...validationWarnings],
      userFacingError: publicMsg,
      canCheckout: false,
      serverDebug: {
        providerErrorCategory: "packing_error",
        providerMessage: providerMsg,
      },
    };
  }

  if (isCheckoutShippoLogEnabled()) {
    console.log("[checkout-estimate] parcel plan for Shippo/UPS", {
      source: parcelPlan.source,
      parcelCount: Array.isArray(parcelPlan.parcels) ? parcelPlan.parcels.length : 0,
      parcels: parcelPlan.parcels,
    });
  }

  const parcelSummary = parcelSummaryFromPlan(parcelPlan);
  const packageLimit = shippingPackageLimitState(parcelSummary);
  if (requestedFlow === "checkout" && packageLimit.exceeded) {
    return {
      shipping: shippingFromFailure({
        quoteStatus: "package_limit_exceeded",
        message: packageLimit.message,
        residentialSurchargePackageCount: packageLimit.packageCount,
        addressIsResidential: validation?.shippingContext?.applyResidentialSurcharge === true,
      }).shipping,
      shippingRateOptions: [],
      parcelSummary,
      shippingPackageLimit: packageLimit,
      addressValidation: toAddressValidationShape({
        status: "valid",
        normalizedAddress: validation.normalizedAddress || null,
        suggestion: validation.addressSuggestion || null,
        messages: [],
      }),
      warnings: [...validationWarnings],
      userFacingError: packageLimit.message,
      canCheckout: false,
    };
  }

  if (isInternalCheckoutPricingEnabled(requestedFlow)) {
    const internalQuote = buildInternalCheckoutShippingQuote({
      address: normalizedAddress,
      parcelPlan,
      validation,
    });
    return {
      ...internalQuote,
      addressValidation: toAddressValidationShape({
        status: "valid",
        normalizedAddress: validation.normalizedAddress || null,
        suggestion: validation.addressSuggestion || null,
        messages: [],
      }),
      warnings: [...validationWarnings],
      serverDebug: {
        rateProvider: "internal",
        rateVersion: internalQuote.shipping.rateVersion,
      },
    };
  }

  const rateProviderId = getShippingRateProviderId();
  const shippoCarrierAccounts = rateProviderId === "shippo" ? parseShippoCarrierAccountIds() : null;

  let rated;
  try {
    rated = await getShippingRateQuote({
      address: normalizedAddress,
      parcels: parcelPlan.parcels,
    });
  } catch (err) {
    if (isCheckoutShippoLogEnabled()) {
      console.log("[checkout-estimate] getShippingRateQuote error", {
        category: err?.category,
        code: err?.code,
        message: err?.message,
      });
    }
    const category = String(err?.category || "").trim();
    const quoteStatus =
      category === "provider_unavailable" || category === "timeout_error" || category === "auth_error"
        ? "provider_unavailable"
        : "error";
    const providerMsg = String(err?.message || "Could not retrieve live shipping rates.");
    const publicMsg = publicShippingUnavailableMessage();
    const parcelCount = Math.max(0, Math.floor(Number(Array.isArray(parcelPlan?.parcels) ? parcelPlan.parcels.length : 0)));
    const isResidential = validation?.shippingContext?.applyResidentialSurcharge === true;
    const perPackageCents = 0;
    const residentialSurchargeCents = 0;
    const failedParcelSummary = parcelSummaryFromPlan(parcelPlan);
    if (isCheckoutShippoLogEnabled()) {
      console.log("[checkout-estimate] residential surcharge (provider error path)", {
        residentialDetected: isResidential,
        parcelCount,
        residentialSurchargePerPackageCents: perPackageCents,
        residentialSurchargeCents,
      });
    }
    if (liveShippingFallbackEnabled(requestedFlow, hasSelectedShippingRate)) {
      return {
        ...shippingFromFallbackRate({
          parcels: failedParcelSummary.parcels,
          parcelSummary: failedParcelSummary,
          validation,
          reason: category || "provider_error",
        }),
        addressValidation: toAddressValidationShape({
          status: "valid",
          normalizedAddress: validation.normalizedAddress || null,
          suggestion: validation.addressSuggestion || null,
          messages: [],
        }),
        warnings: [...validationWarnings],
        serverDebug: {
          providerErrorCategory: category || "unknown_error",
          providerErrorCode: err?.code || null,
          providerDebug: err?.debug || null,
          fallbackApplied: true,
        },
      };
    }

    return {
      shipping: shippingFromFailure({
        quoteStatus,
        message: publicMsg,
        residentialSurchargeCents,
        residentialSurchargePackageCount: parcelCount,
        addressIsResidential: isResidential,
      }).shipping,
      parcelSummary: failedParcelSummary,
      addressValidation: toAddressValidationShape({
        status: "valid",
        normalizedAddress: validation.normalizedAddress || null,
        suggestion: validation.addressSuggestion || null,
        messages: [],
      }),
      warnings: [...validationWarnings],
      userFacingError: publicMsg,
      canCheckout: false,
      // Server-side diagnostics only; do not expose to frontend in API responses.
      serverDebug: {
        providerErrorCategory: category || "unknown_error",
        providerErrorCode: err?.code || null,
        providerMessage: providerMsg,
        providerDebug: err?.debug || null,
      },
    };
  }

  let allRates = Array.isArray(rated?.allRates) ? rated.allRates : [];
  let best = rated.bestRate || null;
  if (rateProviderId === "shippo" && requiresConfiguredShippoCarrierAccount(requestedFlow) && !shippoCarrierAccounts?.length) {
    allRates = allRates.filter(isUspsRate);
    if (!allRates.length) {
      const providerMsg =
        "No USPS sandbox rates are available for this shipment. Refresh rates or check the Shippo sandbox account.";
      const publicMsg = publicShippingUnavailableMessage();
      const failedParcelSummary = {
        source: parcelPlan.source || "computed",
        parcelCount: Array.isArray(parcelPlan.parcels) ? parcelPlan.parcels.length : 0,
        parcels: Array.isArray(parcelPlan.parcels) ? parcelPlan.parcels : [],
        shippoRatingShipmentId: String(rated?.shippoShipmentObjectId || "").trim() || null,
      };
      if (liveShippingFallbackEnabled(requestedFlow, hasSelectedShippingRate)) {
        return {
          ...shippingFromFallbackRate({
            parcels: failedParcelSummary.parcels,
            parcelSummary: failedParcelSummary,
            validation,
            reason: "SHIPPO_NO_USPS_SANDBOX_RATES",
          }),
          addressValidation: toAddressValidationShape({
            status: "valid",
            normalizedAddress: validation.normalizedAddress || null,
            suggestion: validation.addressSuggestion || null,
            messages: [],
          }),
          warnings: [...validationWarnings],
          serverDebug: {
            rateProvider: rateProviderId,
            providerErrorCategory: "provider_error",
            providerErrorCode: "SHIPPO_NO_USPS_SANDBOX_RATES",
            fallbackApplied: true,
          },
        };
      }
      return {
          shipping: shippingFromFailure({
            quoteStatus: "provider_unavailable",
            message: publicMsg,
            residentialSurchargeCents: 0,
            residentialSurchargePackageCount: Array.isArray(parcelPlan.parcels) ? parcelPlan.parcels.length : 0,
            addressIsResidential: validation?.shippingContext?.applyResidentialSurcharge === true,
          }).shipping,
        shippingRateOptions: [],
        parcelSummary: failedParcelSummary,
        addressValidation: toAddressValidationShape({
          status: "valid",
          normalizedAddress: validation.normalizedAddress || null,
          suggestion: validation.addressSuggestion || null,
          messages: [],
        }),
        warnings: [...validationWarnings],
        userFacingError: publicMsg,
        canCheckout: false,
        serverDebug: {
          rateProvider: rateProviderId,
          providerErrorCategory: "provider_error",
          providerErrorCode: "SHIPPO_NO_USPS_SANDBOX_RATES",
          providerMessage: providerMsg,
        },
      };
    }
    const bestId = String(best?.providerQuoteId || "").trim();
    if (!bestId || !allRates.some((rate) => String(rate?.id || "").trim() === bestId)) {
      const fallback = allRates.reduce((current, rate) => {
        if (!current) {
          return rate;
        }
        return (Number(rate?.amountCents) || 0) < (Number(current?.amountCents) || 0) ? rate : current;
      }, null);
      best = fallback
        ? {
            serviceCode: fallback.serviceCode,
            serviceLabel: fallback.serviceLabel,
            amountCents: fallback.amountCents,
            currency: fallback.currency,
            providerQuoteId: fallback.id,
          }
        : best;
    }
  }
  const hasStableSelection = Boolean(
    (selectedServiceCode && selectedProvider) || (selectedServiceLabel && selectedProvider),
  );
  const shouldApplyManualSelection = hasStableSelection;
  let selectedSnapshotFallback = null;
  if (selectedRateObjectId || shouldApplyManualSelection) {
    let m = selectedRateObjectId
      ? allRates.find((o) => o && String(o.id || "").trim() === selectedRateObjectId)
      : null;
    if (!m && hasStableSelection && selectedServiceCode && selectedProvider) {
      const prov = selectedProvider.toLowerCase();
      const cands = allRates.filter(
        (o) =>
          o &&
          String(o?.serviceCode || "").trim() === selectedServiceCode &&
          String(o?.provider || "")
            .trim()
            .toLowerCase() === prov,
      );
      if (cands.length === 1) {
        m = cands[0];
      } else if (cands.length > 1 && selectedAmountCents != null && selectedAmountCents > 0) {
        const close = cands.find((o) => Math.abs((Math.max(0, Math.round(Number(o?.amountCents) || 0)) || 0) - selectedAmountCents) <= 2);
        m = close || cands[0];
      } else if (cands.length > 0) {
        m = cands[0];
      }
    }
    if (!m && hasStableSelection && selectedServiceLabel && selectedProvider) {
      const prov = selectedProvider.toLowerCase();
      const label = selectedServiceLabel.toLowerCase();
      const cands = allRates.filter(
        (o) =>
          o &&
          String(o?.provider || "")
            .trim()
            .toLowerCase() === prov &&
          String(o?.serviceLabel || "")
            .trim()
            .toLowerCase() === label,
      );
      if (cands.length === 1) {
        m = cands[0];
      } else if (cands.length > 1 && selectedAmountCents != null && selectedAmountCents > 0) {
        const close = cands.find((o) => Math.abs((Math.max(0, Math.round(Number(o?.amountCents) || 0)) || 0) - selectedAmountCents) <= 2);
        m = close || cands[0];
      } else if (cands.length > 0) {
        m = cands[0];
      }
    }
    if (
      !m &&
      (requestedFlow === "admin_manual" || requestedFlow === "admin_send_link") &&
      selectedRateObjectId &&
      hasStableSelection &&
      selectedAmountCents != null &&
      selectedAmountCents > 0
    ) {
      selectedSnapshotFallback = {
        id: selectedRateObjectId,
        provider: selectedProvider,
        serviceCode: selectedServiceCode,
        serviceLabel: selectedServiceLabel || serviceLabelWithFallback({ serviceCode: selectedServiceCode }),
        amountCents: selectedAmountCents,
        currency: "USD",
      };
      m = selectedSnapshotFallback;
    }
    if (!m) {
      const e = new Error(
        "That shipping service is no longer available. Please get fresh shipping rates.",
      );
      e.statusCode = 400;
      e.code = "INVALID_SHIPPING_RATE_SELECTION";
      e.shippingRateOptions = buildShippingRateOptions(allRates, 0);
      e.debug = {
        requestedFlow,
        selectedRateObjectId,
        selectedServiceCode,
        selectedServiceLabel,
        selectedProvider,
        selectedAmountCents,
        selectedParcelCount,
        selectedResidentialSurchargeCents,
      };
      throw e;
    }
    best = {
      serviceCode: m.serviceCode,
      serviceLabel: m.serviceLabel,
      amountCents: m.amountCents,
      currency: m.currency,
      providerQuoteId: m.id,
    };
  }

  const shippingAmountCents = Math.max(0, Math.round(Number(best?.amountCents) || 0));
  const serviceCode = String(best?.serviceCode || "").trim() || null;
  const serviceLabel =
    rated?.provider === "shippo"
      ? String(best?.serviceLabel || "").trim() || null
      : serviceLabelWithFallback(best);
  const currency = String(best?.currency || "USD").trim().toUpperCase() || "USD";
  const providerQuoteId = String(best?.providerQuoteId || "").trim() || null;

  const parcelCount = Math.max(0, Math.floor(Number(Array.isArray(parcelPlan?.parcels) ? parcelPlan.parcels.length : 0)));
  const isResidential = validation?.shippingContext?.applyResidentialSurcharge === true;
  const perPackageCents = 0;
  const residentialSurchargeCents = 0;
  const shippingTotalCents = shippingAmountCents + residentialSurchargeCents;
  const rateOptionsSource = selectedSnapshotFallback
    ? [
        selectedSnapshotFallback,
        ...allRates.filter((rate) => String(rate?.id || "").trim() !== String(selectedSnapshotFallback.id || "").trim()),
      ]
    : allRates;
  const allShippingRateOptions = buildShippingRateOptions(rateOptionsSource, residentialSurchargeCents);
  const shippingRateOptions = requestedFlow === "checkout"
    ? selectCheckoutShippingChoices(allShippingRateOptions)
    : allShippingRateOptions;
  if (isCheckoutShippoLogEnabled()) {
    console.log("[checkout-estimate] residential surcharge (rated path)", {
      residentialDetected: isResidential,
      parcelCount,
      residentialSurchargePerPackageCents: perPackageCents,
      residentialSurchargeCents,
      providerBaseShippingCents: shippingAmountCents,
      provider: rated.provider,
    });
  }

  return {
    shipping: {
      mode: "live_ups",
      quoteStatus: "rated",
      serviceCode,
      serviceLabel,
      amountCents: shippingAmountCents,
      amountFormatted: formatCurrency(shippingAmountCents),
      currency,
      residentialSurchargeCents,
      residentialSurchargeFormatted: formatCurrency(residentialSurchargeCents),
      taxableShippingCents: shippingTotalCents,
      provider: rated.provider,
      providerQuoteId,
      addressIsResidential: isResidential,
      residentialSurchargePerPackageCents: perPackageCents,
      residentialSurchargePackageCount: parcelCount,
      originFingerprint: String(rated?.requestMeta?.shipFromFingerprint || "").trim() || null,
    },
    shippingRateOptions,
    parcelSummary: parcelSummaryFromPlan(parcelPlan, {
      shippoRatingShipmentId: String(rated?.shippoShipmentObjectId || "").trim() || null,
    }),
    addressValidation: toAddressValidationShape({
      status: "valid",
      normalizedAddress: validation.normalizedAddress || null,
      suggestion: validation.addressSuggestion || null,
      messages: [],
    }),
    warnings: [...validationWarnings],
    userFacingError: null,
    canCheckout: true,
    // Server-side diagnostics only; do not expose to frontend in API responses.
    serverDebug: {
      rateProvider: rated.provider,
      ...(typeof rated.requestMeta === "object" && rated.requestMeta ? rated.requestMeta : {}),
      ...(typeof rated.raw === "object" && rated.raw ? rated.raw : {}),
    },
  };
}
