import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  handleSquareWebhook,
  resolveSquareNotificationUrl,
} from "./square-webhook-handler.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webhookSource = readFileSync(path.join(__dirname, "square-webhook-handler.js"), "utf8");

const ORDER_ID = "order-uuid-1";
const PAYMENT_ID = "pay_square_99";

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

test.beforeEach(() => {
  saveEnv();
  process.env.PUBLIC_BASE_URL = "https://example.test";
  process.env.ENABLE_SHIPPO_ORDER_SYNC = "true";
});

test.afterEach(() => {
  restoreEnv();
});

test("Preview signature verification includes the Vercel automation bypass query", () => {
  assert.equal(
    resolveSquareNotificationUrl({
      baseUrl: "https://store-saigoods-preview.vercel.app/",
      notificationPath: "/api/webhooks/square-sandbox",
      vercelEnv: "preview",
      automationBypassSecret: "secret + slash/",
    }),
    "https://store-saigoods-preview.vercel.app/api/webhooks/square-sandbox?x-vercel-protection-bypass=secret+%2B+slash%2F",
  );
});

test("Production signature verification never appends the Preview bypass", () => {
  assert.equal(
    resolveSquareNotificationUrl({
      baseUrl: "https://store.saigoods.com",
      notificationPath: "api/webhooks/square",
      vercelEnv: "production",
      automationBypassSecret: "preview-only-secret",
    }),
    "https://store.saigoods.com/api/webhooks/square",
  );
});

function completedPaymentEvent(overrides = {}) {
  return {
    type: "payment.completed",
    data: {
      object: {
        payment: {
          id: PAYMENT_ID,
          status: "COMPLETED",
          note: `Order ${ORDER_ID} from SAI Goods`,
          amount_money: { amount: 12000 },
          ...overrides,
        },
      },
    },
  };
}

