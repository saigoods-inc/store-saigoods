import fs from "node:fs/promises";

import { assertReportsAuthorized } from "../lib/reports-auth.js";
import { loadRuntimeFulfillmentPackagingConfig } from "../lib/fulfillment-cartonization.js";
import { axisAlignedBoxCapacity, configuredCartonCapacity } from "../lib/packaging-fit.js";
import {
  BUNDLE_CATALOG_SETTING_KEY,
  clearRuntimeStoreCache,
  loadRuntimeBundleCatalog,
  mergeBundleCatalogIntoStore,
  primeRuntimeStore,
  runtimeCatalogUsesSupabase,
} from "../lib/runtime-store.js";
import { getStorePath, loadBundledStore, setCachedStore } from "../lib/store.js";
import { getSupabaseServiceRoleClient } from "../lib/supabase-admin.js";

function httpError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function assertPositiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw httpError(`${label} must be a whole number greater than 0.`);
}

function validateCatalog(catalog, store, packaging) {
  if (!catalog || typeof catalog !== "object" || !Array.isArray(catalog.products)) {
    throw httpError("Bundle catalog must contain a products array.");
  }
  const storeProducts = new Map((store.products || []).map((product) => [String(product.slug), product]));
  const seenProducts = new Set();
  for (const productConfig of catalog.products) {
    const slug = String(productConfig?.slug || "").trim();
    const product = storeProducts.get(slug);
    if (!product) throw httpError(`Unknown product: ${slug || "missing slug"}.`);
    if (seenProducts.has(slug)) throw httpError(`Product ${slug} appears more than once.`);
    seenProducts.add(slug);
    if (!Array.isArray(productConfig.bundles) || !productConfig.bundles.length) {
      throw httpError(`${product.name} must retain at least one bundle.`);
    }
    if (productConfig.volumePricing != null) {
      const rule = productConfig.volumePricing;
      if (!rule || typeof rule !== "object") throw httpError(`${product.name} volume pricing is invalid.`);
      if (typeof rule.active !== "boolean") throw httpError(`${product.name} volume pricing requires an enabled status.`);
      assertPositiveInteger(rule.minCases, `${product.name} volume-pricing threshold`);
      if (Number(rule.minCases) < 2) throw httpError(`${product.name} volume pricing must start at 2 cartons or more.`);
      assertPositiveInteger(rule.pricePerCaseCents, `${product.name} promotional carton price`);
      if (typeof rule.allowDiscountStacking !== "boolean") throw httpError(`${product.name} volume pricing requires a discount-stacking choice.`);
      const singleCase = productConfig.bundles.find((bundle) => String(bundle.kind).toLowerCase() === "case" && Number(bundle.units) === 1 && bundle.active !== false);
      if (singleCase && Number(rule.pricePerCaseCents) >= Number(singleCase.priceCents)) {
        throw httpError(`${product.name} promotional carton price must be lower than the active 1-carton price.`);
      }
    }
    const seenIds = new Set();
    for (const bundle of productConfig.bundles) {
      const id = String(bundle?.id || "").trim();
      const label = String(bundle?.label || "").trim();
      const kind = String(bundle?.kind || "").trim().toLowerCase();
      if (!/^[a-z0-9][a-z0-9_-]*$/.test(id)) throw httpError(`${product.name} bundle IDs may use lowercase letters, numbers, underscores, and hyphens.`);
      if (seenIds.has(id)) throw httpError(`${product.name} has duplicate bundle ID ${id}.`);
      seenIds.add(id);
      if (!label) throw httpError(`${product.name} bundle ${id} requires a customer-facing name.`);
      if (kind !== "box" && kind !== "case") throw httpError(`${product.name} bundle ${id} must fulfill as box or case.`);
      assertPositiveInteger(bundle.units, `${product.name} ${label} unit count`);
      assertPositiveInteger(bundle.priceCents, `${product.name} ${label} price`);
      if (bundle.hardinPriceCents != null) assertPositiveInteger(bundle.hardinPriceCents, `${product.name} ${label} Hardin price`);
      if (Number(bundle.cogsCents || 0) < 0) throw httpError(`${product.name} ${label} COGS cannot be negative.`);

      const packageProduct = packaging?.products?.[slug];
      if (!packageProduct) throw httpError(`${product.name} has no packaging profile.`);
      const sizes = Object.entries(packageProduct.sizes || {});
      if (!sizes.length) throw httpError(`${product.name} has no packaged sizes.`);
      if (kind === "box") {
        const looseCartons = (packaging.shippingCartons || []).filter((carton) =>
          carton.packageType !== "factory_case" &&
          String(carton.compatibilityGroup || "") === String(packageProduct.compatibilityGroup || packaging.defaults?.compatibilityGroup || ""),
        );
        for (const [size, profile] of sizes) {
          const fits = looseCartons.some((carton) =>
            configuredCartonCapacity(carton) > 0 && axisAlignedBoxCapacity(carton.inner, profile?.retailUnit) > 0,
          );
          if (!fits) throw httpError(`${product.name} ${size} retail boxes do not fit any configured loose-box carton.`);
        }
      }
    }
  }
  return catalog;
}

async function persistCatalog(catalog) {
  if (runtimeCatalogUsesSupabase()) {
    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .from("admin_runtime_settings")
      .upsert({ setting_key: BUNDLE_CATALOG_SETTING_KEY, setting_value: catalog, updated_at: new Date().toISOString() })
      .select("setting_value, updated_at")
      .single();
    if (error) {
      if (error?.code === "42P01") throw httpError("Install sql/patch-runtime-packaging-settings.sql before saving bundles.", 409);
      throw error;
    }
    clearRuntimeStoreCache();
    await primeRuntimeStore({ force: true });
    return { catalog: data.setting_value, source: "supabase", updatedAt: data.updated_at };
  }
  if (process.env.NODE_ENV === "production" || process.env.VERCEL) {
    throw httpError("Set CATALOG_CONFIG_BACKEND=supabase before editing bundles in a deployed environment.", 409);
  }
  const nextStore = mergeBundleCatalogIntoStore(loadBundledStore(), catalog);
  await fs.writeFile(getStorePath(), `${JSON.stringify(nextStore, null, 2)}\n`);
  setCachedStore(nextStore);
  clearRuntimeStoreCache();
  return { catalog, source: "bundled_file", updatedAt: new Date().toISOString() };
}

export default async function handler(req, res) {
  const method = String(req.method || "").toUpperCase();
  if (method !== "GET" && method !== "POST") {
    res.status(405).json({ error: "Method not allowed." });
    return;
  }
  try {
    await assertReportsAuthorized(req);
    if (method === "GET") {
      res.status(200).json(await loadRuntimeBundleCatalog({ force: true }));
      return;
    }
    const store = loadBundledStore();
    const packaging = await loadRuntimeFulfillmentPackagingConfig();
    const catalog = validateCatalog(req.body?.catalog, store, packaging);
    res.status(200).json({ ok: true, ...(await persistCatalog(catalog)) });
  } catch (error) {
    console.error(error);
    res.status(error.statusCode || 500).json({ error: error.message || "Could not save bundle catalog." });
  }
}

export { validateCatalog };
