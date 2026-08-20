import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  selectCheckoutShippingChoices,
  shippingSelectionStillValid,
} from "./checkout-shipping-options.js";

const checkoutSource = readFileSync(new URL("../public/js/checkout.js", import.meta.url), "utf8");
const cartSource = readFileSync(new URL("../public/js/cart.js", import.meta.url), "utf8");
const storefrontStyles = readFileSync(new URL("../public/css/styles.css", import.meta.url), "utf8");

const rate = (id, amountCents, estimatedDays, serviceCode = id) => ({
  id,
  provider: "UPS",
  serviceCode,
  serviceLabel: serviceCode,
  amountCents,
  totalAmountCents: amountCents,
  estimatedDays,
  currency: "USD",
});

test("checkout exposes the cheapest and fastest valid whole-order services", () => {
  const choices = selectCheckoutShippingChoices([
    rate("ground", 900, 5),
    rate("air", 1800, 1),
    rate("middle", 1200, 3),
  ]);
  assert.deepEqual(choices.map((choice) => choice.id), ["ground", "air"]);
  assert.deepEqual(choices.map((choice) => choice.choiceRoles), [["cheapest"], ["fastest"]]);
});

test("checkout shows one service when it is both cheapest and fastest", () => {
  const choices = selectCheckoutShippingChoices([
    rate("winner", 900, 1),
    rate("other", 1200, 3),
  ]);
  assert.equal(choices.length, 1);
  assert.deepEqual(choices[0].choiceRoles, ["cheapest", "fastest"]);
});

test("refreshed service requires reconfirmation when price or delivery changes", () => {
  assert.equal(shippingSelectionStillValid(rate("old", 900, 3, "ground"), rate("new", 900, 3, "ground")), true);
  assert.equal(shippingSelectionStillValid(rate("old", 900, 3, "ground"), rate("new", 901, 3, "ground")), false);
  assert.equal(shippingSelectionStillValid(rate("old", 900, 3, "ground"), rate("new", 900, 4, "ground")), false);
});

test("checkout disables confirmed address button until address or discount changes", () => {
  assert.match(checkoutSource, /btn\.disabled = estimateLoading \|\| !confirmAddressNeedsRefresh;/);
  assert.match(
    checkoutSource,
    /data\.shippingRateOptions\.length > 0[\s\S]*confirmAddressNeedsRefresh = false;/,
  );
  assert.match(
    checkoutSource,
    /function markEstimateStale\(\)[\s\S]*confirmAddressNeedsRefresh = true;[\s\S]*syncConfirmAddressButtonState\(\);/,
  );
});

test("checkout keeps the confirm action available after a quote failure", () => {
  assert.match(
    checkoutSource,
    /catch \(e\) \{[\s\S]*estimateStale = true;\s*confirmAddressNeedsRefresh = true;/,
  );
});

test("checkout places discount confirmation before concise shipping services", () => {
  const discountIndex = checkoutSource.indexOf('class="checkout-discount-block"');
  const shippingIndex = checkoutSource.indexOf('id="checkout-shipping-rates"');
  assert.ok(discountIndex > 0 && shippingIndex > discountIndex);
  assert.match(checkoutSource, /id="checkout-shipping-rates-hint"[\s\S]*Select one service to continue\.<\/p>/);
  assert.doesNotMatch(checkoutSource, /Rates are held for five minutes|Rate expires five minutes after confirmation/);
  assert.doesNotMatch(checkoutSource, /checkout-shipping-rate-expiry/);
});

test("checkout selects the cheapest shipping service by default", () => {
  assert.match(
    checkoutSource,
    /function cheapestShippingRate\(rates\)[\s\S]*choiceRoles\.includes\("cheapest"\)[\s\S]*totalAmountCents \?\? a\?\.amountCents/,
  );
  assert.match(
    checkoutSource,
    /const defaultRate = preserved \|\| automaticLocalRate \|\| cheapestShippingRate\(rates\);/,
  );
  assert.match(
    checkoutSource,
    /defaultRate && String\(defaultRate\.id\) === id \? "checked" : ""/,
  );
  assert.match(checkoutSource, /updateShippingRateHint\(hint, selectedShippingRate\);/);
  assert.match(checkoutSource, /updateShippingRateHint\(hint, defaultRate\);/);
  assert.match(checkoutSource, /if \(defaultRate\) applySelectedShippingRate\(defaultRate\);/);
});

test("checkout preserves an equivalent shopper selection before applying its default", () => {
  const preservedIndex = checkoutSource.indexOf("const preserved = previousSelection");
  const defaultIndex = checkoutSource.indexOf(
    "const defaultRate = preserved || automaticLocalRate || cheapestShippingRate(rates);",
  );
  assert.ok(preservedIndex > 0 && defaultIndex > preservedIndex);
  assert.match(checkoutSource, /shippingRateEquivalent\(previousSelection, rate\)/);
});

test("checkout hides carrier implementation details for free local delivery", () => {
  assert.match(
    checkoutSource,
    /const isLocalDelivery =[\s\S]*?const meta = isLocalDelivery\s*\? ""/,
  );
  assert.match(
    checkoutSource,
    /String\(rate\.serviceCode \|\| rate\.service_code \|\| ""\)[\s\S]*?=== "local_delivery"/,
  );
  assert.match(checkoutSource, /w\.unshift\("Your order qualifies for free local delivery\."\)/);
  assert.doesNotMatch(checkoutSource, /w\.unshift\(data\.freeDelivery\.message\);\s*\n\s*\} else if/);
});

test("checkout gives the normalized address suggestion a subtle yellow accessible treatment", () => {
  assert.match(
    checkoutSource,
    /id="checkout-address-suggestion"[\s\S]*role="region"[\s\S]*aria-labelledby="checkout-address-suggestion-title"/,
  );
  assert.match(
    checkoutSource,
    /class="button button--secondary checkout-address-suggestion__apply"/,
  );
  assert.match(
    storefrontStyles,
    /\.checkout-address-suggestion\s*\{[^}]*border: 1px solid #f0dfa3;[^}]*background: #fff8dc;/,
  );
  assert.doesNotMatch(storefrontStyles, /\.checkout-address-suggestion\s*\{[^}]*box-shadow:/);
});

test("storefront removes internal shipping-unit count and aligns the state control", () => {
  assert.doesNotMatch(cartSource, />Shipping units</);
  assert.match(
    storefrontStyles,
    /\.checkout-state-select__trigger\s*\{[\s\S]*?min-height:\s*0;/,
  );
});
