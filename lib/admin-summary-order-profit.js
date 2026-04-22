/**
 * Summary profit math from stored order snapshots + actual shipping.
 * Expected profit and built-in shipping come from order rows (set at quote time from catalog).
 */

/**
 * @param {object} p
 * @param {number | null | undefined} p.expectedProfitCents
 * @param {number | null | undefined} p.builtInShippingAllowanceCents
 * @param {number | null | undefined} p.actualShippingExpenseCents — null/undefined if not recorded
 * @param {number | null | undefined} p.discountLossCents
 * @returns {number | null} cents contributed to "current profit", or null if snapshot incomplete
 */
export function computeCurrentProfitContributionCents(p) {
  const expRaw = p?.expectedProfitCents;
  const builtRaw = p?.builtInShippingAllowanceCents;
  if (expRaw == null || builtRaw == null || !Number.isFinite(Number(expRaw)) || !Number.isFinite(Number(builtRaw))) {
    return null;
  }
  const exp = Math.round(Number(expRaw));
  const built = Math.round(Number(builtRaw));
  const disc = Math.max(0, Math.round(Number(p?.discountLossCents) || 0));
  const actualRaw = p?.actualShippingExpenseCents;
  const hasActual =
    actualRaw != null && Number.isFinite(Number(actualRaw)) && Number(actualRaw) >= 0;
  const actual = hasActual ? Math.round(Number(actualRaw)) : null;
  const shippingVarianceCents = actual != null ? built - actual : 0;
  return exp + shippingVarianceCents - disc;
}

/**
 * Shipping profit (allowance − actual) when both are known.
 * @returns {number | null}
 */
export function computeShippingProfitCents(builtInShippingAllowanceCents, actualShippingExpenseCents) {
  if (builtInShippingAllowanceCents == null || actualShippingExpenseCents == null) {
    return null;
  }
  if (!Number.isFinite(Number(builtInShippingAllowanceCents)) || !Number.isFinite(Number(actualShippingExpenseCents))) {
    return null;
  }
  return Math.round(Number(builtInShippingAllowanceCents)) - Math.round(Number(actualShippingExpenseCents));
}

/**
 * True when current profit uses expected profit with zero shipping variance (actual label cost missing).
 */
export function isCurrentProfitShippingEstimated(p) {
  const expRaw = p?.expectedProfitCents;
  const builtRaw = p?.builtInShippingAllowanceCents;
  if (expRaw == null || builtRaw == null) return false;
  const actualRaw = p?.actualShippingExpenseCents;
  return actualRaw == null || !Number.isFinite(Number(actualRaw));
}
