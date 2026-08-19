import assert from "node:assert/strict";
import test from "node:test";

import { findStoredRateMeta } from "./admin-order-shippo-purchase-label.js";

test("single-label purchase resolves the exact current rate selected by admin", () => {
  const order = {
    shippo_shipment_rates_json: {
      rates: [
        { object_id: "ground-saver", provider: "UPS", amount: "6.27" },
        { object_id: "next-day-air", provider: "UPS", amount: "31.23" },
      ],
    },
  };

  assert.equal(findStoredRateMeta(order, "next-day-air")?.amount, "31.23");
  assert.equal(findStoredRateMeta(order, "missing-rate"), null);
});
