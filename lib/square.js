import crypto from "node:crypto";

const SQUARE_API_BASE = "https://connect.squareup.com";

export async function createPaymentLink({ quote, customer, orderId }) {
  const accessToken = process.env.SQUARE_ACCESS_TOKEN;
  const locationId = process.env.SQUARE_LOCATION_ID;
  const baseUrl = process.env.PUBLIC_BASE_URL;

  if (!accessToken || !locationId || !baseUrl) {
    const error = new Error("Square is not configured.");
    error.statusCode = 503;
    throw error;
  }

  const idempotencyKey = crypto.randomUUID();

  const body = {
    idempotency_key: idempotencyKey,
    payment_note: `Order ${orderId} from SAI Goods`,
    quick_pay: {
      name: "SAI Goods order",
      price_money: {
        amount: quote.totalCents,
        currency: "USD",
      },
      location_id: locationId,
      redirect_url: `${baseUrl.replace(/\/$/, "")}/cart.html?checkout=success&order_id=${encodeURIComponent(
        orderId,
      )}`,
    },
    checkout_options: {
      ask_for_shipping_address: true,
      merchant_support_email: process.env.VENDOR_NOTIFICATION_EMAIL || undefined,
    },
  };

  const response = await fetch(`${SQUARE_API_BASE}/v2/online-checkout/payment-links`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "Square-Version": "2026-01-22",
    },
    body: JSON.stringify(body),
  });

  const data = await response.json();

  if (!response.ok || !data.payment_link?.url) {
    const error = new Error(data.errors?.[0]?.detail || "Square checkout could not be created.");
    error.statusCode = response.status || 500;
    throw error;
  }

  return {
    checkoutUrl: data.payment_link.url,
    idempotencyKey,
  };
}

export function verifySquareSignature({ body, signature, notificationUrl }) {
  const signatureKey = process.env.SQUARE_WEBHOOK_SIGNATURE_KEY;

  if (!signatureKey || !signature || !body) {
    return false;
  }

  const hmacPayload = notificationUrl + body;
  const hmac = crypto.createHmac("sha256", signatureKey);
  hmac.update(hmacPayload);
  const hash = hmac.digest("base64");

  const a = Buffer.from(hash, "utf8");
  const b = Buffer.from(signature, "utf8");

  if (a.length !== b.length) {
    return false;
  }

  return crypto.timingSafeEqual(a, b);
}

