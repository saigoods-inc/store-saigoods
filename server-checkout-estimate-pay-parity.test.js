/**
 * Phase 9 — normal-suite wrapper for estimate/pay parity.
 *
 * Spawns an isolated child that runs the module-mock fixture with
 * --experimental-test-module-mocks so `node --test` (without that flag) still passes.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_REL = path.join("test-fixtures", "checkout-estimate-pay-parity.fixture.mjs");
const FIXTURE_ABS = path.join(__dirname, FIXTURE_REL);

const SANITIZE_ENV_KEYS = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SQUARE_ACCESS_TOKEN",
  "SHIPPO_API_TOKEN",
  "RESEND_API_KEY",
];

function buildChildEnv() {
  const env = { ...process.env };
  for (const key of SANITIZE_ENV_KEYS) {
    delete env[key];
  }
  // Parent `node --test` sets NODE_TEST_CONTEXT; nested --test then skips files.
  delete env.NODE_TEST_CONTEXT;
  env.INVENTORY_BACKEND = "file";
  env.ADDRESS_VALIDATION = "off";
  return env;
}

function runParityFixture() {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--experimental-test-module-mocks", "--test", FIXTURE_ABS],
      {
        cwd: __dirname,
        env: buildChildEnv(),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      resolve({ code, signal, stdout, stderr });
    });
  });
}

test("checkout estimate/pay parity fixture passes in isolated child with module mocks", async () => {
  assert.equal(
    typeof process.execPath,
    "string",
    "process.execPath required to spawn Node with experimental module mocks",
  );

  const result = await runParityFixture();
  const combined = `${result.stdout}\n${result.stderr}`;

  if (result.code !== 0) {
    console.error("--- parity fixture stdout ---");
    console.error(result.stdout);
    console.error("--- parity fixture stderr ---");
    console.error(result.stderr);
  }

  assert.equal(
    result.code,
    0,
    `parity fixture child exited ${result.code}${result.signal ? ` signal=${result.signal}` : ""}\n${combined}`,
  );
  assert.equal(
    /skipping running files/i.test(combined),
    false,
    `nested node --test was skipped (clear NODE_TEST_CONTEXT):\n${combined}`,
  );
  assert.match(combined, /tests 12/);
  assert.match(combined, /pass 12/);
  assert.match(combined, /fail 0/);
  assert.equal(/skipped 12/.test(combined), false);
  assert.equal(/todo 12/.test(combined), false);
});
