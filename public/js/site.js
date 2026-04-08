import { getStore } from "./catalog.js";
import { getCartCount } from "./cart-store.js";

export async function initSite({
  page,
  searchValue = "",
  onSearchChange = null,
  onSearchSubmit = null,
} = {}) {
  const store = await getStore();

  renderHeader(store.site, page, searchValue);
  renderFooter(store.site);
  bindSearch(store.products, onSearchChange, onSearchSubmit);
  updateCartBadges();

  window.addEventListener("cart:updated", updateCartBadges);

  return store;
}

const TOAST_VISIBLE_MS = 3200;
const TOAST_REMOVE_MS = 220;

export function showToast(message, tone = "default") {
  const toastStack = document.querySelector("[data-toast-stack]");

  if (!toastStack) {
    return;
  }

  const toast = document.createElement("div");
  toast.className = `toast toast--${tone}`;
  toast.textContent = message;
  toastStack.append(toast);

  let hideTimeoutId = null;
  let removeTimeoutId = null;

  function clearTimers() {
    if (hideTimeoutId !== null) {
      window.clearTimeout(hideTimeoutId);
      hideTimeoutId = null;
    }
    if (removeTimeoutId !== null) {
      window.clearTimeout(removeTimeoutId);
      removeTimeoutId = null;
    }
  }

  function startRemoveAfterFade() {
    removeTimeoutId = window.setTimeout(() => {
      removeTimeoutId = null;
      toast.remove();
    }, TOAST_REMOVE_MS);
  }

  function dismiss() {
    clearTimers();
    toast.classList.remove("is-visible");
    startRemoveAfterFade();
  }

  function scheduleDismiss() {
    clearTimers();
    hideTimeoutId = window.setTimeout(() => {
      hideTimeoutId = null;
      dismiss();
    }, TOAST_VISIBLE_MS);
  }

  toast.addEventListener("mouseenter", () => {
    clearTimers();
  });

  toast.addEventListener("mouseleave", () => {
    scheduleDismiss();
  });

  requestAnimationFrame(() => {
    toast.classList.add("is-visible");
  });

  scheduleDismiss();
}

export function setButtonBusy(button, busy, busyLabel) {
  if (!button) {
    return;
  }

  if (!button.dataset.defaultLabel) {
    button.dataset.defaultLabel = button.textContent.trim();
  }

  if (busy) {
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    button.textContent = busyLabel || button.dataset.defaultLabel;
    return;
  }

  button.disabled = false;
  button.removeAttribute("aria-busy");
  button.textContent = button.dataset.defaultLabel;
}

export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderHeader(site, page, searchValue) {
  const headerRoot = document.querySelector("[data-site-header]");

  if (!headerRoot) {
    return;
  }

  const logoHref = page === "home" ? "#hero" : "/index.html#hero";

  headerRoot.innerHTML = `
    <div class="site-header">
      <div class="shell navbar">
        <a class="brand-mark" href="${logoHref}" aria-label="${escapeHtml(site.name)} home">
          <img src="/img/nav-logo.svg" alt="${escapeHtml(site.name)} logo" />
        </a>

        <form class="search-form" data-global-search>
          <button class="search-form__button" type="submit" aria-label="Search products">
            <img src="/img/search-icon.svg" alt="" aria-hidden="true" />
          </button>
          <input
            type="search"
            name="query"
            value="${escapeHtml(searchValue)}"
            placeholder="Search for your product here"
            aria-label="Search for gloves"
            autocomplete="off"
          />
        </form>

        <a class="cart-link" href="/cart.html" aria-label="View cart">
          <img src="/img/cart-icon.svg" alt="" aria-hidden="true" />
          <span class="cart-link__count" data-cart-count hidden>0</span>
        </a>
      </div>
    </div>
  `;
}

function renderFooter(site) {
  const footerRoot = document.querySelector("[data-site-footer]");

  if (!footerRoot) {
    return;
  }

  const year = new Date().getFullYear();

  footerRoot.innerHTML = `
    <div class="footer" id="contact" role="contentinfo">
      <div class="shell footer__content">
        <div class="footer__top">
          <div class="brand widget">
            <div class="brand__row">
              <img src="/img/nav-logo.svg" alt="${escapeHtml(site.legalName)} logo" class="brand__logo" />
              <span class="brand__name">${escapeHtml(site.legalName)}</span>
            </div>
            <address class="brand__address">
              ${site.addressLines.map((line) => escapeHtml(line)).join("<br>")}
            </address>
          </div>

          <div class="widget">
            <h3 class="widget__title">CONTACT</h3>
            <div class="widget__list">
              <address class="contact">
                <div class="contact__label">Sales inquiry</div>
                <a href="mailto:${escapeHtml(site.email)}" class="contact__value">${escapeHtml(
                  site.email,
                )}</a>
              </address>

              <address class="contact">
                <div class="contact__label">Phone</div>
                <a href="tel:+16152437512" class="contact__value">${escapeHtml(site.phone)}</a>
              </address>
            </div>
          </div>

          <div class="widget">
            <h3 class="widget__title">CREDENTIALS</h3>
            <div class="widget__list">
              <div class="credential">
                <div class="credential__label">D-U-N-S®</div>
                <div class="credential__value">${escapeHtml(site.duns)}</div>
              </div>

              <div class="credential">
                <div class="credential__label">SAM.gov UNIQUE ENTITY ID (UEI)</div>
                <div class="credential__value">${escapeHtml(site.uei)}</div>
              </div>

              <div class="credential">
                <div class="credential__label">SAM.gov Cage Code</div>
                <div class="credential__value">${escapeHtml(site.cage)}</div>
              </div>
            </div>
          </div>
        </div>

        <hr class="rule" />

        <div class="footer__bottom">
          <p class="rights">© ${year}, All Rights Reserved</p>
          <div class="social" aria-label="Social links">
            <a
              href="https://www.facebook.com"
              target="_blank"
              rel="noreferrer"
              aria-label="Facebook"
            >
              <img src="/img/facebook-icon.svg" alt="" aria-hidden="true" />
            </a>
            <a
              href="https://www.linkedin.com/company/sai-goods-inc/"
              target="_blank"
              rel="noreferrer"
              aria-label="LinkedIn"
            >
              <img src="/img/linkedin-icon.svg" alt="" aria-hidden="true" />
            </a>
          </div>
        </div>
      </div>
    </div>
  `;
}

function bindSearch(products, onSearchChange, onSearchSubmit) {
  const searchForm = document.querySelector("[data-global-search]");
  const searchInput = searchForm?.querySelector("input");

  if (!searchForm || !searchInput) {
    return;
  }

  if (typeof onSearchChange === "function") {
    searchInput.addEventListener("input", () => {
      onSearchChange(searchInput.value, products);
    });
  }

  searchForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const query = searchInput.value.trim();

    if (typeof onSearchSubmit === "function") {
      const handled = onSearchSubmit(query, products);

      if (handled) {
        return;
      }
    }

    const destination = new URL("/index.html", window.location.origin);

    if (query) {
      destination.searchParams.set("search", query);
      destination.hash = "products";
    }

    window.location.href = destination.toString();
  });
}

function updateCartBadges() {
  const count = getCartCount();

  document.querySelectorAll("[data-cart-count]").forEach((badge) => {
    if (!count) {
      badge.hidden = true;
      badge.textContent = "0";
      return;
    }

    badge.hidden = false;
    badge.textContent = count > 99 ? "99+" : String(count);
  });
}
