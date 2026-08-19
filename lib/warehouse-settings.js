import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getSupabaseServiceRoleClient } from "./supabase-admin.js";
import { validateLocalUsAddressShape, validateShippingAddressForCheckout } from "./address-validation.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, "..", "data", "warehouse-locations.json");
const WAREHOUSE_SETTING_KEY = "warehouse_locations";

function useSupabaseBackend() {
  return String(process.env.WAREHOUSE_CONFIG_BACKEND || process.env.PACKAGING_CONFIG_BACKEND || "")
    .trim()
    .toLowerCase() === "supabase";
}

export function usesPersistedWarehouseConfig() {
  return useSupabaseBackend();
}

function isMissingSettingsTable(error) {
  return error?.code === "42P01" || /admin_runtime_settings/i.test(String(error?.message || ""));
}

function text(value, max = 200) {
  return String(value || "").trim().slice(0, max);
}

function normalizeRoles(raw) {
  return (Array.isArray(raw) ? raw : [])
    .map((role) => text(role, 60))
    .filter(Boolean);
}

export function normalizeWarehouseLocation(raw = {}, index = 0) {
  return {
    key: text(raw.key, 80) || `warehouse-${index + 1}`,
    name: text(raw.name, 120),
    address1: text(raw.address1 || raw.line1, 180),
    address2: text(raw.address2 || raw.line2, 180),
    city: text(raw.city, 100),
    state: text(raw.state, 2).toUpperCase(),
    zip: text(raw.zip || raw.postalCode, 20).replace(/\s+/g, ""),
    country: text(raw.country, 2).toUpperCase() || "US",
    email: text(raw.email, 180),
    phone: text(raw.phone, 40),
    roles: normalizeRoles(raw.roles),
    active: raw.active !== false,
  };
}

export function validateWarehouseLocations(raw) {
  if (!Array.isArray(raw) || !raw.length) {
    const error = new Error("At least one warehouse location is required.");
    error.statusCode = 400;
    throw error;
  }
  const locations = raw.map(normalizeWarehouseLocation);
  const keys = new Set();
  for (const location of locations) {
    if (keys.has(location.key)) {
      const error = new Error(`Warehouse key \"${location.key}\" is duplicated.`);
      error.statusCode = 400;
      throw error;
    }
    keys.add(location.key);
    for (const field of ["name", "address1", "city", "state", "zip", "country", "email", "phone"]) {
      if (!location[field]) {
        const error = new Error(`${location.name || "Warehouse"} requires ${field}.`);
        error.statusCode = 400;
        throw error;
      }
    }
    if (!/^[A-Z]{2}$/.test(location.state)) {
      const error = new Error(`${location.name} requires a two-letter state code.`);
      error.statusCode = 400;
      throw error;
    }
    const addressValidation = validateLocalUsAddressShape({
      line1: location.address1,
      line2: location.address2,
      city: location.city,
      state: location.state,
      postalCode: location.zip,
      country: location.country,
    });
    if (!addressValidation.ok) {
      const error = new Error(`${location.name}: ${addressValidation.error || "Address validation failed."}`);
      error.statusCode = 400;
      error.fieldErrors = addressValidation.fieldErrors || {};
      throw error;
    }
  }
  const defaults = locations.filter(
    (location) => location.active && location.roles.some((role) => role.toLowerCase() === "default ship-from"),
  );
  if (defaults.length !== 1) {
    const error = new Error("Exactly one active warehouse must have the Default ship-from role.");
    error.statusCode = 400;
    throw error;
  }
  return locations;
}

export async function validateWarehouseLocationsWithShippo(
  raw,
  { validateAddress = validateShippingAddressForCheckout } = {},
) {
  const locations = validateWarehouseLocations(raw);
  for (const location of locations) {
    const result = await validateAddress(
      {
        line1: location.address1,
        line2: location.address2,
        city: location.city,
        state: location.state,
        postalCode: location.zip,
        country: location.country,
      },
      { strictShippo: true, forceShippo: true },
    );
    if (!result?.ok) {
      const error = new Error(`${location.name}: ${result?.error || "Shippo could not validate this warehouse address."}`);
      error.statusCode = 400;
      error.fieldErrors = result?.fieldErrors || {};
      error.addressSuggestion = result?.addressSuggestion || null;
      throw error;
    }
  }
  return locations;
}

export function warehouseLocationFromEnv() {
  return normalizeWarehouseLocation({
    key: "default",
    name: process.env.SHIPPO_FROM_NAME || "SAI Goods warehouse",
    address1: process.env.SHIPPO_FROM_STREET1,
    address2: process.env.SHIPPO_FROM_STREET2,
    city: process.env.SHIPPO_FROM_CITY,
    state: process.env.SHIPPO_FROM_STATE,
    zip: process.env.SHIPPO_FROM_ZIP,
    country: process.env.SHIPPO_FROM_COUNTRY || "US",
    email: process.env.SHIPPO_FROM_EMAIL,
    phone: process.env.SHIPPO_FROM_PHONE,
    roles: ["Default ship-from", "Returns", "Inventory"],
    active: true,
  });
}

function isComplete(location) {
  return Boolean(
    location?.name && location?.address1 && location?.city && location?.state && location?.zip && location?.country,
  );
}

export function legacyEnvShipFromOverride() {
  if (useSupabaseBackend()) return null;
  const location = warehouseLocationFromEnv();
  return isComplete(location) ? warehouseLocationToOrderOverride(location) : null;
}

