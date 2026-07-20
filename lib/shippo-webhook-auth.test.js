import assert from "node:assert/strict";
import test from "node:test";
import { evaluateShippoWebhookAuth, handleShippoWebhook } from "./shippo-webhook-handler.js";

const BASE_ENV = {
  NODE_ENV: "test",
  VERCEL: undefined,
  SHIPPO_WEBHOOK_TOKEN: undefined,
  ALLOW_INSECURE_LOCAL_SHIPPO_WEBHOOK: undefined,
};

/** @type {NodeJS.ProcessEnv} */
let savedEnv = null;

function saveEnv() {
  savedEnv = { ...process.env };
}

function restoreEnv() {
  if (!savedEnv) {
    return;
  }
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, savedEnv);
  savedEnv = null;
}

/**
 * @param {Record<string, string | undefined>} patch
 */
function applyEnv(patch) {
  for (const [key, value] of Object.entries({ ...BASE_ENV, ...patch })) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

/**
 * @param {object} [opts]
 * @param {string} [opts.token]
 * @param {string} [opts.headerToken]
 * @param {string} [opts.queryToken]
 */
function webhookReq(opts = {}) {
  const headers = {};
  if (opts.headerToken) {
    headers["x-shippo-webhook-token"] = opts.headerToken;
  }
  const queryToken = opts.queryToken ?? opts.token;
  return {
    method: "POST",
    headers,
    query: queryToken ? { token: queryToken } : {},
    url: queryToken ? `/api/webhooks/shippo?token=${encodeURIComponent(queryToken)}` : "/api/webhooks/shippo",
    body: {
      event: "track_updated",
      data: { object_id: "evt_1", tracking_number: "1ZTEST" },
    },
  };
}

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

test.beforeEach(() => {
  saveEnv();
});

test.afterEach(() => {
  restoreEnv();
});

test("production + missing server token is rejected before processing", async () => {
  applyEnv({ NODE_ENV: "production" });
  const result = evaluateShippoWebhookAuth(webhookReq());
  assert.deepEqual(result, {
    ok: false,
    status: 503,
    error: "Shippo webhook authentication is not configured.",
  });
});

test("production + server token configured + incoming token missing is rejected", async () => {
  applyEnv({
    NODE_ENV: "production",
    SHIPPO_WEBHOOK_TOKEN: "server-token",
  });
  const result = evaluateShippoWebhookAuth(webhookReq());
  assert.deepEqual(result, { ok: false, status: 401, error: "Unauthorized." });
});

test("production + invalid incoming token is rejected", async () => {
  applyEnv({
    NODE_ENV: "production",
    SHIPPO_WEBHOOK_TOKEN: "server-token",
  });
  const result = evaluateShippoWebhookAuth(webhookReq({ token: "wrong-token" }));
  assert.deepEqual(result, { ok: false, status: 403, error: "Forbidden." });
});

test("production + valid incoming token is allowed", async () => {
  applyEnv({
    NODE_ENV: "production",
    SHIPPO_WEBHOOK_TOKEN: "server-token",
  });
  const result = evaluateShippoWebhookAuth(webhookReq({ token: "server-token" }));
  assert.deepEqual(result, { ok: true });
});

test("vercel runtime follows production behavior", async () => {
  applyEnv({
    VERCEL: "1",
    SHIPPO_WEBHOOK_TOKEN: "server-token",
  });
  assert.deepEqual(evaluateShippoWebhookAuth(webhookReq()), {
    ok: false,
    status: 401,
    error: "Unauthorized.",
  });
  assert.deepEqual(evaluateShippoWebhookAuth(webhookReq({ token: "server-token" })), { ok: true });
});

test("local token configured + valid token is allowed", async () => {
  applyEnv({
    NODE_ENV: "development",
    SHIPPO_WEBHOOK_TOKEN: "local-token",
  });
  assert.deepEqual(evaluateShippoWebhookAuth(webhookReq({ headerToken: "local-token" })), { ok: true });
});

test("local token configured + invalid token is rejected", async () => {
  applyEnv({
    NODE_ENV: "development",
    SHIPPO_WEBHOOK_TOKEN: "local-token",
  });
  assert.deepEqual(evaluateShippoWebhookAuth(webhookReq({ token: "bad-token" })), {
    ok: false,
    status: 403,
    error: "Forbidden.",
  });
});

test("local token absent does not allow access by default", async () => {
  applyEnv({ NODE_ENV: "development" });
  assert.deepEqual(evaluateShippoWebhookAuth(webhookReq({ token: "anything" })), {
    ok: false,
    status: 503,
    error: "Shippo webhook authentication is not configured.",
  });
});

test("explicit local bypass works only locally", async () => {
  applyEnv({
    NODE_ENV: "development",
    ALLOW_INSECURE_LOCAL_SHIPPO_WEBHOOK: "true",
  });
  assert.deepEqual(evaluateShippoWebhookAuth(webhookReq()), { ok: true });
});

test("explicit local bypass is ignored in production", async () => {
  applyEnv({
    NODE_ENV: "production",
    ALLOW_INSECURE_LOCAL_SHIPPO_WEBHOOK: "true",
    SHIPPO_WEBHOOK_TOKEN: "server-token",
  });
  assert.deepEqual(evaluateShippoWebhookAuth(webhookReq()), {
    ok: false,
    status: 401,
    error: "Unauthorized.",
  });
});

test("unauthorized requests do not write webhook events or update orders", async () => {
  applyEnv({
    NODE_ENV: "production",
    SHIPPO_WEBHOOK_TOKEN: "server-token",
  });

  const res = mockRes();
  await handleShippoWebhook(
    {
      method: "POST",
      headers: {},
      query: { token: "wrong-token" },
      url: "/api/webhooks/shippo?token=wrong-token",
      body: "not-json",
    },
    res,
  );

  assert.equal(res.state.statusCode, 403);
  assert.deepEqual(res.state.body, { error: "Forbidden." });
});
