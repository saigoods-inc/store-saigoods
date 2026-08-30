import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = (file) => fs.readFileSync(new URL(file, import.meta.url), "utf8");

test("public pages expose safe crawl directives and canonical URLs", () => {
  const home = read("./public/index.html");
  const productFallback = read("./public/product.html");
  const cart = read("./public/cart.html");
  const checkout = read("./public/checkout.html");

  assert.match(home, /rel="canonical" href="https:\/\/store\.saigoods\.com\/"/);
  assert.match(home, /name="google-site-verification" content="[A-Za-z0-9_-]+"/);
  assert.match(home, /application\/ld\+json/);
  assert.match(productFallback, /name="robots" content="noindex, follow"/);
  assert.match(cart, /name="robots" content="noindex, follow"/);
  assert.match(checkout, /name="robots" content="noindex, follow"/);
});

test("internal storefront links use canonical product paths", () => {
  const homeHtml = read("./public/index.html");
  const homeJs = read("./public/js/home.js");
  const cartJs = read("./public/js/cart.js");

  for (const source of [homeHtml, homeJs, cartJs]) {
    assert.doesNotMatch(source, /\/product\.html\?slug=/);
  }
  assert.match(homeJs, /\/products\//);
  assert.match(cartJs, /\/products\//);
});

test("Vercel exposes clean product, policy, contact, and sitemap routes", () => {
  const config = JSON.parse(read("./vercel.json"));
  const rewrites = new Map((config.rewrites || []).map(({ source, destination }) => [source, destination]));

  assert.equal(rewrites.get("/products/:slug"), "/api/product-page?slug=:slug");
  assert.equal(rewrites.get("/contact"), "/contact.html");
  assert.equal(rewrites.get("/shipping"), "/shipping.html");
  assert.equal(rewrites.get("/returns"), "/returns.html");
  assert.equal(rewrites.get("/privacy"), "/privacy.html");
  assert.equal(rewrites.get("/sitemap.xml"), "/api/sitemap");
});

test("approved policy pages are indexable and linked from the shared footer", () => {
  const footer = read("./public/js/site.js");
  const policies = [
    ["shipping", "Shipping Policy"],
    ["returns", "Returns & Refunds Policy"],
    ["privacy", "Privacy Policy"],
  ];

  for (const [slug, title] of policies) {
    const html = read(`./public/${slug}.html`);
    assert.match(html, new RegExp(`<title>${title.replace("&", "&amp;")} \\| SAI Goods<\\/title>`));
    assert.match(html, new RegExp(`rel="canonical" href="https:\\/\\/store\\.saigoods\\.com\\/${slug}"`));
    assert.match(html, /name="robots" content="index, follow"/);
    assert.match(footer, new RegExp(`href="\\/${slug}"`));
  }
});

test("shared storefront chrome keeps retired search and footer shop features removed", () => {
  const headerAndFooter = read("./public/js/site.js");
  const home = read("./public/index.html");

  assert.doesNotMatch(headerAndFooter, /data-global-search|search-form|Search gloves/);
  assert.doesNotMatch(headerAndFooter, /<h3 class="widget__title">SHOP<\/h3>/);
  assert.doesNotMatch(headerAndFooter, /Footer store links/);
  assert.doesNotMatch(home, /data-search-meta/);
});

test("policy layouts keep their contact card beside the page heading", () => {
  for (const slug of ["shipping", "returns", "privacy"]) {
    const html = read(`./public/${slug}.html`);
    const layoutStart = html.indexOf('<div class="legal-page__layout">');
    const primaryStart = html.indexOf('<div class="legal-page__primary">', layoutStart);
    const headingStart = html.indexOf('<header class="page-heading legal-page__heading">', primaryStart);
    const asideStart = html.indexOf('<aside class="legal-page__aside"', layoutStart);

    assert.ok(layoutStart >= 0, `${slug} has the policy layout`);
    assert.ok(primaryStart > layoutStart, `${slug} has a primary content column`);
    assert.ok(headingStart > primaryStart, `${slug} keeps its heading in the primary column`);
    assert.ok(asideStart > headingStart, `${slug} keeps its support card in the top-level grid`);
    assert.doesNotMatch(html, />Customer policies<\/p>/i, `${slug} omits the retired policy eyebrow`);
  }
});

test("robots.txt allows the storefront and advertises the sitemap", () => {
  const robots = read("./public/robots.txt");
  assert.match(robots, /User-agent: \*/);
  assert.match(robots, /Allow: \//);
  assert.match(robots, /Sitemap: https:\/\/store\.saigoods\.com\/sitemap\.xml/);
  assert.doesNotMatch(robots, /Disallow: \/$/m);
});
