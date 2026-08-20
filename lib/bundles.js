import { bundleUnitPriceCents } from "./pricing-tier.js";

/**
 * Tier bundle definitions on products (store.json) + server-side validation / pricing.
 */

export function getBoxesPerCase(product) {
  const n = Math.floor(Number(product?.boxesPerCase));
  return n > 0 ? n : 10;
}

export function normaliseBundleLines(lines) {
  if (!Array.isArray(lines)) {
    return [];
  }

  return lines
    .map((line) => ({
      id: String(line?.id || "").trim(),
      qty: Math.floor(Number(line?.qty) || 0),
    }))
    .filter((line) => line.id && line.qty > 0);
}

export function mergeBundleLineArrays(a, b) {
  const map = new Map();

  for (const arr of [a, b]) {
    for (const { id, qty } of arr || []) {
      if (!id || qty < 1) {
        continue;
      }
      map.set(id, (map.get(id) || 0) + qty);
    }
  }

  return [...map.entries()].map(([id, qty]) => ({ id, qty }));
}

export function getBundleDef(product, bundleId) {
  const defs = product?.bundles;
  if (!Array.isArray(defs)) {
    return null;
  }
  return defs.find((b) => b && String(b.id) === String(bundleId)) || null;
}

export function normalizeVolumePricingRule(product) {
  const raw = product?.volumePricing;
  if (!raw || typeof raw !== "object") return null;
  const minCases = Math.floor(Number(raw.minCases));
  const pricePerCaseCents = Math.round(Number(raw.pricePerCaseCents));
  if (raw.active !== true || minCases < 2 || pricePerCaseCents < 1) return null;
  return {
    active: true,
    minCases,
    pricePerCaseCents,
    allowDiscountStacking: raw.allowDiscountStacking === true,
  };
}

export function resolveVolumePricing(product, caseCount) {
  const rule = normalizeVolumePricingRule(product);
  const cases = Math.max(0, Math.floor(Number(caseCount) || 0));
  return rule && cases >= rule.minCases ? { ...rule, caseCount: cases } : null;
}

/** Price bundle lines and return an auditable snapshot of any applied volume rule. */
export function priceBundleLines(product, bundleLines, pricingTier = "standard", options = {}) {
  const tier = pricingTier === "hardin" ? "hardin" : "standard";
  const lines = normaliseBundleLines(bundleLines);
  if (!lines.length) return null;
  const localCaseCount = lines.reduce((sum, { id, qty }) => {
    const bundle = getBundleDef(product, id);
    return sum + (String(bundle?.kind || "").toLowerCase() === "case"
      ? Math.max(0, Math.floor(Number(bundle?.units) || 0)) * qty
      : 0);
  }, 0);
  const aggregateCaseCount = Number(options.caseCountOverride);
  const caseCount = Number.isFinite(aggregateCaseCount) && aggregateCaseCount >= localCaseCount
    ? Math.floor(aggregateCaseCount)
    : localCaseCount;
  const rule = options.disableVolumePricing === true ? null : resolveVolumePricing(product, caseCount);
  let totalCents = 0;
  let originalTotalCents = 0;
  for (const { id, qty } of lines) {
    const bundle = getBundleDef(product, id);
    if (!bundle) {
      const error = new Error(`Unknown bundle: ${id}`);
      error.statusCode = 400;
      throw error;
    }
    const regular = bundleUnitPriceCents(bundle, tier);
    originalTotalCents += regular * qty;
    if (rule && String(bundle.kind || "").toLowerCase() === "case") {
      const units = Math.max(1, Math.floor(Number(bundle.units) || 1));
      totalCents += Math.min(regular, units * rule.pricePerCaseCents) * qty;
    } else {
      totalCents += regular * qty;
    }
  }
  const savingsCents = Math.max(0, originalTotalCents - totalCents);
  return {
    totalCents,
    volumePricing: rule && savingsCents > 0
      ? { ...rule, originalTotalCents, savingsCents }
      : null,
  };
}

