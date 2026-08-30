import { loadBundledStore } from "../lib/store.js";
import { renderSitemap } from "../lib/seo.js";

export default function handler(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.status(405).setHeader("Allow", "GET, HEAD").end();
    return;
  }

  const store = loadBundledStore();
  const xml = renderSitemap(store.products);
  res.status(200);
  res.setHeader("Content-Type", "application/xml; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=0, s-maxage=3600, stale-while-revalidate=86400");
  res.end(req.method === "HEAD" ? "" : xml);
}
