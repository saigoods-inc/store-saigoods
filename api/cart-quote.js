import { enrichCartQuoteApiResponse } from "../lib/cart-api-response.js";
import { assertCartItemsHaveValidSupportedSizeAllocation, buildQuote } from "../lib/quote.js";
import { assertStockAvailableForItems } from "../lib/stock.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed." });
    return;
  }

  try {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    assertCartItemsHaveValidSupportedSizeAllocation(items);
    await assertStockAvailableForItems(items);
    const quote = buildQuote(items, { omitShippingEstimate: true });

    res.status(200).json(enrichCartQuoteApiResponse(quote));
  } catch (error) {
    console.error(error);
    res.status(error.statusCode || 500).json({ error: error.message || "Failed to build quote." });
  }
}

