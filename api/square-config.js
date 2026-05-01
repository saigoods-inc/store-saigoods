import { isCheckoutAddressValidationEnabled } from "../lib/address-validation.js";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed." });
    return;
  }

  const squareApplicationId = process.env.SQUARE_APPLICATION_ID?.trim() || null;
  const squareLocationId = process.env.SQUARE_LOCATION_ID?.trim() || null;
  const squareEnvironment =
    (process.env.SQUARE_ENVIRONMENT || "production").toLowerCase() === "sandbox" ? "sandbox" : "production";

  const checkoutAddressValidationEnabled = isCheckoutAddressValidationEnabled();
  const isProduction = process.env.NODE_ENV === "production";
  const checkoutShowAddressValidationDisabledBanner =
    !checkoutAddressValidationEnabled && !isProduction;

  if (!squareApplicationId || !squareLocationId) {
    res.status(503).json({
      error: "Embedded checkout is not configured. Add SQUARE_APPLICATION_ID and SQUARE_LOCATION_ID.",
      squareApplicationId: null,
      squareLocationId: null,
      squareEnvironment,
      checkoutAddressValidationEnabled,
      checkoutShowAddressValidationDisabledBanner,
    });
    return;
  }

  res.status(200).json({
    squareApplicationId,
    squareLocationId,
    squareEnvironment,
    checkoutAddressValidationEnabled,
    checkoutShowAddressValidationDisabledBanner,
  });
}
