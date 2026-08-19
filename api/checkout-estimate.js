import "../import-env.mjs";
import { computeCheckoutEstimate, checkoutFlowErrorJsonFields } from "../lib/checkout-estimate-logic.js";
import { getShippingQuoteMode } from "../lib/checkout-totals.js";
import { isCheckoutShippoLogEnabled } from "../lib/shippo.js";
import { getShippingRateProviderId } from "../lib/shipping-rate-provider.js";
import { recordShippingHealthEvent } from "../lib/shipping-health.js";
import { issueCheckoutQuoteToken } from "../lib/checkout-quote-token.js";
import { checkoutQuoteTtlMs } from "../lib/checkout-quote-token.js";
import crypto from "node:crypto";
import { assertPublicApiRequestAllowed } from "../lib/public-api-guard.js";

const SHIPPING_RATE_SELECTION_FIELDS = [
  "selectedShippingRateObjectId",
  "selectedShippingServiceCode",
  "selectedShippingServiceLabel",
  "selectedShippingProvider",
  "selectedShippingAmountCents",
  "selectedShippingParcelCount",
  "selectedShippingResidentialSurchargeCents",
];

export function withoutSelectedShippingRate(body) {
  const next = body && typeof body === "object" ? { ...body } : {};
  for (const field of SHIPPING_RATE_SELECTION_FIELDS) delete next[field];
  return next;
}

export async function computeCheckoutEstimateWithFreshSelection(
  body,
  compute = computeCheckoutEstimate,
) {
  let requestBody = body;
  let estimate;
  try {
    estimate = await compute(requestBody);
  } catch (error) {
    if (error?.code !== "INVALID_SHIPPING_RATE_SELECTION") throw error;
    const hadSelection = SHIPPING_RATE_SELECTION_FIELDS.some((field) => body?.[field] != null);
    if (!hadSelection) throw error;
    if (isCheckoutShippoLogEnabled()) {
      console.warn("[checkout-estimate] stale shipping selection; refreshing current rates");
    }
    requestBody = withoutSelectedShippingRate(body);
    estimate = await compute(requestBody);
  }

  const quoteStatus = String(estimate?.shipping?.quoteStatus || "").trim();
  const transientFailure =
    estimate?.canCheckout === false && (quoteStatus === "provider_unavailable" || quoteStatus === "error");
  if (!transientFailure) return estimate;

  // The Shippo provider owns delayed-rate polling. Recomputing after a Shippo
  // rate failure would POST a new shipment instead of polling the one already
  // created, so return the retryable checkout response without duplicating it.
  const providerErrorCode = String(estimate?.serverDebug?.providerErrorCode || "").trim().toUpperCase();
  if (providerErrorCode.startsWith("SHIPPO_")) {
    return estimate;
  }

  if (isCheckoutShippoLogEnabled()) {
    console.warn("[checkout-estimate] transient carrier failure; retrying once");
  }
  return compute(requestBody);
}

function logCheckoutEstimateForDebug(quote) {
  if (!isCheckoutShippoLogEnabled()) return;
  const s = quote?.shipping && typeof quote.shipping === "object" ? quote.shipping : {};
  console.log("[checkout-estimate]", {
    env_SHIPPING_QUOTE_MODE: process.env.SHIPPING_QUOTE_MODE ?? null,
    env_SHIPPING_RATE_PROVIDER: process.env.SHIPPING_RATE_PROVIDER ?? null,
    env_SHIPPING_PROVIDER: process.env.SHIPPING_PROVIDER ?? null,
    resolvedShippingQuoteMode: getShippingQuoteMode(),
    resolved_SHIPPING_RATE_PROVIDER: getShippingRateProviderId(),
    "shipping.mode": s.mode,
    "shipping.provider": s.provider,
    "shipping.serviceCode": s.serviceCode,
    "shipping.serviceLabel": s.serviceLabel,
    "shipping.amountCents": s.amountCents,
    "shipping.quoteStatus": s.quoteStatus,
    providerQuoteId: s.providerQuoteId ?? null,
    totalShippingCentsLine: Math.max(0, Math.round(Number(quote?.shippingCents) || 0)),
  });
}

