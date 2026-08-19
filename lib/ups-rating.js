import { getUpsAccessToken, isUpsAuthConfigured } from "./ups-auth.js";

const DEFAULT_UPS_API_BASE_URL = "https://wwwcie.ups.com";
const DEFAULT_UPS_RATE_PATH = "/api/rating/v2403/Shop";
const DEFAULT_UPS_RATE_TIMEOUT_MS = 20000;

function trimEnv(name) {
  return String(process.env[name] || "").trim();
}

function parseTimeoutMs(raw, fallbackMs) {
  const n = Math.round(Number(raw));
  return Number.isFinite(n) && n >= 1_000 && n <= 120_000 ? n : fallbackMs;
}

function resolveUpsBaseUrl() {
  return trimEnv("UPS_API_BASE_URL") || trimEnv("UPS_OAUTH_BASE_URL") || DEFAULT_UPS_API_BASE_URL;
}

function resolveUpsRatePath() {
  const raw = trimEnv("UPS_RATE_ENDPOINT_PATH") || DEFAULT_UPS_RATE_PATH;
  return raw.startsWith("/") ? raw : `/${raw}`;
}

function resolveUpsShipperAddress() {
  const line1 = trimEnv("UPS_SHIP_FROM_STREET1") || trimEnv("SHIPPO_FROM_STREET1");
  const line2 = trimEnv("UPS_SHIP_FROM_STREET2") || trimEnv("SHIPPO_FROM_STREET2");
  const city = trimEnv("UPS_SHIP_FROM_CITY") || trimEnv("SHIPPO_FROM_CITY");
  const state = (trimEnv("UPS_SHIP_FROM_STATE") || trimEnv("SHIPPO_FROM_STATE")).toUpperCase().slice(0, 2);
  const postalCode = trimEnv("UPS_SHIP_FROM_POSTAL_CODE") || trimEnv("UPS_SHIP_FROM_ZIP") || trimEnv("SHIPPO_FROM_ZIP");
  const countryCode =
    (trimEnv("UPS_SHIP_FROM_COUNTRY_CODE") || trimEnv("UPS_SHIP_FROM_COUNTRY") || trimEnv("SHIPPO_FROM_COUNTRY") || "US")
      .toUpperCase()
      .slice(0, 2);
  const name = trimEnv("UPS_SHIPPER_NAME") || trimEnv("SHIPPO_FROM_NAME") || "SAI Goods";
  const accountNumber = trimEnv("UPS_ACCOUNT_NUMBER") || trimEnv("UPS_SHIPPER_NUMBER");

  return {
    line1,
    line2,
    city,
    state,
    postalCode,
    countryCode,
    name,
    accountNumber,
  };
}

function validateAddressInput(address) {
  const a = address && typeof address === "object" ? address : {};
  const out = {
    line1: String(a.line1 || "").trim(),
    line2: String(a.line2 || "").trim(),
    city: String(a.city || "").trim(),
    state: String(a.state || "").trim().toUpperCase().slice(0, 2),
    postalCode: String(a.postalCode || "").trim(),
    countryCode: String(a.country || a.countryCode || "US")
      .trim()
      .toUpperCase()
      .slice(0, 2),
  };

  const missing = [];
  if (!out.line1) missing.push("line1");
  if (!out.city) missing.push("city");
  if (!out.state) missing.push("state");
  if (!out.postalCode) missing.push("postalCode");
  if (!out.countryCode) missing.push("country");

  return { normalized: out, missing };
}

function normalizeParcelsInput(parcels) {
  const list = Array.isArray(parcels) ? parcels : [];
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const p = list[i] && typeof list[i] === "object" ? list[i] : {};
    const length = String(p.length || "").trim();
    const width = String(p.width || "").trim();
    const height = String(p.height || "").trim();
    const distanceUnit = normalizeDistanceUnitToUpsCode(p.distance_unit || p.distanceUnit || "in");
    const weight = String(p.weight || "").trim();
    const massUnit = normalizeMassUnitToUpsCode(p.mass_unit || p.massUnit || "lb");

    out.push({
      index: i,
      length,
      width,
      height,
      distanceUnit,
      weight,
      massUnit,
      metadata: String(p.metadata || "").trim() || null,
    });
  }
  return out;
}

function normalizeMassUnitToUpsCode(raw) {
  const u = String(raw || "")
    .trim()
    .toLowerCase();
  if (u === "lb" || u === "lbs") {
    return "LBS";
  }
  if (u === "kg" || u === "kgs") {
    return "KGS";
  }
  return String(raw || "")
    .trim()
    .toUpperCase();
}

