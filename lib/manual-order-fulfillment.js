import { isHardinCountyTnDelivery } from "./hardin-county.js";

/**
 * Manual (staff) order: fulfillment and payment mode.
 * Drives `orders.fulfillment_method`, `shipping_required`, `shippo_label_required`, and `payment_flow`
 * (future: quote, Shippo, and payment capture branch on these).
 */

export const MANUAL_FULFILLMENT_CARRIER = "carrier";
export const MANUAL_FULFILLMENT_LOCAL = "local_delivery";
export const MANUAL_FULFILLMENT_PICKUP = "pickup";

export const MANUAL_PAYMENT_SQUARE_LINK = "square_payment_link";
export const MANUAL_PAYMENT_PAY_LATER = "pay_later";

/** Stored on order rows for pickup when no live ship address is used. */
export const PICKUP_ADDRESS_FOR_ORDER = {
  line1: "In-store / pickup (see staff notes)",
  line2: "",
  city: "Savannah",
  state: "TN",
  postalCode: "38372",
  country: "US",
};

const ALLOWED_FULFILLMENT = new Set(["carrier", "local_delivery", "pickup"]);
const ALLOWED_PAYMENT = new Set(["square_payment_link", "pay_later"]);

export function normalizeFulfillmentMethod(raw) {
  const s = String(raw == null ? "carrier" : raw)
    .trim()
    .toLowerCase();
  if (s === "local") {
    return "local_delivery";
  }
  if (ALLOWED_FULFILLMENT.has(s)) {
    return s;
  }
  return "carrier";
}

export function normalizePaymentFlow(raw) {
  const s = String(raw == null ? "square_payment_link" : raw)
    .trim()
    .toLowerCase();
  if (s === "pay-later" || s === "pay_later") {
    return "pay_later";
  }
  if (s === "square" || s === "link" || s === "square_link") {
    return "square_payment_link";
  }
  if (ALLOWED_PAYMENT.has(s)) {
    return s;
  }
  return "square_payment_link";
}

/**
 * @returns {{ fulfillment_method: string, shipping_required: boolean, shippo_label_required: boolean }}
 */
export function lifecycleForFulfillment(fulfillmentMethod) {
  const f = normalizeFulfillmentMethod(fulfillmentMethod);
  if (f === "carrier") {
    return {
      fulfillment_method: "carrier",
      shipping_required: true,
      shippo_label_required: true,
    };
  }
  if (f === "local_delivery") {
    return {
      fulfillment_method: "local_delivery",
      shipping_required: false,
      shippo_label_required: false,
    };
  }
  if (f === "pickup") {
    return {
      fulfillment_method: "pickup",
      shipping_required: false,
      shippo_label_required: false,
    };
  }
  return {
    fulfillment_method: "carrier",
    shipping_required: true,
    shippo_label_required: true,
  };
}

/** @deprecated use lifecycleForFulfillment("carrier") */
export function defaultManualOrderLifecycleFields() {
  return lifecycleForFulfillment("carrier");
}

/** Default tax / quote place when no delivery address is provided yet. */
export function localDeliveryFallbackAddress() {
  return {
    line1: "Local delivery (address to be confirmed)",
    line2: "",
    city: "Savannah",
    state: "TN",
    postalCode: "38372",
    country: "US",
  };
}

export function hasAnyAddressFields(a) {
  if (!a || typeof a !== "object") {
    return false;
  }
  return Boolean(
    String(a.line1 || "").trim() ||
      String(a.line2 || "").trim() ||
      String(a.city || "").trim() ||
      String(a.state || "").trim() ||
      String(a.postalCode || "").trim(),
  );
}

export function buildLocalOrCarrierAddressForQuote(addrIn) {
  if (!addrIn || typeof addrIn !== "object") {
    return localDeliveryFallbackAddress();
  }
  const postalCode = String(addrIn.postalCode || "").trim();
  const zip5 = postalCode.replace(/\D/g, "").slice(0, 5);
  const rawState = String(addrIn.state || "").trim().toUpperCase().slice(0, 2);
  // Do not invent TN for blank state + non-local ZIP (e.g. FL 33774).
  // Only default TN when ZIP is already in the approved Hardin/local service area.
  let state = rawState;
  if (!state) {
    state = zip5.length === 5 && isHardinCountyTnDelivery({ state: "TN", postalCode: zip5 }) ? "TN" : "";
  }
  const city = String(addrIn.city || "").trim() || (state === "TN" && zip5 === "38372" ? "Savannah" : "");
  return {
    line1: String(addrIn.line1 || "").trim() || "Local delivery",
    line2: String(addrIn.line2 || "").trim(),
    city,
    state,
    postalCode,
    country: (String(addrIn.country || "US").trim() || "US").toUpperCase().slice(0, 2) || "US",
  };
}
