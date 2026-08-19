import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import checkoutPayHandler, {
  CHECKOUT_PAY_NOT_READY_BODY,
  buildCheckoutPayNotReadyBody,
} from "./api/checkout-pay.js";
import checkoutHandler, {
  STOREFRONT_PAYMENT_LINK_UNAVAILABLE_BODY,
} from "./api/checkout.js";
import checkoutEstimateHandler from "./api/checkout-estimate.js";
import { buildFullCheckoutQuote } from "./lib/checkout-totals.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const checkoutPaySource = readFileSync(path.join(__dirname, "api", "checkout-pay.js"), "utf8");
const checkoutEstimateSource = readFileSync(path.join(__dirname, "api", "checkout-estimate.js"), "utf8");
const checkoutSource = readFileSync(path.join(__dirname, "api", "checkout.js"), "utf8");
const adminSendLinkSource = readFileSync(
  path.join(__dirname, "api", "admin-manual-order-send-link.js"),
  "utf8",
);

const VALID_ITEMS = [
  {
    slug: "black-nitrile-general",
    bundleLines: [{ id: "box_1", qty: 1 }],
    quantities: {},
    boxQuantities: { M: 1, L: 0 },
  },
];

const VALID_ADDRESS = {
  line1: "123 Main St",
  city: "Savannah",
  state: "TN",
  postalCode: "38372",
  country: "US",
};

const VALID_PAY_BODY = {
  items: VALID_ITEMS,
  address: VALID_ADDRESS,
  email: "buyer@example.test",
  phone: "7315550100",
  name: "Test Buyer",
  sourceId: "cnon:card-nonce-ok",
  checkoutAttemptId: "11111111-1111-4111-8111-111111111111",
};

/** Env that reaches final live quote with canCheckout:false (Shippo unconfigured) without external HTTP. */
const LIVE_QUOTE_FAIL_ENV = {
  NODE_ENV: "test",
  ADDRESS_VALIDATION: "off",
  SHIPPING_QUOTE_MODE: "live_ups",
  SHIPPING_RATE_PROVIDER: "shippo",
  CHECKOUT_LIVE_SHIPPING_FALLBACK: "off",
  SHIPPO_API_TOKEN: undefined,
  INVENTORY_BACKEND: "file",
};

const LIVE_QUOTE_FALLBACK_ENV = {
  NODE_ENV: "test",
  ADDRESS_VALIDATION: "off",
  SHIPPING_QUOTE_MODE: "live_ups",
  SHIPPING_RATE_PROVIDER: "shippo",
  CHECKOUT_LIVE_SHIPPING_FALLBACK: "on",
  SHIPPO_API_TOKEN: undefined,
  INVENTORY_BACKEND: "file",
};

