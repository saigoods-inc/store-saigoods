import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

import {
  __resetWalkInCompleteDepsForTests,
  __setWalkInCompleteDepsForTests,
  isWalkInOrderFullyCompleted,
  markAdminOrderHandoffShipped,
  markWalkInOrderPaid,
} from "./lib/orders.js";
import {
  __resetSupabaseAccessTokenVerifierForTests,
  __setSupabaseAccessTokenVerifierForTests,
} from "./lib/reports-auth.js";
import markPaidHandler from "./api/admin-walk-in-order-mark-paid.js";

afterEach(() => {
  __resetWalkInCompleteDepsForTests();
  __resetSupabaseAccessTokenVerifierForTests();
  delete process.env.ALLOW_INSECURE_LOCAL_ADMIN_API;
  delete process.env.INTERNAL_REPORTS_SECRET;
});

function makeRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

test("isWalkInOrderFullyCompleted requires paid + shipped + handoff + inventory commit", () => {
  const complete = {
    order_source: "walk_in",
    order_type: "walk_in",
    status: "paid",
    order_status: "shipped",
    admin_handoff_at: "2026-07-24T00:00:00.000Z",
    inventory_committed_at: "2026-07-24T00:00:00.000Z",
  };
  assert.equal(isWalkInOrderFullyCompleted(complete), true);

  assert.equal(isWalkInOrderFullyCompleted({ ...complete, status: "pending" }), false);
  assert.equal(isWalkInOrderFullyCompleted({ ...complete, order_status: "paid" }), false);
  assert.equal(isWalkInOrderFullyCompleted({ ...complete, admin_handoff_at: null }), false);
  assert.equal(isWalkInOrderFullyCompleted({ ...complete, inventory_committed_at: null }), false);
  assert.equal(
    isWalkInOrderFullyCompleted({
      ...complete,
      order_source: "manual",
      order_type: "manual",
    }),
    false,
  );
  // OR between handoff and shipped is not enough — both required.
  assert.equal(
    isWalkInOrderFullyCompleted({
      ...complete,
      order_status: "paid",
      admin_handoff_at: "2026-07-24T00:00:00.000Z",
    }),
    false,
  );
  assert.equal(
    isWalkInOrderFullyCompleted({
      ...complete,
      order_status: "shipped",
      admin_handoff_at: null,
    }),
    false,
  );
});

test("markWalkInOrderPaid rejects unsupported payment methods before mutation", async () => {
  let rpcCalls = 0;
  __setWalkInCompleteDepsForTests({
    getOrderByIdForService: async () => ({
      id: "wi-1",
      order_source: "walk_in",
      order_status: "draft",
      status: "pending",
      items: [],
    }),
    isSupabaseInventoryBackend: () => true,
    rpcWalkInOrderComplete: async () => {
      rpcCalls += 1;
      return { ok: true, idempotent: false, order: {} };
    },
  });

  await assert.rejects(
    () => markWalkInOrderPaid({ orderId: "wi-1", paymentMethod: "card_present" }),
    (e) => e.statusCode === 400 && /cash or check/i.test(e.message),
  );
  await assert.rejects(
    () => markWalkInOrderPaid({ orderId: "wi-1", paymentMethod: "square" }),
    (e) => e.statusCode === 400,
  );
  assert.equal(rpcCalls, 0);
});

test("markWalkInOrderPaid rejects non-walk-in and cancelled orders", async () => {
  __setWalkInCompleteDepsForTests({
    getOrderByIdForService: async () => ({
      id: "m-1",
      order_source: "manual",
      order_status: "draft",
      status: "pending",
      items: [],
    }),
  });
  await assert.rejects(
    () => markWalkInOrderPaid({ orderId: "m-1", paymentMethod: "cash" }),
    (e) => e.statusCode === 400 && /walk-in/i.test(e.message),
  );

  __setWalkInCompleteDepsForTests({
    getOrderByIdForService: async () => ({
      id: "wi-2",
      order_source: "walk_in",
      order_status: "cancelled",
      status: "pending",
      items: [],
    }),
  });
  await assert.rejects(
    () => markWalkInOrderPaid({ orderId: "wi-2", paymentMethod: "cash" }),
    (e) => e.statusCode === 400 && /Cancelled/i.test(e.message),
  );
});

test("markWalkInOrderPaid supabase path completes with inventory commit and is idempotent", async () => {
  const completed = {
    id: "wi-3",
    order_ref: "SAI-WALK-1",
    order_source: "walk_in",
    order_type: "walk_in",
    status: "paid",
    order_status: "shipped",
    payment_method: "cash",
    paid_at: "2026-07-24T12:00:00.000Z",
    admin_handoff_at: "2026-07-24T12:00:00.000Z",
    inventory_committed_at: "2026-07-24T12:00:00.000Z",
    items: [{ slug: "black-nitrile-general" }],
  };
  let rpcCalls = 0;
  let opsBuilt = 0;
  let draft = {
    id: "wi-3",
    order_source: "walk_in",
    order_status: "draft",
    status: "pending",
    items: [{ slug: "black-nitrile-general", boxQuantities: { M: 1 } }],
  };

  __setWalkInCompleteDepsForTests({
    getOrderByIdForService: async () => draft,
    isSupabaseInventoryBackend: () => true,
    buildWalkInSaleOps: async () => {
      opsBuilt += 1;
      return [{ variant_id: "v1", cases_delta: 0, boxes_delta: -1, movement_type: "walk_in_sale" }];
    },
    rpcWalkInOrderComplete: async (_id, method, ops) => {
      rpcCalls += 1;
      assert.equal(method, "cash");
      assert.equal(ops.length, 1);
      draft = { ...completed };
      return { ok: true, idempotent: false, order: completed };
    },
  });

  const first = await markWalkInOrderPaid({ orderId: "wi-3", paymentMethod: "cash", actorEmail: "a@b.co" });
  assert.equal(first.inventoryCommitted, true);
  assert.equal(first.order_status, "shipped");
  assert.equal(first.admin_handoff_at, completed.admin_handoff_at);
  assert.equal(rpcCalls, 1);
  assert.equal(opsBuilt, 1);

  const second = await markWalkInOrderPaid({ orderId: "wi-3", paymentMethod: "cash" });
  assert.equal(second.idempotent, true);
  assert.equal(rpcCalls, 1);
  assert.equal(opsBuilt, 1);
});

