import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildVendorPaidOrderHtml,
  buildVendorPaidOrderSubject,
  buildVendorPaidOrderText,
  sendVendorPaidOrderNotificationIfNeeded,
  vendorPaidNotificationIdempotencyKey,
} from "./vendor-paid-order-notification.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SAMPLE_ORDER = {
  id: "order-uuid-1",
  order_ref: "SAI-ABC123",
  payment_id: "pay_square_99",
  customer_name: "Jane Buyer",
  customer_email: "jane@example.test",
  customer_phone: "7315550100",
  customer_address: "123 Main St, Savannah, TN 38372",
  items: [
    {
      name: "Black Nitrile Gloves",
      slug: "black-nitrile-general",
      lineCases: 2,
      quantities: { M: 2 },
      boxQuantities: { M: 0 },
      lineTotalFormatted: "$120.00",
    },
  ],
  subtotal_cents: 10000,
  shipping_cents: 1500,
  tax_cents: 500,
  total_cents: 12000,
};

test("buildVendorPaidOrderText is operational and omits developer-facing identifiers", () => {
  const text = buildVendorPaidOrderText(SAMPLE_ORDER);

  assert.match(text, /NEW ORDER — READY TO FULFILL/);
  assert.match(text, /Order: SAI-ABC123/);
  assert.match(text, /Jane Buyer/);
  assert.match(text, /jane@example.test/);
  assert.match(text, /7315550100/);
  assert.match(text, /123 Main St, Savannah, TN 38372/);
  assert.match(text, /Black Nitrile Gloves/);
  assert.match(text, /Medium: 2 cartons • \$120\.00/);
  assert.match(text, /Subtotal: \$100\.00/);
  assert.match(text, /Shipping: \$15\.00/);
  assert.match(text, /Tax: \$5\.00/);
  assert.match(text, /Total paid: \$120\.00/);
  assert.match(text, /Open the order dashboard/);
  assert.doesNotMatch(text, /order-uuid-1/);
  assert.doesNotMatch(text, /pay_square_99/);
  assert.doesNotMatch(text, /black-nitrile-general/);
});

test("admin notification subject leads with amount and customer", () => {
  assert.equal(buildVendorPaidOrderSubject(SAMPLE_ORDER), "Paid order $120.00 — Jane Buyer");
});

test("buildVendorPaidOrderHtml is mobile-friendly, actionable, escaped, and uses box quantities", () => {
  const html = buildVendorPaidOrderHtml({
    ...SAMPLE_ORDER,
    customer_name: "Jane <Buyer>",
    items: [
      {
        name: "Nitrile Examination – Standard",
        quantities: { L: 0 },
        boxQuantities: { L: 1 },
        lineCases: 0,
        lineBoxCount: 1,
        lineTotalFormatted: "$9.99",
      },
    ],
  });

  assert.match(html, /New order ready to fulfill/);
  assert.match(html, /Open order dashboard/);
  assert.match(html, /Large: 1 box/);
  assert.match(html, /Jane &lt;Buyer&gt;/);
  assert.match(html, /https:\/\/store\.saigoods\.com\/admin-v2\.5\/orders/);
  assert.doesNotMatch(html, /0 case/);
  assert.doesNotMatch(html, /pay_square_99/);
  assert.doesNotMatch(html, /order-uuid-1/);
});

test("vendorPaidNotificationIdempotencyKey is deterministic from payment id", () => {
  assert.equal(
    vendorPaidNotificationIdempotencyKey(SAMPLE_ORDER),
    "vendor-paid-order/pay_square_99",
  );
  assert.equal(
    vendorPaidNotificationIdempotencyKey({ id: "order-only", payment_id: null }),
    "vendor-paid-order/order-only",
  );
});

test("successful injected Resend send marks notification sent", async () => {
  const markCalls = [];
  const releaseCalls = [];
  let sendCount = 0;

  const result = await sendVendorPaidOrderNotificationIfNeeded(
    { orderId: SAMPLE_ORDER.id, paymentId: SAMPLE_ORDER.payment_id },
    {
      resendApiKey: "re_test_key",
      resendFrom: "ops@example.test",
      vendorEmail: "vendor@example.test",
      tryClaimVendorPaidNotification: async () => ({
        order: SAMPLE_ORDER,
        claimedAt: "2026-07-21T10:00:00.000Z",
      }),
      markVendorPaidNotificationSent: async (args) => {
        markCalls.push(args);
        return true;
      },
      releaseVendorPaidNotificationClaim: async (args) => {
        releaseCalls.push(args);
        return true;
      },
      sendResend: async (payload) => {
        sendCount += 1;
        assert.equal(payload.subject, "Paid order $120.00 — Jane Buyer");
        assert.equal(payload.idempotencyKey, "vendor-paid-order/pay_square_99");
        assert.match(payload.text, /Jane Buyer/);
        assert.match(payload.html, /New order ready to fulfill/);
        return { data: { id: "email_resend_1" }, error: null };
      },
    },
  );

  assert.deepEqual(result, { sent: true, resendId: "email_resend_1" });
  assert.equal(sendCount, 1);
  assert.deepEqual(markCalls, [
    {
      orderId: SAMPLE_ORDER.id,
      claimedAt: "2026-07-21T10:00:00.000Z",
      resendId: "email_resend_1",
    },
  ]);
  assert.equal(releaseCalls.length, 0);
});

