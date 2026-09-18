import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { renderHeaderHtml } from "../public/js/site-header.js";
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


// Every static storefront page ships the same header as server-rendered products.
for (const name of readdirSync(new URL('../public/', import.meta.url)).filter(name => name.endsWith('.html'))) {
  const file = new URL('../public/' + name, import.meta.url);
  const source = readFileSync(file, 'utf8');
  if (!source.includes('<header data-site-header>')) continue;
  const page = name === 'index.html' ? 'home' : name.replace('.html', '');
  const header = renderHeaderHtml(store.site, page).replace(/[ \t]+$/gm, '');
  const rendered = source.replace(/<header data-site-header>[\s\S]*?<\/header>/, `<header data-site-header>${header}</header>`);
  if (process.argv.includes('--check')) {
    if (rendered !== source) throw new Error(`Run npm run build:storefront to refresh ${name}'s header.`);
  } else writeFileSync(file, rendered);
}