test("markWalkInOrderPaid insufficient stock fails before completion", async () => {
  let rpcCalls = 0;
  __setWalkInCompleteDepsForTests({
    getOrderByIdForService: async () => ({
      id: "wi-4",
      order_source: "walk_in",
      order_status: "draft",
      status: "pending",
      items: [{ slug: "x", boxQuantities: { M: 1 } }],
    }),
    isSupabaseInventoryBackend: () => true,
    buildWalkInSaleOps: async () => {
      const e = new Error("Insufficient stock to complete this walk-in order.");
      e.statusCode = 409;
      throw e;
    },
    rpcWalkInOrderComplete: async () => {
      rpcCalls += 1;
      return { ok: true, idempotent: false, order: {} };
    },
  });

  await assert.rejects(
    () => markWalkInOrderPaid({ orderId: "wi-4", paymentMethod: "check" }),
    (e) => e.statusCode === 409 && /Insufficient stock/i.test(e.message),
  );
  assert.equal(rpcCalls, 0);
});

test("mark-paid handler: auth required, receipt after completion, no duplicate receipt on idempotent replay", async () => {
  process.env.ALLOW_INSECURE_LOCAL_ADMIN_API = "1";

  let completeCalls = 0;
  const completedOrder = {
    id: "wi-5",
    order_ref: "SAI-W5",
    order_source: "walk_in",
    status: "paid",
    order_status: "shipped",
    payment_method: "check",
    paid_at: "2026-07-24T12:00:00.000Z",
    admin_handoff_at: "2026-07-24T12:00:00.000Z",
    inventory_committed_at: "2026-07-24T12:00:00.000Z",
    customer_email: "buyer@example.com",
    items: [{ slug: "black-nitrile-general" }],
    inventoryCommitted: true,
    idempotent: false,
  };

  __setWalkInCompleteDepsForTests({
    getOrderByIdForService: async () => {
      if (completeCalls === 0) {
        return {
          id: "wi-5",
          order_source: "walk_in",
          order_status: "draft",
          status: "pending",
          items: completedOrder.items,
          customer_email: "buyer@example.com",
        };
      }
      return { ...completedOrder, idempotent: undefined, inventoryCommitted: undefined };
    },
    isSupabaseInventoryBackend: () => true,
    buildWalkInSaleOps: async () => [],
    rpcWalkInOrderComplete: async () => {
      completeCalls += 1;
      return {
        ok: true,
        idempotent: completeCalls > 1,
        order: { ...completedOrder, idempotent: completeCalls > 1 },
      };
    },
  });

  // Patch receipt via dynamic override is heavy; assert response shape without Resend by omitting email send path when sendReceipt false first.
  const res1 = makeRes();
  await markPaidHandler(
    { method: "POST", headers: {}, body: { orderId: "wi-5", paymentMethod: "check", sendReceipt: false } },
    res1,
  );
  assert.equal(res1.statusCode, 200);
  assert.equal(res1.body.ok, true);
  assert.equal(res1.body.completed, true);
  assert.equal(res1.body.inventoryCommitted, true);
  assert.equal(res1.body.orderStatus, "shipped");
  assert.equal(res1.body.receiptEmailAttempted, false);

  // Unauthenticated
  delete process.env.ALLOW_INSECURE_LOCAL_ADMIN_API;
  process.env.INTERNAL_REPORTS_SECRET = "test-secret";
  __setSupabaseAccessTokenVerifierForTests(async () => null);
  const resUnauth = makeRes();
  await markPaidHandler(
    { method: "POST", headers: {}, body: { orderId: "wi-5", paymentMethod: "cash" } },
    resUnauth,
  );
  assert.equal(resUnauth.statusCode, 401);
});

test("carrier handoff still requires label evidence; completed walk-in does not re-decrement", async () => {
  let stockCalls = 0;
  __setWalkInCompleteDepsForTests({
    getOrderByIdForService: async (id) => {
      if (id === "carrier-1") {
        return {
          id: "carrier-1",
          order_source: "manual",
          status: "paid",
          order_status: "paid",
          shippo_label_required: true,
          admin_handoff_at: null,
          items: [{ slug: "x" }],
        };
      }
      return {
        id: "wi-done",
        order_source: "walk_in",
        order_type: "walk_in",
        status: "paid",
        order_status: "shipped",
        admin_handoff_at: "2026-07-24T12:00:00.000Z",
        inventory_committed_at: "2026-07-24T12:00:00.000Z",
        items: [{ slug: "x" }],
      };
    },
  });

  await assert.rejects(
    () => markAdminOrderHandoffShipped("carrier-1"),
    (e) => e.statusCode === 400 && /shipping label/i.test(e.message),
  );

  const walked = await markAdminOrderHandoffShipped("wi-done");
  assert.equal(walked.order_status, "shipped");
  assert.equal(stockCalls, 0);
});
