import { formatCurrency } from "./catalog.js";
import { responsiveRasterImg } from "./image-utils.js";

export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const PRODUCT_THICKNESS_BY_SLUG = {
  "nitrile-standard": "4 mil",
  "black-nitrile-general": "5 mil",
  "black-nitrile-heavy-duty": "8 mil",
};

function renderCardPrice(priceCents) {
  const formatted = formatCurrency(priceCents);
  const [dollars, cents] = formatted.replace(/^\$/, "").split(".");
  return `<span class="home-visually-hidden">${escapeHtml(formatted)}</span><strong aria-hidden="true"><sup>$</sup>${escapeHtml(dollars)}<sup>${escapeHtml(cents)}</sup></strong>`;
}

export function renderCatalogCards(products) {
  if (!products.length) {
    return `
      <div class="empty-state">
        <h3>Products are temporarily unavailable.</h3>
        <p>Please refresh the page or contact our sales team for assistance.</p>
        <a class="button button--secondary" href="/contact">Contact sales</a>
      </div>
    `;
  }

  return products
    .map((product) => {
      const offer = product.storefront?.featuredOffer;
      const cardOos = product.storefront?.available === false;
      const thickness = PRODUCT_THICKNESS_BY_SLUG[product.slug];
      const oosBlock = cardOos
        ? `<p class="product-card__oos" role="status">Out of stock</p>`
        : "";
      const cta = cardOos
        ? `<span class="button button--primary button--disabled" aria-disabled="true">Unavailable</span>`
        : `<a class="button button--primary" href="/products/${encodeURIComponent(product.slug)}" aria-label="Choose sizes and bundles for ${escapeHtml(product.name)}">
                <svg width="20" height="18" viewBox="0 0 17 15" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M8.5 0C8.70625 0 8.90312 0.084375 9.04375 0.234375L13.5437 4.98438L13.5594 5H16C16.5531 5 17 5.44687 17 6C17 6.45312 16.7 6.83438 16.2875 6.95938L14.8469 13.4344C14.6437 14.35 13.8313 15 12.8938 15H4.10313C3.16563 15 2.35313 14.35 2.15 13.4344L0.7125 6.95938C0.3 6.8375 0 6.45312 0 6C0 5.44687 0.446875 5 1 5H3.44063L3.45625 4.98438L7.95625 0.234375C8.09688 0.084375 8.29375 0 8.5 0ZM8.5 1.84063L5.50625 5H11.4937L8.5 1.84063ZM6 8.25C6 7.83437 5.66563 7.5 5.25 7.5C4.83437 7.5 4.5 7.83437 4.5 8.25V11.75C4.5 12.1656 4.83437 12.5 5.25 12.5C5.66563 12.5 6 12.1656 6 11.75V8.25ZM8.5 7.5C8.08437 7.5 7.75 7.83437 7.75 8.25V11.75C7.75 12.1656 8.08437 12.5 8.5 12.5C8.91563 12.5 9.25 12.1656 9.25 11.75V8.25C9.25 7.83437 8.91563 7.5 8.5 7.5ZM12.5 8.25C12.5 7.83437 12.1656 7.5 11.75 7.5C11.3344 7.5 11 7.83437 11 8.25V11.75C11 12.1656 11.3344 12.5 11.75 12.5C12.1656 12.5 12.5 12.1656 12.5 11.75V8.25Z" fill="currentColor"/></svg>
                <span class="product-card__buy-label">Buy this product</span>
              </a>`;
      return `
        <article class="product-card product-card--${escapeHtml(product.intro.theme)}${cardOos ? " product-card--oos" : ""}" data-product-slug="${escapeHtml(product.slug)}">
          <a class="product-card__mobile-link" href="/products/${encodeURIComponent(product.slug)}" aria-label="View ${escapeHtml(product.name)}"></a>
          <div class="product-card__media">
            ${responsiveRasterImg(product.cardImage, {
              alt: product.name,
              loading: "lazy",
              sizes: "(max-width: 800px) 36vw, 33vw",
            })}
          </div>

          <div class="product-card__body">
            <p class="product-card__brand">LYDUS®</p>
            <p class="product-card__price">${offer ? `${renderCardPrice(offer.priceCents)} <span>per case${offer.available ? "" : " · unavailable"}</span>` : `<span>See available options</span>`}</p>
            <div class="product-card__heading">
            <h3>${escapeHtml(thickness || "")} ${escapeHtml(product.name)}</h3></div>
            <p class="product-card__copy">${escapeHtml(product.subtext)}</p>
            ${oosBlock}
            <div class="product-card__actions">
              ${cta}
            </div>
          </div>
        </article>
      `;
    })
    .join("");
}
