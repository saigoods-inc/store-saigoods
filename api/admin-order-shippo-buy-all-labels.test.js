import assert from "node:assert/strict";
import test from "node:test";
import {
  multiLabelOrderSummaryPatch,
  selectedStoredRateMeta,
} from "./admin-order-shippo-buy-all-labels.js";

test("selected aggregate rate retains the exact rate and shipment for every package", () => {
  const order = {
    shippo_shipment_rates_json: {
      rates: [
        {
          object_id: "package-set:ups:ground_saver:2",
          provider: "UPS",
          servicelevel_name: "Ground Saver",
          servicelevel_token: "ups_ground_saver",
          package_rate_object_ids: ["rate-package-1", "rate-package-2"],
        },
      ],
      packageShipments: [
        { package: 2, shipmentId: "shipment-package-2" },
        { package: 1, shipmentId: "shipment-package-1" },
      ],
    },
  };

  const selected = selectedStoredRateMeta(order, "package-set:ups:ground_saver:2");

  assert.deepEqual(selected.packageRateObjectIds, ["rate-package-1", "rate-package-2"]);
  assert.deepEqual(selected.packageShipmentObjectIds, ["shipment-package-1", "shipment-package-2"]);
});

test("partial package purchase cannot publish legacy complete-label evidence", () => {
  const patch = multiLabelOrderSummaryPatch({
    selectedRateObjectId: "package-set:ups:ground_saver:2",
    desiredRate: { provider: "UPS", servicelevelName: "Ground Saver" },
    purchasedMeta: {
      carrier: "UPS",
      servicelevel_name: "Ground Saver",
      tracking_number: "tracking-1",
      label_url: "https://example.test/label-1.pdf",
    },
    complete: false,
    failedCount: 1,
  });

  assert.equal(patch.shippo_transaction_status, "PARTIAL");
  assert.equal(patch.shippo_tracking_number, null);
  assert.equal(patch.shippo_label_url, null);
  assert.equal(patch.shippo_label_purchased_at, null);
  assert.equal(patch.shippo_label_sync_error, "1 package label failed.");
});

test("complete package purchase publishes the order-level label summary", () => {
  const patch = multiLabelOrderSummaryPatch({
    selectedRateObjectId: "package-set:ups:ground_saver:2",
    desiredRate: { provider: "UPS", servicelevelName: "Ground Saver" },
    purchasedMeta: {
      carrier: "UPS",
      servicelevel_name: "Ground Saver",
      tracking_number: "tracking-1",
      label_url: "https://example.test/label-1.pdf",
    },
    complete: true,
    failedCount: 0,
  });

  assert.equal(patch.shippo_transaction_status, "SUCCESS");
  assert.equal(patch.shippo_tracking_number, "tracking-1");
  assert.equal(patch.shippo_label_url, "https://example.test/label-1.pdf");
  assert.equal(patch.shippo_label_sync_error, null);
});
