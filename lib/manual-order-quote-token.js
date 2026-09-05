import crypto from "node:crypto";
import { computeCheckoutSalesTaxSync } from "./sales-tax.js";

const TOKEN_VERSION = 1;
const DEFAULT_TTL_MS = 30 * 60 * 1000;

function signingSecret() {
  return String(
    process.env.MANUAL_ORDER_QUOTE_SIGNING_SECRET ||
      process.env.CHECKOUT_QUOTE_SIGNING_SECRET ||
      process.env.SQUARE_ACCESS_TOKEN ||
      process.env.SUPABASE_SERVICE_ROLE_KEY ||
      "",
  ).trim();
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => [key, canonicalize(value[key])]),
  );
}

function unsignedRequest(body) {
  const source = body && typeof body === "object" ? body : {};
  const ignored = new Set([
    "quoteToken",
    "selectedShippingRateObjectId",
    "selectedShippingServiceCode",
    "selectedShippingServiceLabel",
    "selectedShippingProvider",
    "selectedShippingAmountCents",
    "selectedShippingParcelCount",
    "selectedShippingResidentialSurchargeCents",
    "paymentFlow",
    "manualPaymentMethod",
    "shipmentDate",
    "orderId",
    "allowPayLaterLink",
    // Admins may decide who pays for an already-signed carrier rate. The
    // selected service and carrier identifiers remain protected by the token.
    "adminFreeShipping",
  ]);
  return canonicalize(
    Object.fromEntries(Object.entries(source).filter(([key]) => !ignored.has(key))),
  );
}

function requestFingerprint(body) {
  return crypto.createHash("sha256").update(JSON.stringify(unsignedRequest(body))).digest("base64url");
}

function signature(encoded, secret) {
  return crypto.createHmac("sha256", secret).update(encoded).digest("base64url");
}

function quoteError(message, code) {
  const error = new Error(message);
  error.statusCode = 409;
  error.code = code;
  return error;
}

