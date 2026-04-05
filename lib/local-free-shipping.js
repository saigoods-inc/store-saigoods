/**
 * Free shipping for destinations within a radius of the warehouse (Haversine).
 * Uses OpenStreetMap Nominatim to resolve the buyer’s 5-digit ZIP to lat/lng (one HTTP call per checkout).
 * @see https://operations.osmfoundation.org/policies/nominatim/ — use a descriptive User-Agent.
 */

import { normalizeUsZip } from "./shipping.js";

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const USER_AGENT =
  process.env.NOMINATIM_USER_AGENT ||
  "SAI-Goods-Store/1.0 (https://store.saigoods.com; checkout shipping zone)";

/** Default: 271 Eureka St area, Savannah, TN 38372 — override with WAREHOUSE_LATITUDE / WAREHOUSE_LONGITUDE. */
const DEFAULT_WAREHOUSE = {
  lat: 35.2248,
  lng: -88.2519,
};

function parseCoord(name, fallback) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === "") {
    return fallback;
  }
  const n = Number.parseFloat(String(raw).trim());
  return Number.isFinite(n) ? n : fallback;
}

export function getWarehouseLatLng() {
  return {
    lat: parseCoord("WAREHOUSE_LATITUDE", DEFAULT_WAREHOUSE.lat),
    lng: parseCoord("WAREHOUSE_LONGITUDE", DEFAULT_WAREHOUSE.lng),
  };
}

export function getFreeShippingRadiusMiles() {
  const raw = process.env.FREE_SHIPPING_RADIUS_MILES;
  if (raw == null || String(raw).trim() === "") {
    return 25;
  }
  const n = Number.parseFloat(String(raw).trim());
  if (!Number.isFinite(n) || n <= 0) {
    return 0;
  }
  return n;
}

/** Optional `FREE_SHIPPING_ZIPS=38372,37086` — instant match, no HTTP (recommended on Vercel; Nominatim may block datacenter IPs). */
function getExplicitFreeShippingZipSet() {
  const raw = process.env.FREE_SHIPPING_ZIPS;
  if (raw == null || !String(raw).trim()) {
    return null;
  }

  const set = new Set();
  for (const part of String(raw).split(/[,;|\s]+/)) {
    const z = part.replace(/\D/g, "").slice(0, 5);
    if (z.length === 5) {
      set.add(z);
    }
  }

  return set.size ? set : null;
}

export function haversineMiles(lat1, lon1, lat2, lon2) {
  const R = 3958.7613;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function geocodeUsZipLatLng(zip5) {
  const url = new URL(NOMINATIM_URL);
  url.searchParams.set("postalcode", zip5);
  url.searchParams.set("countrycodes", "us");
  url.searchParams.set("format", "json");
  url.searchParams.set("limit", "1");

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 8000);

  try {
    const res = await fetch(url.toString(), {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      signal: controller.signal,
    });

    if (!res.ok) {
      return null;
    }

    const rows = await res.json();
    const first = Array.isArray(rows) && rows[0];
    if (!first?.lat || !first?.lon) {
      return null;
    }

    const lat = Number.parseFloat(first.lat);
    const lng = Number.parseFloat(first.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return null;
    }

    return { lat, lng };
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/**
 * True if buyer ZIP is within FREE_SHIPPING_RADIUS_MILES of the warehouse.
 * On geocode failure or radius disabled (0), returns false (keep paid UPS quote).
 */
export async function qualifiesForLocalFreeShippingByZip(zipInput) {
  const zip5 = normalizeUsZip(zipInput);
  if (!zip5) {
    return false;
  }

  const explicit = getExplicitFreeShippingZipSet();
  if (explicit?.has(zip5)) {
    return true;
  }

  const radius = getFreeShippingRadiusMiles();
  if (radius <= 0) {
    return false;
  }

  const warehouse = getWarehouseLatLng();
  const dest = await geocodeUsZipLatLng(zip5);
  if (!dest) {
    return false;
  }

  const miles = haversineMiles(warehouse.lat, warehouse.lng, dest.lat, dest.lng);
  return miles <= radius;
}
