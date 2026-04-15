/**
 * LEGACY — UPS Ground zone lookup + product-based shipping rates.
 * Not used by embedded checkout or `buildQuote()` (kept for rollback / offline tools).
 * Active checkout uses Shippo + flat base + residential surcharge (`lib/checkout-totals.js`).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Catalog slug → shippingRates key */
export const SLUG_TO_SHIPPING_TYPE = {
  "nitrile-standard": "standard",
  "black-nitrile-general": "black_general",
  "black-nitrile-heavy-duty": "black_heavy",
};

export const shippingRates = {
  standard: {
    2: 15.23,
    3: 15.23,
    4: 18.65,
    5: 18.66,
    6: 18.66,
    7: 15.23,
    8: 17.25,
  },
  black_general: {
    2: 15.23,
    3: 15.23,
    4: 18.66,
    5: 18.66,
    6: 18.66,
    7: 15.23,
    8: 18.23,
  },
  black_heavy: {
    2: 15.23,
    3: 15.23,
    4: 18.65,
    5: 21.48,
    6: 25.01,
    7: 18.05,
    8: 26.12,
  },
};

let zoneMapCache = null;

function loadZoneMap() {
  if (zoneMapCache) {
    return zoneMapCache;
  }

  const filePath = path.join(__dirname, "..", "data", "ups_zone_map.json");
  const raw = fs.readFileSync(filePath, "utf8");
  zoneMapCache = JSON.parse(raw);
  return zoneMapCache;
}

/**
 * @param {string} zipCode — US ZIP (5 digits, ZIP+4, or partial for lookup)
 * @returns {number} UPS-style zone (defaults to 8 if prefix missing from map)
 */
export function getShippingZone(zipCode) {
  const digits = String(zipCode ?? "").replace(/\D/g, "");
  if (digits.length < 3) {
    return 8;
  }

  const prefix = digits.slice(0, 3);
  const map = loadZoneMap();
  const zone = map[prefix];

  if (typeof zone === "number" && Number.isFinite(zone)) {
    return zone;
  }

  return 8;
}

/**
 * @param {string} zipCode
 * @param {string} productType — `standard` | `black_general` | `black_heavy`
 * @returns {number} shipping dollars for one unit (one case) at this zone
 */
export function calculateShipping(zipCode, productType) {
  const zone = getShippingZone(zipCode);
  const rates = shippingRates[productType];

  if (!rates) {
    throw new Error(`Unknown product type for shipping: ${productType}`);
  }

  const price = rates[zone] ?? rates[8];
  if (price == null || !Number.isFinite(price)) {
    throw new Error(`No shipping rate for product type "${productType}" at zone ${zone}.`);
  }

  return price;
}

/**
 * @param {string} zipCode
 * @param {Array<{ productType: string, quantity: number }>} items
 * @returns {number} total shipping in dollars (sum of per-unit rate × quantity)
 */
export function calculateCartShipping(zipCode, items) {
  const list = Array.isArray(items) ? items : [];
  let total = 0;

  for (const line of list) {
    const qty = Math.max(0, Math.floor(Number(line.quantity) || 0));
    if (qty === 0) {
      continue;
    }

    const unit = calculateShipping(zipCode, line.productType);
    total += unit * qty;
  }

  return Math.round(total * 100) / 100;
}

export function getShippingProductTypeForSlug(slug) {
  const t = SLUG_TO_SHIPPING_TYPE[slug];
  if (!t) {
    throw new Error(`No shipping product type mapped for slug: ${slug}`);
  }
  return t;
}