function normalizeDistanceUnitToUpsCode(raw) {
  const u = String(raw || "")
    .trim()
    .toLowerCase();
  if (u === "in" || u === "inch" || u === "inches") {
    return "IN";
  }
  if (u === "cm" || u === "centimeter" || u === "centimeters") {
    return "CM";
  }
  return String(raw || "")
    .trim()
    .toUpperCase();
}

function createUpsError(category, message, extras = {}) {
  const err = new Error(message);
  err.name = "UpsRateError";
  err.category = category;
  err.statusCode = Number(extras.statusCode) || 502;
  err.retryable = extras.retryable === true;
  err.code = extras.code || null;
  if (extras.debug) {
    err.debug = extras.debug;
  }
  return err;
}

function ensureConfigOrThrow(shipperOverride) {
  if (!isUpsAuthConfigured()) {
    throw createUpsError("config_error", "UPS auth config missing (UPS_CLIENT_ID / UPS_CLIENT_SECRET).", {
      statusCode: 503,
      retryable: false,
      code: "UPS_CONFIG_MISSING",
    });
  }

  const from = shipperOverride
    ? {
        ...resolveUpsShipperAddress(),
        line1: String(shipperOverride.line1 || shipperOverride.address1 || "").trim(),
        line2: String(shipperOverride.line2 || shipperOverride.address2 || "").trim(),
        city: String(shipperOverride.city || "").trim(),
        state: String(shipperOverride.state || "").trim().toUpperCase().slice(0, 2),
        postalCode: String(shipperOverride.postalCode || shipperOverride.zip || "").trim(),
        countryCode: String(shipperOverride.country || shipperOverride.countryCode || "US").trim().toUpperCase().slice(0, 2),
        name: String(shipperOverride.name || "SAI Goods").trim(),
      }
    : resolveUpsShipperAddress();
  const missing = [];
  if (!from.line1) missing.push("UPS_SHIP_FROM_STREET1");
  if (!from.city) missing.push("UPS_SHIP_FROM_CITY");
  if (!from.state) missing.push("UPS_SHIP_FROM_STATE");
  if (!from.postalCode) missing.push("UPS_SHIP_FROM_POSTAL_CODE/UPS_SHIP_FROM_ZIP");
  if (!from.countryCode) missing.push("UPS_SHIP_FROM_COUNTRY_CODE");
  if (!from.accountNumber) missing.push("UPS_ACCOUNT_NUMBER/UPS_SHIPPER_NUMBER");
  if (missing.length) {
    throw createUpsError(
      "config_error",
      `UPS rating config missing: ${missing.join(", ")}.`,
      {
        statusCode: 503,
        retryable: false,
        code: "UPS_CONFIG_INCOMPLETE",
      },
    );
  }
  return from;
}

function normalizeProviderMessage(responseJson, fallbackStatus) {
  const errs = responseJson?.response?.errors || responseJson?.response?.error;
  if (Array.isArray(errs) && errs.length) {
    const msg = String(errs[0]?.message || errs[0]?.code || "").trim();
    if (msg) {
      return msg;
    }
  }
  if (errs && typeof errs === "object") {
    const msg = String(errs.message || errs.code || "").trim();
    if (msg) {
      return msg;
    }
  }
  const fallback = String(responseJson?.response?.status?.description || "").trim();
  if (fallback) {
    return fallback;
  }
  return `UPS rating request failed (HTTP ${fallbackStatus}).`;
}

function parseUpsRatedShipments(responseJson) {
  const rated = responseJson?.RateResponse?.RatedShipment;
  if (!rated) {
    return [];
  }
  if (Array.isArray(rated)) {
    return rated;
  }
  return [rated];
}

function toCents(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    return null;
  }
  return Math.round(n * 100);
}

/** UPS charge object: { CurrencyCode, MonetaryValue } */
function isUsableMoney(m) {
  if (!m || typeof m !== "object") {
    return false;
  }
  const mv = m.MonetaryValue;
  if (mv == null) {
    return false;
  }
  const s = String(mv).trim();
  if (!s) {
    return false;
  }
  return Number.isFinite(Number(s));
}

function firstUsableMoney(...candidates) {
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    if (isUsableMoney(c)) {
      return c;
    }
  }
  return null;
}

/**
 * Negotiated total when UPS returns it (NegotiatedRateCharges / NegotiatedRates).
 * Prefer negotiated MonetaryValue over published TotalCharges.
 */
function extractNegotiatedMoney(shipment) {
  const nrc = shipment?.NegotiatedRateCharges;
  const nrRoot = shipment?.NegotiatedRates;
  const nrNested = nrc?.NegotiatedRates;

  const fromNegotiatedRatesBlock = (block) => {
    if (!block || typeof block !== "object") {
      return null;
    }
    if (Array.isArray(block)) {
      const first = block[0];
      if (first && typeof first === "object") {
        return firstUsableMoney(first.TotalCharge, first.TotalCharges, first.GrandTotal);
      }
      return null;
    }
    return firstUsableMoney(
      block.TotalCharge,
      block.TotalCharges,
      block.GrandTotal,
      block.NetSummaryCharges?.GrandTotal,
    );
  };

  return firstUsableMoney(
    nrc?.TotalCharge,
    fromNegotiatedRatesBlock(nrNested),
    fromNegotiatedRatesBlock(nrRoot),
  );
}

