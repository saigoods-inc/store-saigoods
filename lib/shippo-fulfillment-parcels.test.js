import assert from "node:assert/strict";
import test from "node:test";

import { buildParcelsForOrder, resolveParcelsForFulfillment } from "./shippo-order-parcels.js";
import { buildShippoShipmentCreateBody } from "./shippo-shipment-sync.js";

const BASE_ITEM = {
  slug: "nitrile-standard",
  quantities: { M: 1 },
  boxQuantities: {},
  bundleLines: [{ id: "case_1", qty: 1 }],
};

const QUOTED_PARCEL = {
  length: "22",
  width: "12",
  height: "9",
  distance_unit: "in",
  weight: "14",
  mass_unit: "lb",
  metadata: "quoted-package-1",
};

const SHIPPING_ADDRESS = {
  name: "Test Buyer",
  line1: "123 Main St",
  city: "Savannah",
  state: "TN",
  postalCode: "38372",
  country: "US",
};

function order(overrides = {}) {
  return {
    id: "ord_test",
    order_ref: "SAI-TEST",
    customer_name: "Test Buyer",
    customer_email: "buyer@example.test",
    customer_phone: "555-555-1212",
    shipping_address: SHIPPING_ADDRESS,
    items: [{ ...BASE_ITEM }],
    ...overrides,
  };
}

test("fulfillment resolver prefers quoted checkout parcel snapshot over recomputing", () => {
  const row = order({
    quoted_parcel_summary_json: {
      source: "computed",
      parcelCount: 1,
      parcels: [QUOTED_PARCEL],
      shippoRatingShipmentId: "shippo_quote_123",
    },
  });

  const computed = buildParcelsForOrder(row);
  assert.equal(computed.source, "computed");
  assert.notEqual(computed.parcels[0].length, QUOTED_PARCEL.length);

  const resolved = resolveParcelsForFulfillment(row);
  assert.equal(resolved.source, "quoted_snapshot");
  assert.deepEqual(resolved.parcels, [QUOTED_PARCEL]);
  assert.equal(resolved.audit[0].source, "quoted_checkout_snapshot");
  assert.equal(resolved.audit[0].shippoRatingShipmentId, "shippo_quote_123");
});

test("admin parcel override wins over quoted checkout snapshot", () => {
  const overrideParcel = {
    length: "8",
    width: "7",
    height: "6",
    distance_unit: "in",
    weight: "5",
    mass_unit: "lb",
    metadata: "staff-override",
  };
  const resolved = resolveParcelsForFulfillment(
    order({
      shippo_parcels_override_json: { parcels: [overrideParcel] },
      quoted_parcel_summary_json: { parcelCount: 1, parcels: [QUOTED_PARCEL] },
    }),
  );

  assert.equal(resolved.source, "override");
  assert.deepEqual(resolved.parcels, [overrideParcel]);
});

test("selected fulfillment packing plan wins over quoted checkout snapshot with plan audit", () => {
  const planParcel = {
    length: "16",
    width: "10",
    height: "6",
    distance_unit: "in",
    weight: "2",
    mass_unit: "lb",
    metadata: "carton:glove_box_5_carton:boxes=2",
  };
  const selectedPlan = {
    source: "selected_fulfillment_packing_plan",
    selectedAt: "2026-08-15T00:00:00.000Z",
    planId: "standard_factory_case_then_cartonize_loose_v1",
    parcels: [planParcel],
    fulfillmentUnits: [{ type: "shipping_carton", cartonId: "glove_box_5_carton" }],
    parcelContents: [{ parcelIndex: 0, type: "shipping_carton", retailBoxCount: 2 }],
  };

  const resolved = resolveParcelsForFulfillment(
    order({
      shippo_parcels_override_json: selectedPlan,
      quoted_parcel_summary_json: { parcelCount: 1, parcels: [QUOTED_PARCEL] },
    }),
  );

  assert.equal(resolved.source, "selected_packing_plan");
  assert.deepEqual(resolved.parcels, [planParcel]);
  assert.equal(resolved.audit[0].source, "selected_packing_plan");
  assert.equal(resolved.audit[0].planId, "standard_factory_case_then_cartonize_loose_v1");
  assert.equal(resolved.audit[0].parcelContents[0].type, "shipping_carton");
});

test("fulfillment resolver falls back to computed parcels when quoted snapshot is absent or invalid", () => {
  const absent = resolveParcelsForFulfillment(order());
  assert.equal(absent.source, "computed");
  assert.equal(absent.parcels.length, 1);

  const invalid = resolveParcelsForFulfillment(
    order({
      quoted_parcel_summary_json: {
        parcelCount: 1,
        parcels: [{ length: "22", width: "12", height: "9" }],
      },
    }),
  );
  assert.equal(invalid.source, "computed");
  assert.equal(invalid.parcels.length, 1);

  const mismatchedCount = resolveParcelsForFulfillment(
    order({
      quoted_parcel_summary_json: {
        parcelCount: 2,
        parcels: [QUOTED_PARCEL],
      },
    }),
  );
  assert.equal(mismatchedCount.source, "computed");
  assert.equal(mismatchedCount.parcels.length, 1);
});

test("Shippo shipment body uses fulfillment parcel resolver", () => {
  const saved = { ...process.env };
  try {
    process.env.SHIPPO_FROM_STREET1 = "10 Warehouse Way";
    process.env.SHIPPO_FROM_CITY = "Savannah";
    process.env.SHIPPO_FROM_STATE = "TN";
    process.env.SHIPPO_FROM_ZIP = "38372";
    process.env.SHIPPO_FROM_COUNTRY = "US";
    process.env.SHIPPO_FROM_NAME = "SAI Goods";

    const built = buildShippoShipmentCreateBody(
      order({
        quoted_parcel_summary_json: {
          source: "computed",
          parcelCount: 1,
          parcels: [QUOTED_PARCEL],
        },
      }),
    );

    assert.equal(built.ok, true);
    assert.equal(built.source, "quoted_snapshot");
    assert.deepEqual(built.body.parcels, [QUOTED_PARCEL]);
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in saved)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, saved);
  }
});
