import assert from "node:assert/strict";
import test from "node:test";
import { expandOrderLineToLogical } from "./shippo-order-parcels.js";

const product = { slug: "dynamic-product", supportedSizes: ["M", "L"], bundles: [
  { id: "5_boxes", kind: "box", units: 5, priceCents: 4495, active: true },
  { id: "3_cartons", kind: "case", units: 3, priceCents: 20000, active: true },
] };

test("admin-defined five-box bundle expands without a hardcoded id", () => {
  const parcels = expandOrderLineToLogical({ bundleLines: [{ id: "5_boxes", qty: 1 }], boxQuantities: { M: 2, L: 3 } }, product);
  assert.equal(parcels.length, 1);
  assert.equal(parcels[0].physicalPack, "box_5");
  assert.deepEqual(parcels[0].sizeMix, ["M", "M", "L", "L", "L"]);
});
test("admin-defined multi-carton bundle expands per unit", () => {
  const parcels = expandOrderLineToLogical({ bundleLines: [{ id: "3_cartons", qty: 1 }], quantities: { M: 1, L: 2 } }, product);
  assert.equal(parcels.length, 3);
  assert.deepEqual(parcels.map((parcel) => parcel.packageCount), [3, 3, 3]);
});
