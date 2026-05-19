import assert from "node:assert/strict";
import test from "node:test";
import { buildSummaryDateRange, collectSummaryOrderAlerts } from "./admin-summary.js";

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
