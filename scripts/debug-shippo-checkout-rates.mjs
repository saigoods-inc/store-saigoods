/**
 * Print full Shippo /shipments/ response for a fixed checkout-style scenario
 * (same build path as checkout: parcels + Shippo addresses + carrier accounts).
 *
 * Default: 1 case nitrile-standard (M), Nolensville TN 37135 (override with DEBUG_SHIP_TO_*).
 *
 * Run: node scripts/debug-shippo-checkout-rates.mjs
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import "../import-env.mjs";
import { buildParcelsForOrder } from "../lib/shippo-order-parcels.js";
import { buildShippoAddressesForShipment } from "../lib/shippo-order-sync.js";
import { getShippoApiBaseUrl } from "../lib/shippo.js";
import { parseShippoCarrierAccountIds } from "../lib/shippo-shipment-sync.js";
import { debugShippoSelectionSnapshot, selectShippoRateForCheckout } from "../lib/shipping-rate-select.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadLocalDotEnv() {
  const envPath = path.join(__dirname, "..", ".env");
  try {
    const raw = readFileSync(envPath, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq < 1) continue;
      const k = t.slice(0, eq).trim();
      const v = t.slice(eq + 1).trim();
      if (!process.env[k]) process.env[k] = v;
    }
  } catch {
    /* optional */
  }
}

const SHIPPO_API_VERSION = "2018-02-08";

function fromEnvOr(name, fallback) {
  const v = String(process.env[name] || "").trim();
  return v || fallback;
}

function syntheticOrderForAddress(addr) {
  return {
    id: 0,
    order_ref: "DEBUG-QUOTE",
    customer_name: "Debug Customer",
    customer_email: "",
    customer_phone: "",
    shipping_address: {
      name: "Debug Customer",
      line1: addr.line1,
      line2: addr.line2,
      city: addr.city,
      state: addr.state,
      postalCode: addr.postalCode,
      country: addr.country || "US",
    },
  };
}

function fullRateRow(r) {
  if (!r || typeof r !== "object") {
    return null;
  }
  return {
    object_id: r.object_id,
    amount: r.amount,
    currency: r.currency,
    provider: r.provider,
    servicelevel: {
      name: r?.servicelevel?.name,
      token: r?.servicelevel?.token,
    },
    estimated_days: r.estimated_days,
    duration_terms: r.duration_terms,
    attributes: r.attributes,
    messages: r.messages,
  };
}

loadLocalDotEnv();

const shipTo = {
  line1: fromEnvOr("DEBUG_SHIP_TO_LINE1", "2009 Ben Hill Ct"),
  line2: fromEnvOr("DEBUG_SHIP_TO_LINE2", ""),
  city: fromEnvOr("DEBUG_SHIP_TO_CITY", "Nolensville"),
  state: fromEnvOr("DEBUG_SHIP_TO_STATE", "TN"),
  postalCode: fromEnvOr("DEBUG_SHIP_TO_POSTAL_CODE", "37135"),
  country: fromEnvOr("DEBUG_SHIP_TO_COUNTRY", "US"),
};

const slug = fromEnvOr("DEBUG_CART_SLUG", "nitrile-standard");
const size = fromEnvOr("DEBUG_CASE_SIZE", "M");
const items = [{ slug, quantities: { [size]: 1 }, boxQuantities: {}, bundleLines: [] }];

if (!String(process.env.SHIPPO_API_TOKEN || "").trim()) {
  console.error("SHIPPO_API_TOKEN is required.");
  process.exit(1);
}

let toFrom;
let parcels;
try {
  toFrom = buildShippoAddressesForShipment(syntheticOrderForAddress(shipTo));
} catch (e) {
  console.error("buildShippoAddressesForShipment failed:", e?.message || e);
  process.exit(1);
}
if (!toFrom.fromAddress) {
  console.error("Missing ship-from: set SHIPPO_FROM_STREET1, CITY, STATE, ZIP in .env");
  process.exit(1);
}
try {
  const plan = buildParcelsForOrder({ items });
  parcels = plan.parcels;
} catch (e) {
  console.error("buildParcelsForOrder failed:", e?.message || e);
  process.exit(1);
}

const body = {
  address_from: toFrom.fromAddress,
  address_to: toFrom.toAddress,
  parcels,
  async: false,
  metadata: "debug_checkout_rates",
};
if (toFrom.returnAddress) {
  body.address_return = toFrom.returnAddress;
}
const ca = parseShippoCarrierAccountIds();
if (ca?.length) {
  body.carrier_accounts = ca;
}

const token = process.env.SHIPPO_API_TOKEN.trim();
const res = await fetch(`${getShippoApiBaseUrl()}/shipments/`, {
  method: "POST",
  headers: {
    Authorization: `ShippoToken ${token}`,
    "Content-Type": "application/json",
    "SHIPPO-API-VERSION": SHIPPO_API_VERSION,
  },
  body: JSON.stringify(body),
});

const json = await res.json().catch(() => ({}));
if (!res.ok) {
  console.log(JSON.stringify({ httpError: res.status, json }, null, 2));
  process.exit(1);
}

const rates = Array.isArray(json.rates) ? json.rates : [];
const selected = selectShippoRateForCheckout(rates);
const debug = debugShippoSelectionSnapshot(rates);
const selectedCents = selected ? Math.round((Number(selected.amount) || 0) * 100) : null;

const upsGsaverInList = rates.find(
  (r) =>
    String(r?.servicelevel?.token || "") === "ups_ground_saver" ||
    (String(r?.provider || "").toUpperCase().includes("UPS") && String(r?.servicelevel?.name || "").toLowerCase().includes("ground saver")),
);

const out = {
  shipFrom: toFrom.fromAddress,
  shipTo: toFrom.toAddress,
  parcelCount: parcels.length,
  parcels,
  shippoShipmentId: json.object_id || null,
  httpStatus: res.status,
  allRates: rates.map((r) => fullRateRow(r)),
  selection: {
    selectedRate: fullRateRow(selected),
    amountCents: selectedCents,
    librarySelector: debug,
    groundSaverInResponse: upsGsaverInList
      ? {
          object_id: upsGsaverInList.object_id,
          amount: upsGsaverInList.amount,
          token: upsGsaverInList?.servicelevel?.token,
          name: upsGsaverInList?.servicelevel?.name,
        }
      : null,
    amountMatchesGroundSaver:
      selected && upsGsaverInList
        ? selected.object_id === upsGsaverInList.object_id && selectedCents === Math.round((Number(upsGsaverInList.amount) || 0) * 100)
        : null,
  },
};

console.log(JSON.stringify(out, null, 2));
if (out.selection.amountMatchesGroundSaver === true) {
  console.error("\n[ok] amountCents matches the Shippo row for UPS Ground Saver (object_id and dollars).");
} else if (out.selection.groundSaverInResponse && out.selection.selectedRate) {
  console.error("\n[compare] Ground Saver is present; selected is:", out.selection.selectedRate?.servicelevel?.token);
} else {
  console.error("\n[info] See selection.librarySelector.reason and allRates.");
}
