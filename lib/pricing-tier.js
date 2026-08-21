/**
 * Legacy pricing-tier compatibility. Campaign discounts are applied explicitly;
 * retired location tiers must never change catalog prices.
 */

/**
 * @param {{ priceCents?: number, hardinPriceCents?: number }} bundle
 * @param {"standard" | "hardin"} tier
 */
export function bundleUnitPriceCents(bundle, tier) {
  const sale = Math.max(0, Math.round(Number(bundle?.priceCents) || 0));
  return sale;
}

/**
 * @param {{ priceCents?: number, hardinPriceCents?: number }} product
 * @param {"standard" | "hardin"} tier
 */
export function productCaseCentsForTier(product, tier) {
  const sale = Math.max(0, Math.round(Number(product?.priceCents) || 0));
  return sale;
}
