import test from "node:test";
import assert from "node:assert/strict";

import {
  evaluateFreeDelivery,
  normalizeDeliveryPostalCode,
  normalizeFreeDeliveryConfig,
} from "./free-delivery-settings.js";

test("normalizes ZIP+4 and de-duplicates configured ZIP codes", () => {
  assert.equal(normalizeDeliveryPostalCode("37135-8484"), "37135");
  assert.equal(normalizeDeliveryPostalCode("bad"), null);
  assert.deepEqual(
    normalizeFreeDeliveryConfig({ active: true, state: "tn", postalCodes: ["37135-8484", "37135", "37086"], minimumSubtotalCents: 5000 }),
    { version: 2, active: true, state: "TN", postalCodes: ["37086", "37135"], minimumSubtotalCents: 5000, productMinimumsCents: {} },
  );
});

test("requires every product in a mixed order to reach its configured local-delivery minimum", () => {
  const config = {
    active: true,
    state: "TN",
    postalCodes: ["37135"],
    minimumSubtotalCents: 10_000,
    productMinimumsCents: {
      "nitrile-standard": 10_000,
      "black-nitrile-general": 12_000,
    },
  };
  const under = evaluateFreeDelivery(config, {
    address: { state: "TN", postalCode: "37135" },
    subtotalCents: 22_000,
    items: [
      { slug: "nitrile-standard", lineTotalCents: 10_000 },
      { slug: "black-nitrile-general", lineTotalCents: 11_000 },
      { slug: "black-nitrile-general", lineTotalCents: 1_000 },
    ],
  });
  assert.equal(under.eligible, true);
  assert.equal(under.productRequirements.length, 2);

  const short = evaluateFreeDelivery(config, {
    address: { state: "TN", postalCode: "37135" },
    subtotalCents: 21_999,
    items: [
      { slug: "nitrile-standard", lineTotalCents: 10_000 },
      { slug: "black-nitrile-general", lineTotalCents: 11_999 },
    ],
  });
  assert.equal(short.eligible, false);
  assert.equal(short.reason, "minimum_not_met");
  assert.equal(short.amountRemainingCents, 1);
});

test("requires active rule, matching state and ZIP, and the post-discount subtotal minimum", () => {
  const config = { active: true, state: "TN", postalCodes: ["37135"], minimumSubtotalCents: 10_000 };
  const under = evaluateFreeDelivery(config, { address: { state: "TN", postalCode: "37135-8484" }, subtotalCents: 9_000 });
  assert.equal(under.eligible, false);
  assert.equal(under.reason, "minimum_not_met");
  assert.equal(under.amountRemainingCents, 1_000);

  const eligible = evaluateFreeDelivery(config, { address: { state: "TN", postalCode: "37135" }, subtotalCents: 10_000 });
  assert.equal(eligible.eligible, true);
  assert.equal(eligible.reason, "eligible");

  const wrongState = evaluateFreeDelivery(config, { address: { state: "KY", postalCode: "37135" }, subtotalCents: 10_000 });
  assert.equal(wrongState.eligible, false);
  assert.equal(wrongState.reason, "postal_code_not_eligible");
});

test("bundled default is inactive so rollout cannot grant shipping accidentally", () => {
  const result = evaluateFreeDelivery(null, { address: { state: "TN", postalCode: "37135" }, subtotalCents: 100_000 });
  assert.equal(result.active, false);
  assert.equal(result.eligible, false);
  assert.equal(result.reason, "inactive");
});
