/**
 * UPS Ground zone lookup + product-based shipping rates.
 *
 * Note: This repo uses ES modules (`"type": "module"`). Use `import`/`export`, not `require`.
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

/** First 5 digits of a US ZIP, or null if not enough digits. */
export function normalizeUsZip(input) {
  if (input == null) {
    return null;
  }

  const digits = String(input).replace(/\D/g, "");
  if (digits.length < 5) {
    return null;
  }

  return digits.slice(0, 5);
}

/** Pull 5-digit ZIP from a free-text address (ZIP+4 supported). */
export function extractZipFromText(text) {
  if (text == null || typeof text !== "string") {
    return null;
  }

  const m = text.match(/\b(\d{5})(?:-\d{4})?\b/);
  return m ? m[1] : null;
}

export function resolveShippingZip(customer) {
  if (!customer || typeof customer !== "object") {
    return null;
  }

  return (
    normalizeUsZip(customer.zipCode) ||
    normalizeUsZip(customer.zip) ||
    extractZipFromText(customer.address)
  );
}
