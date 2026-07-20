import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import squareConfigHandler from "./api/square-config.js";

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

/** Mirrors server.js Express → Vercel adaptation for /api/square-config. */
async function invokeLocalSquareConfig(method) {
  const res = mockRes();
  await squareConfigHandler({ method }, res);
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

/** Every env key the Square config handler (and its helpers) may read. */
const HANDLER_ENV_KEYS = [
  "SQUARE_APPLICATION_ID",
  "SQUARE_LOCATION_ID",
  "SQUARE_ENVIRONMENT",
  "ADDRESS_VALIDATION",
  "NODE_ENV",
];

/** Dummy private keys set only to prove they never appear in responses. */
const PRIVATE_DUMMY_ENV_KEYS = [
  "SQUARE_ACCESS_TOKEN",
  "SQUARE_WEBHOOK_SIGNATURE_KEY",
  "INTERNAL_REPORTS_SECRET",
  "SUPABASE_SERVICE_ROLE_KEY",
];

function clearHandlerEnv() {
  const cleared = {};
  for (const key of HANDLER_ENV_KEYS) {
    cleared[key] = undefined;
  }
  return cleared;
}

const INTENDED_PUBLIC_KEYS = [
  "checkoutAddressValidationEnabled",
  "checkoutShowAddressValidationDisabledBanner",
  "squareApplicationId",
  "squareEnvironment",
  "squareLocationId",
].sort();

const INTENDED_PUBLIC_KEYS_WITH_ERROR = [...INTENDED_PUBLIC_KEYS, "error"].sort();

test("server.js delegates /api/square-config to api/square-config.js", () => {
  assert.match(
    serverSource,
    /import\s+squareConfigHandler\s+from\s+["']\.\/api\/square-config\.js["']/,
  );
  assert.match(serverSource, /pathname\s*===\s*["']\/api\/square-config["']/);
  assert.match(serverSource, /await\s+squareConfigHandler\s*\(/);
  assert.match(serverSource, /adaptExpressStyleResponse\s*\(\s*res\s*\)/);
});

test("server.js no longer inlines square config resolution", () => {
  assert.equal(
    serverSource.includes("from \"./lib/address-validation.js\""),
    false,
  );
  assert.equal(
    serverSource.includes("from './lib/address-validation.js'"),
    false,
  );
  assert.equal(serverSource.includes("isCheckoutAddressValidationEnabled"), false);
  assert.equal(
    serverSource.includes("Embedded checkout is not configured."),
    false,
  );
  assert.equal(
    /SQUARE_APPLICATION_ID\s*\?\.trim\(\)/.test(serverSource),
    false,
  );
});

test("server.js cart quote, checkout, and supabase-public-config delegation remain unchanged", () => {
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
    /import\s+supabasePublicConfigHandler\s+from\s+["']\.\/api\/supabase-public-config\.js["']/,
  );
  assert.match(
    serverSource,
    /pathname\s*===\s*["']\/api\/supabase-public-config["']/,
  );
  assert.match(serverSource, /await\s+supabasePublicConfigHandler\s*\(/);
});

test("local square-config: configured env returns public Square fields", async () => {
  await withEnv(
    {
      ...clearHandlerEnv(),
      SQUARE_APPLICATION_ID: "sandbox-sq0idb-dummy-app-id",
      SQUARE_LOCATION_ID: "LDUMMYLOCATIONID",
      SQUARE_ENVIRONMENT: "sandbox",
      ADDRESS_VALIDATION: undefined,
      NODE_ENV: "development",
      SQUARE_ACCESS_TOKEN: "secret-access-token-must-not-leak",
      SQUARE_WEBHOOK_SIGNATURE_KEY: "secret-webhook-key-must-not-leak",
      INTERNAL_REPORTS_SECRET: "secret-reports-must-not-leak",
    },
    async () => {
      const state = await invokeLocalSquareConfig("GET");
      assert.equal(state.statusCode, 200);
      assert.equal(state.body.squareApplicationId, "sandbox-sq0idb-dummy-app-id");
      assert.equal(state.body.squareLocationId, "LDUMMYLOCATIONID");
      assert.equal(state.body.squareEnvironment, "sandbox");
      assert.equal(state.body.checkoutAddressValidationEnabled, true);
      assert.equal(state.body.checkoutShowAddressValidationDisabledBanner, false);
      assert.deepEqual(Object.keys(state.body).sort(), INTENDED_PUBLIC_KEYS);
      const serialized = JSON.stringify(state.body);
      assert.equal(serialized.includes("secret-access-token-must-not-leak"), false);
      assert.equal(serialized.includes("secret-webhook-key-must-not-leak"), false);
      assert.equal(serialized.includes("secret-reports-must-not-leak"), false);
      assert.equal(serialized.includes("SQUARE_ACCESS_TOKEN"), false);
      assert.equal(serialized.includes("SQUARE_WEBHOOK_SIGNATURE_KEY"), false);
    },
  );
});

test("local square-config: missing public config returns handler 503 body", async () => {
  await withEnv(
    {
      ...clearHandlerEnv(),
      SQUARE_ACCESS_TOKEN: "secret-access-token-must-not-leak",
      NODE_ENV: "development",
    },
    async () => {
      const state = await invokeLocalSquareConfig("GET");
      assert.equal(state.statusCode, 503);
      assert.equal(
        state.body.error,
        "Embedded checkout is not configured. Add SQUARE_APPLICATION_ID and SQUARE_LOCATION_ID.",
      );
      assert.equal(state.body.squareApplicationId, null);
      assert.equal(state.body.squareLocationId, null);
      assert.equal(state.body.squareEnvironment, "production");
      assert.equal(state.body.checkoutAddressValidationEnabled, true);
      assert.equal(state.body.checkoutShowAddressValidationDisabledBanner, false);
      assert.deepEqual(Object.keys(state.body).sort(), INTENDED_PUBLIC_KEYS_WITH_ERROR);
      const serialized = JSON.stringify(state.body);
      assert.equal(serialized.includes("secret-access-token-must-not-leak"), false);
    },
  );
});

test("local square-config: incomplete config (only application id) returns 503", async () => {
  await withEnv(
    {
      ...clearHandlerEnv(),
      SQUARE_APPLICATION_ID: "sandbox-sq0idb-dummy-app-id",
      NODE_ENV: "development",
    },
    async () => {
      const state = await invokeLocalSquareConfig("GET");
      assert.equal(state.statusCode, 503);
      assert.equal(state.body.squareApplicationId, null);
      assert.equal(state.body.squareLocationId, null);
    },
  );
});

test("local square-config: non-GET method is rejected by handler", async () => {
  // Method rejection runs before any env reads; still wrap so order/isolation stay explicit.
  await withEnv(clearHandlerEnv(), async () => {
    const state = await invokeLocalSquareConfig("POST");
    assert.equal(state.statusCode, 405);
    assert.deepEqual(state.body, { error: "Method not allowed." });
  });
});

test("local square-config: HEAD is rejected like Production (405)", async () => {
  await withEnv(
    {
      ...clearHandlerEnv(),
      SQUARE_APPLICATION_ID: "sandbox-sq0idb-dummy-app-id",
      SQUARE_LOCATION_ID: "LDUMMYLOCATIONID",
      NODE_ENV: "development",
    },
    async () => {
      const state = await invokeLocalSquareConfig("HEAD");
      assert.equal(state.statusCode, 405);
      assert.deepEqual(state.body, { error: "Method not allowed." });
    },
  );
});

test("adaptExpressStyleResponse path sets JSON Content-Type like sendJson", async () => {
  await withEnv(
    {
      ...clearHandlerEnv(),
      SQUARE_APPLICATION_ID: "sandbox-sq0idb-dummy-app-id",
      SQUARE_LOCATION_ID: "LDUMMYLOCATIONID",
      SQUARE_ENVIRONMENT: "production",
      NODE_ENV: "development",
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

      await squareConfigHandler({ method: "GET" }, adapted);
      assert.equal(captured.statusCode, 200);
      assert.equal(
        captured.headers["Content-Type"],
        "application/json; charset=utf-8",
      );
      const parsed = JSON.parse(captured.body);
      assert.equal(parsed.squareApplicationId, "sandbox-sq0idb-dummy-app-id");
      assert.equal(parsed.squareLocationId, "LDUMMYLOCATIONID");
      assert.equal(parsed.squareEnvironment, "production");
      assert.equal(captured.headers["Cache-Control"], undefined);
    },
  );
});

test("handler does not expose private Square or application secrets", async () => {
  await withEnv(
    {
      ...clearHandlerEnv(),
      SQUARE_APPLICATION_ID: "sandbox-sq0idb-dummy-app-id",
      SQUARE_LOCATION_ID: "LDUMMYLOCATIONID",
      NODE_ENV: "development",
      SQUARE_ACCESS_TOKEN: "EAAAl-secret-access-token",
      SQUARE_WEBHOOK_SIGNATURE_KEY: "whsec-secret-signature",
      INTERNAL_REPORTS_SECRET: "reports-secret-value",
      SUPABASE_SERVICE_ROLE_KEY: "svc-role-secret",
    },
    async () => {
      const state = await invokeLocalSquareConfig("GET");
      assert.equal(state.statusCode, 200);
      assert.deepEqual(Object.keys(state.body).sort(), INTENDED_PUBLIC_KEYS);
      const serialized = JSON.stringify(state.body);
      assert.equal(serialized.includes("EAAAl-secret-access-token"), false);
      assert.equal(serialized.includes("whsec-secret-signature"), false);
      assert.equal(serialized.includes("reports-secret-value"), false);
      assert.equal(serialized.includes("svc-role-secret"), false);
      for (const key of PRIVATE_DUMMY_ENV_KEYS) {
        assert.equal(serialized.includes(key), false);
      }
    },
  );
});
