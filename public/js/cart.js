import { createCheckout, formatCartUnitLabel, formatSizeLineText, getCartQuote } from "./catalog.js";
import { clearCart, getCart, removeProduct } from "./cart-store.js";
import { responsiveRasterImg } from "./image-utils.js";
import { escapeHtml, initSite, setButtonBusy, showToast } from "./site.js";

const cartRoot = document.querySelector("[data-cart-root]");
const currentUrl = new URL(window.location.href);

let store;
let quote = null;
let isCheckingOut = false;

document.addEventListener("DOMContentLoaded", init);

async function init() {
  store = await initSite({ page: "cart" });
  handleCheckoutReturn();
  cartRoot.addEventListener("click", handleCartClick);
  await refreshQuote();
}

async function refreshQuote() {
  const items = getCart(store.site.sizes);

  if (!items.length) {
    quote = null;
    renderCart();
    return;
  }

  if (store?.site?.storefrontGlobalOutOfStock) {
    quote = null;
    renderCart();
    return;
  }

  try {
    quote = await getCartQuote(items);
  } catch (error) {
    quote = null;
    showToast(error.message, "error");
  }

  renderCart();
}

function renderCart() {
  const items = getCart(store.site.sizes);
  const globalOos = Boolean(store?.site?.storefrontGlobalOutOfStock);
  const packageLimitBlocked = quote?.shippingPackageLimit?.exceeded === true;

  if (!items.length) {
    cartRoot.innerHTML = `
      <section class="page-heading">
        <h1>Your cart</h1>
      </section>

      <div class="empty-state empty-state--wide">
        <h3>Your cart is empty.</h3>
        <p>Add products from the catalog, then come back here to review your order summary.</p>
        <a class="button button--primary" href="/index.html#products">Continue shopping</a>
      </div>
    `;
    return;
  }

  if (globalOos) {
    const lines = items.length === 1 ? "1 saved line" : `${items.length} saved lines`;
    cartRoot.innerHTML = `
      <section class="page-heading">
        <h1>Your cart</h1>
      </section>

      <div class="empty-state empty-state--wide cart-blocked-global-oos">
        <h3>Purchases are temporarily unavailable</h3>
        <p class="cart-blocked-global-oos__hint">
          We're restocking. ${lines} in your cart can't be checked out right now. You can clear the cart or keep it until we're back in stock.
        </p>
        <p class="cart-blocked-global-oos__subtle">This product is currently out of stock. We're restocking soon.</p>
        <div class="cart-blocked-global-oos__actions">
          <button type="button" class="button button--secondary" data-action="clear-cart-global-oos">Clear cart</button>
          <a class="button button--primary" href="/index.html#products">Continue shopping</a>
        </div>
      </div>
    `;
    return;
  }

  if (!quote || !quote.items.length) {
    cartRoot.innerHTML = `
      <section class="page-heading">
        <h1>Your cart</h1>
      </section>

      <div class="empty-state empty-state--wide">
        <h3>Your cart is empty.</h3>
        <p>Add products from the catalog, then come back here to review your order summary.</p>
        <a class="button button--primary" href="/index.html#products">Continue shopping</a>
      </div>
    `;
    return;
  }

  cartRoot.innerHTML = `
    <section class="page-heading">
      <h1>Your cart</h1>
    </section>

    <section class="cart-layout">
      <div class="cart-items">
        ${quote.items.map((item) => renderCartItem(item, store.site.sizes)).join("")}
      </div>

      <aside class="summary-card">
        <h2>Order Summary</h2>
        <div class="summary-card__rows">
          <div class="summary-card__row">
            <span>Merchandise total</span>
            <strong>${quote.subtotalFormatted}</strong>
          </div>
        </div>

        <div class="summary-card__breakdown">
          ${renderOrderBreakdown(quote, store.site.sizes)}
        </div>

        ${
          quote.useEmbeddedCheckout
            ? `<a
                class="button button--primary button--full"
                ${packageLimitBlocked ? "" : 'href="/checkout.html"'}
                ${!quote.squareReady || packageLimitBlocked ? 'aria-disabled="true" tabindex="-1" style="pointer-events:none;opacity:0.6"' : ""}
              >
                Proceed to checkout
              </a>`
            : `<button
                class="button button--primary button--full"
                type="button"
                data-action="checkout"
                ${!quote.squareReady || packageLimitBlocked || isCheckingOut ? "disabled" : ""}
              >
                Proceed to checkout
              </button>`
        }

        ${
          quote.squareReady
            ? ""
            : `<p class="summary-card__note">Checkout is not fully configured yet. Add Square (including <strong>SQUARE_APPLICATION_ID</strong> for on-site pay), Supabase, and related environment variables on the server.</p>`
        }

        ${
          packageLimitBlocked
            ? `<p class="summary-card__note cart-package-limit-message">
                ${escapeHtml(
                  quote?.shippingPackageLimit?.message ||
                    "This order exceeds the current shipping-package limit. Please reduce the quantity or complete your current order before adding more.",
                )}
              </p>`
            : ""
        }
      </aside>
    </section>
  `;
}

