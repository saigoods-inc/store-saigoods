import crypto from "node:crypto";

export const MANUAL_PAYMENT_LINK_VALID_MS = 48 * 60 * 60 * 1000;

function secret() {
  return String(
    process.env.MANUAL_PAYMENT_LINK_SIGNING_SECRET ||
      process.env.CHECKOUT_QUOTE_SIGNING_SECRET ||
      process.env.SQUARE_ACCESS_TOKEN ||
      process.env.SUPABASE_SERVICE_ROLE_KEY ||
      "",
  ).trim();
}

function sign(encoded, signingSecret) {
  return crypto.createHmac("sha256", signingSecret).update(encoded).digest("base64url");
}

export function issueManualPaymentAccessToken({ orderId, expiresAt }) {
  const signingSecret = secret();
  const expiresMs = new Date(expiresAt).getTime();
  if (!signingSecret || !orderId || !Number.isFinite(expiresMs)) return null;
  const encoded = Buffer.from(JSON.stringify({ v: 1, orderId: String(orderId), exp: expiresMs })).toString("base64url");
  return `${encoded}.${sign(encoded, signingSecret)}`;
}

export function verifyManualPaymentAccessToken(token, now = Date.now()) {
  const signingSecret = secret();
  const [encoded, supplied, extra] = String(token || "").split(".");
  if (!signingSecret || !encoded || !supplied || extra) return { ok: false, reason: "invalid" };
  const expected = sign(encoded, signingSecret);
  const suppliedBytes = Buffer.from(supplied);
  const expectedBytes = Buffer.from(expected);
  if (suppliedBytes.length !== expectedBytes.length || !crypto.timingSafeEqual(suppliedBytes, expectedBytes)) {
    return { ok: false, reason: "invalid" };
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (payload?.v !== 1 || !payload.orderId || !Number.isFinite(Number(payload.exp))) {
    return { ok: false, reason: "invalid" };
  }
  if (now > Number(payload.exp)) return { ok: false, reason: "expired", payload };
  return { ok: true, payload };
}

export function manualPaymentAccessUrl({ orderId, expiresAt }) {
  const baseUrl = String(process.env.PUBLIC_BASE_URL || "").trim().replace(/\/$/, "");
  const token = issueManualPaymentAccessToken({ orderId, expiresAt });
  if (!baseUrl || !token) return null;
  return `${baseUrl}/api/manual-order-payment?token=${encodeURIComponent(token)}`;
}
