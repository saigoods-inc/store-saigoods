/**
 * Shared validation for embedded Square Web Payments checkout.
 */

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

  if (!line1) {
    return { error: "Street address is required." };
  }
  if (!city) {
    return { error: "City is required." };
  }
  if (!/^[A-Z]{2}$/.test(state)) {
    return { error: "State must be a 2-letter code." };
  }
  if (!postalCode) {
    return { error: "ZIP code is required." };
  }
  if (country !== "US") {
    return { error: "Only US shipping is supported." };
  }

  const email = String(body?.email || "").trim();
  if (!email || !email.includes("@")) {
    return { error: "A valid email is required." };
  }

  const sourceId = String(body?.sourceId || "").trim();
  if (!sourceId) {
    return { error: "Card details are incomplete. Check the card fields." };
  }

  return {
    items,
    address: { line1, line2: line2 || undefined, city, state, postalCode, country },
    email,
    phone: String(body?.phone || "").trim() || null,
    name: String(body?.name || "").trim() || null,
    sourceId,
  };
}
