/**
 * Shared validation for embedded Square Web Payments checkout.
 */

import {
  isStrictUsZip,
  validateLocalUsAddressShape,
  ZIP_ERROR_MSG,
} from "./address-validation.js";

export function parseCheckoutPayBody(body) {
  const items = Array.isArray(body?.items) ? body.items : [];
  if (!items.length) {
    return { error: "Your cart is empty." };
  }

  const addr = body?.address;
  if (!addr || typeof addr !== "object") {
    return { error: "Shipping address is required." };
  }

  const line1 = String(addr.line1 || "").trim();
  const city = String(addr.city || "").trim();
  const state = String(addr.state || "").trim().toUpperCase();
  const postalCode = String(addr.postalCode || "").trim();
  const line2 = String(addr.line2 || "").trim();
  const country = String(addr.country || "US").trim().toUpperCase() || "US";

  const address = {
    line1,
    line2: line2 || undefined,
    city,
    state,
    postalCode,
    country,
  };

  const shape = validateLocalUsAddressShape(address);
  if (!shape.ok) {
    return { error: shape.error, fieldErrors: shape.fieldErrors || {} };
  }

  const email = String(body?.email || "").trim();
  if (!email || !email.includes("@")) {
    return { error: "A valid email is required." };
  }

  const phone = String(body?.phone || "").trim();
  if (!phone) {
    return { error: "Phone number is required." };
  }
  const phoneDigits = phone.replace(/\D/g, "");
  if (phoneDigits.length < 10) {
    return { error: "Enter a valid phone number (at least 10 digits)." };
  }

  const sourceId = String(body?.sourceId || "").trim();
  if (!sourceId) {
    return { error: "Card details are incomplete. Check the card fields." };
  }

  const discountRaw = String(body?.discountCode ?? "").trim();
  if (discountRaw.length > 32) {
    return { error: "Discount code is too long." };
  }

  return {
    items,
    address,
    email,
    phone,
    name: String(body?.name || "").trim() || null,
    sourceId,
    discountCode: discountRaw || null,
  };
}

/**
 * For POST /api/checkout-estimate — allows partial address (first paint) until all fields are filled.
 * When complete, applies strict ZIP + same shape rules as pay (Shippo runs in estimate logic).
 */
export function parseEstimateAddressBody(body) {
  const addr = body?.address;
  if (!addr || typeof addr !== "object") {
    return { address: {}, partial: true };
  }

  const line1 = String(addr.line1 || "").trim();
  const city = String(addr.city || "").trim();
  const state = String(addr.state || "").trim().toUpperCase();
  const postalCode = String(addr.postalCode || "").trim();
  const line2 = String(addr.line2 || "").trim();
  const country = String(addr.country || "US").trim().toUpperCase() || "US";

  const address = {
    line1,
    line2: line2 || undefined,
    city,
    state,
    postalCode,
    country,
  };

  const zipDigits = postalCode.replace(/\D/g, "");
  const coreFilled = line1.length > 0 && city.length > 0 && /^[A-Z]{2}$/.test(state) && country === "US";

  if (coreFilled && zipDigits.length > 0 && !isStrictUsZip(postalCode)) {
    return {
      address,
      partial: false,
      error: ZIP_ERROR_MSG,
      fieldErrors: { postalCode: ZIP_ERROR_MSG },
    };
  }

  const complete = coreFilled && isStrictUsZip(postalCode);

  if (!complete) {
    return { address, partial: true };
  }

  const shape = validateLocalUsAddressShape(address);
  if (!shape.ok) {
    return {
      address,
      partial: false,
      error: shape.error,
      fieldErrors: shape.fieldErrors || {},
    };
  }

  return { address, partial: false };
}
