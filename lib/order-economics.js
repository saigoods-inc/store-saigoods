import { buildQuote } from "./quote.js";
import {
  builtInShippingAllowanceTotalCents,
  expectedProfitCentsFromBundle,
  getBundleDef,
  normaliseBundleLines,
} from "./bundles.js";
import { getProductMap } from "./store.js";

/**
 * Sum expected profit and built-in shipping allowance from cart/quote line items (bundle lines only).
 * @param {Array<{ slug?: string, bundleLines?: { id: string, qty: number }[] }>} items
 */
export function aggregateMerchandiseEconomicsFromItems(items) {
  const productMap = getProductMap();
  let expectedProfitCents = 0;
  let builtInShippingAllowanceCents = 0;

  for (const item of Array.isArray(items) ? items : []) {
    const slug = String(item?.slug || "").trim();
    const product = productMap.get(slug);
    if (!product) {
      continue;
    }
    const lines = normaliseBundleLines(item.bundleLines);
    for (const { id, qty } of lines) {
      const b = getBundleDef(product, id);
      if (!b) {
        continue;
      }
      const q = Math.max(0, Math.floor(Number(qty) || 0));
      if (q < 1) {
        continue;
      }
      expectedProfitCents += expectedProfitCentsFromBundle(b) * q;
      builtInShippingAllowanceCents += builtInShippingAllowanceTotalCents(b) * q;
    }
  }

  return { expectedProfitCents, builtInShippingAllowanceCents };
}

/**
 * Snapshot columns for `orders` — frozen at quote time so reporting survives catalog edits.
 * @param {Array} items — cart-shaped lines (`slug`, `quantities`, `boxQuantities`, `bundleLines`)
 * @param {{ subtotalCents?: number, items?: Array }} quote — priced quote (may be Hardin tier)
 */
export function computeEconomicsSnapshotForOrder(items, quote) {
  const listQuote = buildQuote(items, { omitShippingEstimate: true, pricingTier: "standard", disableVolumePricing: true });
  const listSub = Math.max(0, Math.round(Number(listQuote.subtotalCents) || 0));
  const actualSub = Math.max(0, Math.round(Number(quote?.subtotalCents) || 0));
  const merchandiseDiscountLossCents = Math.max(0, listSub - actualSub);
  const agg = aggregateMerchandiseEconomicsFromItems(items);
  return {
    merchandise_list_subtotal_cents: listSub,
    merchandise_discount_loss_cents: merchandiseDiscountLossCents,
    // Keep the catalog-margin baseline frozen here. The actual order subtotal
    // already contains any price reduction; this field remains an audit value.
    expected_profit_cents: Math.max(0, agg.expectedProfitCents),
    built_in_shipping_allowance_cents: agg.builtInShippingAllowanceCents,
  };
}
