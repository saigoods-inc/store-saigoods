export const PUBLIC_ORIGIN = "https://store.saigoods.com";

export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function absoluteUrl(value = "/") {
  const raw = String(value || "/").trim();
  if (/^https?:\/\//i.test(raw)) return raw;
  return new URL(raw.startsWith("/") ? raw : `/${raw}`, PUBLIC_ORIGIN).toString();
}

export function productPath(slug) {
  return `/products/${encodeURIComponent(String(slug || "").trim())}`;
}

export function productUrl(slug) {
  return absoluteUrl(productPath(slug));
}

function activeOffers(product) {
  return (Array.isArray(product?.bundles) ? product.bundles : [])
    .filter((bundle) => bundle?.active !== false && Number(bundle?.priceCents) > 0)
    .sort((a, b) => Number(a.priceCents) - Number(b.priceCents));
}

function offerHasInventory(product, offer) {
  if (product?.inventory?.globalOutOfStock === true) return false;
  const lines = Array.isArray(product?.inventory?.lines) ? product.inventory.lines : [];
  if (!lines.length) return true;
  const offerKind = String(offer?.kind || offer?.id || "").toLowerCase();
  const channel = offerKind.includes("case")
    ? "case"
    : offerKind.includes("box")
      ? "box"
      : null;
  const relevant = channel ? lines.filter((line) => !line?.channel || line.channel === channel) : lines;
  const units = Math.max(1, Math.floor(Number(offer?.units) || 1));
  return relevant.some((line) => line?.active !== false && Number(line?.available) >= units);
}

export function preferredSeoOffer(product) {
  const offers = activeOffers(product);
  const available = offers.filter((offer) => offerHasInventory(product, offer));
  return (
    available.find((bundle) => bundle.id === "box_1") ||
    available[0] ||
    offers.find((bundle) => bundle.id === "box_1") ||
    offers[0] ||
    null
  );
}

export function schemaAvailability(product, offer = null) {
  if (product?.inventory?.globalOutOfStock === true) {
    return "https://schema.org/OutOfStock";
  }
  const lines = Array.isArray(product?.inventory?.lines) ? product.inventory.lines : [];
  if (!lines.length) return "https://schema.org/InStock";
  return offerHasInventory(product, offer)
    ? "https://schema.org/InStock"
    : "https://schema.org/OutOfStock";
}

export function productJsonLd(product, site) {
  const url = productUrl(product.slug);
  const images = (Array.isArray(product.gallery) ? product.gallery : [product.cardImage])
    .filter(Boolean)
    .map(absoluteUrl);
  const offer = preferredSeoOffer(product);
  const additionalProperty = (Array.isArray(product.specs) ? product.specs : []).map((spec) => ({
    "@type": "PropertyValue",
    name: String(spec.label || ""),
    value: String(spec.value || ""),
  }));

  const productNode = {
    "@type": "Product",
    "@id": `${url}#product`,
    name: String(product.name || "Nitrile gloves"),
    description: String(product.description || product.subtext || ""),
    url,
    image: images,
    category: "Nitrile gloves",
    ...(additionalProperty.length ? { additionalProperty } : {}),
  };

  if (offer) {
    productNode.offers = {
      "@type": "Offer",
      url,
      priceCurrency: String(product.currency || "USD").toUpperCase(),
      price: (Number(offer.priceCents) / 100).toFixed(2),
      availability: schemaAvailability(product, offer),
      itemCondition: "https://schema.org/NewCondition",
      seller: {
        "@type": "Organization",
        name: String(site?.legalName || site?.name || "SAI Goods Inc."),
        url: PUBLIC_ORIGIN,
      },
    };
  }

  return {
    "@context": "https://schema.org",
    "@graph": [
      productNode,
      {
        "@type": "BreadcrumbList",
        "@id": `${url}#breadcrumb`,
        itemListElement: [
          {
            "@type": "ListItem",
            position: 1,
            name: "Shop",
            item: `${PUBLIC_ORIGIN}/`,
          },
          {
            "@type": "ListItem",
            position: 2,
            name: String(product.name || "Product"),
            item: url,
          },
        ],
      },
    ],
  };
}

export function jsonForHtml(value) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function metaDescription(product) {
  const value = String(product.subtext || product.description || "Shop nitrile gloves from SAI Goods.")
    .replace(/\s+/g, " ")
    .trim();
  return value.length <= 160 ? value : `${value.slice(0, 157).trimEnd()}…`;
}

function visiblePrice(product) {
  const offer = preferredSeoOffer(product);
  return offer ? `$${(Number(offer.priceCents) / 100).toFixed(2)}` : "Contact us for pricing";
}

export function renderProductPage(product, site) {
  const title = `${String(product.name || "Nitrile Gloves")} | SAI Goods`;
  const description = metaDescription(product);
  const canonical = productUrl(product.slug);
  const image = absoluteUrl(product.gallery?.[0] || product.cardImage || "/img/boxes-stack.webp");
  const jsonLd = jsonForHtml(productJsonLd(product, site));
  const specs = (Array.isArray(product.specs) ? product.specs : [])
    .map(
      (spec) => `
              <div class="spec-list__row">
                <span>${escapeHtml(spec.label)}</span>
                <strong>${escapeHtml(spec.value)}</strong>
              </div>`,
    )
    .join("");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(title)}</title>
    <meta name="description" content="${escapeHtml(description)}" />
    <meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1" />
    <link rel="canonical" href="${escapeHtml(canonical)}" />
    <meta property="og:type" content="product" />
    <meta property="og:site_name" content="SAI Goods Store" />
    <meta property="og:title" content="${escapeHtml(title)}" />
    <meta property="og:description" content="${escapeHtml(description)}" />
    <meta property="og:url" content="${escapeHtml(canonical)}" />
    <meta property="og:image" content="${escapeHtml(image)}" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${escapeHtml(title)}" />
    <meta name="twitter:description" content="${escapeHtml(description)}" />
    <meta name="twitter:image" content="${escapeHtml(image)}" />
    <script type="application/ld+json">${jsonLd}</script>
    <style>
      :root { --bg: #f7f4ee; --text: #25242a; }
      body { margin: 0; background: var(--bg); color: var(--text); font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
      .site-header { position: sticky; top: 0; z-index: 20; padding: 0.65rem 0; background: #fff; border-bottom: 1px solid rgba(0, 0, 0, 0.06); }
      .navbar { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; column-gap: 1.5rem; max-width: 72rem; margin: 0 auto; padding: 0 1rem; }
      .section { padding: 1.5rem 0; }
      .shell { max-width: 72rem; margin: 0 auto; padding: 0 1rem; }
      .seo-product-summary { display: grid; grid-template-columns: minmax(280px, 520px) minmax(320px, 1fr); gap: 1.5rem; }
      .seo-product-summary__image { display: block; width: 100%; height: auto; background: #f7f7f7; }
      .seo-product-summary__content h1 { margin-top: 0; }
      @media (max-width: 760px) { .seo-product-summary { grid-template-columns: 1fr; } }
    </style>
    <link rel="stylesheet" href="/css/styles.css" media="print" onload="this.media='all'" />
    <noscript><link rel="stylesheet" href="/css/styles.css" /></noscript>
  </head>
  <body class="page--product">
    <div class="site-frame">
      <header data-site-header></header>
      <main class="section section--tight">
        <div class="shell">
          <div data-product-detail>
            <article class="seo-product-summary">
              <img class="seo-product-summary__image" src="${escapeHtml(image)}" alt="${escapeHtml(product.name)}" width="800" height="800" fetchpriority="high" />
              <div class="seo-product-summary__content">
                <p class="eyebrow eyebrow--accent">Nitrile gloves</p>
                <h1>${escapeHtml(product.name)}</h1>
                <p>${escapeHtml(product.description || product.subtext || "")}</p>
                <p><strong>Starting at ${escapeHtml(visiblePrice(product))}</strong></p>
                ${specs ? `<div class="detail-block"><h2>Product details</h2><div class="spec-list">${specs}</div></div>` : ""}
              </div>
            </article>
          </div>
        </div>
      </main>
      <footer data-site-footer></footer>
    </div>
    <div class="toast-stack" data-toast-stack aria-live="polite" aria-atomic="true"></div>
    <script type="module" src="/js/product.js"></script>
  </body>
</html>`;
}

export function renderProductNotFoundPage() {
  return `<!doctype html><html lang="en"><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><meta name="robots" content="noindex, follow" /><title>Product Not Found | SAI Goods</title><link rel="stylesheet" href="/css/styles.css" /></head><body><main class="section"><div class="shell empty-state"><h1>Product not found.</h1><p>The requested item is not in the current SAI Goods catalog.</p><a class="button button--secondary" href="/">Return to the store</a></div></main></body></html>`;
}

export function renderSitemap(products, extraPaths = ["/", "/contact"]) {
  const paths = [
    ...extraPaths,
    ...(Array.isArray(products) ? products : []).map((product) => productPath(product.slug)),
  ];
  const unique = [...new Set(paths)];
  const urls = unique.map((path) => `  <url><loc>${escapeHtml(absoluteUrl(path))}</loc></url>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}
