const DEFAULT_UPS_OAUTH_BASE_URL = "https://wwwcie.ups.com";
const DEFAULT_UPS_AUTH_TIMEOUT_MS = 15000;
const TOKEN_REFRESH_SKEW_MS = 60_000;

let cachedToken = null;
let inFlightTokenPromise = null;

function parseTimeoutMs(raw, fallbackMs) {
  const n = Math.round(Number(raw));
  return Number.isFinite(n) && n >= 1_000 && n <= 120_000 ? n : fallbackMs;
}

function trimEnv(name) {
  return String(process.env[name] || "").trim();
}

function resolveOauthBaseUrl() {
  return trimEnv("UPS_OAUTH_BASE_URL") || trimEnv("UPS_API_BASE_URL") || DEFAULT_UPS_OAUTH_BASE_URL;
}

function buildTokenUrl() {
  const base = resolveOauthBaseUrl().replace(/\/+$/, "");
  return `${base}/security/v1/oauth/token`;
}

function tokenIsFresh(entry, nowMs = Date.now()) {
  if (!entry || typeof entry !== "object") {
    return false;
  }
  const accessToken = String(entry.accessToken || "").trim();
  const expiresAtMs = Number(entry.expiresAtMs);
  if (!accessToken || !Number.isFinite(expiresAtMs)) {
    return false;
  }
  return expiresAtMs - TOKEN_REFRESH_SKEW_MS > nowMs;
}

export function getUpsAuthConfig() {
  const clientId = trimEnv("UPS_CLIENT_ID");
  const clientSecret = trimEnv("UPS_CLIENT_SECRET");
  const timeoutMs = parseTimeoutMs(process.env.UPS_AUTH_TIMEOUT_MS, DEFAULT_UPS_AUTH_TIMEOUT_MS);
  const tokenUrl = buildTokenUrl();

  return {
    clientId,
    clientSecret,
    timeoutMs,
    tokenUrl,
  };
}

export function isUpsAuthConfigured() {
  const cfg = getUpsAuthConfig();
  return Boolean(cfg.clientId && cfg.clientSecret);
}

export function clearUpsAccessTokenCache() {
  cachedToken = null;
}

function makeConfigError(message) {
  const err = new Error(message);
  err.name = "UpsAuthError";
  err.category = "config_error";
  err.statusCode = 503;
  err.retryable = false;
  return err;
}

function makeAuthError(message, extras = {}) {
  const err = new Error(message);
  err.name = "UpsAuthError";
  err.category = "auth_error";
  err.statusCode = Number(extras.statusCode) || 502;
  err.retryable = extras.retryable !== false;
  if (extras.debug) {
    err.debug = extras.debug;
  }
  return err;
}

async function requestUpsAccessToken() {
  const cfg = getUpsAuthConfig();
  if (!cfg.clientId || !cfg.clientSecret) {
    throw makeConfigError("UPS OAuth is not configured (missing UPS_CLIENT_ID or UPS_CLIENT_SECRET).");
  }

  const basic = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`, "utf8").toString("base64");
  const body = new URLSearchParams({ grant_type: "client_credentials" });

  let response;
  let json = {};
  try {
    response = await fetch(cfg.tokenUrl, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
  } catch (err) {
    if (err?.name === "TimeoutError") {
      throw makeAuthError("UPS OAuth request timed out.", {
        statusCode: 504,
        retryable: true,
      });
    }
    throw makeAuthError("UPS OAuth request failed.", {
      statusCode: 502,
      retryable: true,
      debug: { cause: String(err?.message || err) },
    });
  }

  try {
    json = await response.json();
  } catch {
    json = {};
  }

  if (!response.ok) {
    const providerMessage =
      String(json?.error_description || json?.error || "").trim() || `UPS OAuth HTTP ${response.status}`;
    throw makeAuthError(providerMessage, {
      statusCode: response.status || 502,
      retryable: response.status >= 500,
      debug: { responseJson: json },
    });
  }

  const accessToken = String(json?.access_token || "").trim();
  const tokenType = String(json?.token_type || "").trim();
  const expiresInSec = Math.max(1, Math.round(Number(json?.expires_in) || 0));

  if (!accessToken || tokenType.toLowerCase() !== "bearer" || !Number.isFinite(expiresInSec)) {
    throw makeAuthError("UPS OAuth response did not include a usable bearer token.", {
      statusCode: 502,
      retryable: true,
      debug: { responseJson: json },
    });
  }

  const now = Date.now();
  const entry = {
    accessToken,
    tokenType: "Bearer",
    expiresInSec,
    obtainedAtMs: now,
    expiresAtMs: now + expiresInSec * 1000,
  };
  cachedToken = entry;
  return entry;
}

export async function getUpsAccessToken({ forceRefresh = false } = {}) {
  const now = Date.now();
  if (!forceRefresh && tokenIsFresh(cachedToken, now)) {
    return cachedToken.accessToken;
  }

  if (inFlightTokenPromise) {
    const shared = await inFlightTokenPromise;
    return shared.accessToken;
  }

  inFlightTokenPromise = requestUpsAccessToken();
  try {
    const entry = await inFlightTokenPromise;
    return entry.accessToken;
  } finally {
    inFlightTokenPromise = null;
  }
}
