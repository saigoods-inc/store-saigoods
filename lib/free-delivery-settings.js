import { getSupabaseServiceRoleClient } from "./supabase-admin.js";
import { formatCurrency } from "./quote.js";

export const FREE_DELIVERY_SETTING_KEY = "free_delivery_area";
export const DEFAULT_FREE_DELIVERY_CONFIG = Object.freeze({
  version: 2,
  active: false,
  state: "TN",
  postalCodes: [],
  minimumSubtotalCents: 0,
  productMinimumsCents: {},
});

export function normalizeDeliveryPostalCode(value) {
  const match = String(value || "").trim().match(/^(\d{5})(?:-\d{4})?$/);
  return match ? match[1] : null;
}

export function normalizeFreeDeliveryConfig(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const postalCodes = Array.from(
    new Set(
      (Array.isArray(source.postalCodes) ? source.postalCodes : [])
        .map(normalizeDeliveryPostalCode)
        .filter(Boolean),
    ),
  ).sort();
  const minimum = Math.round(Number(source.minimumSubtotalCents));
  const productMinimumsCents = Object.fromEntries(
    Object.entries(source.productMinimumsCents && typeof source.productMinimumsCents === "object"
      ? source.productMinimumsCents
      : {})
      .map(([slug, value]) => [String(slug || "").trim(), Math.round(Number(value))])
      .filter(([slug, value]) => slug && Number.isFinite(value) && value > 0),
  );
  return {
    version: 2,
    active: source.active === true,
    state: String(source.state || "TN").trim().toUpperCase().slice(0, 2) || "TN",
    postalCodes,
    minimumSubtotalCents: Number.isFinite(minimum) && minimum >= 0 ? minimum : 0,
    productMinimumsCents,
  };
}

export function evaluateFreeDelivery(configValue, { address, subtotalCents, items } = {}) {
  const config = normalizeFreeDeliveryConfig(configValue);
  const postalCode = normalizeDeliveryPostalCode(address?.postalCode || address?.zip);
  const state = String(address?.state || "").trim().toUpperCase();
  const subtotal = Math.max(0, Math.round(Number(subtotalCents) || 0));
  const stateEligible = !config.state || state === config.state;
  const postalCodeEligible = Boolean(postalCode && stateEligible && config.postalCodes.includes(postalCode));
  const productTotalsCents = {};
  for (const item of Array.isArray(items) ? items : []) {
    const slug = String(item?.slug || "").trim();
    if (!slug) continue;
    productTotalsCents[slug] = (productTotalsCents[slug] || 0) + Math.max(0, Math.round(Number(item?.lineTotalCents) || 0));
  }
  const productRequirements = Object.keys(productTotalsCents).map((slug) => {
    const minimumCents = config.productMinimumsCents[slug] || config.minimumSubtotalCents;
    const productSubtotalCents = productTotalsCents[slug];
    return {
      slug,
      minimumCents,
      minimumFormatted: formatCurrency(minimumCents),
      subtotalCents: productSubtotalCents,
      subtotalFormatted: formatCurrency(productSubtotalCents),
      amountRemainingCents: Math.max(0, minimumCents - productSubtotalCents),
      met: productSubtotalCents >= minimumCents,
    };
  });
  const unmetProductRequirements = productRequirements.filter((entry) => !entry.met);
  const minimumMet = productRequirements.length
    ? unmetProductRequirements.length === 0
    : subtotal >= config.minimumSubtotalCents;
  const eligible = config.active && postalCodeEligible && minimumMet;
  const amountRemainingCents = postalCodeEligible
    ? productRequirements.length
      ? unmetProductRequirements.reduce((sum, entry) => sum + entry.amountRemainingCents, 0)
      : Math.max(0, config.minimumSubtotalCents - subtotal)
    : 0;
  let reason = "inactive";
  let message = null;
  if (config.active && !postalCodeEligible) reason = "postal_code_not_eligible";
  if (config.active && postalCodeEligible && !minimumMet) {
    reason = "minimum_not_met";
    const productMessage = unmetProductRequirements.length === 1
      ? ` for ${unmetProductRequirements[0].slug}`
      : "";
    message = `Add ${formatCurrency(amountRemainingCents)} more${productMessage} to qualify for free local delivery in ZIP ${postalCode}.`;
  }
  if (eligible) {
    reason = "eligible";
    message = `Free local delivery applies to ZIP ${postalCode}. SAI Goods will deliver this order without a carrier label.`;
  }
  return {
    active: config.active,
    eligible,
    applied: false,
    reason,
    postalCode,
    postalCodeEligible,
    minimumMet,
    minimumSubtotalCents: config.minimumSubtotalCents,
    minimumSubtotalFormatted: formatCurrency(config.minimumSubtotalCents),
    productMinimumsCents: config.productMinimumsCents,
    productRequirements,
    unmetProductRequirements,
    amountRemainingCents,
    amountRemainingFormatted: formatCurrency(amountRemainingCents),
    message,
  };
}

function missingSettings(error) {
  return error?.code === "42P01" || /admin_runtime_settings/i.test(String(error?.message || ""));
}

export async function loadFreeDeliveryConfig() {
  try {
    const client = getSupabaseServiceRoleClient();
    const { data, error } = await client
      .from("admin_runtime_settings")
      .select("setting_value, updated_at")
      .eq("setting_key", FREE_DELIVERY_SETTING_KEY)
      .maybeSingle();
    if (error) {
      if (missingSettings(error)) return { config: normalizeFreeDeliveryConfig(), source: "bundled_default", migrationRequired: true };
      throw error;
    }
    return {
      config: normalizeFreeDeliveryConfig(data?.setting_value),
      source: data?.setting_value ? "supabase" : "bundled_default",
      migrationRequired: false,
      updatedAt: data?.updated_at || null,
    };
  } catch (error) {
    if (!missingSettings(error)) console.error("[free-delivery] Using inactive defaults.", error);
    return { config: normalizeFreeDeliveryConfig(), source: "bundled_default", migrationRequired: missingSettings(error) };
  }
}

export async function saveFreeDeliveryConfig(value) {
  const config = normalizeFreeDeliveryConfig(value);
  if (config.active && config.postalCodes.length === 0) {
    const error = new Error("Add at least one eligible ZIP code before enabling free delivery.");
    error.statusCode = 400;
    throw error;
  }
  if (config.active && config.minimumSubtotalCents < 1) {
    const error = new Error("Enter a minimum merchandise subtotal before enabling free delivery.");
    error.statusCode = 400;
    throw error;
  }
  const client = getSupabaseServiceRoleClient();
  const { data, error } = await client
    .from("admin_runtime_settings")
    .upsert({ setting_key: FREE_DELIVERY_SETTING_KEY, setting_value: config, updated_at: new Date().toISOString() })
    .select("setting_value, updated_at")
    .single();
  if (error) throw error;
  return { config: normalizeFreeDeliveryConfig(data.setting_value), source: "supabase", updatedAt: data.updated_at };
}
