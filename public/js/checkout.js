import { formatCartUnitLabel, formatSizeLineText, getCartQuote } from "./catalog.js";
import { clearCart, getCart } from "./cart-store.js";
import { escapeHtml, initSite, setButtonBusy, showToast } from "./site.js";

const root = document.querySelector("[data-checkout-root]");

const US_STATE_CODES = [
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA", "HI", "ID", "IL", "IN", "IA", "KS", "KY",
  "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND",
  "OH", "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY", "DC",
];

/** Local styling preview: `?preview-checkout-success=1` on localhost only (no payment / Square needed). */
function isPreviewCheckoutSuccess() {
  if (typeof window === "undefined" || !window.location) {
    return false;
  }
  const h = window.location.hostname;
  const local = h === "localhost" || h === "127.0.0.1";
  return local && new URLSearchParams(window.location.search).get("preview-checkout-success") === "1";
}

const PREVIEW_CHECKOUT_LINE = {
  name: "Nitrile Examination – Standard",
  slug: "nitrile-preview",
  lineCases: 10,
  lineBoxCount: 6,
  lineTotalFormatted: "$690.97",
  quantities: { Small: 3, Medium: 3, Large: 2, "X Large": 2 },
  boxQuantities: { Small: 2, Medium: 2, Large: 1, "X Large": 1 },
};

let store;
let items = [];
let latestEstimate = null;
let cardInstance = null;

document.addEventListener("DOMContentLoaded", init);

async function init() {
  store = await initSite({ page: "cart" });
  items = getCart(store.site.sizes);

  if (!items.length && !isPreviewCheckoutSuccess()) {
    window.location.replace("/cart.html");
    return;
  }

  if (isPreviewCheckoutSuccess()) {
    let miniQuote;
    try {
      miniQuote = items.length ? await getCartQuote(items) : null;
    } catch {
      miniQuote = null;
    }
    if (!miniQuote?.items?.length) {
      miniQuote = {
        items: [PREVIEW_CHECKOUT_LINE],
        subtotalFormatted: "$690.97",
      };
    }
    renderCheckoutShell(miniQuote, { skipInitialEstimate: true });
    latestEstimate = { items: miniQuote.items };
    showCheckoutSuccessModal({
      orderId: "00000000-0000-0000-0000-000000000001",
      orderRef: "SAI-PREVIEW",
      totalFormatted: "$690.97",
    });
    return;
  }

  let config;
  try {
    const res = await fetch("/api/square-config");
    config = await res.json();
    if (!res.ok) {
      throw new Error(config.error || "Checkout is not configured.");
    }
    if (!config.squareApplicationId) {
      throw new Error("Square embedded checkout is not configured.");
    }
  } catch (e) {
    const setupNote =
      "Add <strong>SQUARE_APPLICATION_ID</strong> (and your other Square keys) in the server environment, then redeploy.";
    root.innerHTML = `
      <div class="empty-state empty-state--wide">
        <h2>Checkout unavailable</h2>
        <p>${escapeHtml(e.message || "Could not load payment configuration.")}</p>
        <p class="summary-card__note">
          ${setupNote}
        </p>
        <a class="button button--secondary" href="/cart.html">Back to cart</a>
      </div>
    `;
    return;
  }

  await loadSquareWebSdk();
  let miniQuote;
  try {
    miniQuote = await getCartQuote(items);
  } catch {
    miniQuote = { items: [] };
  }
  renderCheckoutShell(miniQuote);
  await initSquareCard(config.squareApplicationId, config.squareLocationId);
  wireEvents();
  wireCheckoutFieldClearErrors();
}

function loadSquareWebSdk() {
  if (window.Square) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://web.squarecdn.com/v1/square.js";
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Could not load Square Web Payments SDK."));
    document.head.appendChild(s);
  });
}

