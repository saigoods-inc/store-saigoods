import { getShippoApiBaseUrl, isCheckoutShippoLogEnabled, isShippoConfigured } from "./shippo.js";
import { buildShippoAddressesForShipment } from "./shippo-order-sync.js";
import { parseShippoCarrierAccountIds } from "./shippo-shipment-sync.js";
import { selectShippoRateForCheckout } from "./shipping-rate-select.js";
import { aggregateShippoPackageRates } from "./shippo-package-rate-set.js";
import { isShippoCarrierRateLimited } from "./shippo-rate-limit.js";
import { legacyEnvShipFromOverride, warehouseAddressFingerprint, withRuntimeWarehouseAddress } from "./warehouse-settings.js";

const SHIPPO_API_VERSION = "2018-02-08";
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_EMPTY_RATES_RETRY_COUNT = 8;
const DEFAULT_EMPTY_RATES_RETRY_DELAY_MS = 1_000;
const DEFAULT_RATE_CONCURRENCY = 3;
const DEFAULT_RATE_LIMIT_RETRY_COUNT = 2;
const DEFAULT_RATE_LIMIT_RETRY_DELAY_MS = 1_500;

function shouldRateAllActiveUpsAccounts() {
  return ["1", "true", "yes", "all_ups"].includes(
    String(process.env.SHIPPO_RATE_ACCOUNT_MODE || "").trim().toLowerCase(),
  );
}

function isUpsRate(rate) {
  const provider = String(rate?.provider || rate?.provider_name || "").trim().toLowerCase();
  return provider === "ups" || provider.includes("united parcel service");
}

function parseTimeoutMs() {
  const n = Math.round(Number(process.env.SHIPPO_RATE_TIMEOUT_MS || ""));
  if (Number.isFinite(n) && n >= 1_000 && n <= 120_000) {
    return n;
  }
  return DEFAULT_TIMEOUT_MS;
}

function parseEmptyRatesRetryCount() {
  const raw = String(process.env.SHIPPO_RATE_EMPTY_RETRY_COUNT ?? "").trim();
  if (!raw) return DEFAULT_EMPTY_RATES_RETRY_COUNT;
  const n = Math.round(Number(raw));
  if (Number.isFinite(n) && n >= 0 && n <= 12) {
    return n;
  }
  return DEFAULT_EMPTY_RATES_RETRY_COUNT;
}

function parseEmptyRatesRetryDelayMs() {
  const n = Math.round(Number(process.env.SHIPPO_RATE_EMPTY_RETRY_DELAY_MS || ""));
  if (Number.isFinite(n) && n >= 100 && n <= 5_000) {
    return n;
  }
  return DEFAULT_EMPTY_RATES_RETRY_DELAY_MS;
}

function parseRateConcurrency() {
  const n = Math.round(Number(process.env.SHIPPO_RATE_CONCURRENCY || ""));
  if (Number.isFinite(n) && n >= 1 && n <= 6) return n;
  return DEFAULT_RATE_CONCURRENCY;
}

function parseRateLimitRetryCount() {
  const raw = String(process.env.SHIPPO_RATE_LIMIT_RETRY_COUNT ?? "").trim();
  if (!raw) return DEFAULT_RATE_LIMIT_RETRY_COUNT;
  const n = Math.round(Number(raw));
  return Number.isFinite(n) && n >= 0 && n <= 4 ? n : DEFAULT_RATE_LIMIT_RETRY_COUNT;
}

function parseRateLimitRetryDelayMs() {
  const n = Math.round(Number(process.env.SHIPPO_RATE_LIMIT_RETRY_DELAY_MS || ""));
  return Number.isFinite(n) && n >= 100 && n <= 10_000 ? n : DEFAULT_RATE_LIMIT_RETRY_DELAY_MS;
}

