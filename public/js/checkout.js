import { formatCartUnitLabel, formatSizeLineText, getCartQuote } from "./catalog.js";
import { clearCart, getCart } from "./cart-store.js";
import { escapeHtml, initSite, setButtonBusy, showToast } from "./site.js";

const root = document.querySelector("[data-checkout-root]");

/** Backend discount-validation messages → show under discount header (not shipping). */
const CHECKOUT_DISCOUNT_ERROR_PREFIXES = [
  "This discount code is invalid or not applicable to this address.",
  "Enter a valid discount code",
  "That discount code is not valid.",
  "This discount code has already been used.",
];

function isCheckoutDiscountApiError(message) {
  const m = String(message || "").trim();
  if (!m) {
    return false;
  }
  if (m.includes("just used by another order")) {
    return true;
  }
  return CHECKOUT_DISCOUNT_ERROR_PREFIXES.some((p) => m === p || m.startsWith(p));
}

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
            <span id="checkout-err-line1" class="checkout-field-error" role="alert" hidden></span>
          </label>
          <label class="checkout-field checkout-field--full">
            <span>Apt, suite, etc. <span class="checkout-optional">(optional)</span></span>
            <input type="text" name="line2" autocomplete="address-line2" />
          </label>
          <label class="checkout-field">
            <span>City</span>
            <input type="text" name="city" autocomplete="address-level2" required />
            <span id="checkout-err-city" class="checkout-field-error" role="alert" hidden></span>
          </label>
          <label class="checkout-field">
            <span>State</span>
            <select name="state" required>
              <option value="">Select</option>
              ${stateOptions}
            </select>
            <span id="checkout-err-state" class="checkout-field-error" role="alert" hidden></span>
          </label>
          <label class="checkout-field">
            <span>ZIP code</span>
            <input type="text" name="postalCode" inputmode="numeric" autocomplete="postal-code" required />
            <span id="checkout-err-postalCode" class="checkout-field-error" role="alert" hidden></span>
          </label>
        </div>

        <div id="checkout-address-suggestion" class="checkout-address-suggestion" hidden>
          <p class="checkout-address-suggestion__label">Did you mean this address?</p>
          <p id="checkout-address-suggestion-body" class="checkout-address-suggestion__body"></p>
          <button
            type="button"
            class="button button--secondary checkout-address-suggestion__apply"
            id="checkout-apply-suggested-address"
          >
            Use suggested address
          </button>
        </div>

        <div class="checkout-discount-block">
          <h2 class="checkout-section-title">Discount code <span class="checkout-optional">(optional)</span></h2>
          <p id="checkout-discount-warning" class="checkout-discount-warning" role="alert" hidden></p>
          <label class="checkout-field checkout-field--full">
            <input
              type="text"
              name="discountCode"
              autocomplete="off"
              autocapitalize="characters"
              spellcheck="false"
            />
          </label>
          <button type="button" class="button button--secondary button--full checkout-confirm-address" id="checkout-update-totals">
            Confirm shipping address
          </button>
        </div>

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
            <span>Merchandise:</span>
            <strong id="sum-sub">—</strong>
          </div>
          <div class="summary-card__row">
            <span>Shipping:</span>
            <strong id="sum-ship">—</strong>
          </div>
          <div id="checkout-row-residential" class="summary-card__row" hidden>
            <span>Residential surcharge:</span>
            <strong id="sum-residential">—</strong>
          </div>
          <p id="checkout-residential-hint" class="checkout-residential-hint" hidden>
            Use a business address to avoid additional residential charges.
          </p>
          <div id="checkout-row-discount" class="summary-card__row summary-card__row--discount" hidden>
            <span>Discount:</span>
            <strong id="sum-discount">—</strong>
          </div>
          <div class="summary-card__row summary-card__row--tax">
            <span>Estimated tax:</span>
            <strong id="sum-tax">—</strong>
          </div>
          <div class="summary-card__row summary-card__row--total">
            <span>Total due:</span>
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
  // Keep Shipping / Estimated tax as "—" until the shopper clicks "Confirm shipping address".
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

/** Base shipping line — catalog includes shipping; line is always Free unless a future non-zero base is added. */
function baseShippingDisplayFromEstimate(data) {
  const base = Math.max(0, Math.round(Number(data?.baseShippingCents) || 0));
  if (typeof data?.baseShippingCents === "number") {
    return base === 0 ? "Free" : String(data.baseShippingFormatted || "—");
  }
  const ship = Math.max(0, Math.round(Number(data?.shippingCents) || 0));
  const res = Math.max(0, Math.round(Number(data?.residentialSurchargeCents) || 0));
  if (ship === 0 || ship === res) {
    return "Free";
  }
  return data.shippingFormatted || "—";
}

