import { getRates } from "./ups-rating.js";
import { loadDefaultShipFromOverride, warehouseAddressFingerprint } from "./warehouse-settings.js";

/**
 * Direct UPS Rating API; normalized for checkout.
 * @param {{ address: object, parcels: object[] }} input
 */
export async function getUpsRateQuoteForCheckout({ address, parcels }) {
  const shipperAddress = await loadDefaultShipFromOverride();
  const rated = await getRates({ address, parcels, shipperAddress });
  const best = rated.bestRate;
  if (!best) {
    const err = new Error("UPS returned no best rate.");
    err.category = "provider_error";
    err.code = "UPS_NO_BEST";
    throw err;
  }
  const sc = String(best.serviceCode || "").trim() || null;
  const single = {
    id: sc ? `ups:${sc}` : "ups:default",
    provider: "UPS",
    serviceCode: sc,
    serviceLabel: String(best.serviceLabel || "").trim() || null,
    amountCents: Math.max(0, Math.round(Number(best.amountCents) || 0)),
    currency: String(best.currency || "USD").trim().toUpperCase() || "USD",
    estimatedDays: null,
  };
  return {
    provider: "ups",
    allRates: [single],
    shippoShipmentObjectId: null,
    bestRate: {
      serviceCode: sc,
      serviceLabel: String(best.serviceLabel || "").trim() || null,
      amountCents: single.amountCents,
      currency: single.currency,
      providerQuoteId: single.id,
    },
    requestMeta: { upsRequest: rated.request, shipFromFingerprint: warehouseAddressFingerprint(shipperAddress) },
    raw: { type: "ups", rawUpsResponse: rated?.debug?.rawUpsResponse || null },
  };
}
