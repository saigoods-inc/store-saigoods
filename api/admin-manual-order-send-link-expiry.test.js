import assert from "node:assert/strict";
import test from "node:test";
import { deliverManualOrderPaymentLink } from "./admin-manual-order-send-link.js";

test("manual payment email receives only the signed 48-hour access URL", async () => {
  const previous = {
    PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL,
    MANUAL_PAYMENT_LINK_SIGNING_SECRET: process.env.MANUAL_PAYMENT_LINK_SIGNING_SECRET,
  };
  process.env.PUBLIC_BASE_URL = "https://store.example.test";
  process.env.MANUAL_PAYMENT_LINK_SIGNING_SECRET = "test-only-secret";
  const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
  let emailedUrl = "";
  try {
    const result = await deliverManualOrderPaymentLink({
      claimed: false,
      orderId: "42",
      createPaymentLinkFn: async () => ({
        checkoutUrl: "https://square.example.test/raw-provider-link",
        paymentLinkId: "square-link-42",
      }),
      persistPaymentLinkFn: async () => ({ payment_link_expires_at: expiresAt }),
      sendEmailFn: async ({ checkoutUrl }) => {
        emailedUrl = checkoutUrl;
        return true;
      },
      createPaymentLinkArgs: {},
      sendEmailArgs: {},
    });
    assert.equal(result.status, 200);
    assert.equal(result.body.expiresInHours, 48);
    assert.match(emailedUrl, /^https:\/\/store\.example\.test\/api\/manual-order-payment\?token=/);
    assert.equal(emailedUrl.includes("square.example.test"), false);
    assert.equal(result.body.checkoutUrl, emailedUrl);
  } finally {
    if (previous.PUBLIC_BASE_URL === undefined) delete process.env.PUBLIC_BASE_URL;
    else process.env.PUBLIC_BASE_URL = previous.PUBLIC_BASE_URL;
    if (previous.MANUAL_PAYMENT_LINK_SIGNING_SECRET === undefined) delete process.env.MANUAL_PAYMENT_LINK_SIGNING_SECRET;
    else process.env.MANUAL_PAYMENT_LINK_SIGNING_SECRET = previous.MANUAL_PAYMENT_LINK_SIGNING_SECRET;
  }
});

test("manual payment delivery fails closed when expiry access signing is unavailable", async () => {
  const keys = [
    "PUBLIC_BASE_URL",
    "MANUAL_PAYMENT_LINK_SIGNING_SECRET",
    "CHECKOUT_QUOTE_SIGNING_SECRET",
    "SQUARE_ACCESS_TOKEN",
    "SUPABASE_SERVICE_ROLE_KEY",
  ];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  let emailed = false;
  try {
    const result = await deliverManualOrderPaymentLink({
      claimed: false,
      orderId: "42",
      createPaymentLinkFn: async () => ({
        checkoutUrl: "https://square.example.test/raw-provider-link",
        paymentLinkId: "square-link-42",
      }),
      persistPaymentLinkFn: async () => ({
        payment_link_expires_at: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
      }),
      sendEmailFn: async () => {
        emailed = true;
        return true;
      },
      createPaymentLinkArgs: {},
      sendEmailArgs: {},
    });
    assert.equal(result.status, 503);
    assert.equal(result.body.checkoutUrl, undefined);
    assert.equal(emailed, false);
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});
