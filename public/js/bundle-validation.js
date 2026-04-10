/**
 * Browser copy of lib/bundles.js validation helpers — keep in sync with server quote logic.
 */

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

export function getBundleDef(product, bundleId) {
  const defs = product?.bundles;
  if (!Array.isArray(defs)) {
    return null;
  }
  return defs.find((b) => b && String(b.id) === String(bundleId)) || null;
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

  return { boxes: boxes, cases: cases };
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
