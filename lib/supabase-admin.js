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

export function isSupabaseInventoryBackend() {
  return String(process.env.INVENTORY_BACKEND || "").trim().toLowerCase() === "supabase";
}
