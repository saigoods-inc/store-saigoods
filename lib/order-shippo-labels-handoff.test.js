import assert from "node:assert/strict";
import test from "node:test";
import {
  expectedShippoPackageCount,
  isCompletePurchasedShippoLabelRow,
  isPurchasedShippoLabelStatus,
  orderShippoPackageLabelsComplete,
} from "./order-shippo-labels.js";

function row(patch) {
  return {
    parcel_index: 0,
    parcel_count: 1,
    status: "purchased",
    label_url: "https://example.com/label.pdf",
    tracking_number: "1Z999",
    carrier: "UPS",
    ...patch,
  };
}

test("isPurchasedShippoLabelStatus accepts purchased/success/successful case-insensitively", () => {
  assert.equal(isPurchasedShippoLabelStatus("purchased"), true);
  assert.equal(isPurchasedShippoLabelStatus("SUCCESS"), true);
  assert.equal(isPurchasedShippoLabelStatus("Successful"), true);
  assert.equal(isPurchasedShippoLabelStatus("failed"), false);
  assert.equal(isPurchasedShippoLabelStatus("processing"), false);
});

test("isCompletePurchasedShippoLabelRow requires status + label_url + tracking", () => {
  assert.equal(isCompletePurchasedShippoLabelRow(row()), true);
  assert.equal(isCompletePurchasedShippoLabelRow(row({ carrier: null, servicelevel_name: null })), true);
  assert.equal(isCompletePurchasedShippoLabelRow(row({ tracking_number: "" })), false);
  assert.equal(isCompletePurchasedShippoLabelRow(row({ label_url: "  " })), false);
  assert.equal(isCompletePurchasedShippoLabelRow(row({ status: "failed" })), false);
});

test("single complete package row is enough", () => {
  assert.equal(orderShippoPackageLabelsComplete([row()]), true);
  assert.equal(orderShippoPackageLabelsComplete([row({ status: "SUCCESS" })]), true);
});

test("incomplete single package row is rejected", () => {
  assert.equal(orderShippoPackageLabelsComplete([row({ tracking_number: "" })]), false);
  assert.equal(orderShippoPackageLabelsComplete([row({ label_url: null })]), false);
  assert.equal(orderShippoPackageLabelsComplete([]), false);
});

test("multi-package requires every index complete", () => {
  const a = row({ parcel_index: 0, parcel_count: 2, tracking_number: "A" });
  const b = row({ parcel_index: 1, parcel_count: 2, tracking_number: "B" });
  assert.equal(expectedShippoPackageCount([a, b]), 2);
  assert.equal(orderShippoPackageLabelsComplete([a, b]), true);
  assert.equal(orderShippoPackageLabelsComplete([a]), false);
  assert.equal(
    orderShippoPackageLabelsComplete([a, row({ parcel_index: 1, parcel_count: 2, tracking_number: "" })]),
    false,
  );
});

test("partial_label_purchase order status is always rejected", () => {
  const a = row({ parcel_index: 0, parcel_count: 2 });
  const b = row({ parcel_index: 1, parcel_count: 2 });
  assert.equal(orderShippoPackageLabelsComplete([a, b], { orderStatus: "partial_label_purchase" }), false);
  assert.equal(orderShippoPackageLabelsComplete([a, b], { orderStatus: "label_purchased" }), true);
});
