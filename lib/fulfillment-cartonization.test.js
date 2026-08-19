import assert from "node:assert/strict";
import test from "node:test";

import {
  buildFulfillmentPackingPlan,
  buildSelectedPackingPlanOverride,
  loadFulfillmentPackagingConfig,
} from "./fulfillment-cartonization.js";

function orderWithItems(items) {
  return { id: "order_test", items };
}

test("loads packaging profiles and carton library", () => {
  const config = loadFulfillmentPackagingConfig();

  assert.equal(config.$schema, "sai-fulfillment-packaging-v1");
  assert.equal(config.defaults.boxesPerFactoryCase, 10);
  assert.ok(config.products["nitrile-standard"].sizes.Medium.factoryCase);
  assert.ok(config.shippingCartons.some((c) => c.id === "standard_10_box_factory_carton"));
});

test("ordered case quantities produce ship-as-is factory case parcels", () => {
  const plan = buildFulfillmentPackingPlan(
    orderWithItems([
      {
        slug: "nitrile-standard",
        quantities: { M: 1 },
        boxQuantities: {},
      },
    ]),
  );

  assert.equal(plan.source, "cartonization");
  assert.equal(plan.parcels.length, 1);
  assert.deepEqual(plan.parcels[0], {
    length: "14.37",
    width: "10.24",
    height: "9.84",
    distance_unit: "in",
    weight: "9.74",
    mass_unit: "lb",
    metadata: "nitrile-standard:factory_case:Medium",
  });
  assert.equal(plan.fulfillmentUnits[0].type, "factory_case");
  assert.equal(plan.fulfillmentUnits[0].shipAsIs, true);
  assert.equal(plan.parcelContents[0].source, "ordered_case");
});

test("loose boxes normalize into full factory cases before cartonizing remainders", () => {
  const plan = buildFulfillmentPackingPlan(
    orderWithItems([
      {
        slug: "nitrile-standard",
        quantities: {},
        boxQuantities: { M: 12 },
      },
    ]),
  );

  assert.equal(plan.parcels.length, 2);
  assert.equal(plan.fulfillmentUnits[0].type, "factory_case");
  assert.equal(plan.parcelContents[0].source, "normalized_from_loose_boxes");
  assert.equal(plan.parcels[0].metadata, "nitrile-standard:factory_case:Medium");

  assert.equal(plan.fulfillmentUnits[1].type, "shipping_carton");
  assert.equal(plan.fulfillmentUnits[1].cartonId, "loose_2_box_carton");
  assert.equal(plan.fulfillmentUnits[1].retailBoxCount, 2);
  assert.equal(plan.parcels[1].metadata, "carton:loose_2_box_carton:boxes=2");
  assert.equal(plan.parcels[1].weight, "2.34");
});

test("compatible loose boxes consolidate into standard shipping cartons", () => {
  const plan = buildFulfillmentPackingPlan(
    orderWithItems([
      {
        slug: "nitrile-standard",
        quantities: {},
        boxQuantities: { M: 3 },
      },
      {
        slug: "black-nitrile-general",
        quantities: {},
        boxQuantities: { L: 2 },
      },
    ]),
  );

  assert.equal(plan.parcels.length, 1);
  assert.equal(plan.fulfillmentUnits[0].type, "shipping_carton");
  assert.equal(plan.fulfillmentUnits[0].cartonId, "loose_3_5_box_carton");
  assert.equal(plan.fulfillmentUnits[0].retailBoxCount, 5);
  assert.equal(plan.parcelContents[0].contents.length, 5);
  assert.equal(plan.parcels[0].weight, "6.09");
  assert.match(plan.fulfillmentUnits[0].packingInstructions, /stable stacks/i);
});

test("factory-case profiles are never used as empty cartons for loose boxes", () => {
  const plan = buildFulfillmentPackingPlan(
    orderWithItems([
      {
        slug: "nitrile-standard",
        quantities: {},
        boxQuantities: { S: 2, M: 2, L: 2 },
      },
    ]),
  );

  assert.equal(plan.parcels.length, 2);
  assert.deepEqual(
    plan.fulfillmentUnits.map((unit) => [unit.type, unit.cartonId, unit.retailBoxCount]),
    [
      ["shipping_carton", "loose_3_5_box_carton", 5],
      ["shipping_carton", "loose_1_box_carton", 1],
    ],
  );
  assert.equal(plan.fulfillmentUnits.some((unit) => unit.cartonId === "standard_10_box_factory_carton"), false);
});

test("mixed checkout cart rates cartonized fulfillment parcels, not storefront bundle parcels", () => {
  const plan = buildFulfillmentPackingPlan(
    orderWithItems([
      {
        slug: "nitrile-standard",
        quantities: { S: 0, M: 0, L: 0 },
        boxQuantities: { S: 2, M: 2, L: 1 },
      },
      {
        slug: "black-nitrile-general",
        quantities: { M: 0, L: 0 },
        boxQuantities: { M: 2, L: 0 },
      },
      {
        slug: "black-nitrile-heavy-duty",
        quantities: { L: 1, XL: 0 },
        boxQuantities: { L: 0, XL: 0 },
      },
    ]),
  );

  assert.equal(plan.parcels.length, 3);
  assert.deepEqual(
    plan.parcels.map((parcel) => parcel.metadata),
    [
      "black-nitrile-heavy-duty:factory_case:Large",
      "carton:loose_3_5_box_carton:boxes=5",
      "carton:loose_2_box_carton:boxes=2",
    ],
  );
  assert.deepEqual(plan.parcelContents.slice(1).map((parcel) => parcel.retailBoxCount), [5, 2]);
});

test("two heavy duty loose boxes use the configured two-box carton", () => {
  const plan = buildFulfillmentPackingPlan(
    orderWithItems([
      {
        slug: "black-nitrile-heavy-duty",
        quantities: {},
        boxQuantities: { XL: 2 },
      },
    ]),
  );

  assert.equal(plan.parcels.length, 1);
  assert.equal(plan.fulfillmentUnits[0].cartonId, "loose_2_box_carton");
  assert.equal(plan.parcels[0].metadata, "carton:loose_2_box_carton:boxes=2");
  assert.equal(plan.parcels[0].weight, "4.54");
});

test("orders without physical demand fail with a typed error", () => {
  assert.throws(
    () =>
      buildFulfillmentPackingPlan(
        orderWithItems([
          {
            slug: "nitrile-standard",
            quantities: {},
            boxQuantities: {},
          },
        ]),
      ),
    { code: "NO_FULFILLMENT_UNITS" },
  );
});

test("selected packing plan override preserves warehouse contents with Shippo parcels", () => {
  const selected = buildSelectedPackingPlanOverride(
    orderWithItems([
      {
        slug: "nitrile-standard",
        quantities: {},
        boxQuantities: { M: 12 },
      },
    ]),
    { selectedBy: "warehouse", selectedAt: "2026-08-15T00:00:00.000Z" },
  );

  assert.equal(selected.source, "selected_fulfillment_packing_plan");
  assert.equal(selected.selectedBy, "warehouse");
  assert.equal(selected.planId, "standard_factory_case_then_cartonize_loose_v1");
  assert.equal(selected.parcelCount, 2);
  assert.equal(selected.parcels.length, 2);
  assert.equal(selected.fulfillmentUnits[0].source, "normalized_from_loose_boxes");
  assert.equal(selected.parcelContents[1].type, "shipping_carton");
});