test("duplicate or in-progress claim does not send", async () => {
  let sendCount = 0;

  const result = await sendVendorPaidOrderNotificationIfNeeded(
    { orderId: SAMPLE_ORDER.id, paymentId: SAMPLE_ORDER.payment_id },
    {
      tryClaimVendorPaidNotification: async () => null,
      sendResend: async () => {
        sendCount += 1;
        return { data: { id: "should-not-send" }, error: null };
      },
    },
  );

  assert.deepEqual(result, { sent: false, reason: "already_sent_or_in_progress" });
  assert.equal(sendCount, 0);
});

test("Resend API error releases the persistent claim", async () => {
  const releaseCalls = [];
  let sendCount = 0;
  const secretMarker = "re_dummy_secret_should_never_be_stored";

  await assert.rejects(
    () =>
      sendVendorPaidOrderNotificationIfNeeded(
        { orderId: SAMPLE_ORDER.id, paymentId: SAMPLE_ORDER.payment_id },
        {
          resendApiKey: "re_test_key",
          resendFrom: "ops@example.test",
          vendorEmail: "vendor@example.test",
          tryClaimVendorPaidNotification: async () => ({
            order: SAMPLE_ORDER,
            claimedAt: "2026-07-21T10:00:00.000Z",
          }),
          markVendorPaidNotificationSent: async () => true,
          releaseVendorPaidNotificationClaim: async (args) => {
            releaseCalls.push(args);
            return true;
          },
          sendResend: async () => {
            sendCount += 1;
            return { data: null, error: { message: secretMarker } };
          },
        },
      ),
    (err) => err.code === "VENDOR_NOTIFICATION_SEND_FAILED",
  );

  assert.equal(sendCount, 1);
  assert.equal(releaseCalls.length, 1);
  assert.equal(releaseCalls[0].orderId, SAMPLE_ORDER.id);
  assert.equal(releaseCalls[0].claimedAt, "2026-07-21T10:00:00.000Z");
  assert.equal(releaseCalls[0].error, "vendor_notification_send_failed");
  assert.equal(JSON.stringify(releaseCalls).includes(secretMarker), false);
});

test("thrown Resend send exception releases claim with classified send failure only", async () => {
  const releaseCalls = [];
  let sendCount = 0;
  const secretMarker = "re_dummy_secret_should_never_be_stored";

  await assert.rejects(
    () =>
      sendVendorPaidOrderNotificationIfNeeded(
        { orderId: SAMPLE_ORDER.id, paymentId: SAMPLE_ORDER.payment_id },
        {
          resendApiKey: "re_test_key",
          resendFrom: "ops@example.test",
          vendorEmail: "vendor@example.test",
          tryClaimVendorPaidNotification: async () => ({
            order: SAMPLE_ORDER,
            claimedAt: "2026-07-21T10:00:00.000Z",
          }),
          markVendorPaidNotificationSent: async () => true,
          releaseVendorPaidNotificationClaim: async (args) => {
            releaseCalls.push(args);
            return true;
          },
          sendResend: async () => {
            sendCount += 1;
            throw new Error(secretMarker);
          },
        },
      ),
    (err) => err.code === "VENDOR_NOTIFICATION_SEND_FAILED",
  );

  assert.equal(sendCount, 1);
  assert.equal(releaseCalls.length, 1);
  assert.equal(releaseCalls[0].error, "vendor_notification_send_failed");
  assert.equal(JSON.stringify(releaseCalls).includes(secretMarker), false);
});

test("missing configuration releases the claim and does not send", async () => {
  const releaseCalls = [];
  let sendCount = 0;

  await assert.rejects(
    () =>
      sendVendorPaidOrderNotificationIfNeeded(
        { orderId: SAMPLE_ORDER.id, paymentId: SAMPLE_ORDER.payment_id },
        {
          resendApiKey: "",
          resendFrom: "",
          vendorEmail: "",
          tryClaimVendorPaidNotification: async () => ({
            order: SAMPLE_ORDER,
            claimedAt: "2026-07-21T10:00:00.000Z",
          }),
          releaseVendorPaidNotificationClaim: async (args) => {
            releaseCalls.push(args);
            return true;
          },
          sendResend: async () => {
            sendCount += 1;
            return { data: { id: "should-not-send" }, error: null };
          },
        },
      ),
    (err) => err.code === "VENDOR_NOTIFICATION_CONFIG",
  );

  assert.equal(sendCount, 0);
  assert.equal(releaseCalls.length, 1);
  assert.equal(releaseCalls[0].error, "vendor_notification_config_missing");
});