function resetCheckoutSummaryDiscountAmount() {
  const sumDiscount = document.getElementById("sum-discount");
  const discountRow = document.getElementById("checkout-row-discount");
  if (sumDiscount) {
    sumDiscount.textContent = "—";
  }
  if (discountRow) {
    discountRow.hidden = true;
  }
}

/**
 * @param {object} data Estimate JSON from /api/checkout-estimate
 * @param {{ initialSummary?: boolean }} [opts]
 */
function applyCheckoutOrderSummary(data, opts = {}) {
  const initialSummary = opts.initialSummary === true;
  const sumSub = document.getElementById("sum-sub");
  const sumShip = document.getElementById("sum-ship");
  const sumDiscount = document.getElementById("sum-discount");
  const sumTax = document.getElementById("sum-tax");
  const sumTotal = document.getElementById("sum-total");
  const discountCents = Math.max(0, Math.round(Number(data?.merchandiseDiscountCents) || 0));
  const showDiscountBreakdown =
    data?.hardinDiscountApplied === true &&
    typeof data?.originalMerchandiseSubtotalFormatted === "string" &&
    discountCents > 0;

  const discountRow = document.getElementById("checkout-row-discount");

  if (sumSub) {
    sumSub.textContent = showDiscountBreakdown
      ? data.originalMerchandiseSubtotalFormatted
      : data.subtotalFormatted;
  }

  if (sumDiscount && discountRow) {
    if (showDiscountBreakdown) {
      discountRow.hidden = false;
      sumDiscount.textContent = `-${data.merchandiseDiscountFormatted}`;
    } else {
      discountRow.hidden = true;
      sumDiscount.textContent = "—";
    }
  }

  const resRow = document.getElementById("checkout-row-residential");
  const sumRes = document.getElementById("sum-residential");
  const resHint = document.getElementById("checkout-residential-hint");

  if (sumShip && sumTax && sumTotal) {
    if (initialSummary) {
      sumShip.textContent = "—";
      sumTax.textContent = "—";
      if (resRow) {
        resRow.hidden = true;
      }
      if (resHint) {
        resHint.hidden = true;
      }
      if (discountRow) {
        discountRow.hidden = true;
      }
    } else {
      sumShip.textContent = baseShippingDisplayFromEstimate(data);
      sumTax.textContent = data.taxFormatted;
      const resCents = Math.max(0, Math.round(Number(data?.residentialSurchargeCents) || 0));
      if (resRow && sumRes) {
        if (resCents > 0 && data.residentialSurchargeFormatted) {
          resRow.hidden = false;
          sumRes.textContent = data.residentialSurchargeFormatted;
          if (resHint) {
            resHint.hidden = false;
          }
        } else {
          resRow.hidden = true;
          if (resHint) {
            resHint.hidden = true;
          }
        }
      }
    }
    sumTotal.textContent = data.totalFormatted;
  }
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

const ADDRESS_FIELD_ERR_IDS = {
  line1: "checkout-err-line1",
  city: "checkout-err-city",
  state: "checkout-err-state",
  postalCode: "checkout-err-postalCode",
};

function isStrictUsZipInput(z) {
  const s = String(z ?? "")
    .trim()
    .replace(/\s/g, "");
  return /^\d{5}$/.test(s) || /^\d{5}-\d{4}$/.test(s);
}

function clearAddressFieldErrors() {
  for (const id of Object.values(ADDRESS_FIELD_ERR_IDS)) {
    const el = document.getElementById(id);
    if (el) {
      el.textContent = "";
      el.hidden = true;
    }
  }
  for (const name of Object.keys(ADDRESS_FIELD_ERR_IDS)) {
    root.querySelector(`[name="${name}"]`)?.classList.remove("checkout-input--error");
  }
}

/**
 * @param {Record<string, string> | undefined} fieldErrors
 */
function applyApiFieldErrors(fieldErrors) {
  clearAddressFieldErrors();
  if (!fieldErrors || typeof fieldErrors !== "object") {
    return;
  }
  for (const [name, msg] of Object.entries(fieldErrors)) {
    const errId = ADDRESS_FIELD_ERR_IDS[name];
    if (!errId || !String(msg || "").trim()) {
      continue;
    }
    const errEl = document.getElementById(errId);
    if (errEl) {
      errEl.textContent = String(msg).trim();
      errEl.hidden = false;
    }
    root.querySelector(`[name="${name}"]`)?.classList.add("checkout-input--error");
  }
}

function formatSuggestionAddress(s) {
  if (!s || typeof s !== "object") {
    return "";
  }
  const line2 = s.line2 ? `${String(s.line2).trim()}\n` : "";
  const cityLine = [String(s.city || "").trim(), String(s.state || "").trim(), String(s.postalCode || "").trim()]
    .filter(Boolean)
    .join(", ");
  return `${String(s.line1 || "").trim()}\n${line2}${cityLine}`.trim();
}

function hideAddressSuggestion() {
  const box = document.getElementById("checkout-address-suggestion");
  if (box) {
    box.hidden = true;
  }
  const body = document.getElementById("checkout-address-suggestion-body");
  if (body) {
    body.textContent = "";
  }
}

function showAddressSuggestionIfAny(data) {
  const sug = data?.addressSuggestion;
  const box = document.getElementById("checkout-address-suggestion");
  const body = document.getElementById("checkout-address-suggestion-body");
  if (!box || !body || !sug || typeof sug !== "object") {
    hideAddressSuggestion();
    return;
  }
  body.textContent = formatSuggestionAddress(sug);
  box.hidden = false;
}

/** Shippo suggested a normalized address — block Pay until the shopper applies it (or gets a new estimate without one). */
function syncPayButtonForAddressSuggestion() {
  const payBtn = document.getElementById("checkout-pay");
  if (!payBtn || payBtn.getAttribute("aria-busy") === "true") {
    return;
  }
  const pending =
    latestEstimate &&
    latestEstimate.addressSuggestion &&
    typeof latestEstimate.addressSuggestion === "object";
  if (pending) {
    payBtn.disabled = true;
    payBtn.title =
      'Please tap "Use suggested address" above, or edit your address and click Confirm shipping address again.';
  } else {
    payBtn.disabled = false;
    payBtn.removeAttribute("title");
  }
}

function clearDiscountSectionWarning() {
  const el = document.getElementById("checkout-discount-warning");
  const input = root.querySelector('[name="discountCode"]');
  if (el) {
    el.hidden = true;
    el.textContent = "";
  }
  if (input) {
    input.removeAttribute("aria-describedby");
    input.removeAttribute("aria-invalid");
  }
}

/**
 * @param {string} message From API (eligible-address errors use the canonical backend string).
 */
function showDiscountSectionWarning(message) {
  const el = document.getElementById("checkout-discount-warning");
  const input = root.querySelector('[name="discountCode"]');
  if (!el) {
    return;
  }
  el.textContent = message;
  el.hidden = false;
  if (input) {
    input.setAttribute("aria-describedby", "checkout-discount-warning");
    input.setAttribute("aria-invalid", "true");
  }
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
  const warningsEl = document.getElementById("checkout-warnings");

  clearCheckoutInputErrors();
  clearShippingSectionError();
  clearDiscountSectionWarning();
  clearAddressFieldErrors();
  hideAddressSuggestion();

  if (validateContact && !applyContactValidationErrors()) {
    syncPayButtonForAddressSuggestion();
    return;
  }

  if (
    requireAddress &&
    (!address.line1 || !address.city || !address.state || !address.postalCode)
  ) {
    setAddressFieldsError(true);
    showShippingSectionError("Please complete your shipping address.");
    syncPayButtonForAddressSuggestion();
    return;
  }

  if (requireAddress && address.postalCode && !isStrictUsZipInput(address.postalCode)) {
    applyApiFieldErrors({ postalCode: "Please enter a valid ZIP code" });
    root.querySelector('[name="postalCode"]')?.classList.add("checkout-input--error");
    showShippingSectionError("Please enter a valid ZIP code");
    syncPayButtonForAddressSuggestion();
    return;
  }

  try {
    const dc = readDiscountCode();
    const payload = { items, address };
    // Only send a discount code after the shopper clicks "Confirm shipping address".
    // Passive estimate on first paint must not run discount validation (autofill + load
    // would otherwise show eligibility errors before any intentional attempt).
    if (dc && requireAddress) {
      payload.discountCode = dc;
    }

    const res = await fetch("/api/checkout-estimate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) {
      applyApiFieldErrors(data.fieldErrors);
      const parts = [data.error || "Could not calculate totals."];
      const msgs = data.addressValidation?.messages;
      if (Array.isArray(msgs) && msgs.length) {
        parts.push(...msgs.slice(0, 6));
      }
      throw new Error(parts.join(" "));
    }

    latestEstimate = data;
    clearDiscountSectionWarning();
    clearAddressFieldErrors();
    applyCheckoutOrderSummary(data, { initialSummary });
    if (!initialSummary) {
      showAddressSuggestionIfAny(data);
    } else {
      hideAddressSuggestion();
    }

    if (warningsEl) {
      const w = Array.isArray(data.warnings) ? [...data.warnings] : [];
      if (data.hardinDiscountBlocked === "incomplete_address" && readDiscountCode()) {
        w.push(
          'Complete your shipping address and click "Confirm shipping address" to apply a discount code.',
        );
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
    syncPayButtonForAddressSuggestion();
  } catch (e) {
    const msg = e.message || "Could not verify shipping address.";
    if (requireAddress && isCheckoutDiscountApiError(msg)) {
      showDiscountSectionWarning(msg);
    } else {
      if (
        requireAddress &&
        !isCheckoutDiscountApiError(msg) &&
        !root.querySelector(".checkout-field-error:not([hidden])")
      ) {
        setAddressFieldsError(true);
      }
      showShippingSectionError(msg);
    }
    sumShip.textContent = "—";
    sumTax.textContent = "—";
    sumTotal.textContent = "—";
    resetCheckoutSummaryDiscountAmount();
    const resRowErr = document.getElementById("checkout-row-residential");
    const resHintErr = document.getElementById("checkout-residential-hint");
    if (resRowErr) {
      resRowErr.hidden = true;
    }
    if (resHintErr) {
      resHintErr.hidden = true;
    }
    hideAddressSuggestion();
    latestEstimate = null;
    syncPayButtonForAddressSuggestion();
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
    const name = t?.name;
    if (name && ADDRESS_FIELD_ERR_IDS[name]) {
      const errEl = document.getElementById(ADDRESS_FIELD_ERR_IDS[name]);
      if (errEl) {
        errEl.hidden = true;
        errEl.textContent = "";
      }
    }
    if (!t?.classList?.contains("checkout-input--error")) {
      return;
    }
    t.classList.remove("checkout-input--error");
    if (t.matches?.('[name="line1"], [name="city"], [name="postalCode"]')) {
      clearShippingSectionError();
    }
    if (t.matches?.('[name="discountCode"]')) {
      clearDiscountSectionWarning();
    }
  });
  root.addEventListener("change", (e) => {
    const t = e.target;
    if (t?.name === "state") {
      const errEl = document.getElementById(ADDRESS_FIELD_ERR_IDS.state);
      if (errEl) {
        errEl.hidden = true;
        errEl.textContent = "";
      }
    }
    if (t?.name === "state" && t.classList.contains("checkout-input--error")) {
      t.classList.remove("checkout-input--error");
      clearShippingSectionError();
    }
  });
}

function wireEvents() {
  document.getElementById("checkout-apply-suggested-address")?.addEventListener("click", () => {
    const sug = latestEstimate?.addressSuggestion;
    if (!sug || typeof sug !== "object") {
      hideAddressSuggestion();
      return;
    }
    const l1 = root.querySelector('[name="line1"]');
    const l2 = root.querySelector('[name="line2"]');
    const city = root.querySelector('[name="city"]');
    const state = root.querySelector('[name="state"]');
    const zip = root.querySelector('[name="postalCode"]');
    if (l1) {
      l1.value = String(sug.line1 || "").trim();
    }
    if (l2) {
      l2.value = String(sug.line2 || "").trim();
    }
    if (city) {
      city.value = String(sug.city || "").trim();
    }
    if (state && sug.state) {
      state.value = String(sug.state || "").trim().toUpperCase().slice(0, 2);
    }
    if (zip) {
      zip.value = String(sug.postalCode || "").trim();
    }
    hideAddressSuggestion();
    clearAddressFieldErrors();
    clearShippingSectionError();
    void runEstimate({ validateContact: false, requireAddress: true });
  });

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
    clearDiscountSectionWarning();

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
      showShippingSectionError('Click "Confirm shipping address" first, or fix any address errors.');
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
        applyApiFieldErrors(data.fieldErrors);
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
      const msg = e.message || "Payment failed.";
      if (isCheckoutDiscountApiError(msg)) {
        showDiscountSectionWarning(msg);
      } else {
        showToast(msg, "error");
      }
    } finally {
      if (!checkoutSucceeded) {
        setButtonBusy(payBtn, false);
        syncPayButtonForAddressSuggestion();
      }
    }
  });
}
