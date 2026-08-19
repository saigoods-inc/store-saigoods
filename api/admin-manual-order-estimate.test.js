import assert from "node:assert/strict";
import test from "node:test";

import { computeManualOrderEstimateWithRetry } from "./admin-manual-order-estimate.js";

const noWait = async () => {};

test("manual carrier estimate retries one complete transient response", async () => {
  let calls = 0;
  const result = await computeManualOrderEstimateWithRetry(
    { items: [{ slug: "nitrile-standard" }] },
    { strictShippo: true },
    async () => {
      calls += 1;
      if (calls === 1) {
        return {
          canCheckout: false,
          shipping: { quoteStatus: "provider_unavailable" },
          serverDebug: { providerErrorCode: "SHIPPO_RATE_LIMITED" },
        };
      }
      return { canCheckout: true, shipping: { quoteStatus: "rated" } };
    },
    noWait,
  );

  assert.equal(calls, 2);
  assert.equal(result.canCheckout, true);
});

test("manual carrier estimate stops after one whole-request retry", async () => {
  let calls = 0;
  const result = await computeManualOrderEstimateWithRetry(
    {},
    { strictShippo: true },
    async () => {
      calls += 1;
      return { canCheckout: false, shipping: { quoteStatus: "error" } };
    },
    noWait,
  );

  assert.equal(calls, 2);
  assert.equal(result.canCheckout, false);
});

test("manual carrier estimate retries one thrown transient Shippo failure", async () => {
  let calls = 0;
  const result = await computeManualOrderEstimateWithRetry(
    {},
    { strictShippo: true },
    async () => {
      calls += 1;
      if (calls === 1) {
        const error = new Error("rate request timed out");
        error.code = "SHIPPO_TIMEOUT";
        throw error;
      }
      return { canCheckout: true, shipping: { quoteStatus: "rated" } };
    },
    noWait,
  );

  assert.equal(calls, 2);
  assert.equal(result.canCheckout, true);
});

test("manual carrier estimate does not retry validation or configuration errors", async () => {
  let calls = 0;
  await assert.rejects(
    computeManualOrderEstimateWithRetry(
      {},
      { strictShippo: true },
      async () => {
        calls += 1;
        const error = new Error("Shippo token is missing");
        error.code = "SHIPPO_NOT_CONFIGURED";
        throw error;
      },
      noWait,
    ),
    /token is missing/,
  );
  assert.equal(calls, 1);
});
