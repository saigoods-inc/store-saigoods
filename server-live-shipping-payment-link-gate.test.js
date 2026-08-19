import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import checkoutHandler, {
  STOREFRONT_PAYMENT_LINK_UNAVAILABLE_BODY,
} from "./api/checkout.js";
import { enrichCartQuoteApiResponse } from "./lib/cart-api-response.js";
import {
  getShippingQuoteMode,
  isStorefrontPaymentLinkCompatibleWithShippingMode,
} from "./lib/checkout-totals.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const checkoutSource = readFileSync(path.join(__dirname, "api", "checkout.js"), "utf8");
const cartApiSource = readFileSync(path.join(__dirname, "lib", "cart-api-response.js"), "utf8");
const adminSendLinkSource = readFileSync(
  path.join(__dirname, "api", "admin-manual-order-send-link.js"),
  "utf8",
);
const checkoutTotalsSource = readFileSync(path.join(__dirname, "lib", "checkout-totals.js"), "utf8");

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

async function invokeCheckout(body, method = "POST") {
  const res = mockRes();
  await checkoutHandler({ method, body }, res);
  return res.state;
}

const CART_READINESS_ENV_KEYS = [
  "SHIPPING_QUOTE_MODE",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SQUARE_ACCESS_TOKEN",
  "SQUARE_LOCATION_ID",
  "PUBLIC_BASE_URL",
  "SQUARE_WEBHOOK_SIGNATURE_KEY",
  "SQUARE_WEBHOOK_SIGNATURE_KEY_SANDBOX",
  "SQUARE_APPLICATION_ID",
];

const DUMMY_SQUARE_CORE = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "dummy-service-role",
  SQUARE_ACCESS_TOKEN: "dummy-square-token",
  SQUARE_LOCATION_ID: "dummy-location",
  PUBLIC_BASE_URL: "https://example.test",
  SQUARE_WEBHOOK_SIGNATURE_KEY: "dummy-webhook-sig",
};

test("SHIPPING_QUOTE_MODE matrix matches getShippingQuoteMode normalization exactly", async () => {
  const cases = [
    { raw: undefined, expected: "live_ups", compatible: false },
    { raw: "", expected: "live_ups", compatible: false },
    { raw: "live_ups", expected: "live_ups", compatible: false },
    { raw: "  LIVE_UPS  ", expected: "live_ups", compatible: false },
    { raw: "unknown_mode", expected: "live_ups", compatible: false },
    { raw: "baked_in", expected: "baked_in", compatible: true },
    { raw: "  Baked_In  ", expected: "baked_in", compatible: true },
    { raw: "BAKED_IN", expected: "baked_in", compatible: true },
  ];
  for (const c of cases) {
    await withEnv({ SHIPPING_QUOTE_MODE: c.raw }, () => {
      assert.equal(getShippingQuoteMode(), c.expected, `raw=${JSON.stringify(c.raw)}`);
      assert.equal(
        isStorefrontPaymentLinkCompatibleWithShippingMode(),
        c.compatible,
        `compatible raw=${JSON.stringify(c.raw)}`,
      );
    });
  }
});

