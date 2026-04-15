import { normalizeUsStateCode } from "./tax-us.js";

/**
 * Nexus-only: collect TN sales tax at checkout. All other US states → $0 tax (for now).
 * Rate: 9.75% default; override with SALES_TAX_TN_BPS (basis points, e.g. 975 = 9.75%).
 */

function tnSalesTaxBps() {
  const raw = process.env.SALES_TAX_TN_BPS;
  if (raw == null || String(raw).trim() === "") {
    return 975;
  }
  const n = Math.round(Number(raw));
  return Number.isFinite(n) && n >= 0 && n <= 2000 ? n : 975;
}

/** When true (default), TN taxable base includes separately stated fees (e.g. residential surcharge), not baked-in shipping. */
function taxIncludesTaxableFees() {
  const v = process.env.CHECKOUT_TAX_INCLUDES_SHIPPING;
  if (v == null || String(v).trim() === "") {
    return true;
  }
  const s = String(v).trim().toLowerCase();
  return s === "true" || s === "1" || s === "yes" || s === "on";
}

/**
 * @param {string | null | undefined} destinationState - 2-letter US state from ship-to
 * @param {number} subtotalCents - merchandise after line discounts / tier (e.g. Hardin)
 * @param {number} taxableFeesCents - separately stated taxable fees (e.g. residential delivery surcharge only; catalog shipping is baked into subtotal)
 * @returns {{ taxCents: number, taxRateConfigured: boolean, taxSource: string, taxableBaseCents: number }}
 */
export function computeCheckoutSalesTaxSync(destinationState, subtotalCents, taxableFeesCents) {
  const state = normalizeUsStateCode(destinationState);
  const sub = Math.max(0, Math.round(Number(subtotalCents) || 0));
  const fees = Math.max(0, Math.round(Number(taxableFeesCents) || 0));
  const includeFees = taxIncludesTaxableFees();
  const taxableBase = sub + (includeFees ? fees : 0);

  if (state !== "TN" || taxableBase < 1) {
    return {
      taxCents: 0,
      taxRateConfigured: true,
      taxSource: state === "TN" ? "tn_zero" : "no_nexus",
      taxableBaseCents: taxableBase,
    };
  }

  const bps = tnSalesTaxBps();
  const taxCents = Math.round((taxableBase * bps) / 10000);

  return {
    taxCents,
    taxRateConfigured: true,
    taxSource: "tn",
    taxableBaseCents: taxableBase,
  };
}
