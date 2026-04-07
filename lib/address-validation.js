import { verifySmartyUsAddress, isSmartyConfigured } from "./smarty-address.js";

function addressValidationEnabled() {
  const v = process.env.ADDRESS_VALIDATION;
  if (v == null || String(v).trim() === "") {
    return true;
  }
  const s = String(v).trim().toLowerCase();
  return s !== "off" && s !== "false" && s !== "0";
}

function failOpenOnSmartyError() {
  const v = process.env.ADDRESS_VALIDATION_FAIL_OPEN;
  if (v == null || String(v).trim() === "") {
    return true;
  }
  const s = String(v).trim().toLowerCase();
  return s === "true" || s === "1" || s === "yes" || s === "on";
}

/**
 * Format + plausibility checks (always run).
 * @param {{ line1?: string, line2?: string, city?: string, state?: string, postalCode?: string, country?: string }} addr
 */
export function validateLocalUsAddressShape(addr) {
  const line1 = String(addr?.line1 || "").trim();
  const city = String(addr?.city || "").trim();
  const state = String(addr?.state || "").trim().toUpperCase();
  const postalCode = String(addr?.postalCode || "").trim();
  const country = String(addr?.country || "US").trim().toUpperCase() || "US";

  if (!line1) {
    return { ok: false, error: "Street address is required." };
  }
  if (line1.length < 4) {
    return { ok: false, error: "Please enter a complete street address." };
  }
  if (!city) {
    return { ok: false, error: "City is required." };
  }
  if (city.length < 2 || !/[a-zA-Z]/.test(city)) {
    return { ok: false, error: "Please enter a valid city name." };
  }
  if (!/^[A-Z]{2}$/.test(state)) {
    return { ok: false, error: "State must be a 2-letter code." };
  }
  if (!postalCode) {
    return { ok: false, error: "ZIP code is required." };
  }
  const zipNorm = postalCode.replace(/\s/g, "");
  if (!/^\d{5}(-\d{4})?$/.test(zipNorm)) {
    return { ok: false, error: "ZIP must be 5 digits or ZIP+4 (e.g. 37211 or 37211-1234)." };
  }
  if (country !== "US") {
    return { ok: false, error: "Only US shipping is supported." };
  }

  return { ok: true };
}

/**
 * Local checks + optional Smarty USPS match (when credentials are set).
 * @param {{ line1?: string, line2?: string, city?: string, state?: string, postalCode?: string, country?: string }} addr
 */
export async function validateShippingAddressForCheckout(addr) {
  const local = validateLocalUsAddressShape(addr);
  if (!local.ok) {
    return { ok: false, error: local.error };
  }

  if (!addressValidationEnabled()) {
    return { ok: true };
  }

  if (!isSmartyConfigured()) {
    return { ok: true };
  }

  try {
    const sm = await verifySmartyUsAddress(addr);
    if (sm.ok) {
      return { ok: true };
    }
    if (sm.reason === "no_match" || sm.reason === "not_deliverable") {
      return {
        ok: false,
        error:
          "We could not verify that shipping address with the USPS database. Please check the street, city, state, and ZIP.",
      };
    }
    return { ok: true };
  } catch (err) {
    console.error("[address-validation]", err?.message || err);
    if (failOpenOnSmartyError()) {
      return { ok: true, warning: "Address could not be verified automatically; continuing." };
    }
    const e = new Error("Address verification is temporarily unavailable. Try again shortly.");
    e.statusCode = 503;
    throw e;
  }
}
