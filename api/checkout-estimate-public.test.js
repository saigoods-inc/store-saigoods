import assert from "node:assert/strict";
import test from "node:test";
import {
  computeCheckoutEstimateWithFreshSelection,
  publicCheckoutEstimateJson,
  withoutSelectedShippingRate,
} from "./checkout-estimate.js";
import { computeCheckoutEstimate } from "../lib/checkout-estimate-logic.js";

test("checkout estimate removes server-only shipping diagnostics", () => {
  const result = publicCheckoutEstimateJson({
    shipping: { quoteStatus: "provider_unavailable" },
    serverDebug: { providerMessage: "Shippo returned no rates", token: "secret" },
  });
  assert.deepEqual(result, { shipping: { quoteStatus: "provider_unavailable" } });
  assert.equal(JSON.stringify(result).includes("Shippo"), false);
});

test("checkout estimate strips a stale selected rate and retries once", async () => {
  const body = {
    items: [{ slug: "nitrile-standard" }],
    address: { postalCode: "38372" },
    selectedShippingRateObjectId: "fallback:standard_ground",
    selectedShippingServiceCode: "FALLBACK_STANDARD_GROUND",
    selectedShippingServiceLabel: "Standard Ground",
    selectedShippingProvider: "fallback",
    selectedShippingAmountCents: 7620,
    selectedShippingParcelCount: 6,
    selectedShippingResidentialSurchargeCents: 0,
  };
  const calls = [];
  const result = await computeCheckoutEstimateWithFreshSelection(body, async (received) => {
    calls.push(received);
    if (calls.length === 1) {
      const error = new Error("stale selection");
      error.code = "INVALID_SHIPPING_RATE_SELECTION";
      throw error;
    }
    return { shipping: { provider: "shippo", quoteStatus: "rated" } };
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].selectedShippingProvider, "fallback");
  assert.deepEqual(calls[1], withoutSelectedShippingRate(body));
  assert.equal(calls[1].selectedShippingRateObjectId, undefined);
  assert.equal(calls[1].selectedShippingServiceCode, undefined);
  assert.deepEqual(result, { shipping: { provider: "shippo", quoteStatus: "rated" } });
});

test("checkout estimate does not retry provider failures", async () => {
  let calls = 0;
  await assert.rejects(
    computeCheckoutEstimateWithFreshSelection(
      { selectedShippingRateObjectId: "old-rate" },
      async () => {
        calls += 1;
        const error = new Error("no rates");
        error.code = "SHIPPO_NO_RATES";
        throw error;
      },
    ),
    /no rates/,
  );
  assert.equal(calls, 1);
});

test("checkout estimate retries one transient carrier response", async () => {
  let calls = 0;
  const result = await computeCheckoutEstimateWithFreshSelection({}, async () => {
    calls += 1;
    if (calls === 1) {
      return {
        canCheckout: false,
        shipping: { quoteStatus: "provider_unavailable" },
      };
    }
    return {
      canCheckout: true,
      shipping: { quoteStatus: "rated" },
    };
  });

  assert.equal(calls, 2);
  assert.equal(result.canCheckout, true);
});

test("checkout estimate stops after one transient retry", async () => {
  let calls = 0;
  const result = await computeCheckoutEstimateWithFreshSelection({}, async () => {
    calls += 1;
    return {
      canCheckout: false,
      shipping: { quoteStatus: "error" },
    };
  });

  assert.equal(calls, 2);
  assert.equal(result.canCheckout, false);
});

test("checkout estimate does not repost after Shippo delayed rates are exhausted", async () => {
  let calls = 0;
  const result = await computeCheckoutEstimateWithFreshSelection({}, async () => {
    calls += 1;
    return {
      canCheckout: false,
      shipping: { provider: "shippo", quoteStatus: "error" },
      serverDebug: { providerErrorCode: "SHIPPO_NO_RATES" },
    };
  });

  assert.equal(calls, 1);
  assert.equal(result.serverDebug.providerErrorCode, "SHIPPO_NO_RATES");
});

