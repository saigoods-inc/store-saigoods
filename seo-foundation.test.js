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
  assert.match(home, /<h1 class="hero__title">Nitrile gloves you can count on\.<\/h1>/);
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

test("storefront leads from products to decision support and bulk ordering", () => {
  const home = read("./public/index.html");
  const homeJs = read("./public/js/home.js");
  const products = home.indexOf('id="products"');
  const chooser = home.indexOf('id="choose-your-glove"');
  const bulk = home.indexOf('id="b2b"');

  assert.ok(products > 0, "product catalog is present");
  assert.ok(products < chooser, "product catalog appears before comparison guidance");
  assert.ok(chooser < bulk, "decision support leads into bulk ordering");
  assert.doesNotMatch(home, /class="store-benefits"/);
  assert.doesNotMatch(home, /data-product-intros/);
  assert.doesNotMatch(homeJs, /renderIntroPanels|introRoot/);
});

test("Vercel exposes clean product, policy, contact, and sitemap routes", () => {
  const config = JSON.parse(read("./vercel.json"));
  const rewrites = new Map((config.rewrites || []).map(({ source, destination }) => [source, destination]));

  assert.equal(rewrites.get("/products/:slug"), "/api/product-page?slug=:slug");
  assert.equal(rewrites.has("/lydus-nitrile-gloves"), false);
  assert.equal(rewrites.get("/contact"), "/contact.html");
  assert.equal(rewrites.get("/shipping"), "/shipping.html");
  assert.equal(rewrites.get("/returns"), "/returns.html");
  assert.equal(rewrites.get("/privacy"), "/privacy.html");
  assert.equal(rewrites.get("/sitemap.xml"), "/api/sitemap");
  assert.equal(rewrites.get("/merchant-feed.xml"), "/api/merchant-feed");
});

test("legacy LYDUS product URLs permanently redirect to canonical product paths", () => {
  const config = JSON.parse(read("./vercel.json"));
  const redirects = config.redirects || [];
  const legacyQuery = redirects.find((redirect) => redirect.source === "/product.html");
  const oldGeneral = redirects.find(
    (redirect) => redirect.source === "/products/lydus™-black-nitrile-general-series",
  );

  assert.equal(legacyQuery?.destination, "/products/:slug");
  assert.equal(legacyQuery?.permanent, true);
  assert.equal(legacyQuery?.has?.[0]?.type, "query");
  assert.equal(legacyQuery?.has?.[0]?.key, "slug");
  assert.match(legacyQuery?.has?.[0]?.value || "", /black-nitrile-general/);
  assert.equal(oldGeneral?.destination, "/products/black-nitrile-general");
  assert.equal(oldGeneral?.permanent, true);
});

test("LYDUS comparison guidance is consolidated into the storefront", () => {
  const home = read("./public/index.html");
  const sharedChrome = read("./public/js/site.js");
  const config = JSON.parse(read("./vercel.json"));
  const guideRedirect = (config.redirects || []).find(
    (redirect) => redirect.source === "/lydus-nitrile-gloves",
  );

  assert.match(home, /id="choose-your-glove"/);
  assert.match(
    home,
    /Compare the <span class="lydus-word">LYDUS<sup>®<\/sup><\/span> range\./,
  );
  assert.match(home, /"@type": "ItemList"/);
  assert.match(home, /4 mil/);
  assert.match(home, /5 mil/);
  assert.match(home, /8 mil/);
  for (const slug of ["nitrile-standard", "black-nitrile-general", "black-nitrile-heavy-duty"]) {
    assert.match(home, new RegExp(`href="\\/products\\/${slug}"`));
  }
  assert.doesNotMatch(home, /href="\/lydus-nitrile-gloves"/);
  assert.doesNotMatch(sharedChrome, /href="\/lydus-nitrile-gloves"/);
  assert.doesNotMatch(sharedChrome, /Choose your glove/);
  assert.equal(guideRedirect?.destination, "/#choose-your-glove");
  assert.equal(guideRedirect?.permanent, true);
});

test("shipping and return structured data match the published policies", () => {
  const shipping = read("./public/shipping.html");
  const returns = read("./public/returns.html");

  assert.match(shipping, /"@type": "ShippingService"/);
  assert.match(shipping, /"minValue": 300/);
  assert.match(shipping, /"value": 0, "currency": "USD"/);
  assert.match(shipping, /"addressCountry": "US"/);
  assert.match(returns, /"@type": "MerchantReturnPolicy"/);
  assert.match(returns, /"merchantReturnDays": 3/);
  assert.match(returns, /"returnFees": "https:\/\/schema\.org\/ReturnFeesCustomerResponsibility"/);
  assert.match(returns, /"restockingFee": 0\.1/);
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

test("cart count badge remains a compact circle", () => {
  const styles = read("./public/css/styles.css");
  const badgeRule = styles.match(/\.cart-link__count\s*\{([\s\S]*?)\}/)?.[1] || "";

  assert.match(badgeRule, /display:\s*inline-flex/);
  assert.match(badgeRule, /width:\s*1rem/);
  assert.match(badgeRule, /height:\s*1rem/);
  assert.match(badgeRule, /min-width:\s*1rem/);
  assert.match(badgeRule, /padding:\s*0/);
  assert.match(badgeRule, /border-radius:\s*50%/);
  assert.match(badgeRule, /font-size:\s*0\.625rem/);
  assert.match(badgeRule, /line-height:\s*1/);
});
