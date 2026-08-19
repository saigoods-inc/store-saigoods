/**
 * LEGACY — UPS Ground ZIP-to-zone lookup.
 * Used by admin order summary for display; not used by embedded checkout or `buildQuote()`.
 * Active checkout shipping is calculated elsewhere; this module only provides ZIP-to-zone lookup for admin display.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
