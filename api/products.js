import { withStorefrontOffers } from "../lib/storefront-offers.js";
import { mergeInventoryIntoStore } from "../lib/stock.js";
import { primeRuntimeStore } from "../lib/runtime-store.js";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed." });
    return;
  }

  try {
    const { store } = await primeRuntimeStore();
    const publicStore = {
      ...store,
      products: store.products.map((product) => ({
        ...product,
        bundles: (product.bundles || []).filter((bundle) => bundle.active !== false),
      })),
    };
    res.setHeader("Cache-Control", "no-store");
    const enriched = await mergeInventoryIntoStore(publicStore);
    res.status(200).json({ ...enriched, products: enriched.products.map(withStorefrontOffers) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to load products." });
  }
}
