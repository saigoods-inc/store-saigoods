import { normalizeUsStateCode } from "./tax-us.js";

/**
 * Nexus-only: collect TN sales tax at checkout. All other US states → $0 tax (for now).
 * Rate: 9.75% default; override with SALES_TAX_TN_BPS (basis points, e.g. 975 = 9.75%).
 *
 * TN taxable base = merchandise subtotal
 *   + seller-billed shipping/delivery charges
 *   + residential delivery surcharge
 * (passed in as subtotalCents + taxableFeesCents). Do not use CHECKOUT_TAX_INCLUDES_SHIPPING here.
 */

function tnSalesTaxBps() {
  const raw = process.env.SALES_TAX_TN_BPS;
  if (raw == null || String(raw).trim() === "") {
    return 975;
  }
  const n = Math.round(Number(raw));
  return Number.isFinite(n) && n >= 0 && n <= 2000 ? n : 975;
}

/**
 * @param {string | null | undefined} destinationState - 2-letter US state from ship-to
 * @param {number} subtotalCents - merchandise after line discounts / tier (e.g. Hardin)
 * @param {number} taxableFeesCents - taxable shipping/delivery charges + residential delivery surcharge
 * @returns {{ taxCents: number, taxRateConfigured: boolean, taxSource: string, taxableBaseCents: number }}
 */
export function computeCheckoutSalesTaxSync(destinationState, subtotalCents, taxableFeesCents) {
  const state = normalizeUsStateCode(destinationState);
  const sub = Math.max(0, Math.round(Number(subtotalCents) || 0));
  const fees = Math.max(0, Math.round(Number(taxableFeesCents) || 0));

  if (state !== "TN") {
    return {
      taxCents: 0,
      taxRateConfigured: true,
      taxSource: "no_nexus",
      taxableBaseCents: sub + fees,
    };
  }

  const taxableBase = sub + fees;

  if (taxableBase < 1) {
    return {
      taxCents: 0,
      taxRateConfigured: true,
      taxSource: "tn_zero",
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
