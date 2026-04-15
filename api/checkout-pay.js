import { validateShippingAddressForCheckout } from "../lib/address-validation.js";
import { buildFullCheckoutQuote, formatShippingAddressForOrder } from "../lib/checkout-totals.js";
import { parseCheckoutPayBody } from "../lib/checkout-validation.js";
import {
  assertDiscountCodeAvailable,
  claimDiscountCodeForOrder,
  normalizeDiscountCode,
} from "../lib/discount-codes.js";
import { isHardinCountyTnDelivery } from "../lib/hardin-county.js";
import { cancelPendingOrderAfterPaymentFailure, createPendingOrder } from "../lib/orders.js";
import { sendResendOrderConfirmation } from "../lib/resend-order-confirmation.js";
import { createCardPayment } from "../lib/square.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed." });
    return;
  }

  try {
    const parsed = parseCheckoutPayBody(req.body || {});
    if (parsed.error) {
      res.status(400).json({ error: parsed.error });
      return;
    }

    const addrCheck = await validateShippingAddressForCheckout(parsed.address);
    if (!addrCheck.ok) {
      res.status(400).json({
        error: addrCheck.error,
        ...(addrCheck.addressValidation ? { addressValidation: addrCheck.addressValidation } : {}),
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

    const quote = await buildFullCheckoutQuote(parsed.items, mergedAddress, {
      pricingTier,
      shippingContext: addrCheck.shippingContext,
    });
    const customer = {
      name: parsed.name,
      email: parsed.email,
      phone: parsed.phone,
      address: formatShippingAddressForOrder(mergedAddress),
      shippingState: mergedAddress.state,
    };

    let pending = null;
    try {
      pending = await createPendingOrder({ quote, customer, hardinDiscount });
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
      ...(error.addressValidation ? { addressValidation: error.addressValidation } : {}),
    });
  }
}
