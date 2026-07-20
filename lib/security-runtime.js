/**
 * Shared production/local security runtime helpers.
 */

export function isProductionSensitiveRuntime() {
  return process.env.NODE_ENV === "production" || process.env.VERCEL === "1";
}

export function isTruthyEnv(name) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === "") {
    return false;
  }
  const s = String(raw).trim().toLowerCase();
  return s === "true" || s === "1" || s === "yes" || s === "on";
}

/** Insecure local-only opt-in; ignored on production/Vercel. */
export function allowInsecureLocalAdminApi() {
  return !isProductionSensitiveRuntime() && isTruthyEnv("ALLOW_INSECURE_LOCAL_ADMIN_API");
}

/** Insecure local-only opt-in; ignored on production/Vercel. */
export function allowInsecureLocalShippoWebhook() {
  return !isProductionSensitiveRuntime() && isTruthyEnv("ALLOW_INSECURE_LOCAL_SHIPPO_WEBHOOK");
}
