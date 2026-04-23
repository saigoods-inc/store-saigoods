import { validateShippingAddressForCheckout } from "./address-validation.js";
import { buildParcelsForOrder } from "./shippo-order-parcels.js";
import { getRates } from "./ups-rating.js";
import { formatCurrency } from "./quote.js";

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

const DEFAULT_RESIDENTIAL_SURCHARGE_USD = 6.5;

function getCheckoutResidentialSurchargeCents() {
  const raw = String(process.env.CHECKOUT_RESIDENTIAL_SURCHARGE_USD || "").trim();
  if (!raw) {
    return Math.round(DEFAULT_RESIDENTIAL_SURCHARGE_USD * 100);
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    return Math.round(DEFAULT_RESIDENTIAL_SURCHARGE_USD * 100);
  }
  return Math.round(n * 100);
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
  return f === "checkout";
}

function toAddressValidationShape({
  status,
  normalizedAddress = null,
  suggestion = null,
  fieldErrors = {},
  messages = [],
}) {
  return {
    status,
    normalizedAddress,
    suggestion,
    fieldErrors: fieldErrors && typeof fieldErrors === "object" ? fieldErrors : {},
    messages: Array.isArray(messages) ? messages.filter(Boolean) : [],
  };
}

function emptyParcelSummary() {
  return {
    source: "computed",
    parcelCount: 0,
    parcels: [],
  };
}

function shippingFromFailure({ quoteStatus, message, residentialSurchargeCents = 0 }) {
  const surcharge = Math.max(0, Math.round(Number(residentialSurchargeCents) || 0));
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
      provider: "ups",
      providerQuoteId: null,
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
 */
export async function getLiveShippingQuote({ address, cartItems, flow }) {
  const requestedFlow = normalizeFlow(flow);
  const strictShippo = strictShippoForFlow(requestedFlow);
  const items = Array.isArray(cartItems) ? cartItems : [];

  const validation = await validateShippingAddressForCheckout(address, { strictShippo });
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

  let rated;
  try {
    rated = await getRates({
      address: normalizedAddress,
      parcels: parcelPlan.parcels,
    });
  } catch (err) {
    const category = String(err?.category || "").trim();
    const quoteStatus =
      category === "provider_unavailable" || category === "timeout_error" || category === "auth_error"
        ? "provider_unavailable"
        : "error";
    const msg = String(err?.message || "Could not retrieve live shipping rates.");
    const residentialSurchargeCents =
      validation?.shippingContext?.applyResidentialSurcharge === true
        ? getCheckoutResidentialSurchargeCents()
        : 0;

    return {
      shipping: shippingFromFailure({
        quoteStatus,
        message: msg,
        residentialSurchargeCents,
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

  const best = rated.bestRate || null;
  const shippingAmountCents = Math.max(0, Math.round(Number(best?.amountCents) || 0));
  const serviceCode = String(best?.serviceCode || "").trim() || null;
  const serviceLabel = serviceLabelWithFallback(best);
  const currency = String(best?.currency || "USD").trim().toUpperCase() || "USD";

  const residentialSurchargeCents =
    validation?.shippingContext?.applyResidentialSurcharge === true
      ? getCheckoutResidentialSurchargeCents()
      : 0;
  const shippingTotalCents = shippingAmountCents + residentialSurchargeCents;

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
      provider: "ups",
      providerQuoteId: null,
    },
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
    userFacingError: null,
    canCheckout: true,
    // Server-side diagnostics only; do not expose to frontend in API responses.
    serverDebug: {
      provider: rated.provider,
      upsRequest: rated.request,
      rawUpsResponse: rated?.debug?.rawUpsResponse || null,
    },
  };
}
