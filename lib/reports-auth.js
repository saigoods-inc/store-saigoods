/**
 * Protects reporting APIs:
 * - If INTERNAL_REPORTS_SECRET is set: require either
 *   `Authorization: Bearer <secret>` (scripts / cron) or
 *   `Authorization: Bearer <Supabase access JWT>` (signed-in staff on /admin).
 * - If secret is unset: routes stay open (local dev only — do not use unset in production).
 */

import { createClient } from "@supabase/supabase-js";

export async function assertReportsAuthorized(req) {
  const secret = process.env.INTERNAL_REPORTS_SECRET?.trim();
  const auth = String(req.headers?.authorization || req.headers?.Authorization || "");

  if (secret && auth === `Bearer ${secret}`) {
    return;
  }

  const m = /^Bearer\s+(.+)$/i.exec(auth);
  const token = m?.[1]?.trim();
  if (token) {
    const url = process.env.SUPABASE_URL?.trim();
    const anon = process.env.SUPABASE_ANON_KEY?.trim();
    if (url && anon) {
      const supabase = createClient(url, anon, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const { data, error } = await supabase.auth.getUser(token);
      if (!error && data?.user?.id) {
        return;
      }
    }
  }

  if (!secret) {
    return;
  }

  const err = new Error("Unauthorized.");
  err.statusCode = 401;
  throw err;
}
