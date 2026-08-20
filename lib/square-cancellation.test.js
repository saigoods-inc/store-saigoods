import assert from "node:assert/strict";
import test from "node:test";
import { cancelOrRefundSquarePayment } from "./square-cancellation.js";

const response = (body, ok = true, status = 200) => ({ ok, status, json: async () => body });

test("completed Square payment is fully refunded with a stable request", async (t) => {
  const oldToken = process.env.SQUARE_ACCESS_TOKEN;
  const oldFetch = global.fetch;
  process.env.SQUARE_ACCESS_TOKEN = "test-token";
  const calls = [];
  global.fetch = async (url, init = {}) => {
    calls.push({ url, init });
    if (String(url).includes("/v2/payments/")) return response({ payment: { id: "pay_1", status: "COMPLETED", amount_money: { amount: 2500, currency: "USD" } } });
    return response({ refund: { id: "refund_1", status: "PENDING" } });
  };
  t.after(() => { process.env.SQUARE_ACCESS_TOKEN = oldToken; global.fetch = oldFetch; });
  const result = await cancelOrRefundSquarePayment({ paymentId: "pay_1", amountCents: 2500, orderId: "42", reason: "Customer cancelled" });
  assert.equal(result.action, "refund");
  assert.equal(result.status, "PENDING");
  const body = JSON.parse(calls[1].init.body);
  assert.equal(body.amount_money.amount, 2500);
  assert.equal(body.payment_id, "pay_1");
  assert.equal(body.idempotency_key.length, 45);
});
test("approved Square payment is voided instead of refunded", async (t) => {
  const oldToken = process.env.SQUARE_ACCESS_TOKEN;
  const oldFetch = global.fetch;
  process.env.SQUARE_ACCESS_TOKEN = "test-token";
  global.fetch = async (url) => String(url).endsWith("/cancel")
    ? response({ payment: { id: "pay_2", status: "CANCELED" } })
    : response({ payment: { id: "pay_2", status: "APPROVED" } });
  t.after(() => { process.env.SQUARE_ACCESS_TOKEN = oldToken; global.fetch = oldFetch; });
  const result = await cancelOrRefundSquarePayment({ paymentId: "pay_2", amountCents: 1000, orderId: "43", reason: "Duplicate" });
  assert.deepEqual({ action: result.action, status: result.status }, { action: "void", status: "CANCELED" });
});

test("already fully refunded Square payment is idempotent", async (t) => {
  const oldToken = process.env.SQUARE_ACCESS_TOKEN;
  const oldFetch = global.fetch;
  process.env.SQUARE_ACCESS_TOKEN = "test-token";
  let calls = 0;
  global.fetch = async () => { calls += 1; return response({ payment: { status: "COMPLETED", refunded_money: { amount: 1000 } } }); };
  t.after(() => { process.env.SQUARE_ACCESS_TOKEN = oldToken; global.fetch = oldFetch; });
  const result = await cancelOrRefundSquarePayment({ paymentId: "pay_3", amountCents: 1000, orderId: "44", reason: "Retry" });
  assert.equal(result.alreadyComplete, true);
  assert.equal(calls, 1);
});
