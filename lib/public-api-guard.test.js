import assert from "node:assert/strict";
import test from "node:test";
import { __resetPublicApiGuardForTests, assertPublicApiRequestAllowed } from "./public-api-guard.js";

test.beforeEach(__resetPublicApiGuardForTests);

test("public API guard rejects oversized bodies", () => {
  assert.throws(
    () => assertPublicApiRequestAllowed({ headers: { "content-length": "129000" } }, {
      name: "test", limit: 10, windowMs: 1000, maxBodyBytes: 128000,
    }),
    (error) => error.statusCode === 413,
  );
});

test("public API guard limits repeated requests by forwarded client address", () => {
  const req = { headers: { "x-forwarded-for": "203.0.113.5, 10.0.0.1" } };
  assert.doesNotThrow(() => assertPublicApiRequestAllowed(req, { name: "pay", limit: 1, windowMs: 1000 }));
  assert.throws(
    () => assertPublicApiRequestAllowed(req, { name: "pay", limit: 1, windowMs: 1000 }),
    (error) => error.statusCode === 429,
  );
});