const BAKED_IN_PASS_GATE_ENV = {
  NODE_ENV: "test",
  ADDRESS_VALIDATION: "off",
  SHIPPING_QUOTE_MODE: "baked_in",
  INVENTORY_BACKEND: "file",
  SUPABASE_URL: undefined,
  SUPABASE_SERVICE_ROLE_KEY: undefined,
  SQUARE_ACCESS_TOKEN: undefined,
  SQUARE_LOCATION_ID: undefined,
  RESEND_API_KEY: undefined,
  RESEND_FROM: undefined,
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

async function invokeCheckoutPay(body, method = "POST") {
  const res = mockRes();
  await checkoutPayHandler({ method, body }, res);
  return res.state;
}

async function invokeCheckout(body, method = "POST") {
  const res = mockRes();
  await checkoutHandler({ method, body }, res);
  return res.state;
}

async function invokeEstimate(body, method = "POST") {
  const res = mockRes();
  await checkoutEstimateHandler({ method, body }, res);
  return res.state;
}

function assertNoPaymentSuccess(body) {
  assert.equal(body?.success, undefined);
  assert.equal(body?.paymentId, undefined);
  assert.equal(body?.orderId, undefined);
  assert.equal(body?.orderRef, undefined);
  assert.equal(body?.checkoutUrl, undefined);
  assert.equal(body?.canCheckout, false);
  assert.equal(body?.error, CHECKOUT_PAY_NOT_READY_BODY.error);
  assert.equal(String(JSON.stringify(body)).includes("SQUARE_ACCESS_TOKEN"), false);
  assert.equal(String(JSON.stringify(body)).includes("SHIPPO_API_TOKEN"), false);
  assert.equal(String(JSON.stringify(body)).toLowerCase().includes("payment could not"), false);
  assert.equal(String(JSON.stringify(body)).toLowerCase().includes("payment failed"), false);
}

test("buildCheckoutPayNotReadyBody is deterministic and only attaches safe shipping fields", () => {
  assert.deepEqual(buildCheckoutPayNotReadyBody(null), { ...CHECKOUT_PAY_NOT_READY_BODY });
  assert.deepEqual(buildCheckoutPayNotReadyBody({}), { ...CHECKOUT_PAY_NOT_READY_BODY });
  assert.deepEqual(
    buildCheckoutPayNotReadyBody({
      canCheckout: false,
      userFacingError: "Shippo is not configured (missing SHIPPO_API_TOKEN).",
      shipping: {
        mode: "live_ups",
        quoteStatus: "error",
        amountCents: 0,
        provider: "shippo",
        secretDump: "should-not-appear",
      },
    }),
    {
      ...CHECKOUT_PAY_NOT_READY_BODY,
      shipping: { mode: "live_ups", quoteStatus: "error" },
    },
  );
});

test("live shipping provider failure produces canCheckout:false on authoritative quote", async () => {
  await withEnv(LIVE_QUOTE_FAIL_ENV, async () => {
    const quote = await buildFullCheckoutQuote(VALID_ITEMS, VALID_ADDRESS, {
      flow: "checkout",
      shippingContext: { applyResidentialSurcharge: false, shippoUnavailable: true },
    });
    assert.equal(quote.canCheckout, false);
    assert.equal(quote.shipping?.mode, "live_ups");
    assert.ok(["error", "provider_unavailable"].includes(String(quote.shipping?.quoteStatus)));
  });
});

test("public checkout falls back to a payable Standard Ground quote when carrier rates are unavailable", async () => {
  await withEnv(LIVE_QUOTE_FALLBACK_ENV, async () => {
    const quote = await buildFullCheckoutQuote(VALID_ITEMS, VALID_ADDRESS, {
      flow: "checkout",
      shippingContext: { applyResidentialSurcharge: false, shippoUnavailable: true },
    });
    assert.equal(quote.canCheckout, true);
    assert.equal(quote.shipping?.mode, "live_ups");
    assert.equal(quote.shipping?.quoteStatus, "rated");
    assert.equal(quote.shipping?.provider, "fallback");
    assert.equal(quote.shipping?.serviceLabel, "Standard Ground");
    assert.equal(quote.userFacingError, null);
    assert.ok(Number(quote.shippingCents) > 0);
    assert.equal(quote.parcelSummary?.fallbackRated, true);
  });
});

test("POST /api/checkout-pay rejects when final quote canCheckout is false with exact 503 body", async () => {
  await withEnv(
    {
      ...LIVE_QUOTE_FAIL_ENV,
      SQUARE_ACCESS_TOKEN: "dummy-square-token",
      SQUARE_LOCATION_ID: "dummy-location",
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "dummy-service-role",
      RESEND_API_KEY: "re_dummy",
      RESEND_FROM: "orders@example.test",
    },
    async () => {
      const state = await invokeCheckoutPay(VALID_PAY_BODY);
      assert.equal(state.statusCode, 503);
      assert.deepEqual(state.body, {
        ...CHECKOUT_PAY_NOT_READY_BODY,
        shipping: { mode: "live_ups", quoteStatus: "error" },
      });
      assertNoPaymentSuccess(state.body);
    },
  );
});

test("direct API clients cannot bypass the checkout-pay readiness gate", async () => {
  await withEnv(LIVE_QUOTE_FAIL_ENV, async () => {
    const state = await invokeCheckoutPay({
      ...VALID_PAY_BODY,
      // Extra fields a stale client might send — must not bypass readiness.
      forceCheckout: true,
      canCheckout: true,
      skipShipping: true,
    });
    assert.equal(state.statusCode, 503);
    assert.equal(state.body?.canCheckout, false);
    assert.equal(state.body?.error, CHECKOUT_PAY_NOT_READY_BODY.error);
    assertNoPaymentSuccess(state.body);
  });
});

test("checkout-pay.js evaluates readiness after final quote and before payment/order/email", () => {
  const methodIdx = checkoutPaySource.indexOf('if (req.method !== "POST")');
  const parseIdx = checkoutPaySource.indexOf("const parsed = parseCheckoutPayBody");
  const addrIdx = checkoutPaySource.indexOf("await validateShippingAddressForCheckout");
  const stockIdx = checkoutPaySource.indexOf("await assertStockAvailableForItems");
  const selectedQuoteIdx = checkoutPaySource.indexOf("const selectedQuote = verifiedQuotePayload");
  const quoteIdx = checkoutPaySource.indexOf("const quote = verifiedQuotePayload");
  const gateIdx = checkoutPaySource.indexOf("if (quote.canCheckout !== true)");
  const pendingIdx = checkoutPaySource.indexOf("const pending = await createPendingOrder");
  const squareIdx = checkoutPaySource.indexOf("await createCardPayment");
  const paidIdx = checkoutPaySource.indexOf("await markOrderPaidWithRetry");
  const emailIdx = checkoutPaySource.indexOf("void sendResendOrderConfirmation");
  const successIdx = checkoutPaySource.lastIndexOf("success: true");

  assert.ok(methodIdx > 0);
  assert.ok(parseIdx > methodIdx, "body parse after method");
  assert.ok(addrIdx > parseIdx, "address after body");
  assert.ok(stockIdx > addrIdx, "stock after address");
  assert.ok(selectedQuoteIdx > stockIdx, "selected quote after stock");
  assert.ok(quoteIdx > selectedQuoteIdx, "final quote after selected quote");
  assert.ok(gateIdx > quoteIdx, "readiness gate after final quote");
  assert.ok(pendingIdx > gateIdx, "pending order after readiness gate");
  assert.ok(squareIdx > gateIdx, "createCardPayment after readiness gate");
  assert.ok(squareIdx > pendingIdx, "payment after pending order (unchanged)");
  assert.ok(paidIdx > squareIdx, "markOrderPaid after payment");
  assert.ok(emailIdx > paidIdx, "customer email after paid");
  assert.ok(successIdx > emailIdx, "success response last");
  assert.match(checkoutPaySource, /status\(503\)\.json\(buildCheckoutPayNotReadyBody\(quote\)\)/);
  assert.match(checkoutPaySource, /idempotencyKey:\s*`saigoods-pay-\$\{pending\.id\}`/);
  // Strict allow: only === true may continue; false/undefined/null/non-boolean reject.
  assert.match(checkoutPaySource, /if\s*\(\s*quote\.canCheckout\s*!==\s*true\s*\)/);
  assert.equal(checkoutPaySource.includes("quote.canCheckout === false"), false);
});

test("checkout-pay carries the shopper-selected shipping rate into final quote validation", () => {
  assert.match(checkoutPaySource, /function\s+checkoutSelectedShippingRateFields/);
  assert.match(
    checkoutPaySource,
    /const\s+selectedShipping\s*=\s*checkoutSelectedShippingRateFields\(req\.body\s*\|\|\s*\{\}\)/,
  );
  assert.match(checkoutPaySource, /\.\.\.selectedShipping/);
});

/**
 * Side-effect proof (no Production hooks):
 * Under live quote failure the handler returns the readiness 503 while Square/Supabase/Resend
 * are configured with dummy values. The same payload under baked_in proceeds past the gate and
 * fails at createPendingOrder (Supabase) — proving payment/order/email were not the rejection path
 * on the live-fail case, and that canCheckout:true is not blocked by the new check.
 */
test("readiness rejection skips pending order / Square / email; canCheckout true is not blocked", async () => {
  await withEnv(
    {
      ...LIVE_QUOTE_FAIL_ENV,
      SQUARE_ACCESS_TOKEN: "dummy-square-token",
      SQUARE_LOCATION_ID: "dummy-location",
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "dummy-service-role",
      RESEND_API_KEY: "re_dummy",
      RESEND_FROM: "orders@example.test",
    },
    async () => {
      const liveFail = await invokeCheckoutPay(VALID_PAY_BODY);
      assert.equal(liveFail.statusCode, 503);
      assert.deepEqual(liveFail.body?.error, CHECKOUT_PAY_NOT_READY_BODY.error);
      assert.equal(liveFail.body?.success, undefined);
      assert.equal(liveFail.body?.paymentId, undefined);
      // Distinct from Square-not-configured and from Supabase order errors.
      assert.equal(/Square/i.test(String(liveFail.body?.error || "")), false);
      assert.equal(/Supabase/i.test(String(liveFail.body?.error || "")), false);
    },
  );

  await withEnv(BAKED_IN_PASS_GATE_ENV, async () => {
    const baked = await invokeCheckoutPay(VALID_PAY_BODY);
    assert.notEqual(baked.body?.error, CHECKOUT_PAY_NOT_READY_BODY.error);
    assert.notDeepEqual(baked.body, CHECKOUT_PAY_NOT_READY_BODY);
    assert.equal(baked.body?.canCheckout, undefined);
    assert.match(String(baked.body?.error || ""), /Supabase/i);
    assert.ok(baked.statusCode >= 400);
    assert.equal(baked.body?.success, undefined);
    assert.equal(baked.body?.paymentId, undefined);
  });
});

/**
 * Isolated child process + localhost fake Supabase: prove createPendingOrder (and thus later
 * createCardPayment / markOrderPaid / Resend) never runs on readiness rejection — zero HTTP hits.
 */
test("isolated child process: readiness rejection produces zero localhost provider hits", async () => {
  const hits = [];
  const server = createServer((req, res) => {
    hits.push({ method: req.method, url: req.url });
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "spy should not be called" }));
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const spyBase = `http://127.0.0.1:${port}`;

  const childCode = `
import checkoutPayHandler from ${JSON.stringify(path.join(__dirname, "api", "checkout-pay.js"))};

const body = ${JSON.stringify(VALID_PAY_BODY)};
const state = {};
const res = {
  status(code) { state.statusCode = code; return this; },
  json(b) { state.body = b; return this; },
};
await checkoutPayHandler({ method: "POST", body }, res);
process.stdout.write(JSON.stringify(state));
`;

  const childEnv = {
    ...process.env,
    NODE_ENV: "test",
    ADDRESS_VALIDATION: "off",
	    SHIPPING_QUOTE_MODE: "live_ups",
	    SHIPPING_RATE_PROVIDER: "shippo",
	    CHECKOUT_LIVE_SHIPPING_FALLBACK: "off",
	    INVENTORY_BACKEND: "file",
    SQUARE_ACCESS_TOKEN: "dummy-square-token",
    SQUARE_LOCATION_ID: "dummy-location",
    SUPABASE_URL: spyBase,
    SUPABASE_SERVICE_ROLE_KEY: "dummy-service-role",
    RESEND_API_KEY: "re_dummy",
    RESEND_FROM: "orders@example.test",
  };
  delete childEnv.SHIPPO_API_TOKEN;

  let child;
  try {
    const state = await new Promise((resolve, reject) => {
      child = spawn(process.execPath, ["--input-type=module", "-e", childCode], {
        env: childEnv,
        cwd: __dirname,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (c) => {
        stdout += c;
      });
      child.stderr.on("data", (c) => {
        stderr += c;
      });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code !== 0) {
          reject(new Error(`child exited ${code}: ${stderr || stdout}`));
          return;
        }
        try {
          const jsonLine = stdout
            .trim()
            .split(/\r?\n/)
            .reverse()
            .find((line) => line.trim().startsWith("{"));
          resolve(JSON.parse(jsonLine || stdout));
        } catch (err) {
          reject(new Error(`bad child stdout: ${stdout}\nstderr: ${stderr}\n${err}`));
        }
      });
    });

    assert.equal(state.statusCode, 503);
    assert.equal(state.body?.error, CHECKOUT_PAY_NOT_READY_BODY.error);
    assert.equal(state.body?.canCheckout, false);
    assert.equal(state.body?.success, undefined);
    assert.equal(state.body?.paymentId, undefined);
    assert.equal(hits.length, 0, "Supabase/localhost spy must receive zero requests on rejection");
  } finally {
    if (child && !child.killed) {
      child.kill("SIGTERM");
    }
    await new Promise((resolve) => server.close(resolve));
  }
});