function extractListTotalChargesMoney(shipment) {
  return firstUsableMoney(shipment?.TotalCharges) || null;
}

function normalizedRateFromUpsRatedShipment(shipment) {
  const serviceCode = String(shipment?.Service?.Code || "").trim() || null;
  const serviceLabel =
    String(
      shipment?.Service?.Description ||
        shipment?.TimeInTransit?.ServiceSummary?.Service?.Description ||
        "",
    ).trim() || null;

  const negotiatedMoney = extractNegotiatedMoney(shipment);
  const listMoney = extractListTotalChargesMoney(shipment);
  const transportMoney = firstUsableMoney(shipment?.TransportationCharges) || null;

  const negotiatedCents = toCents(negotiatedMoney?.MonetaryValue);
  const listCents = toCents(listMoney?.MonetaryValue);
  const transportCents = toCents(transportMoney?.MonetaryValue);

  const chosenMoney =
    negotiatedCents != null ? negotiatedMoney : listMoney != null ? listMoney : transportMoney;
  const amountCents = negotiatedCents != null ? negotiatedCents : listCents != null ? listCents : transportCents;
  const currency = String(
    chosenMoney?.CurrencyCode ||
      negotiatedMoney?.CurrencyCode ||
      listMoney?.CurrencyCode ||
      transportMoney?.CurrencyCode ||
      "USD",
  )
    .trim()
    .toUpperCase() || "USD";

  // Temporary: compare negotiated vs published list (TotalCharges) for each service.
  console.log("[ups-rating] negotiated vs list", {
    serviceCode,
    negotiatedMonetaryValue: negotiatedMoney?.MonetaryValue ?? null,
    negotiatedCents,
    totalChargesMonetaryValue: listMoney?.MonetaryValue ?? null,
    totalChargesCents: listCents,
    transportationMonetaryValue: transportMoney?.MonetaryValue ?? null,
    transportationCents: transportCents,
    usedSource: negotiatedCents != null ? "negotiated" : listCents != null ? "total_charges" : "transportation_charges",
    amountCents,
  });

  const deliveryDays = Number(shipment?.GuaranteedDelivery?.BusinessDaysInTransit || shipment?.TimeInTransit?.ServiceSummary?.EstimatedArrival?.BusinessDaysInTransit || 0) || null;

  if (amountCents == null) {
    return null;
  }

  return {
    serviceCode,
    serviceLabel,
    amountCents,
    currency,
    deliveryDays,
    rawRate: shipment,
  };
}

function buildUpsRateRequestBody({ address, parcels, shipper }) {
  const packages = parcels.map((p) => ({
    PackagingType: { Code: "02" },
    Dimensions: {
      UnitOfMeasurement: { Code: p.distanceUnit },
      Length: p.length,
      Width: p.width,
      Height: p.height,
    },
    PackageWeight: {
      UnitOfMeasurement: { Code: p.massUnit },
      Weight: p.weight,
    },
  }));

  return {
    RateRequest: {
      Request: {
        TransactionReference: {
          CustomerContext: "SAI Goods live shipping quote",
        },
      },
      Shipment: {
        Shipper: {
          Name: shipper.name,
          ShipperNumber: shipper.accountNumber,
          Address: {
            AddressLine: shipper.line2 ? [shipper.line1, shipper.line2] : [shipper.line1],
            City: shipper.city,
            StateProvinceCode: shipper.state,
            PostalCode: shipper.postalCode,
            CountryCode: shipper.countryCode,
          },
        },
        ShipTo: {
          Name: "Customer",
          Address: {
            AddressLine: address.line2 ? [address.line1, address.line2] : [address.line1],
            City: address.city,
            StateProvinceCode: address.state,
            PostalCode: address.postalCode,
            CountryCode: address.countryCode,
          },
        },
        ShipFrom: {
          Name: shipper.name,
          Address: {
            AddressLine: shipper.line2 ? [shipper.line1, shipper.line2] : [shipper.line1],
            City: shipper.city,
            StateProvinceCode: shipper.state,
            PostalCode: shipper.postalCode,
            CountryCode: shipper.countryCode,
          },
        },
        PaymentDetails: {
          ShipmentCharge: {
            Type: "01",
            BillShipper: {
              AccountNumber: shipper.accountNumber,
            },
          },
        },
        Package: packages,
      },
    },
  };
}

