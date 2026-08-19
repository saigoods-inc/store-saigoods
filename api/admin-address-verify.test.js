import assert from "node:assert/strict";
import test from "node:test";

import { verifyAdminAddress } from "./admin-address-verify.js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const submitted = {
  line1: "12685 Ulmerton Rd.",
  line2: "",
  city: "Largo",
  state: "tn",
  postalCode: "33774",
  country: "us",
};

test("admin address verification returns a visible normalized suggestion", async () => {
  const suggestion = {
    line1: "12685 Ulmerton Road",
    line2: "",
    city: "Largo",
    state: "FL",
    postalCode: "33774-3605",
    country: "US",
  };
  const result = await verifyAdminAddress(submitted, {
    validateAddress: async (_address, options) => {
      assert.deepEqual(options, { forceShippo: true, strictShippo: true });
      return {
        ok: false,
        error: "We found a different deliverable address.",
        normalizedAddress: suggestion,
        addressSuggestion: suggestion,
        fieldErrors: {},
      };
    },
  });

  assert.equal(result.verified, false);
  assert.deepEqual(result.addressSuggestion, suggestion);
  assert.deepEqual(result.normalizedAddress, suggestion);
});

test("admin address verification maps checkout field errors to order-builder fields", async () => {
  const result = await verifyAdminAddress(submitted, {
    validateAddress: async () => ({
      ok: false,
      error: "Please enter a valid shipping address",
      fieldErrors: {
        line1: "Please enter a valid street address",
        city: "Please enter a valid city",
        state: "Please select a state",
        postalCode: "Please enter a valid ZIP code",
      },
    }),
  });

  assert.equal(result.verified, false);
  assert.deepEqual(result.fieldErrors, {
    addressLine1: "Please enter a valid street address",
    addressCity: "Please enter a valid city",
    addressState: "Please select a state",
    addressZip: "Please enter a valid ZIP code",
  });
});

test("admin address verification confirms an exact deliverable address", async () => {
  const result = await verifyAdminAddress(submitted, {
    validateAddress: async (address) => ({
      ok: true,
      normalizedAddress: address,
      addressSuggestion: null,
      fieldErrors: {},
    }),
  });

  assert.equal(result.verified, true);
  assert.equal(result.addressSuggestion, null);
  assert.match(result.message, /verified/i);
});

test("local server exposes the authenticated admin address verification route", () => {
  const source = readFileSync(path.join(root, "server.js"), "utf8");
  assert.match(source, /pathname === "\/api\/admin-address-verify"/);
  assert.match(source, /adminAddressVerifyHandler/);
});
