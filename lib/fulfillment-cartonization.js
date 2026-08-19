import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { normalizeItemLineForOrderProcessing } from "./quote.js";
import { dbSizeLabelsMatchingCatalogSize } from "./size-labels.js";
import { getProductMap } from "./store.js";
import { getSupabaseServiceRoleClient } from "./supabase-admin.js";
import { configuredCartonCapacity } from "./packaging-fit.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let cachedConfig = null;
const PACKAGING_SETTING_KEY = "fulfillment_packaging";

export function loadFulfillmentPackagingConfig() {
  if (cachedConfig) {
    return cachedConfig;
  }
  const filePath = path.join(__dirname, "..", "data", "fulfillment-packaging.json");
  cachedConfig = JSON.parse(fs.readFileSync(filePath, "utf8"));
  return cachedConfig;
}

export function setCachedFulfillmentPackagingConfig(config) {
  cachedConfig = config;
}

function useSupabasePackagingConfig() {
  return String(process.env.PACKAGING_CONFIG_BACKEND || "")
    .trim()
    .toLowerCase() === "supabase";
}

function isMissingRuntimeSettingsTable(error) {
  return error?.code === "42P01" || /admin_runtime_settings/i.test(String(error?.message || ""));
}

export async function loadRuntimeFulfillmentPackagingConfig() {
  const fallback = loadFulfillmentPackagingConfig();
  if (!useSupabasePackagingConfig()) {
    return fallback;
  }

  try {
    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .from("admin_runtime_settings")
      .select("setting_value")
      .eq("setting_key", PACKAGING_SETTING_KEY)
      .maybeSingle();
    if (error) {
      if (isMissingRuntimeSettingsTable(error)) return fallback;
      throw error;
    }
    const value = data?.setting_value;
    return value && typeof value === "object" && !Array.isArray(value) ? value : fallback;
  } catch (error) {
    if (isMissingRuntimeSettingsTable(error)) return fallback;
    console.error("[packaging-config] Could not load Supabase settings; using bundled defaults.", error);
    return fallback;
  }
}

