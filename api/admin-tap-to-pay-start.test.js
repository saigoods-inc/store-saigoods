import test from "node:test";
import assert from "node:assert/strict";

import { assertOrderCanStartTapToPay } from "./admin-tap-to-pay-start.js";

function eligible(overrides = {}) {
  return {
    order_source: "manual",
    fulfillment_method: "local_delivery",
    payment_flow: "pay_later",
    manual_payment_method: "tap_to_pay",
    status: "pending",
    order_status: "draft",
    total_cents: 2500,
    ...overrides,
  };
}

test("eligible local delivery draft returns its locked total", () => {
  assert.equal(assertOrderCanStartTapToPay(eligible()), 2500);
});

test("paid, non-local, and ordinary pay-later orders cannot start Tap to Pay", () => {
  assert.throws(() => assertOrderCanStartTapToPay(eligible({ status: "paid" })), /already paid/i);
  assert.throws(() => assertOrderCanStartTapToPay(eligible({ fulfillment_method: "carrier" })), /not configured/i);
  assert.throws(() => assertOrderCanStartTapToPay(eligible({ manual_payment_method: "cash" })), /not configured/i);
});
