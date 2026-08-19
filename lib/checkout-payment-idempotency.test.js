import assert from "node:assert/strict";
import test from "node:test";
import { parseCheckoutPayBody } from "./checkout-validation.js";
import { createCardPayment } from "./square.js";

const validBody = {
  items: [{ slug: "nitrile-standard", quantities: { Small: 1 } }],
  address: { line1: "1 Main St", city: "Savannah", state: "TN", postalCode: "38372" },
  email: "buyer@example.com",
  sourceId: "card-token",
  checkoutAttemptId: "c74619a5-a0a8-4c21-a7cf-3babcd2c33e1",
};

test("checkout requires a version-4 attempt id", () => {
  assert.equal(parseCheckoutPayBody(validBody).checkoutAttemptId, validBody.checkoutAttemptId);
  assert.match(parseCheckoutPayBody({ ...validBody, checkoutAttemptId: "" }).error, /session expired/i);
  assert.match(
    parseCheckoutPayBody({ ...validBody, checkoutAttemptId: "c74619a5-a0a8-1c21-a7cf-3babcd2c33e1" }).error,
    /session expired/i,
  );
});

test("Square transport failures are marked outcome-uncertain", async () => {
  const previousFetch = globalThis.fetch;
  const previousToken = process.env.SQUARE_ACCESS_TOKEN;
  const previousLocation = process.env.SQUARE_LOCATION_ID;
  process.env.SQUARE_ACCESS_TOKEN = "sandbox-token";
  process.env.SQUARE_LOCATION_ID = "sandbox-location";
  globalThis.fetch = async () => {
    throw new Error("socket closed");
  };
  try {
    await assert.rejects(
      () =>
        createCardPayment({
          sourceId: "card-token",
          amountCents: 1000,
          locationId: "sandbox-location",
          orderId: "order-1",
          idempotencyKey: "stable-key",
        }),
      (error) => error.paymentOutcomeUncertain === true && error.statusCode === 202,
    );
  } finally {
    globalThis.fetch = previousFetch;
    if (previousToken === undefined) delete process.env.SQUARE_ACCESS_TOKEN;
    else process.env.SQUARE_ACCESS_TOKEN = previousToken;
    if (previousLocation === undefined) delete process.env.SQUARE_LOCATION_ID;
    else process.env.SQUARE_LOCATION_ID = previousLocation;
  }
});
