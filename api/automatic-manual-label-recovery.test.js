import assert from "node:assert/strict";
import test from "node:test";

import { recoverAutomaticManualLabels } from "./automatic-manual-label-recovery.js";

function fakeClient(rows, calls) {
  const query = {
    from(table) {
      calls.push(["from", table]);
      return this;
    },
    select(columns) {
      calls.push(["select", columns]);
      return this;
    },
    eq(column, value) {
      calls.push(["eq", column, value]);
      return this;
    },
    or(expression) {
      calls.push(["or", expression]);
      return this;
    },
    is(column, value) {
      calls.push(["is", column, value]);
      return this;
    },
    limit(value) {
      calls.push(["limit", value]);
      return this;
    },
    then(resolve) {
      resolve({ data: rows, error: null });
    },
  };
  return query;
}

test("targeted manual-label recovery processes only the requested eligible order", async () => {
  const calls = [];
  const processed = [];
  const outcomes = await recoverAutomaticManualLabels({
    client: fakeClient([{ id: "123" }], calls),
    orderId: "123",
    processOrder: async (orderId) => {
      processed.push(orderId);
      return { ok: true };
    },
  });

  assert.deepEqual(processed, ["123"]);
  assert.deepEqual(outcomes, [{ orderId: "123", ok: true }]);
  assert.ok(calls.some((call) => call[0] === "eq" && call[1] === "id" && call[2] === "123"));
  assert.ok(calls.some((call) => call[0] === "limit" && call[1] === 1));
});

test("targeted recovery resolves an admin-facing order reference without filtering the bigint id", async () => {
  const calls = [];
  const processed = [];
  const outcomes = await recoverAutomaticManualLabels({
    client: fakeClient([{ id: "456" }], calls),
    orderId: "SAI-0D3A377447CA",
    processOrder: async (orderId) => {
      processed.push(orderId);
      return { ok: true, parcelCount: 2, purchasedCount: 2 };
    },
  });

  assert.deepEqual(processed, ["456"]);
  assert.deepEqual(outcomes, [
    { orderId: "456", ok: true, parcelCount: 2, purchasedCount: 2 },
  ]);
  assert.ok(
    calls.some(
      (call) =>
        call[0] === "eq" &&
        call[1] === "order_ref" &&
        call[2] === "SAI-0D3A377447CA",
    ),
  );
  assert.equal(
    calls.some(
      (call) =>
        call[0] === "eq" &&
        call[1] === "id" &&
        call[2] === "SAI-0D3A377447CA",
    ),
    false,
  );
});

test("scheduled recovery retains its ten-order batch when no order is targeted", async () => {
  const calls = [];
  await recoverAutomaticManualLabels({
    client: fakeClient([], calls),
    processOrder: async () => ({ ok: true }),
  });

  assert.equal(calls.some((call) => call[0] === "eq" && call[1] === "id"), false);
  assert.ok(calls.some((call) => call[0] === "limit" && call[1] === 10));
});
