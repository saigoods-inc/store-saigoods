import { formatShippingAddressForOrder } from "../lib/checkout-totals.js";
import { computeCheckoutEstimate } from "../lib/checkout-estimate-logic.js";
import { createManualOrderDraft } from "../lib/orders.js";
import { assertReportsAuthorized } from "../lib/reports-auth.js";
import { normalizeDiscountCode } from "../lib/discount-codes.js";

function parseCreateBody(body) {
  const name = String(body?.name || "").trim();
  const email = String(body?.email || "").trim();
  const phone = String(body?.phone || "").trim();
  const addr = body?.address;
  if (!name) {
    return { error: "Customer name is required." };
  }
  if (!email || !email.includes("@")) {
    return { error: "A valid email is required." };
  }
  const phoneDigits = phone.replace(/\D/g, "");
  if (phoneDigits.length < 10) {
    return { error: "Enter a valid phone number (at least 10 digits)." };
  }
  if (!addr || typeof addr !== "object") {
    return { error: "Shipping address is required." };
  }
  const items = Array.isArray(body?.items) ? body.items : [];
  if (!items.length) {
    return { error: "Add at least one line item." };
  }
  const discountRaw = String(body?.discountCode ?? "").trim();
  if (discountRaw.length > 32) {
    return { error: "Discount code is too long." };
  }
  return {
    name,
    email,
    phone,
    address: {
      line1: String(addr.line1 || "").trim(),
      line2: String(addr.line2 || "").trim(),
      city: String(addr.city || "").trim(),
      state: String(addr.state || "").trim().toUpperCase(),
      postalCode: String(addr.postalCode || "").trim(),
      country: String(addr.country || "US").trim().toUpperCase() || "US",
    },
    items,
    discountCode: discountRaw,
  };
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed." });
    return;
  }

  try {
    await assertReportsAuthorized(req);
    const parsed = parseCreateBody(req.body || {});
    if (parsed.error) {
      res.status(400).json({ error: parsed.error });
      return;
    }

    const estimateBody = {
      items: parsed.items,
      address: parsed.address,
      discountCode: parsed.discountCode,
    };

    const quote = await computeCheckoutEstimate(estimateBody, { requireCompleteAddress: true });

    const normalizedCode = parsed.discountCode ? normalizeDiscountCode(parsed.discountCode) : null;
    const hardinDiscount =
      quote.hardinDiscountApplied && normalizedCode ? { applied: true, code: normalizedCode } : null;

    const customer = {
      name: parsed.name,
      email: parsed.email,
      phone: parsed.phone,
      address: formatShippingAddressForOrder(parsed.address),
      shippingState: parsed.address.state,
    };

    const order = await createManualOrderDraft({
      quote,
      customer,
      hardinDiscount,
      shippingAddress: parsed.address,
    });

    res.status(200).json({
      orderId: order.id,
      orderRef: order.order_ref,
      totalFormatted: quote.totalFormatted,
      order_status: order.order_status,
    });
  } catch (error) {
    console.error(error);
    res.status(error.statusCode || 500).json({ error: error.message || "Could not create order." });
  }
}
