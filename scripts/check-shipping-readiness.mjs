import "../import-env.mjs";
import { readFile } from "node:fs/promises";

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok: Boolean(ok), detail });
}

const token = String(process.env.SHIPPO_API_TOKEN || "").trim();
const provider = String(process.env.SHIPPING_RATE_PROVIDER || "shippo").trim().toLowerCase();
const packagingBackend = String(process.env.PACKAGING_CONFIG_BACKEND || "").trim().toLowerCase();
const fallbackRaw = String(process.env.CHECKOUT_LIVE_SHIPPING_FALLBACK || "").trim().toLowerCase();
const purchaseLockRaw = String(process.env.SHIPPO_LABEL_DB_LOCK || "").trim().toLowerCase();
const enabled = (value) => ["1", "true", "on", "yes", "enabled"].includes(String(value || "").trim().toLowerCase());
const carrierIds = [
  String(process.env.SHIPPO_UPS_CARRIER_ACCOUNT_ID || "").trim(),
  ...String(process.env.SHIPPO_CARRIER_ACCOUNT_IDS || "").split(",").map((value) => value.trim()),
].filter(Boolean);

check("Shipping provider", provider === "shippo", provider || "missing");
check(
  "Durable packaging settings",
  packagingBackend === "supabase",
  packagingBackend || "set PACKAGING_CONFIG_BACKEND=supabase and install sql/patch-runtime-packaging-settings.sql",
);
check("Shippo token", Boolean(token), token ? (token.startsWith("shippo_live_") ? "live token" : "test token") : "missing");
check("Carrier account", carrierIds.length > 0, carrierIds.length ? `${carrierIds.length} configured` : "missing");
check(
  "Warehouse address",
  ["SHIPPO_FROM_STREET1", "SHIPPO_FROM_CITY", "SHIPPO_FROM_STATE", "SHIPPO_FROM_ZIP"].every((key) =>
    Boolean(String(process.env[key] || "").trim()),
  ),
  "street, city, state, and ZIP required",
);
check(
  "Backup-rate policy",
  ["0", "1", "true", "false", "on", "off", "yes", "no", "enabled", "disabled"].includes(fallbackRaw),
  fallbackRaw || "not explicitly set",
);
check(
  "Database label-purchase lock",
  ["1", "true", "on", "yes", "enabled"].includes(purchaseLockRaw),
  purchaseLockRaw || "not explicitly enabled",
);
check("Checkout quote signing secret", Boolean(String(process.env.CHECKOUT_QUOTE_SIGNING_SECRET || "").trim()), "dedicated secret required");
check("Admin staff allowlist", Boolean(String(process.env.ADMIN_ALLOWED_EMAILS || "").trim()), "ADMIN_ALLOWED_EMAILS required");
check(
  "Checkout payment idempotency migration",
  enabled(process.env.CHECKOUT_PAYMENT_IDEMPOTENCY_DB),
  "run sql/patch-checkout-payment-idempotency.sql, then set flag to 1",
);
check(
  "Atomic online payment inventory migration",
  enabled(process.env.ONLINE_PAYMENT_INVENTORY_ATOMIC_DB),
  "run sql/patch-online-payment-inventory-atomic.sql, then set flag to 1",
);
check(
  "Admin staff authorization migration",
  enabled(process.env.ADMIN_STAFF_AUTHORIZATION_DB),
  "run sql/patch-admin-staff-authorization.sql, add staff, then set flag to 1",
);

try {
  const packaging = JSON.parse(await readFile(new URL("../data/fulfillment-packaging.json", import.meta.url), "utf8"));
  const profiles = packaging?.products && typeof packaging.products === "object" ? Object.keys(packaging.products) : [];
  const cartons = Array.isArray(packaging?.shippingCartons) ? packaging.shippingCartons : [];
  check("Packaging profiles", profiles.length > 0, `${profiles.length} configured`);
  check("Shipping cartons", cartons.length > 0, `${cartons.length} configured`);
  const addedCartons = cartons.filter((carton) => carton?.packageType !== "factory_case");
  const calibrated = addedCartons.length > 0 && addedCartons.every(
    (carton) => Number(carton?.tareWeightLb) > 0 && Number(carton?.costCents) > 0,
  );
  check(
    "Loose-box carton tare weights and costs",
    calibrated,
    calibrated ? "calibrated" : "zero or missing values remain",
  );
  const factoryCases = cartons.filter((carton) => carton?.packageType === "factory_case");
  const factoryCasesMeasured = factoryCases.length > 0 && factoryCases.every((carton) => {
    const outer = carton?.outer || {};
    return Number(outer.length) > 0 && Number(outer.width) > 0 && Number(outer.height) > 0 && Number(carton?.maxWeightLb) > 0;
  });
  check(
    "Factory-case parcel measurements",
    factoryCasesMeasured,
    factoryCasesMeasured ? "measured" : "outer dimensions or filled weight missing",
  );
  const hasSmallLooseCarton = cartons.some((carton) => Number(carton?.maxRetailBoxes) > 0 && Number(carton.maxRetailBoxes) <= 2);
  const hasMediumLooseCarton = cartons.some((carton) => Number(carton?.maxRetailBoxes) > 2 && Number(carton.maxRetailBoxes) <= 5);
  check("Loose-box carton sizes", hasSmallLooseCarton && hasMediumLooseCarton, "measured 1-2 box and 3-5 box cartons required");
} catch (error) {
  check("Packaging configuration", false, String(error?.message || error));
}

for (const item of checks) {
  console.log(`${item.ok ? "PASS" : "FAIL"}  ${item.name}: ${item.detail}`);
}
if (checks.some((item) => !item.ok)) process.exitCode = 1;
