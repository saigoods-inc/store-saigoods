import test from "node:test";
import assert from "node:assert/strict";
import {
  automaticLabelPackagePlan,
  isAutomaticShippoLabelEligible,
  processAutomaticLabelsForOrder,
} from "./automatic-label-worker.js";

function order(overrides = {}) {
  return {
    id: 42,
    order_source: "web",
    order_type: "online",
    status: "paid",
    order_status: "paid_label_pending",
    fulfillment_method: "carrier",
    shippo_label_required: true,
    selected_shipping_rate_snapshot_json: {
      provider: "UPS",
      serviceCode: "ups_ground",
      serviceLabel: "Ground",
      currency: "USD",
      packageRateObjectIds: ["rate-1", "rate-2"],
      packageShipmentObjectIds: ["ship-1", "ship-2"],
    },
    quoted_parcel_summary_json: {
      parcelCount: 2,
      parcels: [{ length: "10.375" }, { length: "10.375" }],
    },
    ...overrides,
  };
}

function harness({ initialRows = [], purchase } = {}) {
  const rows = initialRows.map((row) => ({ ...row }));
  const statuses = [];
  let calls = 0;
  return {
    rows,
    statuses,
    get calls() { return calls; },
    dependencies: {
      getOrder: async () => order(),
      listLabels: async () => rows.map((row) => ({ ...row })),
      setOrderStatus: async (_id, status) => statuses.push(status),
      claimPackage: async ({ parcelIndex, parcelCount, rateObjectId }) => {
        const existing = rows.find((row) => row.parcel_index === parcelIndex);
        if (existing?.claimed) return null;
        const row = existing || { parcel_index: parcelIndex, parcel_count: parcelCount };
        if (!existing) rows.push(row);
        Object.assign(row, { status: "processing", selected_rate_object_id: rateObjectId, attempt_count: (row.attempt_count || 0) + 1 });
        return { row: { ...row }, claimId: `claim-${parcelIndex}`, attemptId: `attempt-${parcelIndex}` };
      },
      transitionPackage: async ({ parcelIndex, status, patch }) => {
        const row = rows.find((candidate) => candidate.parcel_index === parcelIndex);
        Object.assign(row, patch, { status });
        return { ...row };
      },
      purchaseLabel: async (rateId) => {
        calls += 1;
        if (purchase) return purchase(rateId);
        return {
          transactionObjectId: `tx-${rateId}`,
          labelUrl: `https://label/${rateId}`,
          trackingNumber: `track-${rateId}`,
          rate: { amount: "7.25", currency: "USD", provider: "UPS", servicelevel: { token: "ups_ground", name: "Ground" } },
        };
      },
      findRecentTransaction: async () => null,
      reconcileTransaction: async () => null,
      now: () => new Date("2026-08-17T00:00:00.000Z"),
    },
  };
}

test("automatic label eligibility excludes manual, B2B, local, pickup, and external fulfillment", () => {
  assert.equal(isAutomaticShippoLabelEligible(order()), true);
  for (const candidate of [
    order({ order_source: "manual" }),
    order({ fulfillment_method: "b2b_shipping" }),
    order({ fulfillment_method: "local_delivery" }),
    order({ fulfillment_method: "pickup" }),
    order({ shippo_label_required: false }),
  ]) assert.equal(isAutomaticShippoLabelEligible(candidate), false);
});
test("package plan requires one signed Shippo rate for every quoted parcel", () => {
  assert.deepEqual(automaticLabelPackagePlan(order()).map((pkg) => pkg.rateObjectId), ["rate-1", "rate-2"]);
  assert.throws(
    () => automaticLabelPackagePlan(order({ selected_shipping_rate_snapshot_json: { packageRateObjectIds: ["rate-1"] } })),
    /missing a package rate/i,
  );
});

test("successful multi-package processing purchases each package once and becomes ready", async () => {
  const h = harness();
  const result = await processAutomaticLabelsForOrder(42, h.dependencies);
  assert.equal(h.calls, 2);
  assert.equal(result.ok, true);
  assert.deepEqual(h.rows.map((row) => row.status), ["purchased", "purchased"]);
  assert.deepEqual(h.statuses.slice(-2), ["labels_purchased", "ready_to_fulfill"]);
});

test("retrying a partial order never repurchases a successful package", async () => {
  const h = harness({ initialRows: [{ parcel_index: 0, parcel_count: 2, status: "purchased", label_url: "https://label/one" }] });
  const result = await processAutomaticLabelsForOrder(42, h.dependencies);
  assert.equal(h.calls, 1);
  assert.equal(result.purchased, 2);
});

test("a concurrent package claim prevents a duplicate Shippo transaction", async () => {
  const h = harness({ initialRows: [{ parcel_index: 0, parcel_count: 2, status: "processing", claimed: true }] });
  await processAutomaticLabelsForOrder(42, h.dependencies);
  assert.equal(h.calls, 1);
});

test("cancellation claim stops a worker before it purchases a label", async () => {
  const h = harness();
  let reads = 0;
  h.dependencies.getOrder = async () => order({ status: reads++ === 0 ? "paid" : "cancellation_pending" });
  const result = await processAutomaticLabelsForOrder(42, h.dependencies);
  assert.equal(h.calls, 0);
  assert.equal(result.purchased, 0);
  assert.deepEqual(h.rows.map((row) => row.status), ["skipped", "skipped"]);
});

test("Shippo timeout enters unknown and is not blindly retried", async () => {
  const h = harness({ purchase: async () => { throw Object.assign(new Error("timeout"), { labelPurchaseOutcomeUnknown: true }); } });
  const result = await processAutomaticLabelsForOrder(42, h.dependencies);
  assert.equal(h.calls, 2);
  assert.equal(result.orderStatus, "label_purchase_unknown");
  assert.deepEqual(h.rows.map((row) => row.status), ["unknown", "unknown"]);
});

test("one package failure preserves the successful label and marks partial failure", async () => {
  const h = harness({ purchase: async (rateId) => {
    if (rateId === "rate-2") throw new Error("provider outage");
    return { transactionObjectId: "tx-1", labelUrl: "https://label/1", trackingNumber: "track-1", rate: {} };
  } });
  const result = await processAutomaticLabelsForOrder(42, h.dependencies);
  assert.equal(result.purchased, 1);
  assert.equal(result.orderStatus, "partial_label_failure");
  assert.deepEqual(h.rows.map((row) => row.status), ["purchased", "retry"]);
});

test("unknown outcome attaches a found Shippo transaction without purchasing again", async () => {
  const h = harness({ initialRows: [
    { id: "row-0", parcel_index: 0, parcel_count: 2, status: "unknown", selected_rate_object_id: "rate-1" },
    { parcel_index: 1, parcel_count: 2, status: "purchased", label_url: "https://label/2" },
  ] });
  h.dependencies.findRecentTransaction = async () => ({ object_id: "tx-existing", status: "SUCCESS", label_url: "https://label/1" });
  h.dependencies.reconcileTransaction = async (row, tx) => {
    Object.assign(row, { status: "purchased", label_url: tx.label_url, transaction_id: tx.object_id });
    Object.assign(h.rows[0], row);
    return row;
  };
  const result = await processAutomaticLabelsForOrder(42, h.dependencies);
  assert.equal(h.calls, 0);
  assert.equal(result.ok, true);
});