function renderCheckoutShell(miniQuote, options = {}) {
  const stateOptions = US_STATE_CODES.map(
    (code) => `<option value="${code}">${code}</option>`,
  ).join("");

  root.innerHTML = `
    <section class="page-heading">
      <h1>Checkout</h1>
    </section>

    <section class="checkout-layout">
      <div class="checkout-form">
        <h2 class="checkout-section-title">Contact</h2>
        <div class="checkout-field-grid">
          <label class="checkout-field checkout-field--full">
            <span><span class="checkout-field-required" aria-hidden="true">*</span> Full name</span>
            <input type="text" name="name" autocomplete="name" required aria-required="true" />
          </label>
          <label class="checkout-field">
            <span><span class="checkout-field-required" aria-hidden="true">*</span> Email</span>
            <input type="email" name="email" autocomplete="email" required aria-required="true" />
          </label>
          <label class="checkout-field">
            <span><span class="checkout-field-required" aria-hidden="true">*</span> Phone</span>
            <input type="tel" name="phone" autocomplete="tel" required aria-required="true" />
          </label>
        </div>

        <h2 class="checkout-section-title">Shipping address</h2>
        <p id="checkout-shipping-error" class="checkout-shipping-error" role="alert" hidden></p>
        <div class="checkout-field-grid">
          <label class="checkout-field checkout-field--full">
            <span>Street address</span>
            <input type="text" name="line1" autocomplete="address-line1" required />
          </label>
          <label class="checkout-field checkout-field--full">
            <span>Apt, suite, etc. <span class="checkout-optional">(optional)</span></span>
            <input type="text" name="line2" autocomplete="address-line2" />
          </label>
          <label class="checkout-field">
            <span>City</span>
            <input type="text" name="city" autocomplete="address-level2" required />
          </label>
          <label class="checkout-field">
            <span>State</span>
            <select name="state" required>
              <option value="">Select</option>
              ${stateOptions}
            </select>
          </label>
          <label class="checkout-field">
            <span>ZIP code</span>
            <input type="text" name="postalCode" inputmode="numeric" autocomplete="postal-code" required />
          </label>
        </div>

        <button type="button" class="button button--secondary" id="checkout-update-totals">
          Update shipping &amp; tax
        </button>

        <h2 class="checkout-section-title">Hardin County discount <span class="checkout-optional">(optional)</span></h2>
        <p class="checkout-discount-hint">
          Eligible Hardin County, TN deliveries: enter your one-time code (format <strong>HC-XXXXX</strong>). Pricing is validated on our servers when you update totals and when you pay.
        </p>
        <label class="checkout-field checkout-field--full">
          <span>Discount code</span>
          <input
            type="text"
            name="discountCode"
            autocomplete="off"
            autocapitalize="characters"
            spellcheck="false"
            placeholder="e.g. HC-7F3K2"
          />
        </label>

        <h2 class="checkout-section-title">Payment</h2>
        <p class="checkout-card-hint">Card details are processed by Square. We never see your full card number.</p>
        <div id="sq-card-container" class="sq-card-container"></div>

        <button type="button" class="button button--primary button--full" id="checkout-pay">
          Pay now
        </button>

        <p class="checkout-footnote">
          <a href="/cart.html">← Back to cart</a>
        </p>
      </div>

      <aside class="summary-card checkout-summary" aria-live="polite">
        <h2>Order summary</h2>
        <div id="checkout-lines" class="checkout-lines"></div>
        <div class="summary-card__rows checkout-totals">
          <div class="summary-card__row">
            <span>Merchandise</span>
            <strong id="sum-sub">—</strong>
          </div>
          <div class="summary-card__row">
            <span>Shipping</span>
            <strong id="sum-ship">—</strong>
          </div>
          <div class="summary-card__row summary-card__row--tax">
            <span>Estimated tax</span>
            <strong id="sum-tax">—</strong>
          </div>
          <div class="summary-card__row summary-card__row--total">
            <span>Total due</span>
            <strong id="sum-total">—</strong>
          </div>
        </div>
        <div id="checkout-warnings" class="checkout-warnings" hidden></div>
      </aside>
    </section>
  `;

  renderLineItems(miniQuote, store.site.sizes);
  const sumSub = document.getElementById("sum-sub");
  if (sumSub && miniQuote?.subtotalFormatted) {
    sumSub.textContent = miniQuote.subtotalFormatted;
  }
  // Initial estimate on load should not complain about missing contact/address.
  // Keep Shipping / Estimated tax as "—" until the shopper clicks "Update shipping & tax".
  if (!options.skipInitialEstimate) {
    void runEstimate({ validateContact: false, requireAddress: false, initialSummary: true });
  }
}

