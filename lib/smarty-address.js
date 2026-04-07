/**
 * Smarty US Street API (server-side only).
 * https://www.smarty.com/docs/cloud/us-street-api
 */

export function isSmartyConfigured() {
  return Boolean(
    process.env.SMARTY_AUTH_ID?.trim() && process.env.SMARTY_AUTH_TOKEN?.trim(),
  );
}

/**
 * @param {{ line1: string, line2?: string, city: string, state: string, postalCode: string }} addr
 * @returns {Promise<{ ok: boolean, reason?: string, raw?: unknown }>}
 */
export async function verifySmartyUsAddress(addr) {
  const id = process.env.SMARTY_AUTH_ID?.trim();
  const token = process.env.SMARTY_AUTH_TOKEN?.trim();
  if (!id || !token) {
    return { ok: true };
  }

  const line1 = String(addr.line1 || "").trim();
  const line2 = String(addr.line2 || "").trim();
  const city = String(addr.city || "").trim();
  const state = String(addr.state || "").trim().toUpperCase();
  const zipRaw = String(addr.postalCode || "").trim();
  const digits = zipRaw.replace(/\D/g, "");
  const zip5 = digits.length >= 5 ? digits.slice(0, 5) : "";

  const street = [line1, line2].filter(Boolean).join(" ").trim();
  if (!street || !city || !state || zip5.length !== 5) {
    return { ok: false, reason: "incomplete" };
  }

  const url = new URL("https://us-street.api.smarty.com/street-address");
  url.searchParams.set("auth-id", id);
  url.searchParams.set("auth-token", token);
  url.searchParams.set("street", street);
  url.searchParams.set("city", city);
  url.searchParams.set("state", state);
  url.searchParams.set("zipcode", zip5);
  url.searchParams.set("candidates", "5");

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: { Accept: "application/json" },
  });

  const data = await res.json().catch(() => null);

  if (!res.ok) {
    const msg =
      data && typeof data === "object" && Array.isArray(data.errors)
        ? String(data.errors[0]?.message || "")
        : `HTTP ${res.status}`;
    const err = new Error(`Address verification service error: ${msg}`);
    err.statusCode = res.status === 401 || res.status === 403 ? 503 : 502;
    throw err;
  }

  if (!Array.isArray(data) || data.length === 0) {
    return { ok: false, reason: "no_match", raw: data };
  }

  const first = data[0];
  const dpv = first?.analysis?.dpv_match_code;
  if (dpv === "N") {
    return { ok: false, reason: "not_deliverable", raw: first };
  }

  return { ok: true, raw: first };
}
