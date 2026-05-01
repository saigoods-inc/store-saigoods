import { bundleCardPricePerHtml, formatCurrency } from "./catalog.js";
import { formatBundleCardSizeSummaryHtml, perBundleSummaryMap } from "./bundle-size-summary.js";
import { isBundleAllocationValid, requiredUnitsFromBundleLines } from "./bundle-validation.js";
import {
  inventoryAllowsAllocations,
  isProductStorefrontOutOfStock,
  isSizeChannelPurchasable,
} from "./size-availability.js";
import {
  clearAdminSessionUser,
  createSupabaseAdminClient,
  fetchReportJson,
  fetchReportPost,
  fetchSupabasePublicConfig,
  primeAdminSessionUser,
  renderAdminNav,
  ReportPostError,
  shouldBootstrapAdminSignedIn,
} from "./admin-shared.js";

const US_STATES = [
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA", "HI", "ID", "IL", "IN", "IA", "KS", "KY",
  "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND",
  "OH", "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY", "DC",
];

/** Matches server PICKUP_ADDRESS_FOR_ORDER. */
const MANUAL_PICKUP_ADDRESS = {
  line1: "In-store / pickup (see staff notes)",
  line2: "",
  city: "Savannah",
  state: "TN",
  postalCode: "38372",
  country: "US",
};

let supabase = null;
let siteSizes = ["S", "M", "L", "XL"];
let products = [];
/** Order id for payment link + PATCH saves (null = new draft on next save). */
let editingOrderId = null;
/** Same as editingOrderId once a draft is saved or loaded; cleared on “New order”. */
let lastCreatedOrderId = null;
/** @type {object | null} */
let lastQuote = null;
let estimateStale = false;
/** Shippo `object_id` (or `ups:…` id) from last successful quote; UI + save when not stale. */
let selectedShippingRateObjectId = null;
/** Set only when admin picks a radio; cleared on stale. Sent on estimate if still in lastShippingRateOptionsIds. */
let userExplicitShippingRateId = null;
/** Ids from the last successful `shippingRateOptions` (current session). */
let lastShippingRateOptionsIds = null;
/** Stable service identity snapshot chosen by admin for carrier quoting/send flow. */
let selectedShippingRateSnapshot = null;

/** After “Continue — apply discount anyway”, or loaded from draft with admin override. */
let discountOverrideConfirmed = false;

/**
 * @typedef {{ bundleQty: Record<string, number>, caseBySize: Record<string, number>, boxBySize: Record<string, number>, openBundleDropdownId: string | null }} ProductLineState
 */

/** @type {Record<string, ProductLineState>} */
let productState = {};

/** After failed estimate/save: show bundle/size mismatch styling (mirrors product page). */
let allocationSubmitAttempted = false;

const SEND_PAYMENT_LINK_DEFAULT_LABEL = "Create order & send payment link";
const SEND_PAYMENT_LINK_BUSY_LABEL = "Sending payment link…";
const CREATE_UNPAID_DEFAULT_LABEL = "Create unpaid order";
const CREATE_UNPAID_BUSY_LABEL = "Creating unpaid order…";

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
      merchandiseFormatted:
        data?.merchandise?.originalSubtotalFormatted ||
        data?.merchandise?.subtotalFormatted ||
        data?.subtotalFormatted ||
        "—",
      discountFormatted:
        Number(data?.merchandise?.discountCents || 0) > 0
          ? data?.merchandise?.discountFormatted || "—"
          : null,
      shippingStatus: String(data?.shipping?.quoteStatus || "").trim() || "error",
      shippingFormatted: data?.shipping?.amountFormatted || "—",
      shippingServiceLabel: data?.shipping?.serviceLabel || null,
      shippingMode: data?.shipping?.mode || null,
      residentialSurchargeCents: Math.max(0, Math.round(Number(data?.shipping?.residentialSurchargeCents) || 0)),
      residentialSurchargeFormatted:
        data?.shipping?.residentialSurchargeFormatted || data?.residentialSurchargeFormatted || "—",
      taxFormatted: data?.tax?.amountFormatted || data?.taxFormatted || "—",
      totalFormatted: data?.totals?.totalFormatted || data?.totalFormatted || "—",
      warnings: Array.isArray(data?.warnings) ? data.warnings : [],
      userFacingError: data?.userFacingError ? String(data.userFacingError) : null,
      canCheckout: data?.canCheckout !== false,
    };
  }

  return {
    merchandiseFormatted: data?.originalMerchandiseSubtotalFormatted || data?.subtotalFormatted || "—",
    discountFormatted:
      Number(data?.merchandiseDiscountCents || 0) > 0 ? data?.merchandiseDiscountFormatted || "—" : null,
    shippingStatus: "included_in_merchandise",
    shippingFormatted: data?.shippingFormatted || "—",
    shippingServiceLabel: null,
    shippingMode: "baked_in",
    residentialSurchargeCents: Math.max(0, Number(data?.residentialSurchargeCents) || 0),
    residentialSurchargeFormatted: data?.residentialSurchargeFormatted || "—",
    taxFormatted: data?.taxFormatted || "—",
    totalFormatted: data?.totalFormatted || "—",
    warnings: Array.isArray(data?.warnings) ? data.warnings : [],
    userFacingError: null,
    canCheckout: true,
  };
}

function shippingStatusLabel(v) {
  switch (v?.shippingStatus) {
    case "included_in_merchandise":
      return "Included in merchandise";
    case "not_requested":
      return "Address not confirmed";
    case "rated":
      return v.shippingServiceLabel ? `${v.shippingServiceLabel} (${v.shippingFormatted})` : v.shippingFormatted;
    case "invalid_address":
      return "Address invalid";
    case "provider_unavailable":
      return "Quote temporarily unavailable";
    case "error":
      return "Quote failed";
    default:
      return v?.shippingFormatted || "—";
  }
}

function markEstimatePreviewStale() {
  resetShippingRateOptionsUI();
  if (!lastQuote) {
    return;
  }
  if (estimateStale) {
    return;
  }
  estimateStale = true;
  const preview = document.getElementById("manual-preview");
  const pre = document.getElementById("manual-preview-body");
  if (preview && pre) {
    preview.hidden = false;
    pre.textContent = `${String(pre.textContent || "").trim()}\n\nNote: Quote may be stale. Recalculate totals before saving or sending payment link.`;
  }
  syncSendLinkButtonState();
}

function clearManualShippingRateSelection() {
  userExplicitShippingRateId = null;
  lastShippingRateOptionsIds = null;
  selectedShippingRateObjectId = null;
  selectedShippingRateSnapshot = null;
}

function resetShippingRateOptionsUI() {
  clearManualShippingRateSelection();
  const section = document.getElementById("manual-shipping-rate-section");
  const host = document.getElementById("manual-shipping-rate-options");
  if (host) {
    host.innerHTML = "";
  }
  if (section) {
    section.hidden = true;
  }
}

/**
 * @returns {string | null} Rate `object_id` to send; only if user picked it and it exists on the last rate list.
 */
function getRateIdForEstimateRequest() {
  if (!userExplicitShippingRateId || !lastShippingRateOptionsIds) {
    return null;
  }
  const id = String(userExplicitShippingRateId || "").trim();
  if (!id || !lastShippingRateOptionsIds.has(id)) {
    return null;
  }
  return id;
}

/**
 * Shippo/UPS can return new rate `id`s on every request; the backend can match the same line by
 * service + carrier (+ amount). Caller must use the row from `lastQuote.shippingRateOptions` for that id.
 * @param {object} target - body / payload
 * @param {object | null} quote - last successful estimate
 * @param {string | null} providerQuoteId - `shipping.providerQuoteId` or a radio `id` from the same list
 */
function applyShippingRateStabilityFieldsToPayload(target, quote, providerQuoteId) {
  const rid = String(providerQuoteId || "").trim();
  if (!target || !rid || !quote || !Array.isArray(quote.shippingRateOptions)) {
    return;
  }
  const opt = quote.shippingRateOptions.find((o) => String(o?.id || "").trim() === rid);
  if (!opt) {
    return;
  }
  if (String(opt.serviceCode || "").trim()) {
    target.selectedShippingServiceCode = String(opt.serviceCode).trim();
  }
  if (String(opt.provider || "").trim()) {
    target.selectedShippingProvider = String(opt.provider).trim();
  }
  if (opt.amountCents != null && Number.isFinite(Number(opt.amountCents))) {
    target.selectedShippingAmountCents = Math.max(0, Math.round(Number(opt.amountCents)));
  }
  if (String(opt.serviceLabel || "").trim()) {
    target.selectedShippingServiceLabel = String(opt.serviceLabel).trim();
  }
  if (quote?.parcelSummary?.parcelCount != null && Number.isFinite(Number(quote.parcelSummary.parcelCount))) {
    target.selectedShippingParcelCount = Math.max(0, Math.floor(Number(quote.parcelSummary.parcelCount)));
  }
  if (quote?.shipping?.residentialSurchargeCents != null && Number.isFinite(Number(quote.shipping.residentialSurchargeCents))) {
    target.selectedShippingResidentialSurchargeCents = Math.max(
      0,
      Math.round(Number(quote.shipping.residentialSurchargeCents)),
    );
  }
}

function applySelectedShippingSnapshotToPayload(target) {
  if (!target || !selectedShippingRateSnapshot) {
    return;
  }
  const s = selectedShippingRateSnapshot;
  if (String(s.id || "").trim()) {
    target.selectedShippingRateObjectId = String(s.id).trim();
  }
  if (String(s.provider || "").trim()) {
    target.selectedShippingProvider = String(s.provider).trim();
  }
  if (String(s.serviceCode || "").trim()) {
    target.selectedShippingServiceCode = String(s.serviceCode).trim();
  }
  if (String(s.serviceLabel || "").trim()) {
    target.selectedShippingServiceLabel = String(s.serviceLabel).trim();
  }
  if (s.amountCents != null && Number.isFinite(Number(s.amountCents))) {
    target.selectedShippingAmountCents = Math.max(0, Math.round(Number(s.amountCents)));
  }
  if (s.parcelCount != null && Number.isFinite(Number(s.parcelCount))) {
    target.selectedShippingParcelCount = Math.max(0, Math.floor(Number(s.parcelCount)));
  }
  if (s.residentialSurchargeCents != null && Number.isFinite(Number(s.residentialSurchargeCents))) {
    target.selectedShippingResidentialSurchargeCents = Math.max(
      0,
      Math.round(Number(s.residentialSurchargeCents)),
    );
  }
}

/** Filled when API returns `addressSuggestion` for staff to apply in one click. */
let pendingManualSuggestedAddress = null;

const MANUAL_ADDR_FIELD_ERR_IDS = {
  line1: "manual-addr-line1-err",
  city: "manual-addr-city-err",
  state: "manual-addr-state-err",
  postalCode: "manual-addr-zip-err",
};

const MANUAL_ADDR_INPUT_NAMES = {
  line1: "addr_line1",
  city: "addr_city",
  state: "addr_state",
  postalCode: "addr_zip",
};

const MANUAL_FORM_NAME_TO_API_KEY = {
  addr_line1: "line1",
  addr_city: "city",
  addr_state: "state",
  addr_zip: "postalCode",
};

function clearManualAddressFieldErrors() {
  for (const id of Object.values(MANUAL_ADDR_FIELD_ERR_IDS)) {
    const el = document.getElementById(id);
    if (el) {
      el.textContent = "";
      el.hidden = true;
    }
  }
  const form = document.getElementById("manual-order-form");
  if (!form) {
    return;
  }
  for (const name of Object.values(MANUAL_ADDR_INPUT_NAMES)) {
    form.querySelector(`[name="${name}"]`)?.classList.remove("manual-input--error");
  }
}

function setManualAddressFieldError(apiFieldKey, message) {
  const errId = MANUAL_ADDR_FIELD_ERR_IDS[apiFieldKey];
  if (!errId || !String(message || "").trim()) {
    return;
  }
  const errEl = document.getElementById(errId);
  const inputName = MANUAL_ADDR_INPUT_NAMES[apiFieldKey];
  if (errEl) {
    errEl.textContent = String(message).trim();
    errEl.hidden = false;
  }
  if (inputName) {
    document.getElementById("manual-order-form")?.querySelector(`[name="${inputName}"]`)?.classList.add("manual-input--error");
  }
}

