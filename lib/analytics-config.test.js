import assert from "node:assert/strict";
import test from "node:test";
import { resolveAnalyticsConfigFromEnv } from "./analytics-config.js";

test("analytics is disabled when GA4_MEASUREMENT_ID is absent", () => {
  assert.deepEqual(resolveAnalyticsConfigFromEnv({}), {
    enabled: false,
    measurementId: null,
  });
});

test("analytics accepts and normalizes a GA4 measurement id", () => {
  assert.deepEqual(resolveAnalyticsConfigFromEnv({ GA4_MEASUREMENT_ID: " g-ab12cd34 " }), {
    enabled: true,
    measurementId: "G-AB12CD34",
  });
});

test("analytics rejects non-GA4 ids", () => {
  assert.deepEqual(resolveAnalyticsConfigFromEnv({ GA4_MEASUREMENT_ID: "UA-123-4" }), {
    enabled: false,
    measurementId: null,
  });
});
