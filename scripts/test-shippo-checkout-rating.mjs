/**
 * Phase 3: Shippo checkout-style rating (getLiveShippingQuote) + full Shippo rate list.
 * Run from repo root:
 *   SHIPPING_QUOTE_MODE=live_ups SHIPPING_RATE_PROVIDER=shippo node scripts/test-shippo-checkout-rating.mjs
 * Loads .env if present.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getLiveShippingQuote } from "../lib/live-shipping-quote.js";
import { getShippingRateProviderId } from "../lib/shipping-rate-provider.js";
import { buildParcelsForOrder } from "../lib/shippo-order-parcels.js";
import { buildShippoAddressesForShipment } from "../lib/shippo-order-sync.js";
import { getShippoApiBaseUrl } from "../lib/shippo.js";
import { parseShippoCarrierAccountIds } from "../lib/shippo-shipment-sync.js";

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
      const v = t.slice(eq + 1).trim().replace(/^['"]|['"]$/g, "");
      if (!process.env[k]) process.env[k] = v;
    }
  } catch {
    /* optional */
  }
}

function syntheticOrder(address) {
  const a = address && typeof address === "object" ? address : {};
  return {
    id: 0,
    order_ref: "CHECKOUT-QUOTE",
    customer_name: "Test Customer",
    customer_email: "",
    customer_phone: "",
    shipping_address: {
      name: "Test Customer",
      line1: String(a.line1 || "").trim(),
      line2: String(a.line2 || "").trim(),
      city: String(a.city || "").trim(),
      state: String(a.state || "").trim().toUpperCase().slice(0, 2),
      postalCode: String(a.postalCode || "").trim(),
      country: String(a.country || "US")
        .trim()
        .toUpperCase() || "US",
    },
  };
}

const testAddress = {
  line1: "11 W 42nd St",
  line2: "",
  city: "New York",
  state: "NY",
  postalCode: "10036",
  country: "US",
};

const scenarios = [
  {
    name: "1 case only",
    items: [{ slug: "nitrile-standard", quantities: { M: 1 }, boxQuantities: {}, bundleLines: [] }],
  },
  {
    name: "1 case + 1 box",
    items: [{ slug: "nitrile-standard", quantities: { M: 1 }, boxQuantities: { M: 1 }, bundleLines: [] }],
  },
  {
    name: "5 boxes only",
    items: [{ slug: "nitrile-standard", quantities: {}, boxQuantities: { M: 5 }, bundleLines: [] }],
  },
];

async function postShippoShipment(parcels) {
  const { toAddress, fromAddress, returnAddress } = buildShippoAddressesForShipment(syntheticOrder(testAddress));
  if (!fromAddress) {
    return { error: "missing_from", rates: [] };
  }
  const body = {
    address_from: fromAddress,
    address_to: toAddress,
    parcels,
    async: false,
    metadata: "test_script_rate_dump",
  };
  if (returnAddress) {
    body.address_return = returnAddress;
  }
  const ca = parseShippoCarrierAccountIds();
  if (ca?.length) {
    body.carrier_accounts = ca;
  }
  const token = String(process.env.SHIPPO_API_TOKEN || "").trim();
  if (!token) {
    return { error: "no_token", rates: [] };
  }
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
    return { error: { status: res.status, json }, rates: [] };
  }
  return { rates: Array.isArray(json.rates) ? json.rates : [], shipmentObjectId: json.object_id || null };
}

function findHighlights(rates) {
  const list = Array.isArray(rates) ? rates : [];
  const gsaver = list.find(
    (r) =>
      String(r?.servicelevel?.token || "")
        .toLowerCase()
        .includes("ground_saver") ||
      (String(r?.provider || "").toLowerCase().includes("ups") &&
        String(r?.servicelevel?.name || "")
          .toLowerCase()
          .includes("ground") &&
        String(r?.servicelevel?.name || "")
          .toLowerCase()
          .includes("saver")),
  );
  const ug = list.find(
    (r) =>
      String(r?.servicelevel?.token || "") === "ups_ground" ||
      String(r?.servicelevel?.name || "")
        .toLowerCase()
        .trim() === "ups ground",
  );
  const uspsGa = list.find((r) =>
    String(r?.servicelevel?.name || "")
      .toLowerCase()
      .includes("ground advantage"),
  );
  return { ups_ground_saver: gsaver || null, ups_ground: ug || null, usps_ground_advantage: uspsGa || null };
}