export function issueManualOrderQuoteToken({ quote, request, now = Date.now() }) {
  const secret = signingSecret();
  if (!secret || !quote || quote.canCheckout !== true) return null;
  const payload = {
    v: TOKEN_VERSION,
    iat: now,
    exp: now + DEFAULT_TTL_MS,
    requestFingerprint: requestFingerprint(request),
    quote,
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encoded}.${signature(encoded, secret)}`;
}

export function verifyManualOrderQuoteToken(token, request, now = Date.now()) {
  const secret = signingSecret();
  if (!secret) {
    throw quoteError("Manual quote verification is not configured.", "MANUAL_QUOTE_SECRET_MISSING");
  }
  const [encoded, suppliedSignature, extra] = String(token || "").split(".");
  if (!encoded || !suppliedSignature || extra) {
    throw quoteError("Shipping quote is invalid. Get carrier rates again.", "MANUAL_QUOTE_INVALID");
  }
  const expected = signature(encoded, secret);
  const suppliedBytes = Buffer.from(suppliedSignature);
  const expectedBytes = Buffer.from(expected);
  if (suppliedBytes.length !== expectedBytes.length || !crypto.timingSafeEqual(suppliedBytes, expectedBytes)) {
    throw quoteError("Shipping quote is invalid. Get carrier rates again.", "MANUAL_QUOTE_INVALID");
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw quoteError("Shipping quote is invalid. Get carrier rates again.", "MANUAL_QUOTE_INVALID");
  }
  if (payload?.v !== TOKEN_VERSION || !payload?.quote || payload.quote.canCheckout !== true) {
    throw quoteError("Shipping quote is invalid. Get carrier rates again.", "MANUAL_QUOTE_INVALID");
  }
  if (!Number.isFinite(Number(payload.exp)) || now > Number(payload.exp)) {
    throw quoteError("Shipping quote expired. Get carrier rates again.", "MANUAL_QUOTE_EXPIRED");
  }
  if (payload.requestFingerprint !== requestFingerprint(request)) {
    throw quoteError("Order items, discount, or address changed. Get carrier rates again.", "MANUAL_QUOTE_CHANGED");
  }
  return payload;
}

function sameText(left, right) {
  return String(left || "").trim().toLowerCase() === String(right || "").trim().toLowerCase();
}

function parseAdminFreeShipping(input) {
  if (!input || typeof input !== "object" || input.requested !== true) return null;
  const reason = String(input.reason || "").trim().replace(/\s+/g, " ");
  if (reason.length < 3) {
    throw quoteError("Enter an internal reason before applying free shipping.", "ADMIN_FREE_SHIPPING_REASON_REQUIRED");
  }
  if (reason.length > 240) {
    throw quoteError("Keep the free-shipping reason to 240 characters or fewer.", "ADMIN_FREE_SHIPPING_REASON_TOO_LONG");
  }
  return { requested: true, reason };
}

function adminApprovalSnapshot(request, context = {}) {
  if (!request) return null;
  const actor = context?.actor && typeof context.actor === "object" ? context.actor : {};
  return {
    applied: true,
    reason: request.reason,
    approvedAt: context?.approvedAt || null,
    approvedBy: String(actor.email || actor.userEmail || "").trim() || null,
    approvedById: String(actor.id || actor.userId || "").trim() || null,
  };
}

export function selectManualOrderRateFromToken(payload, selected = {}, context = {}) {
  const quote = payload?.quote;
  const rates = Array.isArray(quote?.shippingRateOptions) ? quote.shippingRateOptions : [];
  const selectedId = String(selected.selectedShippingRateObjectId || "").trim();
  const selectedProvider = String(selected.selectedShippingProvider || "").trim();
  const selectedCode = String(selected.selectedShippingServiceCode || "").trim();
  const selectedLabel = String(selected.selectedShippingServiceLabel || "").trim();
  let rate = selectedId ? rates.find((candidate) => String(candidate?.id || "").trim() === selectedId) : null;
  if (!rate && selectedProvider && (selectedCode || selectedLabel)) {
    rate = rates.find(
      (candidate) =>
        sameText(candidate?.provider, selectedProvider) &&
        ((selectedCode && sameText(candidate?.serviceCode, selectedCode)) ||
          (selectedLabel && sameText(candidate?.serviceLabel, selectedLabel))),
    );
  }
  if (!rate) {
    throw quoteError("Select a valid carrier service from the current quote.", "MANUAL_RATE_INVALID");
  }

  const baseAmountCents = Math.max(0, Math.round(Number(rate.amountCents) || 0));
  const bufferCents = Math.max(0, Math.round(Number(rate.bufferCents) || 0));
  const residentialSurchargeCents = Math.max(0, Math.round(Number(rate.residentialSurchargeCents) || 0));
  const quotedShippingCents = Number.isFinite(Number(rate.totalAmountCents))
    ? Math.max(0, Math.round(Number(rate.totalAmountCents)))
    : baseAmountCents + bufferCents + residentialSurchargeCents;
  const adminRequest = parseAdminFreeShipping(selected.adminFreeShipping);
  const adminFreeShippingApplied = Boolean(adminRequest);
  const carrierTotalAmountCents = quotedShippingCents;
  const shippingCents = adminFreeShippingApplied ? 0 : quotedShippingCents;
  const subtotalCents = Math.max(0, Math.round(Number(quote.subtotalCents) || 0));
  const taxMeta = computeCheckoutSalesTaxSync(quote.destinationState, subtotalCents, shippingCents);
  const taxCents = taxMeta.taxCents;
  const totalCents = subtotalCents + shippingCents + taxCents;
  const money = (cents) => `$${(cents / 100).toFixed(2)}`;

  return {
    ...quote,
    shipping: {
      ...(quote.shipping || {}),
      quoteStatus: "rated",
      provider: rate.provider || null,
      serviceCode: rate.serviceCode || null,
      serviceLabel: rate.serviceLabel || null,
      providerQuoteId: String(rate.id || "").trim() || null,
      selectedPackageRateObjectIds: Array.isArray(rate.packageRateObjectIds)
        ? rate.packageRateObjectIds.map((value) => String(value || "").trim()).filter(Boolean)
        : [],
      selectedPackageShipmentObjectIds: Array.isArray(rate.packageShipmentObjectIds)
        ? rate.packageShipmentObjectIds.map((value) => String(value || "").trim()).filter(Boolean)
        : [],
      baseAmountCents,
      bufferCents,
      amountCents: baseAmountCents + bufferCents,
      amountFormatted: money(baseAmountCents + bufferCents),
      residentialSurchargeCents,
      residentialSurchargeFormatted: money(residentialSurchargeCents),
      taxableShippingCents: shippingCents,
      totalCents: shippingCents,
      ...(adminFreeShippingApplied
        ? {
            freeShippingApplied: true,
            freeShippingSource: "admin_override",
            carrierAmountCents: baseAmountCents,
            carrierTotalAmountCents,
            shippingDiscountCents: carrierTotalAmountCents,
          }
        : {}),
    },
    tax: { ...(quote.tax || {}), ...taxMeta, amountCents: taxCents, amountFormatted: money(taxCents) },
    totals: { ...(quote.totals || {}), subtotalCents, shippingCents, taxCents, totalCents, totalFormatted: money(totalCents) },
    shippingCents,
    shippingFormatted: money(shippingCents),
    taxCents,
    taxFormatted: money(taxCents),
    totalCents,
    totalFormatted: money(totalCents),
    freeShipping: adminFreeShippingApplied
      ? {
          active: true,
          configured: true,
          eligible: true,
          applied: true,
          source: "admin_override",
          message: "Admin free shipping applied. SAI Goods will pay the carrier cost.",
        }
      : quote?.freeShipping || null,
    adminFreeShipping: adminFreeShippingApplied
      ? {
          ...adminApprovalSnapshot(adminRequest, context),
          originalShippingCents: carrierTotalAmountCents,
          amountWaivedCents: carrierTotalAmountCents,
        }
      : null,
    canCheckout: true,
    userFacingError: null,
  };
}
