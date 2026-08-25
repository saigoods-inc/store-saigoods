import {
  buildFulfillmentPackingPlan,
  loadRuntimeFulfillmentPackagingConfig,
} from "./fulfillment-cartonization.js";
import { getSupabaseServiceRoleClient } from "./supabase-admin.js";

export const MAX_ONLINE_SHIPPING_PACKAGES = 10;
export const MIN_CONFIGURABLE_ONLINE_SHIPPING_PACKAGES = 1;
export const MAX_CONFIGURABLE_ONLINE_SHIPPING_PACKAGES = 25;
export const SHIPPING_PACKAGE_LIMIT_CONTACT_EMAIL = "sales@saigoods.com";
export const SHIPPING_PACKAGE_LIMIT_SETTING_KEY = "online_shipping_package_limit";

export const DEFAULT_SHIPPING_PACKAGE_LIMIT_CONFIG = Object.freeze({
  version: 1,
  maxPackages: MAX_ONLINE_SHIPPING_PACKAGES,
});

const CONFIG_CACHE_TTL_MS = 15_000;
let cachedConfigResult = null;
let cachedConfigAt = 0;

function cacheConfigResult(result) {
  cachedConfigResult = result;
  cachedConfigAt = Date.now();
  return result;
}

function missingSettings(error) {
  return error?.code === "42P01" || /admin_runtime_settings/i.test(String(error?.message || ""));
}

export function normalizeShippingPackageLimitConfig(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const parsed = Math.floor(Number(source.maxPackages));
  return {
    version: 1,
    maxPackages:
      Number.isFinite(parsed) &&
      parsed >= MIN_CONFIGURABLE_ONLINE_SHIPPING_PACKAGES &&
      parsed <= MAX_CONFIGURABLE_ONLINE_SHIPPING_PACKAGES
        ? parsed
        : MAX_ONLINE_SHIPPING_PACKAGES,
  };
}

export async function loadShippingPackageLimitConfig() {
  if (cachedConfigResult && Date.now() - cachedConfigAt < CONFIG_CACHE_TTL_MS) {
    return cachedConfigResult;
  }
  try {
    const client = getSupabaseServiceRoleClient();
    const { data, error } = await client
      .from("admin_runtime_settings")
      .select("setting_value, updated_at")
      .eq("setting_key", SHIPPING_PACKAGE_LIMIT_SETTING_KEY)
      .maybeSingle();
    if (error) {
      if (missingSettings(error)) {
        return cacheConfigResult({
          config: normalizeShippingPackageLimitConfig(DEFAULT_SHIPPING_PACKAGE_LIMIT_CONFIG),
          source: "bundled_default",
          migrationRequired: true,
        });
      }
      throw error;
    }
    return cacheConfigResult({
      config: normalizeShippingPackageLimitConfig(data?.setting_value || DEFAULT_SHIPPING_PACKAGE_LIMIT_CONFIG),
      source: data?.setting_value ? "supabase" : "bundled_default",
      migrationRequired: false,
      updatedAt: data?.updated_at || null,
    });
  } catch (error) {
    if (missingSettings(error)) {
      return cacheConfigResult({
        config: normalizeShippingPackageLimitConfig(DEFAULT_SHIPPING_PACKAGE_LIMIT_CONFIG),
        source: "bundled_default",
        migrationRequired: true,
      });
    }
    console.error("[shipping-package-limit] Settings unavailable; using the safe bundled limit.", error);
    if (cachedConfigResult) return cachedConfigResult;
    return cacheConfigResult({
      config: normalizeShippingPackageLimitConfig(DEFAULT_SHIPPING_PACKAGE_LIMIT_CONFIG),
      source: "unavailable_safe_default",
      migrationRequired: false,
    });
  }
}

export async function saveShippingPackageLimitConfig(value) {
  const requestedMaxPackages = Math.floor(Number(value?.maxPackages));
  if (
    !Number.isFinite(requestedMaxPackages) ||
    requestedMaxPackages < MIN_CONFIGURABLE_ONLINE_SHIPPING_PACKAGES ||
    requestedMaxPackages > MAX_CONFIGURABLE_ONLINE_SHIPPING_PACKAGES
  ) {
    const error = new Error(
      `Online orders must be limited to between ${MIN_CONFIGURABLE_ONLINE_SHIPPING_PACKAGES} and ${MAX_CONFIGURABLE_ONLINE_SHIPPING_PACKAGES} shipping packages.`,
    );
    error.statusCode = 400;
    throw error;
  }
  const config = normalizeShippingPackageLimitConfig(value);
  const client = getSupabaseServiceRoleClient();
  const { data, error } = await client
    .from("admin_runtime_settings")
    .upsert({
      setting_key: SHIPPING_PACKAGE_LIMIT_SETTING_KEY,
      setting_value: config,
      updated_at: new Date().toISOString(),
    })
    .select("setting_value, updated_at")
    .single();
  if (error) throw error;
  return cacheConfigResult({
    config: normalizeShippingPackageLimitConfig(data.setting_value),
    source: "supabase",
    updatedAt: data.updated_at,
  });
}

export function shippingPackageLimitState(parcelSource, maxPackages = MAX_ONLINE_SHIPPING_PACKAGES) {
  const parcels = Array.isArray(parcelSource?.parcels) ? parcelSource.parcels : null;
  const packageCount = Math.max(
    parcels?.length || 0,
    Math.max(0, Math.floor(Number(parcelSource?.parcelCount) || 0)),
  );
  const normalizedMaxPackages = Math.max(1, Math.floor(Number(maxPackages) || MAX_ONLINE_SHIPPING_PACKAGES));
  const exceeded = packageCount > normalizedMaxPackages;
  const message = exceeded
    ? `Orders are limited to ${normalizedMaxPackages} shipping packages. Please reduce the quantity or complete your current order before adding more.`
    : null;

  return {
    maxPackages: normalizedMaxPackages,
    packageCount,
    exceeded,
    contactEmail: SHIPPING_PACKAGE_LIMIT_CONTACT_EMAIL,
    message,
  };
}

export async function resolveOnlineShippingPackagePlan(items) {
  const [config, packageLimitResult] = await Promise.all([
    loadRuntimeFulfillmentPackagingConfig(),
    loadShippingPackageLimitConfig(),
  ]);
  const plan = buildFulfillmentPackingPlan(
    { items: Array.isArray(items) ? items : [] },
    { config },
  );
  const parcels = Array.isArray(plan?.parcels) ? plan.parcels : [];
  const parcelSummary = {
    source: plan?.source || "cartonization",
    planId: plan?.planId || null,
    parcelCount: parcels.length,
    parcels,
    fulfillmentUnits: Array.isArray(plan?.fulfillmentUnits) ? plan.fulfillmentUnits : [],
    parcelContents: Array.isArray(plan?.parcelContents) ? plan.parcelContents : [],
    candidates: Array.isArray(plan?.candidates) ? plan.candidates : [],
  };

  return {
    plan,
    parcelSummary,
    limit: shippingPackageLimitState(parcelSummary, packageLimitResult.config.maxPackages),
  };
}
