import test from "node:test";
import assert from "node:assert/strict";
import {
  buildOrderCancellationHtml,
  buildOrderCancellationSubject,
  buildOrderCancellationText,
} from "./order-cancellation-email.js";

const order = {
  id: 133,
  order_ref: "SAI-98512EF93D11",
  customer_name: "Nathan <Sai>",
  total_cents: 2018,
};

test("builds a branded, escaped cancellation email for a pending refund", () => {
  const html = buildOrderCancellationHtml(order, { action: "refund", status: "PENDING" });
  const text = buildOrderCancellationText(order, { action: "refund", status: "PENDING" });

  assert.equal(buildOrderCancellationSubject(order), "Order cancelled — SAI-98512EF93D11");
  assert.match(html, /SAI Goods, Inc\./);
  assert.match(html, /Your order has been cancelled/);
  assert.match(html, /Hi Nathan,/);
  assert.match(html, /Refund processing/);
  assert.match(html, /\$20\.18/);
  assert.match(html, /mailto:sales@saigoods\.com/);
  assert.doesNotMatch(html, /<Sai>/);
  assert.match(text, /Status: Refund processing/);
  assert.match(text, /submitted to Square and is processing/);
});

test("describes a completed refund without calling it pending", () => {
  const html = buildOrderCancellationHtml(order, { action: "refund", status: "COMPLETED" });
  const text = buildOrderCancellationText(order, { action: "refund", status: "COMPLETED" });

  assert.match(html, /Refund issued/);
  assert.doesNotMatch(html, /Refund processing/);
  assert.match(text, /original payment method/);
});

test("describes a void as an authorization release instead of a refund", () => {
  const html = buildOrderCancellationHtml(order, { action: "void", status: "CANCELED" });
  const text = buildOrderCancellationText(order, { action: "void", status: "CANCELED" });

  assert.match(html, /Payment authorization released/);
  assert.match(text, /cancelled before it settled/);
  assert.match(text, /remove the pending authorization/);
  assert.doesNotMatch(text, /refund was submitted/);
});
