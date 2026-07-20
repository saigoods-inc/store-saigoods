import assert from "node:assert/strict";
import test from "node:test";
import { normalizeUsStateCode } from "./tax-us.js";

test("normalizeUsStateCode accepts valid two-letter codes", () => {
  assert.equal(normalizeUsStateCode("TN"), "TN");
  assert.equal(normalizeUsStateCode("CA"), "CA");
});

test("normalizeUsStateCode normalizes lowercase and whitespace", () => {
  assert.equal(normalizeUsStateCode("tn"), "TN");
  assert.equal(normalizeUsStateCode("  Ca  "), "CA");
});

test("normalizeUsStateCode rejects invalid values", () => {
  assert.equal(normalizeUsStateCode(null), null);
  assert.equal(normalizeUsStateCode(undefined), null);
  assert.equal(normalizeUsStateCode(""), null);
  assert.equal(normalizeUsStateCode("T"), null);
  assert.equal(normalizeUsStateCode("TNN"), null);
  assert.equal(normalizeUsStateCode("12"), null);
  assert.equal(normalizeUsStateCode("T1"), null);
});
