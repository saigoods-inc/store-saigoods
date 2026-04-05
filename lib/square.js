import crypto from "node:crypto";

function getSquareApiBase() {
  const env = (process.env.SQUARE_ENVIRONMENT || "production").toLowerCase();
  return env === "sandbox" ? "https://connect.squareupsandbox.com" : "https://connect.squareup.com";
}

function isSquareSandbox() {
  return (process.env.SQUARE_ENVIRONMENT || "production").toLowerCase() === "sandbox";
}

/**
 * Square expects E.164 (e.g. +16153973698). Raw 10-digit US numbers are rejected (INVALID_PHONE_NUMBER).
 * Returns null if we cannot normalize — caller should omit buyer_phone_number so checkout still works.
 */
export function normalizePhoneE164(phone) {
  if (phone == null) {
    return null;
  }

  const raw = String(phone).trim();
  if (!raw) {
    return null;
  }

  const defaultCc = String(process.env.DEFAULT_PHONE_COUNTRY_CODE || "1").replace(/\D/g, "") || "1";

  if (raw.startsWith("+")) {
    const digits = raw.slice(1).replace(/\D/g, "");
    if (digits.length >= 10 && digits.length <= 15) {
      return `+${digits}`;
    }
    return null;
  }

  const digitsOnly = raw.replace(/\D/g, "");
  if (digitsOnly.length === 10) {
    return `+${defaultCc}${digitsOnly}`;
  }
  if (digitsOnly.length === 11 && digitsOnly.startsWith("1")) {
    return `+${digitsOnly}`;
  }
  if (digitsOnly.length >= 10 && digitsOnly.length <= 15) {
    return `+${digitsOnly}`;
  }

  return null;
}

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
  const squareApiBase = getSquareApiBase();

  const phoneE164 = customer?.phone ? normalizePhoneE164(customer.phone) : null;
  const prePopulated =
    customer?.email || phoneE164
      ? {
          ...(customer.email ? { buyer_email: String(customer.email).trim() } : {}),
          ...(phoneE164 ? { buyer_phone_number: phoneE164 } : {}),
        }
      : undefined;

  const redirectUrl = `${baseUrl.replace(/\/$/, "")}/cart.html?checkout=success&order_id=${encodeURIComponent(
    orderId,
  )}`;

  const subtotalCents = Math.max(0, Number(quote.subtotalCents) || 0);
  const shippingCents = Math.max(0, Number(quote.shippingCents) || 0);

  /**
   * Square: when `ask_for_shipping_address` is true, you should set `shipping_fee` or buyers see
   * "enter a valid address for shipping methods" with no rates. We already computed UPS shipping
   * on our server — pass it explicitly. Quick Pay amount = merchandise only; Square adds shipping.
   */
  const checkoutOptions = {
    redirect_url: redirectUrl,
    merchant_support_email: process.env.VENDOR_NOTIFICATION_EMAIL || undefined,
  };

  if (shippingCents > 0) {
    checkoutOptions.ask_for_shipping_address = true;
    checkoutOptions.shipping_fee = {
      name: "UPS Ground (estimated)",
      charge: {
        amount: shippingCents,
        currency: "USD",
      },
    };
  } else {
    checkoutOptions.ask_for_shipping_address = false;
  }

  const body = {
    idempotency_key: idempotencyKey,
    payment_note: `Order ${orderId} from SAI Goods`,
    quick_pay: {
      name: "SAI Goods order",
      price_money: {
        amount: subtotalCents,
        currency: "USD",
      },
      location_id: locationId,
    },
    checkout_options: checkoutOptions,
    ...(Object.keys(prePopulated || {}).length ? { pre_populated_data: prePopulated } : {}),
  };

  if (isSquareSandbox()) {
    console.warn(
      "[Square] Using SANDBOX: checkout shows “Preview link” and cards are test-only. " +
        "For live payments set SQUARE_ENVIRONMENT=production and use Production access token + Location ID in Vercel.",
    );
  }

  const response = await fetch(`${squareApiBase}/v2/online-checkout/payment-links`, {
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

