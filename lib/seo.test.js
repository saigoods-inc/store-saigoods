import assert from "node:assert/strict";
import test from "node:test";

import {
  productJsonLd,
  renderProductPage,
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
    { id: "case_1", kind: "case", units: 1, active: true, priceCents: 7999 },
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

test("sitemap contains only public canonical URLs", () => {
  const xml = renderSitemap([product]);
  assert.match(xml, /https:\/\/store\.saigoods\.com\/<\/loc>/);
  assert.match(xml, /https:\/\/store\.saigoods\.com\/contact<\/loc>/);
  assert.match(xml, /https:\/\/store\.saigoods\.com\/products\/nitrile-standard<\/loc>/);
  assert.doesNotMatch(xml, /cart|checkout|admin|api/);
});
