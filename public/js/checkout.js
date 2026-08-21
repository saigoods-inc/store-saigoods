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

/** Shown above the shipping form when the carrier verified a deliverable normalized address. */
const CHECKOUT_ADDRESS_NOTICE_COPY =
  "Please confirm your shipping address. We found a deliverable version of your address below.";

function isAddressMismatchOrSuggestionPayload(data) {
  const av = data?.addressValidation && typeof data.addressValidation === "object" ? data.addressValidation : null;
  const code = String(av?.code || "").trim().toLowerCase();
  return (
    code === "address_mismatch" ||
    Boolean(data?.addressSuggestion && typeof data.addressSuggestion === "object")
  );
}

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
let estimateStale = true;
let estimateLoading = false;
let confirmAddressNeedsRefresh = true;
let latestQuotedAddressSnapshot = null;
let selectedShippingRate = null;
let quoteExpiryTimer = null;
/** Bumped when the shipping address (or discount) invalidates the quote; stale in-flight estimates must not repaint the UI. */
let checkoutQuoteEpoch = 0;
const CHECKOUT_ATTEMPT_STORAGE_KEY = "saigoods.checkoutAttemptId";

function checkoutAttemptId() {
  let value = sessionStorage.getItem(CHECKOUT_ATTEMPT_STORAGE_KEY) || "";
  if (!/^[0-9a-f-]{36}$/i.test(value)) {
    value = crypto.randomUUID();
    sessionStorage.setItem(CHECKOUT_ATTEMPT_STORAGE_KEY, value);
  }
  return value;
}

function resetCheckoutAttemptId() {
  sessionStorage.removeItem(CHECKOUT_ATTEMPT_STORAGE_KEY);
}

document.addEventListener("DOMContentLoaded", init);

async function init() {
  store = await initSite({ page: "cart" });
  items = getCart(store.site.sizes);

  if (store?.site?.storefrontGlobalOutOfStock && items.length && !isPreviewCheckoutSuccess()) {
    window.location.replace("/cart.html");
    return;
  }

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
    initCheckoutStateDropdown();
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

  const squareEnvironment =
    String(config.squareEnvironment || "production").toLowerCase() === "sandbox" ? "sandbox" : "production";
  await loadSquareWebSdk(squareEnvironment);
  let miniQuote;
  try {
    miniQuote = await getCartQuote(items);
  } catch {
    miniQuote = { items: [] };
  }
  renderCheckoutShell(miniQuote);
  initCheckoutStateDropdown();
  applyCheckoutAddressValidationDevBanner(config);
  await initSquareCard(config.squareApplicationId, config.squareLocationId);
  wireEvents();
  wireCheckoutFieldClearErrors();
}

function applyCheckoutAddressValidationDevBanner(config) {
  const el = document.getElementById("checkout-address-validation-dev-banner");
  if (!el) {
    return;
  }
  if (config?.checkoutShowAddressValidationDisabledBanner) {
    el.hidden = false;
    el.textContent = "Address validation is currently disabled.";
  } else {
    el.hidden = true;
    el.textContent = "";
  }
}

/**
 * Web Payments SDK script host must match application id environment (sandbox vs production).
 * @param {"sandbox" | "production"} environment
 */
function loadSquareWebSdk(environment) {
  const env = String(environment || "production").toLowerCase() === "sandbox" ? "sandbox" : "production";
  const url =
    env === "sandbox"
      ? "https://sandbox.web.squarecdn.com/v1/square.js"
      : "https://web.squarecdn.com/v1/square.js";

  const existing = document.querySelector("script[data-sai-square-wps-env]");
  if (existing && existing.getAttribute("data-sai-square-wps-env") === env && window.Square) {
    return Promise.resolve();
  }
  if (existing) {
    existing.remove();
  }
  try {
    delete window.Square;
  } catch {
    /* ignore */
  }

  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = url;
    s.async = true;
    s.setAttribute("data-sai-square-wps-env", env);
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Could not load Square Web Payments SDK."));
    document.head.appendChild(s);
  });
}

