/** Route discount failures before the shipping-message sanitizer. */
const DISCOUNT_ERROR_PREFIXES = [
  "This discount code is invalid or not applicable to this address.",
  "Enter a valid discount code",
  "That discount code is not valid.",
  "This discount code has already been used.",
  "This automatic volume price cannot be combined with another discount.",
  "Custom selling prices cannot be combined with another discount.",
];

export function isCheckoutDiscountApiError(message, data) {
  if (data?.errorCode === "DISCOUNT_MIN_CARTONS") return true;
  const text = String(message || "").trim();
  return Boolean(text) && (
    text.includes("just used by another order") ||
    DISCOUNT_ERROR_PREFIXES.some((prefix) => text.startsWith(prefix))
  );
}

/** Display server-confirmed eligibility only; never infer it from browser cart quantities. */
export function checkoutDiscountSuccess(details) {
  if (!details || typeof details !== "object") return null;
  const code = String(details.code || "").trim();
  const { percentOff, minCartons, cartonCount } = details;
  if (!code || !Number.isFinite(percentOff) || percentOff < 1 || percentOff > 100 ||
      !Number.isSafeInteger(minCartons) || minCartons < 0 ||
      !Number.isSafeInteger(cartonCount) || cartonCount < minCartons) return null;
  return {
    message: `${code} applied — ${percentOff}% off.`,
    summaryLabel: `${code} • ${percentOff}% Off`,
  };
}

const CHECKOUT_DRAFT_KEY = "saigoods.checkoutDraft";
export const CHECKOUT_DRAFT_FIELDS = ["name", "email", "phone", "line1", "line2", "city", "state", "postalCode", "discountCode"];

function customerDraftFields(values) {
  return Object.fromEntries(CHECKOUT_DRAFT_FIELDS
    .filter((name) => typeof values?.[name] === "string")
    .map((name) => [name, values[name].slice(0, 256)]));
}

/** Session-only customer inputs survive an Edit cart round trip. No payment data is retained. */
export function saveCheckoutDraft(storage, values) {
  try {
    storage.setItem(CHECKOUT_DRAFT_KEY, JSON.stringify(customerDraftFields(values)));
  } catch { /* Browser storage restrictions must not prevent checkout. */ }
}

export function readCheckoutDraft(storage) {
  try {
    return customerDraftFields(JSON.parse(storage.getItem(CHECKOUT_DRAFT_KEY)));
  } catch {
    return {};
  }
}

export function clearCheckoutDraft(storage) {
  try { storage.removeItem(CHECKOUT_DRAFT_KEY); } catch { /* Optional browser persistence. */ }
}