function readAddressFromForm() {
  const form = root;
  const line1 = form.querySelector('[name="line1"]')?.value?.trim() || "";
  const line2 = form.querySelector('[name="line2"]')?.value?.trim() || "";
  const city = form.querySelector('[name="city"]')?.value?.trim() || "";
  const state = form.querySelector('[name="state"]')?.value?.trim() || "";
  const postalCode = form.querySelector('[name="postalCode"]')?.value?.trim() || "";
  return { line1, line2, city, state, postalCode, country: "US" };
}

function readContactFromForm() {
  const form = root;
  return {
    name: form.querySelector('[name="name"]')?.value?.trim() || "",
    email: form.querySelector('[name="email"]')?.value?.trim() || "",
    phone: form.querySelector('[name="phone"]')?.value?.trim() || "",
  };
}

function readDiscountCode() {
  return root.querySelector('[name="discountCode"]')?.value?.trim() || "";
}

/** Order summary: show "Free" when shipping is $0. */
function shippingDisplayFromEstimate(data) {
  const cents = Math.max(0, Math.round(Number(data?.shippingCents) || 0));
  if (cents === 0) {
    return "Free";
  }
  return data.shippingFormatted || "—";
}

/** US-oriented: at least 10 digits (ignores formatting). */
function isValidPhone(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  return digits.length >= 10;
}

/** Basic email shape: local@domain.tld (requires @ and a dot in the domain). */
function isValidEmail(email) {
  const s = email.trim();
  if (!s.includes("@")) {
    return false;
  }
  const parts = s.split("@");
  if (parts.length !== 2) {
    return false;
  }
  const domain = parts[1];
  return Boolean(domain && domain.includes("."));
}

function clearCheckoutInputErrors() {
  const selectors = ['[name="line1"]', '[name="city"]', '[name="state"]', '[name="postalCode"]'];
  for (const sel of selectors) {
    const input = root.querySelector(sel);
    if (input?.classList?.contains("checkout-input--error")) {
      input.classList.remove("checkout-input--error");
    }
  }
}

function clearShippingSectionError() {
  const el = document.getElementById("checkout-shipping-error");
  if (!el) {
    return;
  }
  el.hidden = true;
  el.textContent = "";
}

function showShippingSectionError(message) {
  const el = document.getElementById("checkout-shipping-error");
  if (!el) {
    return;
  }
  el.textContent = message;
  el.hidden = false;
}

function setAddressFieldsError(on) {
  const selectors = ['[name="line1"]', '[name="city"]', '[name="state"]', '[name="postalCode"]'];
  for (const sel of selectors) {
    const input = root.querySelector(sel);
    if (!input) {
      continue;
    }
    input.classList.toggle("checkout-input--error", on);
  }
}

/**
 * @returns {boolean} true if name, email, and phone are valid.
 */