function clearSingleManualAddressFieldError(apiFieldKey) {
  const errId = MANUAL_ADDR_FIELD_ERR_IDS[apiFieldKey];
  if (errId) {
    const el = document.getElementById(errId);
    if (el) {
      el.textContent = "";
      el.hidden = true;
    }
  }
  const inputName = MANUAL_ADDR_INPUT_NAMES[apiFieldKey];
  if (inputName) {
    document.getElementById("manual-order-form")?.querySelector(`[name="${inputName}"]`)?.classList.remove("manual-input--error");
  }
}

function formatManualAddressSuggestionBlock(a) {
  if (!a || typeof a !== "object") {
    return "";
  }
  const line2 = String(a.line2 || "").trim();
  const line2part = line2 ? `${line2}\n` : "";
  const cityLine = [String(a.city || "").trim(), String(a.state || "").trim(), String(a.postalCode || "").trim()]
    .filter(Boolean)
    .join(", ");
  return `${String(a.line1 || "").trim()}\n${line2part}${cityLine}`.trim();
}

function hideManualAddressSuggestion() {
  const box = document.getElementById("manual-address-suggestion");
  if (box) {
    box.hidden = true;
  }
  const subEl = document.getElementById("manual-address-submitted-display");
  const sugEl = document.getElementById("manual-address-suggested-display");
  if (subEl) {
    subEl.textContent = "";
  }
  if (sugEl) {
    sugEl.textContent = "";
  }
  pendingManualSuggestedAddress = null;
}

function showManualAddressSuggestionPanel(submitted, suggested) {
  const box = document.getElementById("manual-address-suggestion");
  const subEl = document.getElementById("manual-address-submitted-display");
  const sugEl = document.getElementById("manual-address-suggested-display");
  if (!box || !subEl || !sugEl || !submitted || !suggested) {
    return;
  }
  subEl.textContent = formatManualAddressSuggestionBlock(submitted);
  sugEl.textContent = formatManualAddressSuggestionBlock(suggested);
  box.hidden = false;
  pendingManualSuggestedAddress = suggested;
}

/**
 * Maps estimate/pay-style `fieldErrors` and `addressErrors` to manual order inputs (carrier flow).
 * @param {object | null | undefined} body - parsed JSON error body
 */
function applyManualOrderAddressErrorsFromApiBody(body) {
  if (!body || typeof body !== "object") {
    return;
  }
  clearManualAddressFieldErrors();
  hideManualAddressSuggestion();

  const fe = body.fieldErrors && typeof body.fieldErrors === "object" ? body.fieldErrors : {};
  const aeRaw =
    body.addressErrors && typeof body.addressErrors === "object"
      ? body.addressErrors
      : body.addressValidation?.addressErrors && typeof body.addressValidation.addressErrors === "object"
        ? body.addressValidation.addressErrors
        : {};

  const byField = new Map();
  for (const [k, v] of Object.entries(fe)) {
    const msg = String(v || "").trim();
    if (!msg) {
      continue;
    }
    if (k === "line1" || k === "street1") {
      byField.set("line1", msg);
    } else if (k === "city") {
      byField.set("city", msg);
    } else if (k === "state") {
      byField.set("state", msg);
    } else if (k === "postalCode" || k === "zip") {
      byField.set("postalCode", msg);
    }
  }
  for (const [k, v] of Object.entries(aeRaw)) {
    const msg = v != null ? String(v).trim() : "";
    if (!msg) {
      continue;
    }
    if (k === "street1" && !byField.has("line1")) {
      byField.set("line1", msg);
    } else if (k === "city" && !byField.has("city")) {
      byField.set("city", msg);
    } else if (k === "state" && !byField.has("state")) {
      byField.set("state", msg);
    } else if (k === "zip" && !byField.has("postalCode")) {
      byField.set("postalCode", msg);
    }
  }

  for (const [field, msg] of byField) {
    setManualAddressFieldError(field, msg);
  }

  const code = String(body.addressValidation?.code || "").trim();
  const hasSug = body.addressSuggestion && typeof body.addressSuggestion === "object";
  const submitted = body.submittedAddress && typeof body.submittedAddress === "object" ? body.submittedAddress : null;
  if ((code === "address_mismatch" || hasSug) && submitted && hasSug) {
    showManualAddressSuggestionPanel(submitted, body.addressSuggestion);
  }
}

function applySuggestedAddressToManualForm() {
  const s = pendingManualSuggestedAddress;
  const form = document.getElementById("manual-order-form");
  if (!s || !form || !form.addr_line1) {
    return;
  }
  form.addr_line1.value = String(s.line1 || "").trim();
  form.addr_line2.value = String(s.line2 || "").trim();
  form.addr_city.value = String(s.city || "").trim();
  const st = String(s.state || "").trim().toUpperCase().slice(0, 2);
  if (form.addr_state) {
    form.addr_state.value = st || form.addr_state.value;
  }
  form.addr_zip.value = String(s.postalCode || "").trim();
  hideManualAddressSuggestion();
  clearManualAddressFieldErrors();
  markEstimatePreviewStale();
}

/**
 * @param {object} data
 * @param {string} [selectedId] - `shipping.providerQuoteId` (backend default) for radio
 */
function renderShippingRateOptionsFromData(data, selectedId) {
  const section = document.getElementById("manual-shipping-rate-section");
  const host = document.getElementById("manual-shipping-rate-options");
  if (!section || !host) {
    return;
  }
  const raw = data?.shippingRateOptions;
  const list = Array.isArray(raw) ? raw : [];
  if (!list.length) {
    section.hidden = true;
    host.innerHTML = "";
    return;
  }
  const back = String(selectedId || data?.shipping?.providerQuoteId || "").trim();
  const ids = new Set(list.map((o) => String(o?.id || "").trim()).filter(Boolean));
  const fromExplicit =
    userExplicitShippingRateId && ids.has(String(userExplicitShippingRateId)) ? String(userExplicitShippingRateId) : null;
  const effective = fromExplicit || back;
  const picked = list.find((o) => String(o?.id || "").trim() === effective) || null;
  selectedShippingRateSnapshot = picked
    ? {
        id: String(picked.id || "").trim(),
        provider: String(picked.provider || "").trim(),
        serviceCode: String(picked.serviceCode || "").trim(),
        serviceLabel: String(picked.serviceLabel || "").trim(),
        amountCents: Number.isFinite(Number(picked.amountCents))
          ? Math.max(0, Math.round(Number(picked.amountCents)))
          : null,
        parcelCount:
          data?.parcelSummary?.parcelCount != null && Number.isFinite(Number(data.parcelSummary.parcelCount))
            ? Math.max(0, Math.floor(Number(data.parcelSummary.parcelCount)))
            : null,
        residentialSurchargeCents:
          data?.shipping?.residentialSurchargeCents != null &&
          Number.isFinite(Number(data.shipping.residentialSurchargeCents))
            ? Math.max(0, Math.round(Number(data.shipping.residentialSurchargeCents)))
            : null,
      }
    : null;
  const rows = list.map((o) => {
    const id = String(o?.id || "").trim();
    if (!id) {
      return "";
    }
    const lab = [o?.serviceLabel || o?.serviceCode, o?.amountFormatted, o?.provider]
      .filter((x) => (typeof x === "string" && x.trim()) || (typeof x === "number" && Number.isFinite(x)))
      .map((x) => (typeof x === "number" ? String(x) : x.trim()));
    const est =
      o?.estimatedDays != null && Number.isFinite(Number(o.estimatedDays)) ? Number(o.estimatedDays) : null;
    if (est != null) {
      lab.push(`est. ${est}d`);
    }
    const labelText = lab.join(" · ");
    const checked = id === effective ? " checked" : "";
    return `
      <label class="manual-shipping-rate-option manual-shipping-rate-card">
        <input type="radio" name="manual_shipping_rate" value="${escapeHtml(id)}"${checked} />
        <span class="manual-shipping-rate-card__text">${escapeHtml(labelText || id)}</span>
      </label>
    `;
  });
  host.innerHTML = rows.join("");
  section.hidden = false;
  if (effective) {
    for (const inp of host.querySelectorAll('input[name="manual_shipping_rate"]')) {
      if (String(inp.value) === effective) {
        inp.checked = true;
        break;
      }
    }
  }
  selectedShippingRateObjectId = String(data?.shipping?.providerQuoteId || effective || "").trim() || null;
}

/**
 * @param {unknown} e
 * @returns {string}
 */
function formatReportPostErrorForAdmin(e) {
  if (!(e instanceof ReportPostError)) {
    return (e && typeof e === "object" && e.message) || "Request failed.";
  }
  const body = e.body || {};
  return String(body.error || e.message || "Request failed.").trim() || "Request failed.";
}

function isWalkInMode() {
  return typeof document !== "undefined" && document.body?.dataset?.adminOrderMode === "walk-in";
}

function staffOrderApi(suffix) {
  const base = isWalkInMode() ? "admin-walk-in-order" : "admin-manual-order";
  return `/api/${base}-${suffix}`;
}

function activeAdminNavId() {
  return isWalkInMode() ? "walk-in-order" : "manual-order";
}

function syncWalkInPaymentPanel() {
  if (!isWalkInMode()) {
    return;
  }
  const panel = document.getElementById("walk-in-payment-panel");
  const btnPay = document.getElementById("btn-mark-walk-in-paid");
  if (panel) {
    panel.hidden = false;
  }
  const oid = lastCreatedOrderId || editingOrderId;
  if (btnPay) {
    btnPay.disabled = !oid;
  }
}

function resetSendPaymentLinkButtonState() {
  const btn = document.getElementById("btn-send-link");
  if (!btn) {
    return;
  }
  btn.textContent = SEND_PAYMENT_LINK_DEFAULT_LABEL;
  delete btn.dataset.paymentLinkSent;
  delete btn.dataset.sending;
  const createBtn = document.getElementById("btn-create-unpaid");
  if (createBtn) {
    createBtn.textContent = CREATE_UNPAID_DEFAULT_LABEL;
    delete createBtn.dataset.creating;
  }
}

function lockSendPaymentLinkButtonAfterEmail() {
  const btn = document.getElementById("btn-send-link");
  if (!btn) {
    return;
  }
  btn.textContent = "Payment link sent";
  btn.dataset.paymentLinkSent = "1";
  btn.disabled = true;
}

function updateSaveButtonLabel() {
  const btn = document.getElementById("btn-save-draft");
  if (!btn) {
    return;
  }
  if (isWalkInMode()) {
    btn.textContent = editingOrderId ? "Update unpaid walk-in order" : "Create unpaid walk-in order";
  } else {
    btn.textContent = editingOrderId ? "Save to update" : "Save draft order";
  }
}

function setDiscountOverridePanelVisible(visible) {
  const p = document.getElementById("manual-discount-override-panel");
  if (p) {
    p.hidden = !visible;
  }
}

function syncDiscountOverridePanelAfterEstimate(data, form) {
  if (isWalkInMode()) {
    setDiscountOverridePanelVisible(false);
    return;
  }
  if (!readApplyLocalDiscount(form)) {
    setDiscountOverridePanelVisible(false);
    return;
  }
  if (data?.adminLocalDiscountNeedsOverride && !data?.hardinDiscountApplied) {
    setDiscountOverridePanelVisible(true);
    return;
  }
  setDiscountOverridePanelVisible(false);
}

function showLogin() {
  document.getElementById("admin-login").hidden = false;
  document.getElementById("admin-app").hidden = true;
}

function showApp() {
  document.getElementById("admin-login").hidden = true;
  document.getElementById("admin-app").hidden = false;
}

function getFulfillmentFromForm(form) {
  if (isWalkInMode()) {
    return "carrier";
  }
  const v = form?.querySelector('input[name="fulfillment_method"]:checked')?.value;
  if (v === "local_delivery" || v === "pickup" || v === "carrier") {
    return v;
  }
  return "carrier";
}

