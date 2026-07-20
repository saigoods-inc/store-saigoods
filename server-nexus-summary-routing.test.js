import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import nexusSummaryHandler from "./api/nexus-summary.js";
import {
  __resetSupabaseAccessTokenVerifierForTests,
  __setSupabaseAccessTokenVerifierForTests,
} from "./lib/reports-auth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverSource = readFileSync(path.join(__dirname, "server.js"), "utf8");

const DUMMY_REPORTS_SECRET = "dummy-local-nexus-reports-secret";
const DUMMY_SERVICE_ROLE_KEY = "dummy-local-supabase-service-role-key";
const NEXUS_RPC_PATH = "/rest/v1/rpc/nexus_summary";

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
 * Mirrors server.js Express → Vercel adaptation for /api/nexus-summary:
 * `{ method: req.method, headers: req.headers }` + adaptExpressStyleResponse.
 */
async function invokeLocalNexusSummary(method, headers = {}) {
  const res = mockRes();
  await nexusSummaryHandler({ method, headers }, res);
  return res.state;
}

/**
 * Run authenticated nexus-summary against a temporary localhost PostgREST stub.
 *
 * Inspected client path (do not guess):
 *   createClient(SUPABASE_URL).rpc("nexus_summary")
 *   → POST {SUPABASE_URL}/rest/v1/rpc/nexus_summary
 *   body "{}"
 *   headers Authorization/apikey = service role key
 *
 * The fake server runs inside the child so spawnSync cannot deadlock the
 * parent's event loop. The child also isolates lib/supabase-admin.js's
 * cached service client from sibling tests.
 */
