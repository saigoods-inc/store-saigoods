/**
 * Shippo Address API — create address with `validate: true`.
 * https://docs.goshippo.com/docs/addresses/addressvalidation
 *
 * Checkout uses strict mode: only `validation_results.is_valid === true` (and HTTP success) counts as valid.
 * Transport/parse failures return invalid — do not fail open.
 */

const DEFAULT_BASE = "https://api.goshippo.com";

export function isShippoConfigured() {
  return Boolean(process.env.SHIPPO_API_TOKEN?.trim());
}

/** When `CHECKOUT_ESTIMATE_SHIPPO_LOG=1`, /api/checkout-estimate logs Shippo rating inputs (server logs only). */
export function isCheckoutShippoLogEnabled() {
  return String(process.env.CHECKOUT_ESTIMATE_SHIPPO_LOG || "").trim() === "1";
}

export function getShippoApiBaseUrl() {
  const u = process.env.SHIPPO_API_BASE_URL?.trim();
  return u && u.startsWith("http") ? u.replace(/\/$/, "") : DEFAULT_BASE;
}

/**
 * @param {object} json — Shippo address object
 * @returns {{ line1: string, line2?: string, city: string, state: string, postalCode: string, country: string } | null}
 */
export function shippoAddressToOurShape(json) {
  if (!json || typeof json !== "object") {
    return null;
  }
  const line1 = String(json.street1 || "").trim();
  const city = String(json.city || "").trim();
  const state = String(json.state || "").trim().toUpperCase().slice(0, 2);
  if (!line1 || !city || !state) {
    return null;
  }
  const line2 = String(json.street2 || "").trim();
  const zip = String(json.zip || "").trim();
  return {
    line1,
    ...(line2 ? { line2 } : {}),
    city,
    state,
    postalCode: zip,
    country: String(json.country || "US").trim().toUpperCase() || "US",
  };
}

function collectValidationMessages(validationResults) {
  const vr = validationResults && typeof validationResults === "object" ? validationResults : {};
  const raw = Array.isArray(vr.messages) ? vr.messages : [];
  const out = [];
  for (const m of raw) {
    if (m && typeof m === "object" && typeof m.text === "string" && m.text.trim()) {
      out.push(m.text.trim());
    } else if (typeof m === "string" && m.trim()) {
      out.push(m.trim());
    }
  }
  return out;
}

/**
 * @param {{ line1?: string, line2?: string, city?: string, state?: string, postalCode?: string, country?: string }} addr
 * @returns {Promise<{
 *   isValid: boolean,
 *   isResidential: boolean | null,
 *   messages: string[],
 *   normalizedAddress: object | null,
 *   shippoSkipped?: boolean,
 *   shippoUnavailable?: boolean,
 *   httpStatus?: number,
 * }>}
 */
export async function validateAddressWithShippo(addr) {
  const token = process.env.SHIPPO_API_TOKEN?.trim();
  if (!token) {
    return {
      isValid: false,
      isResidential: null,
      messages: [],
      normalizedAddress: null,
      shippoSkipped: true,
      shippoUnavailable: true,
    };
  }

  const a = addr && typeof addr === "object" ? addr : {};
  const street1 = String(a.line1 || "").trim();
  const street2 = String(a.line2 || "").trim();
  const city = String(a.city || "").trim();
  const state = String(a.state || "").trim().toUpperCase().slice(0, 2);
  const zipRaw = String(a.postalCode || "").trim().replace(/\s/g, "");
  const country = String(a.country || "US").trim().toUpperCase() || "US";

  const body = {
    name: "Checkout",
    street1,
    ...(street2 ? { street2 } : {}),
    city,
    state,
    zip: zipRaw,
    country: country.length === 2 ? country : "US",
    validate: true,
  };

  const url = `${getShippoApiBaseUrl()}/addresses/`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `ShippoToken ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      console.error("[shippo] Non-JSON response:", String(text).slice(0, 500));
      return {
        isValid: false,
        isResidential: null,
        messages: ["Address verification returned an invalid response."],
        normalizedAddress: null,
        shippoUnavailable: true,
      };
    }

    if (!res.ok) {
      console.error("[shippo] HTTP error", res.status, json);
      return {
        isValid: false,
        isResidential: null,
        messages: [],
        normalizedAddress: null,
        shippoUnavailable: true,
        httpStatus: res.status,
      };
    }

    const vr = json.validation_results && typeof json.validation_results === "object" ? json.validation_results : null;
    const messages = collectValidationMessages(vr || {});
    if (isCheckoutShippoLogEnabled()) {
      console.log("[shippo-address-validation] response shape", {
        hasValidationResults: Boolean(vr),
        validationResultsKeys: vr ? Object.keys(vr) : [],
        topLevelKeys: Object.keys(json || {}),
        topLevelIsResidential: Object.hasOwn(json || {}, "is_residential") ? json.is_residential : null,
      });
    }

    if (!vr || !Object.hasOwn(vr, "is_valid")) {
      console.warn("[shippo] Missing validation_results.is_valid.");
      return {
        isValid: false,
        isResidential: null,
        messages: messages.length ? messages : ["Address could not be verified."],
        normalizedAddress: shippoAddressToOurShape(json),
        shippoUnavailable: true,
      };
    }

    if (vr.is_valid !== true) {
      return {
        isValid: false,
        isResidential: null,
        messages: messages.length ? messages : ["Address could not be verified."],
        normalizedAddress: shippoAddressToOurShape(json),
      };
    }

    const isUs = String(json.country || "US")
      .trim()
      .toUpperCase()
      .startsWith("US");
    if (isUs && json.is_complete === false) {
      return {
        isValid: false,
        isResidential: null,
        messages: messages.length ? messages : ["This address appears incomplete. Please add missing details."],
        normalizedAddress: shippoAddressToOurShape(json),
      };
    }

    const isResidential =
      json.is_residential === true ? true : json.is_residential === false ? false : null;
    if (isCheckoutShippoLogEnabled()) {
      console.log("[shippo-address-validation] residential parsed", {
        parsedIsResidential: isResidential,
      });
    }

    return {
      isValid: true,
      isResidential,
      messages,
      normalizedAddress: shippoAddressToOurShape(json),
    };
  } catch (err) {
    console.error("[shippo] Request failed:", err?.message || err);
    return {
      isValid: false,
      isResidential: null,
      messages: [],
      normalizedAddress: null,
      shippoUnavailable: true,
    };
  }
}
