import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const [credentialArg, projectRoot = process.cwd(), secretsOutputPath = ""] = process.argv.slice(2);
if (!credentialArg) {
  console.error("Usage: node scripts/configure-vercel-preview.mjs <token-file|--local-auth> [project-root]");
  process.exit(2);
}

function parseDotEnv(filePath) {
  const values = {};
  const raw = fs.readFileSync(filePath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator < 1) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

const useLocalAuth = credentialArg === "--local-auth";
const token = useLocalAuth ? "" : fs.readFileSync(credentialArg, "utf8").trim();
if (!useLocalAuth && !token) throw new Error("The Vercel token file is empty.");

const local = parseDotEnv(path.join(projectRoot, ".env"));
const copiedNames = [
  "ADDRESS_VALIDATION",
  "ADMIN_ALLOWED_EMAILS",
  "CHECKOUT_LIVE_SHIPPING_FALLBACK",
  "CHECKOUT_RESIDENTIAL_SURCHARGE_USD",
  "RESEND_API_KEY",
  "RESEND_FROM",
  "SHIPPING_BUFFER_CENTS",
  "SHIPPING_RATE_PROVIDER",
  "SHIPPO_API_BASE_URL",
  "SHIPPO_API_TOKEN",
  "SHIPPO_DEFAULT_ITEM_WEIGHT_LB",
  "SHIPPO_FROM_CITY",
  "SHIPPO_FROM_COUNTRY",
  "SHIPPO_FROM_NAME",
  "SHIPPO_FROM_STATE",
  "SHIPPO_FROM_STREET1",
  "SHIPPO_FROM_ZIP",
  "SHIPPO_UPS_CARRIER_ACCOUNT_ID",
  "SHIPPO_WEBHOOK_TOKEN",
  "SQUARE_ACCESS_TOKEN",
  "SQUARE_APPLICATION_ID",
  "SQUARE_ENVIRONMENT",
  "SQUARE_LOCATION_ID",
  "SQUARE_WEBHOOK_SIGNATURE_KEY_SANDBOX",
  "SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_URL",
];

const variables = Object.fromEntries(
  copiedNames.filter((name) => String(local[name] || "").trim()).map((name) => [name, local[name]]),
);

if (!String(variables.SHIPPO_API_TOKEN || "").startsWith("shippo_test_")) {
  throw new Error("Refusing preview setup: the local Shippo token is not a test token.");
}
if (String(variables.SQUARE_ENVIRONMENT || "").toLowerCase() !== "sandbox") {
  throw new Error("Refusing preview setup: the local Square environment is not sandbox.");
}

const generatedSecrets = {
  INTERNAL_REPORTS_SECRET: crypto.randomBytes(32).toString("base64url"),
  CRON_SECRET: crypto.randomBytes(32).toString("base64url"),
  CHECKOUT_QUOTE_SIGNING_SECRET: crypto.randomBytes(32).toString("base64url"),
  MANUAL_ORDER_QUOTE_SIGNING_SECRET: crypto.randomBytes(32).toString("base64url"),
  MANUAL_PAYMENT_LINK_SIGNING_SECRET: crypto.randomBytes(32).toString("base64url"),
};

Object.assign(variables, {
  INVENTORY_BACKEND: "supabase",
  PACKAGING_CONFIG_BACKEND: "supabase",
  WAREHOUSE_CONFIG_BACKEND: "supabase",
  SHIPPO_LABEL_DB_LOCK: "1",
  CHECKOUT_PAYMENT_IDEMPOTENCY_DB: "1",
  ONLINE_PAYMENT_INVENTORY_ATOMIC_DB: "1",
  ADMIN_STAFF_AUTHORIZATION_DB: "1",
  ...generatedSecrets,
});

if (secretsOutputPath) {
  fs.writeFileSync(secretsOutputPath, `${JSON.stringify(generatedSecrets)}\n`, { mode: 0o600 });
}

for (const [name, value] of Object.entries(variables)) {
  const args = [
      "vercel",
      "env",
      "add",
      name,
      "preview",
      "--force",
      "--sensitive",
      "--yes",
      "--scope",
      "sai-goods-inc",
    ];
  if (token) args.push("--token", token);
  const result = spawnSync(
    "npx",
    args,
    { cwd: projectRoot, input: `${value}\n`, encoding: "utf8" },
  );
  if (result.status !== 0) {
    console.error(`FAIL ${name}`);
    process.exit(result.status || 1);
  }
  console.log(`PASS ${name}`);
}

console.log(`Configured ${Object.keys(variables).length} Preview variables.`);
