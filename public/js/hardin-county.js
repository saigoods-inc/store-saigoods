/**
 * Browser copy of lib/hardin-county.js local-delivery / Hardin ZIP allowlist.
 * Keep in sync with server `DEFAULT_HARDIN_COUNTY_ZIPS` / HARDIN_COUNTY_ZIPS env.
 */

export const DEFAULT_HARDIN_COUNTY_ZIPS = [
  "38326", // Counce
  "38327", // Crump
  "38361", // Morris Chapel
  "38365", // Pickwick Dam
  "38370", // Saltillo
  "38372", // Savannah
  "38375", // Hardin area
  "38379", // Stantonville
];

export const LOCAL_DELIVERY_AREA_ERROR =
  "Local delivery is only available for the approved local service area. Use Ship with carrier for this address.";

const ZIP_SET = new Set(DEFAULT_HARDIN_COUNTY_ZIPS);

/**
 * @param {{ state?: string, postalCode?: string }} addr
 */
export function isHardinCountyTnDelivery(addr) {
  const a = addr && typeof addr === "object" ? addr : {};
  const state = String(a.state || "")
    .trim()
    .toUpperCase();
  if (state !== "TN") return false;
  const z = String(a.postalCode || "")
    .replace(/\D/g, "")
    .slice(0, 5);
  if (z.length !== 5) return false;
  return ZIP_SET.has(z);
}

/**
 * Local delivery service area — same Hardin County TN ZIP allowlist.
 * @param {{ state?: string, postalCode?: string }} addr
 */
export function isLocalDeliveryServiceArea(addr) {
  return isHardinCountyTnDelivery(addr);
}

/**
 * @param {{ state?: string, postalCode?: string } | null | undefined} addr
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
export function validateLocalDeliveryServiceArea(addr) {
  const a = addr && typeof addr === "object" ? addr : {};
  const state = String(a.state || "").trim().toUpperCase();
  const zip = String(a.postalCode || "").replace(/\D/g, "").slice(0, 5);
  if (!state || zip.length !== 5) {
    return {
      ok: false,
      error: "Local delivery requires state and ZIP in the approved local service area.",
    };
  }
  if (!isLocalDeliveryServiceArea({ state, postalCode: zip })) {
    return { ok: false, error: LOCAL_DELIVERY_AREA_ERROR };
  }
  return { ok: true };
}
