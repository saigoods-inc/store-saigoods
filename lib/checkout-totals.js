import { computeCheckoutSalesTaxSync } from "./sales-tax.js";
import { buildQuote, formatCurrency } from "./quote.js";
import { normalizeUsZip } from "./shipping.js";
import { normalizeUsStateCode } from "./tax-us.js";

/** When true (default if unset), embedded checkout uses $0 shipping; ZIP is ignored for shipping. */
function checkoutFreeShipping() {
  const v = process.env.CHECKOUT_FREE_SHIPPING;
  if (v == null || String(v).trim() === "") {
    return true;
  }
  const s = String(v).trim().toLowerCase();
  return s === "true" || s === "1" || s === "yes" || s === "on";
}

/**
 * Full cart quote with shipping and TN-only sales tax (9.75% default on taxable base).
 * @param {Array} items - cart lines
 * @param {{ line1?: string, line2?: string, city?: string, state?: string, postalCode?: string, country?: string }} address
 * @param {{ pricingTier?: "standard" | "hardin" }} [opts]
 */
export async function buildFullCheckoutQuote(items, address, opts = {}) {
  const addr = address && typeof address === "object" ? address : {};
  const zip = normalizeUsZip(addr.postalCode);
  const freeShip = checkoutFreeShipping();
  const pricingTier = opts.pricingTier === "hardin" ? "hardin" : "standard";
  const quoteOpts = {
    ...(freeShip || !zip ? { omitShippingEstimate: true } : { zipCode: zip }),
    pricingTier,
  };
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

  const state = normalizeUsStateCode(addr.state);

  const taxMeta = computeCheckoutSalesTaxSync(state, quote.subtotalCents, quote.shippingCents);
  const taxCents = taxMeta.taxCents;
  const totalCents = quote.subtotalCents + quote.shippingCents + taxCents;

  return {
    ...quote,
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
