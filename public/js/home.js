import { formatCurrency, getStore, storefrontSizesForProduct } from "./catalog.js";
import { responsiveRasterImg } from "./image-utils.js";
import { isProductStorefrontOutOfStock } from "./size-availability.js";
import { escapeHtml, initSite } from "./site.js";
import { trackViewItemList } from "./analytics.js";

const productGrid = document.querySelector("[data-product-grid]");

const PRODUCT_THICKNESS_BY_SLUG = {
  "nitrile-standard": "4 mil",
  "black-nitrile-general": "5 mil",
  "black-nitrile-heavy-duty": "8 mil",
};

let store;

/** Index catalog only — mirrors the 1-carton bundle (`case_1`); PDP uses full bundle + size selection. */
function catalogCardPriceLabel(product) {
  const case1 = product.bundles?.find((b) => b.id === "case_1");
  const cents = Number(case1?.priceCents);
  if (case1 && Number.isFinite(cents) && cents > 0) {
    return formatCurrency(cents);
  }
  return formatCurrency(product.priceCents);
}

document.addEventListener("DOMContentLoaded", init);

/** Persists for this tab only: survives refresh, clears when the tab is closed. */
const ANNOUNCEMENT_SESSION_KEY = "saigoods-free-delivery-announcement-v1";

function initAnnouncementBar() {
  const bar = document.querySelector("[data-announcement-bar]");
  if (!bar) return;

  try {
    if (sessionStorage.getItem(ANNOUNCEMENT_SESSION_KEY) === "1") {
      bar.hidden = true;
    }
  } catch {
    // ignore (e.g. storage disabled)
  }

  const closeBtn = bar.querySelector("[data-announcement-close]");
  closeBtn?.addEventListener("click", () => {
    bar.hidden = true;
    try {
      sessionStorage.setItem(ANNOUNCEMENT_SESSION_KEY, "1");
    } catch {
      // ignore
    }
  });
}

async function init() {
  initAnnouncementBar();
  store = await initSite({ page: "home" });

  renderCatalog(store.products);
  trackViewItemList(store.products);
}

function renderCatalog(products) {
  if (!products.length) {
    productGrid.innerHTML = `
      <div class="empty-state">
        <h3>Products are temporarily unavailable.</h3>
        <p>Please refresh the page or contact our sales team for assistance.</p>
        <a class="button button--secondary" href="/contact">Contact sales</a>
      </div>
    `;
    return;
  }

  productGrid.innerHTML = products
    .map((product) => {
      const cardOos = isProductStorefrontOutOfStock(product, storefrontSizesForProduct(product, store));
      const thickness = PRODUCT_THICKNESS_BY_SLUG[product.slug];
      const oosBlock = cardOos
        ? `<p class="product-card__oos" role="status">Out of stock</p>`
        : "";
      const cta = cardOos
        ? `<span class="button button--primary button--disabled" aria-disabled="true">Unavailable</span>`
        : `<a class="button button--primary" href="/products/${encodeURIComponent(product.slug)}">
                Buy this product
              </a>`;
      return `
        <article class="product-card product-card--${escapeHtml(product.intro.theme)}${cardOos ? " product-card--oos" : ""}" data-product-slug="${escapeHtml(product.slug)}">
          ${thickness ? `<span class="product-card__tag">${escapeHtml(thickness)}</span>` : ""}
          <div class="product-card__media">
            ${responsiveRasterImg(product.cardImage, {
              alt: product.name,
              loading: "lazy",
              sizes: "(max-width: 768px) 92vw, 33vw",
            })}
          </div>

          <div class="product-card__body">
            <h3>${escapeHtml(product.name)}</h3>
            <p class="product-card__price"><strong>${catalogCardPriceLabel(product)}</strong> <span>per carton</span></p>
            <div class="product-card__value" aria-label="50 pairs per box and ${escapeHtml(product.boxesPerCase || 10)} boxes per case">
              <span><strong>50 pairs per box</strong> <span aria-hidden="true">·</span> ${escapeHtml(product.boxesPerCase || 10)} boxes per case</span>
              <small>2× a typical 25-pair box</small>
            </div>
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
