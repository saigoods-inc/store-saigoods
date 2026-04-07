import { buildQuote, formatCurrency } from "./quote.js";
import { normalizeUsZip } from "./shipping.js";
import {
  computeTaxCentsForState,
  hasTaxRateForState,
  normalizeUsStateCode,
} from "./tax-us.js";

function taxIncludesShipping() {
  const v = process.env.CHECKOUT_TAX_INCLUDES_SHIPPING;
  if (v == null || String(v).trim() === "") {
    return true;
  }
  const s = String(v).trim().toLowerCase();
  return s === "true" || s === "1" || s === "yes" || s === "on";
}

/**
 * Full cart quote with shipping (from ZIP) and destination tax (from state + CHECKOUT_STATE_TAX_BPS).
 * @param {Array} items - cart lines
 * @param {{ line1?: string, line2?: string, city?: string, state?: string, postalCode?: string, country?: string }} address
 */
export function buildFullCheckoutQuote(items, address) {
  const addr = address && typeof address === "object" ? address : {};
  const zip = normalizeUsZip(addr.postalCode);
  const quote = buildQuote(items, zip ? { zipCode: zip } : { omitShippingEstimate: true });
  const state = normalizeUsStateCode(addr.state);

  const includeShip = taxIncludesShipping();
  const taxableBase = quote.subtotalCents + (includeShip ? quote.shippingCents : 0);
  const taxCents = computeTaxCentsForState(state, taxableBase);
  const totalCents = quote.subtotalCents + quote.shippingCents + taxCents;

  return {
    ...quote,
    taxCents,
    taxFormatted: formatCurrency(taxCents),
    totalCents,
    totalFormatted: formatCurrency(totalCents),
    destinationState: state,
    taxRateConfigured: state ? hasTaxRateForState(state) : false,
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
