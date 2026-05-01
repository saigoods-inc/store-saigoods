/**
 * Supabase URL + anon key for browser clients (admin UI RLS). Never return service role.
 * Tolerates common alternate names (e.g. Next.js-style) when .env or hosting uses them.
 */
function firstNonEmptyEnvKey(names) {
  for (const k of names) {
    const v = process.env[k];
    if (v == null) {
      continue;
    }
    const t = String(v).trim();
    if (t) {
      return t;
    }
  }
  return "";
}

export function resolveSupabasePublicConfigFromEnv() {
  const supabaseUrl = firstNonEmptyEnvKey([
    "SUPABASE_URL",
    "NEXT_PUBLIC_SUPABASE_URL",
    "PUBLIC_SUPABASE_URL",
  ]);
  const supabaseAnonKey = firstNonEmptyEnvKey([
    "SUPABASE_ANON_KEY",
    "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    "SUPABASE_PUBLIC_ANON_KEY",
  ]);
  return { supabaseUrl, supabaseAnonKey };
}

/** JSON body for GET /api/supabase-public-config when URL or anon key is missing. */
export function buildSupabasePublicConfig503Body() {
  const { supabaseUrl, supabaseAnonKey } = resolveSupabasePublicConfigFromEnv();
  const body = { error: "Supabase public configuration is not set." };
  const hasServiceRole = Boolean(
    firstNonEmptyEnvKey(["SUPABASE_SERVICE_ROLE_KEY"]),
  );
  if (supabaseUrl && !supabaseAnonKey && hasServiceRole) {
    body.hint =
      "SUPABASE_URL is set and a service role key is present, but SUPABASE_ANON_KEY is missing. Add the anon (public) key from Supabase Dashboard → Project Settings → API (the same project). Admin login uses the anon key in the browser; never expose SUPABASE_SERVICE_ROLE_KEY to clients.";
  } else if (!supabaseAnonKey) {
    body.hint =
      "Set SUPABASE_ANON_KEY (and SUPABASE_URL) in the app environment. Use the public anon key from Supabase, not the service role.";
  } else if (!supabaseUrl) {
    body.hint = "Set SUPABASE_URL in the app environment.";
  }
  return body;
}
