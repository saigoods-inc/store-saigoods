import assert from "node:assert/strict";
import test from "node:test";

import {
  releaseShippoLabelPurchaseClaim,
  sanitizeLabelPurchaseOutcome,
  tryClaimShippoLabelPurchase,
} from "./shippo-label-purchase-claim.js";

function fakeClient(result = { data: [{ id: 42 }], error: null }) {
  const calls = { update: null, eq: [], or: [], select: [] };
  const chain = {
    eq(column, value) { calls.eq.push({ column, value }); return chain; },
    or(value) { calls.or.push(value); return chain; },
    select(value) { calls.select.push(value); return Promise.resolve(result); },
  };
  return {
    calls,
    from(table) {
      assert.equal(table, "orders");
      return { update(value) { calls.update = value; return chain; } };
    },
  };
}

test("persistent label claim is a conditional paid-order update", async () => {
  const previous = process.env.SHIPPO_LABEL_DB_LOCK;
  process.env.SHIPPO_LABEL_DB_LOCK = "1";
  try {
    const client = fakeClient();
    const claim = await tryClaimShippoLabelPurchase({
      orderId: 42,
      client,
      now: () => new Date("2026-08-16T00:00:00.000Z"),
      createClaimId: () => "claim-1",
    });
    assert.deepEqual(claim, { claimId: "claim-1", claimedAt: "2026-08-16T00:00:00.000Z" });
    assert.equal(client.calls.update.shippo_label_purchase_claim_id, "claim-1");
    assert.deepEqual(client.calls.eq, [{ column: "id", value: 42 }, { column: "status", value: "paid" }]);
    assert.match(client.calls.or[0], /shippo_label_purchase_claimed_at\.is\.null/);
  } finally {
    if (previous == null) delete process.env.SHIPPO_LABEL_DB_LOCK;
    else process.env.SHIPPO_LABEL_DB_LOCK = previous;
  }
});

test("claim returns null when another server owns the order", async () => {
  const previous = process.env.SHIPPO_LABEL_DB_LOCK;
  process.env.SHIPPO_LABEL_DB_LOCK = "1";
  try {
    const claim = await tryClaimShippoLabelPurchase({ orderId: 42, client: fakeClient({ data: [], error: null }) });
    assert.equal(claim, null);
  } finally {
    if (previous == null) delete process.env.SHIPPO_LABEL_DB_LOCK;
    else process.env.SHIPPO_LABEL_DB_LOCK = previous;
  }
});

test("release requires the same claim token and never stores raw errors", async () => {
  const client = fakeClient();
  const released = await releaseShippoLabelPurchaseClaim({ orderId: 42, claimId: "claim-1", outcome: "raw provider secret", client });
  assert.equal(released, true);
  assert.equal(client.calls.update.shippo_label_purchase_claim_id, null);
  assert.equal(client.calls.update.shippo_label_purchase_last_error, "failed");
  assert.deepEqual(client.calls.eq, [{ column: "id", value: 42 }, { column: "shippo_label_purchase_claim_id", value: "claim-1" }]);
  assert.equal(sanitizeLabelPurchaseOutcome("raw provider secret"), "failed");
});
