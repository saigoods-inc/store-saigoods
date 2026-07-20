import assert from "node:assert/strict";
import test from "node:test";
import { getCheckoutResidentialSurchargeCents } from "./checkout-surcharge.js";
import { computeResidentialSurchargeCents } from "./live-shipping-quote.js";

/** @type {NodeJS.ProcessEnv} */
let savedEnv = null;

function saveEnv() {
  savedEnv = { ...process.env };
}

function restoreEnv() {
  if (!savedEnv) {
    return;
  }
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, savedEnv);
  savedEnv = null;
}

/**
 * @param {string | undefined} value
 */
function setResidentialSurchargeUsd(value) {
  if (value === undefined) {
    delete process.env.CHECKOUT_RESIDENTIAL_SURCHARGE_USD;
  } else {
    process.env.CHECKOUT_RESIDENTIAL_SURCHARGE_USD = value;
  }
}

test("CHECKOUT_RESIDENTIAL_SURCHARGE_USD absent → 650 cents per package", () => {
  saveEnv();
  try {
    setResidentialSurchargeUsd(undefined);
    assert.equal(getCheckoutResidentialSurchargeCents(), 650);
    assert.equal(computeResidentialSurchargeCents(true, 1), 650);
  } finally {
    restoreEnv();
  }
});

test("configured value 7.25 → 725 cents per package", () => {
  saveEnv();
  try {
    setResidentialSurchargeUsd("7.25");
    assert.equal(getCheckoutResidentialSurchargeCents(), 725);
    assert.equal(computeResidentialSurchargeCents(true, 1), 725);
  } finally {
    restoreEnv();
  }
});

test("configured value 0 → 0 cents", () => {
  saveEnv();
  try {
    setResidentialSurchargeUsd("0");
    assert.equal(getCheckoutResidentialSurchargeCents(), 0);
    assert.equal(computeResidentialSurchargeCents(true, 3), 0);
  } finally {
    restoreEnv();
  }
});

test("invalid text → fallback to 650 cents", () => {
  saveEnv();
  try {
    setResidentialSurchargeUsd("not-a-number");
    assert.equal(getCheckoutResidentialSurchargeCents(), 650);
    assert.equal(computeResidentialSurchargeCents(true, 1), 650);
  } finally {
    restoreEnv();
  }
});

test("negative value → fallback to 650 cents", () => {
  saveEnv();
  try {
    setResidentialSurchargeUsd("-1");
    assert.equal(getCheckoutResidentialSurchargeCents(), 650);
    assert.equal(computeResidentialSurchargeCents(true, 1), 650);
  } finally {
    restoreEnv();
  }
});

test("residential shipment with multiple parcels multiplies correctly", () => {
  saveEnv();
  try {
    setResidentialSurchargeUsd("6.50");
    assert.equal(computeResidentialSurchargeCents(true, 3), 1950);
    setResidentialSurchargeUsd("7.25");
    assert.equal(computeResidentialSurchargeCents(true, 2), 1450);
  } finally {
    restoreEnv();
  }
});

test("non-residential shipment returns 0", () => {
  saveEnv();
  try {
    setResidentialSurchargeUsd("6.50");
    assert.equal(computeResidentialSurchargeCents(false, 5), 0);
    assert.equal(computeResidentialSurchargeCents(false, 1), 0);
  } finally {
    restoreEnv();
  }
});

test("zero/invalid parcel count returns 0", () => {
  saveEnv();
  try {
    setResidentialSurchargeUsd("6.50");
    assert.equal(computeResidentialSurchargeCents(true, 0), 0);
    assert.equal(computeResidentialSurchargeCents(true, -2), 0);
    assert.equal(computeResidentialSurchargeCents(true, Number.NaN), 0);
    assert.equal(computeResidentialSurchargeCents(true, null), 0);
    assert.equal(computeResidentialSurchargeCents(true, undefined), 0);
    assert.equal(computeResidentialSurchargeCents(true, 1.9), 650);
  } finally {
    restoreEnv();
  }
});
