import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertManualOrderEligibleForPaymentLink,
  classifySquareCreatePaymentLinkError,
  deliverManualOrderPaymentLink,
} from "./api/admin-manual-order-send-link.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function read(rel) {
  return readFileSync(path.join(__dirname, rel), "utf8");
}

function makeDeps(overrides = {}) {
  const calls = {
    square: 0,
    persist: 0,
    email: 0,
    release: 0,
    log: 0,
  };
  return {
    calls,
    claimed: true,
    orderId: "ord-test-1",
    createPaymentLinkArgs: { quote: {}, customer: {}, orderId: "ord-test-1" },
    sendEmailArgs: { customerEmail: "a@b.com" },
    createPaymentLinkFn: async () => {
      calls.square += 1;
      return { checkoutUrl: "https://square.test/link" };
    },
    persistPaymentLinkFn: async () => {
      calls.persist += 1;
    },
    sendEmailFn: async () => {
      calls.email += 1;
      return true;
    },
    releaseDiscountFn: async () => {
      calls.release += 1;
    },
    logErrorFn: () => {
      calls.log += 1;
    },
    ...overrides,
  };
}

function squareThrow(statusCode, message = "square fail", extra = {}) {
  const e = new Error(message);
  if (statusCode != null) e.statusCode = statusCode;
  Object.assign(e, extra);
  return e;
}

