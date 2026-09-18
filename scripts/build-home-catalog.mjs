import { readFileSync, writeFileSync } from "node:fs";
import { renderCatalogCards } from "../public/js/home-cards.js";

// Cache stable descriptions/images in the HTML; never bake live stock or pricing.
const store = JSON.parse(readFileSync(new URL("../data/store.json", import.meta.url), "utf8"));
const path = new URL("../public/index.html", import.meta.url);
const html = readFileSync(path, "utf8");
const cards = renderCatalogCards(store.products.map(({ storefront, inventory, ...product }) => product)).replace(/[ \t]+$/gm, "");
const next = html.replace(/<!-- catalog:start -->[\s\S]*?<!-- catalog:end -->/, `<!-- catalog:start --><div class="catalog-grid" data-product-grid>${cards}</div><!-- catalog:end -->`);
if (process.argv.includes("--check")) {
  if (next !== html) throw new Error("Run npm run build:storefront to refresh the initial product cards.");
} else writeFileSync(path, next);
