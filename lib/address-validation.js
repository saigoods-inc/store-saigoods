import { isShippoConfigured, validateAddressWithShippo } from "./shippo.js";

/** Exact US ZIP: 5 digits or ZIP+4 (no partial 4-digit, no stray digits). */
export const ZIP_ERROR_MSG = "Please enter a valid ZIP code";

/** Shippo rejected or could not verify the deliverable address. */
export const SHIPPING_ADDRESS_ERROR_MSG = "Please enter a valid shipping address";

export function isStrictUsZip(postalCode) {
  const z = String(postalCode ?? "")
    .trim()
    .replace(/\s/g, "");
  return /^\d{5}$/.test(z) || /^\d{5}-\d{4}$/.test(z);
}

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
 * Compare submitted vs Shippo-normalized (loose) to suggest corrections in UI.
 * @param {object} submitted
 * @param {object} normalized
 */
export function submittedAddressDiffersFromNormalized(submitted, normalized) {
  if (!submitted || !normalized || typeof normalized !== "object") {
    return false;
  }
  const zip5 = (s) => String(s || "").replace(/\D/g, "").slice(0, 5);
  const line = (s) => String(s || "").replace(/\s+/g, " ").trim().toLowerCase();
  return (
    line(submitted.line1) !== line(normalized.line1) ||
    line(submitted.city) !== line(normalized.city) ||
    String(submitted.state || "")
      .toUpperCase()
      .slice(0, 2) !== String(normalized.state || "").toUpperCase().slice(0, 2) ||
    zip5(submitted.postalCode) !== zip5(normalized.postalCode)
  );
}

/**
 * Format + strict US checks (always run before Shippo).
 * @param {{ line1?: string, line2?: string, city?: string, state?: string, postalCode?: string, country?: string }} addr
 * @returns {{ ok: boolean, error?: string, fieldErrors?: Record<string, string> }}
 */
export function validateLocalUsAddressShape(addr) {
  const line1 = String(addr?.line1 || "").trim();
  const city = String(addr?.city || "").trim();
  const state = String(addr?.state || "").trim().toUpperCase();
  const postalCode = String(addr?.postalCode || "").trim();
  const country = String(addr?.country || "US").trim().toUpperCase() || "US";

  if (!line1) {
    return {
      ok: false,
      error: "Street address is required.",
      fieldErrors: { line1: "Street address is required." },
    };
  }
  if (line1.length < 4) {
    return {
      ok: false,
      error: "Please enter a complete street address.",
      fieldErrors: { line1: "Please enter a complete street address." },
    };
  }
  if (!city) {
    return { ok: false, error: "City is required.", fieldErrors: { city: "City is required." } };
  }
  if (city.length < 2 || !/[a-zA-Z]/.test(city)) {
    return {
      ok: false,
      error: "Please enter a valid city name.",
      fieldErrors: { city: "Please enter a valid city name." },
    };
  }
  if (!/^[A-Z]{2}$/.test(state)) {
    return {
      ok: false,
      error: "State must be a 2-letter code.",
      fieldErrors: { state: "State must be a 2-letter code." },
    };
  }
  if (!postalCode) {
    return { ok: false, error: ZIP_ERROR_MSG, fieldErrors: { postalCode: ZIP_ERROR_MSG } };
  }
  if (!isStrictUsZip(postalCode)) {
    return { ok: false, error: ZIP_ERROR_MSG, fieldErrors: { postalCode: ZIP_ERROR_MSG } };
  }
  if (country !== "US") {
    return {
      ok: false,
      error: "Only US shipping is supported.",
      fieldErrors: { state: "Only US shipping is supported." },
    };
  }

  return { ok: true };
}

const ADDRESS_FIELD_KEYS = ["line1", "city", "state", "postalCode"];

