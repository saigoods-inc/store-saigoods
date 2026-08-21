import { validateShippingAddressForCheckout } from "../lib/address-validation.js";
import { buildFullCheckoutQuote, formatShippingAddressForOrder } from "../lib/checkout-totals.js";
import { parseCheckoutPayBody } from "../lib/checkout-validation.js";
import {
  assertDiscountCodeAvailable,
  claimDiscountCodeForOrder,
  normalizeDiscountCode,
} from "../lib/discount-codes.js";
import { cancelPendingOrderAfterPaymentFailure, createPendingOrder, markOrderPaid } from "../lib/orders.js";
import { sendResendOrderConfirmation } from "../lib/resend-order-confirmation.js";
import { syncWebsiteOrderToShippo } from "../lib/shippo-order-sync.js";
import { createCardPayment } from "../lib/square.js";
import { assertCartItemsHaveValidSupportedSizeAllocation } from "../lib/quote.js";
import { assertStockAvailableForItems } from "../lib/stock.js";
import { primeRuntimeStoreForItems } from "../lib/runtime-store.js";
import { checkoutFlowErrorJsonFields } from "../lib/checkout-estimate-logic.js";
import {
  selectSignedCheckoutQuote,
  verifyCheckoutQuoteToken,
} from "../lib/checkout-quote-token.js";
import { assertPublicApiRequestAllowed } from "../lib/public-api-guard.js";
import { loadDefaultShipFromOverride, warehouseAddressFingerprint } from "../lib/warehouse-settings.js";
import { assertCompletedSquarePaymentMatchesOrder } from "../lib/square-payment-verification.js";
import { shippingPackageLimitState } from "../lib/shipping-package-limit.js";

/**
 * Deterministic rejection when the authoritative final quote says checkout cannot proceed.
 * Safe shipping mode/quoteStatus only (estimate conventions); no secrets or raw provider dumps.
 */
export const CHECKOUT_PAY_NOT_READY_BODY = {
  error: "Checkout cannot proceed because the shipping quote is not ready.",
  canCheckout: false,
};

/** Build the fail-closed JSON body, optionally attaching safe shipping status from the quote. */
export function buildCheckoutPayNotReadyBody(quote) {
  const shipping = quote?.shipping && typeof quote.shipping === "object" ? quote.shipping : null;
  if (!shipping) {
    return { ...CHECKOUT_PAY_NOT_READY_BODY };
  }
  return {
    ...CHECKOUT_PAY_NOT_READY_BODY,
    shipping: {
      mode: shipping.mode ?? null,
      quoteStatus: shipping.quoteStatus ?? null,
    },
  };
}

/** Reject oversized public orders even when an older signed quote is replayed. */
export function buildCheckoutPayPackageLimitBody(quote) {
  const limit = shippingPackageLimitState(quote?.parcelSummary);
  if (!limit.exceeded) return null;
  return {
    error: limit.message,
    canCheckout: false,
    parcelSummary: quote?.parcelSummary || { parcelCount: limit.packageCount, parcels: [] },
    shippingPackageLimit: limit,
  };
}

function shouldRetryCheckoutQuote(quote) {
  if (quote?.canCheckout === true) return false;
  const status = String(quote?.shipping?.quoteStatus || "").trim();
  return status === "provider_unavailable" || status === "error";
}

/** Retry one transient carrier failure before rejecting a shopper at the payment step. */
export async function buildCheckoutPayQuoteWithRetry(items, address, options, buildQuote = buildFullCheckoutQuote) {
  const firstQuote = await buildQuote(items, address, options);
  if (!shouldRetryCheckoutQuote(firstQuote)) return firstQuote;
  return buildQuote(items, address, options);
}

export function checkoutSelectedShippingRateFields(body = {}) {
  return {
    selectedShippingRateObjectId: body.selectedShippingRateObjectId,
    selectedShippingServiceCode: body.selectedShippingServiceCode,
    selectedShippingServiceLabel: body.selectedShippingServiceLabel,
    selectedShippingProvider: body.selectedShippingProvider,
    selectedShippingAmountCents: body.selectedShippingAmountCents,
    selectedShippingParcelCount: body.selectedShippingParcelCount,
  };
}

