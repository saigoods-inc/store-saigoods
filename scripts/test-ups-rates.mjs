import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getRates } from "../lib/ups-rating.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function stripOptionalQuotes(value) {
  const v = String(value || "").trim();
  if (
    (v.startsWith('"') && v.endsWith('"') && v.length >= 2) ||
    (v.startsWith("'") && v.endsWith("'") && v.length >= 2)
  ) {
    return v.slice(1, -1);
  }
  return v;
}

/**
 * Match local app behavior: read repo-root `.env` for local scripts.
 * Existing process env still wins (no override).
 */
function loadLocalDotEnv() {
  const envPath = path.join(__dirname, "..", ".env");
  try {
    const raw = readFileSync(envPath, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }
      const eq = trimmed.indexOf("=");
      if (eq < 1) {
        continue;
      }
      const key = trimmed.slice(0, eq).trim();
      const value = stripOptionalQuotes(trimmed.slice(eq + 1));
      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
  } catch {
    // Optional in local development.
  }
}

function fromEnvOrDefault(name, fallback = "") {
  const v = String(process.env[name] || "").trim();
  return v || fallback;
}

function sampleAddress() {
  return {
    line1: fromEnvOrDefault("UPS_TEST_TO_LINE1", "11 W 42nd St"),
    line2: fromEnvOrDefault("UPS_TEST_TO_LINE2", ""),
    city: fromEnvOrDefault("UPS_TEST_TO_CITY", "New York"),
    state: fromEnvOrDefault("UPS_TEST_TO_STATE", "NY"),
    postalCode: fromEnvOrDefault("UPS_TEST_TO_POSTAL_CODE", "10036"),
    country: fromEnvOrDefault("UPS_TEST_TO_COUNTRY", "US"),
  };
}

function sampleParcels() {
  return [
    {
      length: fromEnvOrDefault("UPS_TEST_PARCEL_LENGTH", "12"),
      width: fromEnvOrDefault("UPS_TEST_PARCEL_WIDTH", "8"),
      height: fromEnvOrDefault("UPS_TEST_PARCEL_HEIGHT", "6"),
      distance_unit: fromEnvOrDefault("UPS_TEST_PARCEL_DISTANCE_UNIT", "in"),
      weight: fromEnvOrDefault("UPS_TEST_PARCEL_WEIGHT", "5"),
      mass_unit: fromEnvOrDefault("UPS_TEST_PARCEL_MASS_UNIT", "lb"),
      metadata: "test-ups-rates",
    },
  ];
}

async function main() {
  loadLocalDotEnv();

  const address = sampleAddress();
  const parcels = sampleParcels();

  console.info("[ups-test] Requesting live UPS rates...");
  console.info(
    "[ups-test] Destination:",
    JSON.stringify(
      {
        line1: address.line1,
        city: address.city,
        state: address.state,
        postalCode: address.postalCode,
        country: address.country,
      },
      null,
      2,
    ),
  );
  console.info("[ups-test] Parcel count:", parcels.length);

  try {
    const result = await getRates({ address, parcels });
    console.info("[ups-test] UPS rate lookup succeeded.");
    console.info(
      JSON.stringify(
        {
          provider: result.provider,
          bestRate: result.bestRate,
          rates: result.rates,
        },
        null,
        2,
      ),
    );
  } catch (err) {
    console.error("[ups-test] UPS rate lookup failed.");
    console.error(
      JSON.stringify(
        {
          message: err?.message || "Unknown UPS error",
          category: err?.category || "unknown_error",
          code: err?.code || null,
          statusCode: err?.statusCode || null,
          retryable: Boolean(err?.retryable),
          debug: err?.debug || null,
        },
        null,
        2,
      ),
    );
    process.exitCode = 1;
  }
}

main();
