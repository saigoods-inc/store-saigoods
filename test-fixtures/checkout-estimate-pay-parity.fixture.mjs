/**
 * Phase 9 estimate/pay parity fixture (module-mock harness).
 *
 * Filename intentionally does NOT match *.test.js so the normal suite does not
 * load mock.module without --experimental-test-module-mocks.
 *
 * Invoked only by server-checkout-estimate-pay-parity.test.js (child process) or:
 *   node --experimental-test-module-mocks --test test-fixtures/checkout-estimate-pay-parity.fixture.mjs
 */

import assert from "node:assert/strict";
import { mock, test } from "node:test";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const u = (rel) => pathToFileURL(path.join(repoRoot, rel)).href;

/** Set after handlers are imported under mocks. */
let CHECKOUT_PAY_NOT_READY_BODY;

const VALID_ITEMS = [
  {
    slug: "black-nitrile-general",
    bundleLines: [{ id: "box_1", qty: 1 }],
    quantities: {},
    boxQuantities: { M: 1, L: 0 },
  },
];

const TN_ADDRESS = {
  line1: "123 Main St",
  city: "Savannah",
  state: "TN",
  postalCode: "38372",
  country: "US",
};

const CA_ADDRESS = {
  line1: "1 Market St",
  city: "San Francisco",
  state: "CA",
  postalCode: "94105",
  country: "US",
};

const VALID_PAY_BODY = {
  items: VALID_ITEMS,
  address: TN_ADDRESS,
  email: "buyer@example.test",
  phone: "7315550100",
  name: "Test Buyer",
  sourceId: "cnon:card-nonce-ok",
};

const LIVE_OK_SHIPPING = {
  mode: "live_ups",
  quoteStatus: "rated",
  serviceCode: "03",
  serviceLabel: "UPS Ground",
  amountCents: 1000,
  amountFormatted: "$10.00",
  currency: "USD",
  residentialSurchargeCents: 0,
  residentialSurchargeFormatted: "$0.00",
  taxableShippingCents: 1000,
  provider: "shippo",
  providerQuoteId: "rate_test_1",
};

const LIVE_RESIDENTIAL_SHIPPING = {
  ...LIVE_OK_SHIPPING,
  residentialSurchargeCents: 650,
  residentialSurchargeFormatted: "$6.50",
  taxableShippingCents: 1650,
};

const LIVE_FAIL_SHIPPING = {
  mode: "live_ups",
  quoteStatus: "provider_unavailable",
  serviceCode: null,
  serviceLabel: null,
  amountCents: 0,
  amountFormatted: "$0.00",
  currency: "USD",
  residentialSurchargeCents: 0,
  residentialSurchargeFormatted: "$0.00",
  taxableShippingCents: 0,
  provider: "shippo",
  providerQuoteId: null,
};

/** @type {"ok" | "fail" | "residential"} */
let liveQuoteMode = "ok";

const getLiveShippingQuote = mock.fn(async () => {
  if (liveQuoteMode === "fail") {
    return {
      shipping: { ...LIVE_FAIL_SHIPPING },
      parcelSummary: { source: "computed", parcelCount: 0, parcels: [] },
      addressValidation: {
        status: "valid",
        normalizedAddress: null,
        suggestion: null,
        fieldErrors: {},
        messages: [],
      },
      warnings: [],
      userFacingError: "Shipping provider is temporarily unavailable.",
      canCheckout: false,
      shippingRateOptions: [],
    };
  }
  const shipping = liveQuoteMode === "residential" ? { ...LIVE_RESIDENTIAL_SHIPPING } : { ...LIVE_OK_SHIPPING };
  return {
    shipping,
    parcelSummary: { source: "computed", parcelCount: 1, parcels: [] },
    addressValidation: {
      status: "valid",
      normalizedAddress: null,
      suggestion: null,
      fieldErrors: {},
      messages: [],
    },
    warnings: [],
    userFacingError: null,
    canCheckout: true,
    shippingRateOptions: [
      {
        id: "rate_test_1",
        provider: "ups",
        serviceCode: "03",
        serviceLabel: "UPS Ground",
        amountCents: 1000,
        currency: "USD",
      },
    ],
  };
});

// --- Side-effect / carrier modules: only the exact exports handlers import. ---

