import assert from "node:assert/strict";
import test from "node:test";
import { MANUAL_PAYMENT_LINK_VALID_MS, issueManualPaymentAccessToken, verifyManualPaymentAccessToken } from "./manual-payment-link-access.js";

test("manual payment access token is valid for 48 hours and then expires", () => {
  const prior = process.env.MANUAL_PAYMENT_LINK_SIGNING_SECRET;
  process.env.MANUAL_PAYMENT_LINK_SIGNING_SECRET = "test-payment-link-secret";
  try {
    const now = Date.UTC(2026, 7, 18, 1, 0, 0);
    const expiresAt = new Date(now + MANUAL_PAYMENT_LINK_VALID_MS).toISOString();
    const token = issueManualPaymentAccessToken({ orderId: "42", expiresAt });
    assert.equal(verifyManualPaymentAccessToken(token, now + MANUAL_PAYMENT_LINK_VALID_MS - 1).ok, true);
    assert.equal(verifyManualPaymentAccessToken(token, now + MANUAL_PAYMENT_LINK_VALID_MS + 1).reason, "expired");
  } finally {
    if (prior == null) delete process.env.MANUAL_PAYMENT_LINK_SIGNING_SECRET;
    else process.env.MANUAL_PAYMENT_LINK_SIGNING_SECRET = prior;
  }
});