async function mapWithConcurrency(values, concurrency, fn) {
  const results = new Array(values.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await fn(values[index], index);
    }
  }
  const workerCount = Math.min(values.length, Math.max(1, concurrency));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postShippoShipment({ url, token, body, timeoutMs }) {
  let res;
  let json = {};
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `ShippoToken ${token}`,
        "Content-Type": "application/json",
        "SHIPPO-API-VERSION": SHIPPO_API_VERSION,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    if (e?.name === "TimeoutError") {
      const err = new Error("Shippo rate request timed out.");
      err.name = "ShippingRateProviderError";
      err.category = "timeout_error";
      err.code = "SHIPPO_TIMEOUT";
      throw err;
    }
    const err = new Error("Shippo rate request could not be completed.");
    err.name = "ShippingRateProviderError";
    err.category = "provider_unavailable";
    err.code = "SHIPPO_FETCH_FAILED";
    err.debug = { cause: String(e?.message || e) };
    throw err;
  }

  try {
    json = await res.json();
  } catch {
    json = {};
  }

  if (!res.ok) {
    const msg = extractShippoErrorMessage(json, res.status);
    const err = new Error(msg);
    err.name = "ShippingRateProviderError";
    err.category = res.status >= 500 ? "provider_unavailable" : "provider_error";
    err.code = "SHIPPO_HTTP_ERROR";
    err.statusCode = res.status;
    err.debug = { responseJson: json, requestUrl: url };
    throw err;
  }

  return json;
}

async function getShippoShipment({ url, token, timeoutMs }) {
  let res;
  let json = {};
  try {
    res = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `ShippoToken ${token}`,
        "SHIPPO-API-VERSION": SHIPPO_API_VERSION,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    if (e?.name === "TimeoutError") {
      const err = new Error("Shippo rate request timed out.");
      err.name = "ShippingRateProviderError";
      err.category = "timeout_error";
      err.code = "SHIPPO_TIMEOUT";
      throw err;
    }
    const err = new Error("Shippo rate request could not be completed.");
    err.name = "ShippingRateProviderError";
    err.category = "provider_unavailable";
    err.code = "SHIPPO_FETCH_FAILED";
    err.debug = { cause: String(e?.message || e) };
    throw err;
  }

  try {
    json = await res.json();
  } catch {
    json = {};
  }

  if (!res.ok) {
    const err = new Error(extractShippoErrorMessage(json, res.status));
    err.name = "ShippingRateProviderError";
    err.category = res.status >= 500 ? "provider_unavailable" : "provider_error";
    err.code = "SHIPPO_HTTP_ERROR";
    err.statusCode = res.status;
    err.debug = { responseJson: json, requestUrl: url };
    throw err;
  }

  return json;
}

/**
 * @param {object} normalizedAddress — { line1, line2?, city, state, postalCode, country }
 * @param {{ name?: string, email?: string, phone?: string }} [customer]
 */
function buildSyntheticOrderForShipmentQuote(normalizedAddress, customer = {}) {
  const a = normalizedAddress && typeof normalizedAddress === "object" ? normalizedAddress : {};
  return {
    id: 0,
    order_ref: "CHECKOUT-QUOTE",
    customer_name: String(customer.name || "Customer").trim() || "Customer",
    customer_email: String(customer.email || "").trim(),
    customer_phone: String(customer.phone || "").trim(),
    shipping_address: {
      name: String(customer.name || "Customer").trim() || "Customer",
      line1: String(a.line1 || "").trim(),
      line2: String(a.line2 || "").trim(),
      city: String(a.city || "").trim(),
      state: String(a.state || "").trim().toUpperCase().slice(0, 2),
      postalCode: String(a.postalCode || "").trim(),
      country: String(a.country || a.countryCode || "US")
        .trim()
        .toUpperCase() || "US",
    },
  };
}

