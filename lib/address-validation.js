import { isShippoConfigured, validateAddressWithShippo } from "./shippo.js";

/** Exact US ZIP: 5 digits or ZIP+4 (no partial 4-digit, no stray digits). */
export const ZIP_ERROR_MSG = "Please enter a valid ZIP code";

/** Shippo rejected or could not verify the deliverable address. */
export const SHIPPING_ADDRESS_ERROR_MSG = "Please enter a valid shipping address";

export const ADDRESS_CHECK_BANNER_MESSAGE = "Please check your shipping address.";

const STREET_FIELD_MSG = "Please enter a valid street address";
const CITY_FIELD_MSG = "Please enter a valid city";

/** API + UI shape: null means “no error for this field”. */
export function emptyAddressErrorsRecord() {
  return { street1: null, city: null, state: null, zip: null };
}

/**
 * Sparse form `fieldErrors` (line1 / city / state / postalCode) for legacy clients.
 * @param {Record<string, string | null | undefined>} addressErrors street1/city/state/zip
 * @returns {Record<string, string>}
 */
export function addressErrorsToFieldErrors(addressErrors) {
  if (!addressErrors || typeof addressErrors !== "object") {
    return {};
  }
  const fe = {};
  if (addressErrors.street1) {
    fe.line1 = String(addressErrors.street1).trim();
  }
  if (addressErrors.city) {
    fe.city = String(addressErrors.city).trim();
  }
  if (addressErrors.state) {
    fe.state = String(addressErrors.state).trim();
  }
  if (addressErrors.zip) {
    fe.postalCode = String(addressErrors.zip).trim();
  }
  return fe;
}

