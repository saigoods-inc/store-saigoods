/** @type {Map<string, string>} legacy or alternate spellings → storefront catalog key */
const TO_CATALOG = new Map([
  ["Small", "S"],
  ["Medium", "M"],
  ["Large", "L"],
  ["X Large", "XL"],
  ["S", "S"],
  ["M", "M"],
  ["L", "L"],
  ["XL", "XL"],
]);

/**
 * Normalize a DB or form `size_label` to the canonical storefront key (S, M, L, XL).
 * @param {string | null | undefined} label
 */
export function catalogSizeFromDbSizeLabel(label) {
  const raw = String(label ?? "").trim();
  if (!raw) return "";
  return TO_CATALOG.get(raw) || raw;
}

/**
 * All `product_variants.size_label` values that should match one logical catalog size.
 * @param {string | null | undefined} catalogSize
 * @returns {string[]}
 */
export function dbSizeLabelsMatchingCatalogSize(catalogSize) {
  const c = catalogSizeFromDbSizeLabel(catalogSize);
  if (!c) return [];
  const out = new Set([c]);
  for (const [legacy, canon] of TO_CATALOG) {
    if (canon === c) out.add(legacy);
    if (legacy === c) out.add(canon);
  }
  return [...out];
}