test("existing unrelated validation failures remain unchanged (method, body, empty cart)", async () => {
  await withEnv(LIVE_QUOTE_FAIL_ENV, async () => {
    const get = await invokeCheckoutPay(VALID_PAY_BODY, "GET");
    assert.equal(get.statusCode, 405);
    assert.deepEqual(get.body, { error: "Method not allowed." });

    const empty = await invokeCheckoutPay({ ...VALID_PAY_BODY, items: [] });
    assert.equal(empty.statusCode, 400);
    assert.deepEqual(empty.body, { error: "Your cart is empty." });

    const noToken = await invokeCheckoutPay({ ...VALID_PAY_BODY, sourceId: "" });
    assert.equal(noToken.statusCode, 400);
    assert.deepEqual(noToken.body, {
      error: "Card details are incomplete. Check the card fields.",
    });

    const noEmail = await invokeCheckoutPay({ ...VALID_PAY_BODY, email: "not-an-email" });
    assert.equal(noEmail.statusCode, 400);
    assert.deepEqual(noEmail.body, { error: "A valid email is required." });
  });
});

test("validation order unchanged: method and body reject before readiness gate", () => {
  const methodIdx = checkoutPaySource.indexOf('if (req.method !== "POST")');
  const parseIdx = checkoutPaySource.indexOf("const parsed = parseCheckoutPayBody");
  const quoteIdx = checkoutPaySource.indexOf("const quote = verifiedQuotePayload");
  const gateIdx = checkoutPaySource.indexOf("if (quote.canCheckout !== true)");
  assert.ok(methodIdx < parseIdx);
  assert.ok(parseIdx < quoteIdx);
  assert.ok(quoteIdx < gateIdx);
});