function lineNorm(s) {
  return String(s ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function zip5Only(z) {
  return String(z ?? "")
    .replace(/\D/g, "")
    .slice(0, 5);
}

/** Last-token street suffix expansion (safe positions only). */
const STREET_SUFFIX_TOKEN_MAP = {
  st: "street",
  street: "street",
  ave: "avenue",
  av: "avenue",
  avenue: "avenue",
  rd: "road",
  road: "road",
  dr: "drive",
  drive: "drive",
  ct: "court",
  court: "court",
  ln: "lane",
  lane: "lane",
  blvd: "boulevard",
  boulevard: "boulevard",
  pkwy: "parkway",
  parkway: "parkway",
  cir: "circle",
  circle: "circle",
  pl: "place",
  place: "place",
  way: "way",
  ter: "terrace",
  terrace: "terrace",
  cres: "crescent",
  crescent: "crescent",
  sq: "square",
  square: "square",
};

function stripHarmlessAddressPunctuation(s) {
  return String(s ?? "")
    .replace(/[.,#'"]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Normalize a street line for comparison: case, spacing, harmless punctuation, trailing suffix tokens.
 * @param {string} line
 */
function normalizeComparableStreetLine(line) {
  let s = stripHarmlessAddressPunctuation(String(line ?? "")).toLowerCase();
  const parts = s.split(/\s+/).filter(Boolean);
  if (!parts.length) {
    return "";
  }
  const lastIdx = parts.length - 1;
  const lastRaw = parts[lastIdx];
  const last = STREET_SUFFIX_TOKEN_MAP[lastRaw] || lastRaw;
  parts[lastIdx] = last;
  return parts.join(" ");
}

/**
 * Normalize city for comparison (spacing, case, harmless punctuation).
 * @param {string} city
 */
function normalizeComparableCity(city) {
  return stripHarmlessAddressPunctuation(String(city ?? "")).toLowerCase();
}

/**
 * When Shippo rejects an address, infer which fields are wrong using the normalized
 * address when present; otherwise fall back to street/city only if ZIP/state look valid.
 * @param {{ line1?: string, line2?: string, city?: string, state?: string, postalCode?: string }} addr
 * @param {{ messages: string[], normalizedAddress: object | null }} sm
 * @returns {{ addressErrors: ReturnType<typeof emptyAddressErrorsRecord>, bannerMessage: string | null, fieldErrors: Record<string, string> }}
 */
export function buildAddressErrorsForInvalidShippo(addr, sm) {
  const a = addr && typeof addr === "object" ? addr : {};
  const norm = sm?.normalizedAddress && typeof sm.normalizedAddress === "object" ? sm.normalizedAddress : null;
  const stateIn = String(a.state || "").trim().toUpperCase().slice(0, 2);

  const addressErrors = emptyAddressErrorsRecord();

  if (norm && norm.line1 && norm.city && norm.state && norm.postalCode) {
    if (normalizeComparableStreetLine(a.line1) !== normalizeComparableStreetLine(norm.line1)) {
      addressErrors.street1 = STREET_FIELD_MSG;
    }
    if (normalizeComparableCity(a.city) !== normalizeComparableCity(norm.city)) {
      addressErrors.city = CITY_FIELD_MSG;
    }
    if (stateIn !== String(norm.state || "").trim().toUpperCase().slice(0, 2)) {
      addressErrors.state = "Please select a valid state.";
    }
    if (zip5Only(a.postalCode) !== zip5Only(norm.postalCode)) {
      addressErrors.zip = ZIP_ERROR_MSG;
    }
    if (Object.values(addressErrors).some(Boolean)) {
      return {
        addressErrors,
        bannerMessage: ADDRESS_CHECK_BANNER_MESSAGE,
        fieldErrors: addressErrorsToFieldErrors(addressErrors),
      };
    }
  }

  /** Shippo-only failure with no per-field signal: do not blame ZIP/state when they pass local checks. */
  if (isStrictUsZip(a.postalCode)) {
    addressErrors.zip = null;
  } else {
    addressErrors.zip = ZIP_ERROR_MSG;
  }
  if (/^[A-Z]{2}$/.test(stateIn)) {
    addressErrors.state = null;
  } else {
    addressErrors.state = "Please select a valid state.";
  }
  addressErrors.street1 = STREET_FIELD_MSG;
  addressErrors.city = CITY_FIELD_MSG;

  const fieldErrors = addressErrorsToFieldErrors(addressErrors);
  const bannerMessage =
    addressErrors.street1 || addressErrors.city || addressErrors.state || addressErrors.zip
      ? ADDRESS_CHECK_BANNER_MESSAGE
      : null;
  return { addressErrors, bannerMessage, fieldErrors };
}

function localFieldErrorsToAddressPresentation(fieldErrors, errorMsg) {
  const fe = fieldErrors && typeof fieldErrors === "object" ? fieldErrors : {};
  const addressErrors = emptyAddressErrorsRecord();
  if (fe.line1) {
    addressErrors.street1 = String(fe.line1).trim();
  }
  if (fe.city) {
    addressErrors.city = String(fe.city).trim();
  }
  if (fe.state) {
    addressErrors.state = String(fe.state).trim();
  }
  if (fe.postalCode) {
    addressErrors.zip = String(fe.postalCode).trim();
  }
  const n = Object.values(addressErrors).filter(Boolean).length;
  const bannerMessage = n >= 2 ? ADDRESS_CHECK_BANNER_MESSAGE : null;
  return {
    addressErrors,
    bannerMessage,
    addressValidation: {
      code: "invalid",
      messages: errorMsg ? [String(errorMsg)] : [],
      addressErrors,
      bannerMessage,
    },
  };
}

export function isStrictUsZip(postalCode) {
  const z = String(postalCode ?? "")
    .trim()
    .replace(/\s/g, "");
  return /^\d{5}$/.test(z) || /^\d{5}-\d{4}$/.test(z);
}

export function isCheckoutAddressValidationEnabled() {
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
  const st = (s) =>
    String(s || "")
      .replace(/\s+/g, "")
      .replace(/[.,]/g, "")
      .toUpperCase()
      .slice(0, 2);
  return (
    normalizeComparableStreetLine(submitted.line1) !== normalizeComparableStreetLine(normalized.line1) ||
    normalizeComparableCity(submitted.city) !== normalizeComparableCity(normalized.city) ||
    st(submitted.state) !== st(normalized.state) ||
    zip5(submitted.postalCode) !== zip5(normalized.postalCode)
  );
}

const ADDRESS_MISMATCH_USER_MSG =
  "We found a different deliverable address. Please review the suggested address below, update your entry, or use the suggested address.";

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
 *   addressValidation?: { code: string, messages: string[], addressErrors?: object, bannerMessage?: string | null },
 *   shippingContext: { applyResidentialSurcharge: boolean, shippoUnavailable: boolean },
 *   normalizedAddress?: object | null,
 *   addressSuggestion?: object | null,
 * }>}
 */
export async function validateShippingAddressForCheckout(addr, opts = {}) {
  const local = validateLocalUsAddressShape(addr);
  if (!local.ok) {
    const pres = localFieldErrorsToAddressPresentation(local.fieldErrors || {}, local.error);
    return {
      ok: false,
      error: local.error,
      fieldErrors: local.fieldErrors || {},
      addressValidation: pres.addressValidation,
      shippingContext: { applyResidentialSurcharge: false, shippoUnavailable: false },
    };
  }

  if (!isCheckoutAddressValidationEnabled()) {
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
    const pres = unavailable ? null : buildAddressErrorsForInvalidShippo(addr, sm);
    const empty = emptyAddressErrorsRecord();
    return {
      ok: false,
      error: unavailable
        ? "Address verification is temporarily unavailable. Please try again."
        : SHIPPING_ADDRESS_ERROR_MSG,
      addressValidation: {
        code: unavailable ? "unavailable" : "invalid",
        messages,
        addressErrors: unavailable ? empty : pres.addressErrors,
        bannerMessage: unavailable ? null : pres.bannerMessage,
      },
      fieldErrors: unavailable ? {} : pres.fieldErrors,
      shippingContext: { applyResidentialSurcharge: false, shippoUnavailable: unavailable },
      normalizedAddress: sm.normalizedAddress || null,
      addressSuggestion: null,
    };
  }

  if (
    strictShippo &&
    sm.normalizedAddress &&
    typeof sm.normalizedAddress === "object" &&
    submittedAddressDiffersFromNormalized(addr, sm.normalizedAddress)
  ) {
    const empty = emptyAddressErrorsRecord();
    return {
      ok: false,
      error: ADDRESS_MISMATCH_USER_MSG,
      fieldErrors: {},
      addressValidation: {
        code: "address_mismatch",
        messages: [ADDRESS_MISMATCH_USER_MSG],
        addressErrors: empty,
        bannerMessage: null,
      },
      shippingContext: { applyResidentialSurcharge: false, shippoUnavailable: false },
      normalizedAddress: sm.normalizedAddress,
      addressSuggestion: sm.normalizedAddress,
      submittedAddress: {
        line1: String(addr.line1 || "").trim(),
        line2: String(addr.line2 || "").trim(),
        city: String(addr.city || "").trim(),
        state: String(addr.state || "").trim(),
        postalCode: String(addr.postalCode || "").trim(),
        country: String(addr.country || "US").trim().toUpperCase() || "US",
      },
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
