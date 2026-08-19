import { formatCurrency } from "./quote.js";
import { getShippingZone } from "./shipping-zone-legacy.js";

const RATE_VERSION = "standard-ground-v2";

function envUsdCents(name, fallbackCents) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === "") return fallbackCents;
  const value = Number.parseFloat(String(raw));
  return Number.isFinite(value) && value >= 0 ? Math.round(value * 100) : fallbackCents;
}

function envPositiveNumber(name, fallback) {
  const value = Number.parseFloat(String(process.env[name] ?? ""));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function envPercent(name, fallbackPercent) {
  const value = Number.parseFloat(String(process.env[name] ?? ""));
  return Number.isFinite(value) && value >= 0 && value <= 100 ? value : fallbackPercent;
}

function parcelWeightLb(parcel) {
  const weight = Math.max(0, Number(parcel?.weight) || 0);
  const unit = String(parcel?.mass_unit || parcel?.massUnit || "lb").trim().toLowerCase();
  return unit === "oz" || unit === "ounce" || unit === "ounces" ? weight / 16 : weight;
}

function parcelVolumeInches(parcel) {
  const unit = String(parcel?.distance_unit || parcel?.distanceUnit || "in").trim().toLowerCase();
  const factor = unit === "cm" ? 1 / 2.54 : 1;
  const length = Math.max(0, Number(parcel?.length) || 0) * factor;
  const width = Math.max(0, Number(parcel?.width) || 0) * factor;
  const height = Math.max(0, Number(parcel?.height) || 0) * factor;
  return length * width * height;
}

export function parcelBillableWeightLb(parcel) {
  const divisor = envPositiveNumber("CHECKOUT_INTERNAL_DIM_DIVISOR", 139);
  const dimensionalWeight = parcelVolumeInches(parcel) / divisor;
  return Math.max(1, Math.ceil(Math.max(parcelWeightLb(parcel), dimensionalWeight)));
}

export function isInternalCheckoutPricingEnabled(flow) {
  if (String(flow || "").trim().toLowerCase() !== "checkout") return false;
  const mode = String(process.env.CHECKOUT_SHIPPING_PRICING_MODE || "shippo")
    .trim()
    .toLowerCase();
  return mode === "internal" || mode === "estimate";
}

function estimatedGroundDays(zone) {
  if (zone <= 2) return 2;
  if (zone <= 4) return 3;
  if (zone <= 6) return 4;
  return 5;
}

/** Deterministic shopper price; actual carrier label rates remain an admin concern. */
export function buildInternalCheckoutShippingQuote({ address, parcelPlan, validation }) {
  const parcels = Array.isArray(parcelPlan?.parcels) ? parcelPlan.parcels : [];
  if (!parcels.length) {
    const error = new Error("No shippable packages were produced for this cart.");
    error.code = "NO_SHIPPING_PARCELS";
    throw error;
  }

  const zone = getShippingZone(address?.postalCode);
  const parcelCount = parcels.length;
  const billableWeightLb = parcels.reduce((sum, parcel) => sum + parcelBillableWeightLb(parcel), 0);
  const baseCents = envUsdCents("CHECKOUT_INTERNAL_BASE_USD", 495);
  const extraParcelCents = envUsdCents("CHECKOUT_INTERNAL_EXTRA_PARCEL_USD", 450);
  const perPoundCents = envUsdCents("CHECKOUT_INTERNAL_PER_LB_USD", 55);
  const zoneStepPerParcelCents = envUsdCents("CHECKOUT_INTERNAL_ZONE_STEP_PER_PARCEL_USD", 60);
  const minimumCents = envUsdCents("CHECKOUT_INTERNAL_MIN_USD", 795);
  const contingencyCents = envUsdCents("CHECKOUT_INTERNAL_CONTINGENCY_USD", 200);
  const riskReservePercent = envPercent("CHECKOUT_INTERNAL_RISK_RESERVE_PERCENT", 8);
  const calculatedCents =
    baseCents +
    Math.max(0, parcelCount - 1) * extraParcelCents +
    billableWeightLb * perPoundCents +
    Math.max(0, zone - 2) * parcelCount * zoneStepPerParcelCents;
  const riskReserveCents = Math.ceil((calculatedCents * riskReservePercent) / 100);
  const amountCents = Math.max(minimumCents, calculatedCents + riskReserveCents) + contingencyCents;
  const estimatedDays = estimatedGroundDays(zone);
  const option = {
    id: "internal:standard_ground",
    provider: "internal",
    serviceCode: "STANDARD_GROUND",
    serviceLabel: "Standard Ground",
    amountCents,
    amountFormatted: formatCurrency(amountCents),
    totalAmountCents: amountCents,
    totalAmountFormatted: formatCurrency(amountCents),
    residentialSurchargeCents: 0,
    residentialSurchargeFormatted: formatCurrency(0),
    currency: "USD",
    estimatedDays,
  };

  return {
    shipping: {
      mode: "internal",
      quoteStatus: "rated",
      serviceCode: option.serviceCode,
      serviceLabel: option.serviceLabel,
      amountCents,
      amountFormatted: option.amountFormatted,
      currency: "USD",
      residentialSurchargeCents: 0,
      residentialSurchargeFormatted: formatCurrency(0),
      taxableShippingCents: amountCents,
      provider: "internal",
      providerQuoteId: option.id,
      addressIsResidential: validation?.shippingContext?.applyResidentialSurcharge === true,
      residentialSurchargePerPackageCents: 0,
      residentialSurchargePackageCount: parcelCount,
      shippingZone: zone,
      billableWeightLb,
      rateVersion: RATE_VERSION,
      contingencyCents,
      riskReservePercent,
      riskReserveCents,
    },
    shippingRateOptions: [option],
    parcelSummary: {
      source: parcelPlan?.source || "cartonization",
      planId: parcelPlan?.planId || null,
      parcelCount,
      parcels,
      fulfillmentUnits: Array.isArray(parcelPlan?.fulfillmentUnits) ? parcelPlan.fulfillmentUnits : [],
      parcelContents: Array.isArray(parcelPlan?.parcelContents) ? parcelPlan.parcelContents : [],
      candidates: Array.isArray(parcelPlan?.candidates) ? parcelPlan.candidates : [],
      internalRated: true,
      shippingZone: zone,
      billableWeightLb,
      rateVersion: RATE_VERSION,
      riskReservePercent,
      riskReserveCents,
    },
    userFacingError: null,
    canCheckout: true,
  };
}
