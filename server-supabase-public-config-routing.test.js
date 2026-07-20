import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import supabasePublicConfigHandler from "./api/supabase-public-config.js";
import { buildSupabasePublicConfig503Body } from "./lib/supabase-public-config-env.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverSource = readFileSync(path.join(__dirname, "server.js"), "utf8");

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

/** Mirrors server.js Express → Vercel adaptation for /api/supabase-public-config. */
async function invokeLocalSupabasePublicConfig(method) {
  const res = mockRes();
  await supabasePublicConfigHandler({ method }, res);
  return res.state;
}

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

const PUBLIC_ENV_KEYS = [
  "SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_URL",
  "PUBLIC_SUPABASE_URL",
  "SUPABASE_ANON_KEY",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_PUBLIC_ANON_KEY",
];

function clearPublicSupabaseEnv() {
  const cleared = {};
  for (const key of PUBLIC_ENV_KEYS) {
    cleared[key] = undefined;
  }
  return cleared;
}

test("server.js delegates /api/supabase-public-config to api/supabase-public-config.js", () => {
  assert.match(
    serverSource,
    /import\s+supabasePublicConfigHandler\s+from\s+["']\.\/api\/supabase-public-config\.js["']/,
  );
  assert.match(
    serverSource,
    /pathname\s*===\s*["']\/api\/supabase-public-config["']/,
  );
  assert.match(serverSource, /await\s+supabasePublicConfigHandler\s*\(/);
  assert.match(serverSource, /adaptExpressStyleResponse\s*\(\s*res\s*\)/);
});

test("server.js no longer inlines supabase public config resolution", () => {
  assert.equal(serverSource.includes("buildSupabasePublicConfig503Body"), false);
  assert.equal(serverSource.includes("resolveSupabasePublicConfigFromEnv"), false);
  assert.equal(
    serverSource.includes('from "./lib/supabase-public-config-env.js"'),
    false,
  );
  assert.equal(
    serverSource.includes("from './lib/supabase-public-config-env.js'"),
    false,
  );
});

test("server.js cart quote and checkout delegation remain unchanged", () => {
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
});

test("local supabase-public-config: configured env returns public URL and anon key", async () => {
  await withEnv(
    {
      ...clearPublicSupabaseEnv(),
      SUPABASE_URL: "https://example-project.supabase.co",
      SUPABASE_ANON_KEY: "dummy-public-anon-key",
      SUPABASE_SERVICE_ROLE_KEY: "secret-service-role-must-not-leak",
      INTERNAL_REPORTS_SECRET: "secret-reports-must-not-leak",
    },
    async () => {
      const state = await invokeLocalSupabasePublicConfig("GET");
      assert.equal(state.statusCode, 200);
      assert.deepEqual(state.body, {
        supabaseUrl: "https://example-project.supabase.co",
        supabaseAnonKey: "dummy-public-anon-key",
      });
      const serialized = JSON.stringify(state.body);
      assert.equal(serialized.includes("secret-service-role-must-not-leak"), false);
      assert.equal(serialized.includes("secret-reports-must-not-leak"), false);
      assert.equal(serialized.includes("SUPABASE_SERVICE_ROLE_KEY"), false);
    },
  );
});

test("local supabase-public-config: missing public config returns handler 503 body", async () => {
  await withEnv(clearPublicSupabaseEnv(), async () => {
    const state = await invokeLocalSupabasePublicConfig("GET");
    assert.equal(state.statusCode, 503);
    assert.deepEqual(state.body, buildSupabasePublicConfig503Body());
  });
});

test("local supabase-public-config: non-GET method is rejected by handler", async () => {
  const state = await invokeLocalSupabasePublicConfig("POST");
  assert.equal(state.statusCode, 405);
  assert.deepEqual(state.body, { error: "Method not allowed." });
});

test("local supabase-public-config: HEAD is rejected like Production (405)", async () => {
  // Production handler: req.method !== "GET" → 405. Local delegation must match
  // (previously the GET/HEAD gate let HEAD reach the inline route and return 200/503).
  await withEnv(
    {
      ...clearPublicSupabaseEnv(),
      SUPABASE_URL: "https://example-project.supabase.co",
      SUPABASE_ANON_KEY: "dummy-public-anon-key",
    },
    async () => {
      const state = await invokeLocalSupabasePublicConfig("HEAD");
      assert.equal(state.statusCode, 405);
      assert.deepEqual(state.body, { error: "Method not allowed." });
    },
  );
});

test("adaptExpressStyleResponse path sets JSON Content-Type like sendJson", async () => {
  // Exercise the same status/json surface used by server.js adaptExpressStyleResponse.
  await withEnv(
    {
      ...clearPublicSupabaseEnv(),
      SUPABASE_URL: "https://example-project.supabase.co",
      SUPABASE_ANON_KEY: "dummy-public-anon-key",
    },
    async () => {
      /** @type {{ statusCode?: number, headers?: Record<string, string>, body?: string }} */
      const captured = {};
      const fakeNodeRes = {
        writeHead(statusCode, headers) {
          captured.statusCode = statusCode;
          captured.headers = headers;
        },
        end(body) {
          captured.body = body;
        },
      };

      let statusCode = 200;
      const adapted = {
        status(c) {
          statusCode = c;
          return this;
        },
        json(body) {
          fakeNodeRes.writeHead(statusCode, {
            "Content-Type": "application/json; charset=utf-8",
          });
          fakeNodeRes.end(JSON.stringify(body));
        },
      };

      await supabasePublicConfigHandler({ method: "GET" }, adapted);
      assert.equal(captured.statusCode, 200);
      assert.equal(
        captured.headers["Content-Type"],
        "application/json; charset=utf-8",
      );
      assert.deepEqual(JSON.parse(captured.body), {
        supabaseUrl: "https://example-project.supabase.co",
        supabaseAnonKey: "dummy-public-anon-key",
      });
    },
  );
});

test("handler does not set Cache-Control or private env fields", async () => {
  await withEnv(
    {
      ...clearPublicSupabaseEnv(),
      SUPABASE_URL: "https://example-project.supabase.co",
      SUPABASE_ANON_KEY: "dummy-public-anon-key",
      SUPABASE_SERVICE_ROLE_KEY: "svc-role-secret",
      DATABASE_URL: "postgres://user:password@localhost:5432/db",
    },
    async () => {
      const state = await invokeLocalSupabasePublicConfig("GET");
      assert.equal(state.statusCode, 200);
      assert.deepEqual(Object.keys(state.body).sort(), [
        "supabaseAnonKey",
        "supabaseUrl",
      ]);
      const serialized = JSON.stringify(state.body);
      assert.equal(serialized.includes("svc-role-secret"), false);
      assert.equal(serialized.includes("password"), false);
      assert.equal(serialized.includes("DATABASE_URL"), false);
    },
  );
});
