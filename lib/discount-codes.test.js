import assert from "node:assert/strict";
import test from "node:test";

import { normalizeDiscountCode, normalizeDiscountPercent } from "./discount-codes.js";

test("discount codes accept generated and memorable admin formats", () => {
  assert.equal(normalizeDiscountCode("hc-a2b4z"), "HC-A2B4Z");
  assert.equal(normalizeDiscountCode("summer-2026"), "SUMMER-2026");
  assert.equal(normalizeDiscountCode("  vip123  "), "VIP123");
  assert.equal(normalizeDiscountCode("no"), null);
  assert.equal(normalizeDiscountCode("bad_code"), null);
});

test("discount percentages are bounded and default safely", () => {
  assert.equal(normalizeDiscountPercent("12"), 12);
  assert.equal(normalizeDiscountPercent(101), 7);
  assert.equal(normalizeDiscountPercent("oops", 0), 0);
});
