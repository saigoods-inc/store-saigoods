import { buildQuote } from "../lib/quote.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed." });
    return;
  }

  try {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    const quote = buildQuote(items);

    const checkoutReady = Boolean(
      process.env.SQUARE_ACCESS_TOKEN &&
        process.env.SQUARE_LOCATION_ID &&
        process.env.PUBLIC_BASE_URL &&
        process.env.SQUARE_WEBHOOK_SIGNATURE_KEY &&
        process.env.SUPABASE_URL &&
        process.env.SUPABASE_SERVICE_ROLE_KEY,
    );

    res.status(200).json({
      ...quote,
      squareReady: checkoutReady,
      checkoutReady,
    });
  } catch (error) {
    console.error(error);
    res.status(error.statusCode || 500).json({ error: error.message || "Failed to build quote." });
  }
}

