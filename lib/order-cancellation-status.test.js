import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { cancellationStatusInternals } from "./order-cancellation-status.js";

const { squareRefundState, shippoRefundState } = cancellationStatusInternals;

test("Square pending refund stays pending without creating another refund", () => {
  const payment = { id: "payment-1", refunded_money: { amount: 0 } };
  const refunds = [{ payment_id: "payment-1", status: "PENDING", updated_at: "2026-08-20T11:35:00Z" }];
  assert.deepEqual(squareRefundState(payment, refunds, 2018), { state: "pending", status: "PENDING" });
});

test("Square completed or approved refund is complete", () => {
  const payment = { id: "payment-1", refunded_money: { amount: 2018 } };
  assert.deepEqual(squareRefundState(payment, [], 2018), { state: "complete", status: "COMPLETED" });
  assert.deepEqual(
    squareRefundState({ id: "payment-1" }, [{ payment_id: "payment-1", status: "APPROVED" }], 2018),
    { state: "complete", status: "APPROVED" },
  );
});

test("Square rejected refund requires attention", () => {
  const result = squareRefundState(
    { id: "payment-1" },
    [{ payment_id: "payment-1", status: "REJECTED" }],
    2018,
  );
  assert.deepEqual(result, { state: "attention", status: "REJECTED" });
});

test("Shippo refund states are mapped without requesting another refund", () => {
  assert.deepEqual(shippoRefundState({ status: "REFUNDPENDING" }), { state: "pending", status: "REFUNDPENDING" });
  assert.deepEqual(shippoRefundState({ status: "REFUNDED" }), { state: "complete", status: "REFUNDED" });
  assert.deepEqual(shippoRefundState({ status: "SUCCESS" }), { state: "attention", status: "SUCCESS" });
});

test("cancelled-order UI exposes a non-destructive status check and removes the retry label", () => {
  const source = readFileSync(new URL("../admin-v2.5/src/pages/OrdersPage.tsx", import.meta.url), "utf8");
  assert.match(source, /Check refund status/);
  assert.match(source, /This only checks Square and Shippo\. It cannot submit another refund\./);
  assert.doesNotMatch(source, /Continue cancellation/);
  assert.match(source, /canConfirmShipped = carrierOrder && labelPurchased && !shipped && !cancelled/);
});

test("local server delegates the cancellation status endpoint", () => {
  const source = readFileSync(new URL("../server.js", import.meta.url), "utf8");
  assert.match(source, /adminOrderCancelStatusHandler/);
  assert.match(source, /pathname === "\/api\/admin-order-cancel-status" && req\.method === "POST"/);
});