test("getShippingQuoteMode only recognizes baked_in vs live_ups default", () => {
  assert.match(
    checkoutTotalsSource,
    /if\s*\(\s*raw\s*===\s*["']baked_in["']\s*\)\s*\{\s*return\s*["']baked_in["']\s*;\s*\}/,
  );
  assert.match(checkoutTotalsSource, /return\s*["']live_ups["']\s*;/);
});

test("POST /api/checkout rejects under default live shipping with exact 503 body", async () => {
  await withEnv({ SHIPPING_QUOTE_MODE: undefined }, async () => {
    const state = await invokeCheckout({
      items: [{ slug: "anything", quantities: { M: 1 } }],
      customer: { email: "buyer@example.test" },
    });
    assert.equal(state.statusCode, 503);
    assert.deepEqual(state.body, STOREFRONT_PAYMENT_LINK_UNAVAILABLE_BODY);
    assert.deepEqual(state.body, {
      error:
        "Address-based checkout is required. The payment-link fallback is unavailable.",
    });
    assert.equal(String(JSON.stringify(state.body)).includes("SHIPPING_QUOTE_MODE"), false);
  });
});

test("POST /api/checkout rejects under explicit live_ups", async () => {
  await withEnv({ SHIPPING_QUOTE_MODE: "live_ups" }, async () => {
    const state = await invokeCheckout({
      items: [{ slug: "anything", quantities: { M: 1 } }],
    });
    assert.equal(state.statusCode, 503);
    assert.deepEqual(state.body, STOREFRONT_PAYMENT_LINK_UNAVAILABLE_BODY);
  });
});

test("direct API calls cannot bypass the live-shipping payment-link gate", async () => {
  await withEnv({ SHIPPING_QUOTE_MODE: "live_ups" }, async () => {
    const empty = await invokeCheckout({ items: [] });
    assert.equal(empty.statusCode, 503);
    assert.deepEqual(empty.body, STOREFRONT_PAYMENT_LINK_UNAVAILABLE_BODY);

    const missing = await invokeCheckout({});
    assert.equal(missing.statusCode, 503);
    assert.deepEqual(missing.body, STOREFRONT_PAYMENT_LINK_UNAVAILABLE_BODY);

    const get = await invokeCheckout({ items: [{ slug: "x" }] }, "GET");
    assert.equal(get.statusCode, 405);
    assert.deepEqual(get.body, { error: "Method not allowed." });
  });
});

test("checkout.js gates before quote, pending order, Square, and any email work", () => {
  const methodIdx = checkoutSource.indexOf('req.method !== "POST"');
  const gateIdx = checkoutSource.indexOf("!isStorefrontPaymentLinkCompatibleWithShippingMode()");
  const itemsIdx = checkoutSource.indexOf("const { items, customer: rawCustomer }");
  const emptyIdx = checkoutSource.indexOf('error: "Your cart is empty."');
  const quoteIdx = checkoutSource.indexOf("await buildFullCheckoutQuote");
  const pendingIdx = checkoutSource.indexOf("await createPendingOrder");
  const squareIdx = checkoutSource.indexOf("await createPaymentLink");
  const checkoutUrlIdx = checkoutSource.indexOf("checkoutUrl: paymentLink.checkoutUrl");
  assert.ok(methodIdx > 0, "method check must be present");
  assert.ok(gateIdx > methodIdx, "method rejection must run before shipping gate");
  assert.ok(itemsIdx > gateIdx, "gate must run before reading cart items");
  assert.ok(emptyIdx > gateIdx, "gate must run before empty-cart validation");
  assert.ok(quoteIdx > gateIdx, "gate must run before buildFullCheckoutQuote");
  assert.ok(pendingIdx > gateIdx, "gate must run before createPendingOrder");
  assert.ok(squareIdx > gateIdx, "gate must run before createPaymentLink");
  assert.ok(checkoutUrlIdx > gateIdx, "gate must run before any checkoutUrl response");
  assert.equal(/resend|sendgrid|sendMail|send.*[Ee]mail/.test(checkoutSource), false);
  assert.match(checkoutSource, /status\(503\)\.json\(STOREFRONT_PAYMENT_LINK_UNAVAILABLE_BODY\)/);
});

/**
 * Direct side-effect proof (no Production test hooks):
 * Under live shipping the handler returns the gate 503 for payloads that, under
 * baked_in, reach later stages with different status/body. That contrast proves
 * buildFullCheckoutQuote / createPendingOrder / createPaymentLink were not invoked.
 */
test("live shipping skips item validation, quote, pending order, and Square for payloads that diverge under baked_in", async () => {
  const emptyBody = { items: [] };
  const validBody = {
    items: [
      {
        slug: "black-nitrile-general",
        bundleLines: [{ id: "box_1", qty: 1 }],
        quantities: {},
        boxQuantities: { M: 1, L: 0 },
      },
    ],
    customer: {},
  };

  await withEnv({ SHIPPING_QUOTE_MODE: "live_ups" }, async () => {
    const emptyLive = await invokeCheckout(emptyBody);
    assert.equal(emptyLive.statusCode, 503);
    assert.deepEqual(emptyLive.body, STOREFRONT_PAYMENT_LINK_UNAVAILABLE_BODY);
    assert.equal(emptyLive.body?.checkoutUrl, undefined);

    const validLive = await invokeCheckout(validBody);
    assert.equal(validLive.statusCode, 503);
    assert.deepEqual(validLive.body, STOREFRONT_PAYMENT_LINK_UNAVAILABLE_BODY);
    assert.equal(validLive.body?.checkoutUrl, undefined);
  });

  await withEnv(
    {
      SHIPPING_QUOTE_MODE: "baked_in",
      SUPABASE_URL: undefined,
      SUPABASE_SERVICE_ROLE_KEY: undefined,
      SQUARE_ACCESS_TOKEN: undefined,
    },
    async () => {
      // Same empty payload: would hit empty-cart validation (before quote) if gate open.
      const emptyBaked = await invokeCheckout(emptyBody);
      assert.equal(emptyBaked.statusCode, 400);
      assert.deepEqual(emptyBaked.body, { error: "Your cart is empty." });

      // Same valid payload: passes empty check + buildFullCheckoutQuote, then fails at
      // createPendingOrder (Supabase) — proving quote ran and Square was not yet called
      // with a checkoutUrl response.
      const validBaked = await invokeCheckout(validBody);
      assert.notDeepEqual(validBaked.body, STOREFRONT_PAYMENT_LINK_UNAVAILABLE_BODY);
      assert.notEqual(validBaked.body?.error, STOREFRONT_PAYMENT_LINK_UNAVAILABLE_BODY.error);
      assert.match(String(validBaked.body?.error || ""), /Supabase/i);
      assert.equal(validBaked.body?.checkoutUrl, undefined);
      assert.ok(validBaked.statusCode >= 400);
    },
  );
});

test("compatible baked_in mode is not blocked by the new payment-link gate", async () => {
  await withEnv(
    {
      SHIPPING_QUOTE_MODE: "baked_in",
      // Leave order/Square unconfigured so the handler fails after the gate —
      // proving the gate itself did not reject.
      SUPABASE_URL: undefined,
      SUPABASE_SERVICE_ROLE_KEY: undefined,
      SQUARE_ACCESS_TOKEN: undefined,
    },
    async () => {
      assert.equal(isStorefrontPaymentLinkCompatibleWithShippingMode(), true);
      const state = await invokeCheckout({
        items: [
          {
            slug: "black-nitrile-general",
            bundleLines: [{ id: "box_1", qty: 1 }],
            quantities: {},
            boxQuantities: { M: 1, L: 0 },
          },
        ],
        customer: {},
      });
      assert.notDeepEqual(state.body, STOREFRONT_PAYMENT_LINK_UNAVAILABLE_BODY);
      assert.notEqual(
        state.body?.error,
        STOREFRONT_PAYMENT_LINK_UNAVAILABLE_BODY.error,
      );
      assert.match(String(state.body?.error || ""), /Supabase/i);
      assert.ok(state.statusCode >= 400, "baked_in proceeds past the gate into order/Square work");
    },
  );
});

test("cart does not advertise payment-link fallback when live shipping and embedded Square unavailable", async () => {
  await withEnv(
    {
      SHIPPING_QUOTE_MODE: undefined,
      ...DUMMY_SQUARE_CORE,
      SQUARE_APPLICATION_ID: undefined,
      SQUARE_WEBHOOK_SIGNATURE_KEY_SANDBOX: undefined,
    },
    () => {
      const enriched = enrichCartQuoteApiResponse({ items: [], subtotalCents: 0 });
      assert.equal(enriched.useEmbeddedCheckout, false);
      assert.equal(enriched.squareReady, false);
      assert.equal(enriched.checkoutReady, false);
    },
  );
});

test("cart keeps embedded checkout ready when Square embedded config is present under live shipping", async () => {
  await withEnv(
    {
      SHIPPING_QUOTE_MODE: "live_ups",
      ...DUMMY_SQUARE_CORE,
      SQUARE_APPLICATION_ID: "sandbox-sq0idb-dummy",
      SQUARE_WEBHOOK_SIGNATURE_KEY_SANDBOX: undefined,
    },
    () => {
      const enriched = enrichCartQuoteApiResponse({ items: [], subtotalCents: 0 });
      assert.equal(enriched.useEmbeddedCheckout, true);
      assert.equal(enriched.squareReady, true);
      assert.equal(enriched.checkoutReady, true);
    },
  );
});

test("cart can advertise payment-link readiness only under baked_in when Square core is configured", async () => {
  await withEnv(
    {
      SHIPPING_QUOTE_MODE: "baked_in",
      ...DUMMY_SQUARE_CORE,
      SQUARE_APPLICATION_ID: undefined,
      SQUARE_WEBHOOK_SIGNATURE_KEY_SANDBOX: undefined,
    },
    () => {
      const baseQuote = { items: [], subtotalCents: 0, totalCases: 0, customField: "keep-me" };
      const enriched = enrichCartQuoteApiResponse(baseQuote);
      assert.equal(enriched.useEmbeddedCheckout, false);
      assert.equal(enriched.squareReady, true);
      assert.equal(enriched.checkoutReady, true);
      assert.equal(enriched.customField, "keep-me");
      assert.equal(enriched.subtotalCents, 0);
      assert.equal(enriched.totalCases, 0);
      assert.equal(Object.prototype.hasOwnProperty.call(enriched, "useEmbeddedCheckout"), true);
      assert.equal(Object.prototype.hasOwnProperty.call(enriched, "squareReady"), true);
      assert.equal(Object.prototype.hasOwnProperty.call(enriched, "checkoutReady"), true);
    },
  );
});

test("cart readiness stays false under baked_in when neither embedded nor payment-link prerequisites are present", async () => {
  await withEnv(
    {
      SHIPPING_QUOTE_MODE: "baked_in",
      SUPABASE_URL: undefined,
      SUPABASE_SERVICE_ROLE_KEY: undefined,
      SQUARE_ACCESS_TOKEN: undefined,
      SQUARE_LOCATION_ID: undefined,
      PUBLIC_BASE_URL: undefined,
      SQUARE_WEBHOOK_SIGNATURE_KEY: undefined,
      SQUARE_WEBHOOK_SIGNATURE_KEY_SANDBOX: undefined,
      SQUARE_APPLICATION_ID: undefined,
    },
    () => {
      const enriched = enrichCartQuoteApiResponse({ items: [], subtotalCents: 0 });
      assert.equal(enriched.useEmbeddedCheckout, false);
      assert.equal(enriched.squareReady, false);
      assert.equal(enriched.checkoutReady, false);
    },
  );
});

test("cart readiness env is restored after each readiness test", async () => {
  const snapshot = Object.fromEntries(CART_READINESS_ENV_KEYS.map((k) => [k, process.env[k]]));
  await withEnv(
    {
      SHIPPING_QUOTE_MODE: "live_ups",
      SUPABASE_URL: "https://temp.example",
      SQUARE_APPLICATION_ID: "temp-app",
    },
    () => {
      enrichCartQuoteApiResponse({});
    },
  );
  for (const key of CART_READINESS_ENV_KEYS) {
    assert.equal(process.env[key], snapshot[key]);
  }
});

test("admin manual-order payment-link flow source is unchanged by this fix", () => {
  assert.equal(adminSendLinkSource.includes("isStorefrontPaymentLinkCompatibleWithShippingMode"), false);
  assert.equal(adminSendLinkSource.includes("STOREFRONT_PAYMENT_LINK_UNAVAILABLE"), false);
  assert.match(adminSendLinkSource, /computeCheckoutEstimate/);
  assert.match(adminSendLinkSource, /createPaymentLink/);
  assert.match(adminSendLinkSource, /sendManualOrderPaymentLinkEmail/);
});

test("cart-api-response gates paymentLinkReady on shipping compatibility helper", () => {
  assert.match(cartApiSource, /isStorefrontPaymentLinkCompatibleWithShippingMode/);
  assert.match(
    cartApiSource,
    /paymentLinkReady\s*=\s*Boolean\(\s*squareCore\s*&&\s*supabaseOk\s*&&\s*isStorefrontPaymentLinkCompatibleWithShippingMode\(\),\s*\)/s,
  );
});
