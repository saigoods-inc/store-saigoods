import { mergeInventoryIntoProduct } from "../lib/stock.js";
import { primeRuntimeStore } from "../lib/runtime-store.js";
import { renderProductNotFoundPage, renderProductPage } from "../lib/seo.js";

function sendHtml(res, status, html, cacheControl) {
  res.status(status);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", cacheControl);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.end(html);
}

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.status(405).setHeader("Allow", "GET, HEAD").end();
    return;
  }

  const rawSlug = Array.isArray(req.query?.slug) ? req.query.slug[0] : req.query?.slug;
  const slug = String(rawSlug || "").trim();

  try {
    const { store } = await primeRuntimeStore();
    const source = store.products.find((product) => product.slug === slug);
    if (!source) {
      const html = renderProductNotFoundPage();
      sendHtml(res, 404, req.method === "HEAD" ? "" : html, "public, max-age=0, s-maxage=60");
      return;
    }

    let product = source;
    try {
      product = await mergeInventoryIntoProduct(source);
    } catch (error) {
      console.error("[seo] Inventory enrichment failed; rendering catalog availability.", error);
    }

    const html = renderProductPage(product, store.site);
    sendHtml(
      res,
      200,
      req.method === "HEAD" ? "" : html,
      "public, max-age=0, s-maxage=60, stale-while-revalidate=300",
    );
  } catch (error) {
    console.error("[seo] Product page render failed.", error);
    sendHtml(res, 500, req.method === "HEAD" ? "" : renderProductNotFoundPage(), "no-store");
  }
}
