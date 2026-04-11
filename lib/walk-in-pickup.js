/**
 * Fixed pickup / tax jurisdiction for walk-in orders (no address form in admin).
 * Savannah, TN — Hardin County ZIP used for local-tier eligibility and TN tax.
 */
export const WALK_IN_PICKUP_ADDRESS = {
  line1: "In-store pickup",
  line2: "",
  city: "Savannah",
  state: "TN",
  postalCode: "38372",
  country: "US",
};
