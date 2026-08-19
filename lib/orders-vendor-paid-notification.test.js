import assert from "node:assert/strict";
import test from "node:test";
import { releaseVendorPaidNotificationClaim, tryClaimVendorPaidNotification } from "./orders.js";

/**
 * @param {{ data?: object[], error?: object | null }} terminalResult
 */
function createFakeSupabaseClient(terminalResult = { data: [], error: null }) {
  /** @type {{
   *   from: string[],
   *   update: object | null,
   *   eq: Array<{ col: string, val: unknown }>,
   *   is: Array<{ col: string, val: unknown }>,
   *   or: string[],
   *   select: string[],
   *   updateCount: number,
   * }} */
  const calls = {
    from: [],
    update: null,
    eq: [],
    is: [],
    or: [],
    select: [],
    updateCount: 0,
  };

  const chain = {
    eq(col, val) {
      calls.eq.push({ col, val });
      return chain;
    },
    is(col, val) {
      calls.is.push({ col, val });
      return chain;
    },
    or(expr) {
      calls.or.push(expr);
      return chain;
    },
    select(cols) {
      calls.select.push(cols);
      return Promise.resolve(terminalResult);
    },
  };

  return {
    calls,
    from(table) {
      calls.from.push(table);
      return {
        update(payload) {
          calls.updateCount += 1;
          calls.update = payload;
          return chain;
        },
      };
    },
  };
}

test("tryClaimVendorPaidNotification performs one conditional update with expected filters", async () => {
  const row = {
    id: "order-uuid-1",
    status: "paid",
    payment_id: "pay_square_99",
  };
  const client = createFakeSupabaseClient({ data: [row], error: null });

  const result = await tryClaimVendorPaidNotification({
    orderId: "order-uuid-1",
    paymentId: "pay_square_99",
    client,
  });

  assert.equal(client.calls.updateCount, 1);
  assert.deepEqual(client.calls.from, ["orders"]);
  assert.equal(client.calls.update.vendor_paid_notification_error, null);
  assert.equal(client.calls.update.vendor_paid_notification_claimed_at, client.calls.update.updated_at);
  assert.match(client.calls.update.vendor_paid_notification_claimed_at, /^\d{4}-\d{2}-\d{2}T/);

  assert.deepEqual(client.calls.eq, [
    { col: "id", val: "order-uuid-1" },
    { col: "status", val: "paid" },
    { col: "payment_id", val: "pay_square_99" },
  ]);
  assert.deepEqual(client.calls.is, [{ col: "vendor_paid_notification_sent_at", val: null }]);
  assert.equal(client.calls.or.length, 1);
  assert.match(client.calls.or[0], /vendor_paid_notification_claimed_at\.is\.null/);
  assert.match(client.calls.or[0], /vendor_paid_notification_claimed_at\.lt\./);
  assert.deepEqual(client.calls.select, ["*"]);

  assert.ok(result);
  assert.equal(result.order, row);
  assert.equal(result.claimedAt, client.calls.update.vendor_paid_notification_claimed_at);
});

test("tryClaimVendorPaidNotification returns null when no row is updated", async () => {
  const client = createFakeSupabaseClient({ data: [], error: null });

  const result = await tryClaimVendorPaidNotification({
    orderId: "order-uuid-1",
    paymentId: "pay_square_99",
    client,
  });

  assert.equal(result, null);
  assert.equal(client.calls.updateCount, 1);
});

test("tryClaimVendorPaidNotification accepts an injected client factory", async () => {
  const row = { id: "42", status: "paid", payment_id: "pay_1" };
  const client = createFakeSupabaseClient({ data: [row], error: null });
  let factoryCalls = 0;

  const result = await tryClaimVendorPaidNotification({
    orderId: "42",
    paymentId: "pay_1",
    getClient: () => {
      factoryCalls += 1;
      return client;
    },
  });

  assert.equal(factoryCalls, 1);
  assert.ok(result);
  assert.equal(result.order.id, "42");
});

test("releaseVendorPaidNotificationClaim stores an allowed classification unchanged", async () => {
  const client = createFakeSupabaseClient({ data: [{ id: "order-uuid-1" }], error: null });

  const ok = await releaseVendorPaidNotificationClaim({
    orderId: "order-uuid-1",
    claimedAt: "2026-07-21T10:00:00.000Z",
    error: "vendor_notification_send_failed",
    client,
  });

  assert.equal(ok, true);
  assert.equal(client.calls.updateCount, 1);
  assert.equal(client.calls.update.vendor_paid_notification_claimed_at, null);
  assert.equal(client.calls.update.vendor_paid_notification_error, "vendor_notification_send_failed");
});

test("releaseVendorPaidNotificationClaim converts raw secrets to vendor_notification_failed", async () => {
  const client = createFakeSupabaseClient({ data: [{ id: "order-uuid-1" }], error: null });
  const secretMarker = "re_dummy_secret_should_never_be_stored";

  const ok = await releaseVendorPaidNotificationClaim({
    orderId: "order-uuid-1",
    claimedAt: "2026-07-21T10:00:00.000Z",
    error: secretMarker,
    client,
  });

  assert.equal(ok, true);
  assert.equal(client.calls.update.vendor_paid_notification_error, "vendor_notification_failed");
  assert.equal(JSON.stringify(client.calls.update).includes(secretMarker), false);
});
