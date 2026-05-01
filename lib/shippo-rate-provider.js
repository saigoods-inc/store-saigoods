import { getShippoApiBaseUrl, isCheckoutShippoLogEnabled, isShippoConfigured } from "./shippo.js";
import { buildShippoAddressesForShipment } from "./shippo-order-sync.js";
import { parseShippoCarrierAccountIds } from "./shippo-shipment-sync.js";
import { selectShippoRateForCheckout } from "./shipping-rate-select.js";

const SHIPPO_API_VERSION = "2018-02-08";
const DEFAULT_TIMEOUT_MS = 20_000;

function parseTimeoutMs() {
  const n = Math.round(Number(process.env.SHIPPO_RATE_TIMEOUT_MS || ""));
  if (Number.isFinite(n) && n >= 1_000 && n <= 120_000) {
    return n;
  }
  return DEFAULT_TIMEOUT_MS;
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
    toFrom = buildShippoAddressesForShipment(buildSyntheticOrderForShipmentQuote(address, customer));
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

  const body = {
    address_from: toFrom.fromAddress,
    address_to: toFrom.toAddress,
    parcels: parcelList,
    async: false,
    metadata: "checkout_shipping_quote",
  };
  if (toFrom.returnAddress) {
    body.address_return = toFrom.returnAddress;
  }
  const carrierAccounts = parseShippoCarrierAccountIds();
  if (carrierAccounts?.length) {
    body.carrier_accounts = carrierAccounts;
  }

  if (isCheckoutShippoLogEnabled()) {
    console.log("[checkout-estimate:shippo] POST /shipments/ payload (rating)", {
      address_from: body.address_from,
      address_to: body.address_to,
      address_return: body.address_return || null,
      parcels: body.parcels,
      carrier_accounts: body.carrier_accounts || null,
      metadata: body.metadata,
    });
  }

  const token = String(process.env.SHIPPO_API_TOKEN || "").trim();
  const url = `${getShippoApiBaseUrl()}/shipments/`;
  const timeoutMs = parseTimeoutMs();

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

  const rateList = json?.rates;
  if (!Array.isArray(rateList) || !rateList.length) {
    const err = new Error("Shippo returned no rates for this shipment.");
    err.name = "ShippingRateProviderError";
    err.category = "provider_error";
    err.code = "SHIPPO_NO_RATES";
    err.debug = { shippoObjectId: json?.object_id || null, bodySample: json };
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

  const shippoShipmentObjectId = String(json?.object_id || "").trim() || null;

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
      return {
        id,
        provider: prov || null,
        serviceCode: t,
        serviceLabel: name,
        amountCents: Math.max(0, Math.round((Number(r?.amount) || 0) * 100)),
        currency: String(r?.currency || "USD")
          .trim()
          .toUpperCase() || "USD",
        estimatedDays: r?.estimated_days != null && r.estimated_days !== "" ? Number(r.estimated_days) : null,
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

  if (isCheckoutShippoLogEnabled()) {
    console.log("[checkout-estimate:shippo] selected rate (what we charge base shipping on)", {
      shippoShipmentId: shippoShipmentObjectId,
      selectedRateObjectId: objectId,
      servicelevel: String(t),
      name,
      amountCents,
      currency,
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
    },
    requestMeta: {
      shippoRatesCount: rateList.length,
    },
    raw: {
      type: "shippo",
      shippoShipmentId: shippoShipmentObjectId,
      selectedRateObjectId: objectId,
      shippoResponseExcerpt: {
        status: res.status,
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
