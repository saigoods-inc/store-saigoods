/**
 * UPS Ground ZIP-to-zone lookup from the La Vergne warehouse.
 * Used for admin display, internal shipping estimates, and zone-based free-shipping eligibility.
 * It does not calculate or replace the live carrier rate.
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
