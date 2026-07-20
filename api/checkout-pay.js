import { validateShippingAddressForCheckout } from "../lib/address-validation.js";
import { buildFullCheckoutQuote, formatShippingAddressForOrder } from "../lib/checkout-totals.js";
import { parseCheckoutPayBody } from "../lib/checkout-validation.js";
import {
  assertDiscountCodeAvailable,
  claimDiscountCodeForOrder,
  normalizeDiscountCode,
} from "../lib/discount-codes.js";
import { isHardinCountyTnDelivery } from "../lib/hardin-county.js";
import { cancelPendingOrderAfterPaymentFailure, createPendingOrder, markOrderPaid } from "../lib/orders.js";
import { sendResendOrderConfirmation } from "../lib/resend-order-confirmation.js";
import { syncWebsiteOrderToShippo } from "../lib/shippo-order-sync.js";
import { createCardPayment } from "../lib/square.js";
import { assertCartItemsHaveValidSupportedSizeAllocation } from "../lib/quote.js";
import { assertStockAvailableForItems } from "../lib/stock.js";
import { checkoutFlowErrorJsonFields } from "../lib/checkout-estimate-logic.js";

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

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed." });
    return;
  }

  try {
    const parsed = parseCheckoutPayBody(req.body || {});
    if (parsed.error) {
      res.status(400).json({
        error: parsed.error,
        ...(parsed.fieldErrors && Object.keys(parsed.fieldErrors).length ? { fieldErrors: parsed.fieldErrors } : {}),
      });
      return;
    }

    const addrCheck = await validateShippingAddressForCheckout(parsed.address, { strictShippo: true });
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

    const mergedAddress =
      addrCheck.normalizedAddress && typeof addrCheck.normalizedAddress === "object"
        ? { ...parsed.address, ...addrCheck.normalizedAddress }
        : parsed.address;

    const discountRaw = parsed.discountCode ? String(parsed.discountCode).trim() : "";
    const normalizedCode = discountRaw ? normalizeDiscountCode(discountRaw) : null;
    if (discountRaw && !normalizedCode) {
      res.status(400).json({
        error: "Enter a valid discount code (format HC-XXXXX, letters and numbers only).",
      });
      return;
    }

    let pricingTier = "standard";
    let hardinDiscount = null;

    if (normalizedCode) {
      if (!isHardinCountyTnDelivery(mergedAddress)) {
        res.status(400).json({
          error: "This discount code is invalid or not applicable to this address.",
        });
        return;
      }

      await assertDiscountCodeAvailable(normalizedCode);
      pricingTier = "hardin";
      hardinDiscount = { code: normalizedCode, applied: true };
    }

    assertCartItemsHaveValidSupportedSizeAllocation(parsed.items);
    await assertStockAvailableForItems(parsed.items);
    const quote = await buildFullCheckoutQuote(parsed.items, mergedAddress, {
      pricingTier,
      shippingContext: addrCheck.shippingContext,
      flow: "checkout",
      addressValidationResult: addrCheck,
    });

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

    let pending = null;
    try {
      pending = await createPendingOrder({
        quote,
        customer,
        hardinDiscount,
        shippingAddress: mergedAddress && typeof mergedAddress === "object" ? mergedAddress : null,
      });
      const locationId = process.env.SQUARE_LOCATION_ID?.trim();

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

      const { paymentId } = await createCardPayment({
        sourceId: parsed.sourceId,
        amountCents: quote.totalCents,
        locationId,
        orderId: pending.id,
        buyerEmail: parsed.email,
        idempotencyKey: `saigoods-pay-${pending.id}`,
      });

      await markOrderPaid({
        orderId: pending.id,
        paymentId,
        paidTotalCents: quote.totalCents,
        customerAddress: formatShippingAddressForOrder(mergedAddress),
        buyerEmail: parsed.email,
        buyerPhone: parsed.phone,
        buyerName: parsed.name,
      });

      if (process.env.ENABLE_SHIPPO_ORDER_SYNC === "true") {
        const shippoSync = await syncWebsiteOrderToShippo(pending.id);
        if (!shippoSync.ok && !shippoSync.skipped) {
          console.error("[shippo] checkout sync failed:", shippoSync.error || shippoSync.reason || "unknown");
        }
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
    } catch (payError) {
      if (pending?.id) {
        await cancelPendingOrderAfterPaymentFailure(pending.id);
      }
      throw payError;
    }
  } catch (error) {
    console.error(error);
    res.status(error.statusCode || 500).json({
      error: error.message || "Payment could not be completed.",
      ...checkoutFlowErrorJsonFields(error),
    });
  }
}