function invokeNexusWithFakeSupabaseRpc({
  mode,
  rows = [],
  errorBody = {
    message: "nexus_summary rpc failed",
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
    rpcPath: NEXUS_RPC_PATH,
    handlerPath: path.join(__dirname, "api/nexus-summary.js"),
  };

  const script = `
    import { createServer } from "node:http";
    const payload = JSON.parse(process.env.NEXUS_TEST_PAYLOAD);
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
      const { default: nexusSummaryHandler } = await import(payload.handlerPath);
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
        await nexusSummaryHandler(
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
        await nexusSummaryHandler(
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
    NEXUS_TEST_PAYLOAD: JSON.stringify(payload),
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
      `nexus-summary fake-rpc subprocess failed (status ${result.status}): ${result.stderr || result.stdout || result.error}`,
    );
  }

  return JSON.parse(result.stdout);
}

function assertNexusRpcHit(hits) {
  assert.equal(hits.length, 1, `expected exactly one RPC hit, got ${JSON.stringify(hits)}`);
  assert.equal(hits[0].method, "POST");
  assert.equal(hits[0].url?.split("?")[0], NEXUS_RPC_PATH);
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

test("server.js imports and delegates /api/nexus-summary to api/nexus-summary.js", () => {
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
  assert.match(serverSource, /adaptExpressStyleResponse\s*\(\s*res\s*\)/);
});

test("server.js no longer inlines nexus-summary auth or data loading", () => {
  assert.equal(serverSource.includes("fetchNexusSummaryRows"), false);
  assert.equal(serverSource.includes("Could not load nexus summary."), false);
  assert.equal(
    /pathname\s*===\s*["']\/api\/nexus-summary["']\s*&&\s*req\.method\s*===\s*["']GET["']/.test(
      serverSource,
    ),
    false,
  );
  const nexusBlock = serverSource.match(
    /if\s*\(\s*pathname\s*===\s*["']\/api\/nexus-summary["']\s*\)\s*\{[\s\S]*?\n\s*\}/,
  )?.[0];
  assert.ok(nexusBlock, "expected /api/nexus-summary route block");
  assert.equal(nexusBlock.includes("assertReportsAuthorized"), false);
  assert.equal(nexusBlock.includes("sendJson"), false);
  assert.match(nexusBlock, /await\s+nexusSummaryHandler\s*\(/);
});

test("existing products, cart quote, checkout, square-config, supabase-public-config delegation remain unchanged", () => {
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
      const missing = await invokeLocalNexusSummary("GET", {});
      assert.equal(missing.statusCode, 401);
      assert.deepEqual(missing.body, { error: "Unauthorized." });

      const lower = await invokeLocalNexusSummary("GET", {
        authorization: `Bearer ${DUMMY_REPORTS_SECRET}`,
      });
      // Auth succeeds; missing Supabase service config fails closed before any external call.
      assert.equal(lower.statusCode, 503);
      assert.equal(
        lower.body.error,
        "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set for Supabase inventory.",
      );

      const mixed = await invokeLocalNexusSummary("GET", {
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
      const state = await invokeLocalNexusSummary("GET", {});
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
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_ANON_KEY: "dummy-anon-key",
    }),
    async () => {
      const state = await invokeLocalNexusSummary("GET", {
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
      const state = await invokeLocalNexusSummary("GET", {
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

test("POST and HEAD are rejected like Production (405)", async () => {
  await withEnv(
    clearHandlerEnv({
      NODE_ENV: "production",
      INTERNAL_REPORTS_SECRET: DUMMY_REPORTS_SECRET,
    }),
    async () => {
      for (const method of ["POST", "HEAD"]) {
        const state = await invokeLocalNexusSummary(method, {
          authorization: `Bearer ${DUMMY_REPORTS_SECRET}`,
        });
        assert.equal(state.statusCode, 405);
        assert.deepEqual(state.body, { error: "Method not allowed." });
      }
    },
  );
});

test("valid dummy bearer returns deterministic success via local fake nexus_summary RPC", () => {
  const stubRows = [
    { state: "CA", total_revenue: 5000, total_orders: 2 },
    { state: "TN", total_revenue: 1200, total_orders: 1 },
  ];

  const { state, hits, supabaseUrl } = invokeNexusWithFakeSupabaseRpc({
    mode: "success",
    rows: stubRows,
  });

  assert.match(supabaseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
  assertNexusRpcHit(hits);
  assert.equal(state.statusCode, 200);
  assert.equal(state.body.currency, "USD");
  assert.equal(state.body.amounts_in, "cents");
  assert.equal(typeof state.body.generated_at, "string");
  assert.ok(Number.isFinite(Date.parse(state.body.generated_at)));
  assert.deepEqual(state.body.summary, stubRows);
  assert.deepEqual(
    state.body.summary.map((r) => r.state),
    ["CA", "TN"],
  );
  const serialized = JSON.stringify(state.body);
  assert.equal(serialized.includes(DUMMY_REPORTS_SECRET), false);
  assert.equal(serialized.includes(DUMMY_SERVICE_ROLE_KEY), false);
});

test("response shape and summary row ordering remain unchanged", () => {
  const ordered = [
    { state: "AK", total_revenue: 10, total_orders: 1 },
    { state: "AL", total_revenue: 20, total_orders: 2 },
    { state: "UNKNOWN", total_revenue: 0, total_orders: 0 },
  ];

  const { state, hits } = invokeNexusWithFakeSupabaseRpc({
    mode: "success",
    rows: ordered,
  });

  assertNexusRpcHit(hits);
  assert.equal(state.statusCode, 200);
  assert.deepEqual(Object.keys(state.body).sort(), [
    "amounts_in",
    "currency",
    "generated_at",
    "summary",
  ]);
  assert.deepEqual(state.body.summary, ordered);
  assert.deepEqual(
    state.body.summary.map((r) => r.state),
    ["AK", "AL", "UNKNOWN"],
  );
});

test("empty summary array is a valid success body (local fake RPC only)", () => {
  const { state, hits } = invokeNexusWithFakeSupabaseRpc({
    mode: "success",
    rows: [],
  });

  assertNexusRpcHit(hits);
  assert.equal(state.statusCode, 200);
  assert.deepEqual(state.body.summary, []);
});

test("deterministic database error matches Production handler behavior", () => {
  const { state, hits } = invokeNexusWithFakeSupabaseRpc({
    mode: "error",
    errorStatus: 500,
    errorBody: {
      message: "nexus_summary rpc failed",
      code: "PGRST000",
      details: null,
      hint: null,
    },
  });

  assertNexusRpcHit(hits);
  assert.equal(state.statusCode, 500);
  assert.deepEqual(state.body, { error: "nexus_summary rpc failed" });
});

test("adaptExpressStyleResponse path sets JSON Content-Type like sendJson", () => {
  const { captured, parsed, hits } = invokeNexusWithFakeSupabaseRpc({
    mode: "success",
    rows: [],
    captureAdapter: true,
  });

  assertNexusRpcHit(hits);
  assert.equal(captured.statusCode, 200);
  assert.equal(captured.writeHeadCalls, 1);
  assert.equal(captured.endCalls, 1);
  assert.equal(
    captured.headers["Content-Type"],
    "application/json; charset=utf-8",
  );
  assert.equal(captured.headers["Cache-Control"], undefined);
  assert.equal(parsed.currency, "USD");
  assert.deepEqual(parsed.summary, []);
});

test("environment mutations from nexus routing tests are restored", async () => {
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