function combinedSizeLineHtml(size, quantities, boxQuantities) {
  const line = formatSizeLineText(size, quantities, boxQuantities);
  if (!line) {
    return null;
  }
  return escapeHtml(line);
}

function renderOrderBreakdown(currentQuote, sizes) {
  if (!currentQuote?.items?.length) {
    return "";
  }

  const sizeOrder =
    Array.isArray(sizes) && sizes.length
      ? sizes
      : [...new Set([...Object.keys(currentQuote.items[0].quantities || {})])];

  return currentQuote.items
    .map((item) => {
      const lines = sizeOrder
        .map((size) => combinedSizeLineHtml(size, item.quantities, item.boxQuantities))
        .filter(Boolean)
        .map(
          (html) => `
            <div class="summary-card__row summary-card__row--size">
              <span>${html}</span>
            </div>
          `,
        )
        .join("");

      if (!lines) {
        return "";
      }

      return `
        <div class="summary-card__product">
          <p class="summary-card__product-name">${escapeHtml(item.name)}</p>
          ${lines}
        </div>
      `;
    })
    .join("");
}

function renderCartItemSummary(item, sizes) {
  const sizeOrder =
    Array.isArray(sizes) && sizes.length
      ? sizes
      : [
          ...new Set([
            ...Object.keys(item.quantities || {}),
            ...Object.keys(item.boxQuantities || {}),
          ]),
        ];

  const rows = sizeOrder
    .map((size) => combinedSizeLineHtml(size, item.quantities, item.boxQuantities))
    .filter(Boolean)
    .map((html) => `<li>${html}</li>`);

  if (!rows.length) {
    return `<p class="cart-card__summary-empty">—</p>`;
  }

  return `<ul class="cart-card__summary-list">${rows.join("")}</ul>`;
}

function renderCartItem(item, sizes) {
  const slugEnc = encodeURIComponent(item.slug);
  const productHref = `/product.html?slug=${slugEnc}`;

  return `
    <article class="cart-card" data-slug="${escapeHtml(item.slug)}">
      <div class="cart-card__media">
        ${responsiveRasterImg(item.cardImage, {
          alt: item.name,
          loading: "lazy",
          sizes: "160px",
        })}
      </div>

      <div class="cart-card__body">
        <div class="cart-card__topline">
          <div>
            <h3>${escapeHtml(item.name)}</h3>
            <p class="cart-card__meta">${escapeHtml(formatCartUnitLabel(item))} · ${escapeHtml(item.lineTotalFormatted)}</p>
          </div>

          <div class="cart-card__actions">
            <a
              class="cart-card__icon-btn"
              href="${productHref}"
              aria-label="Edit ${escapeHtml(item.name)} on product page"
            >
              <img src="/img/edit-icon.svg" alt="" aria-hidden="true" width="20" height="20" />
            </a>
            <button
              type="button"
              class="cart-card__icon-btn"
              data-action="remove"
              aria-label="Remove ${escapeHtml(item.name)} from cart"
            >
              <img src="/img/trash-icon.svg" alt="" aria-hidden="true" width="20" height="20" />
            </button>
          </div>
        </div>

        <div class="cart-card__summary">
          ${renderCartItemSummary(item, sizes)}
        </div>
      </div>
    </article>
  `;
}

async function handleCartClick(event) {
  const target = event.target.closest("[data-action]");

  if (!target || !store) {
    return;
  }

  const action = target.dataset.action;

  if (action === "clear-cart-global-oos") {
    clearCart(store.site.sizes);
    await refreshQuote();
    showToast("Cart cleared.", "success");
    return;
  }

  if (action === "checkout") {
    await startCheckout(target);
    return;
  }

  const itemRoot = target.closest("[data-slug]");
  const slug = itemRoot?.dataset.slug;

  if (!slug) {
    return;
  }

  if (action === "remove") {
    removeProduct(slug, store.site.sizes);
    await refreshQuote();
    showToast("Item removed from your cart.", "success");
  }
}

async function startCheckout(button) {
  if (store?.site?.storefrontGlobalOutOfStock) {
    showToast("This product is currently out of stock. We're restocking soon.", "error");
    return;
  }
  try {
    isCheckingOut = true;
    setButtonBusy(button, true, "Redirecting...");
    const response = await createCheckout(getCart(store.site.sizes));
    window.location.href = response.checkoutUrl;
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    isCheckingOut = false;
    setButtonBusy(button, false);
    renderCart();
  }
}

function handleCheckoutReturn() {
  const checkoutState = currentUrl.searchParams.get("checkout");

  if (!checkoutState) {
    return;
  }

  if (checkoutState === "success") {
    clearCart();
    showToast("Payment completed. Your local cart has been cleared.", "success");
  }

  if (checkoutState === "cancelled") {
    showToast("Checkout was cancelled. Your cart is still available.", "error");
  }

  currentUrl.searchParams.delete("checkout");
  currentUrl.searchParams.delete("session_id");
  currentUrl.searchParams.delete("order_id");
  window.history.replaceState({}, "", `${currentUrl.pathname}${currentUrl.search}`);
}
