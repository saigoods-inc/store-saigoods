import { formatCurrency, getStore, searchProducts } from "./catalog.js";
import { escapeHtml, initSite } from "./site.js";

const productGrid = document.querySelector("[data-product-grid]");
const introRoot = document.querySelector("[data-product-intros]");
const searchMeta = document.querySelector("[data-search-meta]");

const currentUrl = new URL(window.location.href);
let activeQuery = currentUrl.searchParams.get("search")?.trim() || "";
let store;

/** Index catalog only — mirrors the 1-case bundle (`case_1`); PDP uses full bundle + size selection. */
function catalogCardPriceLabel(product) {
  const case1 = product.bundles?.find((b) => b.id === "case_1");
  const cents = Number(case1?.priceCents);
  if (case1 && Number.isFinite(cents) && cents > 0) {
    return `${formatCurrency(cents)} per case`;
  }
  return `${formatCurrency(product.priceCents)} per case`;
}

document.addEventListener("DOMContentLoaded", init);

/** Persists for this tab only: survives refresh, clears when the tab is closed. */
const ANNOUNCEMENT_SESSION_KEY = "saigoods-announcement-dismissed";

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
  store = await initSite({
    page: "home",
    searchValue: activeQuery,
    onSearchChange: (query) => handleSearch(query),
    onSearchSubmit: (query) => handleSearchSubmit(query),
  });

  renderIntroPanels(store.products);
  applySearch(activeQuery);
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
            <p class="product-card__price">${catalogCardPriceLabel(product)}</p>
            <p class="product-card__copy">${escapeHtml(product.subtext)}</p>

            <div class="product-card__actions">
              <a class="button button--primary" href="/product.html?slug=${encodeURIComponent(product.slug)}">
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