async function readBundledLocations() {
  try {
    const parsed = JSON.parse(await fs.readFile(CONFIG_PATH, "utf8"));
    if (Array.isArray(parsed?.locations) && parsed.locations.length) {
      return { locations: parsed.locations.map(normalizeWarehouseLocation), saved: parsed.saved === true };
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const fallback = warehouseLocationFromEnv();
  return { locations: isComplete(fallback) ? [fallback] : [], saved: false };
}

export async function readWarehouseConfig({ client: injectedClient } = {}) {
  const environment = warehouseLocationFromEnv();
  if (!useSupabaseBackend() && isComplete(environment)) {
    return { locations: [environment], source: "environment", migrationRequired: false, updatedAt: null };
  }
  const bundled = await readBundledLocations();
  const fallback = bundled.saved
    ? bundled.locations
    : isComplete(environment)
      ? [environment]
      : bundled.locations;
  if (!useSupabaseBackend()) {
    return { locations: fallback, source: "bundled_file", migrationRequired: false, updatedAt: null };
  }
  const client = injectedClient || getSupabaseServiceRoleClient();
  const { data, error } = await client
    .from("admin_runtime_settings")
    .select("setting_value, updated_at")
    .eq("setting_key", WAREHOUSE_SETTING_KEY)
    .maybeSingle();
  if (error) {
    if (isMissingSettingsTable(error)) {
      return { locations: fallback, source: "environment", migrationRequired: true, updatedAt: null };
    }
    throw error;
  }
  const stored = Array.isArray(data?.setting_value?.locations)
    ? data.setting_value.locations.map(normalizeWarehouseLocation)
    : null;
  return {
    locations: stored?.length ? stored : fallback,
    source: stored?.length ? "supabase" : "environment",
    migrationRequired: false,
    updatedAt: data?.updated_at || null,
  };
}

export async function persistWarehouseConfig(locations, { client: injectedClient } = {}) {
  const normalized = await validateWarehouseLocationsWithShippo(locations);
  const updatedAt = new Date().toISOString();
  if (useSupabaseBackend()) {
    const client = injectedClient || getSupabaseServiceRoleClient();
    const { data, error } = await client
      .from("admin_runtime_settings")
      .upsert({
        setting_key: WAREHOUSE_SETTING_KEY,
        setting_value: { locations: normalized },
        updated_at: updatedAt,
      })
      .select("setting_value, updated_at")
      .single();
    if (error) {
      if (isMissingSettingsTable(error)) {
        const migrationError = new Error("Install sql/patch-runtime-packaging-settings.sql before saving warehouse locations.");
        migrationError.statusCode = 409;
        throw migrationError;
      }
      throw error;
    }
    return { locations: data.setting_value.locations, source: "supabase", updatedAt: data.updated_at };
  }
  if (process.env.NODE_ENV === "production" || process.env.VERCEL) {
    const error = new Error("Set WAREHOUSE_CONFIG_BACKEND=supabase before editing warehouse locations in production.");
    error.statusCode = 409;
    throw error;
  }
  await fs.writeFile(CONFIG_PATH, `${JSON.stringify({ saved: true, locations: normalized }, null, 2)}\n`);
  return { locations: normalized, source: "bundled_file", updatedAt };
}

export function selectDefaultShipFrom(locations) {
  const active = (Array.isArray(locations) ? locations : []).filter((location) => location?.active !== false);
  return active.find((location) =>
    (location.roles || []).some((role) => String(role).trim().toLowerCase() === "default ship-from"),
  ) || null;
}

export function warehouseLocationToOrderOverride(location) {
  if (!location) return null;
  return {
    name: location.name,
    line1: location.address1,
    line2: location.address2 || "",
    city: location.city,
    state: location.state,
    postalCode: location.zip,
    country: location.country || "US",
    email: location.email,
    phone: location.phone,
  };
}

export async function loadDefaultShipFromOverride(options = {}) {
  const config = await readWarehouseConfig(options);
  return warehouseLocationToOrderOverride(selectDefaultShipFrom(config.locations));
}

export async function withRuntimeWarehouseAddress(orderRow, options = {}) {
  if (orderRow?.shippo_from_address_override_json && orderRow?.shippo_return_address_override_json) return orderRow;
  const config = await readWarehouseConfig(options);
  const defaultLocation = selectDefaultShipFrom(config.locations);
  const returnLocation = (config.locations || []).find(
    (location) => location?.active !== false && (location.roles || []).some((role) => String(role).trim().toLowerCase() === "returns"),
  ) || defaultLocation;
  return {
    ...orderRow,
    shippo_from_address_override_json:
      orderRow?.shippo_from_address_override_json || warehouseLocationToOrderOverride(defaultLocation),
    shippo_return_address_override_json:
      orderRow?.shippo_return_address_override_json || warehouseLocationToOrderOverride(returnLocation),
  };
}

export function warehouseAddressFingerprint(address) {
  const value = address || {};
  return [value.line1 || value.address1 || value.street1, value.line2 || value.address2 || value.street2, value.city, value.state, value.postalCode || value.zip, value.country || value.countryCode || "US"]
    .map((part) => String(part || "").trim().toUpperCase())
    .join("|");
}

function parseObject(raw) {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw;
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function assertStoredRatesMatchWarehouse(orderRow) {
  const ratesPayload = parseObject(orderRow?.shippo_shipment_rates_json);
  const stored = String(ratesPayload?.shipFromFingerprint || "").trim();
  if (!stored) return;
  const current = warehouseAddressFingerprint(parseObject(orderRow?.shippo_from_address_override_json));
  if (current && current !== stored) {
    const error = new Error("The ship-from warehouse changed after these rates were fetched. Refresh current rates before purchasing a label.");
    error.statusCode = 409;
    error.code = "SHIP_FROM_CHANGED";
    throw error;
  }
}
