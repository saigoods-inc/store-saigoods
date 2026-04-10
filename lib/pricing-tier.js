/**
 * Standard vs Hardin County promo tier (server-side only).
 * Optional per-bundle `hardinPriceCents`; else `HARDIN_PRICE_MULTIPLIER` (default 0.93) × `priceCents`.
 */

function parseHardinMultiplier() {
  const raw = Number(process.env.HARDIN_PRICE_MULTIPLIER);
  if (Number.isFinite(raw) && raw > 0 && raw <= 1) {
    return raw;
  }
  return 0.93;
}

/**
 * @param {{ priceCents?: number, hardinPriceCents?: number }} bundle
 * @param {"standard" | "hardin"} tier
 */
export function bundleUnitPriceCents(bundle, tier) {
  const sale = Math.max(0, Math.round(Number(bundle?.priceCents) || 0));
  if (tier !== "hardin") {
    return sale;
  }
  if (bundle?.hardinPriceCents != null && Number.isFinite(Number(bundle.hardinPriceCents))) {
    return Math.max(0, Math.round(Number(bundle.hardinPriceCents)));
  }
  return Math.max(0, Math.round(sale * parseHardinMultiplier()));
}

/**
 * @param {{ priceCents?: number, hardinPriceCents?: number }} product
 * @param {"standard" | "hardin"} tier
 */
export function productCaseCentsForTier(product, tier) {
  const sale = Math.max(0, Math.round(Number(product?.priceCents) || 0));
  if (tier !== "hardin") {
    return sale;
  }
  if (product?.hardinPriceCents != null && Number.isFinite(Number(product.hardinPriceCents))) {
    return Math.max(0, Math.round(Number(product.hardinPriceCents)));
  }
  return Math.max(0, Math.round(sale * parseHardinMultiplier()));
}
