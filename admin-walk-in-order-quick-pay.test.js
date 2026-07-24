import assert from "node:assert/strict";
import test from "node:test";

import quickPayHandler, { WALK_IN_QUICK_PAY_ADMIN_V2_SAFE } from "./api/admin-walk-in-order-quick-pay.js";

test("quick-pay is explicitly marked unsuitable for Admin-v2 first release (Option B)", () => {
  assert.equal(WALK_IN_QUICK_PAY_ADMIN_V2_SAFE, false);
});

test("quick-pay rejects unsupported payment methods before mutation", async () => {
  process.env.ALLOW_INSECURE_LOCAL_ADMIN_API = "1";
  const res = {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };

  await quickPayHandler(
    {
      method: "POST",
      headers: {},
      body: {
        name: "Test",
        items: [{ slug: "black-nitrile-general", boxQuantities: { M: 1 }, bundleLines: [{ id: "box_1", qty: 1 }] }],
        paymentMethod: "card_present",
      },
    },
    res,
  );

  assert.equal(res.statusCode, 400);
  assert.match(String(res.body?.error || ""), /cash or check/i);
  delete process.env.ALLOW_INSECURE_LOCAL_ADMIN_API;
});

test("quick-pay source documents Option B and routes payment through markWalkInOrderPaid", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(dir, "api", "admin-walk-in-order-quick-pay.js"), "utf8");
  assert.match(src, /Option B/);
  assert.match(src, /markWalkInOrderPaid/);
  assert.match(src, /WALK_IN_QUICK_PAY_ADMIN_V2_SAFE = false/);
  assert.match(src, /must use create-draft/);
  assert.match(src, /explicit mark-paid/);
});