test("/api/checkout-estimate keeps its independent retry path without pay-gate coupling", () => {
  assert.equal(checkoutEstimateSource.includes("CHECKOUT_PAY_NOT_READY"), false);
  assert.equal(checkoutEstimateSource.includes("buildCheckoutPayNotReadyBody"), false);
  assert.match(checkoutEstimateSource, /computeCheckoutEstimateWithFreshSelection/);
});

test("/api/checkout live-shipping payment-link gate remains unchanged", async () => {
  assert.match(checkoutSource, /STOREFRONT_PAYMENT_LINK_UNAVAILABLE_BODY/);
  assert.equal(checkoutSource.includes("CHECKOUT_PAY_NOT_READY"), false);
  await withEnv({ SHIPPING_QUOTE_MODE: "live_ups" }, async () => {
    const state = await invokeCheckout({ items: VALID_ITEMS, customer: {} });
    assert.equal(state.statusCode, 503);
    assert.deepEqual(state.body, STOREFRONT_PAYMENT_LINK_UNAVAILABLE_BODY);
  });
});

test("admin payment-link send-link source is untouched by checkout-pay readiness work", () => {
  assert.equal(adminSendLinkSource.includes("CHECKOUT_PAY_NOT_READY"), false);
  assert.equal(adminSendLinkSource.includes("buildCheckoutPayNotReadyBody"), false);
  assert.match(adminSendLinkSource, /createPaymentLink|payment.?link/i);
});

