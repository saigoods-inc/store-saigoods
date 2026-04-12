/**
 * In-stock size labels per product slug (must match `site.sizes` in data/store.json).
 * Slugs not listed here: all sizes treated as available.
 */
export const SIZE_AVAILABILITY_BY_SLUG = {
  /** Nitrile Examination Gloves – Standard: S, M, L */
  "nitrile-standard": new Set(["Small", "Medium", "Large"]),
  /** Black Nitrile – General: M, L */
  "black-nitrile-general": new Set(["Medium", "Large"]),
  /** Black Nitrile – Heavy Duty: L, XL */
  "black-nitrile-heavy-duty": new Set(["Large", "X Large"]),
};

export function isSizeInStock(slug, sizeLabel) {
  const allowed = SIZE_AVAILABILITY_BY_SLUG[slug];
  if (!allowed || allowed.size === 0) {
    return true;
  }
  return allowed.has(sizeLabel);
}

/** Catalog order, restricted to in-stock sizes (for round-robin allocation). */
export function sizesOrderedForAllocation(slug, allSizes) {
  const allowed = SIZE_AVAILABILITY_BY_SLUG[slug];
  if (!allowed || allowed.size === 0) {
    return [...allSizes];
  }
  const filtered = allSizes.filter((s) => allowed.has(s));
  return filtered.length ? filtered : [...allSizes];
}
