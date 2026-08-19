import assert from "node:assert/strict";
import test from "node:test";
import {
  isAutomaticManualLabelEligible,
  originalShippoRatePlan,
  processAutomaticManualLabels,
} from "./automatic-manual-label-worker.js";

function order(overrides = {}) {
  return {
    id: 42,
    order_source: "manual",
    status: "paid",
    payment_flow: "square_payment_link",
    fulfillment_method: "carrier",
    shippo_label_required: true,
    quoted_shipping_provider: "UPS",
    quoted_shipping_service_label: "Ground",
    quoted_shipping_service_code: "ground",
    shipping_cents: 1200,
    ...overrides,
  };
}

test("automatic labels only apply to paid manual Square carrier orders", () => {
  assert.equal(isAutomaticManualLabelEligible(order()), true);
  assert.equal(isAutomaticManualLabelEligible(order({ status: "pending" })), false);
  assert.equal(isAutomaticManualLabelEligible(order({ payment_flow: "pay_later" })), false);
  assert.equal(isAutomaticManualLabelEligible(order({ fulfillment_method: "pickup" })), false);
});

test("original rate plan reads the exact saved Shippo rate", () => {
  assert.deepEqual(
    originalShippoRatePlan(
      order({
        quoted_shipping_base_amount_cents: 900,
        selected_shipping_rate_snapshot_json: JSON.stringify({
          providerQuoteId: "rate-original",
          packageRateObjectIds: ["rate-original"],
          packageShipmentObjectIds: ["shipment-original"],
        }),
      }),
      1,
    ),
    {
      rateIds: ["rate-original"],
      shipmentIds: ["shipment-original"],
      quotedCostCents: 900,
    },
  );
});

test("automatic worker buys the saved original rate without requesting fresh rates", async () => {
  const rows = [];
  let rateRequests = 0;
  let purchasedRateId = null;
  const saveLabel = async (_orderId, index, parcelCount, patch) => {
    const row = {
      ...(rows.find((item) => item.parcel_index === index) || {}),
      parcel_index: index,
      parcel_count: parcelCount,
      ...patch,
    };
    const position = rows.findIndex((item) => item.parcel_index === index);
    if (position >= 0) rows[position] = row;
    else rows.push(row);
    return row;
  };
  const result = await processAutomaticManualLabels(42, {
    getOrder: async () => order({
      quoted_shipping_base_amount_cents: 900,
      selected_shipping_rate_snapshot_json: {
        providerQuoteId: "rate-original",
        packageRateObjectIds: ["rate-original"],
        packageShipmentObjectIds: ["shipment-original"],
      },
    }),
    listLabels: async () => rows,
    resolveParcels: () => ({ source: "test", parcels: [{ weight: "1" }] }),
    createShipment: async () => { rateRequests += 1; throw new Error("fresh rating must not run"); },
    buyLabel: async (rateId) => {
      purchasedRateId = rateId;
      return {
        transactionObjectId: "tx-original",
        labelUrl: "https://label/original",
        rate: {
          provider: "UPS",
          amount: "9.00",
          currency: "USD",
          servicelevel: { name: "Ground", token: "ground" },
        },
      };
    },
    claimLabel: async (_orderId, index, parcelCount, patch) =>
      saveLabel(_orderId, index, parcelCount, { ...patch, status: "processing" }),
    saveLabel,
    updateOrder: async () => ({}),
    recomputeStatus: async () => ({}),
  });

  assert.equal(result.ok, true);
  assert.equal(rateRequests, 0);
  assert.equal(purchasedRateId, "rate-original");
  assert.equal(rows[0].shipment_object_id, "shipment-original");
});