async function markOrderPaidWithRetry(args, markPaid = markOrderPaid) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await markPaid(args);
    } catch (error) {
      lastError = error;
      if (attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)));
      }
    }
  }
  throw lastError;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed." });
    return;
  }

  try {
    if (process.env.NODE_ENV !== "test") {
      assertPublicApiRequestAllowed(req, {
        name: "checkout-pay",
        limit: 10,
        windowMs: 10 * 60 * 1000,
      });
    }
    const parsed = parseCheckoutPayBody(req.body || {});
    if (parsed.error) {
      res.status(400).json({
        error: parsed.error,
        ...(parsed.fieldErrors && Object.keys(parsed.fieldErrors).length ? { fieldErrors: parsed.fieldErrors } : {}),
      });
      return;
    }

    const discountRaw = parsed.discountCode ? String(parsed.discountCode).trim() : "";
    const normalizedCode = discountRaw ? normalizeDiscountCode(discountRaw) : null;
    if (discountRaw && !normalizedCode) {
      res.status(400).json({
        error: "Enter a valid discount code.",
      });
      return;
    }

    const quoteToken = String(req.body?.checkoutQuoteToken || "").trim();
    const verifiedQuotePayload = quoteToken
      ? verifyCheckoutQuoteToken(quoteToken, {
          items: parsed.items,
          address: parsed.address,
          discountCode: discountRaw,
        })
      : null;
    if (verifiedQuotePayload) {
      const signedOrigin = String(verifiedQuotePayload?.quote?.shipping?.originFingerprint || "").trim();
      const currentOrigin = warehouseAddressFingerprint(await loadDefaultShipFromOverride());
      if (signedOrigin && currentOrigin && signedOrigin !== currentOrigin) {
        const error = new Error("The shipping origin changed. Confirm your address and shipping service again.");
        error.statusCode = 409;
        error.code = "CHECKOUT_ORIGIN_CHANGED";
        throw error;
      }
    }
    let addrCheck;
    let mergedAddress;
    if (verifiedQuotePayload) {
      const signedAddress =
        verifiedQuotePayload?.quote?.addressValidation?.normalizedAddress ||
        verifiedQuotePayload.submittedAddress;
      addrCheck = {
        ok: true,
        normalizedAddress: signedAddress,
        shippingContext: {
          applyResidentialSurcharge:
            verifiedQuotePayload?.quote?.shipping?.addressIsResidential === true,
          shippoUnavailable: false,
        },
      };
      mergedAddress = { ...parsed.address, ...(signedAddress || {}) };
    } else {
      addrCheck = await validateShippingAddressForCheckout(parsed.address, { strictShippo: true });
      addrCheck.submittedAddress = parsed.address;
      if (!addrCheck.ok) {
        res.status(400).json({
          error: addrCheck.error,
          ...checkoutFlowErrorJsonFields({
            addressValidation: addrCheck.addressValidation,
            fieldErrors: addrCheck.fieldErrors,
          }),
        });
        return;
      }
      mergedAddress =
        addrCheck.normalizedAddress && typeof addrCheck.normalizedAddress === "object"
          ? { ...parsed.address, ...addrCheck.normalizedAddress }
          : parsed.address;
    }

    let pricingTier = "standard";
    let hardinDiscount = null;
    let codeDiscount = null;

    if (normalizedCode) {
      const codeDetails = await assertDiscountCodeAvailable(normalizedCode);
      const percentOff = Number(codeDetails?.percentOff) || 7;
      codeDiscount = { type: "percent", value: percentOff };
      pricingTier = "standard";
      hardinDiscount = { code: normalizedCode, applied: true, percentOff };
    }

    await primeRuntimeStoreForItems(parsed.items);
    assertCartItemsHaveValidSupportedSizeAllocation(parsed.items);
    await assertStockAvailableForItems(parsed.items);
    const selectedShipping = checkoutSelectedShippingRateFields(req.body || {});
    const selectedQuote = verifiedQuotePayload
      ? selectSignedCheckoutQuote(verifiedQuotePayload, selectedShipping)
      : await buildCheckoutPayQuoteWithRetry(parsed.items, mergedAddress, {
          pricingTier,
          shippingContext: addrCheck.shippingContext,
          flow: "checkout",
          addressValidationResult: addrCheck,
          ...(codeDiscount ? { manualDiscount: codeDiscount } : {}),
          ...selectedShipping,
        });
    const quote = verifiedQuotePayload
      ? {
          ...selectedQuote,
          quoteCorrelationId: verifiedQuotePayload.quoteCorrelationId,
          quoteExpiresAt: new Date(Number(verifiedQuotePayload.exp)).toISOString(),
          requestFingerprint: verifiedQuotePayload.requestFingerprint,
        }
      : selectedQuote;

    const packageLimitBody = buildCheckoutPayPackageLimitBody(quote);
    if (packageLimitBody) {
      res.status(422).json(packageLimitBody);
      return;
    }

    // Fail closed: allow payment only when the authoritative final quote explicitly says ready.
    // Strict === true rejects false, undefined, null, and any non-boolean truthy value.
    // 503: quote capability unavailable (same family as payment-link live-shipping gate / Square unconfigured).
    if (quote.canCheckout !== true) {
      res.status(503).json(buildCheckoutPayNotReadyBody(quote));
      return;
    }

    const customer = {
      name: parsed.name,
      email: parsed.email,
      phone: parsed.phone,
      address: formatShippingAddressForOrder(mergedAddress),
      shippingState: mergedAddress.state,
    };

    const localDelivery =
      quote?.freeDelivery?.applied === true ||
      String(quote?.shipping?.mode || "") === "local_delivery" ||
      String(quote?.shipping?.provider || "") === "local";
    const pending = await createPendingOrder({
      quote,
      customer,
      hardinDiscount,
      shippingAddress: mergedAddress && typeof mergedAddress === "object" ? mergedAddress : null,
      checkoutAttemptId: parsed.checkoutAttemptId,
      fulfillmentMethod: localDelivery ? "local_delivery" : "carrier",
    });
    const locationId = process.env.SQUARE_LOCATION_ID?.trim();

    if (String(pending.status || "") === "paid" && pending.payment_id) {
      res.status(200).json({
        success: true,
        idempotent: true,
        paymentId: pending.payment_id,
        orderId: pending.id,
        orderRef: pending.order_ref,
        totalFormatted: quote.totalFormatted,
        hardinDiscountApplied: Boolean(normalizedCode),
      });
      return;
    }
    if (String(pending.order_status || "") === "cancelled") {
      const err = new Error("This payment attempt ended. Please submit payment again.");
      err.statusCode = 409;
      err.retryWithNewAttempt = true;
      throw err;
    }

    if (normalizedCode) {
      const claimed = await claimDiscountCodeForOrder(normalizedCode, pending.id);
      if (!claimed) {
        await cancelPendingOrderAfterPaymentFailure(pending.id);
        const err = new Error(
          "This discount code was just used by another order. Refresh and try again without the code, or use a different code.",
        );
        err.statusCode = 409;
        throw err;
      }
    }

    let paymentId;
    let payment;
    try {
      ({ paymentId, payment } = await createCardPayment({
        sourceId: parsed.sourceId,
        amountCents: quote.totalCents,
        locationId,
        orderId: pending.id,
        buyerEmail: parsed.email,
        idempotencyKey: `saigoods-pay-${pending.id}`,
      }));
      assertCompletedSquarePaymentMatchesOrder(payment, {
        orderId: pending.id,
        amountCents: quote.totalCents,
        currency: quote.currency || "USD",
      });
    } catch (paymentError) {
      if (paymentError?.paymentOutcomeUncertain === true) {
        paymentError.statusCode = 503;
        paymentError.retrySafe = true;
        throw paymentError;
      }
      paymentError.retryWithNewAttempt = true;
      await cancelPendingOrderAfterPaymentFailure(pending.id);
      throw paymentError;
    }

    try {
      await markOrderPaidWithRetry({
        orderId: pending.id,
        paymentId,
        paidTotalCents: quote.totalCents,
        customerAddress: formatShippingAddressForOrder(mergedAddress),
        buyerEmail: parsed.email,
        buyerPhone: parsed.phone,
        buyerName: parsed.name,
        payment,
      });
    } catch (persistError) {
      console.error("[checkout-pay] paid order awaiting webhook reconciliation", {
        orderId: pending.id,
        code: String(persistError?.code || "payment_persist_failed").slice(0, 64),
      });
      res.status(200).json({
        success: true,
        paymentPendingConfirmation: true,
        paymentId,
        orderId: pending.id,
        orderRef: pending.order_ref,
        totalFormatted: quote.totalFormatted,
        hardinDiscountApplied: Boolean(normalizedCode),
      });
      return;
    }

    if (!localDelivery && process.env.ENABLE_SHIPPO_ORDER_SYNC === "true") {
      const shippoSync = await syncWebsiteOrderToShippo(pending.id);
      if (!shippoSync.ok && !shippoSync.skipped) {
        console.error("[shippo] checkout sync failed:", shippoSync.error || shippoSync.reason || "unknown");
      }
    }

    if (!localDelivery) {
      void import("../lib/automatic-label-worker.js")
        .then(({ processAutomaticLabelsForOrder }) => processAutomaticLabelsForOrder(pending.id))
        .catch((error) => {
          console.error("[shipping] automatic label worker deferred to recovery", {
            orderId: pending.id,
            code: String(error?.code || "AUTOMATIC_LABEL_WORKER_FAILED").slice(0, 64),
          });
        });
    }

    void sendResendOrderConfirmation({
      pending: {
        ...pending,
        shipping_address: mergedAddress && typeof mergedAddress === "object" ? mergedAddress : null,
      },
      quote,
      customerEmail: parsed.email,
      customerName: parsed.name,
    }).catch((err) => console.error("Resend order receipt failed:", err));

    res.status(200).json({
      success: true,
      paymentId,
      orderId: pending.id,
      orderRef: pending.order_ref,
      totalFormatted: quote.totalFormatted,
      hardinDiscountApplied: Boolean(normalizedCode),
    });
  } catch (error) {
    console.error(error);
    res.status(error.statusCode || 500).json({
      error: error.message || "Payment could not be completed.",
      ...(error.retrySafe === true ? { retrySafe: true } : {}),
      ...(error.retryWithNewAttempt === true ? { retryWithNewAttempt: true } : {}),
      ...checkoutFlowErrorJsonFields(error),
    });
  }
}
