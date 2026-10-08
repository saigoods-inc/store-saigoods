import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("manual carrier create/update enforce live discount conditions on signed quotes", () => {
  const env = { ...process.env };
  for (const key of [
    "NODE_TEST_CONTEXT", "SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY",
    "SQUARE_ACCESS_TOKEN", "SHIPPO_API_TOKEN", "RESEND_API_KEY",
  ]) delete env[key];
  Object.assign(env, {
    CATALOG_CONFIG_BACKEND: "file", PACKAGING_CONFIG_BACKEND: "file", INVENTORY_BACKEND: "file",
    INTERNAL_REPORTS_SECRET: "test-internal-secret",
    MANUAL_ORDER_QUOTE_SIGNING_SECRET: "test-manual-quote-secret",
  });
  const result = spawnSync(process.execPath, [
    "--experimental-test-module-mocks", "--test",
    fileURLToPath(new URL("./test-fixtures/manual-order-discount-cartons.fixture.mjs", import.meta.url)),
  ], { env, encoding: "utf8", timeout: 30_000 });
  const output = `${result.stdout}\n${result.stderr}`;
  assert.ifError(result.error);
  assert.equal(result.status, 0, output);
  assert.match(output, /tests 8/);
  assert.match(output, /pass 8/);
  assert.match(output, /fail 0/);
  assert.match(output, /skipped 0/);
});
