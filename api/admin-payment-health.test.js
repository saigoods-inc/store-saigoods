import assert from "node:assert/strict";
import test from "node:test";

import handler from "./admin-payment-health.js";

function responseCapture() {
  return {
    statusCode: 0,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

test("authenticated payment health returns safe sandbox readiness without credential values", async () => {
  const saved = { ...process.env };
  Object.assign(process.env, {
    INTERNAL_REPORTS_SECRET: "admin-health-secret",
    ALLOW_INSECURE_LOCAL_ADMIN_API: "false",
    SQUARE_ENVIRONMENT: "sandbox",
    SQUARE_ACCESS_TOKEN: "private-square-token",
    SQUARE_APPLICATION_ID: "configured",
    SQUARE_LOCATION_ID: "configured",
    SQUARE_WEBHOOK_SIGNATURE_KEY_SANDBOX: "private-webhook-secret",
    PUBLIC_BASE_URL: "https://store.example.test",
    SUPABASE_URL: "https://database.example.test",
    SUPABASE_SERVICE_ROLE_KEY: "private-database-secret",
    RESEND_API_KEY: "private-resend-secret",
    RESEND_FROM: "SAI Goods <sales@example.test>",
  });
  const res = responseCapture();
  try {
    await handler({ method: "GET", headers: { authorization: "Bearer admin-health-secret" } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.runtime.environment, "sandbox");
    assert.equal(res.body.runtime.embeddedCheckoutReady, true);
    assert.equal(res.body.runtime.paymentLinkEmailReady, true);
    const serialized = JSON.stringify(res.body);
    assert.equal(serialized.includes("private-square-token"), false);
    assert.equal(serialized.includes("private-webhook-secret"), false);
    assert.equal(serialized.includes("private-database-secret"), false);
    assert.equal(serialized.includes("private-resend-secret"), false);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});

test("payment health rejects unsupported methods before reading configuration", async () => {
  const res = responseCapture();
  await handler({ method: "POST", headers: {} }, res);
  assert.equal(res.statusCode, 405);
  assert.deepEqual(res.body, { error: "Method not allowed." });
});
