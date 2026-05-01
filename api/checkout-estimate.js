import "../import-env.mjs";
import { computeCheckoutEstimate, checkoutFlowErrorJsonFields } from "../lib/checkout-estimate-logic.js";
import { getShippingQuoteMode } from "../lib/checkout-totals.js";
import { isCheckoutShippoLogEnabled } from "../lib/shippo.js";
import { getShippingRateProviderId } from "../lib/shipping-rate-provider.js";

function logCheckoutEstimateForDebug(quote) {
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

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed." });
    return;
  }

  try {
    const body = req.body || {};
    if (isCheckoutShippoLogEnabled()) {
      console.log("[checkout-estimate] incoming request", {
        itemCount: Array.isArray(body.items) ? body.items.length : 0,
        discountCodeSet: Boolean(String(body?.discountCode ?? "").trim()),
      });
    }
    const json = await computeCheckoutEstimate(body);
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
    res.status(200).json(json);
  } catch (error) {
    console.error(error);
    const status = error.statusCode || 500;
    res.status(status).json({
      error: error.message || "Estimate failed.",
      ...checkoutFlowErrorJsonFields(error),
    });
  }
}
