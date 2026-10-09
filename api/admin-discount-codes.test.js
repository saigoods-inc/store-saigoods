import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import handler from "./admin-discount-codes.js";
import { claimDiscountCodeForOrder } from "../lib/discount-codes.js";

test("unused discount deletion is authorized and conditional at the database boundary", async (t) => {
  let rows = [];
  let requests = [];
  let fail = false;
  let claimBeforeDelete = false;
  const db = createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    requests.push({ method: req.method, url });
    res.setHeader("Content-Type", "application/json");
    if (fail) { res.writeHead(500); res.end(JSON.stringify({ message: "Database unavailable" })); return; }
    if (claimBeforeDelete && req.method === "DELETE") {
      rows[0].is_used = true;
      rows[0].used_by_order_id = "concurrent-order";
    }
    const matches = rows.filter((row) => [...url.searchParams].every(([key, value]) => {
      if (key === "select" || key === "order") return true;
      if (value === "is.null") return row[key] == null;
      return String(row[key]) === value.replace(/^eq\./, "");
    }));
    if (req.method === "DELETE") rows = rows.filter((row) => !matches.includes(row));
    if (req.method === "PATCH") {
      let body = "";
      for await (const chunk of req) body += chunk;
      for (const row of matches) Object.assign(row, JSON.parse(body));
    }
    res.end(JSON.stringify(matches));
  });
  db.listen(0, "127.0.0.1");
  await once(db, "listening");
  t.after(() => { db.closeAllConnections(); db.close(); });
  const settings = {
    SUPABASE_URL: `http://127.0.0.1:${db.address().port}`,
    SUPABASE_SERVICE_ROLE_KEY: "test-service-key",
    SUPABASE_ANON_KEY: "",
    INTERNAL_REPORTS_SECRET: "test-admin-secret",
    ALLOW_INSECURE_LOCAL_ADMIN_API: "false",
  };
  for (const [key, value] of Object.entries(settings)) {
    const previous = process.env[key];
    process.env[key] = value;
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  }
  const invoke = async (code = "ACCIDENTAL", authorization = "Bearer test-admin-secret") => {
    const result = {};
    await handler({ method: "DELETE", body: { code }, headers: { authorization } }, {
      status(status) { result.status = status; return this; },
      json(body) { result.body = body; },
    });
    return result;
  };
  const reset = () => {
    rows = [{ id: "original-code", code: "ACCIDENTAL", is_used: false, used_at: null, used_by_order_id: null }];
    requests = []; fail = false; claimBeforeDelete = false;
  };
  await t.test("rejects unauthenticated requests without touching the database", async () => {
    reset(); assert.equal((await invoke("ACCIDENTAL", "")).status, 401); assert.equal(requests.length, 0);
  });
  await t.test("rejects unauthorized requests without touching the database", async () => {
    reset(); assert.equal((await invoke("ACCIDENTAL", "Bearer wrong")).status, 403); assert.equal(requests.length, 0);
  });
  await t.test("rejects invalid codes without issuing an unfiltered delete", async () => {
    reset(); assert.equal((await invoke("*")).status, 400); assert.equal(requests.length, 0);
  });
  await t.test("deletes only the matching unused code", async () => {
    reset(); rows.push({ code: "KEEP", is_used: false, used_at: null, used_by_order_id: null });
    const result = await invoke(" accidental ");
    assert.equal(result.status, 200); assert.deepEqual(result.body, { deleted: true, code: "ACCIDENTAL" });
    assert.deepEqual(rows.map((row) => row.code), ["KEEP"]);
    assert.equal(requests.length, 1); assert.equal(requests[0].method, "DELETE");
  });
  for (const [label, change] of [
    ["used codes", { is_used: true }],
    ["codes linked to an order", { used_by_order_id: "order-123" }],
    ["codes with a redemption timestamp", { used_at: "2026-10-09T00:00:00Z" }],
  ]) await t.test(`protects ${label}`, async () => {
    reset(); Object.assign(rows[0], change);
    assert.equal((await invoke()).status, 409); assert.equal(rows.length, 1);
  });
  await t.test("protects a code claimed after the admin loaded the list", async () => {
    reset(); claimBeforeDelete = true;
    assert.equal((await invoke()).status, 409); assert.equal(rows[0].used_by_order_id, "concurrent-order");
    assert.equal(requests[0].method, "DELETE");
  });
  await t.test("handles already deleted codes without reporting success", async () => {
    reset(); rows = []; assert.equal((await invoke()).status, 409);
  });
  await t.test("claim cannot reserve a replacement created between validation and payment", async () => {
    reset(); rows[0].id = "replacement-code";
    assert.equal(await claimDiscountCodeForOrder("ACCIDENTAL", "order-1", "original-code"), false);
    assert.equal(rows[0].is_used, false);
  });
  await t.test("claim retries require the same code identity and order", async () => {
    reset();
    assert.equal(await claimDiscountCodeForOrder("ACCIDENTAL", "order-1", "original-code"), true);
    assert.equal(await claimDiscountCodeForOrder("ACCIDENTAL", "order-1", "original-code"), true);
    assert.equal(await claimDiscountCodeForOrder("ACCIDENTAL", "order-2", "original-code"), false);
    assert.equal(await claimDiscountCodeForOrder("ACCIDENTAL", "order-1", "replacement-code"), false);
  });
  await t.test("legacy drafts must refresh their quote before claiming a code", async () => {
    reset();
    assert.equal(await claimDiscountCodeForOrder("ACCIDENTAL", "order-1"), false);
    assert.equal(requests.length, 0);
  });
  await t.test("reports database failures without deleting anything", async () => {
    reset(); fail = true; assert.equal((await invoke()).status, 500); assert.equal(rows.length, 1);
  });
});
