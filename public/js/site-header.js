import { escapeHtml } from "./home-cards.js";

export function renderHeaderHtml(site, page) {
  const logoHref = page === "home" ? "#hero" : "/index.html#hero";
  const shopHref = page === "home" ? "#products" : "/index.html#products";
  const b2bHref = "/contact";
  const contactHref = "#contact";

  return `
    <div class="site-header">
      <div class="shell navbar">
        <a class="brand-mark" href="${logoHref}" aria-label="${escapeHtml(site.name)} home">
          <img src="/img/nav-logo.svg" alt="${escapeHtml(site.name)} logo" width="30" height="30" decoding="async" />
          <span class="brand-mark__name">${escapeHtml(site.legalName || site.name)}</span>
        </a>

        <div class="store-nav-backdrop" aria-hidden="true"></div>

        <nav class="store-nav" id="store-navigation" aria-label="Store navigation">
          <div class="store-nav__drawer-head">
            <button class="store-nav__close" type="button" aria-label="Close menu">
              <span aria-hidden="true"></span>
            </button>
          </div>
          <a href="${shopHref}">Shop</a>
          <a href="${b2bHref}">For business</a>
          <a href="${contactHref}">Contact</a>
        </nav>

        <button class="store-nav-toggle" type="button" aria-controls="store-navigation" aria-expanded="false" aria-label="Open menu">
          <span aria-hidden="true"></span>
          <span aria-hidden="true"></span>
          <span aria-hidden="true"></span>
        </button>

        ${page === "checkout" ? "" : `<a class="cart-link" ${page === "cart" ? 'aria-current="page" aria-disabled="true"' : 'href="/cart.html"'} aria-label="View cart">
          <span class="cart-link__icon">
          <img src="/img/cart-icon.svg" alt="" aria-hidden="true" width="22" height="22" decoding="async" />
          <span class="cart-link__count" data-cart-count hidden>0</span>
          </span>
        </a>`}
      </div>
    </div>
  `;
}

