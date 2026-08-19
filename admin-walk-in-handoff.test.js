import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

import {
  __resetWalkInCompleteDepsForTests,
  __setWalkInCompleteDepsForTests,
  markAdminOrderHandoffShipped,
} from "./lib/orders.js";

afterEach(() => {
  __resetWalkInCompleteDepsForTests();
});

function walkInBase(overrides = {}) {
  return {
    id: "wi-h1",
    order_source: "walk_in",
    order_type: "walk_in",
    status: "paid",
    order_status: "paid",
    admin_handoff_at: null,
    inventory_committed_at: null,
    items: [{ slug: "x" }],
    ...overrides,
  };
}

const REJECT_WALK_IN =
  /Walk-in orders are completed through Walk-in mark-paid/i;

test("Walk-in without inventory commit cannot use carrier handoff path", async () => {
  __setWalkInCompleteDepsForTests({
    getOrderByIdForService: async () => walkInBase(),
  });

  await assert.rejects(
    () => markAdminOrderHandoffShipped("wi-h1"),
    (e) => e.statusCode === 400 && REJECT_WALK_IN.test(e.message),
  );
});

test("completed Walk-in handoff is a no-op (no second stock path)", async () => {
  const row = walkInBase({
    id: "wi-h2",
    order_status: "shipped",
    admin_handoff_at: "2026-07-24T12:00:00.000Z",
    inventory_committed_at: "2026-07-24T12:00:00.000Z",
  });
  __setWalkInCompleteDepsForTests({
    getOrderByIdForService: async () => row,
    getClient: () => {
      throw new Error("getClient must not run for already-complete walk-in handoff");
    },
  });

  const out = await markAdminOrderHandoffShipped("wi-h2");
  assert.equal(out.admin_handoff_at, row.admin_handoff_at);
});

test("Walk-in shipped without inventory marker is rejected (no carrier bypass)", async () => {
  __setWalkInCompleteDepsForTests({
    getOrderByIdForService: async () =>
      walkInBase({
        order_status: "shipped",
        admin_handoff_at: "2026-07-24T12:00:00.000Z",
        inventory_committed_at: null,
      }),
    getClient: () => {
      throw new Error("carrier handoff path must not run for partial walk-in");
    },
  });

  await assert.rejects(
    () => markAdminOrderHandoffShipped("wi-h1"),
    (e) => e.statusCode === 400 && REJECT_WALK_IN.test(e.message),
  );
});

test("Walk-in with admin_handoff_at but no inventory marker is rejected", async () => {
  __setWalkInCompleteDepsForTests({
    getOrderByIdForService: async () =>
      walkInBase({
        order_status: "paid",
        admin_handoff_at: "2026-07-24T12:00:00.000Z",
        inventory_committed_at: null,
      }),
    getClient: () => {
      throw new Error("carrier handoff path must not run for partial walk-in");
    },
  });

  await assert.rejects(
    () => markAdminOrderHandoffShipped("wi-h1"),
    (e) => e.statusCode === 400 && REJECT_WALK_IN.test(e.message),
  );
});

test("Walk-in with inventory marker but incomplete paid/handoff state is rejected", async () => {
  __setWalkInCompleteDepsForTests({
    getOrderByIdForService: async () =>
      walkInBase({
        status: "paid",
        order_status: "paid",
        admin_handoff_at: null,
        inventory_committed_at: "2026-07-24T12:00:00.000Z",
      }),
    getClient: () => {
      throw new Error("carrier handoff path must not run for partial walk-in");
    },
  });

  await assert.rejects(
    () => markAdminOrderHandoffShipped("wi-h1"),
    (e) => e.statusCode === 400 && REJECT_WALK_IN.test(e.message),
  );
});

test("normal carrier order still fails closed without fulfillment evidence", async () => {
  __setWalkInCompleteDepsForTests({
    getOrderByIdForService: async () => ({
      id: "carrier-h1",
      order_source: "web",
      status: "paid",
      order_status: "paid",
      shippo_label_required: true,
      admin_handoff_at: null,
      tracking_number: null,
      carrier: null,
      items: [{ slug: "x" }],
    }),
  });

  await assert.rejects(
    () => markAdminOrderHandoffShipped("carrier-h1"),
    (e) => e.statusCode === 400 && /label/i.test(e.message),
  );
});

test("already-shipped non-Walk-in carrier order remains an idempotent handoff no-op", async () => {
  const row = {
    id: "carrier-h2",
    order_source: "manual",
    status: "paid",
    order_status: "shipped",
    admin_handoff_at: "2026-07-24T12:00:00.000Z",
    items: [{ slug: "x" }],
  };
  __setWalkInCompleteDepsForTests({
    getOrderByIdForService: async () => row,
    getClient: () => {
      throw new Error("getClient must not run for already-shipped non-walk-in");
    },
  });

  const out = await markAdminOrderHandoffShipped("carrier-h2");
  assert.equal(out.admin_handoff_at, row.admin_handoff_at);
});
