import { formatCartUnitLabel, getCartQuote } from "./catalog.js";
import { clearCart, getCart } from "./cart-store.js";
import { escapeHtml, initSite, setButtonBusy, showToast } from "./site.js";

const root = document.querySelector("[data-checkout-root]");

const US_STATE_CODES = [
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA", "HI", "ID", "IL", "IN", "IA", "KS", "KY",
  "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND",
  "OH", "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY", "DC",
];

let store;
let items = [];
let latestEstimate = null;
let cardInstance = null;

document.addEventListener("DOMContentLoaded", init);

async function init() {
  store = await initSite({ page: "cart" });
  items = getCart(store.site.sizes);

  if (!items.length) {
    window.location.replace("/cart.html");
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

function renderCheckoutShell(miniQuote) {
  const stateOptions = US_STATE_CODES.map(
    (code) => `<option value="${code}">${code}</option>`,
  ).join("");

  root.innerHTML = `
    <section class="page-heading">
      <h1>Checkout</h1>
      <p class="checkout-lead">
        Enter your shipping address once. Shipping is free. We collect Tennessee sales tax on orders shipped to TN only; other states show $0 tax for now.
      </p>
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
            <span>Phone <span class="checkout-optional">(optional)</span></span>
            <input type="tel" name="phone" autocomplete="tel" />
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

  renderLineItems(miniQuote);
  const sumSub = document.getElementById("sum-sub");
  if (sumSub && miniQuote?.subtotalFormatted) {
    sumSub.textContent = miniQuote.subtotalFormatted;
  }
  void runEstimate({ validateContact: false });
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
 * @returns {boolean} true if name and email are present and email is valid.
 */
function applyContactValidationErrors() {
  const contact = readContactFromForm();
  const nameInput = root.querySelector('[name="name"]');
  const emailInput = root.querySelector('[name="email"]');
  let ok = true;
  if (nameInput?.classList?.contains("checkout-input--error")) {
    nameInput.classList.remove("checkout-input--error");
  }
  if (emailInput?.classList?.contains("checkout-input--error")) {
    emailInput.classList.remove("checkout-input--error");
  }
  if (!contact.name) {
    nameInput?.classList.add("checkout-input--error");
    ok = false;
  }
  if (!contact.email || !isValidEmail(contact.email)) {
    emailInput?.classList.add("checkout-input--error");
    ok = false;
  }
  return ok;
}

async function runEstimate(options = {}) {
  const validateContact = options.validateContact === true;
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

  try {
    const res = await fetch("/api/checkout-estimate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items, address }),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || "Could not calculate totals.");
    }

    latestEstimate = data;
    sumSub.textContent = data.subtotalFormatted;
    sumShip.textContent = data.shippingFormatted;
    sumTax.textContent = data.taxFormatted;
    sumTotal.textContent = data.totalFormatted;

    if (warningsEl) {
      const w = Array.isArray(data.warnings) ? data.warnings : [];
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

function renderLineItems(miniQuote) {
  const el = document.getElementById("checkout-lines");
  if (!el) {
    return;
  }

  const rows = (miniQuote?.items || [])
    .map((item) => {
      const name = escapeHtml(item.name || item.slug);
      const meta = `${escapeHtml(formatCartUnitLabel(item))} · ${escapeHtml(item.lineTotalFormatted)}`;
      return `<div class="checkout-line"><div class="checkout-line__name">${name}</div><div class="checkout-line__meta">${meta}</div></div>`;
    })
    .join("");
  el.innerHTML = rows || "<p>Your cart items</p>";
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
    const contact = readContactFromForm();
    const nameInput = root.querySelector('[name="name"]');
    const emailInput = root.querySelector('[name="email"]');

    if (!contact.name) {
      nameInput?.classList.add("checkout-input--error");
    }
    if (!contact.email || !isValidEmail(contact.email)) {
      emailInput?.classList.add("checkout-input--error");
    }

    void runEstimate({ validateContact: false });
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

    try {
      const tokenResult = await cardInstance.tokenize();
      if (tokenResult.status !== "OK") {
        const msg =
          tokenResult.errors?.map((e) => e.message).join(" ") || "Card could not be verified.";
        throw new Error(msg);
      }

      const res = await fetch("/api/checkout-pay", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items,
          address,
          email: contact.email,
          phone: contact.phone || undefined,
          name: contact.name || undefined,
          sourceId: tokenResult.token,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Payment failed.");
      }

      clearCart();
      showToast(`Paid ${data.totalFormatted}. Thank you!`, "success");
      window.setTimeout(() => {
        window.location.href = "/cart.html?checkout=success";
      }, 600);
    } catch (e) {
      showToast(e.message, "error");
    } finally {
      setButtonBusy(payBtn, false);
    }
  });
}
