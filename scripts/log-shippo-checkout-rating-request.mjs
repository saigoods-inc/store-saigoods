/**
 * Log the exact Shippo POST /shipments/ body used for checkout-style rating
 * (same as getShippoRateQuoteForCheckout: addresses + parcels + carrier_accounts),
 * then print all rates and the selected object_id.
 *
 * Run: node scripts/log-shippo-checkout-rating-request.mjs
 *
 * Optional: set DEBUG_SHIP_TO_* and DEBUG_CART_SLUG / DEBUG_CASE_SIZE. Defaults are examples only
 * and do not mirror live checkout; use the same address as the browser to compare apples-to-apples.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import "../import-env.mjs";
import { buildParcelsForOrder } from "../lib/shippo-order-parcels.js";
import { buildShippoAddressesForShipment } from "../lib/shippo-order-sync.js";
import { getShippoApiBaseUrl } from "../lib/shippo.js";
import { parseShippoCarrierAccountIds } from "../lib/shippo-shipment-sync.js";
import { selectShippoRateForCheckout } from "../lib/shipping-rate-select.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHIPPO_API_VERSION = "2018-02-08";

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
    /* */
  }
}

function fromEnvOr(name, fallback) {
  const v = String(process.env[name] || "").trim();
  return v || fallback;
}

function syntheticOrderForAddress(addr) {
  return {
    id: 0,
    order_ref: "LOG-QUOTE",
    customer_name: "Checkout Customer",
    customer_email: "",
    customer_phone: "",
    shipping_address: {
      name: "Checkout Customer",
      line1: addr.line1,
      line2: addr.line2,
      city: addr.city,
      state: addr.state,
      postalCode: addr.postalCode,
      country: addr.country || "US",
    },
  };
}

async function postShipment(body) {
  const token = String(process.env.SHIPPO_API_TOKEN || "").trim();
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
  return { res, json };
}

function gsaver(rates) {
  if (!Array.isArray(rates)) {
    return null;
  }
  return (
    rates.find((r) => String(r?.servicelevel?.token || "") === "ups_ground_saver") ||
    rates.find(
      (r) => String(r?.servicelevel?.name || "").includes("Ground Saver") && String(r?.provider || "").includes("UPS"),
    ) ||
    null
  );
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
  console.error("SHIPPO_API_TOKEN required");
  process.exit(1);
}

const toFrom = buildShippoAddressesForShipment(syntheticOrderForAddress(shipTo));
if (!toFrom.fromAddress) {
  console.error("Missing SHIPPO_FROM_*");
  process.exit(1);
}

const { parcels: parcelList } = buildParcelsForOrder({ items });

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
const ca = parseShippoCarrierAccountIds();
if (ca?.length) {
  body.carrier_accounts = ca;
}

const { res, json } = await postShipment(body);
const rates = Array.isArray(json.rates) ? json.rates : [];
const selected = selectShippoRateForCheckout(rates);
const g = gsaver(rates);

// --- 1–8: requested log block ---
const report = {
  "1_shipFrom": body.address_from,
  "2_shipTo": body.address_to,
  "3_parcelDimensions": parcelList.map((p) => ({
    length: p.length,
    width: p.width,
    height: p.height,
  })),
  "4_parcelWeight": parcelList.map((p) => p.weight),
  "5_units": {
    distance_unit: parcelList[0]?.distance_unit,
    mass_unit: parcelList[0]?.mass_unit,
    per_parcel: parcelList.map((p) => ({ distance_unit: p.distance_unit, mass_unit: p.mass_unit })),
  },
  "6_carrierAccounts": {
    inRequest: body.carrier_accounts || null,
    fromEnv: {
      SHIPPO_UPS_CARRIER_ACCOUNT_ID: process.env.SHIPPO_UPS_CARRIER_ACCOUNT_ID
        ? "(set, value hidden)"
        : null,
      SHIPPO_CARRIER_ACCOUNT_IDS: process.env.SHIPPO_CARRIER_ACCOUNT_IDS ? "(set, value hidden)" : null,
    },
  },
  "7_allRates": rates.map((r) => ({
    object_id: r.object_id,
    provider: r.provider,
    servicelevel_token: r?.servicelevel?.token,
    servicelevel_name: r?.servicelevel?.name,
    amount: r.amount,
    currency: r.currency,
    estimated_days: r.estimated_days,
  })),
  "8_selectedRateObjectId": selected?.object_id || null,
  "8b_selectedService": selected
    ? { token: selected?.servicelevel?.token, name: selected?.servicelevel?.name, amount: selected?.amount }
    : null,
  shippoHttpStatus: res.status,
  shippoShipmentId: json.object_id || null,
  ups_ground_saverInResponse: g
    ? { object_id: g.object_id, amount: g.amount, estimated_days: g.estimated_days }
    : null,
};

console.log("=== Shippo rating request (checkout code path) ===\n");
console.log(JSON.stringify(report, null, 2));

console.log(
  "\n=== Full JSON body sent to POST /shipments/ (same as production checkout) ===\n",
  JSON.stringify(body, null, 2),
);

// --- Dashboard comparison (11 lb) — do not change app logic; same addresses, only weight override ---
if (parcelList.length === 1) {
  const p = { ...parcelList[0] };
  p.weight = "11";
  const body11 = { ...body, parcels: [p] };
  const { res: r2, json: j2 } = await postShipment(body11);
  const g11 = gsaver(j2.rates || []);
  console.log(
    "\n=== Same request with weight overridden to 11 lb (to match manual Shippo UI if that was 11) ===\n" +
      JSON.stringify(
        {
          httpStatus: r2.status,
          parcelWeight: "11",
          mass_unit: p.mass_unit,
          ups_ground_saver: g11 ? { object_id: g11.object_id, amount: g11.amount } : null,
          note: "If this ≈ $17.73, the ~$8 gap vs checkout is explained by 10 lb (catalog) vs 11 lb (dashboard).",
        },
        null,
        2,
      ),
  );
}

console.log(
  "\n=== Why checkout can differ from Shippo dashboard (no code change) ===\n" +
    "- Checkout parcel weight comes from data/shippo-parcel-packs.json (e.g. nitrile-standard M case_1: weightLb 10).\n" +
    "- If the dashboard shipment used 11 lb, billable weight and carrier tariffs change; Ground Saver will not match 10 lb.\n" +
    "- Also compare: same ship-from/ship-to addresses, same shipment date (we do not set shipment_date on API quote; dashboard may), carrier account scoping, and that UI may round or show a different line item total.\n",
);
