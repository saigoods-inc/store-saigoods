import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const ordersSource = readFileSync(new URL("./orders.js", import.meta.url), "utf8");
const serviceSource = readFileSync(new URL("./inventory-service.js", import.meta.url), "utf8");
const migration = readFileSync(
  new URL("../sql/patch-online-payment-inventory-atomic.sql", import.meta.url),
  "utf8",
);

test("online payment builds fail-closed inventory operations", () => {
  assert.match(serviceSource, /buildWebsiteOrderPaymentOps/);
  assert.match(serviceSource, /"order_commit",\s*\{\s*rejectInsufficient:\s*true/);
});

test("paid transition and inventory mutation share one database transaction", () => {
  const applyIndex = migration.indexOf("perform public.inventory_apply_ops");
  const paidIndex = migration.indexOf("set status = 'paid'");
  assert.ok(applyIndex > 0);
  assert.ok(paidIndex > applyIndex);
  assert.match(migration, /inventory_committed_at = v_now/);
  assert.match(migration, /security definer/);
  assert.match(ordersSource, /rpcOnlineOrderPaymentComplete/);
});

test("post-charge finalization failures are durably flagged for reconciliation", () => {
  assert.match(ordersSource, /payment_reconciliation_required:\s*true/);
  assert.match(ordersSource, /payment_reconciliation_error:\s*"online_payment_finalize_failed"/);
});