test("markVendorPaidNotificationSent returns false releases claim and rejects with persistence error", async () => {
  const releaseCalls = [];
  let sendCount = 0;

  await assert.rejects(
    () =>
      sendVendorPaidOrderNotificationIfNeeded(
        { orderId: SAMPLE_ORDER.id, paymentId: SAMPLE_ORDER.payment_id },
        {
          resendApiKey: "re_test_key",
          resendFrom: "ops@example.test",
          vendorEmail: "vendor@example.test",
          tryClaimVendorPaidNotification: async () => ({
            order: SAMPLE_ORDER,
            claimedAt: "2026-07-21T10:00:00.000Z",
          }),
          markVendorPaidNotificationSent: async () => false,
          releaseVendorPaidNotificationClaim: async (args) => {
            releaseCalls.push(args);
            return true;
          },
          sendResend: async () => {
            sendCount += 1;
            return { data: { id: "email_resend_1" }, error: null };
          },
        },
      ),
    (err) => err.code === "VENDOR_NOTIFICATION_PERSIST_FAILED",
  );

  assert.equal(sendCount, 1);
  assert.equal(releaseCalls.length, 1);
  assert.equal(releaseCalls[0].orderId, SAMPLE_ORDER.id);
  assert.equal(releaseCalls[0].claimedAt, "2026-07-21T10:00:00.000Z");
  assert.equal(releaseCalls[0].error, "vendor_notification_persist_failed");
});

test("markVendorPaidNotificationSent throws releases claim and rejects with persistence error", async () => {
  const releaseCalls = [];
  let sendCount = 0;

  await assert.rejects(
    () =>
      sendVendorPaidOrderNotificationIfNeeded(
        { orderId: SAMPLE_ORDER.id, paymentId: SAMPLE_ORDER.payment_id },
        {
          resendApiKey: "re_test_key",
          resendFrom: "ops@example.test",
          vendorEmail: "vendor@example.test",
          tryClaimVendorPaidNotification: async () => ({
            order: SAMPLE_ORDER,
            claimedAt: "2026-07-21T10:00:00.000Z",
          }),
          markVendorPaidNotificationSent: async () => {
            throw new Error("database connection lost");
          },
          releaseVendorPaidNotificationClaim: async (args) => {
            releaseCalls.push(args);
            return true;
          },
          sendResend: async () => {
            sendCount += 1;
            return { data: { id: "email_resend_1" }, error: null };
          },
        },
      ),
    (err) => {
      assert.equal(err.code, "VENDOR_NOTIFICATION_PERSIST_FAILED");
      assert.equal(String(err.message).includes("database"), false);
      return true;
    },
  );

  assert.equal(sendCount, 1);
  assert.equal(releaseCalls.length, 1);
  assert.equal(releaseCalls[0].orderId, SAMPLE_ORDER.id);
  assert.equal(releaseCalls[0].claimedAt, "2026-07-21T10:00:00.000Z");
  assert.equal(releaseCalls[0].error, "vendor_notification_persist_failed");
});

test("SQL migration includes all four columns and schema reload", () => {
  const sql = readFileSync(
    path.join(__dirname, "..", "sql", "patch-orders-vendor-paid-notification.sql"),
    "utf8",
  );

  assert.match(sql, /vendor_paid_notification_claimed_at timestamptz/);
  assert.match(sql, /vendor_paid_notification_sent_at timestamptz/);
  assert.match(sql, /vendor_paid_notification_resend_id text/);
  assert.match(sql, /vendor_paid_notification_error text/);
  assert.match(sql, /notify pgrst, 'reload schema';/);
});

test("package.json and package-lock.json no longer contain SendGrid packages", () => {
  const packageJson = readFileSync(path.join(__dirname, "..", "package.json"), "utf8");
  const lockJson = readFileSync(path.join(__dirname, "..", "package-lock.json"), "utf8");

  for (const pkg of ["@sendgrid/mail", "@sendgrid/client", "@sendgrid/helpers"]) {
    assert.equal(packageJson.includes(pkg), false, `package.json should not reference ${pkg}`);
    assert.equal(lockJson.includes(`"node_modules/${pkg}"`), false, `lockfile should not include ${pkg}`);
  }
});

test("no runtime SendGrid imports remain in project source", () => {
  const webhookSource = readFileSync(path.join(__dirname, "square-webhook-handler.js"), "utf8");
  const checkoutPaySource = readFileSync(path.join(__dirname, "..", "api", "checkout-pay.js"), "utf8");

  assert.equal(webhookSource.includes("@sendgrid"), false);
  assert.equal(webhookSource.includes("./email.js"), false);
  assert.equal(checkoutPaySource.includes("@sendgrid"), false);
  assert.equal(checkoutPaySource.includes("./email.js"), false);
});
