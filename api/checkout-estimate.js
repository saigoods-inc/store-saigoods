import { computeCheckoutEstimate, checkoutFlowErrorJsonFields } from "../lib/checkout-estimate-logic.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed." });
    return;
  }

  try {
    const json = await computeCheckoutEstimate(req.body || {});
    res.status(200).json(json);
  } catch (error) {
    console.error(error);
    const status = error.statusCode || 500;
    res.status(status).json({
      error: error.message || "Estimate failed.",
      ...checkoutFlowErrorJsonFields(error),
    });
  }
}