/**
 * Total built-in shipping allowance for one bundle SKU at qty 1 (cents).
 * Prefer `builtInShippingTotalCents`; else `builtInShippingPerCaseCents` × case `units` for case bundles.
 */
export function builtInShippingAllowanceTotalCents(bundle) {
  if (!bundle || typeof bundle !== "object") {
    return 0;
  }
  const total = Number(bundle.builtInShippingTotalCents);
  if (Number.isFinite(total) && total >= 0) {
    return Math.round(total);
  }
  const perCase = Number(bundle.builtInShippingPerCaseCents);
  const units = Math.max(0, Math.floor(Number(bundle.units) || 0));
  const kind = String(bundle.kind || "").toLowerCase();
  if (kind === "case" && Number.isFinite(perCase) && perCase >= 0 && units > 0) {
    return Math.round(perCase * units);
  }
  return 0;
}

/** Expected profit at list price for one bundle line at qty 1 (cents). */
export function expectedProfitCentsFromBundle(bundle) {
  if (!bundle || typeof bundle !== "object") {
    return 0;
  }
  const p = Number(bundle.expectedProfitCents);
  return Number.isFinite(p) && p >= 0 ? Math.round(p) : 0;
}

/**
 * @param {"standard" | "hardin"} [pricingTier]
 */
export function bundleLinesTotalCents(product, bundleLines, pricingTier = "standard") {
  const lines = normaliseBundleLines(bundleLines);
  if (!lines.length) {
    return null;
  }

  const defs = product?.bundles;
  if (!Array.isArray(defs) || !defs.length) {
    const error = new Error("This product has no bundle pricing configured.");
    error.statusCode = 400;
    throw error;
  }

  return priceBundleLines(product, lines, pricingTier).totalCents;
}

export function requiredUnitsFromBundleLines(product, bundleLines) {
  const lines = normaliseBundleLines(bundleLines);
  let boxes = 0;
  let cases = 0;

  for (const { id, qty } of lines) {
    const b = getBundleDef(product, id);
    if (!b) {
      const error = new Error(`Unknown bundle: ${id}`);
      error.statusCode = 400;
      throw error;
    }
    const units = Math.max(0, Math.floor(Number(b.units) || 0));
    const kind = String(b.kind || "").toLowerCase();
    if (kind === "box") {
      boxes += units * qty;
    } else if (kind === "case") {
      cases += units * qty;
    }
  }

  return { boxes, cases };
}

export function sumQuantitiesMap(quantities, sizes) {
  return sizes.reduce((sum, size) => {
    const n = Math.floor(Number(quantities?.[size]) || 0);
    return sum + (Number.isFinite(n) && n > 0 ? n : 0);
  }, 0);
}

export function isBundleAllocationValid(product, bundleLines, quantities, boxQuantities, sizes) {
  const lines = normaliseBundleLines(bundleLines);
  if (!lines.length) {
    return true;
  }

  if (!Array.isArray(product?.bundles) || !product.bundles.length) {
    return false;
  }

  const req = requiredUnitsFromBundleLines(product, lines);
  const sumCase = sumQuantitiesMap(quantities, sizes);
  const sumBox = sumQuantitiesMap(boxQuantities, sizes);

  return sumCase === req.cases && sumBox === req.boxes;
}

/**
 * Split total cents across `qty` units into integer unit prices (Square line items).
 * @returns {{ qty: number, unitCents: number }[]}
 */
export function splitPriceAcrossUnits(totalCents, qty) {
  const q = Math.floor(Number(qty) || 0);
  const total = Math.round(Number(totalCents) || 0);
  if (q < 1 || total < 0) {
    return [];
  }

  const base = Math.floor(total / q);
  const rem = total - base * q;
  if (rem === 0) {
    return [{ qty: q, unitCents: base }];
  }

  return [
    { qty: rem, unitCents: base + 1 },
    { qty: q - rem, unitCents: base },
  ].filter((row) => row.qty > 0);
}
