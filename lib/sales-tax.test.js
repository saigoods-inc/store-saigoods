import assert from "node:assert/strict";
import test from "node:test";
import { computeCheckoutSalesTaxSync } from "./sales-tax.js";

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

test("Tennessee tax defaults to 975 bps when SALES_TAX_TN_BPS is absent", () => {
  saveEnv();
  try {
    delete process.env.SALES_TAX_TN_BPS;
    const result = computeCheckoutSalesTaxSync("TN", 10000, 0);
    assert.equal(result.taxCents, 975);
    assert.equal(result.taxSource, "tn");
    assert.equal(result.taxableBaseCents, 10000);
  } finally {
    restoreEnv();
  }
});

test("SALES_TAX_TN_BPS override still works", () => {
  saveEnv();
  try {
    process.env.SALES_TAX_TN_BPS = "700";
    const result = computeCheckoutSalesTaxSync("TN", 10000, 0);
    assert.equal(result.taxCents, 700);
    assert.equal(result.taxSource, "tn");
  } finally {
    restoreEnv();
  }
});

test("non-Tennessee destinations return zero tax", () => {
  saveEnv();
  try {
    delete process.env.SALES_TAX_TN_BPS;
    const result = computeCheckoutSalesTaxSync("CA", 10000, 500);
    assert.equal(result.taxCents, 0);
    assert.equal(result.taxSource, "no_nexus");
    assert.equal(result.taxableBaseCents, 10500);
  } finally {
    restoreEnv();
  }
});

test("invalid SALES_TAX_TN_BPS falls back to 975", () => {
  saveEnv();
  try {
    process.env.SALES_TAX_TN_BPS = "not-a-number";
    const result = computeCheckoutSalesTaxSync("TN", 10000, 0);
    assert.equal(result.taxCents, 975);
    assert.equal(result.taxSource, "tn");
  } finally {
    restoreEnv();
  }
});

test("taxable shipping and fees are included in the Tennessee taxable base", () => {
  saveEnv();
  try {
    delete process.env.SALES_TAX_TN_BPS;
    // 10000 merchandise + 1500 shipping/fees = 11500 base @ 9.75% = 1121 cents
    const result = computeCheckoutSalesTaxSync("TN", 10000, 1500);
    assert.equal(result.taxableBaseCents, 11500);
    assert.equal(result.taxCents, 1121);
    assert.equal(result.taxSource, "tn");
  } finally {
    restoreEnv();
  }
});
