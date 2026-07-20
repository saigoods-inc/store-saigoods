import assert from "node:assert/strict";
import test from "node:test";
import {
  __resetSupabaseAccessTokenVerifierForTests,
  __setSupabaseAccessTokenVerifierForTests,
  assertReportsAuthorized,
} from "./reports-auth.js";

const BASE_ENV = {
  NODE_ENV: "test",
  VERCEL: undefined,
  INTERNAL_REPORTS_SECRET: undefined,
  SUPABASE_URL: undefined,
  SUPABASE_ANON_KEY: undefined,
  ALLOW_INSECURE_LOCAL_ADMIN_API: undefined,
};

/** @type {NodeJS.ProcessEnv} */
let savedEnv = null;

function saveEnv() {
  savedEnv = { ...process.env };
}

function restoreEnv() {
  if (!savedEnv) {
    return;
  }
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, savedEnv);
  savedEnv = null;
}

/**
 * @param {Record<string, string | undefined>} patch
 */
function applyEnv(patch) {
  for (const [key, value] of Object.entries({ ...BASE_ENV, ...patch })) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function req(authHeader) {
  return {
    headers: authHeader ? { authorization: authHeader } : {},
  };
}

test.beforeEach(() => {
  saveEnv();
  __resetSupabaseAccessTokenVerifierForTests();
});

test.afterEach(() => {
  restoreEnv();
  __resetSupabaseAccessTokenVerifierForTests();
});

test("production + no credentials + no internal secret is denied", async () => {
  applyEnv({
    NODE_ENV: "production",
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_ANON_KEY: "anon-key",
  });

  await assert.rejects(
    () => assertReportsAuthorized(req()),
    (err) => {
      assert.equal(err.statusCode, 401);
      assert.equal(err.message, "Unauthorized.");
      return true;
    },
  );
});

test("vercel runtime + no credentials + no internal secret is denied", async () => {
  applyEnv({
    VERCEL: "1",
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_ANON_KEY: "anon-key",
  });

  await assert.rejects(
    () => assertReportsAuthorized(req()),
    (err) => err.statusCode === 401,
  );
});

test("production + wrong bearer secret is denied", async () => {
  applyEnv({
    NODE_ENV: "production",
    INTERNAL_REPORTS_SECRET: "expected-secret",
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_ANON_KEY: "anon-key",
  });
  __setSupabaseAccessTokenVerifierForTests(async () => null);

  await assert.rejects(
    () => assertReportsAuthorized(req("Bearer wrong-secret")),
    (err) => {
      assert.equal(err.statusCode, 403);
      assert.equal(err.message, "Forbidden.");
      return true;
    },
  );
});

test("production + correct bearer secret is allowed", async () => {
  applyEnv({
    NODE_ENV: "production",
    INTERNAL_REPORTS_SECRET: "expected-secret",
  });

  await assert.doesNotReject(() => assertReportsAuthorized(req("Bearer expected-secret")));
});

test("valid supabase jwt path remains allowed", async () => {
  applyEnv({
    NODE_ENV: "production",
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_ANON_KEY: "anon-key",
  });
  __setSupabaseAccessTokenVerifierForTests(async (token) =>
    token === "valid-jwt" ? { id: "user-1", email: "staff@example.com" } : null,
  );

  await assert.doesNotReject(() => assertReportsAuthorized(req("Bearer valid-jwt")));
});

test("invalid supabase jwt is denied", async () => {
  applyEnv({
    NODE_ENV: "production",
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_ANON_KEY: "anon-key",
  });
  __setSupabaseAccessTokenVerifierForTests(async () => null);

  await assert.rejects(
    () => assertReportsAuthorized(req("Bearer not-a-valid-jwt")),
    (err) => err.statusCode === 403,
  );
});

test("local environment does not allow unrestricted access by default", async () => {
  applyEnv({
    NODE_ENV: "development",
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_ANON_KEY: "anon-key",
  });

  await assert.rejects(
    () => assertReportsAuthorized(req()),
    (err) => err.statusCode === 401,
  );
});

test("explicit local bypass works only locally", async () => {
  applyEnv({
    NODE_ENV: "development",
    ALLOW_INSECURE_LOCAL_ADMIN_API: "true",
  });

  await assert.doesNotReject(() => assertReportsAuthorized(req()));
});

test("explicit local bypass is ignored in production", async () => {
  applyEnv({
    NODE_ENV: "production",
    ALLOW_INSECURE_LOCAL_ADMIN_API: "true",
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_ANON_KEY: "anon-key",
  });

  await assert.rejects(
    () => assertReportsAuthorized(req()),
    (err) => err.statusCode === 401,
  );
});

test("missing server configuration returns 503 without exposing secret details", async () => {
  applyEnv({
    NODE_ENV: "production",
  });
  process.env.INTERNAL_REPORTS_SECRET = "super-secret-value";

  await assert.rejects(
    () => assertReportsAuthorized(req("Bearer anything")),
    (err) => {
      assert.equal(err.statusCode, 403);
      assert.ok(!String(err.message).includes("super-secret-value"));
      return true;
    },
  );

  delete process.env.INTERNAL_REPORTS_SECRET;
  await assert.rejects(
    () => assertReportsAuthorized(req("Bearer anything")),
    (err) => {
      assert.equal(err.statusCode, 503);
      assert.equal(err.message, "Admin API authentication is not configured.");
      assert.ok(!String(err.message).includes("super-secret-value"));
      assert.ok(!String(err.message).includes("anything"));
      return true;
    },
  );
});
