import test from "node:test";
import assert from "node:assert/strict";
import { assertCompletedSquarePaymentMatchesOrder } from "./square-payment-verification.js";

const payment = {
  status: "COMPLETED",
  amount_money: { amount: 1234, currency: "USD" },
  note: "Order 42 from SAI Goods",
};

test("completed Square payment must match order, amount, and currency", () => {
  assert.doesNotThrow(() => assertCompletedSquarePaymentMatchesOrder(payment, { orderId: 42, amountCents: 1234 }));
  assert.throws(() => assertCompletedSquarePaymentMatchesOrder({ ...payment, status: "APPROVED" }, { orderId: 42, amountCents: 1234 }), { code: "SQUARE_PAYMENT_NOT_COMPLETED" });
  assert.throws(() => assertCompletedSquarePaymentMatchesOrder(payment, { orderId: 42, amountCents: 999 }), { code: "SQUARE_PAYMENT_AMOUNT_MISMATCH" });
  assert.throws(() => assertCompletedSquarePaymentMatchesOrder(payment, { orderId: 99, amountCents: 1234 }), { code: "SQUARE_PAYMENT_ORDER_MISMATCH" });
});
