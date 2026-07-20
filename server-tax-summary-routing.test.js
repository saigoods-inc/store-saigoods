import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import taxSummaryHandler from "./api/tax-summary.js";
import {
  __resetSupabaseAccessTokenVerifierForTests,
  __setSupabaseAccessTokenVerifierForTests,
} from "./lib/reports-auth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverSource = readFileSync(path.join(__dirname, "server.js"), "utf8");

const DUMMY_REPORTS_SECRET = "dummy-local-tax-reports-secret";
const DUMMY_SERVICE_ROLE_KEY = "dummy-local-supabase-service-role-key";
const TAX_RPC_PATH = "/rest/v1/rpc/tax_summary_tn";

/** Env keys auth + handler / service-client paths may read. */
const HANDLER_ENV_KEYS = [
  "INTERNAL_REPORTS_SECRET",
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "ALLOW_INSECURE_LOCAL_ADMIN_API",
  "NODE_ENV",
  "VERCEL",
];

function withEnv(overrides, fn) {
  const keys = Object.keys(overrides);
  const previous = {};
  for (const key of keys) {
    previous[key] = process.env[key];
    const value = overrides[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const key of keys) {
        if (previous[key] === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = previous[key];
        }
      }
    });
}

function clearHandlerEnv(extra = {}) {
  /** @type {Record<string, string | undefined>} */
  const cleared = {};
  for (const key of HANDLER_ENV_KEYS) {
    cleared[key] = undefined;
  }
  return { ...cleared, ...extra };
}

function mockRes() {
  /** @type {{ statusCode?: number, body?: object, headers: Record<string, string> }} */
  const state = { headers: {} };
  return {
    state,
    status(code) {
      state.statusCode = code;
      return this;
    },
    setHeader(name, value) {
      state.headers[String(name)] = String(value);
      return this;
    },
    json(body) {
      state.body = body;
      return this;
    },
  };
}

/**
 * Mirrors server.js Express → Vercel adaptation for /api/tax-summary:
 * `{ method: req.method, headers: req.headers }` + adaptExpressStyleResponse.
 */
async function invokeLocalTaxSummary(method, headers = {}) {
  const res = mockRes();
  await taxSummaryHandler({ method, headers }, res);
  return res.state;
}

/**
 * Run authenticated tax-summary against a temporary localhost PostgREST stub.
 *
 * Inspected client path (do not guess):
 *   createClient(SUPABASE_URL).rpc("tax_summary_tn")
 *   → POST {SUPABASE_URL}/rest/v1/rpc/tax_summary_tn
 *   body "{}"
 *   headers Authorization/apikey = service role key
 *
 * The fake server runs inside the child so spawnSync cannot deadlock the
 * parent's event loop. The child also isolates lib/supabase-admin.js's
 * cached service client from sibling tests.
 */
