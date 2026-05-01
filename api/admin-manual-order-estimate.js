import { assertReportsAuthorized } from "../lib/reports-auth.js";
import { computeCheckoutEstimate, checkoutFlowErrorJsonFields } from "../lib/checkout-estimate-logic.js";
import { normalizeFulfillmentMethod } from "../lib/manual-order-fulfillment.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed." });
    return;
  }

  try {
    await assertReportsAuthorized(req);
    const body = req.body || {};
    const fm = normalizeFulfillmentMethod(body.fulfillmentMethod);
    const isCarrier = fm === "carrier";
    const json = await computeCheckoutEstimate(body, {
      requireCompleteAddress: isCarrier,
      adminLocalDiscount: true,
      strictShippo: isCarrier,
      allowForceStockOverride: true,
    });
    res.status(200).json(json);
  } catch (error) {
    console.error(error);
    res.status(error.statusCode || 500).json({
      error: error.message || "Estimate failed.",
      ...checkoutFlowErrorJsonFields(error),
    });
  }
}
