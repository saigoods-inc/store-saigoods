import crypto from "node:crypto";
import { getBoxesPerCase, splitPriceAcrossUnits } from "./bundles.js";
import { getProductMap, getSupportedSizesForProduct } from "./store.js";

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

function sumSizeQuantities(quantities, sizes) {
  return sizes.reduce((sum, size) => {
    const n = Math.floor(Number(quantities?.[size]) || 0);
    return sum + (n > 0 ? n : 0);
  }, 0);
}

function distributeIntegerByWeights(totalCents, weights) {
  const total = Math.round(Number(totalCents) || 0);
  const w = weights.map((x) => Math.max(0, Number(x) || 0));
  const sumW = w.reduce((a, b) => a + b, 0);
  if (sumW <= 0) {
    return w.map(() => 0);
  }

  const raw = w.map((wi) => (total * wi) / sumW);
  const floors = raw.map((r) => Math.floor(r));
  let rem = total - floors.reduce((a, b) => a + b, 0);
  const order = raw
    .map((r, i) => ({ i, frac: r - floors[i] }))
    .sort((a, b) => b.frac - a.frac);

  for (let k = 0; k < rem; k++) {
    floors[order[k % order.length].i] += 1;
  }

  return floors;
}

/**
 * Square order lines: catalog SKUs when list-priced cases only; otherwise ad hoc lines with
 * bundle-allocated unit prices (cases vs boxes per size).
 */
