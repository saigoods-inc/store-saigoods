import { claimDiscountCodeForOrder, normalizeDiscountCode, releaseDiscountCodeForOrder } from "../lib/discount-codes.js";
import { computeCheckoutEstimate, checkoutFlowErrorJsonFields } from "../lib/checkout-estimate-logic.js";
import { computeEconomicsSnapshotForOrder } from "../lib/order-economics.js";
import { sendManualOrderPaymentLinkEmail } from "../lib/manual-order-payment-email.js";
import {
  buildOrderQuoteSnapshotColumns,
  getOrderByIdForService,
  updateOrderPaymentLinkSent,
} from "../lib/orders.js";
import { assertReportsAuthorized } from "../lib/reports-auth.js";
import { createClient } from "@supabase/supabase-js";
import { createPaymentLink } from "../lib/square.js";

function getServiceClient() {
  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) {
    const e = new Error("Supabase is not configured.");
    e.statusCode = 503;
    throw e;
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

async function syncOrderTotalsFromQuote(client, orderId, quote, shippingAddress) {
  const amountCents =
    Math.max(0, Number(quote.subtotalCents) || 0) + Math.max(0, Number(quote.shippingCents) || 0);
  const taxCollected = Math.max(0, Number(quote.taxCents) || 0);

  const { error } = await client
    .from("orders")
    .update({
      items: quote.items,
      subtotal_cents: quote.subtotalCents,
      shipping_cents: quote.shippingCents,
      tax_cents: quote.taxCents,
      total_cents: quote.totalCents,
      amount: amountCents,
      tax_collected: taxCollected,
      ...buildOrderQuoteSnapshotColumns({ quote, shippingAddress }),
      admin_local_discount_override: Boolean(quote.adminLocalDiscountForced),
      updated_at: new Date().toISOString(),
      ...computeEconomicsSnapshotForOrder(quote.items, quote),
    })
    .eq("id", orderId)
    .eq("order_status", "draft");

  if (error) {
    throw error;
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed." });
    return;
  }

  try {
    await assertReportsAuthorized(req);
    const orderId = String(req.body?.orderId || "").trim();
    if (!orderId) {
      res.status(400).json({ error: "orderId is required." });
      return;
    }

    const order = await getOrderByIdForService(orderId);
    if (!order) {
      res.status(404).json({ error: "Order not found." });
      return;
    }

    if (String(order.order_source || "web") !== "manual") {
      res.status(400).json({ error: "Only manual orders can receive a payment link from this action." });
      return;
    }

    const st = String(order.order_status || "");
    if (st === "payment_link_sent") {
      res.status(400).json({ error: "A payment link email was already sent for this order." });
      return;
    }
    if (st !== "draft") {
      res.status(400).json({ error: "Order must be a draft to send a payment link." });
      return;
    }

    if (String(order.status || "") === "paid") {
      res.status(400).json({ error: "This order is already paid." });
      return;
    }

    const shipAddr = order.shipping_address;
    if (!shipAddr || typeof shipAddr !== "object") {
      res.status(400).json({ error: "Order is missing shipping_address; recreate the draft." });
      return;
    }

    const adminAddressHardin =
      order.is_hardin_discount === true && !String(order.discount_code_used || "").trim();

    const estimateBody = {
      items: order.items,
      address: shipAddr,
      discountCode: order.discount_code_used || "",
      applyEligibleLocalDiscount: adminAddressHardin,
      forceApplyEligibleLocalDiscount:
        adminAddressHardin && order.admin_local_discount_override === true,
      ...(req.body?.forceStockOverride === true ? { forceStockOverride: true } : {}),
    };

    const quote = await computeCheckoutEstimate(estimateBody, {
      requireCompleteAddress: true,
      adminLocalDiscount: adminAddressHardin,
      strictShippo: false,
      allowForceStockOverride: true,
    });

    const client = getServiceClient();
    await syncOrderTotalsFromQuote(client, order.id, quote, shipAddr);

    const normalizedCode = order.discount_code_used
      ? normalizeDiscountCode(String(order.discount_code_used))
      : null;
    let claimed = false;

    if (st === "draft" && order.is_hardin_discount && normalizedCode) {
      claimed = await claimDiscountCodeForOrder(normalizedCode, order.id);
      if (!claimed) {
        res.status(409).json({
          error:
            "Could not reserve the discount code (it may have been used elsewhere). Update the order or remove the code.",
        });
        return;
      }
    }

    const customer = {
      email: order.customer_email,
      phone: order.customer_phone,
      name: order.customer_name,
    };

    try {
      const { checkoutUrl } = await createPaymentLink({
        quote,
        customer,
        orderId: String(order.id),
        checkoutOptions: {
          quoteShipping: true,
          askForShippingAddress: false,
        },
      });

      const emailed = await sendManualOrderPaymentLinkEmail({
        customerEmail: order.customer_email,
        customerName: order.customer_name,
        orderRef: order.order_ref,
        totalFormatted: quote.totalFormatted,
        checkoutUrl,
        quote,
        shippingAddress: shipAddr,
      });

      if (!emailed) {
        if (claimed) {
          await releaseDiscountCodeForOrder(order.id);
        }
        res.status(200).json({
          ok: true,
          checkoutUrl,
          emailed: false,
          warning:
            "Payment link was created but the email could not be sent. Configure RESEND_API_KEY and RESEND_FROM, or share the link manually.",
        });
        return;
      }

      await updateOrderPaymentLinkSent(order.id, checkoutUrl);

      res.status(200).json({ ok: true, checkoutUrl, emailed: true });
    } catch (err) {
      if (claimed) {
        await releaseDiscountCodeForOrder(order.id);
      }
      throw err;
    }
  } catch (error) {
    console.error(error);
    res.status(error.statusCode || 500).json({
      error: error.message || "Could not send payment link.",
      ...checkoutFlowErrorJsonFields(error),
    });
  }
}
