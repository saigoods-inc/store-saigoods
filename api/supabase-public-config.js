import {
  buildSupabasePublicConfig503Body,
  resolveSupabasePublicConfigFromEnv,
} from "../lib/supabase-public-config-env.js";

/**
 * Public Supabase URL + anon key for browser clients (admin UI).
 * Safe to expose: anon key is restricted by RLS.
 * (Vercel serverless: `import "../import-env.mjs"` is not used; platform env is injected.)
 */

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed." });
    return;
  }

  const { supabaseUrl, supabaseAnonKey } = resolveSupabasePublicConfigFromEnv();

  if (!supabaseUrl || !supabaseAnonKey) {
    res.status(503).json(buildSupabasePublicConfig503Body());
    return;
  }

  res.status(200).json({ supabaseUrl, supabaseAnonKey });
}
