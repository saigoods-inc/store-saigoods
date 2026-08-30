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

test("Vercel exposes clean product, contact, and sitemap routes", () => {
  const config = JSON.parse(read("./vercel.json"));
  const rewrites = new Map((config.rewrites || []).map(({ source, destination }) => [source, destination]));

  assert.equal(rewrites.get("/products/:slug"), "/api/product-page?slug=:slug");
  assert.equal(rewrites.get("/contact"), "/contact.html");
  assert.equal(rewrites.get("/sitemap.xml"), "/api/sitemap");
});

test("robots.txt allows the storefront and advertises the sitemap", () => {
  const robots = read("./public/robots.txt");
  assert.match(robots, /User-agent: \*/);
  assert.match(robots, /Allow: \//);
  assert.match(robots, /Sitemap: https:\/\/store\.saigoods\.com\/sitemap\.xml/);
  assert.doesNotMatch(robots, /Disallow: \/$/m);
});
