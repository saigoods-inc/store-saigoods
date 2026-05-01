import assert from "node:assert/strict";
import test from "node:test";
import {
  computeCurrentProfitContributionCents,
  computeLandedPlusSuppliesCents,
  computeProductProfitCents,
  computeShippingProfitCents,
  impliedPaidShippingCents,
  isCurrentProfitShippingEstimated,
  orderMissingQuotedShippingRevenue,
  resolveShippingChargedToCustomerCents,
} from "./admin-summary-order-profit.js";

function rowBase(over = {}) {
  return {
    subtotal_cents: 10000,
    total_cents: 12000,
    tax_cents: 500,
    merchandise_list_subtotal_cents: 10000,
    expected_profit_cents: 2000,
    built_in_shipping_allowance_cents: 0,
    merchandise_discount_loss_cents: 0,
    quoted_shipping_amount_cents: 1500,
    quoted_shipping_base_amount_cents: 1300,
    paid_shipping_amount_cents: 1500,
    order_source: "web",
    ...over,
  };
}

test("landed + supplies = list − expected − built-in", () => {
  assert.equal(computeLandedPlusSuppliesCents(rowBase()), 8000);
});

test("shipping charged prefers quoted_shipping_amount_cents", () => {
  assert.equal(resolveShippingChargedToCustomerCents(rowBase()), 1500);
});

test("implied paid shipping from total", () => {
  assert.equal(impliedPaidShippingCents(rowBase()), 1500);
});

test("shipping profit = charged − label", () => {
  assert.equal(computeShippingProfitCents(1500, 900), 600);
});

test("current profit = product profit + shipping profit", () => {
  const row = rowBase();
  const fee = 378;
  const product = computeProductProfitCents(row, fee);
  assert.equal(product, 10000 - 8000 - 0 - fee);
  const total = computeCurrentProfitContributionCents(row, 900, fee);
  assert.equal(total, product + 600);
});

test("zero shipping and zero label still yields current profit when snapshot complete", () => {
  const row = rowBase({
    total_cents: 10500,
    tax_cents: 500,
    quoted_shipping_amount_cents: 0,
    quoted_shipping_base_amount_cents: 0,
    paid_shipping_amount_cents: 0,
  });
  assert.equal(resolveShippingChargedToCustomerCents(row), 0);
  const fee = 334;
  const total = computeCurrentProfitContributionCents(row, 0, fee);
  assert.equal(total, computeProductProfitCents(row, fee));
});

test("missing label with non-zero shipping → estimated", () => {
  const row = rowBase();
  assert.equal(isCurrentProfitShippingEstimated(row, null), true);
});

test("orderMissingQuotedShippingRevenue when implied ship but no quote", () => {
  assert.equal(
    orderMissingQuotedShippingRevenue(
      rowBase({
        quoted_shipping_amount_cents: 0,
        quoted_shipping_base_amount_cents: 0,
        paid_shipping_amount_cents: 0,
      }),
    ),
    true,
  );
  assert.equal(orderMissingQuotedShippingRevenue(rowBase({ order_source: "walk_in" })), false);
});