function buildOrderPayloadFromQuote(quote, locationId, opts = {}) {
  const productMap = getProductMap();
  const lineItems = [];

  for (const row of quote.items || []) {
    const product = productMap.get(row.slug);
    if (!product) {
      continue;
    }
    const sizes = getSupportedSizesForProduct(product);
    const nameBase = row.name || product?.name || row.slug;
    const sumCase = sumSizeQuantities(row.quantities, sizes);
    const sumBox = sumSizeQuantities(row.boxQuantities, sizes);
    const bundleLines = row.bundleLines || [];
    const listTotal = sumCase * Math.max(0, Number(product?.priceCents) || 0);
    const useCatalog =
      (!bundleLines || bundleLines.length === 0) &&
      sumBox === 0 &&
      Number(row.lineTotalCents) === listTotal;

    if (useCatalog) {
      for (const size of sizes) {
        const qty = Math.floor(Number(row.quantities?.[size]) || 0);
        if (qty < 1) {
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

      continue;
    }

    const boxesPerCase = getBoxesPerCase(product);
    const parts = [];

    for (const size of sizes) {
      const cq = Math.floor(Number(row.quantities?.[size]) || 0);
      const bq = Math.floor(Number(row.boxQuantities?.[size]) || 0);

      if (cq > 0) {
        parts.push({
          size,
          kind: "case",
          qty: cq,
          weight: cq * Math.max(0, Number(product?.priceCents) || 0),
        });
      }

      if (bq > 0) {
        const boxW = Math.max(
          1,
          Math.round(Math.max(0, Number(product?.priceCents) || 0) / boxesPerCase),
        );
        parts.push({ size, kind: "box", qty: bq, weight: bq * boxW });
      }
    }

    const target = Math.max(0, Number(row.lineTotalCents) || 0);
    const totalW = parts.reduce((s, p) => s + p.weight, 0);
    let allocations =
      totalW > 0
        ? distributeIntegerByWeights(
            target,
            parts.map((p) => p.weight),
          )
        : parts.map(() => (parts.length ? Math.floor(target / parts.length) : 0));

    for (let i = 0; i < parts.length; i++) {
      if (parts[i].qty > 0 && (allocations[i] || 0) < 1 && target > 0) {
        const donor = allocations.findIndex((x, j) => j !== i && x > 1);
        const donor2 = donor >= 0 ? donor : allocations.findIndex((x, j) => j !== i && x > 0);
        if (donor2 >= 0) {
          allocations = [...allocations];
          allocations[donor2] -= 1;
          allocations[i] = (allocations[i] || 0) + 1;
        }
      }
    }

    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      const alloc = Math.max(0, allocations[i] || 0);
      const splits = splitPriceAcrossUnits(alloc, p.qty);

      for (const seg of splits) {
        lineItems.push({
          uid: crypto.randomUUID(),
          name: `${nameBase} (${p.size}) — ${p.kind === "box" ? "box" : "case"}`,
          quantity: String(seg.qty),
          base_price_money: {
            amount: Math.max(0, seg.unitCents),
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

  const order = {
    location_id: locationId,
    line_items: lineItems,
  };
  const shippingAsLineItems = opts?.shippingAsLineItems === true;
  const shippingLabel = String(opts?.shippingLineItemLabel || "").trim() || "Shipping";
  const residentialLabel =
    String(opts?.residentialSurchargeLineItemLabel || "").trim() || "Residential delivery surcharge";
  if (shippingAsLineItems) {
    const shippingCents = Math.max(0, Math.round(Number(quote?.shippingCents) || 0));
    const residentialCents = Math.max(0, Math.round(Number(quote?.shipping?.residentialSurchargeCents) || 0));
    const baseShippingCents = Math.max(0, shippingCents - residentialCents);
    if (baseShippingCents > 0) {
      order.line_items.push({
        uid: crypto.randomUUID(),
        name: shippingLabel,
        quantity: "1",
        base_price_money: {
          amount: baseShippingCents,
          currency: "USD",
        },
      });
    }
    if (residentialCents > 0) {
      order.line_items.push({
        uid: crypto.randomUUID(),
        name: residentialLabel,
        quantity: "1",
        base_price_money: {
          amount: residentialCents,
          currency: "USD",
        },
      });
    }
  }
  const taxCents = Math.max(0, Math.round(Number(quote?.taxCents) || 0));
  if (taxCents > 0) {
    const taxName = String(process.env.SQUARE_CHECKOUT_TAX_NAME || "").trim() || "Sales tax";
    order.line_items.push({
      uid: crypto.randomUUID(),
      name: taxName,
      quantity: "1",
      base_price_money: {
        amount: taxCents,
        currency: "USD",
      },
    });
  }

  return order;
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

/**
 * @param {{ quote: object, customer: object, orderId: string, checkoutOptions?: {
 *   askForShippingAddress?: boolean
 * } }} params
 */
export async function createPaymentLink({ quote, customer, orderId, checkoutOptions: linkOpts = {} }) {
  const accessToken = process.env.SQUARE_ACCESS_TOKEN?.trim();
  const locationId = process.env.SQUARE_LOCATION_ID?.trim();
  const baseUrl = process.env.PUBLIC_BASE_URL?.trim();

  if (!accessToken || !locationId || !baseUrl) {
    const error = new Error("Square is not configured.");
    error.statusCode = 503;
    throw error;
  }

  const idempotencyKey = crypto.randomUUID();
  const squareApiBase = getSquareApiBase();

  const c = customer && typeof customer === "object" ? customer : {};
  const phoneE164 = c.phone ? normalizePhoneE164(c.phone) : null;
  const prePopulated = {
    ...(c.email ? { buyer_email: String(c.email).trim() } : {}),
    ...(phoneE164 ? { buyer_phone_number: phoneE164 } : {}),
  };
  const hasPrePopulated = Object.keys(prePopulated).length > 0;

  const redirectUrl = `${baseUrl.replace(/\/$/, "")}/cart.html?checkout=success&order_id=${encodeURIComponent(
    orderId,
  )}`;

  const qShip = Math.max(0, Math.round(Number(quote?.shippingCents) || 0));
  const shippingCents = qShip > 0 ? qShip : null;
  const shippingAsLineItems = linkOpts.shippingAsLineItems === true;

  const shippingLabel =
    String(process.env.SQUARE_CHECKOUT_SHIPPING_LABEL || "").trim() || "Shipping";

  const askForShippingAddress = linkOpts.askForShippingAddress !== false;

  /** Line items + shipping are sourced from shared quote engine values. */
  const checkoutOptions = {
    redirect_url: redirectUrl,
    merchant_support_email: process.env.VENDOR_NOTIFICATION_EMAIL || undefined,
    ask_for_shipping_address: askForShippingAddress,
    ...(!shippingAsLineItems && shippingCents != null
      ? {
          shipping_fee: {
            name: shippingLabel,
            charge: { amount: shippingCents, currency: "USD" },
          },
        }
      : {}),
  };

  const order = buildOrderPayloadFromQuote(quote, locationId, {
    shippingAsLineItems,
    shippingLineItemLabel: linkOpts.shippingLineItemLabel,
    residentialSurchargeLineItemLabel: linkOpts.residentialSurchargeLineItemLabel,
  });

  const body = {
    idempotency_key: idempotencyKey,
    payment_note: `Order ${orderId} from SAI Goods`,
    order,
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
    const first = data.errors?.[0];
    let message = first?.detail || "Square checkout could not be created.";
    const code = first?.code;
    const unauthorized =
      response.status === 401 ||
      code === "UNAUTHORIZED" ||
      /could not be authorized/i.test(String(message));
    if (unauthorized) {
      message =
        "Square rejected your API credentials (unauthorized). Use a Production access token and Location ID from " +
        "Square Developer → Production, with SQUARE_ENVIRONMENT=production on Vercel. " +
        "If you use Sandbox credentials, set SQUARE_ENVIRONMENT=sandbox. Token and location must be from the same " +
        "Square app and environment—no extra spaces or quotes in env values.";
    } else if (code && !String(message).includes(code)) {
      message = `${message} (${code})`;
    }
    const error = new Error(message);
    error.statusCode = response.status || 500;
    throw error;
  }

  return {
    checkoutUrl: data.payment_link.url,
    paymentLinkId: data.payment_link.id || null,
    idempotencyKey,
  };
}

export async function deletePaymentLink(paymentLinkId) {
  const accessToken = process.env.SQUARE_ACCESS_TOKEN?.trim();
  const id = String(paymentLinkId || "").trim();
  if (!accessToken || !id) return { ok: false, skipped: true };
  const response = await fetch(`${getSquareApiBase()}/v2/online-checkout/payment-links/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "Square-Version": "2026-01-22",
    },
  });
  if (response.status === 404) return { ok: true, alreadyDeleted: true };
  if (!response.ok) {
    const error = new Error("Square payment link could not be expired.");
    error.statusCode = response.status || 502;
    throw error;
  }
  return { ok: true };
}

/**
 * Charge a card token from the Web Payments SDK (`token` from `card.tokenize()`).
 * @see https://developer.squareup.com/reference/square/payments-api/create-payment
 */
export async function createCardPayment({
  sourceId,
  amountCents,
  locationId,
  orderId,
  buyerEmail,
  idempotencyKey,
}) {
  const accessToken = process.env.SQUARE_ACCESS_TOKEN?.trim();
  const loc = String(locationId || process.env.SQUARE_LOCATION_ID || "").trim();

  if (!accessToken || !loc) {
    const error = new Error("Square is not configured.");
    error.statusCode = 503;
    throw error;
  }

  const token = String(sourceId || "").trim();
  if (!token) {
    const error = new Error("Missing card token.");
    error.statusCode = 400;
    throw error;
  }

  const amount = Math.round(Number(amountCents) || 0);
  if (amount < 1) {
    const error = new Error("Invalid payment amount.");
    error.statusCode = 400;
    throw error;
  }

  const squareApiBase = getSquareApiBase();
  const idem = String(idempotencyKey || "").trim() || crypto.randomUUID();
  const note = `Order ${orderId} from SAI Goods`;

  const body = {
    idempotency_key: idem,
    amount_money: { amount, currency: "USD" },
    source_id: token,
    location_id: loc,
    autocomplete: true,
    note,
  };

  const em = String(buyerEmail || "").trim();
  if (em) {
    body.buyer_email_address = em;
  }

  let response;
  let data;
  try {
    response = await fetch(`${squareApiBase}/v2/payments`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "Square-Version": "2026-01-22",
      },
      body: JSON.stringify(body),
    });
    data = await response.json();
  } catch {
    const error = new Error("Payment confirmation is taking longer than expected. Do not submit again.");
    error.statusCode = 202;
    error.paymentOutcomeUncertain = true;
    throw error;
  }

  if (!response.ok || !data.payment?.id) {
    const first = data.errors?.[0];
    let message = first?.detail || first?.code || "Card payment could not be completed.";
    const error = new Error(message);
    error.statusCode = response.status || 400;
    throw error;
  }

  const st = data.payment.status;
  if (st === "FAILED" || st === "CANCELED") {
    const error = new Error("Payment was not successful. Try another card.");
    error.statusCode = 402;
    throw error;
  }

  return {
    paymentId: data.payment.id,
    payment: data.payment,
  };
}

/** Pull buyer email / phone / name from a completed Payment when checkout started with no cart form. */
export function extractBuyerContactFromPayment(payment) {
  if (!payment || typeof payment !== "object") {
    return { email: null, phone: null, name: null };
  }

  const email = String(payment.buyer_email_address || "").trim() || null;

  let phone =
    String(payment.buyer_phone_number || payment.phone_number || "").trim() || null;

  let name = null;
  const ship = payment.shipping_address;
  if (ship && typeof ship === "object") {
    const fn = String(ship.first_name || "").trim();
    const ln = String(ship.last_name || "").trim();
    const combined = [fn, ln].filter(Boolean).join(" ").trim();
    if (combined) {
      name = combined;
    }
  }

  return { email, phone, name };
}

/** Format Square Payment.shipping_address for storing on our order row. */
export function formatPaymentShippingAddress(payment) {
  const a = payment?.shipping_address;
  if (!a || typeof a !== "object") {
    return null;
  }

  const line1 = String(a.address_line_1 || "").trim();
  const line2 = String(a.address_line_2 || "").trim();
  const city = String(a.locality || "").trim();
  const region = String(a.administrative_district_level_1 || "").trim();
  const zip = String(a.postal_code || "").trim();
  const country = String(a.country || "").trim();

  const cityLine = [city, region, zip].filter(Boolean).join(", ");
  const parts = [line1, line2, cityLine, country].filter(Boolean);
  const text = parts.join("\n").trim();
  return text || null;
}

/**
 * @param {{ body: string, signature: string|undefined, notificationUrl: string, signatureKey?: string }} opts
 * If `signatureKey` is omitted, uses `SQUARE_WEBHOOK_SIGNATURE_KEY` (production).
 */
export function verifySquareSignature({ body, signature, notificationUrl, signatureKey }) {
  const key =
    typeof signatureKey === "string" && signatureKey.trim()
      ? signatureKey.trim()
      : process.env.SQUARE_WEBHOOK_SIGNATURE_KEY?.trim();

  if (!key || !signature || !body) {
    return false;
  }

  const hmacPayload = notificationUrl + body;
  const hmac = crypto.createHmac("sha256", key);
  hmac.update(hmacPayload);
  const hash = hmac.digest("base64");

  const a = Buffer.from(hash, "utf8");
  const b = Buffer.from(signature, "utf8");

  if (a.length !== b.length) {
    return false;
  }

  return crypto.timingSafeEqual(a, b);
}
