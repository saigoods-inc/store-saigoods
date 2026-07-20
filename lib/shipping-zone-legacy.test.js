import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { getShippingZone } from "./shipping-zone-legacy.js";
import * as shippingZoneLegacy from "./shipping-zone-legacy.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test("getShippingZone returns mapped zone for representative valid ZIPs", () => {
  assert.equal(getShippingZone("10001"), 5);
  assert.equal(getShippingZone("90210"), 8);
  assert.equal(getShippingZone("60601"), 5);
  assert.equal(getShippingZone("33101"), 4);
  assert.equal(getShippingZone("37013"), 2);
});

test("getShippingZone accepts ZIP+4 and non-digit separators", () => {
  assert.equal(getShippingZone("10001-1234"), 5);
  assert.equal(getShippingZone("90210 6789"), 8);
});

test("getShippingZone defaults to zone 8 for invalid or too-short input", () => {
  assert.equal(getShippingZone(""), 8);
  assert.equal(getShippingZone("12"), 8);
  assert.equal(getShippingZone("ab"), 8);
  assert.equal(getShippingZone(null), 8);
  assert.equal(getShippingZone(undefined), 8);
});

test("module no longer exports removed rate-calculator symbols", () => {
  assert.equal(shippingZoneLegacy.shippingRates, undefined);
  assert.equal(shippingZoneLegacy.SLUG_TO_SHIPPING_TYPE, undefined);
  assert.equal(shippingZoneLegacy.calculateShipping, undefined);
  assert.equal(shippingZoneLegacy.calculateCartShipping, undefined);
  assert.equal(shippingZoneLegacy.getShippingProductTypeForSlug, undefined);
  assert.equal(typeof shippingZoneLegacy.getShippingZone, "function");
});

test("admin-summary still imports getShippingZone from shipping-zone-legacy", () => {
  const adminSummarySource = fs.readFileSync(
    path.join(__dirname, "admin-summary.js"),
    "utf8",
  );
  assert.match(
    adminSummarySource,
    /import\s+\{\s*getShippingZone\s*\}\s+from\s+"\.\/shipping-zone-legacy\.js"/,
  );
  assert.equal(typeof getShippingZone, "function");
  assert.equal(getShippingZone("10001"), 5);
});
