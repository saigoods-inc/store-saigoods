import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import cartQuoteHandler from "./api/cart-quote.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverSource = readFileSync(path.join(__dirname, "server.js"), "utf8");
const stylesSource = readFileSync(path.join(__dirname, "public", "css", "styles.css"), "utf8");

/** Deterministic file-backed stock for cart-quote behavior tests. */
process.env.INVENTORY_BACKEND = "file";

const SLUG = "black-nitrile-general";

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

/** Mirrors server.js Express → Vercel adaptation for POST /api/cart/quote. */
async function invokeLocalCartQuote(body) {
  const res = mockRes();
  await cartQuoteHandler({ method: "POST", body }, res);
  return res.state;
}

test("server.js delegates POST /api/checkout to api/checkout.js", () => {
  assert.match(
    serverSource,
    /import\s+checkoutHandler\s+from\s+["']\.\/api\/checkout\.js["']/,
  );
  assert.match(
    serverSource,
    /pathname\s*===\s*["']\/api\/checkout["']\s*&&\s*req\.method\s*===\s*["']POST["']/,
  );
  assert.match(serverSource, /await\s+checkoutHandler\s*\(/);
});

test("server.js delegates POST /api/cart/quote to api/cart-quote.js", () => {
  assert.match(
    serverSource,
    /import\s+cartQuoteHandler\s+from\s+["']\.\/api\/cart-quote\.js["']/,
  );
  assert.match(
    serverSource,
    /pathname\s*===\s*["']\/api\/cart\/quote["']\s*&&\s*req\.method\s*===\s*["']POST["']/,
  );
  assert.match(serverSource, /await\s+cartQuoteHandler\s*\(/);
  assert.match(serverSource, /adaptExpressStyleResponse\s*\(\s*res\s*\)/);
});

test("server.js no longer inlines cart quote build/enrich logic", () => {
  assert.equal(serverSource.includes("enrichCartQuoteApiResponse"), false);
  assert.equal(serverSource.includes('from "./lib/quote.js"'), false);
  assert.equal(serverSource.includes("from './lib/quote.js'"), false);
  assert.equal(
    /buildQuote\s*\(\s*body\.items\s*,\s*\{\s*omitShippingEstimate\s*:\s*true\s*\}\s*\)/.test(
      serverSource,
    ),
    false,
  );
});

test("server.js no longer contains legacy Stripe checkout code", () => {
  assert.equal(serverSource.includes("STRIPE_SECRET_KEY"), false);
  assert.equal(serverSource.includes("api.stripe.com"), false);
  assert.equal(serverSource.includes("checkout/sessions"), false);
  assert.equal(serverSource.includes("stripeReady"), false);
  assert.equal(serverSource.includes("createCheckoutSession"), false);
});

test("styles.css no longer references Checkout with Stripe", () => {
  assert.equal(stylesSource.includes("Checkout with Stripe"), false);
});

test("local cart quote: valid cart returns enriched quote shape", async () => {
  const state = await invokeLocalCartQuote({
    items: [
      {
        slug: SLUG,
        bundleLines: [{ id: "box_1", qty: 1 }],
        quantities: {},
        boxQuantities: { M: 1, L: 0 },
      },
    ],
  });

  assert.equal(state.statusCode, 200);
  assert.ok(Array.isArray(state.body.items));
  assert.equal(state.body.items.length, 1);
  assert.equal(state.body.items[0].slug, SLUG);
  assert.equal(typeof state.body.subtotalCents, "number");
  assert.equal(typeof state.body.subtotalFormatted, "string");
  assert.equal(typeof state.body.totalCents, "number");
  assert.equal(typeof state.body.useEmbeddedCheckout, "boolean");
  assert.equal(typeof state.body.squareReady, "boolean");
  assert.equal(typeof state.body.checkoutReady, "boolean");
  assert.equal(state.body.shippingQuoteComplete, true);
});

test("local cart quote: unsupported size allocation is rejected like Vercel", async () => {
  const state = await invokeLocalCartQuote({
    items: [
      {
        slug: SLUG,
        bundleLines: [{ id: "box_1", qty: 1 }],
        quantities: {},
        boxQuantities: { S: 1, M: 0, L: 0, XL: 0 },
      },
    ],
  });

  assert.equal(state.statusCode, 400);
  assert.equal(
    state.body.error,
    "Selected bundle has no valid supported size allocation. Please choose a supported size.",
  );
});

test("local cart quote: a-la-carte unsupported size is rejected like Vercel", async () => {
  const state = await invokeLocalCartQuote({
    items: [
      {
        slug: SLUG,
        boxQuantities: { S: 1, M: 0, L: 0 },
      },
    ],
  });

  assert.equal(state.statusCode, 400);
  assert.match(state.body.error, /Quantity is set on sizes this product does not offer/);
});

test("local cart quote: package limit blocks an oversized cart before stock lookup", async () => {
  const state = await invokeLocalCartQuote({
    items: [
      {
        slug: SLUG,
        bundleLines: [{ id: "case_1", qty: 9999 }],
        quantities: { M: 9999, L: 0 },
        boxQuantities: {},
      },
    ],
  });

  assert.equal(state.statusCode, 200);
  assert.equal(state.body.canCheckout, false);
  assert.equal(state.body.shippingPackageLimit?.exceeded, true);
  assert.ok(Number(state.body.shippingPackageLimit?.packageCount) > Number(state.body.shippingPackageLimit?.maxPackages));
});

test("local cart quote: empty items returns empty quote", async () => {
  const state = await invokeLocalCartQuote({ items: [] });

  assert.equal(state.statusCode, 200);
  assert.deepEqual(state.body.items, []);
  assert.equal(state.body.subtotalCents, 0);
  assert.equal(state.body.totalCases, 0);
  assert.equal(typeof state.body.useEmbeddedCheckout, "boolean");
});

test("local cart quote: missing or non-array items treated as empty cart", async () => {
  const missing = await invokeLocalCartQuote({});
  assert.equal(missing.statusCode, 200);
  assert.deepEqual(missing.body.items, []);

  const malformed = await invokeLocalCartQuote({ items: { not: "an-array" } });
  assert.equal(malformed.statusCode, 200);
  assert.deepEqual(malformed.body.items, []);
});

test("local cart quote: non-POST method is rejected by handler", async () => {
  const res = mockRes();
  await cartQuoteHandler({ method: "GET", body: {} }, res);
  assert.equal(res.state.statusCode, 405);
  assert.deepEqual(res.state.body, { error: "Method not allowed." });
});