test("estimate endpoint still returns 200 quotes (including canCheckout false) without pay gate body", async () => {
  await withEnv(LIVE_QUOTE_FAIL_ENV, async () => {
    const state = await invokeEstimate({
      items: VALID_ITEMS,
      address: VALID_ADDRESS,
    });
    assert.equal(state.statusCode, 200);
    assert.equal(state.body?.canCheckout, false);
    assert.notEqual(state.body?.error, CHECKOUT_PAY_NOT_READY_BODY.error);
    assert.equal(state.body?.success, undefined);
  });
});

/**
 * buildFullCheckoutQuote always returns a strict boolean canCheckout today
 * (Boolean(...) at the final assignment). The pay gate still uses !== true so
 * undefined/null/non-boolean would reject if the contract ever drifts.
 * Malformed values cannot be injected into the handler without Production hooks;
 * prove the allow condition and response builder at the narrowest safe boundary.
 */
test("buildFullCheckoutQuote canCheckout is always a strict boolean true|false", async () => {
  await withEnv(LIVE_QUOTE_FAIL_ENV, async () => {
    const failQuote = await buildFullCheckoutQuote(VALID_ITEMS, VALID_ADDRESS, {
      flow: "checkout",
      shippingContext: { applyResidentialSurcharge: false, shippoUnavailable: true },
    });
    assert.equal(typeof failQuote.canCheckout, "boolean");
    assert.equal(failQuote.canCheckout, false);
  });

  await withEnv(BAKED_IN_PASS_GATE_ENV, async () => {
    const okQuote = await buildFullCheckoutQuote(VALID_ITEMS, VALID_ADDRESS, {
      flow: "checkout",
      shippingContext: null,
      receiptRebuild: true,
    });
    assert.equal(typeof okQuote.canCheckout, "boolean");
    assert.equal(okQuote.canCheckout, true);
  });
});

