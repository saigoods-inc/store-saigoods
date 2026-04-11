import { assertReportsAuthorized } from "../lib/reports-auth.js";
import { computeCheckoutEstimate } from "../lib/checkout-estimate-logic.js";
import { WALK_IN_PICKUP_ADDRESS } from "../lib/walk-in-pickup.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed." });
    return;
  }

  try {
    await assertReportsAuthorized(req);
    const body = req.body || {};
    const json = await computeCheckoutEstimate(
      {
        ...body,
        address: WALK_IN_PICKUP_ADDRESS,
      },
      {
        requireCompleteAddress: true,
        adminLocalDiscount: true,
        walkInPickup: true,
      },
    );
    res.status(200).json(json);
  } catch (error) {
    console.error(error);
    res.status(error.statusCode || 500).json({ error: error.message || "Estimate failed." });
  }
}
