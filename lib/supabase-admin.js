import { createClient } from "@supabase/supabase-js";

let _serviceClient = null;

/**
 * Supabase client with service role (server only). Never import this from client-side code.
 */
export function getSupabaseServiceRoleClient() {
  if (_serviceClient) {
    return _serviceClient;
  }
  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) {
    const err = new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set for Supabase inventory.");
    err.statusCode = 503;
    throw err;
  }
  _serviceClient = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return _serviceClient;
}

/**
 * Inventory storage mode.
 * - `supabase`: Postgres + RPC (default whenever `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are set).
 * - `file`: bundled/mutable JSON under `data/` or `/tmp` (local dev or explicit opt-out).
 *
 * Set `INVENTORY_BACKEND=file` to keep file-based stock while still using Supabase for other features.
 */
export function getInventoryBackendMode() {
  const explicit = String(process.env.INVENTORY_BACKEND || "").trim().toLowerCase();
  if (explicit === "file") return "file";
  if (explicit === "supabase") return "supabase";
  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (url && key) return "supabase";
  return "file";
}

export function isSupabaseInventoryBackend() {
  return getInventoryBackendMode() === "supabase";
}