mock.module(u("lib/live-shipping-quote.js"), {
  namedExports: {
    getLiveShippingQuote,
    // Pure helper; kept so any accidental import still cannot hit a carrier.
    computeResidentialSurchargeCents: (isResidential, parcelCount) =>
      isResidential ? Math.max(0, Math.floor(Number(parcelCount) || 0)) * 650 : 0,
  },
});

// Prevent checkout-estimate → shipping-rate-provider → shippo-rate-provider from loading.
mock.module(u("lib/shipping-rate-provider.js"), {
  namedExports: {
    getShippingRateProviderId: () => "shippo",
    getShippingRateQuote: async () => {
      throw new Error("getShippingRateQuote must not run in parity fixture");
    },
  },
});

const createPendingOrder = mock.fn(async ({ quote }) => {
  globalThis.__parityLastPendingQuote = quote;
  return { id: "ord_parity_test", order_ref: "SG-PARITY" };
});
const markOrderPaid = mock.fn(async () => ({ id: "ord_parity_test", status: "paid" }));
const cancelPendingOrderAfterPaymentFailure = mock.fn(async () => true);
mock.module(u("lib/orders.js"), {
  namedExports: {
    createPendingOrder,
    markOrderPaid,
    cancelPendingOrderAfterPaymentFailure,
  },
});

const createCardPayment = mock.fn(async ({ amountCents }) => {
  globalThis.__parityLastSquareAmountCents = amountCents;
  return { paymentId: "pay_parity_test" };
});
mock.module(u("lib/square.js"), {
  namedExports: {
    createCardPayment,
  },
});

const sendResendOrderConfirmation = mock.fn(async () => ({}));
mock.module(u("lib/resend-order-confirmation.js"), {
  namedExports: {
    sendResendOrderConfirmation,
  },
});

const syncWebsiteOrderToShippo = mock.fn(async () => ({ ok: true, skipped: true }));
mock.module(u("lib/shippo-order-sync.js"), {
  namedExports: {
    syncWebsiteOrderToShippo,
  },
});

/** Pure format check — mirrors lib/discount-codes.js normalizeDiscountCode (no I/O). */
function normalizeDiscountCode(raw) {
  const s = String(raw || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "");
  if (!s || s.length > 32) {
    return null;
  }
  if (!/^HC-[A-Z0-9]{5}$/.test(s)) {
    return null;
  }
  return s;
}

const assertDiscountCodeAvailable = mock.fn(async () => {});
const claimDiscountCodeForOrder = mock.fn(async () => true);
mock.module(u("lib/discount-codes.js"), {
  namedExports: {
    normalizeDiscountCode,
    assertDiscountCodeAvailable,
    claimDiscountCodeForOrder,
  },
});

/** When set, buildFullCheckoutQuote returns this object (strict readiness injection). */
let forcedQuote = null;

// Real checkout-totals is quote math only (no Square/Shippo/email/DB mutations).
const realTotals = await import(u("lib/checkout-totals.js"));
const buildFullCheckoutQuote = mock.fn(async (...args) => {
  if (forcedQuote) {
    return forcedQuote;
  }
  return realTotals.buildFullCheckoutQuote(...args);
});
mock.module(u("lib/checkout-totals.js"), {
  namedExports: {
    // Explicit pure exports required by handlers / remocked module consumers.
    buildFullCheckoutQuote,
    formatShippingAddressForOrder: realTotals.formatShippingAddressForOrder,
    getShippingQuoteMode: realTotals.getShippingQuoteMode,
    getShippingBufferCents: realTotals.getShippingBufferCents,
    getCheckoutResidentialSurchargeCents: realTotals.getCheckoutResidentialSurchargeCents,
    isStorefrontPaymentLinkCompatibleWithShippingMode:
      realTotals.isStorefrontPaymentLinkCompatibleWithShippingMode,
  },
});

const checkoutPayMod = await import(u("api/checkout-pay.js"));
const checkoutPayHandler = checkoutPayMod.default;
CHECKOUT_PAY_NOT_READY_BODY = checkoutPayMod.CHECKOUT_PAY_NOT_READY_BODY;
const { default: checkoutEstimateHandler } = await import(u("api/checkout-estimate.js"));