function pickRateLine(r) {
  if (!r) return null;
  return {
    object_id: r.object_id,
    amount: r.amount,
    provider: r.provider,
    servicelevel_name: r?.servicelevel?.name,
    servicelevel_token: r?.servicelevel?.token,
  };
}

let upsCallCount = 0;
const origFetch = globalThis.fetch;

function summarizeRatesForPrint(rates, cap = 40) {
  if (!Array.isArray(rates)) {
    return [];
  }
  return rates.slice(0, cap).map((r) => pickRateLine(r));
}

loadLocalDotEnv();
process.env.SHIPPING_QUOTE_MODE = "live_ups";
process.env.SHIPPING_RATE_PROVIDER = "shippo";

const required = [
  "SHIPPO_API_TOKEN",
  "SHIPPO_FROM_STREET1",
  "SHIPPO_FROM_CITY",
  "SHIPPO_FROM_STATE",
  "SHIPPO_FROM_ZIP",
];
const miss = required.filter((k) => !String(process.env[k] || "").trim());

if (miss.length) {
  console.log(
    JSON.stringify(
      {
        ok: false,
        error: "Missing env; cannot run live test",
        miss,
        hint: "Set keys in .env and re-run, or set SHIPPING_RATE_PROVIDER=shippo and fill Shippo ship-from + token",
      },
      null,
      2,
    ),
  );
  process.exitCode = 1;
} else {
  globalThis.fetch = async (url, ...rest) => {
    const s = String(url);
    if (s.includes("ups.com") && /oauth|rating|security\/v1/i.test(s)) {
      upsCallCount += 1;
    }
    return origFetch(url, ...rest);
  };

  (async () => {
    const out = {
      env: {
        SHIPPING_QUOTE_MODE: process.env.SHIPPING_QUOTE_MODE,
        SHIPPING_RATE_PROVIDER: getShippingRateProviderId(),
      },
      scenarios: [],
      upsDirectApiCallCount: upsCallCount,
    };

    for (const sc of scenarios) {
      let plan;
      try {
        plan = buildParcelsForOrder({ items: sc.items });
      } catch (e) {
        out.scenarios.push({ name: sc.name, error: String(e?.message || e) });
        continue;
      }

      const [live, shippoJson] = await Promise.all([
        getLiveShippingQuote({ address: testAddress, cartItems: sc.items, flow: "checkout" }),
        postShippoShipment(plan.parcels),
      ]);

      const s = live.shipping || {};
      const highlights = findHighlights(shippoJson.rates);
      out.scenarios.push({
        name: sc.name,
        liveQuote: {
          parcelSummary: live.parcelSummary,
          parcelCount: live.parcelSummary?.parcelCount,
          selected: {
            provider: s.provider,
            serviceCode: s.serviceCode,
            serviceLabel: s.serviceLabel,
            amountCents: s.amountCents,
            providerQuoteId: s.providerQuoteId,
            quoteStatus: s.quoteStatus,
            canCheckout: live.canCheckout,
            userFacingError: live.userFacingError || null,
          },
        },
        shippoRates: {
          count: shippoJson.rates?.length ?? 0,
          shipmentObjectId: shippoJson.shipmentObjectId || null,
          postError: shippoJson.error || null,
          allRatesTable: summarizeRatesForPrint(shippoJson.rates, 50),
        },
        highlightRates: {
          ups_ground_saver: pickRateLine(highlights.ups_ground_saver),
          ups_ground: pickRateLine(highlights.ups_ground),
          usps_ground_advantage: pickRateLine(highlights.usps_ground_advantage),
        },
      });
    }

    out.upsDirectApiCallCount = upsCallCount;
    out.note =
      "Confirmations: (1) liveQuote.selected matches Shippo selection. (2) If upsDirectApiCallCount=0, no direct UPS call was made during this script. (3) For UI/Supabase/Square, these require browser + payment; verify quoted_* on order row after a real test charge.";

    globalThis.fetch = origFetch;
    console.log(JSON.stringify(out, null, 2));
  })().catch((e) => {
    globalThis.fetch = origFetch;
    console.error(String(e?.stack || e));
    process.exitCode = 1;
  });
}
