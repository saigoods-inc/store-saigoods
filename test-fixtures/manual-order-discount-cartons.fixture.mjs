import assert from "node:assert/strict";
import { beforeEach, mock, test } from "node:test";
import * as realDiscountCodes from "../lib/discount-codes.js";
import * as realOrders from "../lib/orders.js";
import { buildQuote } from "../lib/quote.js";
import { applyManualOrderDiscountToQuote } from "../lib/manual-order-discount.js";
import { issueManualOrderQuoteToken } from "../lib/manual-order-quote-token.js";

// Keep the production catalog, authentication, eligibility and signed-token path.
// The only replaced boundaries are the database lookup and draft persistence.
let codeUsed = false;
let codeId = "original-code";
const assertDiscountCodeAvailable = mock.fn(async (code) => {
  if (codeUsed) throw Object.assign(new Error("This discount code has already been used."), { statusCode: 400 });
  return { id: codeId, code, percentOff: 10, min_cartons: 5 };
});
const draft = { id: "draft-test", order_ref: "TEST-001", order_status: "draft" };
const createManualOrderDraft = mock.fn(async () => draft);
const updateManualOrderDraft = mock.fn(async () => draft);
mock.module(new URL("../lib/discount-codes.js", import.meta.url).href, {
  namedExports: { ...realDiscountCodes, assertDiscountCodeAvailable },
});
mock.module(new URL("../lib/orders.js", import.meta.url).href, {
  namedExports: { ...realOrders, createManualOrderDraft, updateManualOrderDraft },
});

const { default: create } = await import("../api/admin-manual-order-create.js");
const { default: update } = await import("../api/admin-manual-order-update-draft.js");

const carton = (slug, qty, size = "M") => ({
  slug, quantities: { [size]: qty }, bundleLines: [{ id: "case_1", qty }],
});
const looseBoxes = {
  slug: "nitrile-standard", quantities: {}, boxQuantities: { M: 10 },
  bundleLines: [{ id: "box_1", qty: 10 }],
};
const eligibleItems = [carton("nitrile-standard", 2), carton("black-nitrile-general", 3, "L")];

function signedRequest(items, discountCode = "FRIYAY999") {
  const body = {
    orderId: draft.id,
    name: "Test Customer", email: "customer@example.test", phone: "7315550100",
    address: { line1: "123 Main St", city: "Savannah", state: "TN", postalCode: "38372", country: "US" },
    fulfillmentMethod: "carrier", paymentFlow: "pay_now", items,
    selectedShippingRateObjectId: "test-rate",
    ...(discountCode ? { discountCode } : {}),
  };
  let quote = buildQuote(items, { omitShippingEstimate: true });
  if (discountCode) {
    quote = applyManualOrderDiscountToQuote(quote, { type: "percent", value: 10 }).quote;
    // This previously issued quote must not override today's database condition.
    quote.discountCodeDetails = { id: "original-code", code: discountCode, percentOff: 10, minCartons: 0, cartonCount: 0, missingCartons: 0 };
  }
  quote = {
    ...quote, destinationState: "TN", canCheckout: true, userFacingError: null,
    shippingRateOptions: [{ id: "test-rate", provider: "ups", serviceCode: "03", serviceLabel: "UPS Ground", amountCents: 1000 }],
  };
  const quoteToken = issueManualOrderQuoteToken({ quote, request: body });
  assert.ok(quoteToken, "test must exercise a real signed quote");
  return { ...body, quoteToken };
}

async function invoke(handler, body) {
  let status;
  let json;
  const res = {
    status(value) { status = value; return this; },
    json(value) { json = value; return this; },
  };
  await handler({ method: "POST", headers: { authorization: "Bearer test-internal-secret" }, body }, res);
  return { status, json };
}

function assertNoDraftSaved() {
  assert.equal(createManualOrderDraft.mock.callCount(), 0);
  assert.equal(updateManualOrderDraft.mock.callCount(), 0);
}

beforeEach(() => {
  codeUsed = false;
  codeId = "original-code";
  for (const fn of [assertDiscountCodeAvailable, createManualOrderDraft, updateManualOrderDraft]) fn.mock.resetCalls();
});

for (const [name, handler, persistence, payloadIndex] of [
  ["create", create, createManualOrderDraft, 0],
  ["update", update, updateManualOrderDraft, 1],
]) {
  test(`${name}: signed carrier quote below today's minimum rejects before saving, even with ten loose boxes`, async () => {
    const result = await invoke(handler, signedRequest([carton("black-nitrile-general", 4), looseBoxes]));
    assert.equal(result.status, 400);
    assert.equal(result.json.errorCode, "DISCOUNT_MIN_CARTONS");
    assert.deepEqual(result.json.discount, { code: "FRIYAY999", percentOff: 10, minCartons: 5, cartonCount: 4, missingCartons: 1 });
    assert.equal(assertDiscountCodeAvailable.mock.callCount(), 1);
    assertNoDraftSaved();
  });

  test(`${name}: code used after the carrier quote was issued rejects before saving`, async () => {
    const body = signedRequest(eligibleItems);
    codeUsed = true;
    const result = await invoke(handler, body);
    assert.equal(result.status, 400);
    assert.match(result.json.error, /already been used/);
    assert.equal(assertDiscountCodeAvailable.mock.callCount(), 1);
    assertNoDraftSaved();
  });

  test(`${name}: qualifying signed carrier quote saves fresh carton details and selected shipping`, async () => {
    const result = await invoke(handler, signedRequest(eligibleItems));
    assert.equal(result.status, 200);
    assert.equal(result.json.orderId, draft.id);
    assert.equal(persistence.mock.callCount(), 1);
    const saved = persistence.mock.calls[0].arguments[payloadIndex];
    assert.deepEqual(saved.quote.discountCodeDetails, { id: "original-code", code: "FRIYAY999", percentOff: 10, minCartons: 5, cartonCount: 5, missingCartons: 0 });
    assert.deepEqual(saved.hardinDiscount, { code: "FRIYAY999", applied: true });
    assert.equal(saved.quote.manualDiscount.percent, 10);
    assert.equal(saved.quote.shipping.providerQuoteId, "test-rate");
    assert.equal(saved.quote.shippingCents, 1000);
    assert.equal(assertDiscountCodeAvailable.mock.calls[0].arguments[0], "FRIYAY999");
  });

  test(`${name}: recreated code rejects an old carrier quote before saving`, async () => {
    const body = signedRequest(eligibleItems);
    codeId = "replacement-code";
    const result = await invoke(handler, body);
    assert.equal(result.status, 409);
    assert.match(result.json.error, /changed|replaced/i);
    assertNoDraftSaved();
  });

  test(`${name}: carrier draft without a code preserves loose-box checkout and skips discount lookup`, async () => {
    const result = await invoke(handler, signedRequest([looseBoxes], null));
    assert.equal(result.status, 200);
    assert.equal(persistence.mock.callCount(), 1);
    const saved = persistence.mock.calls[0].arguments[payloadIndex];
    assert.equal(saved.quote.discountCodeDetails, undefined);
    assert.equal(saved.hardinDiscount, null);
    assert.equal(saved.quote.shipping.providerQuoteId, "test-rate");
    assert.equal(assertDiscountCodeAvailable.mock.callCount(), 0);
  });
}