function applyContactValidationErrors() {
  const contact = readContactFromForm();
  const nameInput = root.querySelector('[name="name"]');
  const emailInput = root.querySelector('[name="email"]');
  const phoneInput = root.querySelector('[name="phone"]');
  let ok = true;
  if (nameInput?.classList?.contains("checkout-input--error")) {
    nameInput.classList.remove("checkout-input--error");
  }
  if (emailInput?.classList?.contains("checkout-input--error")) {
    emailInput.classList.remove("checkout-input--error");
  }
  if (phoneInput?.classList?.contains("checkout-input--error")) {
    phoneInput.classList.remove("checkout-input--error");
  }
  if (!contact.name) {
    nameInput?.classList.add("checkout-input--error");
    ok = false;
  }
  if (!contact.email || !isValidEmail(contact.email)) {
    emailInput?.classList.add("checkout-input--error");
    ok = false;
  }
  if (!contact.phone || !isValidPhone(contact.phone)) {
    phoneInput?.classList.add("checkout-input--error");
    ok = false;
  }
  return ok;
}

async function runEstimate(options = {}) {
  const validateContact = options.validateContact === true;
  const requireAddress = options.requireAddress === true;
  const initialSummary = options.initialSummary === true;
  const address = readAddressFromForm();
  const sumShip = document.getElementById("sum-ship");
  const sumTax = document.getElementById("sum-tax");
  const sumTotal = document.getElementById("sum-total");
  const sumSub = document.getElementById("sum-sub");
  const warningsEl = document.getElementById("checkout-warnings");

  clearCheckoutInputErrors();
  clearShippingSectionError();

  if (validateContact && !applyContactValidationErrors()) {
    return;
  }

  if (
    requireAddress &&
    (!address.line1 || !address.city || !address.state || !address.postalCode)
  ) {
    setAddressFieldsError(true);
    showShippingSectionError("Please complete your shipping address.");
    return;
  }

  try {
    const dc = readDiscountCode();
    const payload = { items, address };
    if (dc) {
      payload.discountCode = dc;
    }

    const res = await fetch("/api/checkout-estimate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || "Could not calculate totals.");
    }

    latestEstimate = data;
    sumSub.textContent = data.subtotalFormatted;
    if (initialSummary) {
      sumShip.textContent = "—";
      sumTax.textContent = "—";
    } else {
      sumShip.textContent = shippingDisplayFromEstimate(data);
      sumTax.textContent = data.taxFormatted;
    }
    sumTotal.textContent = data.totalFormatted;

    if (warningsEl) {
      const w = Array.isArray(data.warnings) ? [...data.warnings] : [];
      if (data.hardinDiscountBlocked === "incomplete_address" && readDiscountCode()) {
        w.push(
          'Complete your shipping address and click "Update shipping & tax" to apply your Hardin County discount code.',
        );
      }
      if (data.hardinDiscountApplied) {
        w.push("Hardin County discount pricing is applied to this order summary.");
      }
      if (w.length) {
        warningsEl.hidden = false;
        warningsEl.innerHTML = w
          .map((x) => `<p class="summary-card__note">${escapeHtml(x)}</p>`)
          .join("");
      } else {
        warningsEl.hidden = true;
        warningsEl.innerHTML = "";
      }
    }
  } catch (e) {
    setAddressFieldsError(true);
    showShippingSectionError(e.message || "Could not verify shipping address.");
    sumShip.textContent = "—";
    sumTax.textContent = "—";
    sumTotal.textContent = "—";
    latestEstimate = null;
  }
}

function renderCheckoutSizeHtml(item, sizes) {
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
    .map((size) => formatSizeLineText(size, item.quantities, item.boxQuantities))
    .filter(Boolean)
    .map((line) => `<li>${escapeHtml(line)}</li>`);

  if (!rows.length) {
    return "";
  }

  return `<ul class="checkout-line__sizes">${rows.join("")}</ul>`;
}

function renderLineItems(miniQuote, sizes) {
  const el = document.getElementById("checkout-lines");
  if (!el) {
    return;
  }

  const rows = (miniQuote?.items || [])
    .map((item) => {
      const name = escapeHtml(item.name || item.slug);
      const meta = `${escapeHtml(formatCartUnitLabel(item))} · ${escapeHtml(item.lineTotalFormatted)}`;
      const sizesHtml = renderCheckoutSizeHtml(item, sizes);
      return `<div class="checkout-line"><div class="checkout-line__name">${name}</div><div class="checkout-line__meta">${meta}</div>${sizesHtml}</div>`;
    })
    .join("");
  el.innerHTML = rows || "<p>Your cart items</p>";
}

