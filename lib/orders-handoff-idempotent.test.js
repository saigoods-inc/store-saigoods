import assert from "node:assert/strict";
import test from "node:test";
import { isAdminHandoffAlreadyComplete, isWalkInOrderRow } from "./orders.js";

test("isAdminHandoffAlreadyComplete is true when admin_handoff_at is set", () => {
  assert.equal(isAdminHandoffAlreadyComplete({ admin_handoff_at: "2026-01-01T00:00:00.000Z" }), true);
});

test("isAdminHandoffAlreadyComplete is true when order_status is shipped", () => {
  assert.equal(isAdminHandoffAlreadyComplete({ order_status: "shipped" }), true);
});

test("isAdminHandoffAlreadyComplete is false for unshipped paid orders", () => {
  assert.equal(
    isAdminHandoffAlreadyComplete({ order_status: "label_purchased", admin_handoff_at: null }),
    false,
  );
});

test("isWalkInOrderRow detects walk_in source and type", () => {
  assert.equal(isWalkInOrderRow({ order_source: "walk_in" }), true);
  assert.equal(isWalkInOrderRow({ order_type: "walk_in" }), true);
  assert.equal(isWalkInOrderRow({ order_source: "web" }), false);
});
