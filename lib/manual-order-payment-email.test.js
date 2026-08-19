import test from "node:test";
import assert from "node:assert/strict";

import { buildManualPaymentLinkHtml } from "./manual-order-payment-email.js";

test("manual payment email states the enforced payment-link window", () => {
  const html = buildManualPaymentLinkHtml({
    customerName: "Customer",
    orderRef: "SAI-TEST",
    totalFormatted: "$10.00",
    checkoutUrl: "https://example.com/pay",
  });

  assert.match(html, /available for up to <strong[^>]*>48 hours<\/strong> from when it was first issued/);
});
