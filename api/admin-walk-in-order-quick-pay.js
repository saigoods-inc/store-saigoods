import { computeCheckoutEstimate, checkoutFlowErrorJsonFields } from "../lib/checkout-estimate-logic.js";
import { createWalkInOrderDraft, markWalkInOrderPaid } from "../lib/orders.js";
import { assertReportsAuthorized } from "../lib/reports-auth.js";
import { sendPaidOrderReceiptResendIfConfigured } from "../lib/send-paid-order-receipt-resend.js";
import { WALK_IN_PICKUP_ADDRESS } from "../lib/walk-in-pickup.js";

function parseQuickPayBody(body) {
  const name = String(body?.name || "").trim();
  const email = String(body?.email || "").trim();
  const phone = String(body?.phone || "").trim();
  const paymentMethod = String(body?.paymentMethod || "")
    .trim()
    .toLowerCase();
  if (!name) {
    return { error: "Customer name is required." };
  }
  if (email && !email.includes("@")) {
    return { error: "If provided, email must be valid." };
  }
  if (phone) {
    const phoneDigits = phone.replace(/\D/g, "");
    if (phoneDigits.length < 10) {
      return { error: "If provided, phone must have at least 10 digits." };
    }
  }
  if (paymentMethod !== "cash" && paymentMethod !== "check") {
    return { error: "paymentMethod must be cash or check." };
  }
  const items = Array.isArray(body?.items) ? body.items : [];
  if (!items.length) {
    return { error: "Add at least one line item." };
  }
  return {
    name,
    email: email || null,
    phone: phone || null,
    paymentMethod,
    sendReceipt: body?.sendReceipt === true,
    items,
    applyEligibleLocalDiscount: body?.applyEligibleLocalDiscount === true,
  };
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed." });
    return;
  }

  try {
    await assertReportsAuthorized(req);
    const parsed = parseQuickPayBody(req.body || {});
    if (parsed.error) {
      res.status(400).json({ error: parsed.error });
      return;
    }

    const estimateBody = {
      items: parsed.items,
      address: WALK_IN_PICKUP_ADDRESS,
      applyEligibleLocalDiscount: parsed.applyEligibleLocalDiscount,
    };
    const quote = await computeCheckoutEstimate(estimateBody, {
      requireCompleteAddress: true,
      adminLocalDiscount: true,
      walkInPickup: true,
      strictShippo: false,
      allowForceStockOverride: true,
    });

    const hardinDiscount =
      quote.hardinDiscountApplied === true
        ? {
            applied: true,
            code: null,
            adminAddressVerified: true,
            adminOverride: false,
          }
        : null;

    const customer = {
      name: parsed.name,
      email: parsed.email,
      phone: parsed.phone,
      address: "In-store pickup\nSavannah, TN 38372",
      shippingState: WALK_IN_PICKUP_ADDRESS.state,
    };

    const draft = await createWalkInOrderDraft({
      quote,
      customer,
      hardinDiscount,
      shippingAddress: WALK_IN_PICKUP_ADDRESS,
    });
    const paid = await markWalkInOrderPaid({
      orderId: draft.id,
      paymentMethod: parsed.paymentMethod,
    });

    let receipt = { sent: false, reason: "skipped" };
    if (parsed.sendReceipt) {
      receipt = await sendPaidOrderReceiptResendIfConfigured(paid);
    }

    res.status(200).json({
      ok: true,
      orderId: paid.id,
      orderRef: paid.order_ref,
      totalFormatted: quote.totalFormatted,
      paymentMethod: paid.payment_method,
      ...(paid.inventoryWarning ? { inventoryWarning: String(paid.inventoryWarning) } : {}),
      receiptEmailAttempted: parsed.sendReceipt,
      receiptEmailSent: receipt.sent === true,
      receiptEmailReason: receipt.reason || null,
    });
  } catch (error) {
    console.error(error);
    res.status(error.statusCode || 500).json({
      error: error.message || "Could not complete quick payment.",
      ...checkoutFlowErrorJsonFields(error),
    });
  }
}
