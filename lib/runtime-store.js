import { getSupabaseServiceRoleClient } from "./supabase-admin.js";
import { loadBundledStore, setCachedStore } from "./store.js";

export const BUNDLE_CATALOG_SETTING_KEY = "store_bundle_catalog";
const CACHE_TTL_MS = 30_000;

let runtimeCache = null;
let runtimeCacheAt = 0;

function useSupabaseBackend() {
  const explicit = String(process.env.CATALOG_CONFIG_BACKEND || "").trim().toLowerCase();
  if (explicit) return explicit === "supabase";
  return String(process.env.PACKAGING_CONFIG_BACKEND || "").trim().toLowerCase() === "supabase";
}

function isMissingSettingsTable(error) {
  return error?.code === "42P01" || /admin_runtime_settings/i.test(String(error?.message || ""));
}

export function bundleCatalogFromStore(store) {
  return {
    $schema: "sai-store-bundle-catalog-v1",
    products: (Array.isArray(store?.products) ? store.products : []).map((product) => ({
      slug: String(product.slug || ""),
      name: String(product.name || product.slug || ""),
      bundles: (Array.isArray(product.bundles) ? product.bundles : []).map((bundle) => ({ ...bundle })),
      ...(product.volumePricing && typeof product.volumePricing === "object"
        ? { volumePricing: { ...product.volumePricing } }
        : {}),
    })),
  };
}

export function mergeBundleCatalogIntoStore(store, catalog) {
  const overrides = new Map(
    (Array.isArray(catalog?.products) ? catalog.products : []).map((product) => [String(product?.slug || ""), product]),
  );
  return {
    ...store,
    products: (Array.isArray(store?.products) ? store.products : []).map((product) => {
      const override = overrides.get(String(product.slug || ""));
      return override && Array.isArray(override.bundles)
        ? {
            ...product,
            bundles: override.bundles.map((bundle) => ({ ...bundle })),
            ...(override.volumePricing && typeof override.volumePricing === "object"
              ? { volumePricing: { ...override.volumePricing } }
              : { volumePricing: undefined }),
          }
        : product;
    }),
  };
}

export function clearRuntimeStoreCache() {
  runtimeCache = null;
  runtimeCacheAt = 0;
}

export async function loadRuntimeBundleCatalog({ force = false } = {}) {
  const fallback = bundleCatalogFromStore(loadBundledStore());
  if (!useSupabaseBackend()) {
    return { catalog: fallback, source: "bundled_file", migrationRequired: false };
  }
  if (!force && runtimeCache && Date.now() - runtimeCacheAt < CACHE_TTL_MS) {
    return runtimeCache;
  }
  try {
    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .from("admin_runtime_settings")
      .select("setting_value, updated_at")
      .eq("setting_key", BUNDLE_CATALOG_SETTING_KEY)
      .maybeSingle();
    if (error) {
      if (isMissingSettingsTable(error)) {
        return { catalog: fallback, source: "bundled_default", migrationRequired: true };
      }
      throw error;
    }
    runtimeCache = {
      catalog: data?.setting_value || fallback,
      source: data?.setting_value ? "supabase" : "bundled_default",
      migrationRequired: false,
      updatedAt: data?.updated_at || null,
    };
    runtimeCacheAt = Date.now();
    return runtimeCache;
  } catch (error) {
    if (!isMissingSettingsTable(error)) {
      console.error("[bundle-catalog] Could not load runtime catalog; using bundled defaults.", error);
    }
    return { catalog: fallback, source: "bundled_default", migrationRequired: isMissingSettingsTable(error) };
  }
}

export async function primeRuntimeStore(options = {}) {
  const base = loadBundledStore();
  const result = await loadRuntimeBundleCatalog(options);
  const store = mergeBundleCatalogIntoStore(base, result.catalog);
  setCachedStore(store);
  return { ...result, store };
}

/**
 * Return bundle selections that are not present in the supplied runtime store.
 * This deliberately checks the exact catalog IDs sent by the browser; labels and
 * legacy aliases must never be used as pricing identifiers.
 */
export function findUnknownRuntimeBundleSelections(store, items) {
  const products = new Map(
    (Array.isArray(store?.products) ? store.products : []).map((product) => [
      String(product?.slug || ""),
      product,
    ]),
  );
  const missing = [];
  for (const item of Array.isArray(items) ? items : []) {
    const slug = String(item?.slug || "").trim();
    const product = products.get(slug);
    const known = new Set(
      (Array.isArray(product?.bundles) ? product.bundles : []).map((bundle) =>
        String(bundle?.id || "").trim(),
      ),
    );
    for (const line of Array.isArray(item?.bundleLines) ? item.bundleLines : []) {
      const id = String(line?.id || "").trim();
      const qty = Math.floor(Number(line?.qty) || 0);
      if (slug && id && qty > 0 && !known.has(id)) missing.push({ slug, id });
    }
  }
  return missing;
}

/**
 * Prime the store for a pricing/checkout request and repair a stale serverless
 * instance on demand. Bundle edits are saved by a different Vercel function, so
 * another warm function can retain the old catalog for up to the normal cache
 * TTL. A selected ID that is absent is the authoritative signal to bypass that
 * cache immediately.
 */
export async function primeRuntimeStoreForItems(items) {
  let result = await primeRuntimeStore();
  let missing = findUnknownRuntimeBundleSelections(result.store, items);
  if (missing.length && runtimeCatalogUsesSupabase()) {
    result = await primeRuntimeStore({ force: true });
    missing = findUnknownRuntimeBundleSelections(result.store, items);
  }
  if (missing.length) {
    const error = new Error(
      "The bundle catalog changed while this order was open. Refresh the page and select the bundle again.",
    );
    error.statusCode = 409;
    error.code = "BUNDLE_CATALOG_MISMATCH";
    error.bundleSelections = missing;
    throw error;
  }
  return result;
}

export function runtimeCatalogUsesSupabase() {
  return useSupabaseBackend();
}
