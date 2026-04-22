import assert from "node:assert/strict";
import test from "node:test";
import {
  computeCurrentProfitContributionCents,
  computeShippingProfitCents,
  isCurrentProfitShippingEstimated,
} from "./admin-summary-order-profit.js";

test("1-box nitrile: actual = built-in → profit = expected, shipping profit 0", () => {
  const built = 1100;
  const actual = 1100;
  assert.equal(
    computeCurrentProfitContributionCents({
      expectedProfitCents: 165,
      builtInShippingAllowanceCents: built,
      actualShippingExpenseCents: actual,
      discountLossCents: 0,
    }),
    165,
  );
  assert.equal(computeShippingProfitCents(built, actual), 0);
});

test("actual shipping $9 vs $11 built-in → +$2 to profit", () => {
  const built = 1100;
  const actual = 900;
  assert.equal(
    computeCurrentProfitContributionCents({
      expectedProfitCents: 165,
      builtInShippingAllowanceCents: built,
      actualShippingExpenseCents: actual,
      discountLossCents: 0,
    }),
    365,
  );
  assert.equal(computeShippingProfitCents(built, actual), 200);
});

test("missing actual: profit uses expected only; marked estimated", () => {
  assert.equal(
    computeCurrentProfitContributionCents({
      expectedProfitCents: 165,
      builtInShippingAllowanceCents: 1100,
      actualShippingExpenseCents: null,
      discountLossCents: 0,
    }),
    165,
  );
  assert.equal(
    isCurrentProfitShippingEstimated({
      expectedProfitCents: 165,
      builtInShippingAllowanceCents: 1100,
      actualShippingExpenseCents: null,
    }),
    true,
  );
});

test("no snapshot → null contribution", () => {
  assert.equal(
    computeCurrentProfitContributionCents({
      expectedProfitCents: null,
      builtInShippingAllowanceCents: 1100,
      actualShippingExpenseCents: 1100,
      discountLossCents: 0,
    }),
    null,
  );
});
