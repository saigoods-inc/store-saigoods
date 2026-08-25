import { formatCurrency } from "./quote.js";
import { getShippingZone } from "./shipping-zone-legacy.js";

export const DEFAULT_ZONE_FREE_SHIPPING_THRESHOLDS_CENTS = Object.freeze({
  3: 15_000,
  6: 30_000,
});

function normalizeThresholds(value) {
  const out = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [rawZone, rawCents] of Object.entries(value)) {
    const zone = Math.round(Number(rawZone));
    const cents = Math.round(Number(rawCents));
    if (zone >= 2 && zone <= 8 && Number.isFinite(cents) && cents > 0) {
      out[zone] = cents;
    }
  }
  return out;
}

/**
 * Optional production override, expressed in whole dollars:
 * ZONE_FREE_SHIPPING_THRESHOLDS_USD="3:150,6:300"
 */
export function getZoneFreeShippingThresholdsCents(raw = process.env.ZONE_FREE_SHIPPING_THRESHOLDS_USD) {
  if (raw == null || String(raw).trim() === "") {
    return { ...DEFAULT_ZONE_FREE_SHIPPING_THRESHOLDS_CENTS };
  }
  const parsed = {};
  for (const entry of String(raw).split(",")) {
    const [zoneText, dollarsText, extra] = entry.split(":");
    if (extra != null) continue;
    const zone = Math.round(Number(zoneText));
    const dollars = Number(dollarsText);
    if (zone >= 2 && zone <= 8 && Number.isFinite(dollars) && dollars > 0) {
      parsed[zone] = Math.round(dollars * 100);
    }
  }
  return parsed;
}

function rateId(rate) {
  return String(rate?.id || rate?.object_id || rate?.providerQuoteId || "").trim();
}

function carrierTotalCents(rate) {
  if (Number.isFinite(Number(rate?.carrierTotalAmountCents))) {
    return Math.max(0, Math.round(Number(rate.carrierTotalAmountCents)));
  }
  if (Number.isFinite(Number(rate?.totalAmountCents))) {
    return Math.max(0, Math.round(Number(rate.totalAmountCents)));
  }
  return Math.max(0, Math.round(Number(rate?.amountCents) || 0));
}

function lowestCostRate(rates) {
  return [...rates]
    .filter((rate) => rateId(rate) && String(rate?.provider || "").toLowerCase() !== "local")
    .sort((a, b) => carrierTotalCents(a) - carrierTotalCents(b))[0] || null;
}

export function evaluateZoneFreeShipping({
  postalCode,
  subtotalCents,
  shippingRateOptions,
  selectedRateId,
  shippingZone,
  thresholdsCents = getZoneFreeShippingThresholdsCents(),
} = {}) {
  const zip = String(postalCode || "").trim();
  const validZip = /^\d{5}(?:-\d{4})?$/.test(zip);
  const zone = validZip
    ? Math.round(Number(shippingZone)) || getShippingZone(zip)
    : null;
  const thresholds = normalizeThresholds(thresholdsCents);
  const thresholdCents = zone == null ? 0 : Math.max(0, Number(thresholds[zone]) || 0);
  const subtotal = Math.max(0, Math.round(Number(subtotalCents) || 0));
  const configured = thresholdCents > 0;
  const eligible = configured && subtotal >= thresholdCents;
  const amountRemainingCents = configured ? Math.max(0, thresholdCents - subtotal) : 0;
  const qualifyingRate = lowestCostRate(Array.isArray(shippingRateOptions) ? shippingRateOptions : []);
  const qualifyingRateId = rateId(qualifyingRate) || null;
  const applied = Boolean(eligible && qualifyingRateId && qualifyingRateId === String(selectedRateId || ""));

  return {
    active: configured,
    configured,
    zone,
    thresholdCents,
    thresholdFormatted: formatCurrency(thresholdCents),
    subtotalCents: subtotal,
    eligible,
    applied,
    amountRemainingCents,
    amountRemainingFormatted: formatCurrency(amountRemainingCents),
    qualifyingRateId,
    qualifyingServiceLabel: qualifyingRate?.serviceLabel || null,
    message: !configured
      ? null
      : eligible
        ? "Enjoy your free shipping!"
        : `Spend ${formatCurrency(amountRemainingCents)} more for free shipping.`,
  };
}

export function applyZoneFreeShippingToRates(rates, evaluation) {
  const list = Array.isArray(rates) ? rates : [];
  if (!evaluation?.eligible || !evaluation?.qualifyingRateId) return list;
  return list.map((rate) => {
    if (rateId(rate) !== evaluation.qualifyingRateId) return rate;
    const carrierTotalAmountCents = carrierTotalCents(rate);
    const carrierResidentialSurchargeCents = Math.max(
      0,
      Math.round(Number(rate?.residentialSurchargeCents) || 0),
    );
    return {
      ...rate,
      carrierTotalAmountCents,
      carrierTotalAmountFormatted: formatCurrency(carrierTotalAmountCents),
      carrierResidentialSurchargeCents,
      freeShippingApplied: true,
      shippingDiscountCents: carrierTotalAmountCents,
      shippingDiscountFormatted: formatCurrency(carrierTotalAmountCents),
      residentialSurchargeCents: 0,
      residentialSurchargeFormatted: formatCurrency(0),
      totalAmountCents: 0,
      totalAmountFormatted: formatCurrency(0),
    };
  });
}

export function applyZoneFreeShippingToShipping(shipping, evaluation) {
  if (!shipping || typeof shipping !== "object" || !evaluation?.applied) return shipping;
  const carrierAmountCents = Math.max(0, Math.round(Number(shipping.amountCents) || 0));
  const carrierResidentialSurchargeCents = Math.max(
    0,
    Math.round(Number(shipping.residentialSurchargeCents) || 0),
  );
  const carrierTotalAmountCents = carrierAmountCents + carrierResidentialSurchargeCents;
  return {
    ...shipping,
    carrierAmountCents,
    carrierAmountFormatted: formatCurrency(carrierAmountCents),
    carrierResidentialSurchargeCents,
    carrierResidentialSurchargeFormatted: formatCurrency(carrierResidentialSurchargeCents),
    carrierTotalAmountCents,
    carrierTotalAmountFormatted: formatCurrency(carrierTotalAmountCents),
    freeShippingApplied: true,
    shippingDiscountCents: carrierTotalAmountCents,
    shippingDiscountFormatted: formatCurrency(carrierTotalAmountCents),
    amountCents: 0,
    amountFormatted: formatCurrency(0),
    residentialSurchargeCents: 0,
    residentialSurchargeFormatted: formatCurrency(0),
    taxableShippingCents: 0,
  };
}
