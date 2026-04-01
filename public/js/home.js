import { getStore, searchProducts } from "./catalog.js";
import { mergeProductQuantities } from "./cart-store.js";
import { escapeHtml, initSite, showToast } from "./site.js";

const productGrid = document.querySelector("[data-product-grid]");
const introRoot = document.querySelector("[data-product-intros]");
const searchMeta = document.querySelector("[data-search-meta]");

const currentUrl = new URL(window.location.href);
let activeQuery = currentUrl.searchParams.get("search")?.trim() || "";
let store;

document.addEventListener("DOMContentLoaded", init);

async function init() {
  store = await initSite({
    page: "home",
    searchValue: activeQuery,
    onSearchChange: (query) => handleSearch(query),
    onSearchSubmit: (query) => handleSearchSubmit(query),
  });

  renderIntroPanels(store.products);
  applySearch(activeQuery);
  productGrid.addEventListener("click", handleCatalogClick);
}

function handleSearch(query) {
  applySearch(query);
  return true;
}

function handleSearchSubmit(query) {
  applySearch(query);
  document.querySelector("#products")?.scrollIntoView({ behavior: "smooth", block: "start" });
  return true;
}

function applySearch(query) {
  activeQuery = query.trim();
  const results = searchProducts(store.products, activeQuery);

  renderCatalog(results);
  renderSearchMeta(results.length);
  syncUrl();
}

function renderCatalog(products) {
  if (!products.length) {
    productGrid.innerHTML = `
      <div class="empty-state">
        <h3>No products match that search.</h3>
        <p>Try keywords like "black", "heavy", "medical", or "powder free".</p>
        <a class="button button--secondary" href="/index.html#products">Clear search</a>
      </div>
    `;
    return;
  }

  productGrid.innerHTML = products
    .map((product) => {
      return `
        <article class="product-card product-card--${escapeHtml(product.intro.theme)}">
          <div class="product-card__media">
            <img src="${escapeHtml(product.cardImage)}" alt="${escapeHtml(product.name)}" loading="lazy" />
          </div>

          <div class="product-card__body">
            <h3>${escapeHtml(product.name)}</h3>
            <p class="product-card__price">$${(product.priceCents / 100).toFixed(2)}</p>
            <p class="product-card__copy">${escapeHtml(product.subtext)}</p>

            <div class="product-card__actions">
              <button class="button button--primary" type="button" data-action="add" data-slug="${escapeHtml(product.slug)}">
                Add to cart
              </button>
              <a class="button button--secondary" href="/product.html?slug=${encodeURIComponent(product.slug)}">
                View product
              </a>
            </div>
          </div>
        </article>
      `;
    })
    .join("");
}

function renderSearchMeta(resultCount) {
  if (!activeQuery) {
    searchMeta.innerHTML = "";
    return;
  }

  searchMeta.innerHTML = `
    <p>
      Showing <strong>${resultCount}</strong> result${resultCount === 1 ? "" : "s"} for
      "<strong>${escapeHtml(activeQuery)}</strong>".
    </p>
  `;
}

function renderIntroPanels(products) {
  introRoot.innerHTML = products
    .map((product, index) => {
      return `
        <section class="intro-panel intro-panel--${escapeHtml(product.intro.theme)}">
          <div class="intro-panel__grid ${index % 2 === 1 ? "intro-panel__grid--reverse" : ""}">
            <div class="intro-panel__copy">
              <p class="eyebrow eyebrow--accent">${escapeHtml(product.intro.eyebrow)}</p>
              <h2>${escapeHtml(product.intro.headline)}</h2>
              ${
                product.slug === "nitrile-standard" ||
                product.slug === "black-nitrile-general" ||
                product.slug === "black-nitrile-heavy-duty"
                  ? `
                <p class="intro-panel__subheading">
                  ${
                    product.slug === "nitrile-standard"
                      ? "Standard"
                      : product.slug === "black-nitrile-general"
                        ? "General Purpose"
                        : "Heavy Duty"
                  }
                </p>
              `
                  : ""
              }
              <p class="intro-panel__body">${escapeHtml(product.intro.body)}</p>

              <ul class="feature-list">
                ${product.intro.features
                  .map(
                    (feature) => `
                      <li>
                        <img src="/img/check-icon.svg" alt="" aria-hidden="true" />
                        <span>${escapeHtml(feature)}</span>
                      </li>
                    `,
                  )
                  .join("")}
              </ul>
            </div>

            <div class="intro-panel__media">
              <img src="${escapeHtml(product.intro.image)}" alt="${escapeHtml(product.name)} gloves" loading="lazy" />
            </div>
          </div>
        </section>
      `;
    })
    .join("");
}

function handleCatalogClick(event) {
  const button = event.target.closest("[data-action='add']");

  if (!button || !store) {
    return;
  }

  const { slug } = button.dataset;
  mergeProductQuantities(slug, { Medium: 1 }, store.site.sizes);
  showToast("Added 1 medium case to your cart.", "success");
}

function syncUrl() {
  const nextUrl = new URL(window.location.href);

  if (activeQuery) {
    nextUrl.searchParams.set("search", activeQuery);
    nextUrl.hash = "products";
  } else {
    nextUrl.searchParams.delete("search");
    nextUrl.hash = "";
  }

  window.history.replaceState({}, "", `${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`);
}