/** Shipment rating via Shippo POST /shipments/; parcels from `buildParcelsForOrder`. */
export async function getShippoRateQuoteForCheckout({ address, parcels, customer: customerOpt }) {
  if (!isShippoConfigured()) {
    const err = new Error("Shippo is not configured (missing SHIPPO_API_TOKEN).");
    err.name = "ShippingRateProviderError";
    err.category = "config_error";
    err.code = "SHIPPO_NOT_CONFIGURED";
    throw err;
  }

  const customer = customerOpt && typeof customerOpt === "object" ? customerOpt : {};
  let toFrom;
  try {
    const baseOrder = buildSyntheticOrderForShipmentQuote(address, customer);
    const immediateOverride = legacyEnvShipFromOverride();
    const syntheticOrder = immediateOverride
      ? { ...baseOrder, shippo_from_address_override_json: immediateOverride }
      : await withRuntimeWarehouseAddress(baseOrder);
    toFrom = buildShippoAddressesForShipment(syntheticOrder);
  } catch (e) {
    const err = new Error(
      e && typeof e.message === "string" && e.message.trim()
        ? e.message.trim()
        : "Invalid ship-from (SHIPPO_FROM_*) or address for Shippo rate quote.",
    );
    err.name = "ShippingRateProviderError";
    err.category = e?.code === "SHIPPO_ADDRESS_MISSING_FIELDS" ? "validation_error" : "config_error";
    err.code = e?.code || "SHIPPO_ADDRESS_BUILD_FAILED";
    err.cause = e;
    throw err;
  }
  if (!toFrom.fromAddress) {
    const err = new Error("Ship-from address is not configured (set SHIPPO_FROM_STREET1, CITY, STATE, ZIP).");
    err.name = "ShippingRateProviderError";
    err.category = "config_error";
    err.code = "SHIPPO_FROM_MISSING";
    throw err;
  }

  const parcelList = Array.isArray(parcels) ? parcels : [];
  if (!parcelList.length) {
    const err = new Error("At least one parcel is required for Shippo rating.");
    err.name = "ShippingRateProviderError";
    err.category = "validation_error";
    err.code = "SHIPPO_PARCELS_EMPTY";
    throw err;
  }

  const baseBody = {
    address_from: toFrom.fromAddress,
    address_to: toFrom.toAddress,
    async: false,
    metadata: "checkout_shipping_quote",
  };
  if (toFrom.returnAddress) {
    baseBody.address_return = toFrom.returnAddress;
  }
  const carrierAccounts = parseShippoCarrierAccountIds();
  const rateAllActiveUpsAccounts = shouldRateAllActiveUpsAccounts();
  if (!rateAllActiveUpsAccounts && carrierAccounts?.length) {
    baseBody.carrier_accounts = carrierAccounts;
  }

  if (isCheckoutShippoLogEnabled()) {
    console.log("[checkout-estimate:shippo] POST /shipments/ payload (rating)", {
      address_from: baseBody.address_from,
      address_to: baseBody.address_to,
      address_return: baseBody.address_return || null,
      parcels: parcelList,
      carrier_accounts: baseBody.carrier_accounts || null,
      metadata: baseBody.metadata,
      ratingMode: parcelList.length > 1 ? "per_package_sum" : "single_package",
    });
  }

  const token = String(process.env.SHIPPO_API_TOKEN || "").trim();
  const url = `${getShippoApiBaseUrl()}/shipments/`;
  const timeoutMs = parseTimeoutMs();
  const emptyRatesRetryCount = parseEmptyRatesRetryCount();
  const emptyRatesRetryDelayMs = parseEmptyRatesRetryDelayMs();
  const rateLimitRetryCount = parseRateLimitRetryCount();
  const rateLimitRetryDelayMs = parseRateLimitRetryDelayMs();

  async function rateParcel(parcel, parcelIndex) {
    const body = {
      ...baseBody,
      parcels: [parcel],
      metadata: `checkout_shipping_quote_package_${parcelIndex + 1}_of_${parcelList.length}`,
    };
    let response = await postShippoShipment({ url, token, body, timeoutMs });
    for (let attempt = 0; attempt < rateLimitRetryCount; attempt += 1) {
      if (Array.isArray(response?.rates) && response.rates.length) break;
      if (!isShippoCarrierRateLimited(response)) break;
      await sleep(rateLimitRetryDelayMs * 2 ** attempt);
      response = await postShippoShipment({ url, token, body, timeoutMs });
    }
    if (isShippoCarrierRateLimited(response) && !(Array.isArray(response?.rates) && response.rates.length)) {
      const err = new Error("UPS is temporarily limiting rate requests. Please wait a moment and try again.");
      err.name = "ShippingRateProviderError";
      err.category = "provider_unavailable";
      err.code = "SHIPPO_RATE_LIMITED";
      throw err;
    }
    for (let attempt = 0; attempt < emptyRatesRetryCount; attempt += 1) {
      if (Array.isArray(response?.rates) && response.rates.length) break;
      const shipmentId = String(response?.object_id || "").trim();
      if (isCheckoutShippoLogEnabled()) {
        console.log("[checkout-estimate:shippo] empty package rates returned; polling shipment", {
          package: parcelIndex + 1,
          attempt: attempt + 1,
          maxPolls: emptyRatesRetryCount,
          shippoObjectId: shipmentId || null,
          delayMs: emptyRatesRetryDelayMs,
        });
      }
      if (!shipmentId) {
        const err = new Error("Shippo returned delayed rates without a shipment ID to poll.");
        err.name = "ShippingRateProviderError";
        err.category = "provider_error";
        err.code = "SHIPPO_SHIPMENT_ID_MISSING";
        err.debug = { parcelIndex, attempt: attempt + 1 };
        throw err;
      }
      await sleep(emptyRatesRetryDelayMs);
      response = await getShippoShipment({
        url: `${url}${encodeURIComponent(shipmentId)}/`,
        token,
        timeoutMs,
      });
    }
    return response;
  }

  // Rate independent packages concurrently, but cap the fan-out so large orders
  // do not burst every parcel request into Shippo at once.
  const shipmentResponses = await mapWithConcurrency(
    parcelList,
    parseRateConcurrency(),
    rateParcel,
  );
  const packageRateLists = shipmentResponses.map((response) => {
    const rates = Array.isArray(response?.rates) ? response.rates : [];
    return rateAllActiveUpsAccounts
      ? rates
        .filter(isUpsRate)
        .sort((a, b) => Number(a?.amount || Infinity) - Number(b?.amount || Infinity))
      : rates;
  });
  for (let index = 0; index < shipmentResponses.length; index += 1) {
    const response = shipmentResponses[index];
    if (!packageRateLists[index].length) {
      const err = new Error(
        rateAllActiveUpsAccounts
          ? `Shippo returned no active UPS rates for package ${index + 1}.`
          : `Shippo returned no rates for package ${index + 1}.`,
      );
      err.name = "ShippingRateProviderError";
      err.category = "provider_error";
      err.code = "SHIPPO_NO_RATES";
      err.debug = { parcelIndex: index, shippoObjectId: response?.object_id || null };
      throw err;
    }
  }

  const json = shipmentResponses[0] || {};
  const rateList =
    parcelList.length === 1
      ? packageRateLists[0]
      : aggregateShippoPackageRates(packageRateLists);
  if (!Array.isArray(rateList) || !rateList.length) {
    const err = new Error("Shippo returned no service available for every package.");
    err.name = "ShippingRateProviderError";
    err.category = "provider_error";
    err.code = "SHIPPO_NO_COMMON_PACKAGE_SERVICE";
    err.debug = { shippoShipmentIds: shipmentResponses.map((response) => response?.object_id).filter(Boolean) };
    throw err;
  }

  if (isCheckoutShippoLogEnabled()) {
    console.log("[checkout-estimate:shippo] Shippo /shipments/ response rates", {
      address_to_is_residential: toFrom.toAddress.is_residential,
      rateCount: rateList.length,
      rates: rateList.map((r) => ({
        object_id: r?.object_id,
        servicelevel: r?.servicelevel?.token,
        name: r?.servicelevel?.name,
        amount: r?.amount,
        currency: r?.currency,
      })),
    });
  }

  const shippoShipmentObjectIds = shipmentResponses
    .map((response) => String(response?.object_id || "").trim())
    .filter(Boolean);
  const shippoShipmentObjectId = shippoShipmentObjectIds[0] || null;

  const allRates = rateList
    .map((r) => {
      if (!r || typeof r !== "object") {
        return null;
      }
      const id = String(r.object_id || "").trim();
      if (!id) {
        return null;
      }
      const t = String(r?.servicelevel?.token || r?.servicelevel_token || "").trim() || null;
      const name = String(r?.servicelevel?.name || r?.servicelevel_name || "").trim() || "Shipping";
      const prov = String(r?.provider || r?.provider_name || "")
        .trim()
        .replace(/\s+/g, " ");
      const packageRateObjectIds = Array.isArray(r?.package_rate_object_ids)
        ? r.package_rate_object_ids.map((value) => String(value || "").trim()).filter(Boolean)
        : [id];
      return {
        id,
        provider: prov || null,
        carrierAccount: String(r?.carrier_account || "").trim() || null,
        serviceCode: t,
        serviceLabel: name,
        amountCents: Math.max(0, Math.round((Number(r?.amount) || 0) * 100)),
        currency: String(r?.currency || "USD")
          .trim()
          .toUpperCase() || "USD",
        estimatedDays: r?.estimated_days != null && r.estimated_days !== "" ? Number(r.estimated_days) : null,
        packageRateObjectIds,
        packageShipmentObjectIds: shippoShipmentObjectIds,
      };
    })
    .filter(Boolean);

  const selected = selectShippoRateForCheckout(rateList);
  if (!selected) {
    const err = new Error("Could not select a Shippo rate for this shipment.");
    err.name = "ShippingRateProviderError";
    err.category = "provider_error";
    err.code = "SHIPPO_NO_SELECTABLE_RATE";
    throw err;
  }

  const objectId = String(selected.object_id || "").trim() || null;
  const t = String(selected?.servicelevel?.token || selected?.servicelevel_token || "").trim() || null;
  const name = String(selected?.servicelevel?.name || selected?.servicelevel_name || "").trim() || "Shipping";
  const currency = String(selected?.currency || "USD").trim().toUpperCase() || "USD";
  const amountCents = Math.max(0, Math.round((Number(selected?.amount) || 0) * 100));
  const carrierAccount = String(selected?.carrier_account || "").trim() || null;

  if (isCheckoutShippoLogEnabled()) {
    console.log("[checkout-estimate:shippo] selected rate (what we charge base shipping on)", {
      shippoShipmentId: shippoShipmentObjectId,
      selectedRateObjectId: objectId,
      servicelevel: String(t),
      name,
      amountCents,
      currency,
      carrierAccount,
    });
  }

  return {
    provider: "shippo",
    allRates,
    shippoShipmentObjectId,
    bestRate: {
      serviceCode: t,
      serviceLabel: name,
      amountCents,
      currency,
      providerQuoteId: objectId,
      carrierAccount,
    },
    requestMeta: {
      shipFromFingerprint: warehouseAddressFingerprint(toFrom.fromAddress),
      shippoRatesCount: rateList.length,
      shippoShipmentObjectIds,
      labelRateMode: parcelList.length > 1 ? "per_package_sum" : "single_package",
      carrierAccountMode: rateAllActiveUpsAccounts ? "all_active_ups" : "configured_accounts",
    },
    raw: {
      type: "shippo",
      shippoShipmentId: shippoShipmentObjectId,
      shippoShipmentIds: shippoShipmentObjectIds,
      selectedRateObjectId: objectId,
      shippoResponseExcerpt: {
        status: "ok",
        message: json?.status_message,
      },
    },
  };
}

function extractShippoErrorMessage(json, status) {
  if (json && typeof json === "object" && typeof json.detail === "string" && json.detail.trim()) {
    return json.detail.trim();
  }
  if (json && typeof json === "object" && typeof json.message === "string" && json.message.trim()) {
    return json.message.trim();
  }
  return `Shippo rating failed (HTTP ${status}).`;
}
