import assert from "node:assert/strict";
import test from "node:test";
import { buildFullCheckoutQuote } from "./checkout-totals.js";

const previousPricingMode = process.env.CHECKOUT_SHIPPING_PRICING_MODE;
const previousQuoteMode = process.env.SHIPPING_QUOTE_MODE;
process.env.CHECKOUT_SHIPPING_PRICING_MODE = "internal";
process.env.SHIPPING_QUOTE_MODE = "live_ups";

test.after(() => {
  if (previousPricingMode == null) delete process.env.CHECKOUT_SHIPPING_PRICING_MODE;
  else process.env.CHECKOUT_SHIPPING_PRICING_MODE = previousPricingMode;
  if (previousQuoteMode == null) delete process.env.SHIPPING_QUOTE_MODE;
  else process.env.SHIPPING_QUOTE_MODE = previousQuoteMode;
});

function address(postalCode, state, city) {
  const value = { line1: "1 Main St", city, state, postalCode, country: "US" };
  return {
    value,
    options: {
      shippingContext: { applyResidentialSurcharge: false },
      addressValidationResult: {
        ok: true,
        normalizedAddress: value,
        shippingContext: { applyResidentialSurcharge: false },
      },
    },
  };
}

const item = (boxes) => [{ slug: "nitrile-standard", quantities: { M: boxes } }];

test("zone 3 standard shipping becomes free at $150", async () => {
  const destination = address("35005", "AL", "Birmingham");
  const quote = await buildFullCheckoutQuote(item(3), destination.value, destination.options);
  assert.equal(quote.subtotalCents, 16497);
  assert.equal(quote.freeShipping.zone, 3);
  assert.equal(quote.freeShipping.applied, true);
  assert.equal(quote.freeShipping.message, "Enjoy your free shipping!");
  assert.equal(quote.shippingCents, 0);
  assert.ok(quote.shipping.carrierTotalAmountCents > 0);
  assert.equal(quote.shipping.provider, "internal");
  assert.equal(quote.shipping.providerQuoteId, "internal:standard_ground");
});

test("discounted merchandise below the threshold keeps the carrier charge", async () => {
  const destination = address("35005", "AL", "Birmingham");
  const quote = await buildFullCheckoutQuote(item(3), destination.value, {
    ...destination.options,
    manualDiscount: { type: "percent", value: 10 },
  });
  assert.equal(quote.subtotalCents, 14847);
  assert.equal(quote.freeShipping.eligible, false);
  assert.equal(quote.freeShipping.amountRemainingCents, 153);
  assert.equal(quote.freeShipping.message, "Spend $1.53 more for free shipping.");
  assert.ok(quote.shippingCents > 0);
});

test("zone 6 standard shipping becomes free at $300", async () => {
  const destination = address("80002", "CO", "Denver");
  const quote = await buildFullCheckoutQuote(item(6), destination.value, destination.options);
  assert.equal(quote.subtotalCents, 32994);
  assert.equal(quote.freeShipping.zone, 6);
  assert.equal(quote.freeShipping.thresholdCents, 30000);
  assert.equal(quote.freeShipping.applied, true);
  assert.equal(quote.shippingCents, 0);
});
