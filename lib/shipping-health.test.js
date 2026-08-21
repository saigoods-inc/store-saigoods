import assert from "node:assert/strict";
import test from "node:test";

import { sanitizeShippingHealthEvent, shippingRuntimeReadiness } from "./shipping-health.js";

test("shipping health events retain operational fields but discard raw details", () => {
  const row = sanitizeShippingHealthEvent({
    eventType: "checkout_rate",
    outcome: "no_rates",
    errorCode: "arbitrary provider response with token",
    provider: "Shippo",
    parcelCount: 2,
    rateCount: 0,
    durationMs: 821,
    address: "must not persist",
  });
  assert.deepEqual(row, {
    event_type: "checkout_rate",
    outcome: "no_rates",
    provider: "shippo",
    order_id: null,
    error_code: "UNKNOWN",
    parcel_count: 2,
    rate_count: 0,
    duration_ms: 821,
  });
  assert.equal(JSON.stringify(row).includes("address"), false);
  assert.equal(JSON.stringify(row).includes("token"), false);
});

test("runtime readiness reports test mode without exposing credentials", () => {
  const saved = { ...process.env };
  process.env.SHIPPING_RATE_PROVIDER = "shippo";
  process.env.SHIPPO_API_TOKEN = "shippo_test_secret";
  process.env.SHIPPO_UPS_CARRIER_ACCOUNT_ID = "carrier-id";
  process.env.SHIPPO_FROM_STREET1 = "configured";
  process.env.SHIPPO_FROM_CITY = "configured";
  process.env.SHIPPO_FROM_STATE = "TN";
  process.env.SHIPPO_FROM_ZIP = "00000";
  process.env.SHIPPO_LABEL_DB_LOCK = "1";
  process.env.ADDRESS_VALIDATION = "on";
  try {
    const readiness = shippingRuntimeReadiness();
    assert.equal(readiness.provider, "shippo");
    assert.equal(readiness.providerConfigured, true);
    assert.equal(readiness.tokenConfigured, true);
    assert.equal(readiness.shippoConfigured, true);
    assert.equal(readiness.tokenMode, "test");
    assert.equal(readiness.carrierAccountCount, 1);
    assert.equal(readiness.warehouseConfigured, true);
    assert.equal(readiness.checkoutAddressValidationReady, true);
    assert.equal(readiness.warehouseAddressValidationReady, true);
    assert.equal(JSON.stringify(readiness).includes("shippo_test_secret"), false);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});

test("live Shippo credentials are treated as configured for readiness checks", () => {
  const saved = { ...process.env };
  process.env.SHIPPING_RATE_PROVIDER = "shippo";
  process.env.SHIPPO_API_TOKEN = "shippo_live_secret";
  process.env.SHIPPO_UPS_CARRIER_ACCOUNT_ID = "carrier-id";
  process.env.SHIPPO_FROM_STREET1 = "configured";
  process.env.SHIPPO_FROM_CITY = "configured";
  process.env.SHIPPO_FROM_STATE = "TN";
  process.env.SHIPPO_FROM_ZIP = "00000";
  process.env.SHIPPO_LABEL_DB_LOCK = "1";
  process.env.ADDRESS_VALIDATION = "on";

  try {
    const readiness = shippingRuntimeReadiness();
    assert.equal(readiness.tokenMode, "live");
    assert.equal(readiness.shippoConfigured, true);
    assert.equal(readiness.checkoutAddressValidationReady, true);
    assert.equal(readiness.warehouseAddressValidationReady, true);
    assert.equal(JSON.stringify(readiness).includes("shippo_live_secret"), false);
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in saved)) delete process.env[key];
    }
    Object.assign(process.env, saved);
  }
});
