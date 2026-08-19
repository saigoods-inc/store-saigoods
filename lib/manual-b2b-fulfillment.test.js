import assert from "node:assert/strict";
import test from "node:test";

import { buildFullCheckoutQuote } from "./checkout-totals.js";
import { lifecycleForFulfillment, normalizeFulfillmentMethod } from "./manual-order-fulfillment.js";

const items = [
  {
    slug: "black-nitrile-general",
    bundleLines: [{ id: "box_1", qty: 1 }],
    quantities: {},
    boxQuantities: { M: 1, L: 0 },
  },
];

test("B2B fulfillment requires shipping but never requires a Shippo label", () => {
  assert.equal(normalizeFulfillmentMethod("b2b_shipping"), "b2b_shipping");
  assert.deepEqual(lifecycleForFulfillment("b2b_shipping"), {
    fulfillment_method: "b2b_shipping",
    shipping_required: true,
    shippo_label_required: false,
  });
});

test("manual B2B freight becomes the authoritative taxable shipping line without Shippo", async () => {
  const quote = await buildFullCheckoutQuote(
    items,
    { line1: "2009 Ben Hill Ct", city: "Nolensville", state: "TN", postalCode: "37135", country: "US" },
    { flow: "admin_manual", manualShippingAmountCents: 25000 },
  );

  assert.equal(quote.canCheckout, true);
  assert.equal(quote.shipping.mode, "manual_b2b");
  assert.equal(quote.shipping.provider, "external");
  assert.equal(quote.shipping.serviceLabel, "B2B freight");
  assert.equal(quote.shippingCents, 25000);
  assert.equal(quote.shipping.taxableShippingCents, 25000);
  assert.equal(quote.shipping.providerQuoteId, null);
  assert.deepEqual(quote.shippingRateOptions, []);
  assert.equal(quote.totalCents, quote.subtotalCents + quote.shippingCents + quote.taxCents);
});
