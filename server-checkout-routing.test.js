import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverSource = readFileSync(path.join(__dirname, "server.js"), "utf8");
const stylesSource = readFileSync(path.join(__dirname, "public", "css", "styles.css"), "utf8");

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