function invokeTaxWithFakeSupabaseRpc({
  mode,
  rows = [],
  errorBody = {
    message: "tax_summary_tn rpc failed",
    code: "PGRST000",
    details: null,
    hint: null,
  },
  errorStatus = 500,
  method = "GET",
  headers = { authorization: `Bearer ${DUMMY_REPORTS_SECRET}` },
  captureAdapter = false,
  envExtra = {},
}) {
  const payload = {
    mode,
    rows,
    errorBody,
    errorStatus,
    method,
    headers,
    captureAdapter,
    reportsSecret: DUMMY_REPORTS_SECRET,
    serviceRoleKey: DUMMY_SERVICE_ROLE_KEY,
    rpcPath: TAX_RPC_PATH,
    handlerPath: path.join(__dirname, "api/tax-summary.js"),
  };

  const script = `
    import { createServer } from "node:http";
    const payload = JSON.parse(process.env.TAX_TEST_PAYLOAD);
    const hits = [];

    const fake = createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString("utf8");
      hits.push({
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization,
        apikey: req.headers.apikey,
        body,
      });
      if (req.method === "POST" && req.url?.split("?")[0] === payload.rpcPath) {
        if (payload.mode === "error") {
          res.writeHead(payload.errorStatus, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify(payload.errorBody));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(payload.rows));
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ message: "unexpected path " + req.url }));
    });

    await new Promise((resolve, reject) => {
      fake.once("error", reject);
      fake.listen(0, "127.0.0.1", resolve);
    });
    const address = fake.address();
    const supabaseUrl = "http://127.0.0.1:" + address.port;
    process.env.NODE_ENV = "production";
    process.env.INTERNAL_REPORTS_SECRET = payload.reportsSecret;
    process.env.SUPABASE_URL = supabaseUrl;
    process.env.SUPABASE_SERVICE_ROLE_KEY = payload.serviceRoleKey;
    delete process.env.SUPABASE_ANON_KEY;
    delete process.env.ALLOW_INSECURE_LOCAL_ADMIN_API;
    delete process.env.VERCEL;

    try {
      const { default: taxSummaryHandler } = await import(payload.handlerPath);
      const state = { headers: {} };
      if (payload.captureAdapter) {
        const captured = { writeHeadCalls: 0, endCalls: 0 };
        let statusCode = 200;
        const extraHeaders = {};
        const adapted = {
          status(c) { statusCode = c; return this; },
          setHeader(name, value) { extraHeaders[String(name)] = String(value); return this; },
          json(body) {
            captured.writeHeadCalls += 1;
            captured.endCalls += 1;
            captured.statusCode = statusCode;
            captured.headers = {
              "Content-Type": "application/json; charset=utf-8",
              ...extraHeaders,
            };
            captured.body = JSON.stringify(body);
          },
        };
        await taxSummaryHandler(
          { method: payload.method, headers: payload.headers },
          adapted,
        );
        process.stdout.write(JSON.stringify({
          captured,
          parsed: JSON.parse(captured.body),
          hits,
          supabaseUrl,
        }));
      } else {
        const res = {
          status(code) { state.statusCode = code; return this; },
          setHeader(name, value) { state.headers[String(name)] = String(value); return this; },
          json(body) { state.body = body; return this; },
        };
        await taxSummaryHandler(
          { method: payload.method, headers: payload.headers },
          res,
        );
        process.stdout.write(JSON.stringify({ state, hits, supabaseUrl }));
      }
    } finally {
      await new Promise((resolve, reject) => {
        fake.close((err) => (err ? reject(err) : resolve()));
      });
    }
  `;

  const childEnv = { ...process.env };
  for (const key of HANDLER_ENV_KEYS) {
    delete childEnv[key];
  }
  Object.assign(childEnv, {
    TAX_TEST_PAYLOAD: JSON.stringify(payload),
    ...envExtra,
  });
  for (const key of Object.keys(childEnv)) {
    if (childEnv[key] === undefined) {
      delete childEnv[key];
    }
  }

  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: __dirname,
    env: childEnv,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    timeout: 15000,
  });

  if (result.status !== 0) {
    throw new Error(
      `tax-summary fake-rpc subprocess failed (status ${result.status}): ${result.stderr || result.stdout || result.error}`,
    );
  }

  return JSON.parse(result.stdout);
}

function assertTaxRpcHit(hits) {
  assert.equal(hits.length, 1, `expected exactly one RPC hit, got ${JSON.stringify(hits)}`);
  assert.equal(hits[0].method, "POST");
  assert.equal(hits[0].url?.split("?")[0], TAX_RPC_PATH);
  assert.equal(hits[0].authorization, `Bearer ${DUMMY_SERVICE_ROLE_KEY}`);
  assert.equal(hits[0].apikey, DUMMY_SERVICE_ROLE_KEY);
  assert.equal(hits[0].body, "{}");
}

test.beforeEach(() => {
  __resetSupabaseAccessTokenVerifierForTests();
});

test.afterEach(() => {
  __resetSupabaseAccessTokenVerifierForTests();
});

