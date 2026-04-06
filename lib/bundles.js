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

export function bundleLinesTotalCents(product, bundleLines) {
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

  let total = 0;
  for (const { id, qty } of lines) {
    const b = getBundleDef(product, id);
    if (!b) {
      const error = new Error(`Unknown bundle: ${id}`);
      error.statusCode = 400;
      throw error;
    }
    total += qty * Math.max(0, Number(b.priceCents) || 0);
  }

  return total;
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
