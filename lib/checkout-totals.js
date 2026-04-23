import { computeCheckoutSalesTaxSync } from "./sales-tax.js";
import { buildQuote, formatCurrency } from "./quote.js";
import { normalizeUsStateCode } from "./tax-us.js";
import { buildParcelsForOrder } from "./shippo-order-parcels.js";
import { getLiveShippingQuote } from "./live-shipping-quote.js";

const DEFAULT_RESIDENTIAL_SURCHARGE_USD = 6.5;

function parseUsdToCents(envName, defaultUsd) {
  const raw = process.env[envName]?.trim();
  if (raw == null || raw === "") {
    return Math.round(Number(defaultUsd) * 100);
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    return Math.round(Number(defaultUsd) * 100);
  }
  return Math.round(n * 100);
}

export function getCheckoutResidentialSurchargeCents() {
  return parseUsdToCents("CHECKOUT_RESIDENTIAL_SURCHARGE_USD", DEFAULT_RESIDENTIAL_SURCHARGE_USD);
}

function getShippingQuoteMode() {
  const raw = String(process.env.SHIPPING_QUOTE_MODE || "")
    .trim()
    .toLowerCase();
  return raw === "live_ups" ? "live_ups" : "baked_in";
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

  return {
    status,
    normalizedAddress: validationResult.normalizedAddress || null,
    suggestion: validationResult.addressSuggestion || null,
    fieldErrors:
      validationResult.fieldErrors && typeof validationResult.fieldErrors === "object"
        ? validationResult.fieldErrors
        : {},
    messages,
  };
}

function tryBuildParcelSummary(items) {
  try {
    const plan = buildParcelsForOrder({ items: Array.isArray(items) ? items : [] });
    return {
      parcelSummary: {
        source: plan.source || "computed",
        parcelCount: Array.isArray(plan.parcels) ? plan.parcels.length : 0,
        parcels: Array.isArray(plan.parcels) ? plan.parcels : [],
      },
      warning: null,
    };
  } catch (err) {
    return {
      parcelSummary: {
        source: "computed",
        parcelCount: 0,
        parcels: [],
      },
      warning: String(err?.message || "Could not build parcel summary."),
    };
  }
}

/**
 * Full cart quote with $0 base shipping (baked into catalog prices), optional residential surcharge, TN sales tax.
 * @param {Array} items - cart lines
 * @param {{ line1?: string, line2?: string, city?: string, state?: string, postalCode?: string, country?: string }} address
 * @param {{
 *   pricingTier?: "standard" | "hardin",
 *   shippingContext?: { applyResidentialSurcharge: boolean, shippoUnavailable: boolean } | null,
 *   receiptRebuild?: boolean,
 * }} [opts]
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
  const quote = buildQuote(items, quoteOpts);

  let discountBreakdown = {};
  if (pricingTier === "hardin") {
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

  if (!receiptRebuild && shippingMode === "live_ups") {
    const liveQuote = await getLiveShippingQuote({
      address: addr,
      cartItems: items,
      flow: requestedFlow,
    });
    shippingBlock = liveQuote.shipping;
    parcelSummary = liveQuote.parcelSummary;
    canCheckout = Boolean(liveQuote.canCheckout);
    userFacingError = liveQuote.userFacingError || null;
    warningList = [...(Array.isArray(liveQuote.warnings) ? liveQuote.warnings : [])];
    if (liveQuote.addressValidation && typeof liveQuote.addressValidation === "object") {
      addressValidationShape = liveQuote.addressValidation;
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
    },
    shipping: {
      ...shippingBlock,
      mode: shippingMode === "live_ups" && !receiptRebuild ? "live_ups" : "baked_in",
      amountFormatted: formatCurrency(Math.max(0, Number(shippingBlock?.amountCents) || 0)),
      residentialSurchargeFormatted: formatCurrency(
        Math.max(0, Number(shippingBlock?.residentialSurchargeCents) || 0),
      ),
    },
    tax: {
      amountCents: taxCents,
      amountFormatted: formatCurrency(taxCents),
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
  };

  return {
    ...quoteResponse,
    items: quote.items,
    subtotalCents: quote.subtotalCents,
    subtotalFormatted: formatCurrency(quote.subtotalCents),
    shippingCents,
    shippingFormatted: formatCurrency(shippingCents),
    shippingZone: null,
    shippingMode: quoteResponse.shipping.mode,
    shippingQuoteStatus: quoteResponse.shipping.quoteStatus,
    baseShippingCents: Math.max(0, Number(quoteResponse.shipping.amountCents) || 0),
    baseShippingFormatted: formatCurrency(Math.max(0, Number(quoteResponse.shipping.amountCents) || 0)),
    residentialSurchargeCents: Math.max(0, Number(quoteResponse.shipping.residentialSurchargeCents) || 0),
    residentialSurchargeFormatted: formatCurrency(
      Math.max(0, Number(quoteResponse.shipping.residentialSurchargeCents) || 0),
    ),
    shippingResidentialApplied,
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
    taxJarOnly: false,
    warnings: normalizedWarnings,
    userFacingError,
    canCheckout: quoteResponse.canCheckout,
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