test("automatic worker purchases the selected service once", async () => {
  const rows = [];
  let purchases = 0;
  const saveLabel = async (_orderId, index, parcelCount, patch) => {
    const row = { ...(rows.find((item) => item.parcel_index === index) || {}), parcel_index: index, parcel_count: parcelCount, ...patch };
    const position = rows.findIndex((item) => item.parcel_index === index);
    if (position >= 0) rows[position] = row;
    else rows.push(row);
    return row;
  };
  const result = await processAutomaticManualLabels(42, {
    getOrder: async () => order(),
    listLabels: async () => rows,
    resolveParcels: () => ({ source: "test", parcels: [{ weight: "1" }] }),
    buildShipment: () => ({ ok: true, body: {} }),
    createShipment: async () => ({ ok: true, shipmentId: "shipment-1", rates: [{ object_id: "rate-1", provider: "UPS", amount: "9.00", currency: "USD", servicelevel: { name: "Ground", token: "ground" } }] }),
    selectRate: (rates) => rates[0],
    buyLabel: async () => { purchases += 1; return { transactionObjectId: "tx-1", labelUrl: "https://label", rate: { provider: "UPS", amount: "9.00", currency: "USD", servicelevel: { name: "Ground", token: "ground" } } }; },
    claimLabel: async (_orderId, index, parcelCount, patch) => saveLabel(_orderId, index, parcelCount, { ...patch, status: "processing" }),
    saveLabel,
    updateOrder: async () => ({}),
    recomputeStatus: async () => ({}),
  });
  assert.equal(result.ok, true);
  assert.equal(purchases, 1);
  assert.equal(rows[0].status, "purchased");
});

test("automatic worker does not purchase when another worker owns the parcel", async () => {
  let purchases = 0;
  const result = await processAutomaticManualLabels(42, {
    getOrder: async () => order(),
    listLabels: async () => [],
    resolveParcels: () => ({ source: "test", parcels: [{}] }),
    buildShipment: () => ({ ok: true, body: {} }),
    createShipment: async () => ({ ok: true, shipmentId: "shipment-1", rates: [{ object_id: "rate-1", provider: "UPS", amount: "9.00", servicelevel: { name: "Ground", token: "ground" } }] }),
    selectRate: (rates) => rates[0],
    claimLabel: async () => null,
    buyLabel: async () => { purchases += 1; },
    updateOrder: async () => ({}),
    recomputeStatus: async () => ({}),
  });
  assert.equal(result.skipped, true);
  assert.equal(result.reason, "already_processing");
  assert.equal(purchases, 0);
});

test("automatic worker does not spend more than collected shipping", async () => {
  let purchases = 0;
  const updates = [];
  const result = await processAutomaticManualLabels(42, {
    getOrder: async () => order({ shipping_cents: 800 }),
    listLabels: async () => [],
    resolveParcels: () => ({ source: "test", parcels: [{}] }),
    buildShipment: () => ({ ok: true, body: {} }),
    createShipment: async () => ({ ok: true, shipmentId: "shipment-1", rates: [{ object_id: "rate-1", provider: "UPS", amount: "9.00", servicelevel: { name: "Ground", token: "ground" } }] }),
    selectRate: (rates) => rates[0],
    buyLabel: async () => { purchases += 1; },
    updateOrder: async (_id, patch) => { updates.push(patch); },
  });
  assert.equal(result.reviewRequired, true);
  assert.equal(result.reason, "price_exceeds_collected_shipping");
  assert.equal(purchases, 0);
  assert.match(updates[0].shippo_label_sync_error, /exceeds collected shipping/i);
});

test("automatic worker leaves a rate-limited order queued for cron retry", async () => {
  const updates = [];
  const result = await processAutomaticManualLabels(42, {
    getOrder: async () => order(),
    listLabels: async () => [],
    resolveParcels: () => ({ source: "test", parcels: [{}] }),
    buildShipment: () => ({ ok: true, body: {} }),
    createShipment: async () => ({
      ok: false,
      errorCode: "SHIPPO_RATE_LIMITED",
      retryable: true,
      errorMessage: "UPS is temporarily limiting rate requests. Automatic label purchase will retry shortly.",
    }),
    updateOrder: async (_id, patch) => { updates.push(patch); },
  });

  assert.equal(result.ok, false);
  assert.equal(result.retryScheduled, true);
  assert.equal(result.reviewRequired, false);
  assert.equal(result.reason, "SHIPPO_RATE_LIMITED");
  assert.match(updates[0].shippo_label_sync_error, /retry shortly/i);
});
