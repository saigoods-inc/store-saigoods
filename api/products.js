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
    res.status(200).json(await mergeInventoryIntoStore(publicStore));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to load products." });
  }
}
