/**
 * Public Supabase URL + anon key for browser clients (admin UI).
 * Safe to expose: anon key is restricted by RLS.
 */
export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed." });
    return;
  }

  const supabaseUrl = process.env.SUPABASE_URL?.trim();
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY?.trim();

  if (!supabaseUrl || !supabaseAnonKey) {
    res.status(503).json({ error: "Supabase public configuration is not set." });
    return;
  }

  res.status(200).json({ supabaseUrl, supabaseAnonKey });
}
