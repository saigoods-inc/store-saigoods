import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

import {
  __resetWalkInCompleteDepsForTests,
  __setWalkInCompleteDepsForTests,
  markWalkInOrderPaid,
} from "./lib/orders.js";
import { buildDemandDeltaOps } from "./lib/inventory-service.js";
import { __classifyWalkInRpcErrorForTests } from "./lib/inventory-repo.js";

afterEach(() => {
  __resetWalkInCompleteDepsForTests();
});

test("duplicate completion does not rebuild or re-apply inventory ops", async () => {
  const completed = {
    id: "wi-inv-1",
    order_source: "walk_in",
    status: "paid",
    order_status: "shipped",
    admin_handoff_at: "2026-07-24T12:00:00.000Z",
    inventory_committed_at: "2026-07-24T12:00:00.000Z",
    payment_method: "cash",
    items: [{ slug: "black-nitrile-general", boxQuantities: { M: 2 } }],
  };
  let buildCount = 0;
  let rpcCount = 0;
  let state = "draft";

  __setWalkInCompleteDepsForTests({
    getOrderByIdForService: async () => {
      if (state === "draft") {
        return {
          id: "wi-inv-1",
          order_source: "walk_in",
          order_status: "draft",
          status: "pending",
          items: completed.items,
        };
      }
      return completed;
    },
    isSupabaseInventoryBackend: () => true,
    buildWalkInSaleOps: async () => {
      buildCount += 1;
      return [
        {
          variant_id: "var-1",
          cases_delta: 0,
          boxes_delta: -2,
          movement_type: "walk_in_sale",
          reference_type: "order",
          reference_id: "wi-inv-1",
        },
      ];
    },
    rpcWalkInOrderComplete: async (_id, _method, ops) => {
      rpcCount += 1;
      assert.equal(ops[0].reference_id, "wi-inv-1");
      assert.equal(ops[0].movement_type, "walk_in_sale");
      state = "done";
      return { ok: true, idempotent: false, order: completed };
    },
  });

  const first = await markWalkInOrderPaid({ orderId: "wi-inv-1", paymentMethod: "cash" });
  assert.equal(first.inventoryCommitted, true);
  assert.equal(buildCount, 1);
  assert.equal(rpcCount, 1);

  const second = await markWalkInOrderPaid({ orderId: "wi-inv-1", paymentMethod: "cash" });
  assert.equal(second.idempotent, true);
  assert.equal(buildCount, 1);
  assert.equal(rpcCount, 1);
});

test("concurrent-style second completion after first wins is idempotent without second RPC", async () => {
  const completed = {
    id: "wi-inv-2",
    order_source: "walk_in",
    status: "paid",
    order_status: "shipped",
    admin_handoff_at: "2026-07-24T12:00:00.000Z",
    inventory_committed_at: "2026-07-24T12:00:00.000Z",
    items: [],
  };
  let rpcCount = 0;

  __setWalkInCompleteDepsForTests({
    getOrderByIdForService: async () => completed,
    isSupabaseInventoryBackend: () => true,
    buildWalkInSaleOps: async () => {
      throw new Error("should not build ops for completed order");
    },
    rpcWalkInOrderComplete: async () => {
      rpcCount += 1;
      return { ok: true, idempotent: true, order: completed };
    },
  });

  const out = await markWalkInOrderPaid({ orderId: "wi-inv-2", paymentMethod: "check" });
  assert.equal(out.idempotent, true);
  assert.equal(rpcCount, 0);
});

test("stock persistence failure cannot return a successful completed order", async () => {
  __setWalkInCompleteDepsForTests({
    getOrderByIdForService: async () => ({
      id: "wi-inv-3",
      order_source: "walk_in",
      order_status: "draft",
      status: "pending",
      items: [{ slug: "x", boxQuantities: { M: 1 } }],
    }),
    isSupabaseInventoryBackend: () => true,
    buildWalkInSaleOps: async () => [{ variant_id: "v", boxes_delta: -1, movement_type: "walk_in_sale" }],
    rpcWalkInOrderComplete: async () => {
      const e = new Error("Insufficient stock to complete this walk-in order.");
      e.statusCode = 409;
      throw e;
    },
  });

  await assert.rejects(
    () => markWalkInOrderPaid({ orderId: "wi-inv-3", paymentMethod: "cash" }),
    (e) => e.statusCode === 409,
  );
});

test("Walk-in ops builder fails closed on unresolved variant (does not omit item)", async () => {
  const demand = new Map([["missing-slug\tM\tbox", 1]]);
  await assert.rejects(
    () =>
      buildDemandDeltaOps(
        demand,
        { orderId: "wi-inv-4", referenceType: "order" },
        "walk_in_sale",
        {
          rejectInsufficient: true,
          resolveVariantId: async () => null,
          fetchVariantStock: async () => {
            throw new Error("fetchVariantStock must not run when variant is unresolved");
          },
        },
      ),
    (e) =>
      e.statusCode === 409 &&
      e.message === "Inventory is not configured for one or more Walk-in items.",
  );
});

test("Walk-in ops builder fails closed when inventory level row is missing", async () => {
  const demand = new Map([["black-nitrile-general\tM\tbox", 1]]);
  await assert.rejects(
    () =>
      buildDemandDeltaOps(
        demand,
        { orderId: "wi-inv-5", referenceType: "order" },
        "walk_in_sale",
        {
          rejectInsufficient: true,
          resolveVariantId: async () => "11111111-1111-1111-1111-111111111111",
          fetchVariantStock: async () => ({ boxesPerCase: 10, level: null }),
        },
      ),
    (e) =>
      e.statusCode === 409 &&
      e.message === "Inventory is not configured for one or more Walk-in items.",
  );
});

test("non-Walk-in demand builder still skips unresolved variants", async () => {
  const demand = new Map([["missing-slug\tM\tbox", 1]]);
  const ops = await buildDemandDeltaOps(demand, { orderId: "web-1" }, "order_commit", {
    rejectInsufficient: false,
    resolveVariantId: async () => null,
    fetchVariantStock: async () => {
      throw new Error("should not fetch when unresolved and non-strict");
    },
  });
  assert.deepEqual(ops, []);
});

test("Walk-in RPC error classifier maps validation failures to 400", () => {
  assert.deepEqual(__classifyWalkInRpcErrorForTests("Invalid walk-in inventory operation."), {
    message: "Invalid walk-in inventory operation.",
    statusCode: 400,
  });
  assert.deepEqual(
    __classifyWalkInRpcErrorForTests("Walk-in inventory operation does not belong to this order."),
    {
      message: "Walk-in inventory operation does not belong to this order.",
      statusCode: 400,
    },
  );
  assert.deepEqual(
    __classifyWalkInRpcErrorForTests("Duplicate variant in walk-in inventory operations."),
    {
      message: "Duplicate variant in walk-in inventory operations.",
      statusCode: 400,
    },
  );
  assert.deepEqual(
    __classifyWalkInRpcErrorForTests("Inventory is not configured for one or more Walk-in items."),
    {
      message: "Inventory is not configured for one or more Walk-in items.",
      statusCode: 409,
    },
  );
  assert.equal(__classifyWalkInRpcErrorForTests("relation does not exist").statusCode, 500);
  assert.equal(
    __classifyWalkInRpcErrorForTests("relation does not exist").message,
    "Could not complete walk-in order.",
  );
});
