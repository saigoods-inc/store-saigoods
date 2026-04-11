import { buildFullCheckoutQuote } from "./checkout-totals.js";
import { sendResendOrderConfirmation, isResendCustomerEmailEnabled } from "./resend-order-confirmation.js";

function formatCurrency(cents) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format((Number(cents) || 0) / 100);
}

export function quoteFromPaidOrderRow(order) {
  const items = Array.isArray(order.items) ? order.items : [];
  return {
    items,
    subtotalCents: Math.max(0, Number(order.subtotal_cents) || 0),
    subtotalFormatted: formatCurrency(order.subtotal_cents),
    shippingCents: Math.max(0, Number(order.shipping_cents) || 0),
    shippingFormatted: formatCurrency(order.shipping_cents),
    taxCents: Math.max(0, Number(order.tax_cents) || 0),
    taxFormatted: formatCurrency(order.tax_cents),
    totalCents: Math.max(0, Number(order.total_cents) || 0),
    totalFormatted: formatCurrency(order.total_cents),
  };
}

/**
 * Rebuild quote line items + discount display where possible; totals always match the paid order row.
 * @param {object} order — DB row (snake_case)
 */
export async function buildQuoteForReceiptEmail(order) {
  const items = Array.isArray(order.items) ? order.items : [];
  const addr = order.shipping_address && typeof order.shipping_address === "object" ? order.shipping_address : null;
  const pricingTier = order.is_hardin_discount === true ? "hardin" : "standard";

  if (addr && String(addr.postalCode || "").trim()) {
    try {
      const quote = await buildFullCheckoutQuote(items, addr, { pricingTier });
      return {
        ...quote,
        subtotalCents: Math.max(0, Number(order.subtotal_cents) || 0),
        subtotalFormatted: formatCurrency(order.subtotal_cents),
        shippingCents: Math.max(0, Number(order.shipping_cents) || 0),
        shippingFormatted: formatCurrency(order.shipping_cents),
        taxCents: Math.max(0, Number(order.tax_cents) || 0),
        taxFormatted: formatCurrency(order.tax_cents),
        totalCents: Math.max(0, Number(order.total_cents) || 0),
        totalFormatted: formatCurrency(order.total_cents),
      };
    } catch (err) {
      console.error("[receipt] buildFullCheckoutQuote:", err);
      return quoteFromPaidOrderRow(order);
    }
  }
  return quoteFromPaidOrderRow(order);
}

/**
 * Sends the branded Resend receipt when configured and the row has a customer email + line items.
 * @returns {Promise<{ sent: boolean, reason?: string }>}
 */
export async function sendPaidOrderReceiptResendIfConfigured(order) {
  if (!isResendCustomerEmailEnabled()) {
    return { sent: false, reason: "resend_disabled" };
  }
  const email = order?.customer_email != null ? String(order.customer_email).trim() : "";
  if (!email) {
    return { sent: false, reason: "no_email" };
  }
  const items = Array.isArray(order.items) ? order.items : [];
  if (!items.length) {
    return { sent: false, reason: "no_items" };
  }

  try {
    const quoteForEmail = await buildQuoteForReceiptEmail(order);
    await sendResendOrderConfirmation({
      pending: {
        id: order.id,
        order_ref: order.order_ref,
        created_at: order.created_at,
        customer_address: order.customer_address,
        shipping_address: order.shipping_address,
      },
      quote: quoteForEmail,
      customerEmail: email,
      customerName: order.customer_name,
    });
    return { sent: true };
  } catch (err) {
    console.error("[receipt] sendPaidOrderReceiptResendIfConfigured:", err);
    return { sent: false, reason: "error", message: err?.message };
  }
}
