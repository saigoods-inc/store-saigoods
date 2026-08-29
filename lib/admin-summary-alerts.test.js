import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSummaryDateRange,
  collectSummaryOrderAlerts,
  isSquareProcessedOrder,
  orderGrossChargeCents,
  platformFeeCentsForOrder,
  profitFeeQualityForOrder,
  salesRevenueCentsForOrder,
  squareFeeQualityForOrder,
} from "./admin-summary.js";

function paidOrder(over = {}) {
  return {
    id: over.id ?? "order-1",
    order_ref: over.order_ref ?? "SG-100",
    status: "paid",
    order_status: over.order_status ?? "paid",
    total_cents: over.total_cents ?? 12000,
    subtotal_cents: over.subtotal_cents ?? 10000,
    tax_cents: over.tax_cents ?? 500,
    paid_at: over.paid_at ?? "2024-01-15T12:00:00.000Z",
    created_at: over.created_at ?? "2024-01-15T12:00:00.000Z",
    order_source: over.order_source ?? "web",
    quoted_shipping_amount_cents: over.quoted_shipping_amount_cents ?? 1500,
    quoted_shipping_base_amount_cents: over.quoted_shipping_base_amount_cents ?? 1300,
    ...over,
  };
}

test("collectSummaryOrderAlerts includes paid-not-fulfilled outside report date range", () => {
  const oldUnfulfilled = paidOrder({
    id: "old-unfulfilled",
    order_ref: "SG-OLD",
    paid_at: "2020-06-01T12:00:00.000Z",
    order_status: "paid",
  });
  const todayRange = buildSummaryDateRange({ preset: "today" });
  const paidAt = new Date(oldUnfulfilled.paid_at);
  assert.ok(paidAt < todayRange.start, "fixture order must fall outside Today preset");

  const alerts = collectSummaryOrderAlerts([oldUnfulfilled], new Map());
  assert.equal(alerts.paidNotFulfilled.length, 1);
  assert.equal(alerts.paidNotFulfilled[0].orderRef, "SG-OLD");
});

test("collectSummaryOrderAlerts excludes shipped orders from paid-not-fulfilled", () => {
  const shipped = paidOrder({
    id: "shipped",
    order_status: "shipped",
    admin_handoff_at: "2024-02-01T00:00:00.000Z",
  });
  const alerts = collectSummaryOrderAlerts([shipped], new Map());
  assert.equal(alerts.paidNotFulfilled.length, 0);
});

test("collectSummaryOrderAlerts alert counts do not depend on date-range slicing", () => {
  const rows = [
    paidOrder({ id: "a", order_ref: "SG-A", paid_at: "2020-01-01T00:00:00.000Z", order_status: "paid" }),
    paidOrder({ id: "b", order_ref: "SG-B", paid_at: new Date().toISOString(), order_status: "paid" }),
  ];
  const allAlerts = collectSummaryOrderAlerts(rows, new Map());

  const todayRange = buildSummaryDateRange({ preset: "today" });
  const inRangeOnly = rows.filter((row) => {
    const paidAt = new Date(row.paid_at);
    return paidAt >= todayRange.start && paidAt < todayRange.endExclusive;
  });
  const rangeSliceAlerts = collectSummaryOrderAlerts(inRangeOnly, new Map());

  assert.ok(allAlerts.paidNotFulfilled.length >= rangeSliceAlerts.paidNotFulfilled.length);
  assert.equal(allAlerts.paidNotFulfilled.length, 2);
  assert.equal(rangeSliceAlerts.paidNotFulfilled.length, 1);
});

test("sales revenue excludes collected tax while payment fees use the full charge", () => {
  const row = paidOrder({
    total_cents: 12_000,
    tax_cents: 500,
    actual_processing_fee_cents: null,
    estimated_processing_fee_cents: null,
  });

  assert.equal(orderGrossChargeCents(row), 12_000);
  assert.equal(salesRevenueCentsForOrder(row), 11_500);
  assert.equal(platformFeeCentsForOrder(row), Math.round(12_000 * 0.033 + 30));
});

test("sales revenue never becomes negative when legacy tax data exceeds the total", () => {
  assert.equal(salesRevenueCentsForOrder(paidOrder({ total_cents: 100, tax_cents: 200 })), 0);
});

test("Square dashboard metrics distinguish actual fees from frozen estimates", () => {
  const settled = paidOrder({ payment_id: "square-payment-1", actual_processing_fee_cents: 241 });
  const estimated = paidOrder({
    processing_fee_profile: "square_online",
    actual_processing_fee_cents: null,
    estimated_processing_fee_cents: 228,
  });
  const cash = paidOrder({ order_source: "walk_in", payment_method: "cash", payment_id: null });

  assert.equal(isSquareProcessedOrder(settled), true);
  assert.equal(squareFeeQualityForOrder(settled), "actual");
  assert.equal(isSquareProcessedOrder(estimated), true);
  assert.equal(squareFeeQualityForOrder(estimated), "estimated");
  assert.equal(platformFeeCentsForOrder(estimated), 228);
  assert.equal(isSquareProcessedOrder(cash), false);
});

test("profit fee quality distinguishes settled, frozen, and fallback fee values", () => {
  assert.equal(profitFeeQualityForOrder(paidOrder({ actual_processing_fee_cents: 241 })), "actual");
  assert.equal(profitFeeQualityForOrder(paidOrder({ actual_processing_fee_cents: null, estimated_processing_fee_cents: 228 })), "estimated");
  assert.equal(profitFeeQualityForOrder(paidOrder({ order_source: "walk_in", payment_method: "cash" })), "actual");
  assert.equal(profitFeeQualityForOrder(paidOrder({ actual_processing_fee_cents: null, estimated_processing_fee_cents: null })), "estimated");
});

test("pending shipping alert applies only to carrier orders without actual or frozen costs", () => {
  const carrier = paidOrder({
    id: "carrier",
    order_ref: "SG-CARRIER",
    fulfillment_method: "carrier",
    quoted_shipping_amount_cents: 0,
    quoted_shipping_base_amount_cents: 0,
  });
  const local = paidOrder({ id: "local", order_ref: "SG-LOCAL", fulfillment_method: "local_delivery" });
  const pickup = paidOrder({ id: "pickup", order_ref: "SG-PICKUP", fulfillment_method: "pickup" });
  const estimatedCarrier = paidOrder({
    id: "estimated",
    order_ref: "SG-ESTIMATED",
    fulfillment_method: "carrier",
    shippo_selected_rate_object_id: "rate_1",
    shippo_shipment_rates_json: [{ object_id: "rate_1", amount: "12.50" }],
  });
  const snapshotCarrier = paidOrder({
    id: "snapshot",
    order_ref: "SG-SNAPSHOT",
    fulfillment_method: "carrier",
    quoted_shipping_amount_cents: 0,
    quoted_shipping_base_amount_cents: 0,
    selected_shipping_rate_snapshot_json: { carrierTotalAmountCents: 5748 },
  });
  const alerts = collectSummaryOrderAlerts([carrier, local, pickup, estimatedCarrier, snapshotCarrier], new Map());
  assert.deepEqual(alerts.pendingShippingCost.map((row) => row.orderRef), ["SG-CARRIER"]);
});