const PARITY_ENV = {
  ADDRESS_VALIDATION: "off",
  SHIPPING_QUOTE_MODE: "live_ups",
  INVENTORY_BACKEND: "file",
  SHIPPING_BUFFER_CENTS: "200",
  SALES_TAX_TN_BPS: "975",
  CHECKOUT_RESIDENTIAL_SURCHARGE_USD: "6.50",
  SQUARE_LOCATION_ID: "loc_parity_test",
  ENABLE_SHIPPO_ORDER_SYNC: "true",
  SUPABASE_URL: undefined,
  SUPABASE_SERVICE_ROLE_KEY: undefined,
  SQUARE_ACCESS_TOKEN: undefined,
  SHIPPO_API_TOKEN: undefined,
  RESEND_API_KEY: undefined,
};

function mockRes() {
  /** @type {{ statusCode?: number, body?: object }} */
  const state = {};
  return {
    state,
    status(code) {
      state.statusCode = code;
      return this;
    },
    json(body) {
      state.body = body;
      return this;
    },
  };
}

function withEnv(overrides, fn) {
  const keys = Object.keys(overrides);
  const previous = {};
  for (const key of keys) {
    previous[key] = process.env[key];
    const value = overrides[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const key of keys) {
        if (previous[key] === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = previous[key];
        }
      }
    });
}

async function invokeEstimate(body, method = "POST") {
  const res = mockRes();
  await checkoutEstimateHandler({ method, body }, res);
  return res.state;
}

async function invokePay(body, method = "POST") {
  const res = mockRes();
  await checkoutPayHandler({ method, body }, res);
  return res.state;
}

function resetSideEffectMocks() {
  createPendingOrder.mock.resetCalls();
  markOrderPaid.mock.resetCalls();
  cancelPendingOrderAfterPaymentFailure.mock.resetCalls();
  createCardPayment.mock.resetCalls();
  sendResendOrderConfirmation.mock.resetCalls();
  syncWebsiteOrderToShippo.mock.resetCalls();
  assertDiscountCodeAvailable.mock.resetCalls();
  claimDiscountCodeForOrder.mock.resetCalls();
  getLiveShippingQuote.mock.resetCalls();
  buildFullCheckoutQuote.mock.resetCalls();
  globalThis.__parityLastPendingQuote = undefined;
  globalThis.__parityLastSquareAmountCents = undefined;
}

function assertNoPaySideEffects() {
  assert.equal(createPendingOrder.mock.callCount(), 0, "createPendingOrder must not run");
  assert.equal(createCardPayment.mock.callCount(), 0, "createCardPayment must not run");
  assert.equal(markOrderPaid.mock.callCount(), 0, "markOrderPaid must not run");
  assert.equal(claimDiscountCodeForOrder.mock.callCount(), 0, "claimDiscountCodeForOrder must not run");
  assert.equal(syncWebsiteOrderToShippo.mock.callCount(), 0, "syncWebsiteOrderToShippo must not run");
  assert.equal(sendResendOrderConfirmation.mock.callCount(), 0, "sendResendOrderConfirmation must not run");
  assert.equal(
    cancelPendingOrderAfterPaymentFailure.mock.callCount(),
    0,
    "cancelPendingOrderAfterPaymentFailure must not run",
  );
}

function moneyFields(q) {
  return {
    subtotalCents: q.subtotalCents,
    merchandiseDiscountCents: Math.max(0, Number(q.merchandiseDiscountCents) || 0),
    shippingAmountCents: Math.max(0, Number(q.shipping?.amountCents) || 0),
    residentialSurchargeCents: Math.max(0, Number(q.shipping?.residentialSurchargeCents) || 0),
    shippingCents: q.shippingCents,
    taxableShippingCents: Math.max(0, Number(q.shipping?.taxableShippingCents) || 0),
    taxCents: q.taxCents,
    totalCents: q.totalCents,
    provider: q.shipping?.provider ?? null,
    serviceCode: q.shipping?.serviceCode ?? null,
    serviceLabel: q.shipping?.serviceLabel ?? null,
    quoteStatus: q.shipping?.quoteStatus ?? null,
    canCheckout: q.canCheckout,
    taxSource: q.taxSource ?? q.tax?.source ?? null,
  };
}