function positiveInt(value, fallback = 0) {
  const n = Math.floor(Number(value) || 0);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function positiveNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function getSizeProfile(config, productSlug, sizeLabel) {
  const productProfile = config?.products?.[productSlug];
  if (!productProfile) {
    return null;
  }
  const candidates = [String(sizeLabel || "").trim(), ...dbSizeLabelsMatchingCatalogSize(sizeLabel)].filter(Boolean);
  for (const candidate of candidates) {
    const hit = productProfile.sizes?.[candidate];
    if (hit) {
      return { productProfile, sizeProfile: hit, canonicalSize: candidate };
    }
  }
  const fallbackKey = Object.keys(productProfile.sizes || {})[0];
  if (!fallbackKey) {
    return null;
  }
  return { productProfile, sizeProfile: productProfile.sizes[fallbackKey], canonicalSize: fallbackKey };
}

function parcelFromDimensions(dimensions, metadata) {
  return {
    length: String(dimensions.length),
    width: String(dimensions.width),
    height: String(dimensions.height),
    distance_unit: "in",
    weight: String(dimensions.weightLb),
    mass_unit: "lb",
    metadata: String(metadata || "").slice(0, 100),
  };
}

function addFactoryCaseParcel(plan, { slug, size, profile, source }) {
  const fc = profile.sizeProfile.factoryCase;
  const canonicalSize = profile.canonicalSize || size;
  const parcel = parcelFromDimensions(fc, `${slug}:factory_case:${canonicalSize}`);
  plan.fulfillmentUnits.push({
    type: "factory_case",
    slug,
    size: canonicalSize,
    shipAsIs: profile.productProfile.factoryCaseShipAsIs !== false,
    boxesPerFactoryCase: positiveInt(profile.productProfile.boxesPerFactoryCase, 10),
    source,
    dimensions: { ...fc },
  });
  plan.parcels.push(parcel);
  plan.parcelContents.push({
    parcelIndex: plan.parcels.length - 1,
    type: "factory_case",
    slug,
    size: canonicalSize,
    source,
    retailBoxes: positiveInt(profile.productProfile.boxesPerFactoryCase, 10),
  });
}

function addLooseBoxes(looseBoxes, { slug, size, profile, count, source }) {
  const canonicalSize = profile.canonicalSize || size;
  for (let i = 0; i < count; i++) {
    looseBoxes.push({
      slug,
      size: canonicalSize,
      compatibilityGroup:
        profile.productProfile.compatibilityGroup || profile.config.defaults?.compatibilityGroup || "default",
      weightLb: positiveNumber(profile.sizeProfile.retailUnit.weightLb),
      dimensions: { ...profile.sizeProfile.retailUnit },
      source,
    });
  }
}

function cartonsForGroup(config, compatibilityGroup) {
  return (Array.isArray(config.shippingCartons) ? config.shippingCartons : [])
    .filter((c) => {
      const sameCompatibilityGroup =
        String(c.compatibilityGroup || "") === String(compatibilityGroup || "");
      const packageType = String(c.packageType || "").trim().toLowerCase();
      return sameCompatibilityGroup && packageType !== "factory_case";
    })
    .sort((a, b) => {
      const aOuter = a.outer || {};
      const bOuter = b.outer || {};
      const aVolume =
        positiveNumber(aOuter.length, Infinity) *
        positiveNumber(aOuter.width, Infinity) *
        positiveNumber(aOuter.height, Infinity);
      const bVolume =
        positiveNumber(bOuter.length, Infinity) *
        positiveNumber(bOuter.width, Infinity) *
        positiveNumber(bOuter.height, Infinity);
      return aVolume - bVolume;
    });
}

function sortedDimensions(dimensions) {
  return [
    positiveNumber(dimensions?.length, 0),
    positiveNumber(dimensions?.width, 0),
    positiveNumber(dimensions?.height, 0),
  ].sort((a, b) => b - a);
}

function cartonCanFitBox(carton, box) {
  const maxBox = carton?.maxRetailBox || carton?.inner || {};
  const maxDims = sortedDimensions(maxBox);
  const boxDims = sortedDimensions(box?.dimensions || {});
  return boxDims.every((value, index) => value > 0 && value <= maxDims[index] + 0.001);
}

function chooseCarton(cartons, boxes, offset) {
  const next = boxes[offset];
  if (!next) {
    return null;
  }
  const compatible = cartons.filter((carton) => cartonCanFitBox(carton, next));
  const remaining = boxes.length - offset;
  return (
    compatible.find((carton) => configuredCartonCapacity(carton) >= remaining) ||
    compatible.at(-1) ||
    null
  );
}

function packLooseBoxes(plan, config, looseBoxes) {
  const groups = new Map();
  for (const box of looseBoxes) {
    const key = box.compatibilityGroup || "default";
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(box);
  }

  for (const [compatibilityGroup, boxes] of groups.entries()) {
    const cartons = cartonsForGroup(config, compatibilityGroup);
    if (!cartons.length) {
      throw new Error(`No shipping cartons configured for compatibility group ${compatibilityGroup}.`);
    }
    let offset = 0;
    while (offset < boxes.length) {
      const carton = chooseCarton(cartons, boxes, offset);
      if (!carton) {
        const next = boxes[offset];
        throw new Error(
          `No shipping carton available for ${compatibilityGroup} box ${next?.slug || ""} ${next?.size || ""}.`,
        );
      }
      const maxBoxes = configuredCartonCapacity(carton);
      if (maxBoxes < 1) {
        throw new Error(`Shipping carton ${carton.id} has no valid physical retail-box capacity.`);
      }
      const maxWeight = positiveNumber(carton.maxWeightLb, Infinity);
      const contents = [];
      let weight = positiveNumber(carton.tareWeightLb, 0);
      while (offset < boxes.length && contents.length < maxBoxes) {
        const next = boxes[offset];
        if (!cartonCanFitBox(carton, next)) {
          break;
        }
        const nextWeight = weight + positiveNumber(next.weightLb, 0);
        if (contents.length && nextWeight > maxWeight) {
          break;
        }
        contents.push(next);
        weight = nextWeight;
        offset += 1;
      }
      if (!contents.length) {
        const next = boxes[offset];
        if (!cartonCanFitBox(carton, next)) {
          throw new Error(`Retail box does not fit selected carton ${carton.id}.`);
        }
        contents.push(next);
        weight += positiveNumber(next.weightLb, 0);
        offset += 1;
      }
      const outer = carton.outer || {};
      const parcel = parcelFromDimensions(
        {
          length: outer.length,
          width: outer.width,
          height: outer.height,
          weightLb: Number(weight.toFixed(2)),
        },
        `carton:${carton.id}:boxes=${contents.length}`,
      );
      plan.fulfillmentUnits.push({
        type: "shipping_carton",
        cartonId: carton.id,
        compatibilityGroup,
        retailBoxCount: contents.length,
        tareWeightLb: positiveNumber(carton.tareWeightLb, 0),
        cartonCostCents: positiveInt(carton.costCents, 0),
        packageType: String(carton.packageType || "corrugated_carton"),
        packingMaterial: String(carton.packingMaterial || ""),
        packingInstructions: String(carton.packingInstructions || ""),
        contents: contents.map((b) => ({
          slug: b.slug,
          size: b.size,
          source: b.source,
        })),
      });
      plan.parcels.push(parcel);
      plan.parcelContents.push({
        parcelIndex: plan.parcels.length - 1,
        type: "shipping_carton",
        cartonId: carton.id,
        retailBoxCount: contents.length,
        contents: contents.map((b) => ({
          slug: b.slug,
          size: b.size,
          source: b.source,
        })),
      });
    }
  }
}

/**
 * Deterministic Phase 2 planner. It does not know about storefront bundle prices;
 * it plans physical factory cases and loose retail boxes from normalized order quantities.
 * @param {{ items?: object[] }} orderRow
 */
export function buildFulfillmentPackingPlan(orderRow, options = {}) {
  const config = options.config || loadFulfillmentPackagingConfig();
  const productMap = getProductMap();
  const lines = Array.isArray(orderRow?.items) ? orderRow.items : [];
  const plan = {
    planId: "standard_factory_case_then_cartonize_loose_v1",
    source: "cartonization",
    parcels: [],
    fulfillmentUnits: [],
    parcelContents: [],
    candidates: [],
  };
  const looseBoxes = [];

  for (const item of lines) {
    const product = productMap.get(item?.slug);
    if (!product) {
      continue;
    }
    const normalized = normalizeItemLineForOrderProcessing(item, product);
    if (!normalized.hasPhysicalDemand) {
      continue;
    }
    const productProfile = config.products?.[product.slug];
    const boxesPerFactoryCase = positiveInt(
      productProfile?.boxesPerFactoryCase,
      positiveInt(config.defaults?.boxesPerFactoryCase, 10),
    );

    for (const size of normalized.sizes) {
      const profile = getSizeProfile(config, product.slug, size);
      if (!profile) {
        throw new Error(`Missing fulfillment packaging profile for ${product.slug} ${size}.`);
      }
      profile.config = config;

      const caseCount = positiveInt(normalized.quantities[size], 0);
      for (let i = 0; i < caseCount; i++) {
        addFactoryCaseParcel(plan, {
          slug: product.slug,
          size,
          profile,
          source: "ordered_case",
        });
      }

      const rawLooseBoxes = positiveInt(normalized.boxQuantities[size], 0);
      const normalizedCases = Math.floor(rawLooseBoxes / boxesPerFactoryCase);
      const remainderBoxes = rawLooseBoxes % boxesPerFactoryCase;
      for (let i = 0; i < normalizedCases; i++) {
        addFactoryCaseParcel(plan, {
          slug: product.slug,
          size,
          profile,
          source: "normalized_from_loose_boxes",
        });
      }
      addLooseBoxes(looseBoxes, {
        slug: product.slug,
        size,
        profile,
        count: remainderBoxes,
        source: "loose_box",
      });
    }
  }

  if (!plan.parcels.length && !looseBoxes.length) {
    const e = new Error("No fulfillable physical units derived from order line items.");
    e.code = "NO_FULFILLMENT_UNITS";
    throw e;
  }

  packLooseBoxes(plan, config, looseBoxes);
  plan.candidates.push({
    id: plan.planId,
    parcelCount: plan.parcels.length,
    parcels: plan.parcels,
  });
  return plan;
}

export function buildSelectedPackingPlanOverride(orderRow, opts = {}) {
  const plan = buildFulfillmentPackingPlan(orderRow, { config: opts.config });
  const selectedAt =
    opts.selectedAt instanceof Date
      ? opts.selectedAt.toISOString()
      : String(opts.selectedAt || "").trim() || new Date().toISOString();
  return {
    source: "selected_fulfillment_packing_plan",
    selectedBy: String(opts.selectedBy || "admin").trim() || "admin",
    selectedAt,
    planId: plan.planId,
    parcels: plan.parcels,
    parcelCount: plan.parcels.length,
    fulfillmentUnits: plan.fulfillmentUnits,
    parcelContents: plan.parcelContents,
    candidates: plan.candidates,
  };
}
