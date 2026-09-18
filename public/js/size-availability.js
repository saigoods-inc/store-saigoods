/**
 * Storefront availability from `product.inventory.lines` (merged by `/api/products`).
 * When there are no lines for a product, all sizes/channels are treated as purchasable (legacy).
 * Variants with neither channel tracked retain the existing untracked-stock policy.
 * When `site.storefrontGlobalOutOfStock` is true, merged products include `inventory.globalOutOfStock`
 * and all channels read as unavailable for purchase.
 */

/** @param {object} product */
export function isStorefrontGlobalOutOfStock(product) {
  return Boolean(product?.inventory?.globalOutOfStock);
}

/** @param {object} product */
export function getProductInventoryLines(product) {
  const lines = product?.inventory?.lines;
  if (!Array.isArray(lines)) return [];
  return lines;
}

function findLine(lines, slug, size, channel) {
  const ch = String(channel || "").toLowerCase();
  return lines.find((l) => l.productSlug === slug && l.size === size && l.channel === ch) || null;
}

function boxesPerCaseForProduct(product) {
  const n = Number(product?.boxesPerCase);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 10;
}

function tracked(line) {
  return Boolean(line && line.active !== false && line.track === true);
}

export function getSizePurchaseCapacity(product, sizeLabel) {
  if (isStorefrontGlobalOutOfStock(product)) return { cases: 0, boxes: 0 };
  const lines = getProductInventoryLines(product);
  const caseLine = findLine(lines, product?.slug, sizeLabel, "case");
  const boxLine = findLine(lines, product?.slug, sizeLabel, "box");
  if (!tracked(caseLine) && !tracked(boxLine)) return { cases: Infinity, boxes: Infinity };
  // Match checkout: loose boxes cannot become intact cases; cases can be opened for boxes.
  const cases = caseLine ? availableUnitsForLine(caseLine) : 0;
  const boxes = boxLine ? availableUnitsForLine(boxLine) : 0;
  return { cases, boxes: cases * boxesPerCaseForProduct(product) + boxes };
}

function sellableBoxesForSize(product, sizeLabel) {
  return getSizePurchaseCapacity(product, sizeLabel).boxes;
}

/**
 * Sellable units for this variant row (Infinity when not tracked).
 */
export function availableUnitsForLine(line) {
  if (!line || line.active === false || line.track !== true) return Number.POSITIVE_INFINITY;
  const a = line.available;
  if (a != null && Number.isFinite(Number(a))) return Math.max(0, Number(a));
  const oh = Math.max(0, Math.floor(Number(line.onHand) || 0));
  const r = Math.max(0, Math.floor(Number(line.reserved) || 0));
  return Math.max(0, oh - r);
}

/**
 * @param {object} product
 * @param {string} sizeLabel
 * @param {"box"|"case"} channel
 */
export function isSizeChannelPurchasable(product, sizeLabel, channel) {
  if (isStorefrontGlobalOutOfStock(product)) return false;
  const bpc = boxesPerCaseForProduct(product);
  const needBoxes = String(channel || "").toLowerCase() === "case" ? bpc : 1;
  const stock = getSizePurchaseCapacity(product, sizeLabel);
  return String(channel).toLowerCase() === "case" ? stock.cases >= 1 : stock.boxes >= needBoxes;
}

/**
 * Allocation order: all catalog sizes remain eligible for viewing; spread uses site order.
 * @param {object} _product
 * @param {string[]} allSizes
 */
export function sizesOrderedForAllocation(_product, allSizes) {
  return [...(allSizes || [])];
}

/**
 * True when every positive box/case allocation is within available inventory for tracked variants.
 * @param {object} product
 * @param {object} caseBySize
 * @param {object} boxBySize
 * @param {string[]} allSizes
 */
export function inventoryAllowsAllocations(product, caseBySize, boxBySize, allSizes) {
  if (isStorefrontGlobalOutOfStock(product)) {
    for (const size of allSizes || []) {
      const c = Math.max(0, Math.floor(Number(caseBySize?.[size]) || 0));
      const b = Math.max(0, Math.floor(Number(boxBySize?.[size]) || 0));
      if (c > 0 || b > 0) return false;
    }
    return true;
  }
  const bpc = boxesPerCaseForProduct(product);
  for (const size of allSizes) {
    const c = Math.max(0, Math.floor(Number(caseBySize?.[size]) || 0));
    const b = Math.max(0, Math.floor(Number(boxBySize?.[size]) || 0));
    const needBoxes = c * bpc + b;
    if (needBoxes < 1) continue;
    const stock = getSizePurchaseCapacity(product, size);
    if (stock.cases < c || stock.boxes < needBoxes) return false;
  }
  return true;
}

/**
 * For catalog cards: true when the product has inventory rows and no size has sellable case or box stock.
 */
export function isProductStorefrontOutOfStock(product, allSizes) {
  if (!product || isStorefrontGlobalOutOfStock(product)) return true;
  const list = Array.isArray(allSizes) ? allSizes : [];
  for (const size of list) {
    if (sellableBoxesForSize(product, size) > 0) return false;
  }
  return true;
}

/** @deprecated use isSizeChannelPurchasable */
export function isSizeInStock(slug, sizeLabel) {
  void slug;
  void sizeLabel;
  return true;
}