test("internal checkout pricing still requires Shippo address verification", async () => {
  const previous = {
    token: process.env.SHIPPO_API_TOKEN,
    validation: process.env.ADDRESS_VALIDATION,
    pricingMode: process.env.CHECKOUT_SHIPPING_PRICING_MODE,
    fetch: globalThis.fetch,
  };
  let validationCalls = 0;

  process.env.SHIPPO_API_TOKEN = "shippo_test_address_validation";
  process.env.ADDRESS_VALIDATION = "on";
  process.env.CHECKOUT_SHIPPING_PRICING_MODE = "internal";
  globalThis.fetch = async (url) => {
    if (!/\/addresses\/$/.test(String(url))) {
      return new Response(JSON.stringify({ message: "not configured in this test" }), { status: 503 });
    }
    validationCalls += 1;
    return new Response(JSON.stringify({
      street1: "1234 Ulmerton Road",
      city: "Nashville",
      state: "TN",
      zip: "37135",
      country: "US",
      validation_results: {
        is_valid: false,
        messages: [{ text: "The city, state, and ZIP code do not match." }],
      },
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    await assert.rejects(
      computeCheckoutEstimate({
        items: [{
          slug: "nitrile-standard",
          quantities: {},
          boxQuantities: { M: 1 },
          bundleLines: [{ id: "box_1", qty: 1 }],
        }],
        address: {
          line1: "1234 Ulmerton Road",
          city: "Seminole",
          state: "FL",
          postalCode: "37135",
          country: "US",
        },
        forceStockOverride: true,
      }, {
        requireCompleteAddress: true,
        allowForceStockOverride: true,
      }),
      (error) => error?.statusCode === 400 && /valid shipping address/i.test(error.message),
    );
    assert.equal(validationCalls, 1);
  } finally {
    if (previous.token == null) delete process.env.SHIPPO_API_TOKEN;
    else process.env.SHIPPO_API_TOKEN = previous.token;
    if (previous.validation == null) delete process.env.ADDRESS_VALIDATION;
    else process.env.ADDRESS_VALIDATION = previous.validation;
    if (previous.pricingMode == null) delete process.env.CHECKOUT_SHIPPING_PRICING_MODE;
    else process.env.CHECKOUT_SHIPPING_PRICING_MODE = previous.pricingMode;
    globalThis.fetch = previous.fetch;
  }
});

test("eligible free-local-delivery estimate bypasses Shippo completely", async () => {
  const previousFetch = globalThis.fetch;
  let carrierCalls = 0;
  globalThis.fetch = async () => {
    carrierCalls += 1;
    throw new Error("Shippo must not be called for free local delivery");
  };
  try {
    const result = await computeCheckoutEstimate({
      items: [{
        slug: "nitrile-standard",
        quantities: {},
        boxQuantities: { M: 1 },
        bundleLines: [{ id: "box_1", qty: 1 }],
      }],
      address: {
        line1: "2009 Ben Hill Ct",
        city: "Nolensville",
        state: "TN",
        postalCode: "37135-8484",
        country: "US",
      },
      forceStockOverride: true,
    }, {
      requireCompleteAddress: true,
      allowForceStockOverride: true,
      freeDeliveryConfig: {
        active: true,
        state: "TN",
        postalCodes: ["37135"],
        minimumSubtotalCents: 100,
        productMinimumsCents: { "nitrile-standard": 100 },
      },
    });
    assert.equal(carrierCalls, 0);
    assert.equal(result.shipping.mode, "local_delivery");
    assert.equal(result.shipping.provider, "local");
    assert.equal(result.shippingCents, 0);
    assert.equal(result.freeDelivery.applied, true);
    assert.equal(result.freeDelivery.carrierBypassed, true);
  } finally {
    globalThis.fetch = previousFetch;
  }
});
