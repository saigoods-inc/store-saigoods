/**
 * Walk-in quick-pay: create draft then complete via hardened markWalkInOrderPaid.
 *
 * Option B — Legacy compatibility preserved; unsuitable for Admin-v2 first release.
 * Draft creation is not durable-idempotent (retry can create a second draft). Admin-v2
 * must use create-draft → explicit mark-paid instead of this endpoint.
 */

import { computeCheckoutEstimate, checkoutFlowErrorJsonFields } from "../lib/checkout-estimate-logic.js";
import { createWalkInOrderDraft, markWalkInOrderPaid } from "../lib/orders.js";
import { assertReportsAuthorized, getReportsActor } from "../lib/reports-auth.js";
import { sendPaidOrderReceiptResendIfConfigured } from "../lib/send-paid-order-receipt-resend.js";
import { WALK_IN_PICKUP_ADDRESS } from "../lib/walk-in-pickup.js";

/** Explicit capability flag for tests / Admin-v2 gating. */
export const WALK_IN_QUICK_PAY_ADMIN_V2_SAFE = false;

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

function sanitizePublicError(error) {
  const status = error?.statusCode || 500;
  const msg = String(error?.message || "").trim();
  if (status >= 500) {
    return "Could not complete quick payment.";
  }
  return msg || "Could not complete quick payment.";
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed." });
    return;
  }

  try {
    await assertReportsAuthorized(req);
    const actor = await getReportsActor(req);
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
      allowForceStockOverride: false,
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
      actorEmail: actor?.email || null,
    });

    const idempotent = paid?.idempotent === true;
    let receipt = { sent: false, reason: "skipped" };
    if (parsed.sendReceipt && !idempotent) {
      receipt = await sendPaidOrderReceiptResendIfConfigured(paid);
    } else if (parsed.sendReceipt && idempotent) {
      receipt = { sent: false, reason: "already_completed" };
    }

    res.status(200).json({
      ok: true,
      orderId: paid.id,
      orderRef: paid.order_ref,
      totalFormatted: quote.totalFormatted,
      paymentMethod: paid.payment_method,
      status: paid.status,
      orderStatus: paid.order_status,
      paidAt: paid.paid_at || null,
      adminHandoffAt: paid.admin_handoff_at || null,
      inventoryCommitted: paid.inventoryCommitted === true || Boolean(paid.inventory_committed_at),
      inventoryCommittedAt: paid.inventory_committed_at || null,
      completed: true,
      idempotent,
      adminV2Safe: WALK_IN_QUICK_PAY_ADMIN_V2_SAFE,
      receiptEmailAttempted: parsed.sendReceipt === true && !idempotent,
      receiptEmailSent: receipt.sent === true,
      receiptEmailReason: receipt.reason || null,
      ...(receipt.sent !== true && parsed.sendReceipt && !idempotent
        ? { receiptWarning: "Order completed, but the receipt email could not be sent." }
        : {}),
    });
  } catch (error) {
    console.error(error);
    res.status(error.statusCode || 500).json({
      error: sanitizePublicError(error),
      ...checkoutFlowErrorJsonFields(error),
    });
  }
}
