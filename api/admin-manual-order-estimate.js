import { assertReportsAuthorized } from "../lib/reports-auth.js";
import { applyTaxExemptionToQuote, parseTaxExemptionDetails } from "../lib/admin-tax-exemption.js";
import { computeCheckoutEstimate, checkoutFlowErrorJsonFields } from "../lib/checkout-estimate-logic.js";
import { normalizeFulfillmentMethod } from "../lib/manual-order-fulfillment.js";
import {
  issueManualOrderQuoteToken,
  selectManualOrderRateFromToken,
  verifyManualOrderQuoteToken,
} from "../lib/manual-order-quote-token.js";

const RETRYABLE_MANUAL_RATE_ERROR_CODES = new Set([
  "SHIPPO_TIMEOUT",
  "SHIPPO_FETCH_FAILED",
  "SHIPPO_HTTP_ERROR",
  "SHIPPO_RATE_LIMITED",
  "SHIPPO_NO_RATES",
  "SHIPPO_NO_COMMON_PACKAGE_SERVICE",
  "SHIPPO_NO_SELECTABLE_RATE",
]);

function retryableManualRateResponse(estimate) {
  if (estimate?.canCheckout === true) return false;
  const quoteStatus = String(estimate?.shipping?.quoteStatus || "").trim();
  return quoteStatus === "provider_unavailable" || quoteStatus === "error";
}

function retryableManualRateError(error) {
  return RETRYABLE_MANUAL_RATE_ERROR_CODES.has(String(error?.code || "").trim().toUpperCase());
}

function waitBeforeWholeRequestRetry() {
  return new Promise((resolve) => setTimeout(resolve, 350));
}

/**
 * Re-run the complete manual carrier estimate once after a transient provider
 * outcome. Shippo already performs its own short polling/retries inside one
 * estimate; this outer retry is deliberately capped at one additional request.
 */
export async function computeManualOrderEstimateWithRetry(
  body,
  options,
  compute = computeCheckoutEstimate,
  wait = waitBeforeWholeRequestRetry,
) {
  let firstEstimate;
  try {
    firstEstimate = await compute(body, options);
  } catch (error) {
    if (!retryableManualRateError(error)) throw error;
    console.warn("[admin-manual-order-estimate] transient carrier error; retrying whole estimate once", {
      providerErrorCode: String(error?.code || "").trim() || null,
    });
    await wait();
    return compute(body, options);
  }

  if (!retryableManualRateResponse(firstEstimate)) return firstEstimate;
  console.warn("[admin-manual-order-estimate] transient carrier response; retrying whole estimate once", {
    quoteStatus: String(firstEstimate?.shipping?.quoteStatus || "").trim() || null,
    providerErrorCode: String(firstEstimate?.serverDebug?.providerErrorCode || "").trim() || null,
  });
  await wait();
  return compute(body, options);
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed." });
    return;
  }

  try {
    await assertReportsAuthorized(req);
    const body = req.body || {};
    const fm = normalizeFulfillmentMethod(body.fulfillmentMethod);
    const isCarrier = fm === "carrier";
    const isB2b = fm === "b2b_shipping";
    if (isCarrier && body.quoteToken) {
      const payload = verifyManualOrderQuoteToken(body.quoteToken, body);
      const details = parseTaxExemptionDetails(body.taxExemption, {
        shippingAddress: body.address,
        customer: body,
      });
      const selected = applyTaxExemptionToQuote(selectManualOrderRateFromToken(payload, body), details);
      res.status(200).json({ ...selected, quoteToken: body.quoteToken });
      return;
    }
    const estimateOptions = {
      requireCompleteAddress: isCarrier || isB2b,
      manualOrderDiscount: true,
      strictShippo: isCarrier,
      allowForceStockOverride: true,
      allowManualB2bShipping: true,
    };
    let json = isCarrier
      ? await computeManualOrderEstimateWithRetry(body, estimateOptions)
      : await computeCheckoutEstimate(body, estimateOptions);
    const details = parseTaxExemptionDetails(body.taxExemption, {
      shippingAddress: body.address,
      customer: body,
    });
    json = applyTaxExemptionToQuote(json, details);
    const quoteToken = isCarrier ? issueManualOrderQuoteToken({ quote: json, request: body }) : null;
    if (isCarrier && json.canCheckout === true && !quoteToken) {
      res.status(503).json({ error: "Manual quote signing is not configured." });
      return;
    }
    res.status(200).json({ ...json, ...(quoteToken ? { quoteToken } : {}) });
  } catch (error) {
    console.error(error);
    res.status(error.statusCode || 500).json({
      error: error.message || "Estimate failed.",
      ...checkoutFlowErrorJsonFields(error),
    });
  }
}
