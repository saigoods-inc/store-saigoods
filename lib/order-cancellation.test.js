import assert from "node:assert/strict";
import test from "node:test";
import { cancelPaidOrder } from "./order-cancellation.js";

function fakeClient(order, labels) {
  const events = [];
  function builder(table, operation, payload) {
    const filters = [];
    const execute = async () => {
      if (table === "orders" && operation === "update") {
        if (filters.some(([key, value]) => key === "status" && order.status !== value)) return { data: null, error: null };
        Object.assign(order, payload);
        return { data: order, error: null };
      }
      if (table === "order_shippo_labels" && operation === "update") {
        const row = labels.find((item) => filters.every(([key, value]) => item[key] === value));
        if (row) Object.assign(row, payload);
        return { data: row || null, error: null };
      }
      if (table === "shipping_state_events" && operation === "insert") { events.push(payload); return { data: payload, error: null }; }
      return { data: null, error: null };
    };
    const api = { eq(key, value) { filters.push([key, value]); return api; }, select() { return api; }, maybeSingle: execute, then(resolve, reject) { return execute().then(resolve, reject); } };
    return api;
  }
  return { events, from(table) { return { update(payload) { return builder(table, "update", payload); }, insert(payload) { return builder(table, "insert", payload); } }; } };
}

test("cancellation refunds payment, restores stock, refunds every label, and notifies buyer", async () => {
  const order = { id: 7, order_ref: "SAI-7", order_source: "web", status: "paid", order_status: "labels_purchased", payment_id: "pay_7", total_cents: 8400, customer_email: "buyer@example.test" };
  const labels = [{ id: "a", order_id: 7, status: "purchased", transaction_id: "tx_a" }, { id: "b", order_id: 7, status: "purchased", transaction_id: "tx_b" }];
  const client = fakeClient(order, labels);
  let restored = 0;
  let notified = 0;
  const result = await cancelPaidOrder({ orderId: "7", reason: "Customer changed their mind", actor: "admin@example.test" }, {
    client, loadOrder: async () => order, loadLabels: async () => labels,
    getTransaction: async (id) => ({ object_id: id, status: "SUCCESS", tracking_status: "UNKNOWN" }),
    square: async () => ({ action: "refund", status: "COMPLETED", refundId: "refund_7" }),
    restoreInventory: async () => { restored += 1; return { restored: true }; },
    refundTransaction: async (id) => ({ status: "REFUNDPENDING", refundId: `refund_${id}` }),
    sendEmail: async () => { notified += 1; return { sent: true, id: "resend-cancel-7" }; },
  });
  assert.equal(order.status, "refunded");
  assert.equal(order.order_status, "cancelled");
  assert.equal(restored, 1);
  assert.equal(notified, 1);
  assert.ok(order.cancellation_email_sent_at);
  assert.equal(order.cancellation_email_resend_id, "resend-cancel-7");
  assert.equal(result.shippingRefunds.length, 2);
  assert.match(result.warning, /carrier credit is pending/i);
  assert.equal(labels[0].last_error_code, "LABEL_REFUND_PENDING");
  assert.equal(client.events.length, 1);
});
test("Square failure stops before inventory and label refunds", async () => {
  const order = { id: 8, order_source: "web", status: "paid", order_status: "labels_purchased", payment_id: "pay_8", total_cents: 1000 };
  const labels = [{ id: "c", order_id: 8, status: "purchased", transaction_id: "tx_c" }];
  const client = fakeClient(order, labels);
  let downstreamCalls = 0;
  await assert.rejects(() => cancelPaidOrder({ orderId: "8", reason: "Customer request", actor: "admin" }, {
    client, loadOrder: async () => order, loadLabels: async () => labels,
    getTransaction: async () => ({ status: "SUCCESS", tracking_status: "UNKNOWN" }),
    square: async () => { throw Object.assign(new Error("Square rejected refund"), { statusCode: 409 }); },
    restoreInventory: async () => { downstreamCalls += 1; }, refundTransaction: async () => { downstreamCalls += 1; },
  }), /Square rejected refund/);
  assert.equal(downstreamCalls, 0);
  assert.equal(order.status, "cancellation_pending");
});

test("used shipping label blocks cancellation before Square refund", async () => {
  const order = { id: 9, order_source: "web", status: "paid", order_status: "labels_purchased", payment_id: "pay_9", total_cents: 1000 };
  const labels = [{ id: "d", order_id: 9, status: "purchased", transaction_id: "tx_d" }];
  const client = fakeClient(order, labels);
  let squareCalls = 0;
  await assert.rejects(() => cancelPaidOrder({ orderId: "9", reason: "Customer request", actor: "admin" }, {
    client, loadOrder: async () => order, loadLabels: async () => labels,
    getTransaction: async () => ({ status: "SUCCESS", tracking_status: { status: "TRANSIT" } }), square: async () => { squareCalls += 1; },
  }), /already transit/i);
  assert.equal(squareCalls, 0);
  assert.equal(order.status, "paid");
});
