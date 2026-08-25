import crypto from "node:crypto";

const TOKEN_VERSION = 1;
const DEFAULT_TTL_MS = 5 * 60 * 1000;

function quoteSigningSecret() {
  return String(
    process.env.CHECKOUT_QUOTE_SIGNING_SECRET || process.env.SQUARE_ACCESS_TOKEN || "",
  ).trim();
}

function tokenTtlMs() {
  const minutes = Math.round(Number(process.env.CHECKOUT_QUOTE_TTL_MINUTES || ""));
  if (Number.isFinite(minutes) && minutes >= 5 && minutes <= 120) {
    return minutes * 60 * 1000;
  }
  return DEFAULT_TTL_MS;
}

export function checkoutQuoteTtlMs() {
  return tokenTtlMs();
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

function normalizedAddress(address) {
  const a = address && typeof address === "object" ? address : {};
  const clean = (value) => String(value || "").trim().replace(/\s+/g, " ");
  return {
    line1: clean(a.line1),
    line2: clean(a.line2),
    city: clean(a.city),
    state: clean(a.state).toUpperCase(),
    postalCode: clean(a.postalCode).replace(/\s/g, ""),
    country: clean(a.country || "US").toUpperCase() || "US",
  };
}

function requestFingerprint({ items, address, discountCode }) {
  const request = canonicalize({
    items: Array.isArray(items) ? items : [],
    address: normalizedAddress(address),
    discountCode: String(discountCode || "").trim().toUpperCase(),
  });
  return crypto.createHash("sha256").update(JSON.stringify(request)).digest("base64url");
}

function sign(encodedPayload, secret) {
  return crypto.createHmac("sha256", secret).update(encodedPayload).digest("base64url");
}

function tokenError(message, code) {
  const error = new Error(message);
  error.statusCode = 409;
  error.code = code;
  return error;
}

export function issueCheckoutQuoteToken({ quote, items, address, discountCode, now = Date.now() }) {
  const secret = quoteSigningSecret();
  if (!secret || quote?.canCheckout !== true) return null;

  const payload = {
    v: TOKEN_VERSION,
    iat: now,
    exp: now + tokenTtlMs(),
    requestFingerprint: requestFingerprint({ items, address, discountCode }),
    submittedAddress: normalizedAddress(address),
    quoteCorrelationId: String(quote?.quoteCorrelationId || crypto.randomUUID()),
    quote,
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encoded}.${sign(encoded, secret)}`;
}

export function verifyCheckoutQuoteToken(
  token,
  { items, address, discountCode, now = Date.now() },
) {
  const secret = quoteSigningSecret();
  if (!secret) {
    throw tokenError("Checkout quote verification is not configured.", "CHECKOUT_QUOTE_SECRET_MISSING");
  }
  const [encoded, signature, extra] = String(token || "").split(".");
  if (!encoded || !signature || extra) {
    throw tokenError("Shipping quote is invalid. Confirm your address again.", "CHECKOUT_QUOTE_INVALID");
  }
  const expected = sign(encoded, secret);
  const receivedBytes = Buffer.from(signature);
  const expectedBytes = Buffer.from(expected);
  if (
    receivedBytes.length !== expectedBytes.length ||
    !crypto.timingSafeEqual(receivedBytes, expectedBytes)
  ) {
    throw tokenError("Shipping quote is invalid. Confirm your address again.", "CHECKOUT_QUOTE_INVALID");
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw tokenError("Shipping quote is invalid. Confirm your address again.", "CHECKOUT_QUOTE_INVALID");
  }
  if (payload?.v !== TOKEN_VERSION || !payload?.quote || payload.quote.canCheckout !== true) {
    throw tokenError("Shipping quote is invalid. Confirm your address again.", "CHECKOUT_QUOTE_INVALID");
  }
  if (!Number.isFinite(Number(payload.exp)) || now > Number(payload.exp)) {
    throw tokenError("Shipping quote expired. Confirm your address again.", "CHECKOUT_QUOTE_EXPIRED");
  }
  const currentFingerprint = requestFingerprint({ items, address, discountCode });
  if (payload.requestFingerprint !== currentFingerprint) {
    throw tokenError("Cart or address changed. Confirm your address again.", "CHECKOUT_QUOTE_CHANGED");
  }
  return payload;
}

function rateId(rate) {
  return String(rate?.id || rate?.object_id || rate?.providerQuoteId || "").trim();
}

function sameText(a, b) {
  return String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();
}

export function selectSignedCheckoutQuote(payload, selected = {}) {
  const source = payload?.quote;
  const rates = Array.isArray(source?.shippingRateOptions) ? source.shippingRateOptions : [];
  const selectedId = String(selected.selectedShippingRateObjectId || "").trim();
  const selectedCode = String(selected.selectedShippingServiceCode || "").trim();
  const selectedLabel = String(selected.selectedShippingServiceLabel || "").trim();
  const selectedProvider = String(selected.selectedShippingProvider || "").trim();
  const automaticLocalRate = rates.find(
    (candidate) => candidate?.automatic === true && sameText(candidate?.provider, "local"),
  );
  if (!selectedId && !(selectedProvider && (selectedCode || selectedLabel)) && !automaticLocalRate) {
    throw tokenError("Select a shipping service before paying.", "CHECKOUT_RATE_SELECTION_REQUIRED");
  }
  let rate = selectedId ? rates.find((candidate) => rateId(candidate) === selectedId) : automaticLocalRate || null;
  if (!rate && selectedProvider && (selectedCode || selectedLabel)) {
    rate = rates.find(
      (candidate) =>
        sameText(candidate?.provider, selectedProvider) &&
        ((selectedCode && sameText(candidate?.serviceCode, selectedCode)) ||
          (selectedLabel && sameText(candidate?.serviceLabel, selectedLabel))),
    );
  }
  if (!rate) {
    throw tokenError("Shipping price is no longer valid. Confirm your address again.", "CHECKOUT_RATE_INVALID");
  }

  const parcelCount = Math.max(0, Math.floor(Number(source?.parcelSummary?.parcelCount) || 0));
  if (
    selected.selectedShippingParcelCount != null &&
    Math.max(0, Math.floor(Number(selected.selectedShippingParcelCount) || 0)) !== parcelCount
  ) {
    throw tokenError("Shipping package details changed. Confirm your address again.", "CHECKOUT_PARCELS_CHANGED");
  }
  const signedRateAmount = Math.max(0, Math.round(Number(rate?.amountCents) || 0));
  if (
    selected.selectedShippingAmountCents != null &&
    Math.max(0, Math.round(Number(selected.selectedShippingAmountCents) || 0)) !== signedRateAmount
  ) {
    throw tokenError("Shipping price changed. Confirm your address again.", "CHECKOUT_RATE_CHANGED");
  }

  const shippingTotalCents = Number.isFinite(Number(rate.totalAmountCents))
    ? Math.max(0, Math.round(Number(rate.totalAmountCents)))
    : signedRateAmount;
  const residentialSurchargeCents = Math.max(
    0,
    Math.round(Number(rate.residentialSurchargeCents) || 0),
  );
  const shippingLineCents = Math.max(0, shippingTotalCents - residentialSurchargeCents);
  const subtotalCents = Math.max(0, Math.round(Number(source?.subtotalCents) || 0));
  const taxRateBps = Math.max(0, Math.round(Number(source?.tax?.rateBps) || 0));
  const taxableBaseCents = subtotalCents + shippingTotalCents;
  const taxCents = Math.round((taxableBaseCents * taxRateBps) / 10_000);
  const totalCents = subtotalCents + shippingTotalCents + taxCents;
  const money = (cents) => `$${(cents / 100).toFixed(2)}`;
  const freeShippingApplied = rate?.freeShippingApplied === true;

  return {
    ...source,
    shipping: {
      ...(source.shipping || {}),
      quoteStatus: sameText(rate?.provider, "local") ? "local_delivery" : "rated",
      serviceCode: rate.serviceCode || null,
      serviceLabel: rate.serviceLabel || null,
      provider: rate.provider || null,
      providerQuoteId: rateId(rate) || null,
      selectedPackageRateObjectIds: Array.isArray(rate.packageRateObjectIds) ? rate.packageRateObjectIds : [],
      selectedPackageShipmentObjectIds: Array.isArray(rate.packageShipmentObjectIds) ? rate.packageShipmentObjectIds : [],
      baseAmountCents: signedRateAmount,
      bufferCents: Math.max(0, Math.round(Number(rate.bufferCents) || 0)),
      amountCents: shippingLineCents,
      amountFormatted: money(shippingLineCents),
      residentialSurchargeCents,
      residentialSurchargeFormatted: money(residentialSurchargeCents),
      taxableShippingCents: shippingTotalCents,
      ...(freeShippingApplied
        ? {
            freeShippingApplied: true,
            carrierAmountCents: signedRateAmount,
            carrierTotalAmountCents: Math.max(
              0,
              Math.round(Number(rate?.carrierTotalAmountCents) || signedRateAmount),
            ),
            shippingDiscountCents: Math.max(
              0,
              Math.round(Number(rate?.shippingDiscountCents) || 0),
            ),
          }
        : {}),
    },
    tax: {
      ...(source.tax || {}),
      amountCents: taxCents,
      amountFormatted: money(taxCents),
      taxableBaseCents,
    },
    totals: {
      ...(source.totals || {}),
      subtotalCents,
      shippingCents: shippingTotalCents,
      taxCents,
      totalCents,
      totalFormatted: money(totalCents),
    },
    shippingCents: shippingTotalCents,
    shippingFormatted: money(shippingTotalCents),
    taxCents,
    taxFormatted: money(taxCents),
    totalCents,
    totalFormatted: money(totalCents),
    freeShipping: source?.freeShipping
      ? { ...source.freeShipping, applied: freeShippingApplied }
      : null,
    userFacingError: null,
    canCheckout: true,
  };
}
