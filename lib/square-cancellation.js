import crypto from "node:crypto";

const SQUARE_VERSION = "2026-01-22";

function apiBase() {
  return String(process.env.SQUARE_ENVIRONMENT || "production").toLowerCase() === "sandbox"
    ? "https://connect.squareupsandbox.com"
    : "https://connect.squareup.com";
}
function squareError(json, fallback) {
  return String(json?.errors?.[0]?.detail || json?.errors?.[0]?.code || fallback);
}

async function squareRequest(path, init = {}) {
  const token = process.env.SQUARE_ACCESS_TOKEN?.trim();
  if (!token) {
    const error = new Error("Square is not configured.");
    error.statusCode = 503;
    throw error;
  }
  const response = await fetch(`${apiBase()}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Square-Version": SQUARE_VERSION,
      ...(init.headers || {}),
    },
    signal: init.signal || AbortSignal.timeout(20_000),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(squareError(json, `Square request failed (HTTP ${response.status}).`));
    error.statusCode = response.status;
    error.squareResponse = json;
    throw error;
  }
  return json;
}

export async function getSquarePayment(paymentId) {
  const id = String(paymentId || "").trim();
  if (!id) throw Object.assign(new Error("Square payment ID is missing."), { statusCode: 400 });
  const json = await squareRequest(`/v2/payments/${encodeURIComponent(id)}`);
  return json.payment || null;
}

/** Cancel an authorized payment, or refund a completed one. Safe to retry. */
export async function cancelOrRefundSquarePayment({ paymentId, amountCents, orderId, reason }) {
  const payment = await getSquarePayment(paymentId);
  const status = String(payment?.status || "").toUpperCase();
  const amount = Math.max(0, Math.round(Number(amountCents) || 0));
  if (!payment || !status) throw new Error("Square payment could not be found.");

  if (status === "APPROVED") {
    const json = await squareRequest(`/v2/payments/${encodeURIComponent(paymentId)}/cancel`, { method: "POST" });
    return { action: "void", status: String(json.payment?.status || "CANCELED").toUpperCase(), payment: json.payment };
  }

  const refunded = Math.max(0, Number(payment.refunded_money?.amount) || 0);
  if (status === "CANCELED") return { action: "void", status, alreadyComplete: true, payment };
  if (status !== "COMPLETED") {
    const error = new Error(`Square payment cannot be cancelled while its status is ${status || "unknown"}.`);
    error.statusCode = 409;
    throw error;
  }
  if (amount < 1) throw Object.assign(new Error("Refund amount is invalid."), { statusCode: 400 });
  if (refunded >= amount) return { action: "refund", status: "COMPLETED", alreadyComplete: true, payment };

  const idempotencyKey = crypto.createHash("sha256").update(`cancel-order:${orderId}:${paymentId}`).digest("hex").slice(0, 45);
  const json = await squareRequest("/v2/refunds", {
    method: "POST",
    body: JSON.stringify({
      idempotency_key: idempotencyKey,
      payment_id: String(paymentId),
      amount_money: { amount, currency: String(payment.amount_money?.currency || "USD") },
      reason: String(reason || "Customer requested order cancellation").slice(0, 190),
    }),
  });
  const refund = json.refund || {};
  const refundStatus = String(refund.status || "").toUpperCase();
  if (["FAILED", "REJECTED"].includes(refundStatus)) {
    const error = new Error(`Square rejected the refund (${refundStatus}).`);
    error.statusCode = 409;
    throw error;
  }
  return { action: "refund", status: refundStatus || "PENDING", refundId: refund.id || null, refund };
}
