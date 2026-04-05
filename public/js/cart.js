import { createCheckout, formatCaseLabel, getCartQuote } from "./catalog.js";
import { clearCart, getCart, removeProduct, updateSizeQuantity } from "./cart-store.js";
import { escapeHtml, initSite, setButtonBusy, showToast } from "./site.js";

const cartRoot = document.querySelector("[data-cart-root]");
const checkoutForm = document.querySelector("[data-checkout-form]");
const currentUrl = new URL(window.location.href);

let store;
let quote = null;
let isCheckingOut = false;

let quoteRefreshTimer;

document.addEventListener("DOMContentLoaded", init);

async function init() {
  store = await initSite({ page: "cart" });
  handleCheckoutReturn();
  cartRoot.addEventListener("click", handleCartClick);
  checkoutForm?.addEventListener("submit", handleCheckoutSubmit);
  checkoutForm?.addEventListener("input", (event) => {
    if (event.target?.id === "zipCode") {
      window.clearTimeout(quoteRefreshTimer);
      quoteRefreshTimer = window.setTimeout(() => {
        refreshQuote();
      }, 350);
    }
  });
  await refreshQuote();
}

function getCheckoutZipValue() {
  const el = checkoutForm?.querySelector("#zipCode");
  return el?.value?.trim() || "";
}

async function refreshQuote() {
  const items = getCart(store.site.sizes);

  if (!items.length) {
    quote = null;
    renderCart();
    return;
  }

  try {
    quote = await getCartQuote(items, getCheckoutZipValue());
  } catch (error) {
    quote = null;
    showToast(error.message, "error");
  }

  renderCart();
}

function renderCart() {
  if (!quote || !quote.items.length) {
    cartRoot.innerHTML = `
      <section class="page-heading">
        <h1>Your cart</h1>
      </section>

      <div class="empty-state empty-state--wide">
        <h3>Your cart is empty.</h3>
        <p>Add products from the catalog, then come back here to review the backend-priced order summary.</p>
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
        ${quote.items.map(renderCartItem).join("")}
      </div>

      <aside class="summary-card">
        <h2>Order Summary</h2>
        <div class="summary-card__rows">
          <div class="summary-card__row">
            <span>Total cases</span>
            <strong>${quote.totalCases}</strong>
          </div>
          <div class="summary-card__row">
            <span>Subtotal</span>
            <strong>${quote.subtotalFormatted}</strong>
          </div>
          <div class="summary-card__row">
            <span>Shipping (UPS Ground est.)</span>
            <strong>${quote.shippingQuoteComplete ? quote.shippingFormatted : "Enter ZIP"}</strong>
          </div>
          <div class="summary-card__row">
            <span>Estimated total</span>
            <strong>${quote.shippingQuoteComplete ? quote.totalFormatted : "—"}</strong>
          </div>
        </div>

        <div class="summary-card__breakdown">
          ${renderOrderBreakdown(quote)}
        </div>

        <button
          class="button button--primary button--full"
          type="submit"
          form="checkout-form"
          ${!quote.squareReady || !quote.shippingQuoteComplete || isCheckingOut ? "disabled" : ""}
        >
          Proceed to checkout
        </button>

        <p class="summary-card__note">
          ${
            quote.shippingQuoteComplete
              ? quote.squareReady
                ? "Your final payment includes UPS Ground shipping from your ZIP and uses Square-hosted checkout."
                : "Checkout is not fully configured yet. Add Square and email environment variables on the server to enable live payments."
              : "Enter a 5-digit U.S. shipping ZIP code to calculate shipping and continue."
          }
        </p>
      </aside>
    </section>
  `;
}

function renderOrderBreakdown(currentQuote) {
  if (!currentQuote?.items?.length) {
    return "";
  }

  return currentQuote.items
    .map((item) => {
      const sizeLines = Object.entries(item.quantities)
        .filter(([_, count]) => Number(count) > 0)
        .map(
          ([size, count]) => `
            <div class="summary-card__row summary-card__row--size">
              <span>${escapeHtml(size)}</span>
              <strong>${count}</strong>
            </div>
          `,
        )
        .join("");

      if (!sizeLines) {
        return "";
      }

      return `
        <div class="summary-card__product">
          <p class="summary-card__product-name">${escapeHtml(item.name)}</p>
          ${sizeLines}
        </div>
      `;
    })
    .join("");
}

function renderCartItem(item) {
  return `
    <article class="cart-card" data-slug="${escapeHtml(item.slug)}">
      <div class="cart-card__media">
        <img src="${escapeHtml(item.cardImage)}" alt="${escapeHtml(item.name)}" />
      </div>

      <div class="cart-card__body">
        <div class="cart-card__topline">
          <div>
            <h3>${escapeHtml(item.name)}</h3>
            <p class="cart-card__meta">${formatCaseLabel(item.lineCases)} selected · ${escapeHtml(item.lineTotalFormatted)}</p>
          </div>

          <button class="cart-card__remove" type="button" data-action="remove" aria-label="Remove ${escapeHtml(item.name)} from cart">
            <img src="/img/trash-icon.svg" alt="" aria-hidden="true" />
          </button>
        </div>

        <div class="cart-card__size-grid">
          ${Object.entries(item.quantities)
            .map(
              ([size, quantity]) => `
                <div class="size-card">
                  <span class="size-card__label">${escapeHtml(size)}</span>
                  <div class="qty-control">
                    <button type="button" data-action="decrease" data-size="${escapeHtml(size)}" aria-label="Reduce ${escapeHtml(size)} quantity">
                      -
                    </button>
                    <strong>${quantity}</strong>
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
    </article>
  `;
}

async function handleCartClick(event) {
  const target = event.target.closest("[data-action]");

  if (!target || !store) {
    return;
  }

  const action = target.dataset.action;

  if (action === "checkout") {
    // Checkout is now handled by the form submit.
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
    return;
  }

  if (action === "increase" || action === "decrease") {
    const size = target.dataset.size;
    const currentItem = quote?.items.find((entry) => entry.slug === slug);
    const currentQuantity = currentItem?.quantities?.[size] || 0;
    const nextQuantity = action === "increase" ? currentQuantity + 1 : currentQuantity - 1;

    updateSizeQuantity(slug, size, nextQuantity, store.site.sizes);
    await refreshQuote();
  }
}

async function startCheckout(button) {
  try {
    isCheckingOut = true;
    setButtonBusy(button, true, "Redirecting...");
    const customer = getCustomerDetails();
    const response = await createCheckout(getCart(store.site.sizes), customer);
    window.location.href = response.checkoutUrl;
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    isCheckingOut = false;
    setButtonBusy(button, false);
    renderCart();
  }
}

async function handleCheckoutSubmit(event) {
  event.preventDefault();

  if (!store || isCheckingOut) {
    return;
  }

  const submitButton = checkoutForm.querySelector("[type='submit']");

  await startCheckout(submitButton);
}

function getCustomerDetails() {
  if (!checkoutForm) {
    return {};
  }

  const formData = new FormData(checkoutForm);

  return {
    name: formData.get("fullName") || "",
    email: formData.get("email") || "",
    phone: formData.get("phone") || "",
    zipCode: formData.get("zipCode") || "",
    address: formData.get("address") || "",
  };
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
