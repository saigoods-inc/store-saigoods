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
  const slug = product?.slug;
  if (!slug) return true;
  const lines = getProductInventoryLines(product);
  if (!lines.length) return true;
  const line = findLine(lines, slug, sizeLabel, channel);
  if (!line) return false;
  return availableUnitsForLine(line) > 0;
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
  const slug = product?.slug;
  if (!slug) return true;
  const lines = getProductInventoryLines(product);
  if (!lines.length) return true;
  for (const size of allSizes) {
    const c = Math.max(0, Math.floor(Number(caseBySize?.[size]) || 0));
    const b = Math.max(0, Math.floor(Number(boxBySize?.[size]) || 0));
    if (c > 0) {
      const line = findLine(lines, slug, size, "case");
      if (!line || line.track !== true || availableUnitsForLine(line) < c) return false;
    }
    if (b > 0) {
      const line = findLine(lines, slug, size, "box");
      if (!line || line.track !== true || availableUnitsForLine(line) < b) return false;
    }
  }
  return true;
}

/**
 * For catalog cards: true when the product has inventory rows and no size has sellable case or box stock.
 */
export function isProductStorefrontOutOfStock(product, allSizes) {
  if (!product || isStorefrontGlobalOutOfStock(product)) return true;
  const lines = getProductInventoryLines(product);
  if (!lines.length) return false;
  const slug = product.slug;
  const list = Array.isArray(allSizes) ? allSizes : [];
  for (const size of list) {
    const c = findLine(lines, slug, size, "case");
    const b = findLine(lines, slug, size, "box");
    if (!c && !b) continue;
    if (c && availableUnitsForLine(c) > 0) return false;
    if (b && availableUnitsForLine(b) > 0) return false;
  }
  return true;
}

/** @deprecated use isSizeChannelPurchasable */
export function isSizeInStock(slug, sizeLabel) {
  void slug;
  void sizeLabel;
  return true;
}
