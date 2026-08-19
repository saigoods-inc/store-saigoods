import test from "node:test";
import assert from "node:assert/strict";

import packaging from "../data/fulfillment-packaging.json" with { type: "json" };
import { assertCartonCapacityIsPhysical, axisAlignedBoxCapacity, configuredCartonCapacity } from "./packaging-fit.js";

test("all configured cartons physically fit their declared retail-box capacity", () => {
  for (const carton of packaging.shippingCartons) {
    assert.doesNotThrow(() => assertCartonCapacityIsPhysical(carton), carton.id);
    assert.ok(configuredCartonCapacity(carton) >= Number(carton.maxRetailBoxes), carton.id);
  }
});

test("loose cartons fit the largest heavy-duty retail box at safe configured capacities", () => {
  const largest = packaging.products["black-nitrile-heavy-duty"].sizes.Large.retailUnit;
  const loose = packaging.shippingCartons.filter((carton) => carton.packageType === "corrugated_carton");
  assert.deepEqual(
    loose.map((carton) => axisAlignedBoxCapacity(carton.inner, largest)),
    [1, 2, 6],
  );
  assert.deepEqual(loose.map((carton) => Number(carton.maxRetailBoxes)), [1, 2, 5]);
});

test("capacity validation rejects a carton count larger than its inner dimensions", () => {
  assert.throws(
    () => assertCartonCapacityIsPhysical({ id: "bad", inner: { length: 10, width: 6, height: 4 }, maxRetailBox: { length: 9.45, width: 5.12, height: 3.15 }, maxRetailBoxes: 2 }),
    /fit at most 1/,
  );
});
