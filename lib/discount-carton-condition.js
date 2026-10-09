import { getProductMap } from "./store.js";
import { assertDiscountCodeAvailable } from "./discount-codes.js";
import { getLineCases, normalizeItemLineForOrderProcessing, assertCartItemsHaveValidSupportedSizeAllocation } from "./quote.js";

/** Caller primes the runtime catalog before validating allocations. */
export async function assertDiscountCodeEligibleForItems(code, items) {
  const details = await assertDiscountCodeAvailable(code);
  return assertDiscountCartonCondition({ ...details, code }, items);
}

export function normalizeMinimumCartons(value) {
  if (value == null || value === "") return 0;
  const count = typeof value === "number" || typeof value === "string" ? Number(value) : NaN;
  if (!Number.isSafeInteger(count) || count < 0 || count > 2147483647) {
    const error = new Error("Minimum cartons must be a whole number of 0 or more.");
    error.statusCode = 400;
    throw error;
  }
  return count;
}

/** Use validated carton allocations, never rounded shipping units or loose boxes. */
export function assertDiscountCartonCondition(details, items) {
  const minCartons = normalizeMinimumCartons(details?.min_cartons);
  const lines = Array.isArray(items) ? items : [];
  assertCartItemsHaveValidSupportedSizeAllocation(lines);
  const products = getProductMap();
  const cartonCount = lines.reduce((total, line) => {
    const product = products.get(line?.slug);
    if (!product) return total;
    const normalized = normalizeItemLineForOrderProcessing(line, product);
    return total + getLineCases(normalized.quantities);
  }, 0);
  const discount = {
    code: String(details?.code || ""),
    percentOff: Number(details?.percentOff ?? details?.percent_off) || 7,
    minCartons,
    cartonCount,
    missingCartons: Math.max(0, minCartons - cartonCount),
  };
  if (discount.missingCartons > 0) {
    const error = new Error(`${discount.code || "This code"} requires at least ${minCartons} ${minCartons === 1 ? "carton" : "cartons"}. Your cart has ${cartonCount}. Add ${discount.missingCartons} more to receive ${discount.percentOff}% off.`);
    error.statusCode = 400;
    error.code = "DISCOUNT_MIN_CARTONS";
    error.discount = discount;
    throw error;
  }
  return { ...discount, ...(details?.id ? { id: String(details.id) } : {}) };
}


/** A reused code name must not authorize a price signed for a deleted code. */
export function assertQuotedDiscountIsCurrent(quote, current) {
  const quoted = quote?.discountCodeDetails;
  if (!current?.id || !quoted?.id || quoted.id !== current.id || Number(quoted.percentOff) !== Number(current.percentOff)) {
    const error = new Error("This discount code has changed or was replaced. Refresh the quote and apply the code again before continuing.");
    error.statusCode = 409;
    throw error;
  }
}
