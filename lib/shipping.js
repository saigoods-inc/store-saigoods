/**
 * US ZIP helpers for Hardin County eligibility and customer address parsing.
 * Legacy UPS zone + per-product rates live in `shipping-zone-legacy.js` (not used in checkout).
 */

/** First 5 digits of a US ZIP, or null if not enough digits. */
export function normalizeUsZip(input) {
  if (input == null) {
    return null;
  }

  const digits = String(input).replace(/\D/g, "");
  if (digits.length < 5) {
    return null;
  }

  return digits.slice(0, 5);
}

/** Pull 5-digit ZIP from a free-text address (ZIP+4 supported). */
export function extractZipFromText(text) {
  if (text == null || typeof text !== "string") {
    return null;
  }

  const m = text.match(/\b(\d{5})(?:-\d{4})?\b/);
  return m ? m[1] : null;
}

export function resolveShippingZip(customer) {
  if (!customer || typeof customer !== "object") {
    return null;
  }

  return (
    normalizeUsZip(customer.zipCode) ||
    normalizeUsZip(customer.zip) ||
    extractZipFromText(customer.address)
  );
}
