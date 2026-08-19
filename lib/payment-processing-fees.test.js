import assert from "node:assert/strict";
import test from "node:test";
import {
  actualProcessingFeeFromSquarePayment,
  effectiveProcessingFeeCents,
  estimateProcessingFeeCents,
  processingFeeSnapshotForOrder,
} from "./payment-processing-fees.js";

test("configured processing estimate includes percent and fixed fee", () => {
  assert.equal(estimateProcessingFeeCents(6450, { percentBps: 330, fixedCents: 30 }), 243);
});
test("walk-in cash snapshots a zero actual fee", () => {
  const result = processingFeeSnapshotForOrder({ total_cents: 5000, order_source: "walk_in", payment_method: "cash" });
  assert.equal(result.estimated_processing_fee_cents, 0);
  assert.equal(result.processing_fee_status, "actual");
});
test("Square processing fee components become authoritative", () => {
  assert.equal(actualProcessingFeeFromSquarePayment({ processing_fee: [{ amount_money: { amount: 210 } }, { amount_money: { amount: -10 } }] }), 200);
  assert.equal(actualProcessingFeeFromSquarePayment({}), null);
});
test("a null actual fee does not erase the frozen estimate", () => {
  assert.equal(
    effectiveProcessingFeeCents({
      total_cents: 6450,
      actual_processing_fee_cents: null,
      estimated_processing_fee_cents: 243,
    }),
    243,
  );
});
test("null fee snapshots fall back to the configured calculation", () => {
  assert.equal(
    effectiveProcessingFeeCents({
      total_cents: 6450,
      actual_processing_fee_cents: null,
      estimated_processing_fee_cents: null,
    }),
    243,
  );
});
