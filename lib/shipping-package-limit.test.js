import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { buildCheckoutPayPackageLimitBody } from "../api/checkout-pay.js";
import {
  MAX_ONLINE_SHIPPING_PACKAGES,
  MAX_CONFIGURABLE_ONLINE_SHIPPING_PACKAGES,
  MIN_CONFIGURABLE_ONLINE_SHIPPING_PACKAGES,
  SHIPPING_PACKAGE_LIMIT_CONTACT_EMAIL,
  normalizeShippingPackageLimitConfig,
  resolveOnlineShippingPackagePlan,
  shippingPackageLimitState,
} from "./shipping-package-limit.js";

test("online shipping package limit allows 10 and blocks 11", () => {
  const ten = shippingPackageLimitState({ parcels: Array.from({ length: 10 }, () => ({})) });
  const eleven = shippingPackageLimitState({ parcels: Array.from({ length: 11 }, () => ({})) });

  assert.equal(MAX_ONLINE_SHIPPING_PACKAGES, 10);
  assert.equal(ten.exceeded, false);
  assert.equal(ten.message, null);
  assert.equal(eleven.exceeded, true);
  assert.equal(eleven.packageCount, 11);
  assert.equal(eleven.contactEmail, SHIPPING_PACKAGE_LIMIT_CONTACT_EMAIL);
  assert.match(eleven.message, /limited to 10 shipping packages/i);
});

test("configured limit changes the allow/block boundary and customer message", () => {
  const twelve = shippingPackageLimitState({ parcelCount: 12 }, 12);
  const thirteen = shippingPackageLimitState({ parcelCount: 13 }, 12);

  assert.equal(twelve.exceeded, false);
  assert.equal(twelve.maxPackages, 12);
  assert.equal(thirteen.exceeded, true);
  assert.equal(thirteen.maxPackages, 12);
  assert.match(thirteen.message, /limited to 12 shipping packages/i);
});

test("package-limit config accepts only the supported safe range", () => {
  assert.equal(normalizeShippingPackageLimitConfig({ maxPackages: 14 }).maxPackages, 14);
  assert.equal(
    normalizeShippingPackageLimitConfig({ maxPackages: MIN_CONFIGURABLE_ONLINE_SHIPPING_PACKAGES }).maxPackages,
    MIN_CONFIGURABLE_ONLINE_SHIPPING_PACKAGES,
  );
  assert.equal(
    normalizeShippingPackageLimitConfig({ maxPackages: MAX_CONFIGURABLE_ONLINE_SHIPPING_PACKAGES }).maxPackages,
    MAX_CONFIGURABLE_ONLINE_SHIPPING_PACKAGES,
  );
  assert.equal(normalizeShippingPackageLimitConfig({ maxPackages: 0 }).maxPackages, MAX_ONLINE_SHIPPING_PACKAGES);
  assert.equal(normalizeShippingPackageLimitConfig({ maxPackages: 26 }).maxPackages, MAX_ONLINE_SHIPPING_PACKAGES);
});

test("limit uses the resolved runtime packaging plan rather than storefront quantity", async () => {
  const resolved = await resolveOnlineShippingPackagePlan([
    { slug: "nitrile-standard", quantities: { M: 11 }, boxQuantities: {} },
  ]);

  assert.equal(resolved.parcelSummary.parcelCount, 11);
  assert.equal(resolved.limit.exceeded, true);
});

test("nine factory cartons plus six loose boxes resolve to eleven packages and are blocked", async () => {
  const resolved = await resolveOnlineShippingPackagePlan([
    {
      slug: "nitrile-standard",
      quantities: { S: 3, M: 3, L: 3 },
      boxQuantities: { S: 2, M: 2, L: 2 },
    },
  ]);

  assert.equal(resolved.parcelSummary.parcelCount, 11);
  assert.equal(resolved.limit.packageCount, 11);
  assert.equal(resolved.limit.exceeded, true);
  assert.deepEqual(
    resolved.parcelSummary.parcelContents.slice(-2).map((parcel) => [parcel.cartonId, parcel.retailBoxCount]),
    [
      ["loose_3_5_box_carton", 5],
      ["loose_1_box_carton", 1],
    ],
  );
});

test("the package limit includes compatible loose boxes from other cart items", async () => {
  const resolved = await resolveOnlineShippingPackagePlan([
    {
      slug: "nitrile-standard",
      quantities: { S: 3, M: 3, L: 3 },
      boxQuantities: { S: 2, M: 2, L: 1 },
    },
    {
      slug: "black-nitrile-general",
      quantities: {},
      boxQuantities: { M: 1 },
    },
  ]);

  assert.equal(resolved.parcelSummary.parcelCount, 11);
  assert.equal(resolved.limit.exceeded, true);
});

test("checkout payment rejects an oversized signed quote before order or payment creation", () => {
  const body = buildCheckoutPayPackageLimitBody({
    canCheckout: true,
    parcelSummary: { parcelCount: 11 },
  });

  assert.equal(body?.canCheckout, false);
  assert.equal(body?.shippingPackageLimit?.packageCount, 11);
  assert.match(body?.error || "", /limited to 10 shipping packages/i);

  const source = readFileSync(new URL("../api/checkout-pay.js", import.meta.url), "utf8");
  const packageGateIndex = source.indexOf("const packageLimitBody = buildCheckoutPayPackageLimitBody(");
  const pendingOrderIndex = source.indexOf("pending = await createPendingOrder");
  const paymentIndex = source.indexOf("await createCardPayment");
  assert.ok(packageGateIndex > 0);
  assert.ok(pendingOrderIndex > packageGateIndex);
  assert.ok(paymentIndex > packageGateIndex);
});

test("checkout payment uses the configured package limit", () => {
  const allowed = buildCheckoutPayPackageLimitBody({ parcelSummary: { parcelCount: 12 } }, 12);
  const blocked = buildCheckoutPayPackageLimitBody({ parcelSummary: { parcelCount: 13 } }, 12);

  assert.equal(allowed, null);
  assert.equal(blocked?.shippingPackageLimit?.maxPackages, 12);
  assert.match(blocked?.error || "", /limited to 12 shipping packages/i);
});

test("public package limit runs before Shippo rating while admin rating remains available", () => {
  const quoteSource = readFileSync(new URL("./live-shipping-quote.js", import.meta.url), "utf8");
  const limitIndex = quoteSource.indexOf('requestedFlow === "checkout" && packageLimit.exceeded');
  const rateIndex = quoteSource.indexOf("rated = await getShippingRateQuote");
  assert.ok(limitIndex > 0);
  assert.ok(rateIndex > limitIndex);

  const cartSource = readFileSync(new URL("../api/cart-quote.js", import.meta.url), "utf8");
  const cartLimitIndex = cartSource.indexOf("if (limit.exceeded)");
  const stockIndex = cartSource.indexOf("await assertStockAvailableForItems(items)");
  assert.ok(cartLimitIndex > 0);
  assert.ok(stockIndex > cartLimitIndex);

  const productSource = readFileSync(new URL("../public/js/product.js", import.meta.url), "utf8");
  const cartPageSource = readFileSync(new URL("../public/js/cart.js", import.meta.url), "utf8");
  assert.match(productSource, /quote\.shippingPackageLimit\.message/);
  assert.match(cartPageSource, /quote\?\.shippingPackageLimit\?\.message/);
  assert.doesNotMatch(productSource, /limited to 10 shipping packages/i);
  assert.doesNotMatch(cartPageSource, /limited to 10 shipping packages/i);
});
