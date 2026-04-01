import { createCheckout, formatCaseLabel, formatCurrency, getProduct } from "./catalog.js";
import { getQuantitiesTotal, mergeProductQuantities } from "./cart-store.js";
import { escapeHtml, initSite, setButtonBusy, showToast } from "./site.js";

const productRoot = document.querySelector("[data-product-detail]");
const currentUrl = new URL(window.location.href);
const slug = currentUrl.searchParams.get("slug");

let store;
let product;
let selectedImageIndex = 0;
let isCheckingOut = false;
let selectedQuantities = {};
let customer = null;

document.addEventListener("DOMContentLoaded", init);

async function init() {
  store = await initSite({ page: "product" });
  product = await getProduct(slug);

  if (!product) {
    renderMissingProduct();
    return;
  }

  selectedQuantities = store.site.sizes.reduce((result, size) => {
    result[size] = size === "Medium" ? 1 : 0;
    return result;
  }, {});

  renderProduct();
  productRoot.addEventListener("click", handleProductClick);
}

function renderProduct() {
  const thumbIndexes = product.gallery.slice(0, 4).map((_, index) => index);
  const totalCases = getQuantitiesTotal(selectedQuantities);
  const totalPrice = totalCases * product.priceCents;

  productRoot.innerHTML = `
    <section class="product-layout">
      <div class="product-gallery">
        <div class="product-gallery__thumbs">
          ${thumbIndexes
            .map(
              (index) => `
                <button
                  class="product-gallery__thumb ${selectedImageIndex === index ? "is-active" : ""}"
                  type="button"
                  data-thumb-index="${index}"
                  aria-label="View product image ${index + 1}"
                >
                  <img src="${escapeHtml(product.gallery[index])}" alt="${escapeHtml(product.name)} image ${index + 1}" />
                </button>
              `,
            )
            .join("")}
        </div>

        <div class="product-gallery__main">
          <img src="${escapeHtml(product.gallery[selectedImageIndex])}" alt="${escapeHtml(product.name)} main image" />
        </div>
      </div>

      <div class="product-info">
        <h2>${escapeHtml(product.name)}</h2>
        <p class="product-info__copy">${escapeHtml(product.description)}</p>

        <div class="detail-block">
          <h3>About this item</h3>
          <div class="spec-list">
            ${product.specs
              .map(
                (spec) => `
                  <div class="spec-list__row">
                    <span>${escapeHtml(spec.label)}</span>
                    <strong>${escapeHtml(spec.value)}</strong>
                  </div>
                `,
              )
              .join("")}
          </div>
        </div>

        <div class="detail-block">
          <h3>Size &amp; Quantity</h3>
          <div class="size-grid">
            ${store.site.sizes
              .map(
                (size) => `
                  <div class="size-card">
                    <span class="size-card__label">${escapeHtml(size)}</span>
                    <div class="qty-control">
                      <button type="button" data-action="decrease" data-size="${escapeHtml(size)}" aria-label="Reduce ${escapeHtml(size)} quantity">
                        -
                      </button>
                      <strong>${selectedQuantities[size]}</strong>
                      <button type="button" data-action="increase" data-size="${escapeHtml(size)}" aria-label="Increase ${escapeHtml(size)} quantity">
                        +
                      </button>
                    </div>
                  </div>
                `,
              )
              .join("")}
          </div>
        </div>

        <div class="selection-summary">
          <div>
            <span class="selection-summary__price">${formatCurrency(product.priceCents)}</span>
            <span class="selection-summary__label">per case</span>
          </div>
          <p>
            Selected: <strong>${formatCaseLabel(totalCases)}</strong>
            <span>${formatCurrency(totalPrice)}</span>
          </p>
        </div>

        <div class="product-actions">
          <button class="button button--primary button--with-icon" type="button" data-action="add-to-cart" ${
            totalCases === 0 ? "disabled" : ""
          }>
            <img src="/img/cart-icon.svg" alt="" aria-hidden="true" class="button__icon" />
            <span>Add to cart</span>
          </button>
          <button
            class="button button--secondary"
            type="button"
            data-action="checkout"
            ${totalCases === 0 || isCheckingOut ? "disabled" : ""}
          >
            Go to checkout
          </button>
        </div>

        <p class="inline-note">
          Cart totals are recalculated on the backend before checkout so your payment amount stays in sync.
        </p>
      </div>
    </section>
  `;
}

function renderMissingProduct() {
  productRoot.innerHTML = `
    <div class="empty-state">
      <h2>Product not found.</h2>
      <p>The item you requested is not in the current SAI Goods catalog.</p>
      <a class="button button--secondary" href="/index.html#products">Return to the store</a>
    </div>
  `;
}

async function handleProductClick(event) {
  const target = event.target.closest("[data-thumb-index], [data-action]");

  if (!target || !product) {
    return;
  }

  if (target.dataset.thumbIndex) {
    selectedImageIndex = Number(target.dataset.thumbIndex);
    renderProduct();
    return;
  }

  const action = target.dataset.action;

  if (action === "increase" || action === "decrease") {
    const size = target.dataset.size;
    const delta = action === "increase" ? 1 : -1;
    selectedQuantities[size] = Math.max(0, selectedQuantities[size] + delta);
    renderProduct();
    return;
  }

  if (action === "add-to-cart") {
    mergeProductQuantities(product.slug, selectedQuantities, store.site.sizes);
    showToast(`Added ${formatCaseLabel(getQuantitiesTotal(selectedQuantities))} to your cart.`, "success");
    return;
  }

  if (action === "checkout") {
    mergeProductQuantities(product.slug, selectedQuantities, store.site.sizes);
    window.location.href = "/cart.html";
  }
}
