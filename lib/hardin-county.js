/**
 * Hardin County, TN delivery check (server-side). Uses USPS-style 5-digit ZIP allowlist.
 * Extend `HARDIN_COUNTY_ZIPS` if Smarty/county data is unavailable.
 */

const DEFAULT_ZIPS = [
  "38326", // Counce
  "38327", // Crump
  "38361", // Morris Chapel
  "38365", // Pickwick Dam
  "38370", // Saltillo
  "38372", // Savannah
  "38375", // Hardin area
  "38379", // Stantonville
];

function hardinZipSet() {
  const raw = process.env.HARDIN_COUNTY_ZIPS?.trim();
  if (!raw) {
    return new Set(DEFAULT_ZIPS);
  }
  const parts = raw.split(/[\s,]+/).map((s) => s.replace(/\D/g, "").slice(0, 5)).filter((z) => z.length === 5);
  return new Set(parts.length ? parts : DEFAULT_ZIPS);
}

let cachedSet = null;
function zipSet() {
  if (!cachedSet) {
    cachedSet = hardinZipSet();
  }
  return cachedSet;
}

/**
 * @param {{ state?: string, postalCode?: string }} addr
 */
export function isHardinCountyTnDelivery(addr) {
  const a = addr && typeof addr === "object" ? addr : {};
  const state = String(a.state || "")
    .trim()
    .toUpperCase();
  if (state !== "TN") {
    return false;
  }
  const z = String(a.postalCode || "")
    .replace(/\D/g, "")
    .slice(0, 5);
  if (z.length !== 5) {
    return false;
  }
  return zipSet().has(z);
}