function getPaymentFromForm(form) {
  if (isWalkInMode()) {
    return "square_payment_link";
  }
  const v = form?.querySelector('input[name="payment_method"]:checked')?.value;
  if (v === "pay_later" || v === "square_payment_link") {
    return v;
  }
  return "square_payment_link";
}

function readAddressFromForm(form) {
  if (isWalkInMode()) {
    return {
      line1: "In-store pickup",
      line2: "",
      city: "Savannah",
      state: "TN",
      postalCode: "38372",
      country: "US",
    };
  }
  const ful = getFulfillmentFromForm(form);
  if (ful === "pickup") {
    return { ...MANUAL_PICKUP_ADDRESS };
  }
  return {
    line1: String(form.addr_line1?.value || "").trim(),
    line2: String(form.addr_line2?.value || "").trim(),
    city: String(form.addr_city?.value || "").trim(),
    state: String(form.addr_state?.value || "").trim().toUpperCase(),
    postalCode: String(form.addr_zip?.value || "").trim(),
    country: "US",
  };
}

/**
 * @param {string} [ful] - if omitted, read from form
 */
function syncManualOrderFulfillmentUI(form, ful) {
  if (isWalkInMode() || !form) {
    return;
  }
  const f = ful != null ? ful : getFulfillmentFromForm(form);
  const ship = document.getElementById("manual-shipping-block");
  const hint = document.getElementById("manual-addr-hint");
  const noteWrap = document.getElementById("manual-local-note-wrap");
  const l1 = form.querySelector('input[name="addr_line1"]');
  const city = form.querySelector('input[name="addr_city"]');
  const st = form.querySelector('select[name="addr_state"]');
  const zip = form.querySelector('input[name="addr_zip"]');
  const need = (on) => {
    for (const el of [l1, city, st, zip].filter(Boolean)) {
      if (on) {
        el.setAttribute("required", "required");
      } else {
        el.removeAttribute("required");
      }
    }
  };
  if (f === "pickup") {
    if (ship) {
      ship.hidden = true;
    }
    if (hint) {
      hint.hidden = true;
    }
    if (noteWrap) {
      noteWrap.hidden = true;
    }
    need(false);
  } else {
    if (ship) {
      ship.hidden = false;
    }
    if (f === "local_delivery") {
      if (hint) {
        hint.hidden = false;
      }
      if (noteWrap) {
        noteWrap.hidden = false;
      }
      need(false);
    } else {
      if (hint) {
        hint.hidden = true;
      }
      if (noteWrap) {
        noteWrap.hidden = true;
      }
      need(true);
    }
  }
  if (f !== "carrier") {
    resetShippingRateOptionsUI();
  }
  const ratesRow = document.getElementById("manual-carrier-rates-row");
  if (ratesRow) {
    ratesRow.hidden = f !== "carrier";
  }
  syncSendLinkButtonState();
}

function syncSendLinkButtonState() {
  if (isWalkInMode()) {
    return;
  }
  const form = document.getElementById("manual-order-form");
  const sendBtn = document.getElementById("btn-send-link");
  const unpaidBtn = document.getElementById("btn-create-unpaid");
  const helper = document.getElementById("manual-send-link-helper");
  const setHelper = (show, text = "") => {
    if (!helper) {
      return;
    }
    helper.hidden = !show;
    helper.textContent = show ? text : "";
  };
  if (!form || (!sendBtn && !unpaidBtn)) {
    return;
  }
  const isPayLater = getPaymentFromForm(form) === "pay_later";
  if (sendBtn) {
    sendBtn.hidden = isPayLater;
  }
  if (unpaidBtn) {
    unpaidBtn.hidden = !isPayLater;
  }

  if (!isPayLater && sendBtn && sendBtn.dataset.paymentLinkSent === "1") {
    return;
  }
  const activeBtn = isPayLater ? unpaidBtn : sendBtn;
  if (!activeBtn) {
    return;
  }
  const inFlight =
    (sendBtn && sendBtn.dataset.sending === "1") || (unpaidBtn && unpaidBtn.dataset.creating === "1");
  if (inFlight) {
    return;
  }

  const needsCarrierQuote = !isWalkInMode() && getFulfillmentFromForm(form) === "carrier";
  const hasFreshCarrierQuote =
    lastQuote &&
    typeof lastQuote === "object" &&
    String(lastQuote?.shipping?.quoteStatus || "").trim() === "rated" &&
    estimateStale !== true;
  if (needsCarrierQuote && !hasFreshCarrierQuote) {
    activeBtn.disabled = true;
    activeBtn.title = "Please get fresh shipping rates before sending the invoice.";
    setHelper(
      true,
      isPayLater
        ? "Please get fresh shipping rates before creating this unpaid carrier order."
        : "Please get fresh shipping rates before sending the invoice.",
    );
    return;
  }

  activeBtn.disabled = false;
  activeBtn.removeAttribute("title");
  setHelper(false);
}

