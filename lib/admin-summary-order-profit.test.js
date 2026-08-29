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

test("shipping charged uses the frozen paid amount", () => {
  assert.equal(resolveShippingChargedToCustomerCents(rowBase()), 1500);
});

test("explicit zero customer-paid shipping wins over a preserved carrier quote", () => {
  const row = rowBase({
    paid_shipping_amount_cents: 0,
    quoted_shipping_total_cents: 5748,
    quoted_shipping_amount_cents: 5748,
    shipping_cents: 0,
  });
  assert.equal(resolveShippingChargedToCustomerCents(row), 0);
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

test("legacy negotiated snapshots do not double-count their recorded adjustment", () => {
  const row = rowBase({
    subtotal_cents: 8000,
    merchandise_discount_loss_cents: 2000,
    items: [{ b2bPricing: { mode: "negotiated", adjustmentCents: -2000 } }],
  });
  assert.equal(computeProductProfitCents(row, 0), 0);
});

test("ordinary discount reductions are already reflected in subtotal", () => {
  const row = rowBase({
    subtotal_cents: 8000,
    merchandise_discount_loss_cents: 2000,
  });
  assert.equal(computeProductProfitCents(row, 0), 0);
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

test("admin free shipping keeps customer revenue at zero while carrier expense remains", () => {
  const row = rowBase({
    fulfillment_method: "carrier",
    total_cents: 10500,
    tax_cents: 500,
    quoted_shipping_total_cents: 0,
    quoted_shipping_amount_cents: 1500,
    quoted_shipping_base_amount_cents: 1300,
    paid_shipping_amount_cents: 0,
    selected_shipping_rate_snapshot_json: {
      freeShippingApplied: true,
      freeShippingSource: "admin_override",
      carrierTotalAmountCents: 1500,
      packageRateObjectIds: ["rate_1", "rate_2", "rate_3", "rate_4"],
    },
    shippo_selected_rate_object_id: "rate_1",
    shippo_shipment_rates_json: { rates: [{ object_id: "rate_1", amount: "13.00" }] },
  });
  assert.equal(resolveShippingChargedToCustomerCents(row), 0);
  assert.equal(selectedShippingRateAmountCents(row), 1500);
  assert.deepEqual(resolveShippingExpenseForProfit(row, null), { costCents: 1500, quality: "estimated" });
  const product = computeProductProfitCents(row, 0);
  assert.equal(computeCurrentProfitContributionCents(row, 1500, 0), product - 1500);
});

test("multi-package admin free shipping deducts the frozen carrier total exactly once", () => {
  const row = rowBase({
    fulfillment_method: "carrier",
    total_cents: 10500,
    tax_cents: 500,
    paid_shipping_amount_cents: 0,
    quoted_shipping_total_cents: 0,
    selected_shipping_rate_snapshot_json: {
      freeShippingApplied: true,
      carrierTotalAmountCents: 5748,
      packageRateObjectIds: ["rate_1", "rate_2", "rate_3", "rate_4"],
    },
    shippo_selected_rate_object_id: "rate_1",
    shippo_shipment_rates_json: null,
  });
  assert.equal(resolveShippingChargedToCustomerCents(row), 0);
  assert.deepEqual(resolveShippingExpenseForProfit(row, null), { costCents: 5748, quality: "estimated" });
  const product = computeProductProfitCents(row, 0);
  assert.equal(computeCurrentProfitContributionCents(row, 5748, 0), product - 5748);
});

test("carrier profit stays pending when both actual and estimated label cost are unknown", () => {
  const row = rowBase({
    fulfillment_method: "carrier",
    paid_shipping_amount_cents: 0,
    quoted_shipping_amount_cents: 0,
    quoted_shipping_base_amount_cents: 0,
    shippo_selected_rate_object_id: null,
    shippo_shipment_rates_json: null,
  });
  assert.equal(computeCurrentProfitContributionCents(row, null, 0), null);
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
  assert.deepEqual(
    resolveShippingExpenseForProfit(
      rowBase({
        fulfillment_method: "carrier",
        quoted_shipping_amount_cents: 0,
        quoted_shipping_base_amount_cents: 0,
      }),
      null,
    ),
    { costCents: null, quality: "pending" },
  );
});

test("legacy frozen quote is the final compatible carrier estimate", () => {
  const row = rowBase({
    fulfillment_method: "carrier",
    selected_shipping_rate_snapshot_json: null,
    shippo_selected_rate_object_id: null,
    shippo_shipment_rates_json: null,
    quoted_shipping_amount_cents: 0,
    quoted_shipping_base_amount_cents: 1300,
    quoted_shipping_buffer_cents: 200,
    quoted_shipping_residential_surcharge_cents: 100,
  });
  assert.deepEqual(resolveShippingExpenseForProfit(row, null), { costCents: 1600, quality: "estimated" });
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
