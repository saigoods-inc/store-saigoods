import assert from "node:assert/strict";
import { mock, test } from "node:test";
import * as orders from "../lib/orders.js";
import * as square from "../lib/square.js";
let order;
const expiry = "2099-01-01T00:00:00Z";
const create = mock.fn(async () => ({ checkoutUrl: "https://square.example.test/payment", paymentLinkId: "test-link" }));
const persist = mock.fn(async () => ({ payment_link_expires_at: expiry }));
const email = mock.fn(async () => true);
mock.module(new URL("../lib/orders.js", import.meta.url).href, { namedExports: { ...orders, getOrderByIdForService: async () => order, updateOrderPaymentLinkSent: persist } });
mock.module(new URL("../lib/square.js", import.meta.url).href, { namedExports: { ...square, createPaymentLink: create } });
mock.module(new URL("../lib/manual-order-payment-email.js", import.meta.url).href, { namedExports: { sendManualOrderPaymentLinkEmail: email } });
const { default: handler } = await import("../api/admin-manual-order-send-link.js");
function savedOrder(resend) {
  return { id: "test-order", order_ref: "TEST-FREE", order_source: "manual", order_status: resend ? "payment_link_sent" : "draft", status: "pending", payment_flow: "square_payment_link", fulfillment_method: "carrier", customer_name: "Test Buyer", customer_email: "buyer@example.test", shipping_address: { state: "FL" }, items: [], subtotal_cents: 37170, tax_cents: 0, shipping_cents: 0, total_cents: 37170, quoted_shipping_status: "rated", quoted_shipping_service_label: "Ground Saver", quoted_shipping_provider_quote_id: "test-rate", checkout_quote_snapshot_json: { freeShipping: { applied: true, source: "admin_override" }, shipping: { freeShippingApplied: true, carrierTotalAmountCents: 8126 } }, ...(resend ? { payment_link_url: "https://square.example.test/existing", payment_link_id: "existing", payment_link_expires_at: expiry } : {}) };
}
async function invoke() {
  let status, body;
  await handler({ method: "POST", headers: { authorization: "Bearer test-internal-secret" }, body: { orderId: "test-order" } }, { status(v) { status = v; return this; }, json(v) { body = v; return this; } });
  return { status, body };
}
for (const resend of [false, true]) {
  const mode = resend ? "resend" : "first send";
  test(`${mode}: approved free shipping sends the correct total without charging carrier cost`, async () => {
    order = savedOrder(resend);
    for (const fn of [create, persist, email]) fn.mock.resetCalls();
    const result = await invoke();
    assert.equal(result.status, 200);
    assert.equal(result.body.emailed, true);
    assert.equal(email.mock.callCount(), 1);
    assert.equal(email.mock.calls[0].arguments[0].quote.shippingCents, 0);
    assert.equal(email.mock.calls[0].arguments[0].quote.totalCents, 37170);
    assert.equal(create.mock.callCount(), resend ? 0 : 1);
    assert.equal(persist.mock.callCount(), resend ? 0 : 1);
    if (!resend) assert.equal(create.mock.calls[0].arguments[0].quote.totalCents, 37170);
  });
  for (const [name, change] of [
    ["unapproved zero charge", o => { o.checkout_quote_snapshot_json = null; }],
    ["incomplete approval", o => { o.checkout_quote_snapshot_json.shipping.freeShippingApplied = false; }],
    ["missing provider rate", o => { o.quoted_shipping_provider_quote_id = null; }],
    ["unconfirmed carrier quote", o => { o.quoted_shipping_status = "not_requested"; }],
    ["missing service", o => { o.quoted_shipping_service_label = null; }],
  ]) test(`${mode}: ${name} blocks Square and email`, async () => {
    order = savedOrder(resend); change(order);
    for (const fn of [create, persist, email]) fn.mock.resetCalls();
    const result = await invoke();
    assert.equal(result.status, 400);
    for (const fn of [create, persist, email]) assert.equal(fn.mock.callCount(), 0);
  });
  test(`${mode}: normal charged shipping remains valid`, async () => {
    order = savedOrder(resend); order.shipping_cents = 8126; order.total_cents += 8126; order.checkout_quote_snapshot_json = null;
    assert.equal((await invoke()).status, 200);
  });
}
