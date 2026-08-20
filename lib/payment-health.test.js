import assert from "node:assert/strict";
import test from "node:test";

import { paymentRuntimeReadiness } from "./payment-health.js";

const PAYMENT_ENV_KEYS = [
  "SQUARE_ENVIRONMENT",
  "SQUARE_ACCESS_TOKEN",
  "SQUARE_APPLICATION_ID",
  "SQUARE_LOCATION_ID",
  "SQUARE_WEBHOOK_SIGNATURE_KEY",
  "SQUARE_WEBHOOK_SIGNATURE_KEY_SANDBOX",
  "PUBLIC_BASE_URL",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SHIPPING_QUOTE_MODE",
  "RESEND_API_KEY",
  "RESEND_FROM",
];

function withPaymentEnv(values, run) {
  const saved = Object.fromEntries(PAYMENT_ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of PAYMENT_ENV_KEYS) delete process.env[key];
  Object.assign(process.env, values);
  try {
    run();
  } finally {
    for (const key of PAYMENT_ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

test("payment readiness reports a complete sandbox embedded-checkout configuration without exposing secrets", () => {
  withPaymentEnv({
    SQUARE_ENVIRONMENT: "sandbox",
    SQUARE_ACCESS_TOKEN: "sandbox-secret-token",
    SQUARE_APPLICATION_ID: "sandbox-app-id",
    SQUARE_LOCATION_ID: "sandbox-location-id",
    SQUARE_WEBHOOK_SIGNATURE_KEY_SANDBOX: "sandbox-webhook-secret",
    PUBLIC_BASE_URL: "https://store.example.test",
    SUPABASE_URL: "https://database.example.test",
    SUPABASE_SERVICE_ROLE_KEY: "database-secret",
    RESEND_API_KEY: "resend-secret",
    RESEND_FROM: "SAI Goods <sales@example.test>",
  }, () => {
    const readiness = paymentRuntimeReadiness();
    assert.equal(readiness.environment, "sandbox");
    assert.equal(readiness.environmentConfigured, true);
    assert.equal(readiness.sandboxPolicyCompliant, true);
    assert.equal(readiness.coreConfigured, true);
    assert.equal(readiness.webhookSignatureConfigured, true);
    assert.equal(readiness.embeddedCheckoutReady, true);
    assert.equal(readiness.paymentLinkEmailReady, true);
    assert.equal(JSON.stringify(readiness).includes("sandbox-secret-token"), false);
    assert.equal(JSON.stringify(readiness).includes("sandbox-webhook-secret"), false);
    assert.equal(JSON.stringify(readiness).includes("resend-secret"), false);
  });
});

test("payment-link email readiness requires both Resend settings", () => {
  withPaymentEnv({ RESEND_API_KEY: "configured" }, () => {
    assert.equal(paymentRuntimeReadiness().paymentLinkEmailReady, false);
  });
  withPaymentEnv({ RESEND_API_KEY: "configured", RESEND_FROM: "sales@example.test" }, () => {
    assert.equal(paymentRuntimeReadiness().paymentLinkEmailReady, true);
  });
});

test("sandbox readiness requires the sandbox webhook signature, not the production signature", () => {
  withPaymentEnv({
    SQUARE_ENVIRONMENT: "sandbox",
    SQUARE_ACCESS_TOKEN: "configured",
    SQUARE_APPLICATION_ID: "configured",
    SQUARE_LOCATION_ID: "configured",
    SQUARE_WEBHOOK_SIGNATURE_KEY: "production-only",
    PUBLIC_BASE_URL: "https://store.example.test",
    SUPABASE_URL: "https://database.example.test",
    SUPABASE_SERVICE_ROLE_KEY: "configured",
    SHIPPING_QUOTE_MODE: "baked_in",
  }, () => {
    const readiness = paymentRuntimeReadiness();
    assert.equal(readiness.webhookSignatureConfigured, false);
    assert.equal(readiness.embeddedCheckoutReady, false);
  });
});

test("production readiness uses active production credentials while retaining the legacy sandbox-policy signal", () => {
  withPaymentEnv({
    SQUARE_ENVIRONMENT: "production",
    SQUARE_ACCESS_TOKEN: "configured",
    SQUARE_APPLICATION_ID: "configured",
    SQUARE_LOCATION_ID: "configured",
    SQUARE_WEBHOOK_SIGNATURE_KEY: "configured",
    PUBLIC_BASE_URL: "https://store.example.test",
    SUPABASE_URL: "https://database.example.test",
    SUPABASE_SERVICE_ROLE_KEY: "configured",
    SHIPPING_QUOTE_MODE: "baked_in",
  }, () => {
    const readiness = paymentRuntimeReadiness();
    assert.equal(readiness.environment, "production");
    assert.equal(readiness.environmentConfigured, true);
    assert.equal(readiness.sandboxPolicyCompliant, false);
    assert.equal(readiness.coreConfigured, true);
    assert.equal(readiness.embeddedCheckoutReady, true);
    assert.equal(readiness.paymentLinkReady, true);
  });
});

test("missing Square environment is reported as unconfigured", () => {
  withPaymentEnv({}, () => {
    const readiness = paymentRuntimeReadiness();
    assert.equal(readiness.environment, "missing");
    assert.equal(readiness.environmentConfigured, false);
    assert.equal(readiness.sandboxPolicyCompliant, false);
    assert.equal(readiness.coreConfigured, false);
    assert.equal(readiness.embeddedCheckoutReady, false);
    assert.equal(readiness.paymentLinkReady, false);
  });
});

test("payment-link readiness follows the checkout shipping-mode safeguard", () => {
  const base = {
    SQUARE_ENVIRONMENT: "sandbox",
    SQUARE_ACCESS_TOKEN: "configured",
    SQUARE_LOCATION_ID: "configured",
    SQUARE_WEBHOOK_SIGNATURE_KEY_SANDBOX: "configured",
    PUBLIC_BASE_URL: "https://store.example.test",
    SUPABASE_URL: "https://database.example.test",
    SUPABASE_SERVICE_ROLE_KEY: "configured",
  };
  withPaymentEnv({ ...base, SHIPPING_QUOTE_MODE: "live_ups" }, () => {
    assert.equal(paymentRuntimeReadiness().paymentLinkReady, false);
  });
  withPaymentEnv({ ...base, SHIPPING_QUOTE_MODE: "baked_in" }, () => {
    assert.equal(paymentRuntimeReadiness().paymentLinkReady, true);
  });
});
