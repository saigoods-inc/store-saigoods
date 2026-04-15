import { isShippoConfigured, validateAddressWithShippo } from "./shippo.js";

function addressValidationEnabled() {
  const v = process.env.ADDRESS_VALIDATION;
  if (v == null || String(v).trim() === "") {
    return true;
  }
  const s = String(v).trim().toLowerCase();
  return s !== "off" && s !== "false" && s !== "0";
}

/** Residential surcharge only when Shippo explicitly reports `is_residential: true`. */
function computeApplyResidentialSurcharge(isResidential) {
  return isResidential === true;
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
 * Local checks + Shippo validation when enabled and token is set.
 * On Shippo transport/parse errors: fail open on validity; no residential surcharge unless Shippo says residential.
 * @param {{ line1?: string, line2?: string, city?: string, state?: string, postalCode?: string, country?: string }} addr
 * @returns {Promise<{
 *   ok: boolean,
 *   error?: string,
 *   warning?: string,
 *   addressValidation?: { code: string, messages: string[] },
 *   shippingContext: { applyResidentialSurcharge: boolean, shippoUnavailable: boolean },
 *   normalizedAddress?: object | null,
 * }>}
 */
export async function validateShippingAddressForCheckout(addr) {
  const local = validateLocalUsAddressShape(addr);
  if (!local.ok) {
    return { ok: false, error: local.error, shippingContext: { applyResidentialSurcharge: false, shippoUnavailable: false } };
  }

  if (!addressValidationEnabled()) {
    return {
      ok: true,
      shippingContext: { applyResidentialSurcharge: false, shippoUnavailable: true },
      normalizedAddress: null,
    };
  }

  if (!isShippoConfigured()) {
    return {
      ok: true,
      warning:
        "Shippo is not configured (SHIPPO_API_TOKEN). Address is accepted; residential surcharge applies only when Shippo confirms a residential delivery point.",
      shippingContext: { applyResidentialSurcharge: false, shippoUnavailable: true },
      normalizedAddress: null,
    };
  }

  const sm = await validateAddressWithShippo(addr);

  if (!sm.isValid) {
    const messages =
      sm.messages.length > 0
        ? sm.messages
        : ["We could not verify that shipping address. Please check the street, city, state, and ZIP."];
    return {
      ok: false,
      error: messages[0],
      addressValidation: { code: "invalid", messages },
      shippingContext: { applyResidentialSurcharge: false, shippoUnavailable: false },
      normalizedAddress: sm.normalizedAddress || null,
    };
  }

  const shippoUnavailable = Boolean(sm.shippoUnavailable || sm.shippoSkipped);
  const apply = computeApplyResidentialSurcharge(sm.isResidential);

  let warning;
  if (shippoUnavailable) {
    warning =
      "Address checker did not return a full validation result; residential surcharge was not applied.";
  }

  return {
    ok: true,
    ...(warning ? { warning } : {}),
    shippingContext: {
      applyResidentialSurcharge: apply,
      shippoUnavailable,
    },
    normalizedAddress: sm.normalizedAddress || null,
  };
}
