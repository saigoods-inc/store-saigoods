import assert from "node:assert/strict";
import test from "node:test";
import { packageRateStatePatch } from "./admin-order-shippo-sync.js";

test("failed package refresh preserves the last usable rate set", () => {
  const previous = {
    rates: [{ object_id: "package-set:ups:ground:2" }],
    rateCount: 1,
    labelRateMode: "per_package_sum",
  };
  const patch = packageRateStatePatch(
    {
      rateSet: [],
      shipments: [{ package: 1, shipmentId: "failed-shipment" }],
      error: "Shippo returned no label rates for package 1.",
    },
    previous,
  );

  assert.equal("shippo_shipment_rates_json" in patch, false);
  assert.equal(patch.shippo_shipment_rate_status, "refresh_failed");
  assert.match(patch.shippo_shipment_sync_error, /package 1/);
});

test("successful package refresh replaces rates and clears the old error", () => {
  const rates = [{ object_id: "package-set:ups:ground:2" }];
  const patch = packageRateStatePatch(
    {
      rateSet: rates,
      shipments: [{ package: 1, shipmentId: "shipment-1" }],
      error: null,
    },
    { rates: [{ object_id: "old-rate" }] },
  );

  assert.deepEqual(patch.shippo_shipment_rates_json.rates, rates);
  assert.equal(patch.shippo_shipment_rate_status, "rates_available");
  assert.equal(patch.shippo_shipment_sync_error, null);
});