function renderCheckoutShell(miniQuote, options = {}) {
  const stateOptions = US_STATE_CODES.map(
    (code) => `<option value="${code}">${code}</option>`,
  ).join("");
  const stateButtons = US_STATE_CODES.map(
    (code) => `<button type="button" class="checkout-state-select__option" data-state-value="${code}">${code}</button>`,
  ).join("");

  root.innerHTML = `
    <section class="page-heading">
      <h1>Checkout</h1>
    </section>

    <section class="checkout-layout">
      <div id="checkout-address-validation-dev-banner" class="checkout-dev-banner" role="status" hidden></div>
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
          <div class="checkout-field">
            <span>State</span>
            <div class="checkout-select-wrapper">
              <select class="checkout-native-state-select checkout-state-select__native" name="state" required tabindex="-1" aria-hidden="true">
                <option value="">Select</option>
                ${stateOptions}
              </select>
              <button type="button" class="checkout-state-select__trigger" aria-haspopup="listbox" aria-expanded="false">
                <span class="checkout-state-select__value">Select</span>
                <span class="checkout-state-select__chevron" aria-hidden="true"></span>
              </button>
              <div class="checkout-state-select__menu" role="listbox" hidden>
                <button type="button" class="checkout-state-select__option checkout-state-select__option--placeholder" data-state-value="">Select</button>
                ${stateButtons}
              </div>
            </div>
            <span id="checkout-err-state" class="checkout-field-error" role="alert" hidden></span>
          </div>
          <label class="checkout-field">
            <span>ZIP code</span>
            <input type="text" name="postalCode" inputmode="numeric" autocomplete="postal-code" required />
            <span id="checkout-err-postalCode" class="checkout-field-error" role="alert" hidden></span>
          </label>
        </div>

        <div
          id="checkout-address-suggestion"
          class="checkout-address-suggestion"
          role="region"
          aria-labelledby="checkout-address-suggestion-title"
          aria-describedby="checkout-address-suggestion-body"
          hidden
        >
          <p id="checkout-address-suggestion-title" class="checkout-address-suggestion__label">Did you mean this address?</p>
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
            Confirm address & discount
          </button>
        </div>

        <section
          id="checkout-shipping-rates"
          class="checkout-shipping-rates"
          aria-labelledby="checkout-shipping-rates-title"
          hidden
        >
          <h2 id="checkout-shipping-rates-title" class="checkout-section-title">Shipping service</h2>
          <p id="checkout-shipping-rates-hint" class="checkout-card-hint">Select one service to continue.</p>
          <div id="checkout-shipping-rates-list" class="checkout-shipping-rates__list"></div>
        </section>

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
            <strong id="sum-ship">–</strong>
          </div>
          <p id="checkout-delivery-estimate" class="checkout-delivery-estimate" hidden></p>
          <div id="checkout-row-residential" class="summary-card__row" hidden>
            <span>Residential surcharge*:</span>
            <strong id="sum-residential">—</strong>
          </div>
          <div id="checkout-row-discount" class="summary-card__row summary-card__row--discount" hidden>
            <span>Discount:</span>
            <strong id="sum-discount">—</strong>
          </div>
          <div class="summary-card__row summary-card__row--tax">
            <span>Estimated tax:</span>
            <strong id="sum-tax">–</strong>
          </div>
          <div class="summary-card__row summary-card__row--total">
            <span>Total due:</span>
            <strong id="sum-total">—</strong>
          </div>
        </div>
        <div id="checkout-residential-footnote-wrap" class="checkout-residential-footnote-wrap" hidden>
          <hr class="checkout-residential-rule" aria-hidden="true" />
          <p id="checkout-residential-hint" class="checkout-residential-hint">
            *Use a business address to avoid additional residential charges.
          </p>
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
  // Keep Shipping / Estimated tax pending until the shopper clicks "Confirm address & discount".
  if (!options.skipInitialEstimate) {
    void runEstimate({ validateContact: false, requireAddress: false, initialSummary: true });
  }
}

function initCheckoutStateDropdown() {
  const wrapper = root.querySelector(".checkout-select-wrapper");
  const select = wrapper?.querySelector(".checkout-state-select__native");
  const trigger = wrapper?.querySelector(".checkout-state-select__trigger");
  const value = wrapper?.querySelector(".checkout-state-select__value");
  const menu = wrapper?.querySelector(".checkout-state-select__menu");
  if (!wrapper || !select || !trigger || !value || !menu) {
    return;
  }

  const close = () => {
    menu.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
  };
  const open = () => {
    menu.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
  };
  const sync = () => {
    value.textContent = select.value || "Select";
    menu.querySelectorAll(".checkout-state-select__option").forEach((option) => {
      option.classList.toggle("is-selected", option.dataset.stateValue === select.value);
    });
  };

  trigger.addEventListener("click", () => {
    if (menu.hidden) {
      open();
    } else {
      close();
    }
  });
  menu.addEventListener("click", (event) => {
    const option = event.target.closest(".checkout-state-select__option");
    if (!option) {
      return;
    }
    select.value = option.dataset.stateValue || "";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    sync();
    close();
    trigger.focus();
  });
  document.addEventListener("click", (event) => {
    if (!wrapper.contains(event.target)) {
      close();
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      close();
    }
  });
  select.addEventListener("change", sync);
  sync();
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

/** Estimate adapter: prefer QuoteResponseV1 nested fields with legacy fallback. */
function quoteView(data) {
  const hasV1 =
    data &&
    typeof data === "object" &&
    data.shipping &&
    typeof data.shipping === "object" &&
    data.totals &&
    typeof data.totals === "object";

  if (hasV1) {
    return {
      subtotalFormatted:
        data?.merchandise?.originalSubtotalFormatted ||
        data?.merchandise?.subtotalFormatted ||
        data?.subtotalFormatted ||
        "—",
      discountFormatted:
        Number(data?.merchandise?.discountCents || 0) > 0
          ? data?.merchandise?.discountFormatted || "—"
          : null,
      shippingMode: String(data?.shipping?.mode || "").trim() || null,
      shippingStatus: String(data?.shipping?.quoteStatus || "").trim() || "error",
      shippingAmountFormatted:
        data?.shipping?.amountFormatted || data?.shippingFormatted || "—",
      residentialSurchargeCents: Math.max(0, Math.round(Number(data?.shipping?.residentialSurchargeCents) || 0)),
      residentialSurchargeFormatted:
        data?.shipping?.residentialSurchargeFormatted || data?.residentialSurchargeFormatted || "—",
      taxFormatted: data?.tax?.amountFormatted || data?.taxFormatted || "—",
      totalFormatted: data?.totals?.totalFormatted || data?.totalFormatted || "—",
      canCheckout: data?.canCheckout !== false,
      userFacingError: data?.userFacingError ? String(data.userFacingError) : null,
      warnings: Array.isArray(data?.warnings) ? data.warnings : [],
      shippingRateOptions: Array.isArray(data?.shippingRateOptions) ? data.shippingRateOptions : [],
      estimatedDays: checkoutEstimatedDeliveryDays(data),
    };
  }

  const ship = Math.max(0, Math.round(Number(data?.shippingCents) || 0));
  const res = Math.max(0, Math.round(Number(data?.residentialSurchargeCents) || 0));
  return {
    subtotalFormatted:
      data?.originalMerchandiseSubtotalFormatted || data?.subtotalFormatted || "—",
    discountFormatted:
      Number(data?.merchandiseDiscountCents || 0) > 0 ? data?.merchandiseDiscountFormatted || "—" : null,
    shippingMode: "baked_in",
    shippingStatus: "included_in_merchandise",
    shippingAmountFormatted: ship === 0 || ship === res ? "Included in merchandise" : data?.shippingFormatted || "—",
    residentialSurchargeCents: res,
    residentialSurchargeFormatted: data?.residentialSurchargeFormatted || "—",
    taxFormatted: data?.taxFormatted || "—",
    totalFormatted: data?.totalFormatted || "—",
    canCheckout: true,
    userFacingError: null,
    warnings: Array.isArray(data?.warnings) ? data.warnings : [],
    shippingRateOptions: [],
    estimatedDays: null,
  };
}

function checkoutEstimatedDeliveryDays(data) {
  const options = Array.isArray(data?.shippingRateOptions) ? data.shippingRateOptions : [];
  const providerQuoteId = String(data?.shipping?.providerQuoteId || "").trim();
  const serviceCode = String(data?.shipping?.serviceCode || "").trim();
  const selected =
    options.find((option) => providerQuoteId && String(option?.id || option?.object_id || "") === providerQuoteId) ||
    options.find((option) => serviceCode && String(option?.serviceCode || option?.service_code || "") === serviceCode) ||
    options[0];
  const days = Number(data?.shipping?.estimatedDays ?? selected?.estimatedDays ?? selected?.estimated_days);
  return Number.isFinite(days) && days > 0 ? Math.max(1, Math.round(days)) : null;
}

function addBusinessDays(start, days) {
  const date = new Date(start);
  let remaining = days;
  while (remaining > 0) {
    date.setDate(date.getDate() + 1);
    const day = date.getDay();
    if (day !== 0 && day !== 6) remaining -= 1;
  }
  return date;
}

function estimatedDeliveryDisplay(view) {
  if (view?.shippingStatus !== "rated" || !view?.estimatedDays) return null;
  const date = addBusinessDays(new Date(), view.estimatedDays);
  return `Estimated delivery ${date.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
}

function shippingStatusDisplay(v) {
  switch (v?.shippingStatus) {
    case "included_in_merchandise":
      return "Included in merchandise";
    case "not_requested":
      return "Enter shipping address to quote";
    case "rated":
      return v.shippingAmountFormatted || "—";
    case "local_delivery":
      return "Free local delivery";
    case "invalid_address":
      return "Address invalid";
    case "provider_unavailable":
      return "Quote temporarily unavailable";
    case "error":
      return "Quote unavailable";
    default:
      return v?.shippingAmountFormatted || "—";
  }
}

function markEstimateStale() {
  checkoutQuoteEpoch += 1;
  latestEstimate = null;
  latestQuotedAddressSnapshot = null;
  estimateStale = true;
  confirmAddressNeedsRefresh = true;
  selectedShippingRate = null;
  if (quoteExpiryTimer) clearTimeout(quoteExpiryTimer);
  quoteExpiryTimer = null;
  renderShippingRateChoices(null);
  hideAddressSuggestion();
  const warningsEl = document.getElementById("checkout-warnings");
  if (warningsEl) {
    warningsEl.hidden = true;
    warningsEl.innerHTML = "";
  }
  const sumShip = document.getElementById("sum-ship");
  const sumTax = document.getElementById("sum-tax");
  const sumTotal = document.getElementById("sum-total");
  const deliveryEstimate = document.getElementById("checkout-delivery-estimate");
  const sumSub = document.getElementById("sum-sub");
  const resRow = document.getElementById("checkout-row-residential");
  const resFoot = document.getElementById("checkout-residential-footnote-wrap");
  if (sumShip) {
    sumShip.textContent = "–";
  }
  if (sumTax) {
    sumTax.textContent = "–";
  }
  if (sumTotal) {
    sumTotal.textContent = sumSub?.textContent || "—";
  }
  if (deliveryEstimate) {
    deliveryEstimate.hidden = true;
  }
  if (resRow) {
    resRow.hidden = true;
  }
  if (resFoot) {
    resFoot.hidden = true;
  }
  resetCheckoutSummaryDiscountAmount();
  syncConfirmAddressButtonState();
  syncPayButtonForAddressSuggestion();
}

function shippingRateStableKey(rate) {
  return [rate?.provider, rate?.serviceCode || rate?.serviceLabel, rate?.currency || "USD"]
    .map((value) => String(value || "").trim().toLowerCase())
    .join("||");
}

function shippingRateEquivalent(a, b) {
  return Boolean(a && b) &&
    shippingRateStableKey(a) === shippingRateStableKey(b) &&
    Number(a.totalAmountCents ?? a.amountCents) === Number(b.totalAmountCents ?? b.amountCents) &&
    Number(a.estimatedDays || 0) === Number(b.estimatedDays || 0);
}

function shippingChoiceBadge(rate) {
  const roles = Array.isArray(rate?.choiceRoles) ? rate.choiceRoles : [];
  if (roles.includes("cheapest") && roles.includes("fastest")) return "Cheapest & fastest";
  if (roles.includes("cheapest")) return "Cheapest";
  if (roles.includes("fastest")) return "Fastest";
  return "";
}

function cheapestShippingRate(rates) {
  const list = Array.isArray(rates) ? rates : [];
  const tagged = list.find((rate) =>
    Array.isArray(rate?.choiceRoles) && rate.choiceRoles.includes("cheapest"),
  );
  if (tagged) return tagged;
  return [...list].sort((a, b) => {
    const aCents = Number(a?.totalAmountCents ?? a?.amountCents);
    const bCents = Number(b?.totalAmountCents ?? b?.amountCents);
    const safeA = Number.isFinite(aCents) ? aCents : Number.POSITIVE_INFINITY;
    const safeB = Number.isFinite(bCents) ? bCents : Number.POSITIVE_INFINITY;
    return safeA - safeB;
  })[0] || null;
}

function updateShippingRateHint(hint, rate) {
  if (!hint || !rate) return;
  const isLocal =
    String(rate.provider || "").trim().toLowerCase() === "local" ||
    String(rate.serviceCode || "").trim().toLowerCase() === "local_delivery";
  hint.textContent = isLocal
    ? "Free local delivery selected."
    : `${rate.serviceLabel || "Shipping service"} selected. Choose another service if preferred.`;
}

function applySelectedShippingRate(rate) {
  if (!latestEstimate || !rate) return;
  const shippingCents = Math.max(0, Math.round(Number(rate.totalAmountCents ?? rate.amountCents) || 0));
  const subtotalCents = Math.max(0, Math.round(Number(latestEstimate.subtotalCents) || 0));
  const taxRateBps = Math.max(0, Math.round(Number(latestEstimate?.tax?.rateBps) || 0));
  const taxCents = Math.round(((subtotalCents + shippingCents) * taxRateBps) / 10000);
  const totalCents = subtotalCents + shippingCents + taxCents;
  const money = (cents) => `$${(cents / 100).toFixed(2)}`;
  latestEstimate = {
    ...latestEstimate,
    shipping: {
      ...(latestEstimate.shipping || {}),
      provider: rate.provider,
      serviceCode: rate.serviceCode,
      serviceLabel: rate.serviceLabel,
      providerQuoteId: rate.id,
      amountCents: shippingCents,
      amountFormatted: money(shippingCents),
      estimatedDays: rate.estimatedDays,
    },
    shippingCents,
    shippingFormatted: money(shippingCents),
    tax: { ...(latestEstimate.tax || {}), amountCents: taxCents, amountFormatted: money(taxCents) },
    taxCents,
    taxFormatted: money(taxCents),
    totals: { ...(latestEstimate.totals || {}), shippingCents, taxCents, totalCents, totalFormatted: money(totalCents) },
    totalCents,
    totalFormatted: money(totalCents),
  };
  applyCheckoutOrderSummary(latestEstimate);
}

function renderShippingRateChoices(data, previousSelection = null) {
  const section = document.getElementById("checkout-shipping-rates");
  const list = document.getElementById("checkout-shipping-rates-list");
  const hint = document.getElementById("checkout-shipping-rates-hint");
  if (!section || !list) return;
  const rates = Array.isArray(data?.shippingRateOptions) ? data.shippingRateOptions : [];
  section.hidden = rates.length === 0;
  if (!rates.length) {
    list.innerHTML = "";
    if (hint) hint.textContent = "Select one service to continue.";
    return;
  }
  const preserved = previousSelection
    ? rates.find((rate) => shippingRateEquivalent(previousSelection, rate)) || null
    : null;
  const automaticLocalRate = rates.find(
    (rate) => rate?.automatic === true || String(rate?.provider || "").toLowerCase() === "local",
  ) || null;
  const defaultRate = preserved || automaticLocalRate || cheapestShippingRate(rates);
  selectedShippingRate = defaultRate;
  list.innerHTML = rates.map((rate, index) => {
    const id = String(rate.id || "");
    const badge = shippingChoiceBadge(rate);
    const isLocalDelivery =
      String(rate.provider || "").trim().toLowerCase() === "local" ||
      String(rate.serviceCode || rate.service_code || "").trim().toLowerCase() === "local_delivery";
    const eta = Number(rate.estimatedDays) > 0 ? `${Math.round(Number(rate.estimatedDays))} business day${Number(rate.estimatedDays) === 1 ? "" : "s"}` : "Delivery estimate unavailable";
    const meta = isLocalDelivery
      ? ""
      : `<span class="checkout-shipping-rate__meta">${escapeHtml(rate.provider || "Carrier")} · ${escapeHtml(eta)}</span>`;
    return `<label class="checkout-shipping-rate">
      <input type="radio" name="shippingRate" value="${escapeHtml(id)}" ${defaultRate && String(defaultRate.id) === id ? "checked" : ""} />
      <span class="checkout-shipping-rate__body">
        <span class="checkout-shipping-rate__service">${escapeHtml(rate.serviceLabel || "Shipping")} ${badge ? `<strong>· ${escapeHtml(badge)}</strong>` : ""}</span>
        ${meta}
      </span>
      <strong>${escapeHtml(rate.totalAmountFormatted || rate.amountFormatted || "—")}</strong>
    </label>`;
  }).join("");
  list.querySelectorAll('input[name="shippingRate"]').forEach((input) => {
    input.addEventListener("change", () => {
      selectedShippingRate = rates.find((rate) => String(rate.id) === input.value) || null;
      if (selectedShippingRate) applySelectedShippingRate(selectedShippingRate);
      updateShippingRateHint(hint, selectedShippingRate);
      clearShippingSectionError();
      syncPayButtonForAddressSuggestion();
    });
  });
  updateShippingRateHint(hint, defaultRate);
  if (defaultRate) applySelectedShippingRate(defaultRate);
}

function scheduleQuoteExpiry(data) {
  if (quoteExpiryTimer) clearTimeout(quoteExpiryTimer);
  const expiresAt = Date.parse(String(data?.checkoutQuoteExpiresAt || ""));
  if (!Number.isFinite(expiresAt)) return;
  const delay = Math.max(0, expiresAt - Date.now());
  quoteExpiryTimer = setTimeout(() => {
    const previous = selectedShippingRate;
    selectedShippingRate = null;
    estimateStale = true;
    syncPayButtonForAddressSuggestion();
    showShippingSectionError("Shipping rates expired. Refreshing current rates…", { tone: "notice" });
    void runEstimate({ validateContact: false, requireAddress: true, previousShippingSelection: previous });
  }, delay);
}

function normalizeAddressForComparison(addr) {
  const a = addr && typeof addr === "object" ? addr : {};
  return {
    line1: String(a.line1 || "").trim().replace(/\s+/g, " ").toLowerCase(),
    line2: String(a.line2 || "").trim().replace(/\s+/g, " ").toLowerCase(),
    city: String(a.city || "").trim().replace(/\s+/g, " ").toLowerCase(),
    state: String(a.state || "").trim().toUpperCase().slice(0, 2),
    postalCode: String(a.postalCode || "").trim().replace(/\s/g, "").toUpperCase(),
    country: String(a.country || "US").trim().toUpperCase() || "US",
  };
}

function currentAddressMatchesLatestQuoteSnapshot() {
  if (!latestQuotedAddressSnapshot || typeof latestQuotedAddressSnapshot !== "object") {
    return false;
  }
  const cur = normalizeAddressForComparison(readAddressFromForm());
  const snap = normalizeAddressForComparison(latestQuotedAddressSnapshot);
  return (
    cur.line1 === snap.line1 &&
    cur.line2 === snap.line2 &&
    cur.city === snap.city &&
    cur.state === snap.state &&
    cur.postalCode === snap.postalCode &&
    cur.country === snap.country
  );
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
  const deliveryEstimate = document.getElementById("checkout-delivery-estimate");
  const view = quoteView(data);
  const showDiscountBreakdown = Boolean(view.discountFormatted);

  const discountRow = document.getElementById("checkout-row-discount");

  if (sumSub) {
    sumSub.textContent = view.subtotalFormatted;
  }

  if (sumDiscount && discountRow) {
    if (showDiscountBreakdown) {
      discountRow.hidden = false;
      sumDiscount.textContent = `-${view.discountFormatted}`;
    } else {
      discountRow.hidden = true;
      sumDiscount.textContent = "—";
    }
  }

  const resRow = document.getElementById("checkout-row-residential");
  const sumRes = document.getElementById("sum-residential");
  const resFoot = document.getElementById("checkout-residential-footnote-wrap");

  if (sumShip && sumTax && sumTotal) {
    if (initialSummary) {
      sumShip.textContent = "–";
      sumTax.textContent = "–";
      if (deliveryEstimate) deliveryEstimate.hidden = true;
      if (resRow) {
        resRow.hidden = true;
      }
      if (resFoot) {
        resFoot.hidden = true;
      }
      if (discountRow) {
        discountRow.hidden = true;
      }
    } else {
      sumShip.textContent = shippingStatusDisplay(view);
      sumTax.textContent = view.taxFormatted;
      if (deliveryEstimate) {
        const deliveryText = estimatedDeliveryDisplay(view);
        deliveryEstimate.textContent = deliveryText || "";
        deliveryEstimate.hidden = !deliveryText;
      }
      const resCents = view.residentialSurchargeCents;
      if (resRow && sumRes) {
        if (resCents > 0 && view.residentialSurchargeFormatted) {
          resRow.hidden = false;
          sumRes.textContent = view.residentialSurchargeFormatted;
          if (resFoot) {
            resFoot.hidden = false;
          }
        } else {
          resRow.hidden = true;
          if (resFoot) {
            resFoot.hidden = true;
          }
        }
      }
    }
    sumTotal.textContent = view.totalFormatted;
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
  const selectors = ['[name="name"]', '[name="email"]', '[name="phone"]', '[name="line1"]', '[name="city"]', '[name="state"]', '[name="postalCode"]'];
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
  el.classList.remove("checkout-shipping-error--notice");
}

function publicCheckoutShippingMessage(message) {
  const raw = String(message || "").trim();
  if (!raw) {
    return "";
  }
  const lower = raw.toLowerCase();
  const internalTerms = [
    "shippo",
    "ups rating",
    "provider",
    "carrier account",
    "sandbox",
    "rate provider",
    "shipment",
    "parcel plan",
    "carton",
    "packing plan",
  ];
  if (internalTerms.some((term) => lower.includes(term))) {
    return "Shipping options are temporarily unavailable. Please try again.";
  }
  return raw;
}

const ADDRESS_FIELD_ERR_IDS = {
  line1: "checkout-err-line1",
  city: "checkout-err-city",
  state: "checkout-err-state",
  postalCode: "checkout-err-postalCode",
};

/** API `addressErrors` keys → checkout form `name` attributes. */
const ADDRESS_ERROR_API_TO_FORM = {
  street1: "line1",
  line1: "line1",
  city: "city",
  state: "state",
  zip: "postalCode",
  postalCode: "postalCode",
};

function coerceAddressErrorsRecord(raw) {
  const out = { street1: null, city: null, state: null, zip: null };
  if (!raw || typeof raw !== "object") {
    return out;
  }
  for (const k of ["street1", "city", "state", "zip"]) {
    if (!Object.prototype.hasOwnProperty.call(raw, k)) {
      continue;
    }
    const v = raw[k];
    if (v != null && String(v).trim()) {
      out[k] = String(v).trim();
    }
  }
  return out;
}

function setSingleAddressFieldError(formName, message) {
  const errId = ADDRESS_FIELD_ERR_IDS[formName];
  if (!errId || !String(message || "").trim()) {
    return;
  }
  const errEl = document.getElementById(errId);
  if (errEl) {
    errEl.textContent = String(message).trim();
    errEl.hidden = false;
  }
  root.querySelector(`[name="${formName}"]`)?.classList.add("checkout-input--error");
}

/**
 * Applies `addressErrors` / `message` / `fieldErrors` from estimate or pay API responses.
 * @param {object} data Parsed JSON body
 */
function applyCheckoutShippingAddressErrors(data) {
  clearAddressFieldErrors();
  clearShippingSectionError();
  const av = data?.addressValidation && typeof data.addressValidation === "object" ? data.addressValidation : null;
  const flatAe = data?.addressErrors && typeof data.addressErrors === "object" ? data.addressErrors : null;
  const mergedAe = coerceAddressErrorsRecord(flatAe || av?.addressErrors);
  const fe = data?.fieldErrors && typeof data.fieldErrors === "object" ? data.fieldErrors : {};

  const byForm = new Map();
  for (const [k, v] of Object.entries(mergedAe)) {
    const msg = v != null ? String(v).trim() : "";
    if (!msg) {
      continue;
    }
    const formName = ADDRESS_ERROR_API_TO_FORM[k];
    if (formName) {
      byForm.set(formName, msg);
    }
  }
  for (const [name, rawMsg] of Object.entries(fe)) {
    const msg = String(rawMsg || "").trim();
    if (!msg || !ADDRESS_FIELD_ERR_IDS[name]) {
      continue;
    }
    if (!byForm.has(name)) {
      byForm.set(name, msg);
    }
  }

  for (const [name, msg] of byForm) {
    setSingleAddressFieldError(name, msg);
  }

  const banner =
    (av && typeof av.bannerMessage === "string" && av.bannerMessage.trim()) ||
    (typeof data?.message === "string" && data.message.trim()) ||
    "";
  if (banner) {
    if (isAddressMismatchOrSuggestionPayload(data)) {
      showShippingSectionError(CHECKOUT_ADDRESS_NOTICE_COPY, { tone: "notice" });
    } else {
      showShippingSectionError(banner);
    }
  }
}

function applyIncompleteShippingAddressErrors(address) {
  clearAddressFieldErrors();
  const a = address && typeof address === "object" ? address : {};
  if (!String(a.line1 || "").trim()) {
    setSingleAddressFieldError("line1", "Required.");
  }
  if (!String(a.city || "").trim()) {
    setSingleAddressFieldError("city", "Required.");
  }
  if (!String(a.state || "").trim()) {
    setSingleAddressFieldError("state", "Required.");
  }
  if (!String(a.postalCode || "").trim()) {
    setSingleAddressFieldError("postalCode", "Required.");
  }
  showShippingSectionError("Please complete your shipping address.");
}

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
  applyCheckoutShippingAddressErrors({ fieldErrors: fieldErrors || {} });
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
      'Please tap "Use suggested address" above, or edit your address and click Confirm address & discount again.';
  } else if (estimateLoading) {
    payBtn.disabled = true;
    payBtn.title = "Refreshing shipping quote…";
  } else if (!latestEstimate) {
    payBtn.disabled = true;
    payBtn.title = 'Click "Confirm address & discount" to quote shipping.';
  } else if (!currentAddressMatchesLatestQuoteSnapshot()) {
    payBtn.disabled = true;
    payBtn.title = "Address changed. Confirm address & discount again.";
  } else if (estimateStale) {
    payBtn.disabled = true;
    payBtn.title = "Confirm address & discount to refresh shipping quote.";
  } else if (latestEstimate?.canCheckout === false) {
    payBtn.disabled = true;
    payBtn.title = latestEstimate?.userFacingError || "Shipping quote is not ready.";
  } else if (!selectedShippingRate) {
    payBtn.disabled = true;
    payBtn.title = "Select a shipping service before paying.";
  } else {
    payBtn.disabled = false;
    payBtn.removeAttribute("title");
  }
}

