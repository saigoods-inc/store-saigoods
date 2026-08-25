import assert from "node:assert/strict";
import test from "node:test";
import { issueManualOrderQuoteToken, selectManualOrderRateFromToken, verifyManualOrderQuoteToken } from "./manual-order-quote-token.js";

const priorSecret = process.env.MANUAL_ORDER_QUOTE_SIGNING_SECRET;
process.env.MANUAL_ORDER_QUOTE_SIGNING_SECRET = "test-manual-quote-secret";
test.after(() => {
  if (priorSecret == null) delete process.env.MANUAL_ORDER_QUOTE_SIGNING_SECRET;
  else process.env.MANUAL_ORDER_QUOTE_SIGNING_SECRET = priorSecret;
});

function request() {
  return {
    items: [{ slug: "nitrile-standard", quantities: { S: 1 } }],
    address: { line1: "1 Main St", city: "Savannah", state: "TN", postalCode: "38372", country: "US" },
    fulfillmentMethod: "carrier",
    manualDiscountType: "none",
  };
}

function quote() {
  return {
    canCheckout: true,
    subtotalCents: 5499,
    destinationState: "TN",
    shipping: { quoteStatus: "rated" },
    shippingRateOptions: [
      {
        id: "rate-ground",
        provider: "UPS",
        serviceCode: "ground",
        serviceLabel: "Ground",
        amountCents: 957,
        bufferCents: 200,
        totalAmountCents: 1157,
        packageRateObjectIds: ["rate-ground"],
        packageShipmentObjectIds: ["shipment-ground"],
      },
    ],
  };
}

test("manual carrier confirmation selects the signed rate without requesting another quote", () => {
  const now = Date.UTC(2026, 7, 18, 1, 0, 0);
  const token = issueManualOrderQuoteToken({ quote: quote(), request: request(), now });
  const payload = verifyManualOrderQuoteToken(token, { ...request(), quoteToken: token }, now + 1000);
  const selected = selectManualOrderRateFromToken(payload, { selectedShippingRateObjectId: "rate-ground" });
  assert.equal(selected.shipping.providerQuoteId, "rate-ground");
  assert.deepEqual(selected.shipping.selectedPackageRateObjectIds, ["rate-ground"]);
  assert.deepEqual(selected.shipping.selectedPackageShipmentObjectIds, ["shipment-ground"]);
  assert.equal(selected.shippingCents, 1157);
  assert.equal(selected.totalCents, 7305);
});

test("manual quote token rejects changed order input", () => {
  const now = Date.UTC(2026, 7, 18, 1, 0, 0);
  const token = issueManualOrderQuoteToken({ quote: quote(), request: request(), now });
  assert.throws(
    () => verifyManualOrderQuoteToken(token, { ...request(), items: [{ slug: "nitrile-standard", quantities: { S: 2 } }] }, now + 1000),
    (error) => error.code === "MANUAL_QUOTE_CHANGED",
  );
});

test("manual carrier confirmation preserves a free customer charge and the carrier cost", () => {
  const now = Date.UTC(2026, 7, 18, 1, 0, 0);
  const freeQuote = quote();
  freeQuote.freeShipping = {
    configured: true,
    eligible: true,
    applied: false,
    qualifyingRateId: "rate-ground",
    message: "Enjoy your free shipping!",
  };
  freeQuote.shippingRateOptions[0] = {
    ...freeQuote.shippingRateOptions[0],
    carrierTotalAmountCents: 1157,
    totalAmountCents: 0,
    totalAmountFormatted: "$0.00",
    freeShippingApplied: true,
    shippingDiscountCents: 1157,
  };
  const token = issueManualOrderQuoteToken({ quote: freeQuote, request: request(), now });
  const payload = verifyManualOrderQuoteToken(token, { ...request(), quoteToken: token }, now + 1000);
  const selected = selectManualOrderRateFromToken(payload, { selectedShippingRateObjectId: "rate-ground" });
  assert.equal(selected.shipping.providerQuoteId, "rate-ground");
  assert.equal(selected.shipping.freeShippingApplied, true);
  assert.equal(selected.shipping.carrierTotalAmountCents, 1157);
  assert.equal(selected.shippingCents, 0);
  assert.equal(selected.freeShipping.applied, true);
  assert.equal(selected.totalCents, 6035);
});