test("1. valid live-rate quote: estimate and pay share authoritative money fields", async () => {
  await withEnv(PARITY_ENV, async () => {
    liveQuoteMode = "ok";
    forcedQuote = null;
    resetSideEffectMocks();

    const estimate = await invokeEstimate({ items: VALID_ITEMS, address: TN_ADDRESS });
    assert.equal(estimate.statusCode, 200);
    assert.equal(estimate.body?.canCheckout, true);

    const pay = await invokePay(VALID_PAY_BODY);
    assert.equal(pay.statusCode, 200);
    assert.equal(pay.body?.success, true);
    assert.equal(createPendingOrder.mock.callCount(), 1);
    assert.equal(createCardPayment.mock.callCount(), 1);
    assert.equal(markOrderPaid.mock.callCount(), 1);

    const pendingQuote = globalThis.__parityLastPendingQuote;
    assert.ok(pendingQuote, "pending order must receive authoritative quote");
    assert.deepEqual(moneyFields(pendingQuote), moneyFields(estimate.body));
    assert.equal(globalThis.__parityLastSquareAmountCents, estimate.body.totalCents);
    assert.equal(createCardPayment.mock.calls[0].arguments[0].amountCents, estimate.body.totalCents);

    assert.equal(estimate.body.shipping.amountCents, 1200);
    assert.equal(estimate.body.shipping.quoteStatus, "rated");
    assert.equal(estimate.body.shipping.provider, "shippo");
    assert.equal(estimate.body.shipping.serviceCode, "03");
  });
});

test("2. live-rate provider failure: estimate soft-fails; pay fails closed with no side effects", async () => {
  await withEnv(PARITY_ENV, async () => {
    liveQuoteMode = "fail";
    forcedQuote = null;
    resetSideEffectMocks();

    const estimate = await invokeEstimate({ items: VALID_ITEMS, address: TN_ADDRESS });
    assert.equal(estimate.statusCode, 200);
    assert.equal(estimate.body?.canCheckout, false);
    assert.notEqual(estimate.body?.error, CHECKOUT_PAY_NOT_READY_BODY.error);

    resetSideEffectMocks();
    const pay = await invokePay(VALID_PAY_BODY);
    assert.equal(pay.statusCode, 503);
    assert.equal(pay.body?.error, CHECKOUT_PAY_NOT_READY_BODY.error);
    assert.equal(pay.body?.canCheckout, false);
    assert.deepEqual(pay.body?.shipping, {
      mode: "live_ups",
      quoteStatus: "provider_unavailable",
    });
    assertNoPaySideEffects();
  });
});

test("3. invalid address: both reject; pay has no side effects", async () => {
  await withEnv(PARITY_ENV, async () => {
    liveQuoteMode = "ok";
    forcedQuote = null;
    resetSideEffectMocks();

    const badAddress = { ...TN_ADDRESS, postalCode: "12" };
    const estimate = await invokeEstimate({ items: VALID_ITEMS, address: badAddress });
    assert.equal(estimate.statusCode, 400);
    assert.ok(String(estimate.body?.error || "").length > 0);

    resetSideEffectMocks();
    const pay = await invokePay({ ...VALID_PAY_BODY, address: badAddress });
    assert.equal(pay.statusCode, 400);
    assert.ok(String(pay.body?.error || "").length > 0);
    assertNoPaySideEffects();
  });
});

test("4. unsupported size allocation: both reject at runtime", async () => {
  await withEnv(PARITY_ENV, async () => {
    liveQuoteMode = "ok";
    forcedQuote = null;
    resetSideEffectMocks();

    const badItems = [
      {
        slug: "black-nitrile-general",
        bundleLines: [{ id: "box_1", qty: 1 }],
        quantities: {},
        boxQuantities: { S: 1, M: 0, L: 0, XL: 0 },
      },
    ];

    const estimate = await invokeEstimate({ items: badItems, address: TN_ADDRESS });
    assert.equal(estimate.statusCode, 400);
    assert.match(
      String(estimate.body?.error || ""),
      /no valid supported size allocation|supported size/i,
    );

    resetSideEffectMocks();
    const pay = await invokePay({ ...VALID_PAY_BODY, items: badItems });
    assert.equal(pay.statusCode, 400);
    assert.match(
      String(pay.body?.error || ""),
      /no valid supported size allocation|supported size/i,
    );
    assertNoPaySideEffects();
  });
});

