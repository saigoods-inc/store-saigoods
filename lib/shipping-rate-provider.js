import { getShippoRateQuoteForCheckout } from "./shippo-rate-provider.js";
import { getUpsRateQuoteForCheckout } from "./ups-rate-provider.js";

/**
 * @typedef {object} ShippingBestRate
 * @property {string | null} serviceCode
 * @property {string | null} serviceLabel
 * @property {number} amountCents
 * @property {string} currency
 * @property {string | null} providerQuoteId
 */

/**
 * @typedef {object} ShippingRateOption
 * @property {string} id — Shippo rate `object_id`, or `ups:<serviceCode>` for direct UPS
 * @property {string | null} provider
 * @property {string | null} serviceCode
 * @property {string | null} serviceLabel
 * @property {number} amountCents
 * @property {string} currency
 * @property {number | null} [estimatedDays]
 */

/**
 * @typedef {object} ShippingRateQuoteResult
 * @property {"ups"|"shippo"} provider
 * @property {ShippingBestRate} bestRate
 * @property {ShippingRateOption[]} [allRates]
 * @property {string | null} [shippoShipmentObjectId]
 * @property {object} [requestMeta]
 * @property {object} [raw]
 */

/**
 * Select rate provider for checkout.
 * - Prefer `SHIPPING_RATE_PROVIDER` (or legacy `SHIPPING_PROVIDER`).
 * - If unset, prefer Shippo when `SHIPPO_API_TOKEN` is set; otherwise UPS.
 * @returns {"ups"|"shippo"}
 */
export function getShippingRateProviderId() {
  const r = String(process.env.SHIPPING_RATE_PROVIDER || process.env.SHIPPING_PROVIDER || "")
    .trim()
    .toLowerCase();
  if (r === "shippo") {
    return "shippo";
  }
  if (r === "ups") {
    return "ups";
  }
  if (String(process.env.SHIPPO_API_TOKEN || "").trim()) {
    return "shippo";
  }
  return "ups";
}

/**
 * Live carrier rate quote (UPS direct or Shippo) with a unified result shape.
 * @param {{ address: object, parcels: object[], customer?: { name?: string, email?: string, phone?: string } }} input
 * @returns {Promise<ShippingRateQuoteResult>}
 */
export async function getShippingRateQuote(input) {
  const id = getShippingRateProviderId();
  if (id === "shippo") {
    return getShippoRateQuoteForCheckout(input);
  }
  return getUpsRateQuoteForCheckout(input);
}