export function publicCheckoutEstimateJson(estimate) {
  if (!estimate || typeof estimate !== "object") return estimate;
  const { serverDebug: _serverDebug, ...publicEstimate } = estimate;
  return publicEstimate;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed." });
    return;
  }

  const startedAt = Date.now();
  try {
    if (process.env.NODE_ENV !== "test") {
      assertPublicApiRequestAllowed(req, {
        name: "checkout-estimate",
        limit: 30,
        windowMs: 60 * 1000,
      });
    }
    // Online checkout has one server-owned Standard Ground price. Ignore any
    // legacy or tampered browser rate selection fields.
    const body = withoutSelectedShippingRate(req.body || {});
    if (isCheckoutShippoLogEnabled()) {
      console.log("[checkout-estimate] incoming request", {
        itemCount: Array.isArray(body.items) ? body.items.length : 0,
        discountCodeSet: Boolean(String(body?.discountCode ?? "").trim()),
      });
    }
    const json = await computeCheckoutEstimateWithFreshSelection(body);
    if (isCheckoutShippoLogEnabled()) {
      const av = json?.addressValidation && typeof json.addressValidation === "object" ? json.addressValidation : {};
      console.log("[checkout-estimate] address validation result", {
        status: av.status,
        suggested: Boolean(av.suggestion),
        hasMessages: Array.isArray(av.messages) && av.messages.length > 0,
        isResidential: av.isResidential === true,
      });
      const s = json?.shipping && typeof json.shipping === "object" ? json.shipping : {};
      console.log("[checkout-estimate] shipping line on response", {
        mode: s.mode,
        quoteStatus: s.quoteStatus,
        provider: s.provider,
        serviceCode: s.serviceCode,
        serviceLabel: s.serviceLabel,
        amountCents: s.amountCents,
        providerQuoteId: s.providerQuoteId,
      });
    }
    logCheckoutEstimateForDebug(json);
    const shipping = json?.shipping && typeof json.shipping === "object" ? json.shipping : {};
    const rateCount = Array.isArray(json?.shippingRateOptions) ? json.shippingRateOptions.length : null;
    const providerErrorCode = String(json?.serverDebug?.providerErrorCode || "").trim().toUpperCase();
    const noRates =
      json?.canCheckout === false &&
      rateCount === 0 &&
      (providerErrorCode === "SHIPPO_NO_RATES" || providerErrorCode === "SHIPPO_NO_COMMON_PACKAGE_SERVICE");
    await recordShippingHealthEvent({
      eventType: "checkout_rate",
      outcome:
        shipping.fallbackRated === true || shipping.provider === "fallback"
          ? "fallback"
          : noRates
            ? "no_rates"
            : json?.canCheckout === false
              ? "failed"
              : "success",
      provider: shipping.provider || getShippingRateProviderId(),
      parcelCount: shipping.parcelCount,
      rateCount,
      durationMs: Date.now() - startedAt,
    });
    const quoteIssuedAt = Date.now();
    const publicJson = {
      ...publicCheckoutEstimateJson(json),
      quoteCorrelationId: crypto.randomUUID(),
    };
    const checkoutQuoteToken = issueCheckoutQuoteToken({
      quote: publicJson,
      items: body.items,
      address: body.address,
      discountCode: body.discountCode,
      now: quoteIssuedAt,
    });
    res.status(200).json({
      ...publicJson,
      ...(checkoutQuoteToken
        ? {
            checkoutQuoteToken,
            checkoutQuoteIssuedAt: new Date(quoteIssuedAt).toISOString(),
            checkoutQuoteExpiresAt: new Date(quoteIssuedAt + checkoutQuoteTtlMs()).toISOString(),
          }
        : {}),
    });
  } catch (error) {
    console.error(error);
    await recordShippingHealthEvent({
      eventType: "checkout_rate",
      outcome: error?.code === "SHIPPO_NO_RATES" || error?.code === "SHIPPO_NO_COMMON_PACKAGE_SERVICE" ? "no_rates" : "failed",
      errorCode: error?.code || "UNKNOWN",
      provider: getShippingRateProviderId(),
      durationMs: Date.now() - startedAt,
    });
    const status = error.statusCode || 500;
    res.status(status).json({
      error: status >= 500 ? "We could not calculate your order right now. Please try again." : error.message || "Estimate failed.",
      ...checkoutFlowErrorJsonFields(error),
    });
  }
}