function mockSquareWebhookReq(eventBody) {
  const rawBody = JSON.stringify(eventBody);
  return {
    method: "POST",
    headers: {
      "x-square-hmacsha256-signature": "test-signature",
    },
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(rawBody);
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

function baseDeps(overrides = {}) {
  return {
    verifySquareSignature: () => true,
    extractBuyerContactFromPayment: () => ({ email: "buyer@example.test", phone: "", name: "Buyer" }),
    formatPaymentShippingAddress: () => "123 Main St",
    markOrderPaid: async () => null,
    getOrderByIdForService: async () => null,
    syncWebsiteOrderToShippo: async () => ({ ok: true }),
    sendVendorPaidOrderNotificationIfNeeded: async () => ({ sent: true }),
    sendPaidOrderReceiptResendIfConfigured: async () => ({ sent: true }),
    processAutomaticLabelsForOrder: async () => ({ ok: true }),
    recordSquareWebhookEvent: async () => ({ inserted: true }),
    ...overrides,
  };
}

async function invokeWebhook(eventBody, deps = {}) {
  const req = mockSquareWebhookReq(eventBody);
  const res = mockRes();
  await handleSquareWebhook(
    req,
    res,
    { notificationPath: "/api/webhooks/square", signatureKey: "test-key" },
    baseDeps(deps),
  );
  return res.state;
}

test("A: already-paid embedded web order sends vendor notification only", async () => {
  const calls = {
    markOrderPaid: 0,
    getOrderByIdForService: 0,
    vendor: 0,
    receipt: 0,
    shippo: 0,
  };

  const paidWebOrder = {
    id: ORDER_ID,
    status: "paid",
    payment_id: PAYMENT_ID,
    order_source: "web",
  };

  const state = await invokeWebhook(completedPaymentEvent(), {
    markOrderPaid: async () => {
      calls.markOrderPaid += 1;
      return null;
    },
    getOrderByIdForService: async (orderId) => {
      calls.getOrderByIdForService += 1;
      assert.equal(orderId, ORDER_ID);
      return paidWebOrder;
    },
    sendVendorPaidOrderNotificationIfNeeded: async ({ orderId, paymentId }) => {
      calls.vendor += 1;
      assert.equal(orderId, ORDER_ID);
      assert.equal(paymentId, PAYMENT_ID);
      return { sent: true };
    },
    sendPaidOrderReceiptResendIfConfigured: async () => {
      calls.receipt += 1;
      return { sent: true };
    },
    syncWebsiteOrderToShippo: async () => {
      calls.shippo += 1;
      return { ok: true };
    },
  });

  assert.equal(state.statusCode, 200);
  assert.deepEqual(state.body, { ok: true });
  assert.equal(calls.markOrderPaid, 1);
  assert.equal(calls.getOrderByIdForService, 1);
  assert.equal(calls.vendor, 1);
  assert.equal(calls.receipt, 0);
  assert.equal(calls.shippo, 0);
});

test("B: stored payment_id mismatch skips vendor and customer notifications", async () => {
  const calls = { vendor: 0, receipt: 0 };

  const state = await invokeWebhook(completedPaymentEvent(), {
    markOrderPaid: async () => null,
    getOrderByIdForService: async () => ({
      id: ORDER_ID,
      status: "paid",
      payment_id: "different-payment-id",
      order_source: "web",
    }),
    sendVendorPaidOrderNotificationIfNeeded: async () => {
      calls.vendor += 1;
      return { sent: true };
    },
    sendPaidOrderReceiptResendIfConfigured: async () => {
      calls.receipt += 1;
      return { sent: true };
    },
  });

  assert.equal(state.statusCode, 200);
  assert.deepEqual(state.body, { ok: true });
  assert.equal(calls.vendor, 0);
  assert.equal(calls.receipt, 0);
});

test("C: newly transitioned manual order sends vendor and customer receipt", async () => {
  const calls = {
    getOrderByIdForService: 0,
    vendor: 0,
    receipt: 0,
  };

  const manualOrder = {
    id: ORDER_ID,
    status: "paid",
    payment_id: PAYMENT_ID,
    order_source: "manual",
  };

  const state = await invokeWebhook(completedPaymentEvent(), {
    markOrderPaid: async () => manualOrder,
    getOrderByIdForService: async () => {
      calls.getOrderByIdForService += 1;
      return manualOrder;
    },
    sendVendorPaidOrderNotificationIfNeeded: async () => {
      calls.vendor += 1;
      return { sent: true };
    },
    sendPaidOrderReceiptResendIfConfigured: async (order) => {
      calls.receipt += 1;
      assert.equal(order, manualOrder);
      return { sent: true };
    },
  });

  assert.equal(state.statusCode, 200);
  assert.deepEqual(state.body, { ok: true });
  assert.equal(calls.getOrderByIdForService, 0);
  assert.equal(calls.vendor, 1);
  assert.equal(calls.receipt, 1);
});

test("D: duplicate vendor notification still returns 200", async () => {
  const state = await invokeWebhook(completedPaymentEvent(), {
    markOrderPaid: async () => ({
      id: ORDER_ID,
      status: "paid",
      payment_id: PAYMENT_ID,
      order_source: "manual",
    }),
    sendVendorPaidOrderNotificationIfNeeded: async () => ({
      sent: false,
      reason: "already_sent_or_in_progress",
    }),
  });

  assert.equal(state.statusCode, 200);
  assert.deepEqual(state.body, { ok: true });
});

test("E: vendor notification failure returns generic 500 and skips customer receipt", async () => {
  const calls = { receipt: 0 };
  const secretMarker = "Resend API secret leaked";
  const originalConsoleError = console.error;
  /** @type {unknown[][]} */
  const loggedArgs = [];

  console.error = (...args) => {
    loggedArgs.push(args);
  };

  try {
    const state = await invokeWebhook(completedPaymentEvent(), {
      markOrderPaid: async () => ({
        id: ORDER_ID,
        status: "paid",
        payment_id: PAYMENT_ID,
        order_source: "manual",
      }),
      sendVendorPaidOrderNotificationIfNeeded: async () => {
        const err = new Error(secretMarker);
        err.code = "VENDOR_NOTIFICATION_SEND_FAILED";
        throw err;
      },
      sendPaidOrderReceiptResendIfConfigured: async () => {
        calls.receipt += 1;
        return { sent: true };
      },
    });

    assert.equal(state.statusCode, 500);
    assert.deepEqual(state.body, { error: "Webhook handling failed." });
    assert.equal(calls.receipt, 0);

    assert.equal(loggedArgs.length, 1);
    const serialized = JSON.stringify(loggedArgs);
    assert.equal(serialized.includes(secretMarker), false);
    assert.equal(serialized.includes("stack"), false);
    assert.deepEqual(loggedArgs[0], [
      "[square webhook] handler failed",
      { code: "VENDOR_NOTIFICATION_SEND_FAILED" },
    ]);
  } finally {
    console.error = originalConsoleError;
  }
});

test("F: non-completed payment skips order mutation and notifications", async () => {
  const calls = {
    markOrderPaid: 0,
    getOrderByIdForService: 0,
    vendor: 0,
    receipt: 0,
    shippo: 0,
  };

  const state = await invokeWebhook(
    completedPaymentEvent({ status: "APPROVED" }),
    {
      markOrderPaid: async () => {
        calls.markOrderPaid += 1;
        return null;
      },
      getOrderByIdForService: async () => {
        calls.getOrderByIdForService += 1;
        return null;
      },
      sendVendorPaidOrderNotificationIfNeeded: async () => {
        calls.vendor += 1;
        return { sent: true };
      },
      sendPaidOrderReceiptResendIfConfigured: async () => {
        calls.receipt += 1;
        return { sent: true };
      },
      syncWebsiteOrderToShippo: async () => {
        calls.shippo += 1;
        return { ok: true };
      },
    },
  );

  assert.equal(state.statusCode, 200);
  assert.deepEqual(state.body, { ok: true });
  assert.equal(calls.markOrderPaid, 0);
  assert.equal(calls.getOrderByIdForService, 0);
  assert.equal(calls.vendor, 0);
  assert.equal(calls.receipt, 0);
  assert.equal(calls.shippo, 0);
});

test("G: duplicate Square event identity skips payment and label transitions", async () => {
  const calls = { mark: 0, labels: 0 };
  const state = await invokeWebhook(completedPaymentEvent(), {
    recordSquareWebhookEvent: async () => ({ inserted: false }),
    markOrderPaid: async () => { calls.mark += 1; return null; },
    processAutomaticLabelsForOrder: async () => { calls.labels += 1; },
  });
  assert.equal(state.statusCode, 200);
  assert.deepEqual(state.body, { ok: true, duplicate: true });
  assert.deepEqual(calls, { mark: 0, labels: 0 });
});

test("H: paid manual carrier order registers automatic labels with the function lifecycle", async () => {
  const deferred = [];
  const processedOrderIds = [];

  const state = await invokeWebhook(completedPaymentEvent(), {
    markOrderPaid: async () => ({
      id: ORDER_ID,
      status: "paid",
      payment_id: PAYMENT_ID,
      order_source: "manual",
      payment_flow: "square_payment_link",
      fulfillment_method: "carrier",
      shippo_label_required: true,
      total_cents: 12000,
      quoted_shipping_currency: "USD",
    }),
    processAutomaticManualLabels: async (orderId) => {
      processedOrderIds.push(orderId);
      return { ok: true };
    },
    defer: (promise) => {
      deferred.push(promise);
    },
  });

  assert.equal(state.statusCode, 200);
  assert.deepEqual(state.body, { ok: true });
  assert.deepEqual(processedOrderIds, [ORDER_ID]);
  assert.equal(deferred.length, 1);
  await deferred[0];
});

test("webhook source does not import SendGrid email helpers", () => {
  assert.equal(webhookSource.includes("@sendgrid"), false);
  assert.equal(webhookSource.includes("./email.js"), false);
  assert.equal(webhookSource.includes("sendVendorEmail"), false);
  assert.equal(webhookSource.includes("sendCustomerEmail"), false);
});
