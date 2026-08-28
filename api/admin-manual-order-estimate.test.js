import assert from "node:assert/strict";
import test from "node:test";

import { computeManualOrderEstimateWithRetry } from "./admin-manual-order-estimate.js";
import { computeCheckoutEstimate } from "../lib/checkout-estimate-logic.js";

const noWait = async () => {};

const localAddress = {
  line1: "2009 Ben Hill Ct",
  city: "Nolensville",
  state: "TN",
  postalCode: "37135",
  country: "US",
};

function customPricedAdminItem() {
  return {
    slug: "nitrile-standard",
    clientLineId: "admin-line-1",
    bundleLines: [{ id: "box_1", qty: 2 }],
    quantities: { S: 0, M: 0, L: 0 },
    boxQuantities: { S: 0, M: 2, L: 0 },
    adminUnitPriceOverrideCents: 875,
    adminPriceOverrideReason: "",
  };
}

for (const fulfillmentMethod of ["local_delivery", "pickup"]) {
  test(`authorized admin custom pricing works for ${fulfillmentMethod}`, async () => {
    const quote = await computeCheckoutEstimate(
      {
        items: [customPricedAdminItem()],
        fulfillmentMethod,
        address: localAddress,
        forceStockOverride: true,
      },
      {
        manualOrderDiscount: true,
        allowForceStockOverride: true,
        strictShippo: false,
      },
    );

    assert.equal(quote.subtotalCents, 1750);
    assert.equal(quote.items[0].adminPriceOverride.unitPriceCents, 875);
    assert.equal(quote.manualNoCarrierFulfillment, fulfillmentMethod);
  });
}

test("custom pricing remains blocked when the server has not authorized the admin path", async () => {
  await assert.rejects(
    computeCheckoutEstimate(
      {
        items: [customPricedAdminItem()],
        fulfillmentMethod: "local_delivery",
        address: localAddress,
        forceStockOverride: true,
      },
      {
        allowForceStockOverride: true,
        strictShippo: false,
      },
    ),
    /only available for authorized admin orders/i,
  );
});

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
