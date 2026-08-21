import test from "node:test";
import assert from "node:assert/strict";

import {
  buildTapToPayUrls,
  createTapToPayState,
  retrieveTapToPayPayment,
  tapToPayConfig,
  verifyTapToPayState,
} from "./tap-to-pay.js";

const secret = "test-secret-that-is-longer-than-thirty-two-characters";
const actorEmail = "admin@example.test";

function readyEnv(overrides = {}) {
  return {
    VERCEL_ENV: "preview",
    TAP_TO_PAY_STAGING_ENABLED: "true",
    TAP_TO_PAY_ISOLATED_DATA_ACK: "staging",
    TAP_TO_PAY_SQUARE_APPLICATION_ID: "sq0idp-test",
    TAP_TO_PAY_SQUARE_LOCATION_ID: "location-test",
    TAP_TO_PAY_SQUARE_ACCESS_TOKEN: "token-test",
    TAP_TO_PAY_CALLBACK_URL: "https://preview.example.test/admin-v2.5/orders",
    TAP_TO_PAY_STATE_SECRET: secret,
    TAP_TO_PAY_ADMIN_EMAILS: actorEmail,
    ...overrides,
  };
}

test("Tap to Pay is hard-blocked in production even when requested", () => {
  const config = tapToPayConfig(readyEnv({ VERCEL_ENV: "production" }));
  assert.equal(config.enabled, false);
  assert.equal(config.reason, "production_blocked");
});

test("Tap to Pay requires an explicit isolated staging-data acknowledgement", () => {
  const config = tapToPayConfig(readyEnv({ TAP_TO_PAY_ISOLATED_DATA_ACK: "" }));
  assert.equal(config.enabled, false);
  assert.equal(config.reason, "isolated_data_not_acknowledged");
});

test("signed state binds order, total, actor, and expiry", () => {
  const state = createTapToPayState(
    { orderId: "42", amountCents: 1250, actorEmail, now: 1_000, nonce: "fixed" },
    secret,
  );
  assert.deepEqual(verifyTapToPayState(state, secret, { now: 2_000, actorEmail }), {
    v: 1,
    oid: "42",
    amt: 1250,
    actor: actorEmail,
    exp: 901_000,
    nonce: "fixed",
  });
  assert.throws(() => verifyTapToPayState(`${state}x`, secret, { now: 2_000, actorEmail }), /invalid or expired/i);
  assert.throws(() => verifyTapToPayState(state, secret, { now: 2_000, actorEmail: "other@example.test" }), /invalid or expired/i);
  assert.throws(() => verifyTapToPayState(state, secret, { now: 901_001, actorEmail }), /invalid or expired/i);
});

test("Square handoff URLs lock card tender, amount, location, callback, note, and state", () => {
  const config = tapToPayConfig(readyEnv());
  const urls = buildTapToPayUrls({ config, orderId: "42", orderRef: "SAI-TEST", amountCents: 1250, state: "signed.state" });
  assert.match(urls.androidUrl, /TOTAL_AMOUNT=1250/);
  assert.match(urls.androidUrl, /TENDER_TYPES=com\.squareup\.pos\.TENDER_CARD/);
  assert.match(urls.androidUrl, /LOCATION_ID=location-test/);
  assert.match(urls.androidUrl, /REQUEST_METADATA=signed.state/);
  const ios = JSON.parse(decodeURIComponent(urls.iosUrl.split("data=")[1]));
  assert.deepEqual(ios.amount_money, { amount: "1250", currency_code: "USD" });
  assert.equal(ios.location_id, "location-test");
  assert.equal(ios.state, "signed.state");
  assert.deepEqual(ios.options.supported_tender_types, ["CREDIT_CARD"]);
  assert.match(ios.notes, /Order 42 from SAI Goods Tap to Pay/);
});

test("Square lookup rejects a mismatched location before retrieving payment", async () => {
  const config = tapToPayConfig(readyEnv());
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return new Response(JSON.stringify({ order: { location_id: "wrong", tenders: [{ payment_id: "payment-1" }] } }), { status: 200 });
  };
  await assert.rejects(() => retrieveTapToPayPayment("transaction-1", config, fetchImpl), /location does not match/i);
  assert.equal(calls, 1);
});

test("Square lookup retrieves the payment through the returned order tender", async () => {
  const config = tapToPayConfig(readyEnv());
  const requests = [];
  const fetchImpl = async (url) => {
    requests.push(url);
    if (url.includes("/orders/")) {
      return new Response(JSON.stringify({ order: { location_id: "location-test", tenders: [{ payment_id: "payment-1" }] } }), { status: 200 });
    }
    return new Response(JSON.stringify({ payment: { id: "payment-1", status: "COMPLETED" } }), { status: 200 });
  };
  const result = await retrieveTapToPayPayment("transaction-1", config, fetchImpl);
  assert.equal(result.payment.id, "payment-1");
  assert.equal(requests.length, 2);
});
