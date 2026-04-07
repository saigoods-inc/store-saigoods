import { normalizeUsStateCode, resolveStaticUsTax } from "./tax-us.js";
import { normalizeUsZip } from "./shipping.js";
import { fetchTaxJarTaxCents, isTaxJarConfigured } from "./taxjar-tax.js";

/** @param {object} quote - from buildFullCheckoutQuote */
export function buildCheckoutTaxWarnings(quote, address) {
  const addr = address && typeof address === "object" ? address : {};
  const warnings = [];

  if (quote?.taxWarning) {
    warnings.push(quote.taxWarning);
  }

  if (quote?.taxRateConfigured) {
    return warnings;
  }

  const zip5 = normalizeUsZip(addr.postalCode);
  const stateRaw = String(addr.state || "").trim();
  const stateOk = /^[A-Z]{2}$/i.test(stateRaw);

  if (isTaxJarConfigured() && (!zip5 || !stateOk)) {
    warnings.push("Enter state and a valid ZIP code to calculate sales tax.");
    return warnings;
  }

  if (zip5 && stateOk) {
    warnings.push(
      "Estimated tax is $0. Add CHECKOUT_ZIP_TAX_BPS for this ZIP (combined state + local rate in basis points), use CHECKOUT_STATE_TAX_BPS as a fallback, or set TAXJAR_API_KEY plus ship-from address for automatic rates.",
    );
  }

  return warnings;
}

/**
 * @param {object} p
 * @param {object} p.address
 * @param {number} p.subtotalCents
 * @param {number} p.shippingCents
 * @param {boolean} p.taxIncludesShipping - if true, static table applies to (subtotal+shipping); TaxJar always gets both components
 * @returns {Promise<{ taxCents: number, taxRateConfigured: boolean, taxSource: string, taxWarning?: string }>}
 */
export async function resolveCheckoutSalesTax(p) {
  const addr = p.address && typeof p.address === "object" ? p.address : {};
  const state = normalizeUsStateCode(addr.state);
  const zip5 = normalizeUsZip(addr.postalCode);
  const subtotalCents = Math.max(0, Math.round(Number(p.subtotalCents) || 0));
  const shippingCents = Math.max(0, Math.round(Number(p.shippingCents) || 0));
  const includeShip = p.taxIncludesShipping === true;

  const taxableBaseStatic = subtotalCents + (includeShip ? shippingCents : 0);

  const canTaxJar = isTaxJarConfigured() && zip5 && state;

  if (canTaxJar) {
    try {
      const taxCents = await fetchTaxJarTaxCents({
        subtotalCents,
        shippingCents,
        to: {
          zip: zip5,
          state,
          country: addr.country,
          city: addr.city,
          line1: addr.line1,
        },
      });
      return {
        taxCents,
        taxRateConfigured: true,
        taxSource: "taxjar",
      };
    } catch (err) {
      console.error("[checkout-tax] TaxJar failed:", err?.message || err);
      const fallback = resolveStaticUsTax(state, zip5, taxableBaseStatic);
      const configured = fallback.match !== "none";
      return {
        taxCents: fallback.taxCents,
        taxRateConfigured: configured,
        taxSource: configured ? `fallback_${fallback.match}` : "unconfigured",
        taxWarning: `Live tax (TaxJar) failed; used static rates. ${err?.message || ""}`.trim(),
      };
    }
  }

  const resolved = resolveStaticUsTax(state, zip5, taxableBaseStatic);
  return {
    taxCents: resolved.taxCents,
    taxRateConfigured: resolved.match !== "none",
    taxSource: resolved.match === "none" ? "unconfigured" : resolved.match,
  };
}
