import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { CHECKOUT_DRAFT_FIELDS, checkoutDiscountSuccess, clearCheckoutDraft, isCheckoutDiscountApiError, readCheckoutDraft, saveCheckoutDraft } from "./checkout-discount-state.js";

test("qualifying code identifies savings without repeating the carton condition", () => {
  assert.deepEqual(checkoutDiscountSuccess({ code: "FRIYAY999", percentOff: 10, minCartons: 5, cartonCount: 5 }), {
    message: "FRIYAY999 applied — 10% off.",
    summaryLabel: "FRIYAY999 • 10% Off",
  });
  assert.equal(checkoutDiscountSuccess({ code: "PSD398O", percentOff: 5, minCartons: 1, cartonCount: 2 }).message,
    "PSD398O applied — 5% off.");
});

test("existing codes with no minimum retain a simple confirmation", () => {
  assert.equal(checkoutDiscountSuccess({ code: "WELCOME", percentOff: 7, minCartons: 0, cartonCount: 0 }).message,
    "WELCOME applied — 7% off.");
});

test("missing or inconsistent server details cannot show successful redemption", () => {
  for (const details of [null, {}, { code: "X", percentOff: 10 },
    { code: "X", percentOff: 10, minCartons: 5, cartonCount: 3 },
    { code: "X", percentOff: 101, minCartons: 0, cartonCount: 1 }]) {
    assert.equal(checkoutDiscountSuccess(details), null);
  }
});

test("minimum-carton API errors route to discount feedback even when wording changes", () => {
  assert.equal(isCheckoutDiscountApiError("Please add 2 cartons.", { errorCode: "DISCOUNT_MIN_CARTONS" }), true);
});

test("existing invalid, used, concurrent redemption, and stacking errors stay in discount feedback", () => {
  for (const message of ["That discount code is not valid.", "This discount code has already been used.",
    "This discount code was just used by another order. Try another code.",
    "This automatic volume price cannot be combined with another discount.",
    "Custom selling prices cannot be combined with another discount."]) {
    assert.equal(isCheckoutDiscountApiError(message), true, message);
  }
  assert.equal(isCheckoutDiscountApiError("Shipping provider unavailable."), false);
  assert.equal(isCheckoutDiscountApiError(""), false);
});

test("checkout draft preserves entered customer fields and code but never payment data", () => {
  const values = new Map();
  const storage = { getItem: (key) => values.get(key), setItem: (key, value) => values.set(key, value) };
  saveCheckoutDraft(storage, { name: "Shopper", line1: "12 Test St", discountCode: "FRIYAY999", cardNumber: "excluded", sourceId: "excluded", checkoutQuoteToken: "excluded" });
  assert.deepEqual(readCheckoutDraft(storage), { name: "Shopper", line1: "12 Test St", discountCode: "FRIYAY999" });
  assert.equal([...values.values()][0].includes("excluded"), false);
  saveCheckoutDraft(storage, { name: "Shopper", line1: "12 Test St", discountCode: "" });
  assert.equal(readCheckoutDraft(storage).discountCode, "");
});

test("unavailable browser storage does not block checkout", () => {
  const storage = { getItem() { throw new Error("disabled"); }, setItem() { throw new Error("disabled"); } };
  assert.deepEqual(readCheckoutDraft(storage), {});
  assert.doesNotThrow(() => saveCheckoutDraft(storage, { name: "Shopper" }));
});

function checkoutHarness(response) {
  const elements = new Map();
  function element(key) {
    if (elements.has(key)) return elements.get(key);
    const attributes = new Map();
    const listeners = new Map();
    const node = {
      value: "", textContent: "", innerHTML: "", hidden: true, disabled: false, listeners,
      classList: { remove() {}, add() {}, toggle() {}, contains() { return false; } },
      setAttribute: (name, value) => attributes.set(name, value),
      removeAttribute: (name) => attributes.delete(name),
      getAttribute: (name) => attributes.get(name),
      addEventListener: (name, handler) => listeners.set(name, handler),
      querySelectorAll: () => [], focus() {},
    };
    elements.set(key, node);
    return node;
  }
  const fields = { name: "Shopper", email: "shopper@example.com", phone: "5555551212", line1: "12 Test St", line2: "", city: "Austin", state: "TX", postalCode: "78701", discountCode: "FRIYAY999" };
  for (const [name, value] of Object.entries(fields)) element(name).value = value;
  const root = { querySelector: (selector) => {
    const match = selector.match(/^\[name="([^"]+)"\]$/);
    return match ? element(match[1]) : null;
  }, querySelectorAll: () => [], addEventListener() {} };
  const storage = new Map();
  const sandbox = {
    document: { querySelector: () => root, getElementById: element, addEventListener() {} },
    sessionStorage: { setItem: (key, value) => storage.set(key, value), getItem: (key) => storage.get(key), removeItem: (key) => storage.delete(key) },
    checkoutDiscountSuccess, isCheckoutDiscountApiError, CHECKOUT_DRAFT_FIELDS, readCheckoutDraft, saveCheckoutDraft, clearCheckoutDraft,
    setCheckoutSummaryValue: (node, value) => { node.textContent = value; },
    escapeHtml: (value) => String(value),
    formatCartUnitLabel: () => "5 cartons",
    formatSizeLineText: () => "M: 5",
    fetch: async () => response,
    setTimeout, clearTimeout,
  };
  const source = fs.readFileSync(new URL("./checkout.js", import.meta.url), "utf8").replace(/^import .*;\n/gm, "");
  vm.runInNewContext(`${source}\nstore = { site: { sizes: [] } };\nglobalThis.checkoutTestApi = { runEstimate, wireEvents, markEstimateStale };`, sandbox);
  return { ...sandbox.checkoutTestApi, element };
}

