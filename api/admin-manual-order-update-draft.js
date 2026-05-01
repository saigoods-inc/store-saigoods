import { formatShippingAddressForOrder } from "../lib/checkout-totals.js";
import { computeCheckoutEstimate, checkoutFlowErrorJsonFields } from "../lib/checkout-estimate-logic.js";
import { isHardinCountyTnDelivery } from "../lib/hardin-county.js";
import {
  PICKUP_ADDRESS_FOR_ORDER,
  buildLocalOrCarrierAddressForQuote,
  hasAnyAddressFields,
  normalizeFulfillmentMethod,
  normalizePaymentFlow,
} from "../lib/manual-order-fulfillment.js";
import { updateManualOrderDraft } from "../lib/orders.js";
import { assertReportsAuthorized } from "../lib/reports-auth.js";

function parseOptionalYmd(input) {
  if (input === null || input === undefined || input === "") {
    return { ok: true, value: null };
  }
  const s = String(input).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return { ok: false, error: "Expected ship date must be YYYY-MM-DD." };
  }
  const [y, mo, d] = s.split("-").map((x) => Number(x));
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) {
    return { ok: false, error: "Expected ship date is invalid." };
  }
  return { ok: true, value: s };
}

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
  if (!email || !email.includes("@")) {
    return { error: "A valid email is required." };
  }
  const phoneDigits = phone.replace(/\D/g, "");
  if (phone && phoneDigits.length < 10) {
    return { error: "Enter a valid phone number (at least 10 digits)." };
  }
  const normalizedPhone = phone ? phoneDigits : "";
  const shipmentDateParsed = parseOptionalYmd(body?.shipmentDate);
  if (!shipmentDateParsed.ok) {
    return { error: shipmentDateParsed.error };
  }
  const items = Array.isArray(body?.items) ? body.items : [];
  if (!items.length) {
    return { error: "Add at least one line item." };
  }
  const applyEligibleLocalDiscount = body?.applyEligibleLocalDiscount === true;
  const adminLocalDiscountOverride = applyEligibleLocalDiscount && body?.adminLocalDiscountOverride === true;
  const fulfillmentMethod = normalizeFulfillmentMethod(body?.fulfillmentMethod);
  const paymentFlow = normalizePaymentFlow(body?.paymentFlow);
  const addr = body?.address;
  if (fulfillmentMethod === "carrier") {
    if (!addr || typeof addr !== "object") {
      return { error: "Shipping address is required for ship-with-carrier." };
    }
    const line1 = String(addr.line1 || "").trim();
    const city = String(addr.city || "").trim();
    const st = String(addr.state || "").trim();
    const zip = String(addr.postalCode || "").trim();
    if (!line1 || !city || !st || !zip) {
      return { error: "Please enter a full shipping address (street, city, state, ZIP) for carrier shipping." };
    }
  }

  let address;
  if (fulfillmentMethod === "carrier") {
    address = {
      line1: String(addr.line1 || "").trim(),
      line2: String(addr.line2 || "").trim(),
      city: String(addr.city || "").trim(),
      state: String(addr.state || "").trim().toUpperCase(),
      postalCode: String(addr.postalCode || "").trim(),
      country: String(addr.country || "US").trim().toUpperCase() || "US",
    };
  } else if (fulfillmentMethod === "pickup") {
    address = { ...PICKUP_ADDRESS_FOR_ORDER };
  } else {
    address = addr && typeof addr === "object" && hasAnyAddressFields(addr)
      ? buildLocalOrCarrierAddressForQuote(addr)
      : buildLocalOrCarrierAddressForQuote({
          line1: "Local delivery (address to be confirmed)",
          city: "Savannah",
          state: "TN",
          postalCode: "38372",
          country: "US",
        });
  }

  const localDeliveryNote =
    fulfillmentMethod === "local_delivery" ? String(body?.localDeliveryNote || "").trim() : "";

  return {
    orderId,
    name,
    email,
    phone: normalizedPhone,
    shipmentDate: shipmentDateParsed.value,
    address,
    localDeliveryNote,
    items,
    applyEligibleLocalDiscount,
    adminLocalDiscountOverride,
    fulfillmentMethod,
    paymentFlow,
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

    const rawBody = req.body || {};
    const rateId = String(rawBody.selectedShippingRateObjectId || "").trim();
    const estimateBody = {
      items: parsed.items,
      address: parsed.address,
      applyEligibleLocalDiscount: parsed.applyEligibleLocalDiscount,
      forceApplyEligibleLocalDiscount: parsed.adminLocalDiscountOverride,
      fulfillmentMethod: parsed.fulfillmentMethod,
      ...(rawBody.forceStockOverride === true ? { forceStockOverride: true } : {}),
      ...(rateId ? { selectedShippingRateObjectId: rateId } : {}),
      ...(String(rawBody.selectedShippingServiceCode || "").trim()
        ? { selectedShippingServiceCode: String(rawBody.selectedShippingServiceCode).trim() }
        : {}),
      ...(String(rawBody.selectedShippingServiceLabel || "").trim()
        ? { selectedShippingServiceLabel: String(rawBody.selectedShippingServiceLabel).trim() }
        : {}),
      ...(String(rawBody.selectedShippingProvider || "").trim()
        ? { selectedShippingProvider: String(rawBody.selectedShippingProvider).trim() }
        : {}),
      ...(rawBody.selectedShippingAmountCents != null && Number.isFinite(Number(rawBody.selectedShippingAmountCents))
        ? { selectedShippingAmountCents: Math.max(0, Math.round(Number(rawBody.selectedShippingAmountCents))) }
        : {}),
      ...(rawBody.selectedShippingParcelCount != null && Number.isFinite(Number(rawBody.selectedShippingParcelCount))
        ? { selectedShippingParcelCount: Math.max(0, Math.floor(Number(rawBody.selectedShippingParcelCount))) }
        : {}),
      ...(rawBody.selectedShippingResidentialSurchargeCents != null &&
      Number.isFinite(Number(rawBody.selectedShippingResidentialSurchargeCents))
        ? {
            selectedShippingResidentialSurchargeCents: Math.max(
              0,
              Math.round(Number(rawBody.selectedShippingResidentialSurchargeCents)),
            ),
          }
        : {}),
    };

    const isCarrier = parsed.fulfillmentMethod === "carrier";
    const quote = await computeCheckoutEstimate(estimateBody, {
      requireCompleteAddress: isCarrier,
      adminLocalDiscount: true,
      strictShippo: isCarrier,
      allowForceStockOverride: true,
    });

    const zipOk = isHardinCountyTnDelivery(parsed.address);
    const hardinDiscount =
      quote.hardinDiscountApplied === true
        ? {
            applied: true,
            code: null,
            adminAddressVerified: zipOk,
            adminOverride: quote.adminLocalDiscountForced === true,
          }
        : null;

    let addrText = formatShippingAddressForOrder(parsed.address);
    if (parsed.fulfillmentMethod === "local_delivery" && parsed.localDeliveryNote) {
      addrText = [addrText, `Delivery note: ${parsed.localDeliveryNote}`].filter(Boolean).join("\n\n");
    }
    const customer = {
      name: parsed.name,
      email: parsed.email,
      phone: parsed.phone,
      address: addrText,
      shippingState: parsed.address.state,
    };

    const order = await updateManualOrderDraft(
      parsed.orderId,
      {
        quote,
        customer,
        hardinDiscount,
        shippingAddress: parsed.address,
      },
      {
        fulfillmentMethod: parsed.fulfillmentMethod,
        paymentFlow: parsed.paymentFlow,
        shipmentDate: parsed.shipmentDate,
      },
    );

    res.status(200).json({
      orderId: order.id,
      orderRef: order.order_ref,
      totalFormatted: quote.totalFormatted,
      order_status: order.order_status,
    });
  } catch (error) {
    console.error(error);
    res.status(error.statusCode || 500).json({
      error: error.message || "Could not update draft.",
      ...checkoutFlowErrorJsonFields(error),
    });
  }
}
