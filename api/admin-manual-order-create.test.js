import assert from "node:assert/strict";
import test from "node:test";

import { prepareManualOrderItems } from "./admin-manual-order-create.js";

test("manual order creation primes exact dynamic bundle selections", async () => {
  const items = [{ slug: "nitrile-standard", bundleLines: [{ id: "5_boxes", qty: 1 }] }];
  let received = null;

  await prepareManualOrderItems(items, async (candidateItems) => {
    received = candidateItems;
  });

  assert.equal(received, items);
  assert.equal(received[0].bundleLines[0].id, "5_boxes");
});
