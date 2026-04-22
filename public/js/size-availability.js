/**
 * Storefront availability from `product.inventory.lines` (merged by `/api/products`).
 * When there are no lines for a product, all sizes/channels are treated as purchasable (legacy).
 * When a product has at least one inventory line, a missing line for a size/channel is not purchasable.
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

function sellableBoxesForSize(product, sizeLabel) {
  const slug = product?.slug;
  if (!slug) return Number.POSITIVE_INFINITY;
  const lines = getProductInventoryLines(product);
  if (!lines.length) return Number.POSITIVE_INFINITY;
  const caseLine = findLine(lines, slug, sizeLabel, "case");
  const boxLine = findLine(lines, slug, sizeLabel, "box");
  const bpc = boxesPerCaseForProduct(product);
  let foundTracked = false;
  let total = 0;
  if (tracked(caseLine)) {
    foundTracked = true;
    total += availableUnitsForLine(caseLine) * bpc;
  }
  if (tracked(boxLine)) {
    foundTracked = true;
    total += availableUnitsForLine(boxLine);
  }
  return foundTracked ? total : Number.POSITIVE_INFINITY;
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
  return sellableBoxesForSize(product, sizeLabel) >= needBoxes;
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
    if (sellableBoxesForSize(product, size) < needBoxes) return false;
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
