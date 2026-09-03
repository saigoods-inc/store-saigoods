import assert from "node:assert/strict";
import test from "node:test";

import {
  productJsonLd,
  renderProductPage,
  renderMerchantFeed,
  renderSitemap,
  schemaAvailability,
} from "./seo.js";

const site = { name: "SAI Goods Store", legalName: "SAI Goods Inc." };
const product = {
  slug: "nitrile-standard",
  name: "Nitrile Examination – Standard",
  subtext: "Powder-free blue examination gloves.",
  description: "Reliable nitrile gloves for clinical and hygiene work.",
  currency: "usd",
  gallery: ["/img/product.jpg"],
  specs: [{ label: "Material", value: "Nitrile" }],
  bundles: [
    { id: "box_1", kind: "box", units: 1, active: true, priceCents: 999 },
    { id: "case_1", label: "1 carton", kind: "case", units: 1, active: true, priceCents: 7999 },
  ],
  inventory: {
    globalOutOfStock: false,
    lines: [{ active: true, available: 5 }],
  },
};

test("product JSON-LD uses the live box offer and canonical product URL", () => {
  const graph = productJsonLd(product, site)["@graph"];
  const node = graph.find((entry) => entry["@type"] === "Product");
  assert.equal(node.url, "https://store.saigoods.com/products/nitrile-standard");
  assert.equal(node.offers.price, "9.99");
  assert.equal(node.offers.priceCurrency, "USD");
  assert.equal(node.offers.availability, "https://schema.org/InStock");
  assert.equal(node.brand.name, "LYDUS");
  assert.equal(node.sku, "nitrile-standard");
});

test("availability becomes out of stock only when the enriched inventory is empty", () => {
  assert.equal(
    schemaAvailability({ inventory: { globalOutOfStock: false, lines: [{ available: 0 }] } }),
    "https://schema.org/OutOfStock",
  );
  assert.equal(
    schemaAvailability({ inventory: { globalOutOfStock: true, lines: [{ available: 100 }] } }),
    "https://schema.org/OutOfStock",
  );
});

test("the SEO offer switches to an in-stock carton when loose boxes are unavailable", () => {
  const caseOnly = {
    ...product,
    inventory: {
      globalOutOfStock: false,
      lines: [
        { active: true, channel: "box", available: 0 },
        { active: true, channel: "case", available: 20 },
      ],
    },
  };
  const node = productJsonLd(caseOnly, site)["@graph"].find(
    (entry) => entry["@type"] === "Product",
  );
  assert.equal(node.offers.price, "79.99");
  assert.equal(node.offers.availability, "https://schema.org/InStock");
});

test("rendered product HTML is indexable, canonical, and server-visible", () => {
  const html = renderProductPage(product, site);
  assert.match(html, /<h1>Nitrile Examination – Standard<\/h1>/);
  assert.match(html, /<link rel="canonical" href="https:\/\/store\.saigoods\.com\/products\/nitrile-standard"/);
  assert.match(html, /<script type="application\/ld\+json">/);
  assert.match(html, /Starting at \$9\.99/);
  assert.doesNotMatch(html, /noindex/);
});

test("Merchant landing URL renders the carton price in server-visible HTML and JSON-LD", () => {
  const html = renderProductPage(product, site, { offerId: "case_1" });
  assert.match(html, /1 carton \$79\.99/);
  assert.match(html, /"price":"79\.99"/);
  assert.match(html, /rel="canonical" href="https:\/\/store\.saigoods\.com\/products\/nitrile-standard"/);
});

test("sitemap contains only public canonical URLs", () => {
  const xml = renderSitemap([product]);
  assert.match(xml, /https:\/\/store\.saigoods\.com\/<\/loc>/);
  assert.match(xml, /https:\/\/store\.saigoods\.com\/contact<\/loc>/);
  assert.match(xml, /https:\/\/store\.saigoods\.com\/products\/nitrile-standard<\/loc>/);
  assert.match(xml, /xmlns:image="http:\/\/www\.google\.com\/schemas\/sitemap-image\/1\.1"/);
  assert.match(xml, /<image:loc>https:\/\/store\.saigoods\.com\/img\/product\.jpg<\/image:loc>/);
  assert.doesNotMatch(xml, /cart|checkout|admin|api/);
});

test("Merchant Center feed contains a current, canonical product offer", () => {
  const packaging = {
    products: {
      "nitrile-standard": {
        sizes: {
          Medium: { factoryCase: { weightLb: 9.74 } },
        },
      },
    },
  };
  const xml = renderMerchantFeed([product], site, packaging);
  assert.match(xml, /<rss xmlns:g="http:\/\/base\.google\.com\/ns\/1\.0" version="2\.0">/);
  assert.match(xml, /<g:id>nitrile-standard<\/g:id>/);
  assert.match(xml, /<g:title>Nitrile Examination – Standard – 10-Box Carton<\/g:title>/);
  assert.match(xml, /<g:link>https:\/\/store\.saigoods\.com\/products\/nitrile-standard\?bundle=case_1<\/g:link>/);
  assert.match(xml, /<g:price>79\.99 USD<\/g:price>/);
  assert.match(xml, /<g:multipack>10<\/g:multipack>/);
  assert.match(xml, /<g:shipping_weight>10 lb<\/g:shipping_weight>/);
  assert.match(xml, /<g:availability>in_stock<\/g:availability>/);
  assert.match(xml, /<g:condition>new<\/g:condition>/);
  assert.match(xml, /<g:brand>LYDUS<\/g:brand>/);
  assert.match(xml, /<g:identifier_exists>no<\/g:identifier_exists>/);
});

test("Merchant Center feed reports unavailable tracked stock as out of stock", () => {
  const unavailable = {
    ...product,
    inventory: { globalOutOfStock: false, lines: [{ channel: "case", active: true, available: 0 }] },
  };
  const xml = renderMerchantFeed([unavailable], site);
  assert.match(xml, /<g:availability>out_of_stock<\/g:availability>/);
});
