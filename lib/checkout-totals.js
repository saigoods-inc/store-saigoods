import { computeCheckoutSalesTaxSync } from "./sales-tax.js";
import { buildQuote, formatCurrency } from "./quote.js";
import { normalizeUsStateCode } from "./tax-us.js";

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

  /** Catalog prices include shipping; CHECKOUT_BASE_SHIPPING_USD is not applied to checkout totals. */
  const baseShippingCents = 0;
  let residentialSurchargeCents = 0;
  let shippoUnavailable = false;

  if (!receiptRebuild && shippingContext) {
    if (shippingContext.applyResidentialSurcharge) {
      residentialSurchargeCents = getCheckoutResidentialSurchargeCents();
    }
    shippoUnavailable = Boolean(shippingContext.shippoUnavailable);
  }

  const shippingCents = baseShippingCents + residentialSurchargeCents;
  const shippingResidentialApplied = residentialSurchargeCents > 0;

  const quoteWithShipping = {
    ...quote,
    shippingZone: null,
    baseShippingCents,
    baseShippingFormatted: formatCurrency(baseShippingCents),
    residentialSurchargeCents,
    residentialSurchargeFormatted: formatCurrency(residentialSurchargeCents),
    shippingResidentialApplied,
    shippingCents,
    shippingFormatted: formatCurrency(shippingCents),
    ...(shippoUnavailable ? { shippoUnavailable: true } : {}),
  };

  const state = normalizeUsStateCode(addr.state);

  const taxMeta = computeCheckoutSalesTaxSync(
    state,
    quoteWithShipping.subtotalCents,
    residentialSurchargeCents,
  );
  const taxCents = taxMeta.taxCents;
  const totalCents = quoteWithShipping.subtotalCents + quoteWithShipping.shippingCents + taxCents;

  return {
    ...quoteWithShipping,
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
