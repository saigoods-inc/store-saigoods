import { getStore } from "./catalog.js";
import { getCartCount } from "./cart-store.js";
import { initAnalytics } from "./analytics.js";

export async function initSite({ page } = {}) {
  void initAnalytics();
  const store = await getStore();

  renderHeader(store.site, page);
  initHeaderNavigation();
  renderFooter(store.site);
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

function renderHeader(site, page) {
  const headerRoot = document.querySelector("[data-site-header]");

  if (!headerRoot) {
    return;
  }

  const logoHref = page === "home" ? "#hero" : "/index.html#hero";
  const shopHref = page === "home" ? "#products" : "/index.html#products";
  const b2bHref = page === "home" ? "#b2b" : "/index.html#b2b";
  const contactHref = page === "home" ? "#contact" : "/contact";

  headerRoot.innerHTML = `
    <div class="site-header">
      <div class="shell navbar">
        <a class="brand-mark" href="${logoHref}" aria-label="${escapeHtml(site.name)} home">
          <img src="/img/nav-logo.svg" alt="${escapeHtml(site.name)} logo" width="30" height="30" decoding="async" />
          <span class="brand-mark__name">SAI Goods Store</span>
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

        <a class="cart-link" href="/cart.html" aria-label="View cart">
          <img src="/img/cart-icon.svg" alt="" aria-hidden="true" width="22" height="22" decoding="async" />
          <span class="cart-link__count" data-cart-count hidden>0</span>
        </a>
      </div>
    </div>
  `;
}

function initHeaderNavigation() {
  const toggle = document.querySelector(".store-nav-toggle");
  const navigation = document.querySelector(".store-nav");
  const backdrop = document.querySelector(".store-nav-backdrop");
  const closeButton = document.querySelector(".store-nav__close");
  const mobileNavigation = window.matchMedia("(max-width: 760px)");

  if (!toggle || !navigation || !backdrop || !closeButton) {
    return;
  }

  function setOpen(open, { returnFocus = false } = {}) {
    toggle.setAttribute("aria-expanded", String(open));
    toggle.setAttribute("aria-label", open ? "Close menu" : "Open menu");
    navigation.classList.toggle("is-open", open);
    backdrop.classList.toggle("is-visible", open);
    document.body.classList.toggle("nav-drawer-open", open);
    navigation.toggleAttribute("inert", mobileNavigation.matches && !open);

    if (mobileNavigation.matches && !open) {
      navigation.setAttribute("aria-hidden", "true");
    } else {
      navigation.removeAttribute("aria-hidden");
    }

    if (open) {
      closeButton.focus();
    } else if (returnFocus) {
      toggle.focus();
    }
  }

  toggle.addEventListener("click", () => {
    setOpen(toggle.getAttribute("aria-expanded") !== "true");
  });

  closeButton.addEventListener("click", () => {
    setOpen(false, { returnFocus: true });
  });

  backdrop.addEventListener("click", () => {
    setOpen(false, { returnFocus: true });
  });

  navigation.addEventListener("click", (event) => {
    if (event.target instanceof Element && event.target.closest("a")) {
      setOpen(false);
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && toggle.getAttribute("aria-expanded") === "true") {
      setOpen(false, { returnFocus: true });
    }
  });

  mobileNavigation.addEventListener("change", () => {
    setOpen(false);
  });

  setOpen(false);
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
              <img src="/img/nav-logo.svg" alt="${escapeHtml(site.legalName)} logo" class="brand__logo" width="44" height="44" decoding="async" />
              <span class="brand__name">${escapeHtml(site.legalName)}</span>
            </div>
            <address class="brand__address">
              ${site.addressLines.map((line) => escapeHtml(line)).join("<br>")}
            </address>
          </div>

          <div class="widget">
            <h3 class="widget__title">POLICIES</h3>
            <nav class="footer-links" aria-label="Customer policies">
              <a href="/shipping">Shipping policy</a>
              <a href="/returns">Returns &amp; refunds</a>
              <a href="/privacy">Privacy policy</a>
            </nav>
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
              <img src="/img/facebook-icon.svg" alt="" aria-hidden="true" width="24" height="24" decoding="async" />
            </a>
            <a
              href="https://www.linkedin.com/company/sai-goods-inc/"
              target="_blank"
              rel="noreferrer"
              aria-label="LinkedIn"
            >
              <img src="/img/linkedin-icon.svg" alt="" aria-hidden="true" width="24" height="24" decoding="async" />
            </a>
          </div>
        </div>
      </div>
    </div>
  `;
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