/**
 * Full-screen confirmation after successful payment; closes → cart (already cleared).
 */
function showCheckoutSuccessModal({ orderId, orderRef, totalFormatted }) {
  const quoteItems = Array.isArray(latestEstimate?.items) ? latestEstimate.items : [];
  const sizes = Array.isArray(store?.site?.sizes) ? store.site.sizes : [];

  const sizeOrderForItem = (it) =>
    sizes.length
      ? sizes
      : [
          ...new Set([
            ...Object.keys(it.quantities || {}),
            ...Object.keys(it.boxQuantities || {}),
          ]),
        ];

  const productsHtml = quoteItems.length
    ? `<ul class="checkout-success-modal__products" aria-label="Items ordered">
        ${quoteItems
          .map((it) => {
            const name = escapeHtml(it.name || it.slug);
            const unit = escapeHtml(formatCartUnitLabel(it));
            const sizeLines = sizeOrderForItem(it)
              .map((size) => formatSizeLineText(size, it.quantities, it.boxQuantities))
              .filter(Boolean)
              .map((line) => `<li>${escapeHtml(line)}</li>`)
              .join("");
            const sizesBlock = sizeLines
              ? `<ul class="checkout-success-modal__sizes">${sizeLines}</ul>`
              : "";
            return `<li class="checkout-success-modal__product">
              <div class="checkout-success-modal__product-name">${name}</div>
              <div class="checkout-success-modal__product-meta">${unit}</div>
              ${sizesBlock}
            </li>`;
          })
          .join("")}
      </ul>`
    : "";

  const refLine = orderRef
    ? `<p class="checkout-success-modal__order-ref"><strong>Order reference</strong> ${escapeHtml(String(orderRef))}</p>`
    : "";
  const idLine =
    orderId != null && String(orderId).trim()
      ? `<p class="checkout-success-modal__order-id"><span class="checkout-success-modal__label">Order ID</span> <code>${escapeHtml(String(orderId))}</code></p>`
      : "";
  const totalLine = totalFormatted
    ? `<p class="checkout-success-modal__total"><strong>Total paid</strong> ${escapeHtml(String(totalFormatted))}</p>`
    : "";

  const existing = document.getElementById("checkout-success-modal");
  if (existing) {
    existing.remove();
  }

  const wrap = document.createElement("div");
  wrap.id = "checkout-success-modal";
  wrap.className = "checkout-success-modal";
  wrap.setAttribute("role", "dialog");
  wrap.setAttribute("aria-modal", "true");
  wrap.setAttribute("aria-labelledby", "checkout-success-heading");
  wrap.innerHTML = `
    <div class="checkout-success-modal__backdrop" data-checkout-success-dismiss tabindex="-1"></div>
    <div class="checkout-success-modal__card">
      <button type="button" class="checkout-success-modal__close" id="checkout-success-close" aria-label="Close">
        <span aria-hidden="true">&times;</span>
      </button>
      <div class="checkout-success-modal__content">
        <h2 id="checkout-success-heading" class="checkout-success-modal__title">
          Order completed.<br />
          <span class="checkout-success-modal__title-line2">Thank you for your purchase!</span>
        </h2>
        <p class="checkout-success-modal__message">
          We&rsquo;ll ship your order shortly. You&rsquo;ll receive a shipping notification with tracking information once it&rsquo;s on the way.
        </p>
        <div class="checkout-success-modal__summary">
          <h3 class="checkout-success-modal__summary-title">Order summary</h3>
          ${refLine}
          ${idLine}
          ${totalLine}
          ${productsHtml}
        </div>
        <p class="checkout-success-modal__support">
          If you have any questions, please contact us at
          <a href="mailto:sales@saigoods.com">sales@saigoods.com</a>.
        </p>
      </div>
    </div>
  `;

  document.body.appendChild(wrap);
  const prevOverflow = document.body.style.overflow;
  document.body.style.overflow = "hidden";

  const close = () => {
    document.removeEventListener("keydown", onKeyDown);
    wrap.remove();
    document.body.style.overflow = prevOverflow;
    window.location.href = "/cart.html";
  };

  function onKeyDown(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  }

  document.addEventListener("keydown", onKeyDown);

  wrap.querySelector(".checkout-success-modal__backdrop")?.addEventListener("click", close);
  wrap.querySelector("#checkout-success-close")?.addEventListener("click", close);
  wrap.querySelector(".checkout-success-modal__card")?.addEventListener("click", (e) => e.stopPropagation());
  wrap.addEventListener("click", (e) => {
    if (e.target === wrap) {
      close();
    }
  });

  requestAnimationFrame(() => {
    document.getElementById("checkout-success-close")?.focus();
  });
}

