import test from "node:test";
import assert from "node:assert/strict";

import { isExpiredManualOrderPaymentLink } from "./admin-manual-order-prepare-edit.js";

test("expired payment-link status is eligible even after the cron resets the order to draft", () => {
  assert.equal(isExpiredManualOrderPaymentLink({ payment_link_status: "expired" }, 1_000), true);
});

test("an active payment link cannot enter the edit flow", () => {
  assert.equal(
    isExpiredManualOrderPaymentLink({ payment_link_status: "active", payment_link_expires_at: "2026-08-20T20:00:00.000Z" }, Date.parse("2026-08-20T19:00:00.000Z")),
    false,
  );
});

test("a link at its expiration time can enter the edit flow", () => {
  const expiresAt = "2026-08-20T20:00:00.000Z";
  assert.equal(isExpiredManualOrderPaymentLink({ payment_link_expires_at: expiresAt }, Date.parse(expiresAt)), true);
});

test("a future link is not treated as expired even when it has an active status", () => {
  assert.equal(
    isExpiredManualOrderPaymentLink(
      { payment_link_status: "active", payment_link_expires_at: "2026-08-20T20:00:00.001Z" },
      Date.parse("2026-08-20T20:00:00.000Z"),
    ),
    false,
  );
});
