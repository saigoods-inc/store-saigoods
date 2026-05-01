/**
 * Load repo-root `.env` before any other app module reads process.env.
 * (server.js used to call loadDotEnv() after all imports, which is too late if a dependency
 * ever snapshots env at load time, and is harder to reason about for SHIPPING_* / API keys.)
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dirname, ".env");

try {
  const raw = readFileSync(envPath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }
    const key = trimmed
      .slice(0, separatorIndex)
      .trim()
      .replace(/^\uFEFF/, "");
    let value = trimmed.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    // Always apply from `.env` so local file wins over empty/stale host env (same as dotenv override).
    process.env[key] = value;
  }
} catch {
  /* .env is optional in local development */
}
