import assert from "node:assert/strict";
import test from "node:test";

import { calculateStockAfterDemand } from "./inventory-service.js";

test("box sales use loose boxes first and open the minimum cartons", () => {
  assert.deepEqual(
    calculateStockAfterDemand({ casesOnHand: 193, looseBoxesOnHand: 1, boxesPerCase: 10, requestedBoxes: 2 }),
    {
      ok: true,
      casesOnHand: 193,
      looseBoxesOnHand: 1,
      boxesPerCase: 10,
      requestedCases: 0,
      requestedBoxes: 2,
      nextCases: 192,
      nextBoxes: 9,
      casesDelta: -1,
      boxesDelta: 8,
    },
  );
});

test("mixed carton and box demand preserves intact-carton semantics", () => {
  const result = calculateStockAfterDemand({ casesOnHand: 2, looseBoxesOnHand: 7, boxesPerCase: 10, requestedCases: 1, requestedBoxes: 8 });
  assert.equal(result.ok, true);
  assert.equal(result.nextCases, 0);
  assert.equal(result.nextBoxes, 9);
});

test("loose boxes are not silently repacked to satisfy carton demand", () => {
  const result = calculateStockAfterDemand({ casesOnHand: 0, looseBoxesOnHand: 10, boxesPerCase: 10, requestedCases: 1 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "intact_cases");
  assert.equal(result.available, 0);
});

test("box demand rejects only after all convertible cartons and loose boxes are exhausted", () => {
  const result = calculateStockAfterDemand({ casesOnHand: 1, looseBoxesOnHand: 1, boxesPerCase: 10, requestedBoxes: 12 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "boxes_equivalent");
  assert.equal(result.available, 11);
});
