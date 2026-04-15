import { isShippoConfigured, validateAddressWithShippo } from "./shippo.js";

function addressValidationEnabled() {
  const v = process.env.ADDRESS_VALIDATION;
  if (v == null || String(v).trim() === "") {
    return true;
  }
  const s = String(v).trim().toLowerCase();
  return s !== "off" && s !== "false" && s !== "0";
}

/** When `is_residential` is null or Shippo is unavailable: `residential` (default) = charge surcharge; `commercial` = do not. */
function unknownAddressPolicyIsResidential() {
  const p = String(process.env.CHECKOUT_UNKNOWN_ADDRESS_POLICY || "residential").trim().toLowerCase();
  return p !== "commercial";
}

/**
 * @param {boolean | null} isResidential
 * @param {boolean} shippoUnavailable
 */
function computeApplyResidentialSurcharge(isResidential, shippoUnavailable) {
  if (isResidential === true) {
    return { apply: true, treatAsUnknown: false };
  }
  if (isResidential === false) {
    return { apply: false, treatAsUnknown: false };
  }
  const residentialWhenUnknown = unknownAddressPolicyIsResidential();
  return { apply: residentialWhenUnknown, treatAsUnknown: true };
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
 * On Shippo transport/parse errors: fail open on validity, apply unknown-address policy for residential surcharge.
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
    const { apply } = computeApplyResidentialSurcharge(null, true);
    return {
      ok: true,
      shippingContext: { applyResidentialSurcharge: apply, shippoUnavailable: true },
      normalizedAddress: null,
    };
  }

  if (!isShippoConfigured()) {
    const { apply } = computeApplyResidentialSurcharge(null, true);
    return {
      ok: true,
      warning:
        "Shippo is not configured (SHIPPO_API_TOKEN). Residential surcharge follows CHECKOUT_UNKNOWN_ADDRESS_POLICY.",
      shippingContext: { applyResidentialSurcharge: apply, shippoUnavailable: true },
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
  const { apply, treatAsUnknown } = computeApplyResidentialSurcharge(sm.isResidential, shippoUnavailable);

  let warning;
  if (shippoUnavailable) {
    warning =
      "Address checker was unavailable; residential surcharge follows CHECKOUT_UNKNOWN_ADDRESS_POLICY.";
  } else if (treatAsUnknown && apply) {
    warning = "Residential vs commercial could not be determined; applying residential surcharge per site policy.";
  } else if (treatAsUnknown && !apply) {
    warning = "Residential vs commercial could not be determined; residential surcharge was not applied per site policy.";
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