test("server.js imports and delegates /api/tax-summary to api/tax-summary.js", () => {
  assert.match(
    serverSource,
    /import\s+taxSummaryHandler\s+from\s+["']\.\/api\/tax-summary\.js["']/,
  );
  assert.match(serverSource, /pathname\s*===\s*["']\/api\/tax-summary["']/);
  assert.match(serverSource, /await\s+taxSummaryHandler\s*\(/);
  assert.match(
    serverSource,
    /taxSummaryHandler\s*\(\s*\{\s*method:\s*req\.method,\s*headers:\s*req\.headers\s*\}/,
  );
  assert.match(serverSource, /adaptExpressStyleResponse\s*\(\s*res\s*\)/);
});

test("server.js no longer inlines tax-summary auth or data loading", () => {
  assert.equal(serverSource.includes("fetchTaxSummaryTnRows"), false);
  assert.equal(serverSource.includes("Could not load tax summary."), false);
  assert.equal(
    /pathname\s*===\s*["']\/api\/tax-summary["']\s*&&\s*req\.method\s*===\s*["']GET["']/.test(
      serverSource,
    ),
    false,
  );
  const taxBlock = serverSource.match(
    /if\s*\(\s*pathname\s*===\s*["']\/api\/tax-summary["']\s*\)\s*\{[\s\S]*?\n\s*\}/,
  )?.[0];
  assert.ok(taxBlock, "expected /api/tax-summary route block");
  assert.equal(taxBlock.includes("assertReportsAuthorized"), false);
  assert.equal(taxBlock.includes("sendJson"), false);
  assert.match(taxBlock, /await\s+taxSummaryHandler\s*\(/);
  assert.equal(
    /import\s+\{\s*assertReportsAuthorized\s*\}\s+from\s+["']\.\/lib\/reports-auth\.js["']/.test(
      serverSource,
    ),
    false,
  );
  assert.equal(
    /import\s+\{\s*fetchTaxSummaryTnRows\s*\}\s+from\s+["']\.\/lib\/orders\.js["']/.test(
      serverSource,
    ),
    false,
  );
});

test("existing nexus-summary, products, cart quote, checkout, square-config, supabase-public-config delegation remain unchanged", () => {
  assert.match(
    serverSource,
    /import\s+nexusSummaryHandler\s+from\s+["']\.\/api\/nexus-summary\.js["']/,
  );
  assert.match(serverSource, /pathname\s*===\s*["']\/api\/nexus-summary["']/);
  assert.match(serverSource, /await\s+nexusSummaryHandler\s*\(/);
  assert.match(
    serverSource,
    /nexusSummaryHandler\s*\(\s*\{\s*method:\s*req\.method,\s*headers:\s*req\.headers\s*\}/,
  );

  assert.match(
    serverSource,
    /import\s+productsHandler\s+from\s+["']\.\/api\/products\.js["']/,
  );
  assert.match(serverSource, /pathname\s*===\s*["']\/api\/products["']/);
  assert.match(serverSource, /await\s+productsHandler\s*\(/);

  assert.match(
    serverSource,
    /import\s+cartQuoteHandler\s+from\s+["']\.\/api\/cart-quote\.js["']/,
  );
  assert.match(
    serverSource,
    /pathname\s*===\s*["']\/api\/cart\/quote["']\s*&&\s*req\.method\s*===\s*["']POST["']/,
  );
  assert.match(serverSource, /await\s+cartQuoteHandler\s*\(/);

  assert.match(
    serverSource,
    /import\s+checkoutHandler\s+from\s+["']\.\/api\/checkout\.js["']/,
  );
  assert.match(
    serverSource,
    /pathname\s*===\s*["']\/api\/checkout["']\s*&&\s*req\.method\s*===\s*["']POST["']/,
  );
  assert.match(serverSource, /await\s+checkoutHandler\s*\(/);

  assert.match(
    serverSource,
    /import\s+squareConfigHandler\s+from\s+["']\.\/api\/square-config\.js["']/,
  );
  assert.match(serverSource, /pathname\s*===\s*["']\/api\/square-config["']/);
  assert.match(serverSource, /await\s+squareConfigHandler\s*\(/);

  assert.match(
    serverSource,
    /import\s+supabasePublicConfigHandler\s+from\s+["']\.\/api\/supabase-public-config\.js["']/,
  );
  assert.match(
    serverSource,
    /pathname\s*===\s*["']\/api\/supabase-public-config["']/,
  );
  assert.match(serverSource, /await\s+supabasePublicConfigHandler\s*\(/);
});

test("Authorization header forwarding matches assertReportsAuthorized (lowercase Node keys)", async () => {
  // Node IncomingMessage lowercases header names; reports-auth reads authorization || Authorization.
  await withEnv(
    clearHandlerEnv({
      NODE_ENV: "production",
      INTERNAL_REPORTS_SECRET: DUMMY_REPORTS_SECRET,
    }),
    async () => {
      const missing = await invokeLocalTaxSummary("GET", {});
      assert.equal(missing.statusCode, 401);
      assert.deepEqual(missing.body, { error: "Unauthorized." });

      const lower = await invokeLocalTaxSummary("GET", {
        authorization: `Bearer ${DUMMY_REPORTS_SECRET}`,
      });
      // Auth succeeds; missing Supabase service config fails closed before any external call.
      assert.equal(lower.statusCode, 503);
      assert.equal(
        lower.body.error,
        "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set for Supabase inventory.",
      );

      const mixed = await invokeLocalTaxSummary("GET", {
        Authorization: `Bearer ${DUMMY_REPORTS_SECRET}`,
      });
      assert.equal(mixed.statusCode, 503);
      assert.equal(
        mixed.body.error,
        "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set for Supabase inventory.",
      );
    },
  );
});

test("missing authentication returns Production unauthorized status/body", async () => {
  await withEnv(
    clearHandlerEnv({
      NODE_ENV: "production",
      INTERNAL_REPORTS_SECRET: DUMMY_REPORTS_SECRET,
    }),
    async () => {
      const state = await invokeLocalTaxSummary("GET", {});
      assert.equal(state.statusCode, 401);
      assert.deepEqual(state.body, { error: "Unauthorized." });
    },
  );
});

test("invalid bearer secret returns Production forbidden status/body", async () => {
  __setSupabaseAccessTokenVerifierForTests(async () => null);

  await withEnv(
    clearHandlerEnv({
      NODE_ENV: "production",
      INTERNAL_REPORTS_SECRET: DUMMY_REPORTS_SECRET,
      // Placeholder only; JWT verifier is stubbed so no network call occurs.
      SUPABASE_URL: "http://127.0.0.1:9",
      SUPABASE_ANON_KEY: "dummy-anon-key",
    }),
    async () => {
      const state = await invokeLocalTaxSummary("GET", {
        authorization: "Bearer wrong-dummy-token",
      });
      assert.equal(state.statusCode, 403);
      assert.deepEqual(state.body, { error: "Forbidden." });
    },
  );
});

test("missing INTERNAL_REPORTS_SECRET fails closed like Production (503)", async () => {
  await withEnv(
    clearHandlerEnv({
      NODE_ENV: "production",
    }),
    async () => {
      const state = await invokeLocalTaxSummary("GET", {
        authorization: "Bearer anything",
      });
      assert.equal(state.statusCode, 503);
      assert.deepEqual(state.body, {
        error: "Admin API authentication is not configured.",
      });
      const serialized = JSON.stringify(state.body);
      assert.equal(serialized.includes("anything"), false);
      assert.equal(serialized.includes(DUMMY_REPORTS_SECRET), false);
    },
  );
});

test("POST and HEAD are rejected like Production (405) before auth/database", async () => {
  // Method gate runs before assertReportsAuthorized / fetchTaxSummaryTnRows.
  // With no secret and no Supabase config, auth would be 503 — 405 proves method-first.
  await withEnv(
    clearHandlerEnv({
      NODE_ENV: "production",
    }),
    async () => {
      for (const method of ["POST", "HEAD"]) {
        const state = await invokeLocalTaxSummary(method, {});
        assert.equal(state.statusCode, 405);
        assert.deepEqual(state.body, { error: "Method not allowed." });
      }
    },
  );

  await withEnv(
    clearHandlerEnv({
      NODE_ENV: "production",
      INTERNAL_REPORTS_SECRET: DUMMY_REPORTS_SECRET,
    }),
    async () => {
      for (const method of ["POST", "HEAD"]) {
        const state = await invokeLocalTaxSummary(method, {
          authorization: `Bearer ${DUMMY_REPORTS_SECRET}`,
        });
        assert.equal(state.statusCode, 405);
        assert.deepEqual(state.body, { error: "Method not allowed." });
      }
    },
  );
});

test("valid dummy bearer returns deterministic success via local fake tax_summary_tn RPC", () => {
  const stubRows = [
    {
      month: "2026-06",
      state: "TN",
      taxable_revenue: 5000,
      tax_collected: 475,
      total_orders: 2,
    },
    {
      month: "2026-05",
      state: "TN",
      taxable_revenue: 1200,
      tax_collected: 114,
      total_orders: 1,
    },
  ];

  const { state, hits, supabaseUrl } = invokeTaxWithFakeSupabaseRpc({
    mode: "success",
    rows: stubRows,
  });

  assert.match(supabaseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
  assertTaxRpcHit(hits);
  assert.equal(state.statusCode, 200);
  assert.equal(state.body.currency, "USD");
  assert.equal(state.body.amounts_in, "cents");
  assert.equal(
    state.body.note,
    "Tennessee (TN) paid orders only; months are UTC.",
  );
  assert.equal(typeof state.body.generated_at, "string");
  assert.ok(Number.isFinite(Date.parse(state.body.generated_at)));
  assert.deepEqual(state.body.summary, stubRows);
  assert.deepEqual(
    state.body.summary.map((r) => r.month),
    ["2026-06", "2026-05"],
  );
  assert.ok(state.body.summary.every((r) => r.state === "TN"));
  const serialized = JSON.stringify(state.body);
  assert.equal(serialized.includes(DUMMY_REPORTS_SECRET), false);
  assert.equal(serialized.includes(DUMMY_SERVICE_ROLE_KEY), false);
});

test("response shape, Tennessee-only fields, units, and row ordering remain unchanged", () => {
  const ordered = [
    {
      month: "2026-03",
      state: "TN",
      taxable_revenue: 300,
      tax_collected: 28,
      total_orders: 3,
    },
    {
      month: "2026-02",
      state: "TN",
      taxable_revenue: 200,
      tax_collected: 19,
      total_orders: 2,
    },
    {
      month: "2026-01",
      state: "TN",
      taxable_revenue: 100,
      tax_collected: 9,
      total_orders: 1,
    },
  ];

  const { state, hits } = invokeTaxWithFakeSupabaseRpc({
    mode: "success",
    rows: ordered,
  });

  assertTaxRpcHit(hits);
  assert.equal(state.statusCode, 200);
  assert.deepEqual(Object.keys(state.body).sort(), [
    "amounts_in",
    "currency",
    "generated_at",
    "note",
    "summary",
  ]);
  assert.equal(state.body.amounts_in, "cents");
  assert.equal(state.body.currency, "USD");
  assert.deepEqual(state.body.summary, ordered);
  assert.deepEqual(
    state.body.summary.map((r) => r.month),
    ["2026-03", "2026-02", "2026-01"],
  );
  for (const row of state.body.summary) {
    assert.deepEqual(Object.keys(row).sort(), [
      "month",
      "state",
      "tax_collected",
      "taxable_revenue",
      "total_orders",
    ].sort());
    assert.equal(row.state, "TN");
    assert.equal(typeof row.taxable_revenue, "number");
    assert.equal(typeof row.tax_collected, "number");
    assert.equal(typeof row.total_orders, "number");
  }
});

test("empty summary array is a valid success body (local fake RPC only)", () => {
  const { state, hits } = invokeTaxWithFakeSupabaseRpc({
    mode: "success",
    rows: [],
  });

  assertTaxRpcHit(hits);
  assert.equal(state.statusCode, 200);
  assert.deepEqual(state.body.summary, []);
  assert.equal(
    state.body.note,
    "Tennessee (TN) paid orders only; months are UTC.",
  );
});

test("deterministic database error matches Production handler behavior", () => {
  const { state, hits } = invokeTaxWithFakeSupabaseRpc({
    mode: "error",
    errorStatus: 500,
    errorBody: {
      message: "tax_summary_tn rpc failed",
      code: "PGRST000",
      details: null,
      hint: null,
    },
  });

  assertTaxRpcHit(hits);
  assert.equal(state.statusCode, 500);
  assert.deepEqual(state.body, { error: "tax_summary_tn rpc failed" });
});

test("adaptExpressStyleResponse path sets JSON Content-Type like sendJson", () => {
  const { captured, parsed, hits } = invokeTaxWithFakeSupabaseRpc({
    mode: "success",
    rows: [],
    captureAdapter: true,
  });

  assertTaxRpcHit(hits);
  assert.equal(captured.statusCode, 200);
  assert.equal(captured.writeHeadCalls, 1);
  assert.equal(captured.endCalls, 1);
  assert.equal(
    captured.headers["Content-Type"],
    "application/json; charset=utf-8",
  );
  assert.equal(captured.headers["Cache-Control"], undefined);
  assert.equal(parsed.currency, "USD");
  assert.equal(parsed.amounts_in, "cents");
  assert.deepEqual(parsed.summary, []);
});

test("environment mutations from tax routing tests are restored", async () => {
  const before = {};
  for (const key of HANDLER_ENV_KEYS) {
    before[key] = process.env[key];
  }

  await withEnv(
    clearHandlerEnv({
      NODE_ENV: "test",
      INTERNAL_REPORTS_SECRET: "temporary-should-restore",
    }),
    async () => {
      assert.equal(process.env.INTERNAL_REPORTS_SECRET, "temporary-should-restore");
      assert.equal(process.env.SUPABASE_URL, undefined);
    },
  );

  for (const key of HANDLER_ENV_KEYS) {
    assert.equal(process.env[key], before[key], key);
  }
});
