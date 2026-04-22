import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { dbSizeLabelsMatchingCatalogSize } from "./size-labels.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let _cached = null;

export function loadParcelPackConfig() {
  if (_cached) {
    return _cached;
  }
  const p = path.join(__dirname, "..", "data", "shippo-parcel-packs.json");
  const raw = fs.readFileSync(p, "utf8");
  _cached = JSON.parse(raw);
  return _cached;
}

/**
 * @param {string} productSlug
 * @param {string} sizeLabel e.g. "S" or legacy "Small"
 * @param {string} packKey box_1 | box_5 | case_1 | case_5
 * @returns {{ length: number, width: number, height: number, weightLb: number } | null}
 */
export function getPackSpec(productSlug, sizeLabel, packKey) {
  const cfg = loadParcelPackConfig();
  const byProduct = cfg.products?.[productSlug];
  if (!byProduct) {
    return null;
  }
  const candidates = [String(sizeLabel || "").trim(), ...dbSizeLabelsMatchingCatalogSize(sizeLabel)].filter(
    Boolean,
  );
  let bySize = null;
  for (const lab of candidates) {
    if (byProduct[lab]) {
      bySize = byProduct[lab];
      break;
    }
  }
  if (!bySize) {
    bySize = byProduct.Small || Object.values(byProduct)[0];
  }
  if (!bySize) {
    return null;
  }
  const spec = bySize[packKey];
  if (!spec || typeof spec.length !== "number") {
    return null;
  }
  return {
    length: spec.length,
    width: spec.width,
    height: spec.height,
    weightLb: Number(spec.weightLb) || 0,
  };
}

export function getSplitRule(bundleId) {
  const cfg = loadParcelPackConfig();
  return cfg.splitRules?.[bundleId] || null;
}
