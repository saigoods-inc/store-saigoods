import assert from "node:assert/strict";
import test from "node:test";

import handler from "./admin-order-packing-plan.js";

function mockRes() {
  const state = {};
  return {
    state,
    status(code) {
      state.statusCode = code;
      return this;
    },
    json(body) {
      state.body = body;
      return this;
    },
  };
}

async function invoke(req) {
  const res = mockRes();
  await handler(req, res);
  return res.state;
}

async function withoutConsoleError(fn) {
  const original = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = original;
  }
}

test("admin-order-packing-plan rejects non-POST requests", async () => {
  const state = await invoke({ method: "PUT", body: {}, headers: {} });

  assert.equal(state.statusCode, 405);
  assert.deepEqual(state.body, { error: "Method not allowed." });
});

test("admin-order-packing-plan requires admin authorization", async () => {
  const state = await withoutConsoleError(() =>
    invoke({
      method: "POST",
      body: { orderId: "order_test", action: "preview" },
      headers: {},
    }),
  );

  assert.equal(state.statusCode, 401);
  assert.deepEqual(state.body, { error: "Unauthorized." });
});

test("admin-order-packing-plan validates request body before database work", async () => {
  const previousSecret = process.env.INTERNAL_REPORTS_SECRET;
  process.env.INTERNAL_REPORTS_SECRET = "test-secret";
  try {
    const missingOrder = await invoke({
      method: "POST",
      body: { action: "preview" },
      headers: { authorization: "Bearer test-secret" },
    });
    assert.equal(missingOrder.statusCode, 400);
    assert.deepEqual(missingOrder.body, { error: "orderId is required." });

    const badAction = await invoke({
      method: "POST",
      body: { orderId: "order_test", action: "delete" },
      headers: { authorization: "Bearer test-secret" },
    });
    assert.equal(badAction.statusCode, 400);
    assert.deepEqual(badAction.body, { error: "action must be preview, save, or clear." });
  } finally {
    if (previousSecret == null) {
      delete process.env.INTERNAL_REPORTS_SECRET;
    } else {
      process.env.INTERNAL_REPORTS_SECRET = previousSecret;
    }
  }
});

test("admin-order-packing-plan allows GET for read-only preview compatibility", async () => {
  const previousSecret = process.env.INTERNAL_REPORTS_SECRET;
  process.env.INTERNAL_REPORTS_SECRET = "test-secret";
  try {
    const save = await invoke({
      method: "GET",
      query: { orderId: "order_test", action: "save" },
      headers: { authorization: "Bearer test-secret" },
    });
    assert.equal(save.statusCode, 405);
    assert.deepEqual(save.body, { error: "Only preview is allowed with GET." });

    const missingOrder = await invoke({
      method: "GET",
      query: { action: "preview" },
      headers: { authorization: "Bearer test-secret" },
    });
    assert.equal(missingOrder.statusCode, 400);
    assert.deepEqual(missingOrder.body, { error: "orderId is required." });
  } finally {
    if (previousSecret == null) {
      delete process.env.INTERNAL_REPORTS_SECRET;
    } else {
      process.env.INTERNAL_REPORTS_SECRET = previousSecret;
    }
  }
});
