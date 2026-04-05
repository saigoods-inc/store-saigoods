import crypto from "node:crypto";
import { getProductMap } from "./store.js";
import { normalizeUsZip } from "./shipping.js";

/**
 * Map cart fields to Square PrePopulatedData.buyer_address (US).
 * Pre-fills Square’s shipping form when `ask_for_shipping_address` is true.
 */
function buildBuyerAddress(customer) {
  if (!customer || typeof customer !== "object") {
    return null;
  }

  const zip = normalizeUsZip(customer.zipCode || customer.zip);
  const name = String(customer.name || "").trim();
  const parts = name.split(/\s+/).filter(Boolean);
  const firstName = parts[0];
  const lastName = parts.length > 1 ? parts.slice(1).join(" ") : undefined;

  const addrText = String(customer.address || "").trim();
  const lines = addrText.split(/\n/).map((l) => l.trim()).filter(Boolean);
  const line1 = lines[0];
  const line2 = lines.length > 1 ? lines.slice(1).join(", ") : undefined;

  if (!zip && !line1) {
    return null;
  }

  const buyerAddress = {
    country: "US",
    ...(firstName ? { first_name: firstName } : {}),
    ...(lastName ? { last_name: lastName } : {}),
    ...(line1 ? { address_line_1: line1 } : {}),
    ...(line2 ? { address_line_2: line2 } : {}),
    ...(zip ? { postal_code: zip } : {}),
  };

  return buyerAddress;
}

/**
 * Square CatalogItemVariation ID for a size, if you map items in Square Catalog with shipping weights.
 * When set, checkout uses `catalog_object_id` so Square’s shipping rules can use catalog shipping data.
 * When unset, we send ad hoc line items (name + unit price) — itemized on the receipt, but not tied to catalog weight.
 */
function resolveSquareCatalogVariationId(product, size) {
  if (!product || size == null) {
    return null;
  }

  const raw =
    product.squareVariationIds?.[size] ??
    product.squareCatalogVariationIds?.[size] ??
    product.square?.variationIds?.[size];

  if (raw == null) {
    return null;
  }

  const s = String(raw).trim();
  return s.length ? s : null;
}

/** One Square order line per product × size with quantity &gt; 0 (not Quick Pay). */
function buildOrderPayloadFromQuote(quote, locationId) {
  const productMap = getProductMap();
  const lineItems = [];

  for (const row of quote.items || []) {
    const product = productMap.get(row.slug);
    const nameBase = row.name || product?.name || row.slug;

    for (const [size, rawQty] of Object.entries(row.quantities || {})) {
      const qty = Math.floor(Number(rawQty));
      if (!Number.isFinite(qty) || qty < 1) {
        continue;
      }

      const uid = crypto.randomUUID();
      const catalogId = resolveSquareCatalogVariationId(product, size);

      if (catalogId) {
        lineItems.push({
          uid,
          catalog_object_id: catalogId,
          quantity: String(qty),
        });
      } else {
        lineItems.push({
          uid,
          name: `${nameBase} (${size})`,
          quantity: String(qty),
          base_price_money: {
            amount: Math.max(0, Number(row.priceCents) || 0),
            currency: "USD",
          },
        });
      }
    }
  }

  if (!lineItems.length) {
    const error = new Error("Cart has no line items for Square.");
    error.statusCode = 400;
    throw error;
  }

  return {
    location_id: locationId,
    line_items: lineItems,
  };
}

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
  const buyerAddress = buildBuyerAddress(customer);
  const prePopulated = {
    ...(customer?.email ? { buyer_email: String(customer.email).trim() } : {}),
    ...(phoneE164 ? { buyer_phone_number: phoneE164 } : {}),
    ...(buyerAddress ? { buyer_address: buyerAddress } : {}),
  };
  const hasPrePopulated = Object.keys(prePopulated).length > 0;

  const redirectUrl = `${baseUrl.replace(/\/$/, "")}/cart.html?checkout=success&order_id=${encodeURIComponent(
    orderId,
  )}`;

  /**
   * Order checkout (not Quick Pay) so Square sees each product line. Dashboard shipping rules that depend on
   * catalog weight only apply to lines that use `squareVariationIds` → `catalog_object_id`.
   * Ad hoc lines are still itemized with correct unit prices from your quote.
   */
  const checkoutOptions = {
    redirect_url: redirectUrl,
    merchant_support_email: process.env.VENDOR_NOTIFICATION_EMAIL || undefined,
    ask_for_shipping_address: true,
  };

  const body = {
    idempotency_key: idempotencyKey,
    payment_note: `Order ${orderId} from SAI Goods`,
    order: buildOrderPayloadFromQuote(quote, locationId),
    checkout_options: checkoutOptions,
    ...(hasPrePopulated ? { pre_populated_data: prePopulated } : {}),
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

