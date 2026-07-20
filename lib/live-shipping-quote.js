import { validateShippingAddressForCheckout } from "./address-validation.js";
import { getCheckoutResidentialSurchargeCents } from "./checkout-surcharge.js";
import { buildParcelsForOrder } from "./shippo-order-parcels.js";
import { formatCurrency } from "./quote.js";
import { isCheckoutShippoLogEnabled } from "./shippo.js";
import { getShippingRateProviderId, getShippingRateQuote } from "./shipping-rate-provider.js";

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
  const items = Array.isArray(cartItems) ? cartItems : [];

  const validation = await validateShippingAddressForCheckout(address, { strictShippo });
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
    parcelPlan = buildParcelsForOrder({ items });
  } catch (err) {
    const msg = String(err?.message || "Could not build parcel plan for shipping quote.");
    return {
      shipping: shippingFromFailure({
        quoteStatus: "error",
        message: msg,
      }).shipping,
      parcelSummary: emptyParcelSummary(),
      addressValidation: toAddressValidationShape({
        status: "valid",
        normalizedAddress: validation.normalizedAddress || null,
        suggestion: validation.addressSuggestion || null,
        messages: [],
      }),
      warnings: [...validationWarnings],
      userFacingError: msg,
      canCheckout: false,
    };
  }

  if (isCheckoutShippoLogEnabled()) {
    console.log("[checkout-estimate] parcel plan for Shippo/UPS", {
      source: parcelPlan.source,
      parcelCount: Array.isArray(parcelPlan.parcels) ? parcelPlan.parcels.length : 0,
      parcels: parcelPlan.parcels,
    });
  }

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
    const msg = String(err?.message || "Could not retrieve live shipping rates.");
    const parcelCount = Math.max(0, Math.floor(Number(Array.isArray(parcelPlan?.parcels) ? parcelPlan.parcels.length : 0)));
    const isResidential = validation?.shippingContext?.applyResidentialSurcharge === true;
    const perPackageCents = getCheckoutResidentialSurchargeCents();
    const residentialSurchargeCents = computeResidentialSurchargeCents(isResidential, parcelCount);
    if (isCheckoutShippoLogEnabled()) {
      console.log("[checkout-estimate] residential surcharge (provider error path)", {
        residentialDetected: isResidential,
        parcelCount,
        residentialSurchargePerPackageCents: perPackageCents,
        residentialSurchargeCents,
      });
    }

    return {
      shipping: shippingFromFailure({
        quoteStatus,
        message: msg,
        residentialSurchargeCents,
        residentialSurchargePackageCount: parcelCount,
        addressIsResidential: isResidential,
      }).shipping,
      parcelSummary: {
        source: parcelPlan.source || "computed",
        parcelCount: Array.isArray(parcelPlan.parcels) ? parcelPlan.parcels.length : 0,
        parcels: Array.isArray(parcelPlan.parcels) ? parcelPlan.parcels : [],
      },
      addressValidation: toAddressValidationShape({
        status: "valid",
        normalizedAddress: validation.normalizedAddress || null,
        suggestion: validation.addressSuggestion || null,
        messages: [],
      }),
      warnings: [...validationWarnings],
      userFacingError: msg,
      canCheckout: false,
      // Server-side diagnostics only; do not expose to frontend in API responses.
      serverDebug: {
        providerErrorCategory: category || "unknown_error",
        providerErrorCode: err?.code || null,
        providerDebug: err?.debug || null,
      },
    };
  }

  const allRates = Array.isArray(rated?.allRates) ? rated.allRates : [];
  let best = rated.bestRate || null;
  const hasStableSelection = Boolean(
    (selectedServiceCode && selectedProvider) || (selectedServiceLabel && selectedProvider),
  );
  const shouldApplyManualSelection = hasStableSelection;
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
    if (!m) {
      const e = new Error(
        "That shipping service is no longer available. Please get fresh shipping rates.",
      );
      e.statusCode = 400;
      e.code = "INVALID_SHIPPING_RATE_SELECTION";
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

  const shippingRateOptions = allRates.map((o) => ({
    id: String(o.id || "").trim(),
    provider: o.provider,
    serviceCode: o.serviceCode,
    serviceLabel: o.serviceLabel,
    amountCents: o.amountCents,
    amountFormatted: formatCurrency(o.amountCents),
    currency: o.currency,
    estimatedDays: o.estimatedDays != null && Number.isFinite(Number(o.estimatedDays)) ? Number(o.estimatedDays) : null,
  }));

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
  const perPackageCents = getCheckoutResidentialSurchargeCents();
  const residentialSurchargeCents = computeResidentialSurchargeCents(isResidential, parcelCount);
  const shippingTotalCents = shippingAmountCents + residentialSurchargeCents;
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
    },
    shippingRateOptions,
    parcelSummary: {
      source: parcelPlan.source || "computed",
      parcelCount: Array.isArray(parcelPlan.parcels) ? parcelPlan.parcels.length : 0,
      parcels: Array.isArray(parcelPlan.parcels) ? parcelPlan.parcels : [],
      shippoRatingShipmentId: String(rated?.shippoShipmentObjectId || "").trim() || null,
    },
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
