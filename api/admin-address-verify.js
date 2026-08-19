import { validateShippingAddressForCheckout } from "../lib/address-validation.js";
import { assertReportsAuthorized } from "../lib/reports-auth.js";

function normalizeAddress(value) {
  const address = value && typeof value === "object" ? value : {};
  return {
    line1: String(address.line1 || "").trim(),
    line2: String(address.line2 || "").trim(),
    city: String(address.city || "").trim(),
    state: String(address.state || "").trim().toUpperCase().slice(0, 2),
    postalCode: String(address.postalCode || "").trim(),
    country: String(address.country || "US").trim().toUpperCase() || "US",
  };
}

function mapFieldErrors(fieldErrors) {
  const input = fieldErrors && typeof fieldErrors === "object" ? fieldErrors : {};
  const result = {};
  if (input.line1) result.addressLine1 = String(input.line1);
  if (input.city) result.addressCity = String(input.city);
  if (input.state) result.addressState = String(input.state);
  if (input.postalCode) result.addressZip = String(input.postalCode);
  return result;
}

export async function verifyAdminAddress(address, options = {}) {
  const validateAddress = options.validateAddress || validateShippingAddressForCheckout;
  const submittedAddress = normalizeAddress(address);
  const result = await validateAddress(submittedAddress, {
    forceShippo: true,
    strictShippo: true,
  });
  const suggestion = result.addressSuggestion ? normalizeAddress(result.addressSuggestion) : null;
  const normalized = result.normalizedAddress ? normalizeAddress(result.normalizedAddress) : null;
  const verified = result.ok === true && !suggestion;

  return {
    verified,
    message:
      result.error ||
      result.warning ||
      (suggestion
        ? "We found a different deliverable address. Review it before getting carrier rates."
        : "Address verified. You can now get carrier rates."),
    normalizedAddress: normalized,
    addressSuggestion: suggestion,
    fieldErrors: mapFieldErrors(result.fieldErrors),
    addressValidation: result.addressValidation || null,
  };
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed." });
    return;
  }

  try {
    await assertReportsAuthorized(req);
    const result = await verifyAdminAddress(req.body?.address);
    res.status(200).json(result);
  } catch (error) {
    console.error(error);
    res.status(error.statusCode || 500).json({
      error: error.message || "Address verification failed.",
    });
  }
}