test("5. insufficient stock: both reject with shortfalls; pay has no side effects", async () => {
  await withEnv(PARITY_ENV, async () => {
    liveQuoteMode = "ok";
    forcedQuote = null;
    resetSideEffectMocks();

    const hugeItems = [
      {
        slug: "black-nitrile-general",
        quantities: { M: 9999 },
        boxQuantities: {},
        bundleLines: [],
      },
    ];

    const estimate = await invokeEstimate({ items: hugeItems, address: TN_ADDRESS });
    assert.equal(estimate.statusCode, 409);
    assert.ok(Array.isArray(estimate.body?.stockShortfalls));
    assert.ok(estimate.body.stockShortfalls.length > 0);

    resetSideEffectMocks();
    const pay = await invokePay({ ...VALID_PAY_BODY, items: hugeItems });
    assert.equal(pay.statusCode, 409);
    assert.ok(Array.isArray(pay.body?.stockShortfalls));
    assert.ok(pay.body.stockShortfalls.length > 0);
    assert.deepEqual(pay.body.stockShortfalls, estimate.body.stockShortfalls);
    assertNoPaySideEffects();
  });
});

test("6. residential surcharge: estimate and pay totals match", async () => {
  await withEnv(PARITY_ENV, async () => {
    liveQuoteMode = "residential";
    forcedQuote = null;
    resetSideEffectMocks();

    const estimate = await invokeEstimate({ items: VALID_ITEMS, address: TN_ADDRESS });
    assert.equal(estimate.statusCode, 200);
    assert.equal(estimate.body?.shipping?.residentialSurchargeCents, 650);
    assert.equal(estimate.body?.shippingCents, 1850);

    const pay = await invokePay(VALID_PAY_BODY);
    assert.equal(pay.statusCode, 200);
    const pendingQuote = globalThis.__parityLastPendingQuote;
    assert.equal(pendingQuote.shipping.residentialSurchargeCents, 650);
    assert.equal(pendingQuote.shippingCents, estimate.body.shippingCents);
    assert.equal(pendingQuote.totalCents, estimate.body.totalCents);
  });
});

test("7. Tennessee taxable shipping: same tax base and taxCents", async () => {
  await withEnv(PARITY_ENV, async () => {
    liveQuoteMode = "residential";
    forcedQuote = null;
    resetSideEffectMocks();

    const estimate = await invokeEstimate({ items: VALID_ITEMS, address: TN_ADDRESS });
    assert.equal(estimate.statusCode, 200);
    assert.equal(estimate.body?.taxSource, "tn");
    assert.equal(
      estimate.body?.taxableBaseCents,
      estimate.body.subtotalCents + estimate.body.shipping.taxableShippingCents,
    );
    assert.equal(estimate.body?.taxCents, 268);

    const pay = await invokePay(VALID_PAY_BODY);
    assert.equal(pay.statusCode, 200);
    const pendingQuote = globalThis.__parityLastPendingQuote;
    assert.equal(pendingQuote.taxSource, "tn");
    assert.equal(pendingQuote.taxCents, estimate.body.taxCents);
    assert.equal(pendingQuote.taxableBaseCents, estimate.body.taxableBaseCents);
    assert.equal(pendingQuote.totalCents, estimate.body.totalCents);
  });
});

test("8. non-Tennessee tax: both return taxCents 0 and no_nexus", async () => {
  await withEnv(PARITY_ENV, async () => {
    liveQuoteMode = "ok";
    forcedQuote = null;
    resetSideEffectMocks();

    const estimate = await invokeEstimate({ items: VALID_ITEMS, address: CA_ADDRESS });
    assert.equal(estimate.statusCode, 200);
    assert.equal(estimate.body?.taxCents, 0);
    assert.equal(estimate.body?.taxSource, "no_nexus");

    const pay = await invokePay({ ...VALID_PAY_BODY, address: CA_ADDRESS });
    assert.equal(pay.statusCode, 200);
    const pendingQuote = globalThis.__parityLastPendingQuote;
    assert.equal(pendingQuote.taxCents, 0);
    assert.equal(pendingQuote.taxSource, "no_nexus");
    assert.equal(pendingQuote.totalCents, estimate.body.totalCents);
  });
});