function syncConfirmAddressButtonState() {
  const btn = document.getElementById("checkout-update-totals");
  if (!btn) return;
  btn.disabled = estimateLoading || !confirmAddressNeedsRefresh;
  btn.classList.toggle("checkout-confirm-address--loading", estimateLoading);
  btn.textContent = estimateLoading ? "Calculating shipping..." : "Confirm address & discount";
  if (estimateLoading) {
    btn.title = "Calculating current shipping services…";
  } else if (!confirmAddressNeedsRefresh) {
    btn.title = "Address and discount confirmed. Edit either to refresh.";
  } else {
    btn.removeAttribute("title");
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

/**
 * @param {string} message
 * @param {{ tone?: "error" | "notice" }} [options] notice = soft confirmation (address mismatch / suggestion).
 */
function showShippingSectionError(message, options = {}) {
  const el = document.getElementById("checkout-shipping-error");
  if (!el) {
    return;
  }
  const notice = options.tone === "notice";
  const safeMessage = notice ? String(message || "").trim() : publicCheckoutShippingMessage(message);
  if (!safeMessage) {
    clearShippingSectionError();
    return;
  }
  el.textContent = safeMessage;
  el.hidden = false;
  el.classList.toggle("checkout-shipping-error--notice", notice);
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
  if (contact.phone && !isValidPhone(contact.phone)) {
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
    applyIncompleteShippingAddressErrors(address);
    syncPayButtonForAddressSuggestion();
    return;
  }

  if (requireAddress && address.postalCode && !isStrictUsZipInput(address.postalCode)) {
    const zipMsg = "Please enter a valid ZIP code";
    applyCheckoutShippingAddressErrors({
      fieldErrors: { postalCode: zipMsg },
      addressValidation: {
        addressErrors: { street1: null, city: null, state: null, zip: zipMsg },
      },
    });
    syncPayButtonForAddressSuggestion();
    return;
  }

  let checkoutEstimateApiErrorHandled = false;
  /** True only when this estimate response is an address mismatch with a usable `addressSuggestion` (HTTP 400). */
  let pendingAddressSuggestionFromResponse = false;
  let epochAtFetch = checkoutQuoteEpoch;
  try {
    estimateLoading = true;
    syncConfirmAddressButtonState();
    if (!initialSummary && sumShip) {
      sumShip.textContent = "Calculating…";
      const deliveryEstimate = document.getElementById("checkout-delivery-estimate");
      if (deliveryEstimate) deliveryEstimate.hidden = true;
    }
    syncPayButtonForAddressSuggestion();
    const dc = readDiscountCode();
    const payload = { items, address };
    // Only send a discount code after the shopper clicks "Confirm address & discount".
    // Passive estimate on first paint must not run discount validation (autofill + load
    // would otherwise show eligibility errors before any intentional attempt).
    if (dc && requireAddress) {
      payload.discountCode = dc;
    }
    const requestAddressSnapshot = readAddressFromForm();
    epochAtFetch = checkoutQuoteEpoch;
    const res = await fetch("/api/checkout-estimate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (epochAtFetch !== checkoutQuoteEpoch) {
      return;
    }
    if (!res.ok) {
      applyCheckoutShippingAddressErrors(data);
      const shipErrEl = document.getElementById("checkout-shipping-error");
      const showedBanner = Boolean(shipErrEl && !shipErrEl.hidden);
      const showedInline = Boolean(root.querySelector(".checkout-field-error:not([hidden])"));
      checkoutEstimateApiErrorHandled = showedInline || showedBanner;

      const mismatchSuggestion =
        data?.addressSuggestion && typeof data.addressSuggestion === "object";
      if (mismatchSuggestion) {
        pendingAddressSuggestionFromResponse = true;
        latestEstimate = { addressSuggestion: data.addressSuggestion };
        latestQuotedAddressSnapshot =
          data?.submittedAddress && typeof data.submittedAddress === "object"
            ? data.submittedAddress
            : requestAddressSnapshot;
        showAddressSuggestionIfAny(data);
      }

      throw new Error(publicCheckoutShippingMessage(data.error) || "Could not calculate totals.");
    }

    const previousSelection = options.previousShippingSelection || selectedShippingRate;
    latestEstimate = data;
    latestQuotedAddressSnapshot =
      (data?.addressValidation?.submittedAddress && typeof data.addressValidation.submittedAddress === "object"
        ? data.addressValidation.submittedAddress
        : requestAddressSnapshot) || null;
    estimateStale = false;
    clearDiscountSectionWarning();
    clearAddressFieldErrors();
    applyCheckoutOrderSummary(data, { initialSummary });
    if (!initialSummary) {
      renderShippingRateChoices(data, previousSelection);
      scheduleQuoteExpiry(data);
      if (
        Array.isArray(data?.shippingRateOptions) &&
        data.shippingRateOptions.length > 0 &&
        !(data?.addressSuggestion && typeof data.addressSuggestion === "object")
      ) {
        confirmAddressNeedsRefresh = false;
      }
    }
    if (!initialSummary) {
      showAddressSuggestionIfAny(data);
    } else {
      hideAddressSuggestion();
    }

    if (warningsEl) {
      const view = quoteView(data);
      const w = [...(Array.isArray(view.warnings) ? view.warnings : [])];
      if (data?.freeDelivery?.applied) {
        w.unshift("Your order qualifies for free local delivery.");
      } else if (data?.freeDelivery?.message && data.freeDelivery.reason === "minimum_not_met") {
        w.unshift(data.freeDelivery.message);
      }
      if (data.hardinDiscountBlocked === "incomplete_address" && readDiscountCode()) {
        w.push(
          'Complete your shipping address and click "Confirm address & discount" to apply a discount code.',
        );
      }
      const statusMessageMap = {
        included_in_merchandise: "Shipping is included in merchandise pricing for this order.",
        not_requested: null,
        rated: null,
        invalid_address: "Please fix the shipping address to get a shipping quote.",
        provider_unavailable: "Shipping provider is temporarily unavailable. Please retry.",
        error: "Shipping quote failed. Please retry.",
      };
      const status = String(view.shippingStatus || "");
      if (view.userFacingError) {
        w.push(publicCheckoutShippingMessage(view.userFacingError));
        showShippingSectionError(view.userFacingError);
      } else if (statusMessageMap[status]) {
        w.push(statusMessageMap[status]);
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
    if (epochAtFetch !== checkoutQuoteEpoch) {
      return;
    }
    const msg = e.message || "Could not verify shipping address.";
    if (requireAddress && isCheckoutDiscountApiError(msg)) {
      showDiscountSectionWarning(msg);
    } else if (!checkoutEstimateApiErrorHandled) {
      if (pendingAddressSuggestionFromResponse) {
        showShippingSectionError(CHECKOUT_ADDRESS_NOTICE_COPY, { tone: "notice" });
      } else {
        showShippingSectionError(msg);
      }
    }
    sumShip.textContent = "–";
    sumTax.textContent = "–";
    sumTotal.textContent = "—";
    const deliveryEstimate = document.getElementById("checkout-delivery-estimate");
    if (deliveryEstimate) deliveryEstimate.hidden = true;
    resetCheckoutSummaryDiscountAmount();
    const resRowErr = document.getElementById("checkout-row-residential");
    const resFootErr = document.getElementById("checkout-residential-footnote-wrap");
    if (resRowErr) {
      resRowErr.hidden = true;
    }
    if (resFootErr) {
      resFootErr.hidden = true;
    }
    if (!pendingAddressSuggestionFromResponse) {
      hideAddressSuggestion();
      latestEstimate = null;
      latestQuotedAddressSnapshot = null;
    }
    estimateStale = true;
    confirmAddressNeedsRefresh = true;
    syncPayButtonForAddressSuggestion();
  } finally {
    estimateLoading = false;
    syncConfirmAddressButtonState();
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
    ? `<div class="checkout-success-modal__receipt-row"><span>Order reference</span><strong>${escapeHtml(String(orderRef))}</strong></div>`
    : "";
  const idLine =
    orderId != null && String(orderId).trim()
      ? `<div class="checkout-success-modal__receipt-row"><span>Order ID</span><code>${escapeHtml(String(orderId))}</code></div>`
      : "";
  const totalLine = totalFormatted
    ? `<div class="checkout-success-modal__receipt-row checkout-success-modal__receipt-row--total"><span>Total paid</span><strong>${escapeHtml(String(totalFormatted))}</strong></div>`
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
        <div class="checkout-success-modal__hero">
          <span class="checkout-success-modal__check" aria-hidden="true">&#10003;</span>
          <p class="checkout-success-modal__eyebrow">Order completed</p>
          <h2 id="checkout-success-heading" class="checkout-success-modal__title">Thank you for your purchase.</h2>
          <p class="checkout-success-modal__message">
            We&rsquo;ll email tracking information as soon as your order is on the way.
          </p>
        </div>
        <div class="checkout-success-modal__summary">
          <h3 class="checkout-success-modal__summary-title">Receipt</h3>
          <div class="checkout-success-modal__receipt">
            ${refLine}
            ${idLine}
            ${totalLine}
          </div>
          ${productsHtml ? `<h3 class="checkout-success-modal__summary-title checkout-success-modal__summary-title--items">Items ordered</h3>` : ""}
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
    window.location.href = "/";
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
    if (t?.classList?.contains("checkout-input--error")) {
      t.classList.remove("checkout-input--error");
    }
    if (t.matches?.('[name="line1"], [name="line2"], [name="city"], [name="postalCode"]')) {
      clearShippingSectionError();
      markEstimateStale();
    }
    if (t.matches?.('[name="discountCode"]')) {
      clearDiscountSectionWarning();
      markEstimateStale();
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
    if (t?.name === "state") {
      markEstimateStale();
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
      state.dispatchEvent(new Event("change", { bubbles: true }));
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
      showToast("Please complete your name, email, and phone before confirming your address.", "error");
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
      applyIncompleteShippingAddressErrors(address);
      return;
    }

    if (!latestEstimate) {
      showShippingSectionError('Click "Confirm address & discount" first, or fix any address errors.');
      return;
    }
    if (!currentAddressMatchesLatestQuoteSnapshot()) {
      showShippingSectionError("Address changed. Confirm address & discount again.");
      markEstimateStale();
      return;
    }
    if (estimateStale) {
      showShippingSectionError("Confirm address & discount to refresh shipping quote.");
      return;
    }
    if (latestEstimate?.canCheckout === false) {
      showShippingSectionError(latestEstimate?.userFacingError || "Shipping quote is not ready.");
      return;
    }
    if (!selectedShippingRate) {
      showShippingSectionError("Select a shipping service before paying.");
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
        checkoutAttemptId: checkoutAttemptId(),
        selectedShippingRateObjectId: selectedShippingRate.id,
        selectedShippingServiceCode: selectedShippingRate.serviceCode,
        selectedShippingServiceLabel: selectedShippingRate.serviceLabel,
        selectedShippingProvider: selectedShippingRate.provider,
        selectedShippingAmountCents: selectedShippingRate.amountCents,
        selectedShippingParcelCount: Number(latestEstimate?.parcelSummary?.parcelCount || 0),
        ...(latestEstimate?.checkoutQuoteToken
          ? { checkoutQuoteToken: latestEstimate.checkoutQuoteToken }
          : {}),
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
        if (data?.retryWithNewAttempt === true) {
          resetCheckoutAttemptId();
        }
        applyCheckoutShippingAddressErrors(data);
        throw new Error(publicCheckoutShippingMessage(data.error) || "Payment failed.");
      }

      clearCart();
      resetCheckoutAttemptId();
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
