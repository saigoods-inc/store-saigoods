import assert from "node:assert/strict";
import test from "node:test";

import {
  buildInternalCheckoutShippingQuote,
  isInternalCheckoutPricingEnabled,
  parcelBillableWeightLb,
} from "./internal-shipping-rate.js";

const parcel = (overrides = {}) => ({
  length: "14.37",
  width: "10.24",
  height: "9.84",
  distance_unit: "in",
  weight: "9.74",
  mass_unit: "lb",
  ...overrides,
});

test("public checkout uses live Shippo pricing by default and internal pricing only by explicit override", () => {
  const previous = process.env.CHECKOUT_SHIPPING_PRICING_MODE;
  delete process.env.CHECKOUT_SHIPPING_PRICING_MODE;
  try {
    assert.equal(isInternalCheckoutPricingEnabled("checkout"), false);
    assert.equal(isInternalCheckoutPricingEnabled("admin_manual"), false);
    process.env.CHECKOUT_SHIPPING_PRICING_MODE = "internal";
    assert.equal(isInternalCheckoutPricingEnabled("checkout"), true);
  } finally {
    if (previous == null) delete process.env.CHECKOUT_SHIPPING_PRICING_MODE;
    else process.env.CHECKOUT_SHIPPING_PRICING_MODE = previous;
  }
});

test("billable weight uses the greater of actual and dimensional weight", () => {
  assert.equal(parcelBillableWeightLb(parcel()), 11);
  assert.equal(parcelBillableWeightLb(parcel({ weight: "1" })), 11);
  assert.equal(parcelBillableWeightLb(parcel({ weight: "20" })), 20);
});

test("internal quote is deterministic and returns one stable Standard Ground option", () => {
  const quote = buildInternalCheckoutShippingQuote({
    address: { postalCode: "37135" },
    parcelPlan: { source: "cartonization", planId: "plan-1", parcels: [parcel(), parcel({ weight: "20" })] },
    validation: { shippingContext: { applyResidentialSurcharge: false } },
  });

  assert.equal(quote.canCheckout, true);
  assert.equal(quote.shipping.provider, "internal");
  assert.equal(quote.shipping.serviceLabel, "Standard Ground");
  assert.equal(quote.shipping.shippingZone, 2);
  assert.equal(quote.shipping.billableWeightLb, 31);
  assert.equal(quote.shipping.amountCents, 3062);
  assert.equal(quote.shipping.riskReservePercent, 8);
  assert.equal(quote.shipping.riskReserveCents, 212);
  assert.deepEqual(quote.shippingRateOptions.map((rate) => rate.id), ["internal:standard_ground"]);
  assert.equal(quote.parcelSummary.parcelCount, 2);
});

test("farther zones increase the internal price without a carrier call", () => {
  const plan = { parcels: [parcel()] };
  const nearby = buildInternalCheckoutShippingQuote({ address: { postalCode: "37135" }, parcelPlan: plan });
  const distant = buildInternalCheckoutShippingQuote({ address: { postalCode: "90210" }, parcelPlan: plan });
  assert.ok(distant.shipping.amountCents > nearby.shipping.amountCents);
  assert.equal(distant.shipping.shippingZone, 8);
});
