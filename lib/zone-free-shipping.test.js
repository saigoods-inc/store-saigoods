import assert from "node:assert/strict";
import test from "node:test";
import {
  applyZoneFreeShippingToRates,
  applyZoneFreeShippingToShipping,
  evaluateZoneFreeShipping,
  getZoneFreeShippingThresholdsCents,
  normalizeZoneFreeShippingConfig,
} from "./zone-free-shipping.js";

const rates = [
  { id: "ground", provider: "UPS", serviceLabel: "Ground", amountCents: 1800, totalAmountCents: 2000, residentialSurchargeCents: 200 },
  { id: "air", provider: "UPS", serviceLabel: "2nd Day Air", amountCents: 4200, totalAmountCents: 4400, residentialSurchargeCents: 200 },
];

test("defaults configure only the approved zone 3 and zone 6 thresholds", () => {
  assert.deepEqual(getZoneFreeShippingThresholdsCents(""), { 3: 15000, 6: 30000 });
  assert.deepEqual(getZoneFreeShippingThresholdsCents("3:175.50,6:325,8:500"), {
    3: 17550,
    6: 32500,
    8: 50000,
  });
});

test("threshold uses the post-discount merchandise subtotal", () => {
  const under = evaluateZoneFreeShipping({
    postalCode: "37135",
    shippingZone: 3,
    subtotalCents: 14999,
    shippingRateOptions: rates,
    selectedRateId: "ground",
  });
  assert.equal(under.eligible, false);
  assert.equal(under.amountRemainingCents, 1);
  assert.equal(under.message, "Spend $0.01 more for free shipping.");

  const atThreshold = evaluateZoneFreeShipping({
    postalCode: "37135",
    shippingZone: 3,
    subtotalCents: 15000,
    shippingRateOptions: rates,
    selectedRateId: "ground",
  });
  assert.equal(atThreshold.eligible, true);
  assert.equal(atThreshold.applied, true);
  assert.equal(atThreshold.message, "Enjoy your free shipping!");
});

test("zone 6 requires $300 and an unconfigured zone remains unchanged", () => {
  assert.equal(evaluateZoneFreeShipping({
    postalCode: "90210",
    shippingZone: 6,
    subtotalCents: 29999,
    shippingRateOptions: rates,
  }).amountRemainingCents, 1);
  const unconfigured = evaluateZoneFreeShipping({
    postalCode: "10001",
    shippingZone: 5,
    subtotalCents: 99999,
    shippingRateOptions: rates,
  });
  assert.equal(unconfigured.configured, false);
  assert.equal(unconfigured.message, null);
});

test("saved settings support zones 2 through 8 and inactive means no offer", () => {
  const normalized = normalizeZoneFreeShippingConfig({
    active: true,
    thresholdsCents: { 1: 5000, 2: 10000, 5: 22500, 8: 50000, 9: 60000 },
  });
  assert.deepEqual(normalized.thresholdsCents, { 2: 10000, 5: 22500, 8: 50000 });

  const inactive = evaluateZoneFreeShipping({
    postalCode: "10001",
    shippingZone: 5,
    subtotalCents: 99999,
    shippingRateOptions: rates,
    selectedRateId: "ground",
    config: { active: false, thresholdsCents: { 5: 10000 } },
  });
  assert.equal(inactive.configured, false);
  assert.equal(inactive.eligible, false);
  assert.equal(inactive.message, null);
});

test("saved settings override the bundled thresholds", () => {
  const evaluation = evaluateZoneFreeShipping({
    postalCode: "10001",
    shippingZone: 5,
    subtotalCents: 22499,
    shippingRateOptions: rates,
    selectedRateId: "ground",
    config: { active: true, thresholdsCents: { 5: 22500 } },
  });
  assert.equal(evaluation.thresholdCents, 22500);
  assert.equal(evaluation.amountRemainingCents, 1);
  assert.equal(evaluation.message, "Spend $0.01 more for free shipping.");
});

test("only the lowest-cost signed carrier service becomes free", () => {
  const evaluation = evaluateZoneFreeShipping({
    postalCode: "37135",
    shippingZone: 3,
    subtotalCents: 15000,
    shippingRateOptions: rates,
    selectedRateId: "ground",
  });
  const promotedRates = applyZoneFreeShippingToRates(rates, evaluation);
  assert.equal(promotedRates[0].amountCents, 1800);
  assert.equal(promotedRates[0].carrierTotalAmountCents, 2000);
  assert.equal(promotedRates[0].totalAmountCents, 0);
  assert.equal(promotedRates[0].residentialSurchargeCents, 0);
  assert.equal(promotedRates[1].totalAmountCents, 4400);

  const shipping = applyZoneFreeShippingToShipping({
    providerQuoteId: "ground",
    amountCents: 1800,
    residentialSurchargeCents: 200,
    taxableShippingCents: 2000,
  }, evaluation);
  assert.equal(shipping.carrierTotalAmountCents, 2000);
  assert.equal(shipping.amountCents, 0);
  assert.equal(shipping.taxableShippingCents, 0);
});
