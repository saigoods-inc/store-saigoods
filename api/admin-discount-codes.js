import { assertReportsAuthorized } from "../lib/reports-auth.js";
import { createClient } from "@supabase/supabase-js";
import { normalizeDiscountCode, normalizeDiscountPercent } from "../lib/discount-codes.js";

function getServiceClient() {
  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) {
    const e = new Error("Supabase is not configured.");
    e.statusCode = 503;
    throw e;
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed." });
    return;
  }

  try {
    await assertReportsAuthorized(req);
    const client = getServiceClient();
    if (req.method === "POST") {
      const mode = String(req.body?.mode || "manual").trim().toLowerCase();
      const percentOff = normalizeDiscountPercent(req.body?.percentOff, 0);
      if (!percentOff) {
        res.status(400).json({ error: "Discount percentage must be between 1 and 100." });
        return;
      }
      const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
      const randomCode = () => `HC-${Array.from({ length: 5 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("")}`;
      const requestedCode = mode === "random" ? randomCode() : normalizeDiscountCode(req.body?.code);
      if (!requestedCode) {
        res.status(400).json({ error: "Enter 3–20 letters, numbers, or hyphens for the code." });
        return;
      }
      let created = null;
      let lastError = null;
      for (let attempt = 0; attempt < (mode === "random" ? 5 : 1); attempt += 1) {
        const code = attempt === 0 ? requestedCode : randomCode();
        const result = await client.from("discount_codes").insert({ code, percent_off: percentOff }).select("code,is_used,used_at,used_by_order_id,created_at,percent_off").single();
        if (!result.error) { created = result.data; break; }
        lastError = result.error;
        if (String(result.error.code || "") !== "23505") break;
      }
      if (!created) {
        if (String(lastError?.code || "") === "23505") {
          res.status(409).json({ error: "That discount code already exists." });
          return;
        }
        throw lastError || new Error("Could not create discount code.");
      }
      res.status(201).json({ code: created });
      return;
    }

    const { data, error } = await client
      .from("discount_codes")
      .select("code,is_used,used_at,used_by_order_id,created_at,percent_off")
      .order("created_at", { ascending: false });

    if (error) {
      throw error;
    }

    res.status(200).json({
      generated_at: new Date().toISOString(),
      codes: Array.isArray(data) ? data : [],
    });
  } catch (error) {
    console.error(error);
    res.status(error.statusCode || 500).json({ error: error.message || "Could not load discount codes." });
  }
}