test("Phase 10B-2B production handler uses deliverManualOrderPaymentLink helper", () => {
  const source = read("api/admin-manual-order-send-link.js");
  assert.match(source, /export async function deliverManualOrderPaymentLink/);
  assert.match(source, /export function classifySquareCreatePaymentLinkError/);
  assert.match(source, /export function assertManualOrderEligibleForPaymentLink/);
  assert.match(source, /const result = await deliverManualOrderPaymentLink\(/);
  assert.match(source, /opts\.createPaymentLinkFn \|\| createPaymentLink/);
});

test("Phase 10B-2B Square definite no-link rejection releases claimed discount", async () => {
  for (const status of [400, 401, 403, 404, 422]) {
    const deps = makeDeps({
      createPaymentLinkFn: async () => {
        deps.calls.square += 1;
        throw squareThrow(status, `reject-${status}`);
      },
    });
    const result = await deliverManualOrderPaymentLink(deps);
    assert.equal(result.status, status);
    assert.equal(result.body.ok, false);
    assert.equal(result.body.emailed, false);
    assert.equal(result.body.squareOutcomeUncertain, undefined);
    assert.doesNotMatch(JSON.stringify(result.body), /reject-|square fail|provider/i);
    assert.equal(deps.calls.release, 1);
    assert.equal(deps.calls.persist, 0);
    assert.equal(deps.calls.email, 0);
  }

  const marked = makeDeps({
    createPaymentLinkFn: async () => {
      throw squareThrow(500, "secret provider detail", { definitiveNoLinkCreated: true });
    },
  });
  const markedResult = await deliverManualOrderPaymentLink(marked);
  assert.equal(markedResult.body.ok, false);
  assert.equal(marked.calls.release, 1);
  assert.doesNotMatch(JSON.stringify(markedResult.body), /secret provider detail/);
});

test("Phase 10B-2B ambiguous Square outcomes retain claim and skip persist/email", async () => {
  const cases = [
    { label: "network", err: () => new TypeError("fetch failed") },
    { label: "timeout", err: () => squareThrow(undefined, "aborted") },
    { label: "408", err: () => squareThrow(408) },
    { label: "409", err: () => squareThrow(409) },
    { label: "429", err: () => squareThrow(429) },
    { label: "500", err: () => squareThrow(500, "upstream boom") },
    { label: "502", err: () => squareThrow(502, "bad gateway detail") },
    { label: "503", err: () => squareThrow(503, "unavailable detail") },
  ];

  for (const c of cases) {
    const deps = makeDeps({
      createPaymentLinkFn: async () => {
        deps.calls.square += 1;
        throw c.err();
      },
    });
    const result = await deliverManualOrderPaymentLink(deps);
    assert.equal(result.body.ok, false, c.label);
    assert.equal(result.body.squareOutcomeUncertain, true, c.label);
    assert.equal(result.body.squareLinkCreated, false, c.label);
    assert.equal(result.body.emailed, false, c.label);
    assert.match(String(result.body.warning || ""), /Square may have created/i, c.label);
    assert.match(String(result.body.error || ""), /uncertain/i, c.label);
    assert.doesNotMatch(JSON.stringify(result.body), /upstream boom|bad gateway detail|unavailable detail|fetch failed|aborted/);
    assert.equal(deps.calls.release, 0, c.label);
    assert.equal(deps.calls.persist, 0, c.label);
    assert.equal(deps.calls.email, 0, c.label);
  }

  assert.equal(classifySquareCreatePaymentLinkError(squareThrow(400)).kind, "definite_no_link");
  assert.equal(classifySquareCreatePaymentLinkError(squareThrow(429)).kind, "uncertain");
  assert.equal(classifySquareCreatePaymentLinkError(new Error("net")).kind, "uncertain");
});

test("Phase 10B-2B Square success + persistence failure retains claim and skips email", async () => {
  const deps = makeDeps({
    persistPaymentLinkFn: async () => {
      deps.calls.persist += 1;
      throw new Error("db write failed");
    },
  });
  const result = await deliverManualOrderPaymentLink(deps);
  assert.equal(result.status, 500);
  assert.equal(result.body.squareLinkCreated, true);
  assert.equal(result.body.checkoutUrl, "https://square.test/link");
  assert.equal(result.body.emailed, false);
  assert.equal(deps.calls.email, 0);
  assert.equal(deps.calls.release, 0);
  assert.doesNotMatch(JSON.stringify(result.body), /db write failed/);
});

test("Phase 10B-2B email false and email throw after persist return 200 partial success", async () => {
  const falseDeps = makeDeps({
    sendEmailFn: async () => {
      falseDeps.calls.email += 1;
      return false;
    },
  });
  const falseResult = await deliverManualOrderPaymentLink(falseDeps);
  assert.equal(falseResult.status, 200);
  assert.equal(falseResult.body.ok, true);
  assert.equal(falseResult.body.emailed, false);
  assert.equal(falseDeps.calls.release, 0);

  const throwDeps = makeDeps({
    sendEmailFn: async () => {
      throwDeps.calls.email += 1;
      throw new Error("SMTP secret detail");
    },
  });
  const throwResult = await deliverManualOrderPaymentLink(throwDeps);
  assert.equal(throwResult.status, 200);
  assert.equal(throwResult.body.ok, true);
  assert.equal(throwResult.body.emailed, false);
  assert.equal(throwDeps.calls.release, 0);
  assert.doesNotMatch(JSON.stringify(throwResult.body), /SMTP secret detail/);
});

test("Phase 10B-2B already-sent / paid / pay-later reject before Square", async () => {
  const cases = [
    {
      order_source: "manual",
      order_status: "payment_link_sent",
      payment_flow: "square_payment_link",
      shipping_address: { line1: "1" },
    },
    {
      order_source: "manual",
      order_status: "draft",
      payment_flow: "square_payment_link",
      status: "paid",
      shipping_address: { line1: "1" },
    },
    {
      order_source: "manual",
      order_status: "draft",
      payment_flow: "pay_later",
      shipping_address: { line1: "1" },
    },
  ];
  for (const order of cases) {
    const gate = assertManualOrderEligibleForPaymentLink(order);
    assert.equal(gate.ok, false);
    assert.equal(gate.status, 400);
  }
});

test("Phase 10B-2B production sequence is Square → persist → email", async () => {
  const events = [];
  const deps = makeDeps({
    createPaymentLinkFn: async () => {
      events.push("square");
      return { checkoutUrl: "https://square.test/ok" };
    },
    persistPaymentLinkFn: async (_orderId, url) => {
      events.push(`persist:${url}`);
    },
    sendEmailFn: async ({ checkoutUrl }) => {
      events.push(`email:${checkoutUrl}`);
      return true;
    },
  });
  const result = await deliverManualOrderPaymentLink(deps);
  assert.deepEqual(events, [
    "square",
    "persist:https://square.test/ok",
    "email:https://square.test/ok",
  ]);
  assert.equal(result.status, 200);
  assert.equal(deps.calls.release, 0);
});

test("Phase 10B-2B send-link test file contains no live provider host literals", () => {
  const thisFile = read("admin-manual-order-send-link-partial-success.test.js");
  assert.doesNotMatch(thisFile, /SQUARE_ACCESS_TOKEN\s*=\s*["'](?!dummy)/);
  assert.doesNotMatch(thisFile, /store\.saigoods\.com/);
  assert.doesNotMatch(thisFile, /api\.shippo\.com/);
});
