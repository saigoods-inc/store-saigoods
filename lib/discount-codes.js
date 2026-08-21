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
  if (!/^[A-Z0-9][A-Z0-9-]{2,31}$/.test(s)) {
    return null;
  }
  return s;
}

export function normalizeDiscountPercent(raw, fallback = 7) {
  const percent = Math.round(Number(raw));
  return Number.isFinite(percent) && percent >= 1 && percent <= 100 ? percent : fallback;
}

/**
 * Read-only: code exists and is unused.
 */
export async function assertDiscountCodeAvailable(code) {
  const client = getClient();
  const { data, error } = await client
    .from("discount_codes")
    .select("id,code,is_used,percent_off")
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
  return { ...data, percentOff: normalizeDiscountPercent(data.percent_off) };
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
  if (data) {
    return true;
  }

  // A network retry for the same checkout order must not reject its existing claim.
  const { data: existing, error: existingError } = await client
    .from("discount_codes")
    .select("id")
    .eq("code", code)
    .eq("is_used", true)
    .eq("used_by_order_id", oid)
    .maybeSingle();
  if (existingError) {
    console.error("[discount-codes] existing claim lookup failed", existingError);
    return false;
  }
  return Boolean(existing);
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
