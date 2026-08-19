/**
 * Server-owned Walk-in quote policy: pickup address + Hardin tier rules + exactly $0 shipping.
 * Never invokes live UPS/Shippo, never accepts browser shipping amounts.
 */

import { buildFullCheckoutQuote } from "./checkout-totals.js";
import { assertCartItemsHaveValidSupportedSizeAllocation } from "./quote.js";
import { assertStockAvailableForItems } from "./stock.js";
import { WALK_IN_PICKUP_ADDRESS } from "./walk-in-pickup.js";
import { primeRuntimeStoreForItems } from "./runtime-store.js";

function throwHttpError(message, statusCode = 400) {
  const e = new Error(message);
  e.statusCode = statusCode;
  throw e;
}

function withStockOverrideHint(obj, skipped) {
  if (!skipped || !obj || typeof obj !== "object") {
    return obj;
  }
  const w = Array.isArray(obj.warnings) ? [...obj.warnings] : [];
  w.push("Stock availability was not checked (staff override).");
  return { ...obj, stockAssertionSkipped: true, warnings: w };
}

/**
 * Authoritative Walk-in estimate.
 * Ignores browser fulfillmentMethod / selected shipping rate fields.
 *
 * Quote invariants:
 * - shippingCents = 0
 * - residentialSurchargeCents = 0
 * - taxableShippingCents = 0
 * - shipping.provider = "none"
 * - shipping.quoteStatus = "included_in_merchandise"
 * - canCheckout = true (when stock/items valid)
 * - total = merchandise (after discount) + TN tax only
 *
 * @param {object} body
 * @param {{ allowForceStockOverride?: boolean }} [opts]
 */
export async function computeWalkInZeroShippingQuote(body, opts = {}) {
  await primeRuntimeStoreForItems(body?.items);
  const items = Array.isArray(body?.items) ? body.items : [];
  if (!items.length) {
    throwHttpError("Your cart is empty.", 400);
  }

  assertCartItemsHaveValidSupportedSizeAllocation(items);

  const skipStockAssertion =
    opts.allowForceStockOverride === true && body?.forceStockOverride === true;
  if (!skipStockAssertion) {
    await assertStockAvailableForItems(items);
  }

  // Server-owned jurisdiction — never trust browser address/shipping fields for Walk-in.
  const mergedAddress = { ...WALK_IN_PICKUP_ADDRESS };

  const requestAdminLocal = body?.applyEligibleLocalDiscount === true;
  let pricingTier = "standard";
  let hardinDiscountApplied = false;
  if (requestAdminLocal) {
    // Walk-in: Hardin tier when checked, without ZIP gate (store pickup).
    pricingTier = "hardin";
    hardinDiscountApplied = true;
  }

  // receiptRebuild forces baked-in $0 shipping and skips live_ups entirely.
  const quote = await buildFullCheckoutQuote(items, mergedAddress, {
    pricingTier,
    shippingContext: null,
    flow: "admin_walk_in",
    receiptRebuild: true,
  });

  const shippingCents = Math.max(0, Number(quote.shippingCents) || 0);
  const residential = Math.max(0, Number(quote.residentialSurchargeCents) || 0);
  if (shippingCents !== 0 || residential !== 0) {
    throwHttpError("Walk-in quote produced a non-zero shipping amount.", 500);
  }

  const warnings = [
    "Walk-in pickup: shipping is $0 — no carrier or Shippo quote.",
    ...(Array.isArray(quote.warnings) ? quote.warnings : []),
  ];

  return withStockOverrideHint(
    {
      ...quote,
      shippingCents: 0,
      shippingFormatted: quote.shippingFormatted || "$0.00",
      residentialSurchargeCents: 0,
      warnings,
      hardinDiscountApplied,
      walkInZeroShipping: true,
      flow: "admin_walk_in",
    },
    skipStockAssertion,
  );
}
