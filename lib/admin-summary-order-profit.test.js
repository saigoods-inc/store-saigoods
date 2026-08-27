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
  resolveShippingExpenseForProfit,
  resolveShippingChargedToCustomerCents,
  selectedShippingRateAmountCents,
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

test("custom-price reduction affects product profit exactly once", () => {
  const row = rowBase({
    subtotal_cents: 8000,
    merchandise_discount_loss_cents: 2000,
    items: [{ adminPriceOverride: { mode: "negotiated", adjustmentCents: -2000, profitSnapshotUsesCatalogBaseline: true } }],
  });
  assert.equal(computeProductProfitCents(row, 0), 0);
});

test("legacy negotiated snapshots retain their historical profit treatment", () => {
  const row = rowBase({
    subtotal_cents: 8000,
    merchandise_discount_loss_cents: 2000,
    items: [{ b2bPricing: { mode: "negotiated", adjustmentCents: -2000 } }],
  });
  assert.equal(computeProductProfitCents(row, 0), -2000);
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
  const row = rowBase({
    fulfillment_method: "carrier",
    shippo_selected_rate_object_id: "rate_1",
    shippo_shipment_rates_json: [{ object_id: "rate_1", amount: "9.25" }],
  });
  assert.equal(isCurrentProfitShippingEstimated(row, null), true);
});

test("local delivery and pickup have an actual zero carrier expense", () => {
  assert.deepEqual(resolveShippingExpenseForProfit(rowBase({ fulfillment_method: "local_delivery" }), null), { costCents: 0, quality: "actual" });
  assert.deepEqual(resolveShippingExpenseForProfit(rowBase({ fulfillment_method: "pickup" }), null), { costCents: 0, quality: "actual" });
});

test("carrier profit prefers actual label cost over its frozen selected rate", () => {
  const row = rowBase({
    fulfillment_method: "carrier",
    shippo_selected_rate_object_id: "rate_1",
    shippo_shipment_rates_json: [{ object_id: "rate_1", amount: "9.25" }],
  });
  assert.equal(selectedShippingRateAmountCents(row), 925);
  assert.deepEqual(resolveShippingExpenseForProfit(row, 1010), { costCents: 1010, quality: "actual" });
});

test("carrier profit uses a frozen selected rate as an estimate before label purchase", () => {
  const row = rowBase({
    fulfillment_method: "carrier",
    shippo_selected_rate_object_id: "rate_1",
    shippo_shipment_rates_json: { rates: [{ object_id: "rate_1", amount: "9.25" }] },
  });
  assert.deepEqual(resolveShippingExpenseForProfit(row, null), { costCents: 925, quality: "estimated" });
});

test("carrier profit remains pending when neither label cost nor frozen rate exists", () => {
  assert.deepEqual(resolveShippingExpenseForProfit(rowBase({ fulfillment_method: "carrier" }), null), { costCents: null, quality: "pending" });
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
