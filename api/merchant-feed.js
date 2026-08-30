import { mergeInventoryIntoStore } from "../lib/stock.js";
import { primeRuntimeStore } from "../lib/runtime-store.js";
import { renderMerchantFeed } from "../lib/seo.js";

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.status(405).setHeader("Allow", "GET, HEAD").end();
    return;
  }

  try {
    const { store } = await primeRuntimeStore();
    let publicStore = {
      ...store,
      products: store.products.map((product) => ({
        ...product,
        bundles: (product.bundles || []).filter((bundle) => bundle.active !== false),
      })),
    };

    try {
      publicStore = await mergeInventoryIntoStore(publicStore);
    } catch (error) {
      console.error("[merchant-feed] Inventory enrichment failed; using catalog availability.", error);
    }

    const xml = renderMerchantFeed(publicStore.products, publicStore.site);
    res.status(200);
    res.setHeader("Content-Type", "application/xml; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=0, s-maxage=300, stale-while-revalidate=3600");
    res.end(req.method === "HEAD" ? "" : xml);
  } catch (error) {
    console.error("[merchant-feed] Feed render failed.", error);
    res.status(500).setHeader("Cache-Control", "no-store").end();
  }
}