test("9. Hardin discount: estimate and pay merchandise totals match", async () => {
  await withEnv(PARITY_ENV, async () => {
    liveQuoteMode = "ok";
    forcedQuote = null;
    resetSideEffectMocks();

    const code = "HC-ABC12";
    const estimate = await invokeEstimate({
      items: VALID_ITEMS,
      address: TN_ADDRESS,
      discountCode: code,
    });
    assert.equal(estimate.statusCode, 200);
    assert.equal(estimate.body?.hardinDiscountApplied, true);
    assert.equal(assertDiscountCodeAvailable.mock.callCount(), 1);

    resetSideEffectMocks();
    const pay = await invokePay({ ...VALID_PAY_BODY, discountCode: code });
    assert.equal(pay.statusCode, 200);
    assert.equal(pay.body?.hardinDiscountApplied, true);
    assert.equal(assertDiscountCodeAvailable.mock.callCount(), 1);
    assert.equal(claimDiscountCodeForOrder.mock.callCount(), 1);

    const pendingQuote = globalThis.__parityLastPendingQuote;
    assert.equal(pendingQuote.subtotalCents, estimate.body.subtotalCents);
    assert.equal(
      Math.max(0, Number(pendingQuote.merchandiseDiscountCents) || 0),
      Math.max(0, Number(estimate.body.merchandiseDiscountCents) || 0),
    );
    assert.equal(pendingQuote.totalCents, estimate.body.totalCents);
  });
});

test("10. missing or malformed cart: both reject per existing contracts", async () => {
  await withEnv(PARITY_ENV, async () => {
    liveQuoteMode = "ok";
    forcedQuote = null;
    resetSideEffectMocks();

    const emptyEstimate = await invokeEstimate({ items: [], address: TN_ADDRESS });
    assert.equal(emptyEstimate.statusCode, 400);
    assert.deepEqual(emptyEstimate.body, { error: "Your cart is empty." });

    const emptyPay = await invokePay({ ...VALID_PAY_BODY, items: [] });
    assert.equal(emptyPay.statusCode, 400);
    assert.deepEqual(emptyPay.body, { error: "Your cart is empty." });
    assertNoPaySideEffects();

    resetSideEffectMocks();
    const malformedEstimate = await invokeEstimate({ items: null, address: TN_ADDRESS });
    assert.equal(malformedEstimate.statusCode, 400);
    assert.deepEqual(malformedEstimate.body, { error: "Your cart is empty." });

    const malformedPay = await invokePay({ ...VALID_PAY_BODY, items: null });
    assert.equal(malformedPay.statusCode, 400);
    assert.deepEqual(malformedPay.body, { error: "Your cart is empty." });
    assertNoPaySideEffects();
  });
});

test("11. strict readiness boolean: only true passes; non-true values skip all side effects", async () => {
  await withEnv(PARITY_ENV, async () => {
    liveQuoteMode = "ok";
    const rejectedValues = [false, undefined, null, 0, "true", 1, { ok: true }];

    for (const canCheckout of rejectedValues) {
      forcedQuote = {
        canCheckout,
        shipping: { mode: "live_ups", quoteStatus: "error" },
        items: [],
        subtotalCents: 1,
        shippingCents: 0,
        taxCents: 0,
        totalCents: 1,
        totalFormatted: "$0.01",
      };
      resetSideEffectMocks();
      const pay = await invokePay(VALID_PAY_BODY);
      assert.equal(pay.statusCode, 503, `expected 503 for canCheckout=${String(canCheckout)}`);
      assert.equal(pay.body?.error, CHECKOUT_PAY_NOT_READY_BODY.error);
      assert.equal(pay.body?.canCheckout, false);
      assertNoPaySideEffects();
    }

    forcedQuote = {
      canCheckout: true,
      shipping: { mode: "live_ups", quoteStatus: "rated", amountCents: 0, residentialSurchargeCents: 0 },
      items: VALID_ITEMS,
      subtotalCents: 899,
      shippingCents: 0,
      taxCents: 0,
      totalCents: 899,
      totalFormatted: "$8.99",
    };
    resetSideEffectMocks();
    const ok = await invokePay(VALID_PAY_BODY);
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.body?.success, true);
    assert.equal(createPendingOrder.mock.callCount(), 1);
    assert.equal(createCardPayment.mock.callCount(), 1);
    forcedQuote = null;
  });
});

test("12. direct pay when quote not ready: no order, discount claim, Square, paid, stock, Shippo, or email", async () => {
  await withEnv(PARITY_ENV, async () => {
    liveQuoteMode = "fail";
    forcedQuote = null;
    resetSideEffectMocks();

    const pay = await invokePay({
      ...VALID_PAY_BODY,
      discountCode: "HC-ABC12",
      canCheckout: true,
      forceCheckout: true,
    });
    assert.equal(pay.statusCode, 503);
    assert.equal(pay.body?.error, CHECKOUT_PAY_NOT_READY_BODY.error);
    assertNoPaySideEffects();
  });
});
