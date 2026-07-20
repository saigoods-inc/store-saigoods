/**
 * Protects reporting and admin APIs:
 * - Authorization: Bearer <INTERNAL_REPORTS_SECRET> (scripts / cron), or
 * - Authorization: Bearer <Supabase access JWT> (signed-in staff on /admin).
 * - Fails closed when neither method can succeed.
 */

import { createClient } from "@supabase/supabase-js";
import {
  allowInsecureLocalAdminApi,
  isProductionSensitiveRuntime,
} from "./security-runtime.js";

/** @type {((token: string) => Promise<{ id: string, email?: string | null } | null>) | null} */
let verifySupabaseAccessTokenForTests = null;

/**
 * Test hook — replaces live Supabase JWT verification.
 * @param {((token: string) => Promise<{ id: string, email?: string | null } | null>) | null} fn
 */
export function __setSupabaseAccessTokenVerifierForTests(fn) {
  verifySupabaseAccessTokenForTests = fn;
}

export function __resetSupabaseAccessTokenVerifierForTests() {
  verifySupabaseAccessTokenForTests = null;
}

function getSupabasePublicConfig() {
  const url = process.env.SUPABASE_URL?.trim();
  const anon = process.env.SUPABASE_ANON_KEY?.trim();
  if (!url || !anon) {
    return null;
  }
  return { url, anon };
}

function extractBearerToken(req) {
  const auth = String(req?.headers?.authorization || req?.headers?.Authorization || "");
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  return m?.[1]?.trim() || null;
}

function authConfigurationError(message) {
  const err = new Error(message);
  err.statusCode = 503;
  return err;
}

function unauthorizedError() {
  const err = new Error("Unauthorized.");
  err.statusCode = 401;
  return err;
}

function forbiddenError() {
  const err = new Error("Forbidden.");
  err.statusCode = 403;
  return err;
}

async function verifySupabaseAccessToken(token) {
  if (verifySupabaseAccessTokenForTests) {
    return verifySupabaseAccessTokenForTests(token);
  }

  const cfg = getSupabasePublicConfig();
  if (!cfg) {
    return null;
  }

  const supabase = createClient(cfg.url, cfg.anon, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await supabase.auth.getUser(token);
  if (!error && data?.user?.id) {
    return { id: data.user.id, email: data.user.email || null };
  }
  return null;
}

function assertAdminAuthConfigured(secretConfigured, supabaseConfigured) {
  if (!isProductionSensitiveRuntime()) {
    return;
  }
  if (!secretConfigured && !supabaseConfigured) {
    throw authConfigurationError("Admin API authentication is not configured.");
  }
}

/**
 * @param {import("http").IncomingMessage} req
 * @returns {Promise<"insecure_local_bypass" | "internal_secret" | "supabase_jwt">}
 */
async function resolveAuthorizedAdminMethod(req) {
  if (allowInsecureLocalAdminApi()) {
    return "insecure_local_bypass";
  }

  const secret = process.env.INTERNAL_REPORTS_SECRET?.trim() || "";
  const secretConfigured = Boolean(secret);
  const supabaseConfigured = Boolean(getSupabasePublicConfig());
  const token = extractBearerToken(req);

  assertAdminAuthConfigured(secretConfigured, supabaseConfigured);

  if (secretConfigured && token && token === secret) {
    return "internal_secret";
  }

  if (token && supabaseConfigured) {
    const user = await verifySupabaseAccessToken(token);
    if (user?.id) {
      return "supabase_jwt";
    }
  }

  if (!token) {
    throw unauthorizedError();
  }

  throw forbiddenError();
}

export async function assertReportsAuthorized(req) {
  await resolveAuthorizedAdminMethod(req);
}

/**
 * Best-effort actor for audit fields on admin inventory mutations.
 * @returns {{ kind: "service", email: null } | { kind: "user", email: string | null, id: string } | null}
 */
export async function getReportsActor(req) {
  const secret = process.env.INTERNAL_REPORTS_SECRET?.trim();
  const token = extractBearerToken(req);

  if (secret && token && token === secret) {
    return { kind: "service", email: null };
  }

  if (token) {
    const user = await verifySupabaseAccessToken(token);
    if (user?.id) {
      return { kind: "user", email: user.email || null, id: user.id };
    }
  }

  return null;
}
