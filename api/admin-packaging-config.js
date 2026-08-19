import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { assertReportsAuthorized } from "../lib/reports-auth.js";
import {
  loadFulfillmentPackagingConfig,
  setCachedFulfillmentPackagingConfig,
} from "../lib/fulfillment-cartonization.js";
import { getSupabaseServiceRoleClient } from "../lib/supabase-admin.js";
import { assertCartonCapacityIsPhysical } from "../lib/packaging-fit.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, "..", "data", "fulfillment-packaging.json");
const PACKAGING_SETTING_KEY = "fulfillment_packaging";

function useSupabaseBackend() {
  return String(process.env.PACKAGING_CONFIG_BACKEND || "").trim().toLowerCase() === "supabase";
}

function isMissingSettingsTable(error) {
  return error?.code === "42P01" || /admin_runtime_settings/i.test(String(error?.message || ""));
}

function positiveNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0;
}

function assertDimensions(obj, label) {
  for (const key of ["length", "width", "height"]) {
    if (!positiveNumber(obj?.[key])) {
      const e = new Error(`${label} ${key} must be greater than 0.`);
      e.statusCode = 400;
      throw e;
    }
  }
}

function assertWeightedDimensions(obj, label) {
  assertDimensions(obj, label);
  if (!positiveNumber(obj?.weightLb)) {
    const e = new Error(`${label} weightLb must be greater than 0.`);
    e.statusCode = 400;
    throw e;
  }
}

function validatePackagingConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    const e = new Error("Packaging config must be an object.");
    e.statusCode = 400;
    throw e;
  }
  if (!Array.isArray(config.shippingCartons) || !config.shippingCartons.length) {
    const e = new Error("At least one shipping carton is required.");
    e.statusCode = 400;
    throw e;
  }
  for (const carton of config.shippingCartons) {
    if (!String(carton?.id || "").trim()) {
      const e = new Error("Each shipping carton requires an id.");
      e.statusCode = 400;
      throw e;
    }
    assertDimensions(carton.outer, `Carton ${carton.id} outer`);
    assertDimensions(carton.inner, `Carton ${carton.id} inner`);
    assertDimensions(carton.maxRetailBox || carton.inner, `Carton ${carton.id} max retail box`);
    if (!positiveNumber(carton.maxRetailBoxes)) {
      const e = new Error(`Carton ${carton.id} maxRetailBoxes must be greater than 0.`);
      e.statusCode = 400;
      throw e;
    }
    if (!positiveNumber(carton.maxWeightLb)) {
      const e = new Error(`Carton ${carton.id} maxWeightLb must be greater than 0.`);
      e.statusCode = 400;
      throw e;
    }
    if (Number(carton.tareWeightLb) < 0 || Number(carton.costCents) < 0) {
      const e = new Error(`Carton ${carton.id} tare weight and cost cannot be negative.`);
      e.statusCode = 400;
      throw e;
    }
    assertCartonCapacityIsPhysical(carton);
  }
  const products = config.products && typeof config.products === "object" ? config.products : {};
  for (const [slug, product] of Object.entries(products)) {
    const sizes = product?.sizes && typeof product.sizes === "object" ? product.sizes : {};
    for (const [size, profile] of Object.entries(sizes)) {
      assertWeightedDimensions(profile?.retailUnit, `${slug} ${size} retail unit`);
      assertWeightedDimensions(profile?.factoryCase, `${slug} ${size} factory case`);
    }
  }
}

async function readPackagingConfig() {
  if (!useSupabaseBackend()) {
    return { config: loadFulfillmentPackagingConfig(), source: "bundled_file", migrationRequired: false };
  }

  const supabase = getSupabaseServiceRoleClient();
  const { data, error } = await supabase
    .from("admin_runtime_settings")
    .select("setting_value, updated_at")
    .eq("setting_key", PACKAGING_SETTING_KEY)
    .maybeSingle();
  if (error) {
    if (isMissingSettingsTable(error)) {
      return { config: loadFulfillmentPackagingConfig(), source: "bundled_default", migrationRequired: true };
    }
    throw error;
  }
  return {
    config: data?.setting_value || loadFulfillmentPackagingConfig(),
    source: data?.setting_value ? "supabase" : "bundled_default",
    migrationRequired: false,
    updatedAt: data?.updated_at || null,
  };
}

async function persistPackagingConfig(config) {
  if (useSupabaseBackend()) {
    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .from("admin_runtime_settings")
      .upsert({
        setting_key: PACKAGING_SETTING_KEY,
        setting_value: config,
        updated_at: new Date().toISOString(),
      })
      .select("setting_value, updated_at")
      .single();
    if (error) {
      if (isMissingSettingsTable(error)) {
        const e = new Error("Install sql/patch-runtime-packaging-settings.sql before saving packaging profiles.");
        e.statusCode = 409;
        throw e;
      }
      throw error;
    }
    return { config: data.setting_value, source: "supabase", updatedAt: data.updated_at };
  }

  if (process.env.NODE_ENV === "production" || process.env.VERCEL) {
    const e = new Error("Set PACKAGING_CONFIG_BACKEND=supabase before editing packaging profiles in production.");
    e.statusCode = 409;
    throw e;
  }
  await fs.writeFile(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
  setCachedFulfillmentPackagingConfig(config);
  return { config, source: "bundled_file", updatedAt: new Date().toISOString() };
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
      res.status(200).json(await readPackagingConfig());
      return;
    }

    const config = req.body?.config;
    validatePackagingConfig(config);
    const saved = await persistPackagingConfig(config);
    res.status(200).json({ ok: true, ...saved });
  } catch (error) {
    console.error(error);
    res.status(error.statusCode || 500).json({
      error: error.message || "Could not save packaging configuration.",
    });
  }
}
