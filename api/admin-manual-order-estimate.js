import { assertReportsAuthorized } from "../lib/reports-auth.js";
import { computeCheckoutEstimate } from "../lib/checkout-estimate-logic.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed." });
    return;
  }

  try {
    await assertReportsAuthorized(req);
    const json = await computeCheckoutEstimate(req.body || {}, {
      requireCompleteAddress: true,
      adminLocalDiscount: true,
    });
    res.status(200).json(json);
  } catch (error) {
    console.error(error);
    res.status(error.statusCode || 500).json({ error: error.message || "Estimate failed." });
  }
}