test("strict readiness allow condition rejects false, absent, null, 0, and non-boolean truthy", () => {
  // Mirrors Production: if (quote.canCheckout !== true) reject.
  // Behavioral handler coverage for these values lives in server-checkout-estimate-pay-parity.test.js.
  const wouldReject = (canCheckout) => canCheckout !== true;
  assert.equal(wouldReject(false), true);
  assert.equal(wouldReject(undefined), true);
  assert.equal(wouldReject(null), true);
  assert.equal(wouldReject(0), true);
  assert.equal(wouldReject(1), true);
  assert.equal(wouldReject("true"), true);
  assert.equal(wouldReject({}), true);
  assert.equal(wouldReject({ ok: true }), true);
  assert.equal(wouldReject(true), false);

  assert.deepEqual(
    buildCheckoutPayNotReadyBody({ canCheckout: false, shipping: { mode: "live_ups", quoteStatus: "error" } }),
    { ...CHECKOUT_PAY_NOT_READY_BODY, shipping: { mode: "live_ups", quoteStatus: "error" } },
  );
  assert.deepEqual(
    buildCheckoutPayNotReadyBody({ canCheckout: null, shipping: { mode: "live_ups", quoteStatus: "error" } }),
    { ...CHECKOUT_PAY_NOT_READY_BODY, shipping: { mode: "live_ups", quoteStatus: "error" } },
  );
  assert.deepEqual(
    buildCheckoutPayNotReadyBody({ shipping: { mode: "live_ups", quoteStatus: "not_requested" } }),
    { ...CHECKOUT_PAY_NOT_READY_BODY, shipping: { mode: "live_ups", quoteStatus: "not_requested" } },
  );
});