function successfulQuote() {
  return {
    items: [{ name: "Test gloves", quantities: { M: 5 }, lineTotalFormatted: "$314.95", originalLineTotalFormatted: "$349.95" }],
    subtotalCents: 31495, subtotalFormatted: "$314.95", originalMerchandiseSubtotalFormatted: "$349.95",
    merchandiseDiscountCents: 3500, merchandiseDiscountFormatted: "$35.00", taxFormatted: "$0.00", totalFormatted: "$314.95",
    discountCodeDetails: { code: "FRIYAY999", percentOff: 10, minCartons: 5, cartonCount: 5 },
    shippingRateOptions: [{ id: "local", provider: "local", serviceCode: "local_delivery", serviceLabel: "Free local delivery", amountCents: 0 }],
  };
}

test("checkout displays a confirmed code and remove clears savings without losing customer details", async () => {
  const ui = checkoutHarness({ ok: true, json: async () => successfulQuote() });
  await ui.runEstimate({ requireAddress: true });
  assert.equal(ui.element("checkout-discount-success").hidden, false);
  assert.equal(ui.element("checkout-discount-success").textContent, "FRIYAY999 applied — 10% off.");
  assert.equal(ui.element("checkout-discount-label").textContent, "Discount Applied");
  assert.equal(ui.element("checkout-discount-details").textContent, "FRIYAY999 • 10% Off");
  assert.equal(ui.element("checkout-discount-details").hidden, false);
  assert.equal(ui.element("checkout-pay").disabled, false);
  ui.wireEvents();
  ui.element("checkout-remove-discount").listeners.get("click")();
  assert.equal(ui.element("discountCode").value, "");
  assert.equal(ui.element("name").value, "Shopper");
  assert.equal(ui.element("line1").value, "12 Test St");
  assert.equal(ui.element("checkout-discount-success").hidden, true);
  assert.equal(ui.element("checkout-row-discount").hidden, true);
  assert.equal(ui.element("checkout-pay").disabled, true);
  assert.equal(ui.element("checkout-update-totals").disabled, false);
  assert.match(ui.element("checkout-lines").innerHTML, /\$349\.95/);
  assert.doesNotMatch(ui.element("checkout-lines").innerHTML, /\$314\.95/);
});

test("checkout keeps carton rejection below the code, clears previous savings, and blocks payment", async () => {
  let rejected = false;
  const rejection = "This code requires at least 5 cartons. You have 3 cartons. Add 2 more to receive 10% off.";
  const response = { get ok() { return !rejected; }, json: async () => rejected
    ? { errorCode: "DISCOUNT_MIN_CARTONS", error: rejection, discount: { code: "FRIYAY999", minCartons: 5, cartonCount: 3 } }
    : successfulQuote() };
  const ui = checkoutHarness(response);
  await ui.runEstimate({ requireAddress: true });
  rejected = true;
  await ui.runEstimate({ requireAddress: true });
  assert.equal(ui.element("checkout-discount-warning").textContent, "FRIYAY999 requires at least 5 cartons.");
  assert.equal(ui.element("checkout-discount-actions").hidden, true);
  assert.equal(ui.element("sum-discount").textContent, "—");
  assert.equal(ui.element("checkout-discount-warning").hidden, false);
  assert.equal(ui.element("checkout-shipping-error").hidden, true);
  assert.equal(ui.element("checkout-discount-success").hidden, true);
  assert.equal(ui.element("checkout-row-discount").hidden, true);
  assert.equal(ui.element("checkout-shipping-rates").hidden, true);
  assert.equal(ui.element("checkout-pay").disabled, true);
  assert.equal(ui.element("checkout-update-totals").disabled, false);
  assert.equal(ui.element("discountCode").getAttribute("aria-invalid"), "true");
  assert.match(ui.element("checkout-lines").innerHTML, /\$349\.95/);
  assert.doesNotMatch(ui.element("checkout-lines").innerHTML, /\$314\.95/);
});

test("changing the cart or code during validation cannot restore an obsolete discount", async () => {
  let respond;
  const pending = new Promise((resolve) => { respond = resolve; });
  const ui = checkoutHarness({ ok: true, json: () => pending });
  const request = ui.runEstimate({ requireAddress: true });
  assert.equal(ui.element("checkout-update-totals").textContent, "Checking...");
  assert.equal(ui.element("checkout-update-totals").disabled, true);
  ui.markEstimateStale();
  respond(successfulQuote());
  await request;
  assert.equal(ui.element("checkout-discount-success").hidden, true);
  assert.equal(ui.element("checkout-row-discount").hidden, true);
  assert.equal(ui.element("checkout-pay").disabled, true);
  assert.equal(ui.element("checkout-update-totals").disabled, false);
});
