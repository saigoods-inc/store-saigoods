import assert from "node:assert/strict";
import test from "node:test";
import { validateShippingAddressForCheckout } from "./address-validation.js";

import {
  assertStoredRatesMatchWarehouse,
  legacyEnvShipFromOverride,
  normalizeWarehouseLocation,
  validateWarehouseLocations,
  validateWarehouseLocationsWithShippo,
  warehouseAddressFingerprint,
} from "./warehouse-settings.js";

function warehouse(overrides = {}) {
  return {
    key: "savannah",
    name: "Savannah warehouse",
    address1: "275 Eureka Street",
    address2: "",
    city: "Savannah",
    state: "TN",
    zip: "38372",
    country: "US",
    email: "sales@saigoods.com",
    phone: "5555555555",
    roles: ["Default ship-from", "Returns"],
    active: true,
    ...overrides,
  };
}

test("warehouse settings require exactly one active default ship-from", () => {
  assert.equal(validateWarehouseLocations([warehouse()]).length, 1);
  assert.throws(() => validateWarehouseLocations([warehouse({ roles: ["Returns"] })]), /Exactly one active/);
  assert.throws(
    () => validateWarehouseLocations([warehouse(), warehouse({ key: "second", name: "Second" })]),
    /Exactly one active/,
  );
});

test("warehouse settings reject malformed shipping addresses", () => {
  assert.throws(
    () => validateWarehouseLocations([warehouse({ address1: "1", zip: "123" })]),
    (error) => {
      assert.equal(error.statusCode, 400);
      assert.ok(error.fieldErrors.line1 || error.fieldErrors.postalCode);
      return true;
    },
  );
});

test("warehouse saves require strict Shippo validation even when checkout validation is disabled", async () => {
  let receivedOptions = null;
  const locations = await validateWarehouseLocationsWithShippo([warehouse()], {
    validateAddress: async (_address, options) => {
      receivedOptions = options;
      return { ok: true };
    },
  });
  assert.equal(locations.length, 1);
  assert.deepEqual(receivedOptions, { strictShippo: true, forceShippo: true });
});

test("forced warehouse validation cannot be bypassed by disabling checkout validation", async () => {
  const savedValidation = process.env.ADDRESS_VALIDATION;
  const savedToken = process.env.SHIPPO_API_TOKEN;
  process.env.ADDRESS_VALIDATION = "off";
  delete process.env.SHIPPO_API_TOKEN;
  try {
    const result = await validateShippingAddressForCheckout(
      {
        line1: "275 Eureka Street",
        city: "Savannah",
        state: "TN",
        postalCode: "38372",
        country: "US",
      },
      { strictShippo: true, forceShippo: true },
    );
    assert.equal(result.ok, false);
    assert.match(result.error, /not configured/i);
  } finally {
    if (savedValidation === undefined) delete process.env.ADDRESS_VALIDATION;
    else process.env.ADDRESS_VALIDATION = savedValidation;
    if (savedToken === undefined) delete process.env.SHIPPO_API_TOKEN;
    else process.env.SHIPPO_API_TOKEN = savedToken;
  }
});

test("warehouse saves surface Shippo address failures before persistence", async () => {
  await assert.rejects(
    () => validateWarehouseLocationsWithShippo([warehouse()], {
      validateAddress: async () => ({
        ok: false,
        error: "Please enter a valid shipping address",
        fieldErrors: { postalCode: "City, state, and ZIP do not match." },
      }),
    }),
    (error) => {
      assert.equal(error.statusCode, 400);
      assert.equal(error.fieldErrors.postalCode, "City, state, and ZIP do not match.");
      assert.match(error.message, /Savannah warehouse/);
      return true;
    },
  );
});

test("legacy environment remains the fallback until persistent warehouse settings are enabled", () => {
  const previous = { ...process.env };
  try {
    delete process.env.WAREHOUSE_CONFIG_BACKEND;
    delete process.env.PACKAGING_CONFIG_BACKEND;
    process.env.SHIPPO_FROM_NAME = "Environment warehouse";
    process.env.SHIPPO_FROM_STREET1 = "10 Legacy Way";
    process.env.SHIPPO_FROM_CITY = "Savannah";
    process.env.SHIPPO_FROM_STATE = "TN";
    process.env.SHIPPO_FROM_ZIP = "38372";
    const override = legacyEnvShipFromOverride();
    assert.equal(override.line1, "10 Legacy Way");
    assert.equal(override.postalCode, "38372");
  } finally {
    process.env = previous;
  }
});

test("rate purchase is rejected after the warehouse origin changes", () => {
  const oldAddress = normalizeWarehouseLocation(warehouse());
  const newAddress = normalizeWarehouseLocation(warehouse({ address1: "999 New Warehouse Road" }));
  const order = {
    shippo_from_address_override_json: {
      line1: newAddress.address1,
      city: newAddress.city,
      state: newAddress.state,
      postalCode: newAddress.zip,
      country: newAddress.country,
    },
    shippo_shipment_rates_json: {
      rates: [{ object_id: "rate-old" }],
      shipFromFingerprint: warehouseAddressFingerprint(oldAddress),
    },
  };
  assert.throws(() => assertStoredRatesMatchWarehouse(order), (error) => {
    assert.equal(error.code, "SHIP_FROM_CHANGED");
    assert.equal(error.statusCode, 409);
    return true;
  });
});
