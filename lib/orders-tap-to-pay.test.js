import test from "node:test";
import assert from "node:assert/strict";

import {
  __resetWalkInCompleteDepsForTests,
  __setWalkInCompleteDepsForTests,
  markManualTapToPayOrderPaid,
} from "./orders.js";

function order(overrides = {}) {
  return {
    id: 42,
    order_source: "manual",
    fulfillment_method: "local_delivery",
    payment_flow: "pay_later",
    manual_payment_method: "tap_to_pay",
    status: "pending",
    order_status: "draft",
    total_cents: 2500,
    shipping_cents: 0,
    items: [],
    ...overrides,
  };
}

function payment(overrides = {}) {
  return {
    id: "square-payment-1",
    status: "COMPLETED",
    amount_money: { amount: 2500, currency: "USD" },
    processing_fee: [{ amount_money: { amount: 80, currency: "USD" } }],
    ...overrides,
  };
}

test("verified Tap to Pay marks local delivery paid without completing handoff or inventory", async (t) => {
  t.after(__resetWalkInCompleteDepsForTests);
  const existing = order();
  let updatePayload;
  const chain = {
    update(value) { updatePayload = value; return this; },
    eq() { return this; },
    neq() { return this; },
    select() { return this; },
    async maybeSingle() { return { data: { ...existing, ...updatePayload }, error: null }; },
  };
  __setWalkInCompleteDepsForTests({
    getOrderByIdForService: async () => existing,
    getClient: () => ({ from: () => chain }),
  });
  const result = await markManualTapToPayOrderPaid({ orderId: "42", payment: payment(), actorEmail: "admin@example.test" });
  assert.equal(result.status, "paid");
  assert.equal(result.order_status, "ready_for_local_delivery");
  assert.equal(result.payment_method, "card_present");
  assert.equal(result.payment_id, "square-payment-1");
  assert.equal(result.actual_processing_fee_cents, 80);
  assert.equal(result.admin_handoff_at, undefined);
  assert.equal(result.inventory_committed_at, undefined);
});

test("Tap to Pay finalization rejects a changed order total", async (t) => {
  t.after(__resetWalkInCompleteDepsForTests);
  __setWalkInCompleteDepsForTests({ getOrderByIdForService: async () => order({ total_cents: 2600 }) });
  await assert.rejects(
    () => markManualTapToPayOrderPaid({ orderId: "42", payment: payment() }),
    /amount does not match/i,
  );
});

test("same payment replay is idempotent and a different payment is rejected", async (t) => {
  t.after(__resetWalkInCompleteDepsForTests);
  __setWalkInCompleteDepsForTests({
    getOrderByIdForService: async () => order({ status: "paid", payment_id: "square-payment-1" }),
  });
  const replay = await markManualTapToPayOrderPaid({ orderId: "42", payment: payment() });
  assert.equal(replay.idempotent, true);
  await assert.rejects(
    () => markManualTapToPayOrderPaid({ orderId: "42", payment: payment({ id: "square-payment-2" }) }),
    /different payment/i,
  );
});
