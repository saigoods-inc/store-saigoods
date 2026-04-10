import { createClient } from "@supabase/supabase-js";

let cachedClient = null;

function getClient() {
  if (cachedClient) {
    return cachedClient;
  }
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("Supabase credentials are not configured.");
  }
  cachedClient = createClient(url, key, { auth: { persistSession: false } });
  return cachedClient;
}

export function normalizeDiscountCode(raw) {
  const s = String(raw || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "");
  if (!s || s.length > 32) {
    return null;
  }
  if (!/^HC-[A-Z0-9]{5}$/.test(s)) {
    return null;
  }
  return s;
}

/**
 * Read-only: code exists and is unused.
 */
export async function assertDiscountCodeAvailable(code) {
  const client = getClient();
  const { data, error } = await client
    .from("discount_codes")
    .select("id,code,is_used")
    .eq("code", code)
    .maybeSingle();

  if (error) {
    throw error;
  }
  if (!data) {
    const e = new Error("That discount code is not valid.");
    e.statusCode = 400;
    throw e;
  }
  if (data.is_used) {
    const e = new Error("This discount code has already been used.");
    e.statusCode = 400;
    throw e;
  }
}

/**
 * Atomic claim: only one concurrent checkout can win.
 * @returns {Promise<boolean>} true if this order claimed the code
 */
export async function claimDiscountCodeForOrder(code, orderId) {
  const client = getClient();
  const oid = String(orderId ?? "").trim();
  if (!oid) {
    return false;
  }

  const { data, error } = await client
    .from("discount_codes")
    .update({
      is_used: true,
      used_at: new Date().toISOString(),
      used_by_order_id: oid,
    })
    .eq("code", code)
    .eq("is_used", false)
    .select("id")
    .maybeSingle();

  if (error) {
    console.error("[discount-codes] claim failed", error);
    return false;
  }
  return Boolean(data);
}

/**
 * If payment fails after a claim, release the code for this order.
 */
export async function releaseDiscountCodeForOrder(orderId) {
  const client = getClient();
  const oid = String(orderId ?? "").trim();
  if (!oid) {
    return;
  }

  const { error } = await client
    .from("discount_codes")
    .update({
      is_used: false,
      used_at: null,
      used_by_order_id: null,
    })
    .eq("used_by_order_id", oid)
    .eq("is_used", true);

  if (error) {
    console.error("[discount-codes] release failed", error);
  }
}