/**
 * Live UPS rates for a normalized destination + parcel list.
 * Returns server-friendly normalized data; no frontend formatting.
 */
export async function getRates({ address, parcels, shipperAddress }) {
  const shipper = ensureConfigOrThrow(shipperAddress);
  const validatedAddress = validateAddressInput(address);
  if (validatedAddress.missing.length) {
    throw createUpsError(
      "validation_error",
      `Shipping address is incomplete (${validatedAddress.missing.join(", ")}).`,
      {
        statusCode: 400,
        retryable: false,
        code: "UPS_ADDRESS_INVALID",
      },
    );
  }

  const normalizedParcels = normalizeParcelsInput(parcels);
  if (!normalizedParcels.length) {
    throw createUpsError("validation_error", "At least one parcel is required for UPS rating.", {
      statusCode: 400,
      retryable: false,
      code: "UPS_PARCELS_EMPTY",
    });
  }
  for (const p of normalizedParcels) {
    if (!p.length || !p.width || !p.height || !p.weight) {
      throw createUpsError("validation_error", `Parcel ${p.index + 1} is missing dimensions or weight.`, {
        statusCode: 400,
        retryable: false,
        code: "UPS_PARCEL_INVALID",
      });
    }
    if (p.massUnit !== "LBS" && p.massUnit !== "KGS") {
      throw createUpsError(
        "validation_error",
        `Parcel ${p.index + 1} has unsupported mass unit "${p.massUnit}" (use lb/lbs or kg/kgs).`,
        {
          statusCode: 400,
          retryable: false,
          code: "UPS_PARCEL_INVALID_UNIT",
        },
      );
    }
    if (p.distanceUnit !== "IN" && p.distanceUnit !== "CM") {
      throw createUpsError(
        "validation_error",
        `Parcel ${p.index + 1} has unsupported distance unit "${p.distanceUnit}" (use in/inches or cm).`,
        {
          statusCode: 400,
          retryable: false,
          code: "UPS_PARCEL_INVALID_UNIT",
        },
      );
    }
  }

  const token = await getUpsAccessToken();
  const base = resolveUpsBaseUrl().replace(/\/+$/, "");
  const path = resolveUpsRatePath();
  const url = `${base}${path}`;
  const timeoutMs = parseTimeoutMs(process.env.UPS_RATE_TIMEOUT_MS, DEFAULT_UPS_RATE_TIMEOUT_MS);
  const body = buildUpsRateRequestBody({
    address: validatedAddress.normalized,
    parcels: normalizedParcels,
    shipper,
  });

  let response;
  let responseJson = {};
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        transId: `saigoods-${Date.now()}`,
        transactionSrc: "saigoods-live-quote",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (err?.name === "TimeoutError") {
      throw createUpsError("timeout_error", "UPS rating request timed out.", {
        statusCode: 504,
        retryable: true,
        code: "UPS_TIMEOUT",
      });
    }
    throw createUpsError("provider_unavailable", "UPS rating request could not be completed.", {
      statusCode: 502,
      retryable: true,
      code: "UPS_UNAVAILABLE",
      debug: { cause: String(err?.message || err) },
    });
  }

  try {
    responseJson = await response.json();
  } catch {
    responseJson = {};
  }

  if (!response.ok) {
    const providerMessage = normalizeProviderMessage(responseJson, response.status);
    throw createUpsError("provider_error", providerMessage, {
      statusCode: response.status || 502,
      retryable: response.status >= 500,
      code: "UPS_HTTP_ERROR",
      debug: { responseJson },
    });
  }

  const rates = parseUpsRatedShipments(responseJson)
    .map(normalizedRateFromUpsRatedShipment)
    .filter(Boolean)
    .sort((a, b) => a.amountCents - b.amountCents);

  if (!rates.length) {
    throw createUpsError("provider_error", "UPS returned no usable rates.", {
      statusCode: 502,
      retryable: false,
      code: "UPS_NO_RATES",
      debug: { responseJson },
    });
  }

  return {
    provider: "ups",
    request: {
      address: validatedAddress.normalized,
      parcelCount: normalizedParcels.length,
    },
    rates: rates.map((r) => ({
      serviceCode: r.serviceCode,
      serviceLabel: r.serviceLabel,
      amountCents: r.amountCents,
      currency: r.currency,
      deliveryDays: r.deliveryDays,
    })),
    bestRate: {
      serviceCode: rates[0].serviceCode,
      serviceLabel: rates[0].serviceLabel,
      amountCents: rates[0].amountCents,
      currency: rates[0].currency,
      deliveryDays: rates[0].deliveryDays,
    },
    debug: {
      upsRequestUrl: url,
      rawUpsResponse: responseJson,
    },
  };
}
