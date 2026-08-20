import test from "node:test";
import assert from "node:assert/strict";
import {
  cancellationEmailSquareResult,
  sendCancelledOrderRefundEmail,
} from "./admin-order-cancellation-email.js";

const cancelledOrder = {
  id: 133,
  order_status: "cancelled",
  status: "refund_pending",
  customer_email: "customer@example.com",
  payment_id: "payment-1",
  total_cents: 2018,
};

test("derives accurate completed, pending, and void cancellation email states", () => {
  assert.deepEqual(cancellationEmailSquareResult(cancelledOrder, null), { action: "refund", status: "PENDING" });
  assert.deepEqual(cancellationEmailSquareResult({ ...cancelledOrder, status: "refunded" }, null), { action: "refund", status: "COMPLETED" });
  assert.deepEqual(cancellationEmailSquareResult(cancelledOrder, { status: "CANCELED" }), { action: "void", status: "CANCELED" });
});

test("manual refund email sends only a notification with a request-scoped idempotency key", async () => {
  const calls = [];
  const updates = [];
  const client = {
    from(table) {
      assert.equal(table, "orders");
      return {
        update(payload) {
          updates.push(payload);
          return {
            eq(field, value) {
              assert.equal(field, "id");
              assert.equal(value, 133);
              return {
                select() {
                  return { maybeSingle: async () => ({ data: { ...cancelledOrder, ...payload }, error: null }) };
                },
              };
            },
          };
        },
      };
    },
  };
  const result = await sendCancelledOrderRefundEmail(
    { orderId: "133", requestId: "request_12345678" },
    {
      loadOrder: async () => cancelledOrder,
      client,
      getPayment: async () => ({ status: "COMPLETED", refunded_money: { amount: 2018 } }),
      sendEmail: async (...args) => {
        calls.push(args);
        return { sent: true, id: "resend-123" };
      },
    },
  );

  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0][1], { action: "refund", status: "COMPLETED" });
  assert.equal(calls[0][2].idempotencyKey, "order-cancelled-resend/133/request_12345678");
  assert.equal(updates.length, 1);
  assert.equal(updates[0].cancellation_email_resend_id, "resend-123");
  assert.ok(updates[0].cancellation_email_sent_at);
  assert.equal(result.order.cancellation_email_resend_id, "resend-123");
});

test("manual refund email rejects active orders before sending", async () => {
  let sent = false;
  await assert.rejects(
    sendCancelledOrderRefundEmail(
      { orderId: "133", requestId: "request_12345678" },
      {
        loadOrder: async () => ({ ...cancelledOrder, order_status: "paid" }),
        sendEmail: async () => {
          sent = true;
          return { sent: true };
        },
      },
    ),
    /only be sent for cancelled orders/i,
  );
  assert.equal(sent, false);
});
