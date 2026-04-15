import { formatShippingAddressForOrder } from "../lib/checkout-totals.js";
import { computeCheckoutEstimate } from "../lib/checkout-estimate-logic.js";
import { updateWalkInOrderDraft } from "../lib/orders.js";
import { assertReportsAuthorized } from "../lib/reports-auth.js";
import { WALK_IN_PICKUP_ADDRESS } from "../lib/walk-in-pickup.js";

function parseBody(body) {
  const orderId = String(body?.orderId ?? "").trim();
  if (!orderId) {
    return { error: "orderId is required." };
  }
  const name = String(body?.name || "").trim();
  const email = String(body?.email || "").trim();
  const phone = String(body?.phone || "").trim();
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
  const items = Array.isArray(body?.items) ? body.items : [];
  if (!items.length) {
    return { error: "Add at least one line item." };
  }
  const applyEligibleLocalDiscount = body?.applyEligibleLocalDiscount === true;
  return {
    orderId,
    name,
    email: email ? email : null,
    phone: phone ? phone : null,
    items,
    applyEligibleLocalDiscount,
  };
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed." });
    return;
  }

  try {
    await assertReportsAuthorized(req);
    const parsed = parseBody(req.body || {});
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
      address: formatShippingAddressForOrder(WALK_IN_PICKUP_ADDRESS),
      shippingState: WALK_IN_PICKUP_ADDRESS.state,
    };

    const order = await updateWalkInOrderDraft(parsed.orderId, {
      quote,
      customer,
      hardinDiscount,
      shippingAddress: WALK_IN_PICKUP_ADDRESS,
    });

    res.status(200).json({
      orderId: order.id,
      orderRef: order.order_ref,
      totalFormatted: quote.totalFormatted,
      order_status: order.order_status,
    });
  } catch (error) {
    console.error(error);
    res.status(error.statusCode || 500).json({ error: error.message || "Could not update draft." });
  }
}
