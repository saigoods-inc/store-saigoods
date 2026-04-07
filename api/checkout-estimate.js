import { buildFullCheckoutQuote } from "../lib/checkout-totals.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed." });
    return;
  }

  try {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!items.length) {
      res.status(400).json({ error: "Your cart is empty." });
      return;
    }

    const addr = req.body?.address || {};
    const quote = await buildFullCheckoutQuote(items, addr);

    res.status(200).json({ ...quote, warnings: [] });
  } catch (error) {
    console.error(error);
    res.status(error.statusCode || 500).json({ error: error.message || "Estimate failed." });
  }
}
