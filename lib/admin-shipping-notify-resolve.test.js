import assert from "node:assert/strict";
import test from "node:test";
import {
  buildBuyerShippingNotifyHtml,
  buildBuyerShippingNotifySubject,
  buildBuyerShippingNotifyText,
} from "./admin-shipping-notify-email.js";
import {
  legacyShippoNotifyProofOk,
  resolveBuyerShippingNotifyFulfillment,
} from "./admin-shipping-notify-resolve.js";

function pkg(patch) {
  return {
    parcel_index: 0,
    parcel_count: 1,
    status: "purchased",
    label_url: "https://example.com/l.pdf",
    tracking_number: "1ZAAA",
    tracking_url: "https://track.example/1ZAAA",
    carrier: "UPS",
    servicelevel_name: "Ground",
    ...patch,
  };
}

test("legacy Shippo proof requires URL + SUCCESS + tracking", () => {
  assert.equal(
    legacyShippoNotifyProofOk({
      shippo_label_url: "https://l",
      shippo_transaction_status: "SUCCESS",
      shippo_tracking_number: "1Z",
    }),
    true,
  );
  assert.equal(
    legacyShippoNotifyProofOk({
      shippo_label_url: "https://l",
      shippo_transaction_status: "SUCCESS",
      shippo_tracking_number: "",
    }),
    false,
  );
});

test("legacy Shippo + tracking resolves", () => {
  const r = resolveBuyerShippingNotifyFulfillment(
    {
      shippo_label_url: "https://l",
      shippo_transaction_status: "SUCCESS",
      shippo_tracking_number: "1ZLEGACY",
      shippo_tracking_url_provider: "https://track/1ZLEGACY",
      shippo_label_carrier: "USPS",
      shippo_label_service: "Priority",
    },
    [],
  );
  assert.equal(r.ok, true);
  assert.equal(r.source, "legacy_shippo");
  assert.equal(r.trackings.length, 1);
  assert.equal(r.trackings[0].number, "1ZLEGACY");
});

test("complete package-label row resolves", () => {
  const r = resolveBuyerShippingNotifyFulfillment({ order_status: "label_purchased" }, [pkg()]);
  assert.equal(r.ok, true);
  assert.equal(r.source, "package_labels");
});

test("multi-package complete rows list each tracking", () => {
  const r = resolveBuyerShippingNotifyFulfillment({ order_status: "label_purchased" }, [
    pkg({ parcel_index: 0, parcel_count: 2, tracking_number: "A" }),
    pkg({ parcel_index: 1, parcel_count: 2, tracking_number: "B", tracking_url: "https://t/B" }),
  ]);
  assert.equal(r.ok, true);
  assert.equal(r.trackings.length, 2);
});

test("partial package labels fail", () => {
  const r = resolveBuyerShippingNotifyFulfillment({ order_status: "partial_label_purchase" }, [
    pkg({ parcel_index: 0, parcel_count: 2 }),
    pkg({ parcel_index: 1, parcel_count: 2, status: "failed", tracking_number: "", label_url: "" }),
  ]);
  assert.equal(r.ok, false);
});

test("complete external record resolves with multiple tracking lines", () => {
  const r = resolveBuyerShippingNotifyFulfillment(
    {
      admin_external_carrier: "UPS",
      admin_external_service: "Ground",
      admin_external_tracking_number: "EXT1\nEXT2",
      admin_external_label_storage_path: "orders/1/label.pdf",
    },
    [],
  );
  assert.equal(r.ok, true);
  assert.equal(r.source, "external");
  assert.equal(r.trackings.length, 2);
});

test("email subject uses order ref", () => {
  assert.equal(
    buildBuyerShippingNotifySubject({ order_ref: "SAI-ABC123" }),
    "Your SAI Goods order is on the way — SAI-ABC123",
  );
});

test("one tracking number renders tracking card and Track button when URL exists", () => {
  const html = buildBuyerShippingNotifyHtml(
    { order_ref: "SAI-TEST", customer_name: "Nathan Sai", created_at: "2026-07-01T12:00:00.000Z" },
    {
      sourceLabel: "Shippo",
      carrier: "UPS",
      service: "Ground",
      trackings: [{ number: "1ZONLY", url: "https://track.example/1ZONLY" }],
    },
  );
  assert.match(html, /Tracking/);
  assert.match(html, /1ZONLY/);
  assert.match(html, /Track package/);
  assert.match(html, /https:\/\/track\.example\/1ZONLY/);
  assert.match(html, /Your order is on the way/);
  assert.match(html, /SHIPPING UPDATE/i);
  assert.match(html, /preheader|Tracking information is now available/i);
  assert.doesNotMatch(html, /has shipped/i);
});

test("tracking URL button omitted when URL missing", () => {
  const html = buildBuyerShippingNotifyHtml(
    { order_ref: "SAI-TEST", customer_name: "Nathan" },
    {
      sourceLabel: "External",
      carrier: "USPS",
      trackings: [{ number: "9400NOURL" }],
    },
  );
  assert.match(html, /9400NOURL/);
  assert.doesNotMatch(html, /Track package/);
});

test("multiple tracking numbers render package list", () => {
  const html = buildBuyerShippingNotifyHtml(
    { order_ref: "SAI-MULTI", customer_name: "Alex" },
    {
      sourceLabel: "Package labels",
      trackings: [
        { number: "A", packageLabel: "Package 1 of 2", carrier: "UPS" },
        { number: "B", url: "https://t/B", packageLabel: "Package 2 of 2", carrier: "UPS" },
      ],
    },
  );
  assert.match(html, /Packages/);
  assert.match(html, /Package 1 of 2/);
  assert.match(html, /Package 2 of 2/);
  assert.match(html, /Track package/);
});

test("plain-text fallback includes tracking details", () => {
  const text = buildBuyerShippingNotifyText(
    { order_ref: "SAI-TXT", customer_name: "Jordan Lee" },
    {
      sourceLabel: "Shippo",
      carrier: "UPS",
      trackings: [
        { number: "T1", url: "https://t/1" },
        { number: "T2", packageLabel: "Package 2 of 2" },
      ],
    },
  );
  assert.match(text, /Hi Jordan/);
  assert.match(text, /SAI-TXT/);
  assert.match(text, /T1/);
  assert.match(text, /https:\/\/t\/1/);
  assert.match(text, /T2/);
  assert.match(text, /Thank you for shopping with SAI Goods/);
});