function casesFieldName(slug, size) {
  const safe = `${slug}_${size}`.replace(/[^a-z0-9_-]/gi, "_");
  return `cases_${safe}`;
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function sumChannel(map) {
  return Object.values(map || {}).reduce((s, n) => s + (Math.floor(Number(n)) || 0), 0);
}

/**
 * Must match server `getSupportedSizesForProduct` (see lib/store.js): use product.supportedSizes
 * when set, not the full site size list, so allocation + API normalization agree.
 * @param {object} product
 * @returns {string[]}
 */
function supportedSizesForProduct(product) {
  const sup = product?.supportedSizes;
  if (Array.isArray(sup) && sup.length) {
    return sup.map((s) => String(s || "").trim()).filter(Boolean);
  }
  return siteSizes;
}

function isManualProductOutOfStock(product) {
  return isProductStorefrontOutOfStock(product, supportedSizesForProduct(product));
}

function isManualSizeOutOfStock(product, size, channel = "case") {
  return !isSizeChannelPurchasable(product, size, channel);
}

/**
 * Move counts from site sizes the product does not offer into supported sizes (so nothing sits on e.g. S
 * when the product is M/L only).
 * @param {object} product
 */
function redistributeUnsupportedSizeAllocations(product) {
  const st = productState[product.slug];
  const sup = supportedSizesForProduct(product);
  if (sup.length === siteSizes.length && siteSizes.every((s) => sup.includes(s))) {
    return;
  }
  const allow = new Set(sup);
  let extraB = 0;
  let extraC = 0;
  for (const s of siteSizes) {
    if (!allow.has(s)) {
      extraB += Math.floor(Number(st.boxBySize[s]) || 0);
      extraC += Math.floor(Number(st.caseBySize[s]) || 0);
      st.boxBySize[s] = 0;
      st.caseBySize[s] = 0;
    }
  }
  if (extraB > 0) {
    const sp = defaultSpread(extraB, sup);
    for (const s of sup) {
      st.boxBySize[s] = Math.floor(Number(st.boxBySize[s]) || 0) + (sp[s] || 0);
    }
  }
  if (extraC > 0) {
    const sp = defaultSpread(extraC, sup);
    for (const s of sup) {
      st.caseBySize[s] = Math.floor(Number(st.caseBySize[s]) || 0) + (sp[s] || 0);
    }
  }
}

function ensureProductState(product) {
  const slug = product.slug;
  if (productState[slug]) {
    return;
  }
  const bundles = product.bundles || [];
  productState[slug] = {
    bundleQty: Object.fromEntries(bundles.map((b) => [b.id, 0])),
    caseBySize: Object.fromEntries(siteSizes.map((s) => [s, 0])),
    boxBySize: Object.fromEntries(siteSizes.map((s) => [s, 0])),
    openBundleDropdownId: null,
  };
}

function computeRequiredUnits(product, bundleQty) {
  const bundles = product.bundles || [];
  let reqBox = 0;
  let reqCase = 0;
  for (const b of bundles) {
    const q = Math.floor(bundleQty[b.id] || 0);
    if (q < 1) {
      continue;
    }
    const units = Math.max(0, Math.floor(Number(b.units) || 0));
    if (String(b.kind).toLowerCase() === "box") {
      reqBox += q * units;
    } else {
      reqCase += q * units;
    }
  }
  return { reqBox, reqCase };
}

function defaultSpread(total, sizes) {
  const map = {};
  for (const s of sizes) {
    map[s] = 0;
  }
  const n = Math.max(0, Math.floor(Number(total) || 0));
  for (let i = 0; i < n; i++) {
    map[sizes[i % sizes.length]] += 1;
  }
  return map;
}

function applyBundleRequirementDeltas(slug, prevReq, nextReq) {
  const product = products.find((x) => x.slug === slug);
  if (!product) {
    return;
  }
  const st = productState[slug];
  const sup = supportedSizesForProduct(product);
  if (nextReq.reqBox !== prevReq.reqBox) {
    const spread = defaultSpread(nextReq.reqBox, sup);
    for (const s of siteSizes) {
      st.boxBySize[s] = spread[s] ?? 0;
    }
  }
  if (nextReq.reqCase !== prevReq.reqCase) {
    const spread = defaultSpread(nextReq.reqCase, sup);
    for (const s of siteSizes) {
      st.caseBySize[s] = spread[s] ?? 0;
    }
  }
}

function hasAnyBundleSelection(bundleQty) {
  return Object.values(bundleQty).some((q) => Math.floor(q || 0) > 0);
}

function showBoxColumn(product, bundleQty) {
  return (product.bundles || []).some(
    (b) => String(b.kind).toLowerCase() === "box" && (bundleQty[b.id] || 0) > 0,
  );
}

function showCaseColumn(product, bundleQty) {
  return (product.bundles || []).some(
    (b) => String(b.kind).toLowerCase() === "case" && (bundleQty[b.id] || 0) > 0,
  );
}

function bundleLinesPayload(bundleQty) {
  return Object.entries(bundleQty)
    .filter(([, q]) => q > 0)
    .map(([id, qty]) => ({ id, qty }));
}

function bundleSubtotalCents(product, bundleQty) {
  let total = 0;
  for (const b of product.bundles || []) {
    const q = Math.floor(bundleQty[b.id] || 0);
    if (q < 1) {
      continue;
    }
    total += q * Math.max(0, Number(b.priceCents) || 0);
  }
  return total;
}

function compactQuantities(map, sizes) {
  const o = {};
  for (const s of sizes) {
    const n = Math.floor(Number(map?.[s]) || 0);
    if (n > 0) {
      o[s] = n;
    }
  }
  return o;
}

function safeIsBundleAllocationValid(product, bundleLines, caseMap, boxMap) {
  try {
    return isBundleAllocationValid(product, bundleLines, caseMap, boxMap, supportedSizesForProduct(product));
  } catch {
    return false;
  }
}

/**
 * @returns {{ items: object[], errors: string[] }}
 */
function buildItemsFromState() {
  const errors = [];
  const items = [];

  for (const p of products) {
    const st = productState[p.slug];
    if (!st) {
      continue;
    }
    redistributeUnsupportedSizeAllocations(p);

    const hasCatalogBundles = Array.isArray(p.bundles) && p.bundles.length > 0;
    const bundleLines = bundleLinesPayload(st.bundleQty);
    const sumCase = sumChannel(st.caseBySize);
    const sumBox = sumChannel(st.boxBySize);

    if (!hasCatalogBundles) {
      const quantities = compactQuantities(st.caseBySize, siteSizes);
      const selectedSizes = Object.keys(quantities);
      const blockedSizes = selectedSizes.filter((size) => isManualSizeOutOfStock(p, size, "case"));
      if (blockedSizes.length) {
        errors.push(
          `${p.name || p.slug}: Out of stock for ${blockedSizes.join(", ")}. Remove those sizes before continuing.`,
        );
        continue;
      }
      if (Object.keys(quantities).length) {
        items.push({ slug: p.slug, quantities, boxQuantities: {} });
      }
      continue;
    }

    if (!bundleLines.length && sumCase + sumBox === 0) {
      continue;
    }

    if (!bundleLines.length && sumCase + sumBox > 0) {
      errors.push(
        `${p.name || p.slug}: This product is sold by bundle on the website. Choose bundle packs first — do not enter sizes without bundles.`,
      );
      continue;
    }

    if (!safeIsBundleAllocationValid(p, bundleLines, st.caseBySize, st.boxBySize)) {
      let req = { boxes: 0, cases: 0 };
      try {
        req = requiredUnitsFromBundleLines(p, bundleLines);
      } catch {
        errors.push(`${p.name || p.slug}: Invalid bundle selection.`);
        continue;
      }
      const parts = [];
      if (showCaseColumn(p, st.bundleQty) && req.cases > 0) {
        parts.push(
          `cases must total ${req.cases} to match your bundle packs (currently ${sumCase})`,
        );
      }
      if (showBoxColumn(p, st.bundleQty) && req.boxes > 0) {
        parts.push(
          `boxes must total ${req.boxes} to match your bundle packs (currently ${sumBox})`,
        );
      }
      if (!parts.length) {
        parts.push("size allocation does not match the selected bundles.");
      }
      errors.push(`${p.name || p.slug}: ${parts.join("; ")}.`);
      continue;
    }

    const quantities = compactQuantities(st.caseBySize, siteSizes);
    const boxQuantities = compactQuantities(st.boxBySize, siteSizes);
    const requestedSizes = new Set([...Object.keys(quantities), ...Object.keys(boxQuantities)]);
    const blocked = [...requestedSizes].filter(
      (size) =>
        (Math.floor(Number(quantities[size]) || 0) > 0 && isManualSizeOutOfStock(p, size, "case")) ||
        (Math.floor(Number(boxQuantities[size]) || 0) > 0 && isManualSizeOutOfStock(p, size, "box")),
    );
    if (blocked.length) {
      errors.push(
        `${p.name || p.slug}: Out of stock for ${blocked.join(", ")}. Remove those sizes before continuing.`,
      );
      continue;
    }
    if (!inventoryAllowsAllocations(p, quantities, boxQuantities, supportedSizesForProduct(p))) {
      errors.push(`${p.name || p.slug}: Selected sizes exceed current sellable stock. Update quantities and retry.`);
      continue;
    }
    items.push({
      slug: p.slug,
      bundleLines,
      quantities,
      boxQuantities,
    });
  }

  return { items, errors };
}

function productSummaryStatus(product) {
  const st = productState[product.slug];
  if (!st) {
    return "—";
  }
  if (isManualProductOutOfStock(product)) {
    return "Out of stock";
  }
  const hasCatalogBundles = Array.isArray(product.bundles) && product.bundles.length > 0;
  if (!hasCatalogBundles) {
    const n = sumChannel(st.caseBySize);
    return n ? `${n} case${n === 1 ? "" : "s"}` : "None";
  }
  if (!hasAnyBundleSelection(st.bundleQty)) {
    const n = sumChannel(st.caseBySize) + sumChannel(st.boxBySize);
    return n ? "Sizes without bundles (fix)" : "None";
  }
  const lines = bundleLinesPayload(st.bundleQty);
  const ok = safeIsBundleAllocationValid(product, lines, st.caseBySize, st.boxBySize);
  if (!ok && allocationSubmitAttempted) {
    return "Fix size allocation";
  }
  if (!ok) {
    return "Bundles selected — assign sizes";
  }
  const sub = bundleSubtotalCents(product, st.bundleQty);
  return sub > 0 ? `Subtotal ${formatCurrency(sub)}` : "—";
}

function productHasAllocationIssue(product) {
  const st = productState[product.slug];
  if (!st) {
    return false;
  }
  const hasCatalogBundles = Array.isArray(product.bundles) && product.bundles.length > 0;
  if (!hasCatalogBundles) {
    return false;
  }
  const bundleLines = bundleLinesPayload(st.bundleQty);
  const sumCase = sumChannel(st.caseBySize);
  const sumBox = sumChannel(st.boxBySize);
  if (!bundleLines.length && sumCase + sumBox > 0) {
    return true;
  }
  if (bundleLines.length && !safeIsBundleAllocationValid(product, bundleLines, st.caseBySize, st.boxBySize)) {
    return true;
  }
  return false;
}

function renderSizeColumn(product, st, channel, map, { invalid = false, hint = "", hideHeader = false } = {}) {
  const { reqBox, reqCase } = computeRequiredUnits(product, st.bundleQty);
  const req = channel === "box" ? reqBox : reqCase;
  const total = sumChannel(map);
  const plusDisabled = req < 1 || total >= req;

  const errClass = invalid ? " size-bundle-column--invalid" : "";
  const errMsg =
    invalid && hint
      ? `<p class="size-bundle-column__error" role="alert">${escapeHtml(hint)}</p>`
      : "";

  const title = channel === "box" ? "Boxes bundle" : "Cases bundle";
  const headerBlock =
    hideHeader || !String(title).trim()
      ? ""
      : `<div class="size-bundle-column__header">${escapeHtml(title)}</div>`;

  return `
    <div class="size-bundle-column${errClass}" data-channel="${escapeHtml(channel)}">
      ${errMsg}
      ${headerBlock}
      <div class="size-bundle-column__rows">
        ${siteSizes
          .map(
            (size) => {
              const outOfStock = isManualSizeOutOfStock(product, size, channel);
              return `
          <div class="size-row${outOfStock ? " size-row--oos" : ""}">
            <span class="size-row__label">${escapeHtml(size)}</span>
            ${outOfStock ? '<span class="size-row__oos">Out of stock</span>' : ""}
            <div class="qty-control qty-control--round">
              <button type="button" data-action="size-step" data-slug="${escapeHtml(product.slug)}" data-channel="${escapeHtml(channel)}" data-size="${escapeHtml(size)}" data-delta="-1" aria-label="Decrease ${escapeHtml(size)} ${channel} count"${
                outOfStock ? " disabled" : ""
              }>−</button>
              <strong>${map[size] || 0}</strong>
              <button type="button" data-action="size-step" data-slug="${escapeHtml(product.slug)}" data-channel="${escapeHtml(channel)}" data-size="${escapeHtml(size)}" data-delta="1" aria-label="Increase ${escapeHtml(size)} ${channel} count"${
                plusDisabled || outOfStock ? " disabled" : ""
              }>+</button>
            </div>
          </div>
        `;
            },
          )
          .join("")}
      </div>
    </div>
  `;
}

function renderBundleCard(product, st, b, err) {
  const id = escapeHtml(b.id);
  const qty = Math.floor(st.bundleQty[b.id] || 0);
  const selected = qty > 0 ? " is-selected" : "";
  const productOos = isManualProductOutOfStock(product);
  const badgePopular =
    String(b.badge || "").toLowerCase() === "popular"
      ? `<span class="bundle-card__badge bundle-card__badge--popular">Most popular🔥</span>`
      : "";
  const saveCents = Math.max(0, Number(b.saveCents) || 0);
  const badgeSave = saveCents
    ? `<span class="bundle-card__badge bundle-card__badge--save">Save ${formatCurrency(saveCents)}</span>`
    : "";

  const kind = String(b.kind).toLowerCase();
  const showExpand = qty > 0 && st.openBundleDropdownId === b.id;
  let panelInner = "";
  if (showExpand) {
    if (kind === "box" && showBoxColumn(product, st.bundleQty)) {
      panelInner = renderSizeColumn(product, st, "box", st.boxBySize, {
        invalid: err.showBoxError,
        hint: err.boxHint,
        hideHeader: true,
      });
    } else if (kind === "case" && showCaseColumn(product, st.bundleQty)) {
      panelInner = renderSizeColumn(product, st, "case", st.caseBySize, {
        invalid: err.showCaseError,
        hint: err.caseHint,
        hideHeader: true,
      });
    } else {
      panelInner = `<p class="inline-note inline-note--muted">Use bundle packs above to select sizes.</p>`;
    }
  }

  const expandBlock =
    showExpand && panelInner
      ? `
      <div class="bundle-card__expand">
        <div class="bundle-card__expand-panel-inner" aria-hidden="false">
          <div class="bundle-card__size-grid">
            ${panelInner}
          </div>
        </div>
      </div>
    `
      : "";

  const mapForKind = kind === "box" ? st.boxBySize : kind === "case" ? st.caseBySize : null;
  const summaryMap =
    mapForKind &&
    qty > 0 &&
    !showExpand &&
    ((kind === "box" && showBoxColumn(product, st.bundleQty)) ||
      (kind === "case" && showCaseColumn(product, st.bundleQty)))
      ? perBundleSummaryMap(product, st.bundleQty, b, mapForKind, siteSizes)
      : null;
  const summaryHtml = summaryMap ? formatBundleCardSizeSummaryHtml(summaryMap, siteSizes, escapeHtml) : "";
  const collapsedSummaryBlock =
    summaryHtml !== ""
      ? `<p class="bundle-card__size-summary">${summaryHtml}</p>`
      : "";

  return `
    <div class="bundle-card${selected}" data-bundle-id="${id}">
      <div class="bundle-card__badges" aria-hidden="true">${badgePopular}${badgeSave}</div>
      <div class="bundle-card__row">
        <button type="button" class="bundle-card__main" data-action="bundle-select" data-slug="${escapeHtml(product.slug)}" data-bundle-id="${id}" aria-label="Select ${escapeHtml(b.label)}, ${formatCurrency(b.priceCents)} total"${
          productOos ? " disabled" : ""
        }>
          <span class="bundle-card__title">${escapeHtml(b.label)}</span>
          <span class="bundle-card__price-total">${formatCurrency(b.priceCents)}</span>
          ${bundleCardPricePerHtml(b.priceCents, b.units, kind)}
        </button>
        <div class="bundle-card__stepper qty-control qty-control--round">
          <button type="button" data-action="bundle-decrease" data-slug="${escapeHtml(product.slug)}" data-bundle-id="${id}" aria-label="Decrease ${escapeHtml(b.label)} packs"${
            productOos ? " disabled" : ""
          }>−</button>
          <strong>${qty}</strong>
          <button type="button" data-action="bundle-increase" data-slug="${escapeHtml(product.slug)}" data-bundle-id="${id}" aria-label="Increase ${escapeHtml(b.label)} packs"${
            productOos ? " disabled" : ""
          }>+</button>
        </div>
      </div>
      ${collapsedSummaryBlock}
      ${expandBlock}
    </div>
  `;
}

function renderBundledProductBody(product) {
  const st = productState[product.slug];
  const bundles = product.bundles || [];
  const reqUnits = computeRequiredUnits(product, st.bundleQty);
  const sumBoxes = sumChannel(st.boxBySize);
  const sumCases = sumChannel(st.caseBySize);
  const boxMismatch =
    showBoxColumn(product, st.bundleQty) && reqUnits.reqBox > 0 && sumBoxes !== reqUnits.reqBox;
  const caseMismatch =
    showCaseColumn(product, st.bundleQty) && reqUnits.reqCase > 0 && sumCases !== reqUnits.reqCase;
  const showBoxError = allocationSubmitAttempted && boxMismatch;
  const showCaseError = allocationSubmitAttempted && caseMismatch;
  const boxHint = showBoxError
    ? `Total boxes must equal ${reqUnits.reqBox} to match your bundle packs. Current: ${sumBoxes}.`
    : "";
  const caseHint = showCaseError
    ? `Total cases must equal ${reqUnits.reqCase} to match your bundle packs. Current: ${sumCases}.`
    : "";

  const err = { showBoxError, showCaseError, boxHint, caseHint };
  const subtotal = bundleSubtotalCents(product, st.bundleQty);

  return `
    <div class="detail-block detail-block--bundles manual-bundle-block">
      <h4 class="manual-bundle-heading">Bundle &amp; price</h4>
      <div class="bundle-grid">
        ${bundles.map((b) => renderBundleCard(product, st, b, err)).join("")}
      </div>
      ${
        !hasAnyBundleSelection(st.bundleQty)
          ? `<p class="inline-note inline-note--muted product-bundle-hint">Select a bundle, then choose sizes in the panel below it.</p>`
          : ""
      }
      <div class="selection-summary manual-selection-summary">
        <div class="selection-summary__subtotal-row">
          <span class="selection-summary__subtotal-label">Line subtotal (standard list)</span>
          <span class="selection-summary__subtotal-amount">${formatCurrency(subtotal)}</span>
        </div>
        <p class="admin-muted manual-selection-note">Final merchandise total uses the same server rules as checkout (including local tier when the discount checkbox is checked and the address qualifies).</p>
      </div>
    </div>
  `;
}

function renderLegacyProductBody(product) {
  const st = productState[product.slug];
  const sizeFields = siteSizes
    .map((sz) => {
      const nm = casesFieldName(product.slug, sz);
      const v = Math.floor(Number(st.caseBySize[sz]) || 0);
      const oos = isManualSizeOutOfStock(product, sz, "case");
      return `<label class="${oos ? "manual-legacy-size--oos" : ""}">${escapeHtml(sz)} cases${
        oos ? ' <span class="manual-legacy-size__oos">(Out of stock)</span>' : ""
      } <input type="number" min="0" step="1" name="${escapeHtml(nm)}" data-action="legacy-cases" data-slug="${escapeHtml(product.slug)}" data-size="${escapeHtml(sz)}" value="${v ? String(v) : ""}"${
        oos ? " disabled" : ""
      } /></label>`;
    })
    .join("");
  return `<div class="manual-product-sizes">${sizeFields}</div>`;
}

function renderProductBlock(product, index, openDetailSlugs) {
  ensureProductState(product);
  const hasBundles = Array.isArray(product.bundles) && product.bundles.length > 0;
  const status = escapeHtml(productSummaryStatus(product));
  const issue = productHasAllocationIssue(product);
  const productOos = isManualProductOutOfStock(product);
  const wasOpen = openDetailSlugs instanceof Set && openDetailSlugs.has(product.slug);
  const openAttr =
    (allocationSubmitAttempted && issue) || wasOpen ? " open" : "";
  const invalidClass =
    (allocationSubmitAttempted && issue ? " manual-product-details--warn" : "") +
    (productOos ? " manual-product-details--oos" : "");

  const body = hasBundles ? renderBundledProductBody(product) : renderLegacyProductBody(product);

  return `
    <details class="manual-product-details${invalidClass}" data-manual-product-slug="${escapeHtml(product.slug)}"${openAttr}>
      <summary class="manual-product-summary">
        <span class="manual-product-summary__name">${escapeHtml(product.name || product.slug)}</span>
        <span class="manual-product-summary__status">${status}</span>
      </summary>
      <div class="manual-product-body" data-manual-product-slug="${escapeHtml(product.slug)}">
        ${body}
      </div>
    </details>
  `;
}

function renderProductInputs() {
  const wrap = document.getElementById("manual-products");
  if (!wrap) {
    return;
  }
  const openDetailSlugs = new Set();
  for (const el of wrap.querySelectorAll("details.manual-product-details[open]")) {
    const slug = el.getAttribute("data-manual-product-slug");
    if (slug) {
      openDetailSlugs.add(slug);
    }
  }
  wrap.innerHTML = products.map((p, i) => renderProductBlock(p, i, openDetailSlugs)).join("");
}

function applyBundleDelta(slug, bundleId, delta) {
  allocationSubmitAttempted = false;
  const product = products.find((x) => x.slug === slug);
  if (!product) {
    return;
  }
  const st = productState[slug];
  const prevReq = computeRequiredUnits(product, st.bundleQty);
  const prevQ = Math.floor(st.bundleQty[bundleId] || 0);
  const nextQ = Math.max(0, prevQ + delta);
  st.bundleQty = { ...st.bundleQty, [bundleId]: nextQ };
  if (nextQ < 1) {
    if (st.openBundleDropdownId === bundleId) {
      st.openBundleDropdownId = null;
    }
  } else {
    st.openBundleDropdownId = bundleId;
  }
  const nextReq = computeRequiredUnits(product, st.bundleQty);
  applyBundleRequirementDeltas(slug, prevReq, nextReq);
}

function selectBundleCard(slug, bundleId) {
  allocationSubmitAttempted = false;
  const product = products.find((x) => x.slug === slug);
  if (!product) {
    return;
  }
  const st = productState[slug];
  if ((st.bundleQty[bundleId] || 0) >= 1) {
    st.openBundleDropdownId = bundleId;
    return;
  }
  const prevReq = computeRequiredUnits(product, st.bundleQty);
  st.bundleQty = { ...st.bundleQty, [bundleId]: 1 };
  st.openBundleDropdownId = bundleId;
  const nextReq = computeRequiredUnits(product, st.bundleQty);
  applyBundleRequirementDeltas(slug, prevReq, nextReq);
}

function handleSizeStep(slug, channel, size, delta) {
  allocationSubmitAttempted = false;
  const product = products.find((x) => x.slug === slug);
  if (!product) {
    return;
  }
  if (isManualSizeOutOfStock(product, size, channel)) {
    return;
  }
  const st = productState[slug];
  const map = channel === "box" ? { ...st.boxBySize } : { ...st.caseBySize };
  const cur = Math.floor(map[size]) || 0;
  const { reqBox, reqCase } = computeRequiredUnits(product, st.bundleQty);
  const req = channel === "box" ? reqBox : reqCase;
  const prevTotal = sumChannel(map);

  if (delta > 0) {
    if (req < 1) {
      return;
    }
    if (prevTotal + delta > req) {
      return;
    }
  }

  const nextVal = Math.max(0, cur + delta);
  map[size] = nextVal;

  if (channel === "box") {
    st.boxBySize = map;
  } else {
    st.caseBySize = map;
  }
}

function onDocumentClickBundles(e) {
  let changed = false;
  const productsRoot = document.getElementById("manual-products");
  const clickedInsideManualProducts = Boolean(e.target?.closest?.("#manual-products"));

  for (const p of products) {
    const st = productState[p.slug];
    if (!st?.openBundleDropdownId) {
      continue;
    }
    const card = e.target.closest("[data-bundle-id]");
    if (
      card &&
      card.dataset.bundleId === st.openBundleDropdownId &&
      card.closest("[data-manual-product-slug]")?.dataset.manualProductSlug === p.slug
    ) {
      continue;
    }
    st.openBundleDropdownId = null;
    changed = true;
  }
  if (productsRoot && !clickedInsideManualProducts) {
    for (const details of productsRoot.querySelectorAll("details.manual-product-details[open]")) {
      details.open = false;
      changed = true;
    }
  }
  if (changed) {
    renderProductInputs();
  }
}

function onManualProductsClick(e) {
  const t = e.target.closest("[data-action]");
  if (!t) {
    return;
  }
  const action = t.dataset.action;
  const slug = t.dataset.slug;
  if (!slug) {
    return;
  }

  if (action === "bundle-select") {
    markEstimatePreviewStale();
    selectBundleCard(slug, t.dataset.bundleId);
    renderProductInputs();
    e.stopPropagation();
    return;
  }
  if (action === "bundle-increase") {
    markEstimatePreviewStale();
    applyBundleDelta(slug, t.dataset.bundleId, 1);
    renderProductInputs();
    e.stopPropagation();
    return;
  }
  if (action === "bundle-decrease") {
    markEstimatePreviewStale();
    applyBundleDelta(slug, t.dataset.bundleId, -1);
    renderProductInputs();
    e.stopPropagation();
    return;
  }
  if (action === "size-step") {
    markEstimatePreviewStale();
    const delta = Number(t.dataset.delta) || 0;
    handleSizeStep(slug, t.dataset.channel, t.dataset.size, delta);
    renderProductInputs();
    e.stopPropagation();
  }
}

function onManualProductsInput(e) {
  const t = e.target.closest("[data-action='legacy-cases']");
  if (!t || t.tagName !== "INPUT") {
    return;
  }
  const slug = t.dataset.slug;
  const size = t.dataset.size;
  const st = productState[slug];
  const product = products.find((x) => x.slug === slug);
  if (!st) {
    return;
  }
  if (product && isManualSizeOutOfStock(product, size, "case")) {
    t.value = "";
    st.caseBySize[size] = 0;
    return;
  }
  const n = Math.max(0, Math.floor(Number(t.value) || 0));
  st.caseBySize[size] = n;
  markEstimatePreviewStale();
}

function fillStateSelect() {
  const sel = document.getElementById("addr_state");
  if (!sel) {
    return;
  }
  sel.innerHTML = `<option value="">Select</option>${US_STATES.map((c) => `<option value="${c}">${c}</option>`).join("")}`;
}

function readApplyLocalDiscount(form) {
  return Boolean(form?.apply_local_discount?.checked);
}

function readExpectedShipDateFromForm(form) {
  const raw = String(form?.expected_ship_date?.value || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : "";
}

function resetProductStateFromCatalog() {
  productState = {};
  for (const p of products) {
    ensureProductState(p);
  }
}

function hydrateProductStateFromOrder(order) {
  resetProductStateFromCatalog();
  const items = Array.isArray(order.items) ? order.items : [];
  for (const p of products) {
    const row = items.find((i) => String(i.slug) === p.slug);
    if (!row) {
      continue;
    }
    const st = productState[p.slug];
    const bundles = p.bundles || [];
    st.bundleQty = Object.fromEntries(bundles.map((b) => [b.id, 0]));
    for (const line of row.bundleLines || []) {
      const id = String(line.id || "").trim();
      const q = Math.floor(Number(line.qty) || 0);
      if (id in st.bundleQty) {
        st.bundleQty[id] = q;
      }
    }
    for (const sz of siteSizes) {
      st.caseBySize[sz] = Math.floor(Number(row.quantities?.[sz]) || 0);
      st.boxBySize[sz] = Math.floor(Number(row.boxQuantities?.[sz]) || 0);
    }
    st.openBundleDropdownId = null;
  }
}

function fillFormFromOrder(order) {
  const form = document.getElementById("manual-order-form");
  if (!form) {
    return;
  }
  form.cust_name.value = order.customer_name || "";
  form.cust_email.value = order.customer_email || "";
  form.cust_phone.value = order.customer_phone || "";
  if (form.expected_ship_date) {
    const ymd = String(order.shippo_shipment_date || "").trim();
    form.expected_ship_date.value = /^\d{4}-\d{2}-\d{2}$/.test(ymd) ? ymd : "";
  }
  if (!isWalkInMode()) {
    const fm = String(order.fulfillment_method || "carrier");
    if (form.querySelector(`input[name="fulfillment_method"][value="local_delivery"]`)) {
      if (fm === "local_delivery") {
        form.querySelector('input[name="fulfillment_method"][value="local_delivery"]').checked = true;
      } else if (fm === "pickup") {
        form.querySelector('input[name="fulfillment_method"][value="pickup"]').checked = true;
      } else {
        form.querySelector('input[name="fulfillment_method"][value="carrier"]').checked = true;
      }
    }
    const pay = String(order.payment_flow || "square_payment_link");
    if (form.querySelector(`input[name="payment_method"][value="pay_later"]`)) {
      if (pay === "pay_later") {
        form.querySelector('input[name="payment_method"][value="pay_later"]').checked = true;
      } else {
        form.querySelector('input[name="payment_method"][value="square_payment_link"]').checked = true;
      }
    }
    syncManualOrderFulfillmentUI(form, fm);
    if (form.addr_line1) {
      const isPickup = fm === "pickup" || (order.shipping_address?.line1 || "").includes("In-store / pickup");
      if (isPickup) {
        form.addr_line1.value = "";
        form.addr_line2.value = "";
        form.addr_city.value = "";
        form.addr_state.value = "";
        form.addr_zip.value = "";
      } else {
        const a = order.shipping_address && typeof order.shipping_address === "object" ? order.shipping_address : {};
        form.addr_line1.value = a.line1 || "";
        form.addr_line2.value = a.line2 || "";
        form.addr_city.value = a.city || "";
        form.addr_state.value = String(a.state || "").trim().toUpperCase() || "";
        form.addr_zip.value = a.postalCode || "";
      }
    }
    if (form.local_delivery_note) {
      form.local_delivery_note.value = "";
    }
  }
  const cb = document.getElementById("apply_local_discount");
  if (cb) {
    cb.checked = order.is_hardin_discount === true;
  }
}

function setEditingBanner(text, visible) {
  const el = document.getElementById("manual-editing-banner");
  if (!el) {
    return;
  }
  el.textContent = text || "";
  el.hidden = !visible;
}

function clearFormNewOrder() {
  editingOrderId = null;
  lastCreatedOrderId = null;
  allocationSubmitAttempted = false;
  clearManualAddressFieldErrors();
  hideManualAddressSuggestion();
  const form = document.getElementById("manual-order-form");
  if (form) {
    form.cust_name.value = "";
    form.cust_email.value = "";
    form.cust_phone.value = "";
    if (form.expected_ship_date) {
      form.expected_ship_date.value = "";
    }
    if (!isWalkInMode() && form.addr_line1) {
      form.addr_line1.value = "";
      form.addr_line2.value = "";
      form.addr_city.value = "";
      form.addr_zip.value = "";
    }
  }
  fillStateSelect();
  const cb = document.getElementById("apply_local_discount");
  if (cb) {
    cb.checked = false;
  }
  resetSendPaymentLinkButtonState();
  document.getElementById("btn-send-link")?.setAttribute("disabled", "");
  const payBtn = document.getElementById("btn-mark-walk-in-paid");
  if (payBtn) {
    payBtn.disabled = true;
  }
  const cashRadio = document.querySelector('input[name="walk_in_pay"][value="cash"]');
  if (cashRadio) {
    cashRadio.checked = true;
  }
  const receiptCb = document.getElementById("walk_in_send_receipt");
  if (receiptCb) {
    receiptCb.checked = false;
  }
  if (!isWalkInMode() && form.querySelector('input[name="fulfillment_method"][value="carrier"]')) {
    form.querySelector('input[name="fulfillment_method"][value="carrier"]').checked = true;
  }
  if (!isWalkInMode() && form.querySelector('input[name="payment_method"][value="square_payment_link"]')) {
    form.querySelector('input[name="payment_method"][value="square_payment_link"]').checked = true;
  }
  if (form.local_delivery_note) {
    form.local_delivery_note.value = "";
  }
  if (!isWalkInMode()) {
    syncManualOrderFulfillmentUI(form, "carrier");
  }
  syncWalkInPaymentPanel();
  const pvw = document.getElementById("manual-preview");
  if (pvw) {
    pvw.hidden = true;
  }
  const mres = document.getElementById("manual-result");
  if (mres) {
    mres.hidden = true;
  }
  lastQuote = null;
  estimateStale = false;
  resetShippingRateOptionsUI();
  setEditingBanner("", false);
  resetProductStateFromCatalog();
  renderProductInputs();
  discountOverrideConfirmed = false;
  setDiscountOverridePanelVisible(false);
  updateSaveButtonLabel();
}

function formatDraftWhen(iso) {
  if (!iso) {
    return "—";
  }
  try {
    return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  } catch {
    return "—";
  }
}

async function loadAndRenderDrafts() {
  const wrap = document.getElementById("manual-drafts-list");
  if (!wrap) {
    return;
  }
  const token = await getSessionToken();
  if (!token) {
    wrap.innerHTML = `<p class="admin-muted manual-drafts-empty">Sign in to load drafts.</p>`;
    return;
  }
  try {
    const { drafts } = await fetchReportJson(staffOrderApi("drafts"), token);
    const list = Array.isArray(drafts) ? drafts : [];
    if (!list.length) {
      wrap.innerHTML = `<p class="admin-muted manual-drafts-empty">No saved drafts.</p>`;
      return;
    }
    wrap.innerHTML = `<ul class="manual-drafts-ul">${list
      .map(
        (d) => `
      <li class="manual-drafts-li" data-draft-id="${escapeHtml(String(d.id))}">
        <div class="manual-drafts-li__main">
          <strong>${escapeHtml(d.order_ref || String(d.id))}</strong>
          <span class="admin-muted">${escapeHtml(d.customer_name || "—")} · ${escapeHtml(d.customer_email || "")}</span>
          <span class="admin-muted">Updated ${formatDraftWhen(d.updated_at || d.created_at)} · ${formatCurrency(d.total_cents)}</span>
        </div>
        <div class="manual-drafts-li__actions">
          <button type="button" class="admin-btn admin-btn--small" data-draft-edit="${escapeHtml(String(d.id))}">Edit</button>
          <button type="button" class="admin-btn admin-btn--small" data-draft-delete="${escapeHtml(String(d.id))}">Delete</button>
        </div>
      </li>`,
      )
      .join("")}</ul>`;
  } catch (e) {
    wrap.innerHTML = `<p class="admin-error">${escapeHtml(e.message || "Could not load drafts.")}</p>`;
  }
}

async function openDraftForEdit(orderId) {
  const errEl = document.getElementById("admin-load-error");
  if (errEl) {
    errEl.hidden = true;
  }
  const token = await getSessionToken();
  if (!token) {
    if (errEl) {
      errEl.textContent = "Sign in again.";
      errEl.hidden = false;
    }
    return;
  }
  try {
    const { order } = await fetchReportJson(
      `${staffOrderApi("drafts")}?id=${encodeURIComponent(orderId)}`,
      token,
    );
    hydrateProductStateFromOrder(order);
    editingOrderId = String(order.id);
    lastCreatedOrderId = String(order.id);
    fillFormFromOrder(order);
    lastQuote = null;
    estimateStale = !isWalkInMode() && String(order?.fulfillment_method || "").trim().toLowerCase() === "carrier";
    clearManualAddressFieldErrors();
    hideManualAddressSuggestion();
    clearManualShippingRateSelection();
    resetSendPaymentLinkButtonState();
    syncSendLinkButtonState();
    {
      const pvw = document.getElementById("manual-preview");
      if (pvw) pvw.hidden = true;
    }
    {
      const mres = document.getElementById("manual-result");
      if (mres) mres.hidden = true;
    }
    setEditingBanner(
      isWalkInMode()
        ? `Editing unpaid walk-in ${order.order_ref || order.id}. Update it, or use “New order” to start fresh.`
        : `Editing draft ${order.order_ref || order.id}. Save to update, or use “New order” to start fresh.`,
      true,
    );
    allocationSubmitAttempted = false;
    discountOverrideConfirmed = order.admin_local_discount_override === true;
    setDiscountOverridePanelVisible(false);
    renderProductInputs();
    updateSaveButtonLabel();
    syncWalkInPaymentPanel();
    document.getElementById("manual-order-form")?.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (e) {
    if (errEl) {
      errEl.textContent = e.message || "Could not open draft.";
      errEl.hidden = false;
    }
  }
}

async function deleteDraftById(orderId) {
  if (!confirm("Delete this draft permanently? This cannot be undone.")) {
    return;
  }
  const errEl = document.getElementById("admin-load-error");
  if (errEl) {
    errEl.hidden = true;
  }
  const token = await getSessionToken();
  if (!token) {
    if (errEl) {
      errEl.textContent = "Sign in again.";
      errEl.hidden = false;
    }
    return;
  }
  try {
    await fetchReportPost(staffOrderApi("delete-draft"), token, { orderId });
    if (String(editingOrderId) === String(orderId)) {
      clearFormNewOrder();
    }
    await loadAndRenderDrafts();
  } catch (e) {
    if (errEl) {
      errEl.textContent = e.message || "Delete failed.";
      errEl.hidden = false;
    }
  }
}

function bindDraftsListClicks() {
  const wrap = document.getElementById("manual-drafts-list");
  if (!wrap || wrap.dataset.bound === "1") {
    return;
  }
  wrap.dataset.bound = "1";
  wrap.addEventListener("click", (e) => {
    const editBtn = e.target.closest("[data-draft-edit]");
    if (editBtn) {
      void openDraftForEdit(editBtn.getAttribute("data-draft-edit"));
      return;
    }
    const delBtn = e.target.closest("[data-draft-delete]");
    if (delBtn) {
      void deleteDraftById(delBtn.getAttribute("data-draft-delete"));
    }
  });
}

async function getSessionToken() {
  if (!supabase) {
    return null;
  }
  const {
    data: { session },
  } = await supabase.auth.getSession();
  return session?.access_token || null;
}

async function runEstimate() {
  const form = document.getElementById("manual-order-form");
  const errEl = document.getElementById("admin-load-error");
  if (errEl) {
    errEl.hidden = true;
  }
  clearManualAddressFieldErrors();
  hideManualAddressSuggestion();

  const { items, errors } = buildItemsFromState();
  if (errors.length) {
    allocationSubmitAttempted = true;
    renderProductInputs();
    if (errEl) {
      errEl.textContent = errors.join("\n");
      errEl.hidden = false;
    }
    return null;
  }

  if (!items.length) {
    if (errEl) {
      errEl.textContent = "Add at least one product line (bundles + matching sizes, or legacy case counts).";
      errEl.hidden = false;
    }
    return null;
  }

  allocationSubmitAttempted = false;
  renderProductInputs();

  const fulfillmentMethod = getFulfillmentFromForm(form);
  if (fulfillmentMethod === "carrier") {
    const a = readAddressFromForm(form);
    if (!a.line1 || !a.city || !a.state || !a.postalCode) {
      if (errEl) {
        errEl.textContent =
          "Ship with carrier: enter a full address (street, city, state, ZIP), or choose local delivery / pickup.";
        errEl.hidden = false;
      }
      return null;
    }
  }
  const address = readAddressFromForm(form);
  const applyEligibleLocalDiscount = readApplyLocalDiscount(form);

  const token = await getSessionToken();
  if (!token) {
    if (errEl) {
      errEl.textContent = "Sign in again.";
      errEl.hidden = false;
    }
    return null;
  }

  const body = {
    items,
    address,
    applyEligibleLocalDiscount,
    forceApplyEligibleLocalDiscount: discountOverrideConfirmed,
    fulfillmentMethod,
    localDeliveryNote: String(form?.local_delivery_note?.value || "").trim(),
  };
  const isManualCarrier = fulfillmentMethod === "carrier" && !isWalkInMode();
  if (isManualCarrier) {
    const rateId = getRateIdForEstimateRequest();
    if (rateId) {
      body.selectedShippingRateObjectId = rateId;
      applyShippingRateStabilityFieldsToPayload(body, lastQuote, rateId);
    }
    applySelectedShippingSnapshotToPayload(body);
  }

  let data;
  try {
    data = await fetchReportPost(staffOrderApi("estimate"), token, body);
  } catch (e) {
    const errEl2 = document.getElementById("admin-load-error");
    if (e instanceof ReportPostError) {
      applyManualOrderAddressErrorsFromApiBody(e.body);
      if (errEl2) {
        errEl2.textContent = formatReportPostErrorForAdmin(e);
        errEl2.hidden = false;
      }
    } else {
      clearManualAddressFieldErrors();
      hideManualAddressSuggestion();
      if (errEl2) {
        errEl2.textContent = e.message || "Request failed.";
        errEl2.hidden = false;
      }
    }
    if (isManualCarrier) {
      estimateStale = true;
      resetShippingRateOptionsUI();
    }
    syncSendLinkButtonState();
    return null;
  }
  lastQuote = data;
  estimateStale = false;
  clearManualAddressFieldErrors();
  hideManualAddressSuggestion();

  if (data?.adminLocalDiscountForced) {
    discountOverrideConfirmed = true;
  }

  const preview = document.getElementById("manual-preview");
  const pre = document.getElementById("manual-preview-body");
  const v = quoteView(data);
  if (isManualCarrier && Array.isArray(data.shippingRateOptions) && data.shippingRateOptions.length) {
    lastShippingRateOptionsIds = new Set(
      data.shippingRateOptions.map((o) => String(o?.id || "").trim()).filter(Boolean),
    );
  } else {
    lastShippingRateOptionsIds = null;
  }
  const providerRateId = String(data?.shipping?.providerQuoteId || "").trim() || null;

  if (isManualCarrier && (v.shippingStatus === "rated" || (Array.isArray(data.shippingRateOptions) && data.shippingRateOptions.length))) {
    renderShippingRateOptionsFromData(data, providerRateId);
  } else {
    resetShippingRateOptionsUI();
  }
  userExplicitShippingRateId = null;

  const lines = [
    `Merchandise: ${v.merchandiseFormatted}`,
  ];
  if (v.discountFormatted) {
    lines.push(`Discount: −${v.discountFormatted}`);
  }
  if (v.shippingStatus === "rated") {
    const svc = v.shippingServiceLabel ? ` — ${v.shippingServiceLabel}` : "";
    lines.push(`Shipping: ${v.shippingFormatted}${svc}`);
    lines.push(`Residential surcharge: ${v.residentialSurchargeFormatted || "—"}`);
  } else {
    lines.push(`Shipping: ${shippingStatusLabel(v)}`);
  }
  lines.push(`Tax: ${v.taxFormatted}`, `Total: ${v.totalFormatted}`);
  if (v.userFacingError) {
    lines.push("", `Action needed: ${v.userFacingError}`);
  }
  if (Array.isArray(v.warnings) && v.warnings.length) {
    lines.push("", ...v.warnings.map((w) => `Note: ${w}`));
  }
  if (!v.canCheckout) {
    lines.push("", "Status: Quote is not ready for checkout. Resolve the issue above and recalculate.");
  }
  if (pre) {
    pre.textContent = lines.join("\n");
  }
  if (preview) {
    preview.hidden = false;
    preview.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
  syncDiscountOverridePanelAfterEstimate(data, form);
  syncSendLinkButtonState();

  return data;
}

async function saveDraft() {
  const form = document.getElementById("manual-order-form");
  const errEl = document.getElementById("admin-load-error");
  if (errEl) {
    errEl.hidden = true;
  }

  const { items, errors } = buildItemsFromState();
  if (errors.length) {
    allocationSubmitAttempted = true;
    renderProductInputs();
    if (errEl) {
      errEl.textContent = errors.join("\n");
      errEl.hidden = false;
    }
    return null;
  }

  if (!items.length) {
    if (errEl) {
      errEl.textContent = "Add at least one product line before saving.";
      errEl.hidden = false;
    }
    return null;
  }

  allocationSubmitAttempted = false;
  renderProductInputs();

  const address = readAddressFromForm(form);
  const token = await getSessionToken();
  if (!token) {
    if (errEl) {
      errEl.textContent = "Sign in again.";
      errEl.hidden = false;
    }
    return null;
  }

  const applyEligibleLocalDiscount = readApplyLocalDiscount(form);
  const baseBody = {
    name: String(form.cust_name?.value || "").trim(),
    email: String(form.cust_email?.value || "").trim(),
    phone: String(form.cust_phone?.value || "").trim(),
    address,
    items,
    applyEligibleLocalDiscount,
    adminLocalDiscountOverride: applyEligibleLocalDiscount && discountOverrideConfirmed,
    fulfillmentMethod: getFulfillmentFromForm(form),
    paymentFlow: getPaymentFromForm(form),
    localDeliveryNote: String(form?.local_delivery_note?.value || "").trim(),
    shipmentDate: readExpectedShipDateFromForm(form) || null,
  };
  if (!isWalkInMode() && getFulfillmentFromForm(form) === "carrier" && !estimateStale && lastQuote) {
    const rid = String(lastQuote.shipping?.providerQuoteId || "").trim();
    if (rid) {
      baseBody.selectedShippingRateObjectId = rid;
      applyShippingRateStabilityFieldsToPayload(baseBody, lastQuote, rid);
    }
    applySelectedShippingSnapshotToPayload(baseBody);
  }

  const data = editingOrderId
    ? await fetchReportPost(staffOrderApi("update-draft"), token, {
        orderId: editingOrderId,
        ...baseBody,
      })
    : await fetchReportPost(staffOrderApi("create"), token, baseBody);

  editingOrderId = String(data.orderId);
  lastCreatedOrderId = String(data.orderId);
  resetSendPaymentLinkButtonState();
  if (!isWalkInMode()) {
    syncSendLinkButtonState();
  }

  const resEl = document.getElementById("manual-result");
  const textEl = document.getElementById("manual-result-text");
  const resHeading = resEl?.querySelector("h3");
  if (resHeading) {
    resHeading.textContent = isWalkInMode() ? "Unpaid order created" : "Order saved";
  }
  const payLater = getPaymentFromForm(form) === "pay_later";
  textEl.textContent = isWalkInMode()
    ? `Reference ${data.orderRef} · Total ${data.totalFormatted}\nCollect payment (cash or check), then Mark as paid to complete the walk-in order. Optionally check “Send receipt email” if the customer has an email.`
    : payLater
      ? `Reference ${data.orderRef} · Total ${data.totalFormatted}\nPay later: the order remains unpaid. Use the Orders list to track it; a Square link is not used for this payment mode.`
      : `Reference ${data.orderRef} · Total ${data.totalFormatted}\nYou can now send the payment link email to the customer.`;
  resEl.hidden = false;
  setEditingBanner(`Editing draft ${data.orderRef}. Save again to update totals after changes.`, true);
  updateSaveButtonLabel();
  syncWalkInPaymentPanel();
  await loadAndRenderDrafts();
  return data;
}

async function markWalkInPaid() {
  const errEl = document.getElementById("admin-load-error");
  errEl.hidden = true;
  const oid = lastCreatedOrderId || editingOrderId;
  if (!oid) {
    errEl.textContent = "Save a walk-in draft first.";
    errEl.hidden = false;
    return;
  }
  const method = document.querySelector('input[name="walk_in_pay"]:checked')?.value;
  if (method !== "cash" && method !== "check") {
    errEl.textContent = "Select Cash or Check.";
    errEl.hidden = false;
    return;
  }
  const form = document.getElementById("manual-order-form");
  const sendReceipt = document.getElementById("walk_in_send_receipt")?.checked === true;
  const email = String(form?.cust_email?.value || "").trim();
  if (sendReceipt && !email.includes("@")) {
    errEl.textContent = "Enter a customer email to send a receipt, or uncheck “Send receipt email”.";
    errEl.hidden = false;
    return;
  }
  const token = await getSessionToken();
  if (!token) {
    errEl.textContent = "Sign in again.";
    errEl.hidden = false;
    return;
  }
  const btn = document.getElementById("btn-mark-walk-in-paid");
  if (btn) {
    btn.disabled = true;
  }
  try {
    const data = await fetchReportPost(staffOrderApi("mark-paid"), token, {
      orderId: String(oid),
      paymentMethod: method,
      sendReceipt,
    });
    const resEl = document.getElementById("manual-result");
    const textEl = document.getElementById("manual-result-text");
    const prev = String(textEl?.textContent || "").trim();
    const receiptLine =
      data.receiptEmailAttempted === true
        ? data.receiptEmailSent === true
          ? "\n\nReceipt email sent."
          : `\n\nReceipt not sent (${String(data.receiptEmailReason || "see server logs")}).`
        : "";
    const inventoryLine = data.inventoryWarning ? `\n\n${String(data.inventoryWarning)}` : "";
    const msg = `Marked paid (${data.paymentMethod || method}).${receiptLine}${inventoryLine}`;
    if (textEl) {
      textEl.textContent = prev ? `${prev}\n\n${msg}` : msg;
    }
    if (resEl) {
      resEl.hidden = false;
    }
    await loadAndRenderDrafts();
    editingOrderId = null;
    lastCreatedOrderId = null;
    clearFormNewOrder();
  } catch (e) {
    errEl.textContent = e.message || "Could not mark paid.";
    errEl.hidden = false;
  } finally {
    if (btn) {
      btn.disabled = false;
    }
  }
}

function setWalkInQuickPayButtonsBusy(busy) {
  const cashBtn = document.getElementById("btn-quick-pay-cash");
  const checkBtn = document.getElementById("btn-quick-pay-check");
  if (cashBtn) {
    cashBtn.disabled = Boolean(busy);
  }
  if (checkBtn) {
    checkBtn.disabled = Boolean(busy);
  }
}

async function quickPayWalkIn(paymentMethod) {
  if (!isWalkInMode()) {
    return;
  }
  const method = String(paymentMethod || "").trim().toLowerCase();
  if (method !== "cash" && method !== "check") {
    return;
  }
  const errEl = document.getElementById("admin-load-error");
  if (errEl) {
    errEl.hidden = true;
  }
  const form = document.getElementById("manual-order-form");
  const { items, errors } = buildItemsFromState();
  if (errors.length) {
    allocationSubmitAttempted = true;
    renderProductInputs();
    if (errEl) {
      errEl.textContent = errors.join("\n");
      errEl.hidden = false;
    }
    return;
  }
  if (!items.length) {
    if (errEl) {
      errEl.textContent = "Add at least one product line.";
      errEl.hidden = false;
    }
    return;
  }

  const token = await getSessionToken();
  if (!token) {
    if (errEl) {
      errEl.textContent = "Sign in again.";
      errEl.hidden = false;
    }
    return;
  }

  const payload = {
    name: String(form?.cust_name?.value || "").trim(),
    email: String(form?.cust_email?.value || "").trim(),
    phone: String(form?.cust_phone?.value || "").trim(),
    items,
    applyEligibleLocalDiscount: readApplyLocalDiscount(form),
    paymentMethod: method,
    sendReceipt: document.getElementById("walk_in_send_receipt")?.checked === true,
  };

  setWalkInQuickPayButtonsBusy(true);
  try {
    const data = await fetchReportPost("/api/admin-walk-in-order-quick-pay", token, payload);
    await loadAndRenderDrafts();
    clearFormNewOrder();

    const resEl = document.getElementById("manual-result");
    const textEl = document.getElementById("manual-result-text");
    const resHeading = resEl?.querySelector("h3");
    if (resHeading) {
      resHeading.textContent = "Payment completed";
    }
    const receiptLine =
      data.receiptEmailAttempted === true
        ? data.receiptEmailSent === true
          ? "\n\nReceipt email sent."
          : `\n\nReceipt not sent (${String(data.receiptEmailReason || "see server logs")}).`
        : "";
    const inventoryLine = data.inventoryWarning ? `\n\n${String(data.inventoryWarning)}` : "";
    const msg = `Walk-in paid (${String(data.paymentMethod || method)}). Reference ${String(
      data.orderRef || "—",
    )} · Total ${String(data.totalFormatted || "—")}.${receiptLine}${inventoryLine}`;
    if (textEl) {
      textEl.textContent = msg;
    }
    if (resEl) {
      resEl.hidden = false;
    }
  } catch (e) {
    if (errEl) {
      errEl.textContent = e.message || "Quick pay failed.";
      errEl.hidden = false;
    }
  } finally {
    setWalkInQuickPayButtonsBusy(false);
  }
}

async function sendPaymentLink() {
  const errEl = document.getElementById("admin-load-error");
  if (errEl) {
    errEl.textContent = "";
    errEl.hidden = true;
  }
  const btn = document.getElementById("btn-send-link");
  if (!btn) {
    return;
  }
  if (btn.dataset.sending === "1") {
    return;
  }
  const form = document.getElementById("manual-order-form");
  if (form && getPaymentFromForm(form) === "pay_later") {
    if (errEl) {
      errEl.textContent =
        "This draft is set to Pay later. Change payment to Send Square payment link (and save) to email a checkout, or mark paid in person when that flow exists.";
      errEl.hidden = false;
    }
    return;
  }
  const token = await getSessionToken();
  if (!token) {
    if (errEl) {
      errEl.textContent = "Sign in again.";
      errEl.hidden = false;
    }
    return;
  }

  btn.dataset.sending = "1";
  btn.disabled = true;
  btn.textContent = SEND_PAYMENT_LINK_BUSY_LABEL;
  let oid = null;
  try {
    const saved = await saveDraft();
    btn.textContent = SEND_PAYMENT_LINK_BUSY_LABEL;
    if (!saved || !saved.orderId) {
      if (errEl) {
        errEl.textContent =
          "Could not create order before sending payment link. Fix any errors and try again.";
        errEl.hidden = false;
      }
      return;
    }
    oid = String(saved.orderId);
  } catch (e) {
    if (errEl) {
      errEl.textContent = e?.message || "Could not create order before sending payment link.";
      errEl.hidden = false;
    }
    return;
  }

  const needsCarrierQuote = !isWalkInMode() && getFulfillmentFromForm(form) === "carrier";
  const hasFreshCarrierQuote =
    lastQuote &&
    typeof lastQuote === "object" &&
    String(lastQuote?.shipping?.quoteStatus || "").trim() === "rated" &&
    estimateStale !== true;
  if (needsCarrierQuote && !hasFreshCarrierQuote) {
    if (errEl) {
      errEl.textContent = "Please get fresh shipping rates before sending the invoice.";
      errEl.hidden = false;
    }
    return;
  }

  const sendPayload = {
    orderId: oid,
    shipmentDate: readExpectedShipDateFromForm(form) || null,
  };
  if (!isWalkInMode() && getFulfillmentFromForm(form) === "carrier" && !estimateStale && lastQuote) {
    const rid = String(lastQuote.shipping?.providerQuoteId || "").trim();
    if (rid) {
      sendPayload.selectedShippingRateObjectId = rid;
      applyShippingRateStabilityFieldsToPayload(sendPayload, lastQuote, rid);
    }
    applySelectedShippingSnapshotToPayload(sendPayload);
  }
  try {
    const data = await fetchReportPost("/api/admin-manual-order-send-link", token, sendPayload);
    const msg =
      data.warning ||
      (data.emailed === true
        ? "Payment link emailed to the customer."
        : "Payment link was created but the email was not sent — share the link manually or fix email settings.");
    const resEl = document.getElementById("manual-result");
    const textEl = document.getElementById("manual-result-text");
    if (textEl) {
      const prev = String(textEl.textContent || "").trim();
      textEl.textContent = prev ? `${prev}\n\n${msg}` : msg;
      if (data.checkoutUrl && data.warning) {
        textEl.textContent += `\n\nLink: ${data.checkoutUrl}`;
      }
    }
    if (resEl) {
      resEl.hidden = false;
    }
    if (data.emailed === true) {
      lockSendPaymentLinkButtonAfterEmail();
    }
    await loadAndRenderDrafts();
  } catch (e) {
    if (errEl) {
      errEl.textContent = e.message || "Failed to send link.";
      errEl.hidden = false;
    }
  } finally {
    delete btn.dataset.sending;
    if (btn.dataset.paymentLinkSent !== "1") {
      btn.textContent = SEND_PAYMENT_LINK_DEFAULT_LABEL;
      syncSendLinkButtonState();
    }
  }
}

async function createUnpaidOrder() {
  const errEl = document.getElementById("admin-load-error");
  if (errEl) {
    errEl.textContent = "";
    errEl.hidden = true;
  }
  const form = document.getElementById("manual-order-form");
  if (!form) {
    return;
  }
  if (getPaymentFromForm(form) !== "pay_later") {
    if (errEl) {
      errEl.textContent = "Switch payment mode to Pay later to create an unpaid order.";
      errEl.hidden = false;
    }
    return;
  }
  const btn = document.getElementById("btn-create-unpaid");
  if (!btn) {
    return;
  }
  if (btn.dataset.creating === "1") {
    return;
  }
  btn.dataset.creating = "1";
  btn.disabled = true;
  btn.textContent = CREATE_UNPAID_BUSY_LABEL;
  try {
    await saveDraft();
  } catch (e) {
    if (errEl) {
      errEl.textContent = e?.message || "Could not create unpaid order.";
      errEl.hidden = false;
    }
  } finally {
    delete btn.dataset.creating;
    btn.textContent = CREATE_UNPAID_DEFAULT_LABEL;
    syncSendLinkButtonState();
  }
}

async function loadProducts() {
  const res = await fetch("/api/products");
  const data = await res.json().catch(() => ({}));
  if (Array.isArray(data.site?.sizes)) {
    siteSizes = data.site.sizes;
  }
  products = Array.isArray(data.products) ? data.products : [];
  productState = {};
  allocationSubmitAttempted = false;
  renderProductInputs();
}

async function bootstrapManualOrderData() {
  await loadProducts();
  bindDraftsListClicks();
  await loadAndRenderDrafts();
  updateSaveButtonLabel();
  syncWalkInPaymentPanel();
  if (!isWalkInMode()) {
    const mform = document.getElementById("manual-order-form");
    if (mform) {
      mform.addEventListener("change", (e) => {
        const t = e.target;
        if (t?.name === "fulfillment_method") {
          markEstimatePreviewStale();
          syncManualOrderFulfillmentUI(mform);
        } else if (t?.name === "payment_method") {
          syncSendLinkButtonState();
        }
      });
      syncManualOrderFulfillmentUI(mform);
    }
  }
}

async function init() {
  let config = null;
  try {
    config = await fetchSupabasePublicConfig();
  } catch (e) {
    const le = document.getElementById("admin-load-error");
    if (le) {
      le.textContent = e?.message || "Add SUPABASE_URL and SUPABASE_ANON_KEY to the server environment.";
      le.hidden = false;
    }
    showLogin();
  }

  if (config?.supabaseUrl && config?.supabaseAnonKey) {
    supabase = createSupabaseAdminClient(config.supabaseUrl, config.supabaseAnonKey);
  } else {
    supabase = null;
  }

  fillStateSelect();

  if (supabase) {
    const {
      data: { session },
    } = await supabase.auth.getSession();

    if (session?.user) {
      primeAdminSessionUser(session);
      showApp();
      document.getElementById("admin-user-email").textContent = session.user.email || "";
      renderAdminNav(activeAdminNavId());
      await bootstrapManualOrderData();
    } else {
      showLogin();
    }

    supabase.auth.onAuthStateChange(async (event, sess) => {
      if (event === "SIGNED_IN" && sess?.user) {
        if (!shouldBootstrapAdminSignedIn(sess)) {
          return;
        }
        document.getElementById("admin-user-email").textContent = sess.user.email || "";
        showApp();
        renderAdminNav(activeAdminNavId());
        await bootstrapManualOrderData();
      }
      if (event === "SIGNED_OUT") {
        clearAdminSessionUser();
        showLogin();
      }
    });
  } else {
    showLogin();
  }

  document.getElementById("login-form")?.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const errEl = document.getElementById("login-error");
    errEl.hidden = true;
    if (!supabase) {
      errEl.textContent =
        "Server did not return Supabase configuration. Set SUPABASE_URL and SUPABASE_ANON_KEY, restart the server, and refresh.";
      errEl.hidden = false;
      return;
    }
    const fd = new FormData(ev.target);
    const email = String(fd.get("email") || "").trim();
    const password = String(fd.get("password") || "");
    const { data: signInData, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      errEl.textContent = error.message;
      errEl.hidden = false;
      return;
    }
    const session = signInData?.session
      ? signInData.session
      : (await supabase.auth.getSession()).data?.session ?? null;
    if (session) {
      primeAdminSessionUser(session);
    }
    showApp();
    document.getElementById("admin-user-email").textContent = session?.user?.email || email;
    renderAdminNav(activeAdminNavId());
    await bootstrapManualOrderData();
  });

  document.getElementById("admin-logout")?.addEventListener("click", async () => {
    if (supabase) {
      await supabase.auth.signOut();
    } else {
      showLogin();
    }
  });

  const manualRoot = document.getElementById("manual-products");
  manualRoot?.addEventListener("click", onManualProductsClick);
  manualRoot?.addEventListener("input", onManualProductsInput);
  document.addEventListener("click", onDocumentClickBundles, false);

  document.getElementById("manual-shipping-rate-options")?.addEventListener("change", (e) => {
    const t = e.target;
    if (t?.name !== "manual_shipping_rate") {
      return;
    }
    const next = String(t.value || "").trim();
    if (!next) {
      return;
    }
    if (lastShippingRateOptionsIds && !lastShippingRateOptionsIds.has(next)) {
      return;
    }
    if (String(lastQuote?.shipping?.providerQuoteId || "").trim() === next) {
      return;
    }
    userExplicitShippingRateId = next;
    const btn = document.getElementById("btn-estimate");
    if (btn) {
      btn.disabled = true;
    }
    void runEstimate().finally(() => {
      if (btn) {
        btn.disabled = false;
      }
    });
  });

  document.getElementById("btn-get-shipping-rates")?.addEventListener("click", async () => {
    if (isWalkInMode()) {
      return;
    }
    const btn = document.getElementById("btn-get-shipping-rates");
    userExplicitShippingRateId = null;
    lastShippingRateOptionsIds = null;
    resetShippingRateOptionsUI();
    if (btn) {
      btn.disabled = true;
    }
    try {
      await runEstimate();
    } finally {
      if (btn) {
        btn.disabled = false;
      }
    }
  });

  document.getElementById("btn-new-order")?.addEventListener("click", () => {
    clearFormNewOrder();
    void loadAndRenderDrafts();
  });

  document.getElementById("apply_local_discount")?.addEventListener("change", () => {
    discountOverrideConfirmed = false;
    setDiscountOverridePanelVisible(false);
    markEstimatePreviewStale();
  });

  const manualForm = document.getElementById("manual-order-form");
  function onManualFormFieldActivity(e) {
    const name = e?.target?.name;
    if (!name) {
      return;
    }
    const apiKey = MANUAL_FORM_NAME_TO_API_KEY[name];
    if (apiKey) {
      clearSingleManualAddressFieldError(apiKey);
    }
    const affectsQuote = [
      "addr_line1",
      "addr_line2",
      "addr_city",
      "addr_state",
      "addr_zip",
      "apply_local_discount",
    ];
    if (affectsQuote.includes(name)) {
      markEstimatePreviewStale();
    }
  }
  manualForm?.addEventListener("input", onManualFormFieldActivity);
  manualForm?.addEventListener("change", onManualFormFieldActivity);

  document.getElementById("manual-address-use-suggested")?.addEventListener("click", () => {
    applySuggestedAddressToManualForm();
  });

  document.getElementById("btn-discount-override")?.addEventListener("click", async () => {
    const btn = document.getElementById("btn-discount-override");
    discountOverrideConfirmed = true;
    setDiscountOverridePanelVisible(false);
    if (btn) {
      btn.disabled = true;
    }
    try {
      await runEstimate();
    } finally {
      if (btn) {
        btn.disabled = false;
      }
    }
  });

  document.getElementById("btn-estimate")?.addEventListener("click", async () => {
    const btn = document.getElementById("btn-estimate");
    if (btn) {
      btn.disabled = true;
    }
    try {
      await runEstimate();
    } catch (e) {
      const errEl = document.getElementById("admin-load-error");
      if (errEl) {
        errEl.textContent = formatReportPostErrorForAdmin(e);
        errEl.hidden = false;
      }
    } finally {
      if (btn) {
        btn.disabled = false;
      }
    }
  });

  document.getElementById("btn-save-draft")?.addEventListener("click", async () => {
    const btn = document.getElementById("btn-save-draft");
    if (btn) {
      btn.disabled = true;
    }
    try {
      await saveDraft();
    } catch (e) {
      const errEl = document.getElementById("admin-load-error");
      if (errEl) {
        errEl.textContent = e.message || "Could not save.";
        errEl.hidden = false;
      }
    } finally {
      if (btn) {
        btn.disabled = false;
      }
    }
  });

  document.getElementById("btn-send-link")?.addEventListener("click", () => void sendPaymentLink());
  document.getElementById("btn-create-unpaid")?.addEventListener("click", () => void createUnpaidOrder());
  document.getElementById("btn-mark-walk-in-paid")?.addEventListener("click", () => void markWalkInPaid());
  document.getElementById("btn-quick-pay-cash")?.addEventListener("click", () => void quickPayWalkIn("cash"));
  document.getElementById("btn-quick-pay-check")?.addEventListener("click", () => void quickPayWalkIn("check"));
}

init();
