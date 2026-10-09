import assert from "node:assert/strict";
import test from "node:test";
import { isCheckoutPreviewOnly } from "./checkout-preview.js";
import squareConfig from "../api/square-config.js";

test("payment-free review mode requires explicit sandbox Preview and cannot activate in production", () => {
  const enabled = { VERCEL_ENV: "preview", SQUARE_ENVIRONMENT: "sandbox", CHECKOUT_PREVIEW_ONLY: "true" };
  assert.equal(isCheckoutPreviewOnly(enabled), true);
  for (const overrides of [{ VERCEL_ENV: "production" }, { VERCEL_ENV: undefined }, { SQUARE_ENVIRONMENT: "production" }, { CHECKOUT_PREVIEW_ONLY: undefined }]) {
    assert.equal(isCheckoutPreviewOnly({ ...enabled, ...overrides }), false);
  }
});

test("review checkout can load without Square credentials and exposes only its explicit preview flag", async () => {
  const settings = { VERCEL_ENV: "preview", SQUARE_ENVIRONMENT: "sandbox", CHECKOUT_PREVIEW_ONLY: "true", SQUARE_APPLICATION_ID: "", SQUARE_LOCATION_ID: "" };
  const previous = Object.fromEntries(Object.keys(settings).map((key) => [key, process.env[key]]));
  Object.assign(process.env, settings);
  try {
    let status, body;
    await squareConfig({ method: "GET" }, { status(value) { status = value; return this; }, json(value) { body = value; } });
    assert.equal(status, 200);
    assert.equal(body.checkoutPreviewOnly, true);
    assert.equal(body.squareApplicationId, null);
    assert.equal(body.squareLocationId, null);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