async function initSquareCard(applicationId, locationId) {
  const payments = window.Square.payments(applicationId, locationId);
  cardInstance = await payments.card();
  await cardInstance.attach("#sq-card-container");
}

function wireCheckoutFieldClearErrors() {
  root.addEventListener("input", (e) => {
    const t = e.target;
    if (!t?.classList?.contains("checkout-input--error")) {
      return;
    }
    t.classList.remove("checkout-input--error");
    if (t.matches?.('[name="line1"], [name="city"], [name="postalCode"]')) {
      clearShippingSectionError();
    }
  });
  root.addEventListener("change", (e) => {
    const t = e.target;
    if (t?.name === "state" && t.classList.contains("checkout-input--error")) {
      t.classList.remove("checkout-input--error");
      clearShippingSectionError();
    }
  });
}

function wireEvents() {
  document.getElementById("checkout-update-totals")?.addEventListener("click", () => {
    if (!applyContactValidationErrors()) {
      return;
    }
    void runEstimate({ validateContact: false, requireAddress: true });
  });

  document.getElementById("checkout-pay")?.addEventListener("click", async () => {
    const payBtn = document.getElementById("checkout-pay");
    const contact = readContactFromForm();
    const address = readAddressFromForm();

    clearCheckoutInputErrors();
    clearShippingSectionError();

    if (!applyContactValidationErrors()) {
      return;
    }
    if (!address.line1 || !address.city || !address.state || !address.postalCode) {
      setAddressFieldsError(true);
      showShippingSectionError("Please complete your shipping address.");
      return;
    }

    if (!latestEstimate) {
      setAddressFieldsError(true);
      showShippingSectionError('Click "Update shipping & tax" first, or fix any address errors.');
      return;
    }

    setButtonBusy(payBtn, true, "Processing…");

    let checkoutSucceeded = false;
    try {
      const tokenResult = await cardInstance.tokenize();
      if (tokenResult.status !== "OK") {
        const msg =
          tokenResult.errors?.map((e) => e.message).join(" ") || "Card could not be verified.";
        throw new Error(msg);
      }

      const payBody = {
        items,
        address,
        email: contact.email,
        phone: contact.phone,
        name: contact.name || undefined,
        sourceId: tokenResult.token,
      };
      const dcPay = readDiscountCode();
      if (dcPay) {
        payBody.discountCode = dcPay;
      }

      const res = await fetch("/api/checkout-pay", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payBody),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Payment failed.");
      }

      clearCart();
      checkoutSucceeded = true;
      showCheckoutSuccessModal({
        orderId: data.orderId,
        orderRef: data.orderRef,
        totalFormatted: data.totalFormatted,
      });
    } catch (e) {
      showToast(e.message, "error");
    } finally {
      if (!checkoutSucceeded) {
        setButtonBusy(payBtn, false);
      }
    }
  });
}
