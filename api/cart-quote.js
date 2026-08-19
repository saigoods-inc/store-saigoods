import { enrichCartQuoteApiResponse } from "../lib/cart-api-response.js";
import { assertCartItemsHaveValidSupportedSizeAllocation, buildQuote } from "../lib/quote.js";
import { assertStockAvailableForItems } from "../lib/stock.js";
import { resolveOnlineShippingPackagePlan } from "../lib/shipping-package-limit.js";
import { primeRuntimeStoreForItems } from "../lib/runtime-store.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed." });
    return;
  }

  try {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    await primeRuntimeStoreForItems(items);
    assertCartItemsHaveValidSupportedSizeAllocation(items);
    if (!items.length) {
      const emptyQuote = buildQuote([], { omitShippingEstimate: true });
      res.status(200).json(enrichCartQuoteApiResponse(emptyQuote));
      return;
    }
    const { parcelSummary, limit } = await resolveOnlineShippingPackagePlan(items);
    const quote = buildQuote(items, { omitShippingEstimate: true });

    if (limit.exceeded) {
      res.status(200).json(enrichCartQuoteApiResponse({
        ...quote,
        parcelSummary,
        shippingPackageLimit: limit,
        userFacingError: limit.message,
        canCheckout: false,
      }));
      return;
    }

    await assertStockAvailableForItems(items);

    res.status(200).json(enrichCartQuoteApiResponse({
      ...quote,
      parcelSummary,
      shippingPackageLimit: limit,
      canCheckout: true,
    }));
  } catch (error) {
    console.error(error);
    res.status(error.statusCode || 500).json({ error: error.message || "Failed to build quote." });
  }
}
