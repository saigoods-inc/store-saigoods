import test from "node:test";
import assert from "node:assert/strict";

import {
  buildManualPaymentLinkEmailAttachments,
  buildManualPaymentLinkHtml,
} from "./manual-order-payment-email.js";

test("manual payment email states the enforced payment-link window", () => {
  const html = buildManualPaymentLinkHtml({
    customerName: "Customer",
    orderRef: "SAI-TEST",
    totalFormatted: "$10.00",
    checkoutUrl: "https://example.com/pay",
  });

  assert.match(html, /available for up to <strong[^>]*>48 hours<\/strong> from when it was first issued/);
});

test("manual B2B payment email attaches the validated invoice PDF", () => {
  assert.deepEqual(
    buildManualPaymentLinkEmailAttachments({
      filename: "customer-invoice.pdf",
      content: "JVBERi0xLjQ=",
    }),
    [{
      filename: "customer-invoice.pdf",
      content: "JVBERi0xLjQ=",
      contentType: "application/pdf",
    }],
  );
  assert.equal(buildManualPaymentLinkEmailAttachments(null), undefined);
});