function fieldErrorsForInvalidShippo() {
  /** Same message on core fields so inline + highlight works. */
  const o = {};
  for (const k of ADDRESS_FIELD_KEYS) {
    o[k] = SHIPPING_ADDRESS_ERROR_MSG;
  }
  return o;
}

/**
 * Local checks + Shippo validation when enabled and token is set.
 * @param {{ line1?: string, line2?: string, city?: string, state?: string, postalCode?: string, country?: string }} addr
 * @param {{ strictShippo?: boolean }} [opts] strictShippo false = staff/admin tools without Shippo token (default true).
 * @returns {Promise<{
 *   ok: boolean,
 *   error?: string,
 *   warning?: string,
 *   addressValidation?: { code: string, messages: string[] },
 *   fieldErrors?: Record<string, string>,
 *   shippingContext: { applyResidentialSurcharge: boolean, shippoUnavailable: boolean },
 *   normalizedAddress?: object | null,
 *   addressSuggestion?: object | null,
 * }>}
 */
export async function validateShippingAddressForCheckout(addr, opts = {}) {
  const local = validateLocalUsAddressShape(addr);
  if (!local.ok) {
    return {
      ok: false,
      error: local.error,
      fieldErrors: local.fieldErrors || {},
      shippingContext: { applyResidentialSurcharge: false, shippoUnavailable: false },
    };
  }

  if (!addressValidationEnabled()) {
    return {
      ok: true,
      shippingContext: { applyResidentialSurcharge: false, shippoUnavailable: true },
      normalizedAddress: null,
      addressSuggestion: null,
    };
  }

  const strictShippo = opts.strictShippo !== false;

  if (!isShippoConfigured()) {
    if (!strictShippo) {
      return {
        ok: true,
        warning:
          "Shippo is not configured; this staff estimate used local address checks only (no USPS/Shippo verification).",
        shippingContext: { applyResidentialSurcharge: false, shippoUnavailable: true },
        normalizedAddress: null,
        addressSuggestion: null,
      };
    }
    return {
      ok: false,
      error:
        "Shipping address verification is not configured on the server. Add SHIPPO_API_TOKEN or set ADDRESS_VALIDATION=off for local development.",
      fieldErrors: {},
      shippingContext: { applyResidentialSurcharge: false, shippoUnavailable: true },
      normalizedAddress: null,
      addressSuggestion: null,
    };
  }

  const sm = await validateAddressWithShippo(addr);

  if (!sm.isValid) {
    const unavailable = Boolean(sm.shippoUnavailable);
    const messages =
      sm.messages.length > 0
        ? sm.messages
        : unavailable
          ? ["Address verification is temporarily unavailable. Please try again."]
          : [SHIPPING_ADDRESS_ERROR_MSG];
    return {
      ok: false,
      error: unavailable
        ? "Address verification is temporarily unavailable. Please try again."
        : SHIPPING_ADDRESS_ERROR_MSG,
      addressValidation: { code: unavailable ? "unavailable" : "invalid", messages },
      fieldErrors: unavailable ? {} : fieldErrorsForInvalidShippo(),
      shippingContext: { applyResidentialSurcharge: false, shippoUnavailable: unavailable },
      normalizedAddress: sm.normalizedAddress || null,
      addressSuggestion: null,
    };
  }

  const shippoUnavailable = Boolean(sm.shippoUnavailable);
  const apply = computeApplyResidentialSurcharge(sm.isResidential);

  let warning;
  if (shippoUnavailable) {
    warning =
      "Address checker did not return a full validation result; residential surcharge was not applied.";
  }

  const normalizedAddress = sm.normalizedAddress || null;
  const addressSuggestion =
    normalizedAddress && submittedAddressDiffersFromNormalized(addr, normalizedAddress)
      ? normalizedAddress
      : null;

  return {
    ok: true,
    ...(warning ? { warning } : {}),
    shippingContext: {
      applyResidentialSurcharge: apply,
      shippoUnavailable,
    },
    normalizedAddress,
    addressSuggestion,
  };
}
