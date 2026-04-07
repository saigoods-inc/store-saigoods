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

function taxIncludesShipping() {
  const v = process.env.CHECKOUT_TAX_INCLUDES_SHIPPING;
  if (v == null || String(v).trim() === "") {
    return true;
  }
  const s = String(v).trim().toLowerCase();
  return s === "true" || s === "1" || s === "yes" || s === "on";
}

/**
 * @param {string | null | undefined} destinationState - 2-letter US state from ship-to
 * @param {number} subtotalCents
 * @param {number} shippingCents
 * @returns {{ taxCents: number, taxRateConfigured: boolean, taxSource: string, taxableBaseCents: number }}
 */
export function computeCheckoutSalesTaxSync(destinationState, subtotalCents, shippingCents) {
  const state = normalizeUsStateCode(destinationState);
  const sub = Math.max(0, Math.round(Number(subtotalCents) || 0));
  const ship = Math.max(0, Math.round(Number(shippingCents) || 0));
  const includeShip = taxIncludesShipping();
  const taxableBase = sub + (includeShip ? ship : 0);

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
