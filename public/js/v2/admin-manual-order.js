/*
 * SAI Goods admin-v2 — Manual Order (Phase 10B-2B: payment-link-only).
 *
 * Allowed network:
 *   - GET  /api/products
 *   - POST /api/admin-manual-order-estimate
 *   - POST /api/admin-manual-order-create   (paymentFlow always square_payment_link)
 *   - POST /api/admin-manual-order-send-link
 *
 * Out of scope: pay-later / unpaid create, drafts CRUD, record-payment, resend,
 * Walk-in, force-stock override, labels, cancel/refund, fulfillment actions.
 */

import { formatCurrency } from "../catalog.js";
import { isBundleAllocationValid, requiredUnitsFromBundleLines } from "../bundle-validation.js";
import {
  inventoryAllowsAllocations,
  isProductStorefrontOutOfStock,
  isSizeChannelPurchasable,
} from "../size-availability.js";
import { fetchReportPost, ReportPostError } from "../admin-shared.js";
import { LOCAL_DELIVERY_AREA_ERROR, isLocalDeliveryServiceArea } from "../hardin-county.js";
import {
  card,
  closeDrawer,
  escapeHtml,
  icon,
  openDrawer,
  orderBuilderModeSwitch,
  pageHeader,
  setDrawerCloseGuard,
  statusChip,
  toast,
} from "./ui.js";
import { bootAdminV2Page } from "./page-boot.js";
import {
  ManualOrderLocalAuthError,
  allowCreateAnotherManualOrder,
  classifyManualOrderCreateFailure,
  classifyManualOrderSendLinkFailure,
  classifyManualOrderSendLinkSuccess,
  formatManualOrderAddressSummary,
  isManualOrderLocalAuthError,
  preCreateRejectionControlState,
  runGuardedManualOrderEstimate,
} from "./manual-order-safety.js";

/** Strict POST allowlist for Manual Order v2. */
export const MANUAL_ORDER_V2_POST_ENDPOINTS = new Set([
  "/api/admin-manual-order-estimate",
  "/api/admin-manual-order-create",
  "/api/admin-manual-order-send-link",
]);

/**
 * Allowlisted POST helper. Rejects every other endpoint before network.
 * @param {string} endpoint
 * @param {string} token
 * @param {object} [body]
 */
export async function fetchManualOrderPost(endpoint, token, body) {
  if (!MANUAL_ORDER_V2_POST_ENDPOINTS.has(endpoint)) {
    throw new Error("This action is not available in Admin v2 Manual Order.");
  }
  return fetchReportPost(endpoint, token, body);
}

/** @type {() => Promise<string|undefined>} */
let getToken = async () => undefined;

const US_STATES = [
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA", "HI", "ID", "IL", "IN", "IA", "KS", "KY",
  "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND",
  "OH", "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY", "DC",
];

const PICKUP_NOTE =
  "Pickup uses the stored Savannah pickup address on the server. Staff do not enter a ship-to address.";

const SEND_PAYMENT_LINK_PHRASE = "SEND PAYMENT LINK";
const LEGACY_MANUAL_ORDER_HREF = "/admin/manual-order.html";
const ORDERS_V2_HREF = "/admin-v2/orders";
const MANUAL_DISCOUNT_PRESETS = [
  { type: "none", value: 0, label: "None", detail: "No merchandise discount" },
  { type: "percent", value: 5, label: "5%", detail: "Take 5% off merchandise" },
  { type: "percent", value: 10, label: "10%", detail: "Take 10% off merchandise" },
  { type: "percent", value: 15, label: "15%", detail: "Take 15% off merchandise" },
  { type: "amount", value: null, label: "Custom amount", detail: "Set a fixed dollar amount" },
];

/** @type {object[]} */
let products = [];
/** @type {string[]} */
let siteSizes = ["S", "M", "L", "XL"];
/** @type {Record<string, { bundleQty: Record<string, number>, caseBySize: Record<string, number>, boxBySize: Record<string, number>, ui: { bundleOpen: boolean, sizeOpen: boolean } }>} */
let productState = {};
/** Slugs with expanded product detail. */
const openProductSlugs = new Set();
let allocationSubmitAttempted = false;
/** @type {object|null} */
let lastQuote = null;
let estimateStale = false;
let manualDiscountSelection = defaultManualDiscountSelection();
/** @type {string|null} */
let selectedRateId = null;
/** @type {null | { id: string, provider: string, serviceCode: string, serviceLabel: string, amountCents: number|null, parcelCount: number|null, residentialSurchargeCents: number|null }} */
let selectedShippingRateSnapshot = null;
let estimateInFlight = false;
/** Monotonic revision of quote-relevant form inputs; discarded in-flight estimates when it advances. */
let estimateInputRevision = 0;
/** One guard for the entire create + send-link sequence. */
let paymentLinkInFlight = false;
/** @type {null | { orderId: string, orderRef: string, totalFormatted: string }} */
let lastCreatedOrder = null;
/** @type {"" | "Creating order draft" | "Creating Square payment link" | "Sending customer email"} */
let paymentLinkStage = "";

function getEl(id) {
  return document.getElementById(id);
}

function defaultManualDiscountSelection() {
  return { type: "none", value: 0 };
}

function normalizeManualDiscountSelection(selection) {
  const rawType = String(selection?.type || "")
    .trim()
    .toLowerCase();
  if (!rawType || rawType === "none") {
    return defaultManualDiscountSelection();
  }
  if (rawType === "percent") {
    const percent = Math.round(Number(selection?.value));
    if (percent === 5 || percent === 10 || percent === 15) {
      return { type: "percent", value: percent };
    }
    return defaultManualDiscountSelection();
  }
  if (rawType === "amount") {
    const amountCents = Math.round(Number(selection?.value));
    if (Number.isFinite(amountCents) && amountCents > 0) {
      return { type: "amount", value: amountCents };
    }
  }
  return defaultManualDiscountSelection();
}

function manualDiscountSelectionsEqual(a, b) {
  const left = normalizeManualDiscountSelection(a);
  const right = normalizeManualDiscountSelection(b);
  return left.type === right.type && left.value === right.value;
}

function manualDiscountLabel(selection) {
  const normalized = normalizeManualDiscountSelection(selection);
  if (normalized.type === "percent") {
    return `${normalized.value}% off`;
  }
  if (normalized.type === "amount") {
    return `${formatCurrency(normalized.value)} off`;
  }
  return "None";
}

function manualDiscountSelectionSummary(selection) {
  const normalized = normalizeManualDiscountSelection(selection);
  if (normalized.type === "percent") {
    return `${normalized.value}% off merchandise`;
  }
  if (normalized.type === "amount") {
    return `${formatCurrency(normalized.value)} off merchandise`;
  }
  return "No merchandise discount";
}

function manualDiscountButtonMeta(option, currentSelection) {
  if (option.type === "amount") {
    if (currentSelection.type === "amount") {
      return `${formatCurrency(currentSelection.value)} off merchandise`;
    }
    return option.detail;
  }
  return option.detail;
}

function manualDiscountPayloadFields() {
  const normalized = normalizeManualDiscountSelection(manualDiscountSelection);
  return {
    manualDiscountType: normalized.type,
    manualDiscountValue: normalized.value,
  };
}

function parseCustomDiscountAmountInput(value) {
  const cents = Math.round(Number(value) * 100);
  if (!Number.isFinite(cents) || cents < 1) {
    return null;
  }
  return cents;
}

function sumChannel(map) {
  return Object.values(map || {}).reduce((s, n) => s + (Math.floor(Number(n)) || 0), 0);
}

function supportedSizesForProduct(product) {
  const fromProduct = Array.isArray(product?.sizes) ? product.sizes.map(String) : [];
  const base = fromProduct.length ? fromProduct : siteSizes;
  return base.filter((s) => siteSizes.includes(s) || fromProduct.includes(s));
}

function isManualProductOutOfStock(product) {
  return isProductStorefrontOutOfStock(product, supportedSizesForProduct(product));
}

function isManualSizeOutOfStock(product, size, channel = "case") {
  return !isSizeChannelPurchasable(product, size, channel);
}

function productStockChip(product) {
  if (isManualProductOutOfStock(product)) return statusChip("Out of stock", "danger");
  const sizes = supportedSizesForProduct(product);
  let anyLow = false;
  for (const size of sizes) {
    const lines = Array.isArray(product?.inventory?.lines) ? product.inventory.lines : [];
    for (const ch of ["case", "box"]) {
      const line = lines.find(
        (l) => l.productSlug === product.slug && l.size === size && l.channel === ch && l.track === true,
      );
      if (!line) continue;
      const avail =
        line.available != null && Number.isFinite(Number(line.available))
          ? Math.max(0, Number(line.available))
          : Math.max(0, Math.floor(Number(line.onHand) || 0) - Math.floor(Number(line.reserved) || 0));
      const thr = Math.max(0, Math.floor(Number(line.lowStockThreshold) || 0));
      if (thr > 0 && avail > 0 && avail <= thr) anyLow = true;
    }
  }
  if (anyLow) return statusChip("Low stock", "warning");
  return statusChip("In stock", "success");
}

function ensureProductState(product) {
  const slug = product.slug;
  if (productState[slug]) {
    if (!productState[slug].ui) {
      productState[slug].ui = { bundleOpen: true, sizeOpen: false };
    }
    return;
  }
  const bundles = product.bundles || [];
  productState[slug] = {
    bundleQty: Object.fromEntries(bundles.map((b) => [b.id, 0])),
    caseBySize: Object.fromEntries(siteSizes.map((s) => [s, 0])),
    boxBySize: Object.fromEntries(siteSizes.map((s) => [s, 0])),
    ui: {
      bundleOpen: true,
      sizeOpen: false,
    },
  };
}

function computeRequiredUnits(product, bundleQty) {
  let reqBox = 0;
  let reqCase = 0;
  for (const b of product.bundles || []) {
    const q = Math.floor(bundleQty[b.id] || 0);
    if (q < 1) continue;
    const units = Math.max(0, Math.floor(Number(b.units) || 0));
    if (String(b.kind).toLowerCase() === "box") reqBox += q * units;
    else reqCase += q * units;
  }
  return { reqBox, reqCase };
}

function clearSizeChannel(st, channel) {
  const map = channel === "box" ? st.boxBySize : st.caseBySize;
  for (const s of Object.keys(map)) map[s] = 0;
}

/**
 * When package requirements change, clear size assignments for that channel.
 * Staff assign sizes manually — never auto-assign (avoids parking qty on OOS sizes).
 */
function applyBundleRequirementDeltas(slug, prevReq, nextReq) {
  const product = products.find((x) => x.slug === slug);
  if (!product) return;
  const st = productState[slug];
  if (nextReq.reqBox !== prevReq.reqBox) clearSizeChannel(st, "box");
  if (nextReq.reqCase !== prevReq.reqCase) clearSizeChannel(st, "case");
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
    (b) => String(b.kind).toLowerCase() !== "box" && (bundleQty[b.id] || 0) > 0,
  );
}

function bundleLinesPayload(bundleQty) {
  return Object.entries(bundleQty)
    .filter(([, q]) => Math.floor(q || 0) > 0)
    .map(([id, qty]) => ({ id, qty: Math.floor(qty) }));
}

function compactQuantities(map, sizes) {
  const out = {};
  for (const s of sizes) {
    const n = Math.floor(Number(map?.[s]) || 0);
    if (n > 0) out[s] = n;
  }
  return out;
}

function safeIsBundleAllocationValid(product, bundleLines, caseMap, boxMap) {
  try {
    return isBundleAllocationValid(
      product,
      bundleLines,
      caseMap,
      boxMap,
      supportedSizesForProduct(product),
    );
  } catch {
    return false;
  }
}

function buildItemsFromState() {
  const errors = [];
  const items = [];

  for (const p of products) {
    const st = productState[p.slug];
    if (!st) continue;

    const hasCatalogBundles = Array.isArray(p.bundles) && p.bundles.length > 0;
    const bundleLines = bundleLinesPayload(st.bundleQty);
    const sumCase = sumChannel(st.caseBySize);
    const sumBox = sumChannel(st.boxBySize);

    if (!hasCatalogBundles) {
      const quantities = compactQuantities(st.caseBySize, siteSizes);
      const blocked = Object.keys(quantities).filter((size) => isManualSizeOutOfStock(p, size, "case"));
      if (blocked.length) {
        errors.push(`${p.name || p.slug}: Out of stock for ${blocked.join(", ")}.`);
        continue;
      }
      if (Object.keys(quantities).length) {
        items.push({ slug: p.slug, quantities, boxQuantities: {} });
      }
      continue;
    }

    if (!bundleLines.length && sumCase + sumBox === 0) continue;

    if (!bundleLines.length && sumCase + sumBox > 0) {
      errors.push(`${p.name || p.slug}: Choose bundle packs before entering sizes.`);
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
        parts.push(`cases must total ${req.cases} (currently ${sumCase})`);
      }
      if (showBoxColumn(p, st.bundleQty) && req.boxes > 0) {
        parts.push(`boxes must total ${req.boxes} (currently ${sumBox})`);
      }
      errors.push(`${p.name || p.slug}: ${parts.join("; ") || "size allocation does not match bundles"}.`);
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
      errors.push(`${p.name || p.slug}: Out of stock for ${blocked.join(", ")}.`);
      continue;
    }
    if (!inventoryAllowsAllocations(p, quantities, boxQuantities, supportedSizesForProduct(p))) {
      errors.push(`${p.name || p.slug}: Selected sizes exceed sellable stock.`);
      continue;
    }
    items.push({ slug: p.slug, bundleLines, quantities, boxQuantities });
  }

  return { items, errors };
}

function applyBundleDelta(slug, bundleId, delta) {
  const product = products.find((p) => p.slug === slug);
  if (!product || isManualProductOutOfStock(product)) return;
  ensureProductState(product);
  const st = productState[slug];
  const hadSelection = hasAnyBundleSelection(st.bundleQty);
  const prevReq = computeRequiredUnits(product, st.bundleQty);
  const next = Math.max(0, Math.floor(Number(st.bundleQty[bundleId]) || 0) + delta);
  st.bundleQty[bundleId] = next;
  const nextReq = computeRequiredUnits(product, st.bundleQty);
  const hasSelection = hasAnyBundleSelection(st.bundleQty);
  if (!hadSelection && hasSelection) {
    st.ui.bundleOpen = false;
    st.ui.sizeOpen = true;
  } else if (hadSelection && !hasSelection) {
    st.ui.bundleOpen = true;
    st.ui.sizeOpen = false;
  }
  applyBundleRequirementDeltas(slug, prevReq, nextReq);
  markEstimateInputsChanged();
  renderProducts();
}

function handleSizeStep(slug, channel, size, delta) {
  const product = products.find((p) => p.slug === slug);
  if (!product) return;
  ensureProductState(product);
  const st = productState[slug];
  const map = channel === "box" ? st.boxBySize : st.caseBySize;
  const { reqBox, reqCase } = computeRequiredUnits(product, st.bundleQty);
  const req = channel === "box" ? reqBox : reqCase;
  const cur = Math.floor(Number(map[size]) || 0);
  const oos = isManualSizeOutOfStock(product, size, channel);

  // Plus is blocked for OOS; minus must stay allowed so staff can clear invalid qty.
  if (delta > 0 && oos) return;
  if (delta < 0 && cur < 1) return;

  let next = cur + delta;
  if (next < 0) next = 0;
  if (delta > 0) {
    const total = sumChannel(map);
    if (req > 0 && total >= req) return;
    if (req > 0 && total + 1 > req) return;
  }
  map[size] = next;
  if (st.ui) st.ui.sizeOpen = true;
  markEstimateInputsChanged();
  renderProducts();
}

/* --------------------------------------------------------------- form reads */

function getFulfillment() {
  const v = document.querySelector('input[name="mo_fulfillment"]:checked')?.value;
  if (v === "local_delivery" || v === "pickup" || v === "carrier") return v;
  return "carrier";
}

function readAddress() {
  return {
    line1: String(getEl("mo-addr-line1")?.value || "").trim(),
    line2: String(getEl("mo-addr-line2")?.value || "").trim(),
    city: String(getEl("mo-addr-city")?.value || "").trim(),
    state: String(getEl("mo-addr-state")?.value || "").trim().toUpperCase(),
    postalCode: String(getEl("mo-addr-zip")?.value || "").trim(),
    country: "US",
  };
}

function readCustomer() {
  return {
    name: String(getEl("mo-cust-name")?.value || "").trim(),
    email: String(getEl("mo-cust-email")?.value || "").trim(),
    phone: String(getEl("mo-cust-phone")?.value || "").trim(),
  };
}

function readLocalDeliveryNote() {
  return String(getEl("mo-local-note")?.value || "").trim();
}

function readExpectedShipDate() {
  const s = String(getEl("mo-ship-date")?.value || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : "";
}

function renderDiscountPanel() {
  const host = getEl("mo-discount-panel");
  if (!host) return;
  const current = normalizeManualDiscountSelection(manualDiscountSelection);
  host.innerHTML = `
    <div class="mo-discount">
      <div class="mo-discount__summary">
        <p class="mo-discount__eyebrow">Current selection</p>
        <p class="mo-discount__current">${escapeHtml(manualDiscountSelectionSummary(current))}</p>
        <p class="sg-meta-note" style="margin:0">Manual Order discounts apply to merchandise before tax. ZIP code and delivery location do not affect eligibility.</p>
      </div>
      <div class="mo-discount__options" role="group" aria-label="Manual discount options">
        ${MANUAL_DISCOUNT_PRESETS.map((option) => {
          const isActive =
            option.type === current.type &&
            (option.type !== "amount"
              ? option.value === current.value
              : current.type === "amount" && current.value > 0);
          return `<button
            type="button"
            class="mo-discount-option${isActive ? " is-active" : ""}"
            data-mo-discount-option
            data-type="${escapeHtml(option.type)}"
            ${option.value != null ? `data-value="${escapeHtml(String(option.value))}"` : ""}
            aria-pressed="${isActive ? "true" : "false"}"
          >
            <span class="mo-discount-option__title">${escapeHtml(option.label)}</span>
            <span class="mo-discount-option__meta">${escapeHtml(manualDiscountButtonMeta(option, current))}</span>
          </button>`;
        }).join("")}
      </div>
    </div>`;
}

function applyManualDiscountSelection(nextSelection) {
  const normalized = normalizeManualDiscountSelection(nextSelection);
  const changed = !manualDiscountSelectionsEqual(manualDiscountSelection, normalized);
  manualDiscountSelection = normalized;
  renderDiscountPanel();
  closeDrawer();
  if (!changed) return;
  markEstimateInputsChanged();
  toast(`Manual discount set to ${manualDiscountSelectionSummary(normalized)}.`, "success");
}

function openManualDiscountDialog(rawType, rawValue) {
  const type = String(rawType || "")
    .trim()
    .toLowerCase();
  const baseSelection =
    type === "amount"
      ? normalizeManualDiscountSelection(
          manualDiscountSelection.type === "amount"
            ? manualDiscountSelection
            : { type: "amount", value: 2500 },
        )
      : normalizeManualDiscountSelection({ type, value: rawValue });
  const title =
    baseSelection.type === "none"
      ? "Clear manual discount?"
      : baseSelection.type === "percent"
        ? `Apply ${baseSelection.value}% discount?`
        : "Apply custom discount?";
  const customAmountValue =
    baseSelection.type === "amount" ? (baseSelection.value / 100).toFixed(2) : "";
  const bodyHtml = `
    <div class="sg-confirm">
      <p class="sg-confirm__copy">
        ${
          baseSelection.type === "none"
            ? "This removes any manual merchandise discount from the order."
            : `This applies <strong>${escapeHtml(manualDiscountSelectionSummary(baseSelection))}</strong> before tax.`
        }
      </p>
      ${
        baseSelection.type === "amount"
          ? `<label class="sg-field" style="margin-top:14px">
              <span class="sg-field__label">Custom amount off merchandise</span>
              <input type="number" class="sg-input" id="mo-discount-custom-input" min="0.01" step="0.01" inputmode="decimal" value="${escapeHtml(customAmountValue)}" />
            </label>
            <p class="sg-error sg-hide" id="mo-discount-custom-error" role="alert" hidden></p>`
          : ""
      }
      <p class="sg-meta-note" style="margin:10px 0 0">Shipping, carrier selection, and delivery location are unchanged. Recalculate totals after the selection is confirmed.</p>
      <div class="sg-drawer-actions">
        <button type="button" class="sg-btn sg-btn--ghost" id="mo-discount-cancel">Cancel</button>
        <button type="button" class="sg-btn sg-btn--primary" id="mo-discount-confirm">${
          baseSelection.type === "none" ? "Apply no discount" : "Apply discount"
        }</button>
      </div>
    </div>`;
  setDrawerCloseGuard(null);
  openDrawer({ title, bodyHtml });
  document.getElementById("sg-drawer")?.classList.remove("sg-drawer--wide");

  const customInput = getEl("mo-discount-custom-input");
  const customError = getEl("mo-discount-custom-error");
  const confirmBtn = getEl("mo-discount-confirm");
  const setCustomError = (message) => {
    if (!customError) return;
    if (message) {
      customError.textContent = message;
      customError.hidden = false;
      customError.classList.remove("sg-hide");
    } else {
      customError.textContent = "";
      customError.hidden = true;
      customError.classList.add("sg-hide");
    }
  };
  const syncCustomState = () => {
    if (baseSelection.type !== "amount" || !confirmBtn) return;
    const amountCents = parseCustomDiscountAmountInput(customInput?.value);
    confirmBtn.disabled = amountCents == null;
    if (customInput?.value && amountCents == null) {
      setCustomError("Enter a custom amount greater than $0.00.");
      return;
    }
    setCustomError("");
  };

  if (baseSelection.type === "amount") {
    customInput?.addEventListener("input", syncCustomState);
    customInput?.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || !confirmBtn || confirmBtn.disabled) return;
      event.preventDefault();
      confirmBtn.click();
    });
    syncCustomState();
    customInput?.focus();
  } else {
    confirmBtn?.focus();
  }

  getEl("mo-discount-cancel")?.addEventListener("click", () => {
    closeDrawer();
  });
  confirmBtn?.addEventListener("click", () => {
    if (baseSelection.type === "amount") {
      const amountCents = parseCustomDiscountAmountInput(customInput?.value);
      if (amountCents == null) {
        setCustomError("Enter a custom amount greater than $0.00.");
        return;
      }
      applyManualDiscountSelection({ type: "amount", value: amountCents });
      return;
    }
    applyManualDiscountSelection(baseSelection);
  });
}

function setPanelVisible(el, visible) {
  if (!el) return;
  el.classList.toggle("sg-hide", !visible);
  el.hidden = !visible;
}

function markEstimateStale() {
  if (!lastQuote) {
    syncEstimateButtonState();
    return;
  }
  estimateStale = true;
  renderQuotePreview(lastQuote);
  syncEstimateButtonState();
}

/** Record a quote-relevant form change and invalidate any in-flight estimate result. */
function markEstimateInputsChanged() {
  estimateInputRevision += 1;
  markEstimateStale();
}

function syncFulfillmentUi() {
  const fm = getFulfillment();
  const isCarrier = fm === "carrier";
  const isLocal = fm === "local_delivery";
  const isPickup = fm === "pickup";

  const pickupNote = getEl("mo-pickup-note");
  const localNote = getEl("mo-local-note-wrap");
  const addrBlock = getEl("mo-address-block");
  const shipDate = getEl("mo-ship-date-wrap");
  const rates = getEl("mo-rates-wrap");
  const requiredFields = [
    ["mo-addr-line1", isCarrier],
    ["mo-addr-city", isCarrier],
    ["mo-addr-state", isCarrier || isLocal],
    ["mo-addr-zip", isCarrier || isLocal],
  ];
  for (const [id, required] of requiredFields) {
    const field = getEl(id);
    if (!field) continue;
    field.required = required;
    if (required) field.setAttribute("aria-required", "true");
    else field.removeAttribute("aria-required");
  }

  syncLocalDeliveryAdvisory();

  // Pickup uses a dedicated info callout (not the meta helper).
  setPanelVisible(pickupNote, isPickup);
  // Old admin keeps address fields for local delivery (optional) and carrier (required).
  setPanelVisible(addrBlock, isCarrier || isLocal);
  setPanelVisible(localNote, isLocal);
  // Old admin shows expected ship date whenever the shipping block is visible (carrier + local).
  setPanelVisible(shipDate, isCarrier || isLocal);
  setPanelVisible(
    rates,
    isCarrier && Boolean(lastQuote) && !estimateStale && Array.isArray(lastQuote?.shippingRateOptions) && lastQuote.shippingRateOptions.length > 0,
  );

}

function syncLocalDeliveryAdvisory() {
  const el = getEl("mo-local-area-advisory");
  if (!el) return;
  const fm = getFulfillment();
  if (fm !== "local_delivery") {
    setPanelVisible(el, false);
    el.textContent = "";
    return;
  }
  const a = readAddress();
  const zip = String(a.postalCode || "").replace(/\D/g, "").slice(0, 5);
  const state = String(a.state || "").trim().toUpperCase();
  if (!state || zip.length !== 5) {
    setPanelVisible(el, false);
    el.textContent = "";
    return;
  }
  if (isLocalDeliveryServiceArea({ state, postalCode: zip })) {
    setPanelVisible(el, false);
    el.textContent = "";
    return;
  }
  el.innerHTML = `${icon("alert-triangle", 14)}<span>${escapeHtml(
    `${LOCAL_DELIVERY_AREA_ERROR} This browser ZIP check is advisory; the backend remains authoritative and will confirm eligibility.`,
  )}</span>`;
  setPanelVisible(el, true);
}

/* --------------------------------------------------------------- quote view */

function taxSourceLabel(source) {
  const s = String(source || "").trim();
  if (s === "tn" || s === "tn_zero") return "TN sales tax";
  if (s === "no_nexus") return "No nexus / not collected";
  if (!s) return "—";
  return s.replace(/_/g, " ");
}

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
      residentialSurchargeFormatted:
        data?.shipping?.residentialSurchargeFormatted || data?.residentialSurchargeFormatted || "—",
      taxFormatted: data?.tax?.amountFormatted || data?.taxFormatted || "—",
      taxSource: data?.tax?.source || data?.taxSource || "",
      destinationState: data?.destinationState || "",
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
    residentialSurchargeFormatted: data?.residentialSurchargeFormatted || "—",
    taxFormatted: data?.taxFormatted || "—",
    taxSource: data?.taxSource || "",
    destinationState: data?.destinationState || "",
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

function applyShippingRateStabilityFieldsToPayload(target, quote, providerQuoteId) {
  const rid = String(providerQuoteId || "").trim();
  if (!target || !rid || !quote || !Array.isArray(quote.shippingRateOptions)) return;
  const opt = quote.shippingRateOptions.find((o) => String(o?.id || "").trim() === rid);
  if (!opt) return;
  if (String(opt.serviceCode || "").trim()) target.selectedShippingServiceCode = String(opt.serviceCode).trim();
  if (String(opt.provider || "").trim()) target.selectedShippingProvider = String(opt.provider).trim();
  if (opt.amountCents != null && Number.isFinite(Number(opt.amountCents))) {
    target.selectedShippingAmountCents = Math.max(0, Math.round(Number(opt.amountCents)));
  }
  if (String(opt.serviceLabel || "").trim()) {
    target.selectedShippingServiceLabel = String(opt.serviceLabel).trim();
  }
  if (quote?.parcelSummary?.parcelCount != null && Number.isFinite(Number(quote.parcelSummary.parcelCount))) {
    target.selectedShippingParcelCount = Math.max(0, Math.floor(Number(quote.parcelSummary.parcelCount)));
  }
  if (
    quote?.shipping?.residentialSurchargeCents != null &&
    Number.isFinite(Number(quote.shipping.residentialSurchargeCents))
  ) {
    target.selectedShippingResidentialSurchargeCents = Math.max(
      0,
      Math.round(Number(quote.shipping.residentialSurchargeCents)),
    );
  }
}

function applySelectedShippingSnapshotToPayload(target) {
  if (!target || !selectedShippingRateSnapshot) return;
  const s = selectedShippingRateSnapshot;
  if (String(s.id || "").trim()) target.selectedShippingRateObjectId = String(s.id).trim();
  if (String(s.provider || "").trim()) target.selectedShippingProvider = String(s.provider).trim();
  if (String(s.serviceCode || "").trim()) target.selectedShippingServiceCode = String(s.serviceCode).trim();
  if (String(s.serviceLabel || "").trim()) target.selectedShippingServiceLabel = String(s.serviceLabel).trim();
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

function captureRateSnapshotFromQuote(quote, rateId) {
  const rid = String(rateId || "").trim();
  if (!rid || !quote) {
    selectedShippingRateSnapshot = null;
    return;
  }
  const opt = Array.isArray(quote.shippingRateOptions)
    ? quote.shippingRateOptions.find((o) => String(o?.id || "").trim() === rid)
    : null;
  selectedShippingRateSnapshot = {
    id: rid,
    provider: String(opt?.provider || quote?.shipping?.provider || "").trim(),
    serviceCode: String(opt?.serviceCode || "").trim(),
    serviceLabel: String(opt?.serviceLabel || quote?.shipping?.serviceLabel || "").trim(),
    amountCents:
      opt?.amountCents != null && Number.isFinite(Number(opt.amountCents))
        ? Math.round(Number(opt.amountCents))
        : null,
    parcelCount:
      quote?.parcelSummary?.parcelCount != null && Number.isFinite(Number(quote.parcelSummary.parcelCount))
        ? Math.floor(Number(quote.parcelSummary.parcelCount))
        : null,
    residentialSurchargeCents:
      quote?.shipping?.residentialSurchargeCents != null &&
      Number.isFinite(Number(quote.shipping.residentialSurchargeCents))
        ? Math.round(Number(quote.shipping.residentialSurchargeCents))
        : null,
  };
}

/* --------------------------------------------------------------- render */

function unitWord(kind, n) {
  const isBox = String(kind || "case").toLowerCase() === "box";
  if (Math.abs(n) === 1) return isBox ? "box" : "case";
  return isBox ? "boxes" : "cases";
}

function currentSelectionEntries() {
  const entries = [];
  for (const product of products) {
    const st = productState[product.slug];
    if (!st) continue;
    const bundleBits = bundleLinesPayload(st.bundleQty).map((line) => {
      const bundle = (product.bundles || []).find((item) => item.id === line.id);
      return `${bundle?.label || line.id} × ${line.qty}`;
    });
    const caseBits = Object.entries(compactQuantities(st.caseBySize, supportedSizesForProduct(product))).map(
      ([size, qty]) => `${size}: ${qty} ${unitWord("case", qty)}`,
    );
    const boxBits = Object.entries(compactQuantities(st.boxBySize, supportedSizesForProduct(product))).map(
      ([size, qty]) => `${size}: ${qty} ${unitWord("box", qty)}`,
    );
    if (!bundleBits.length && !caseBits.length && !boxBits.length) continue;

    const pendingBits = [];
    if (Array.isArray(product.bundles) && product.bundles.length) {
      const { reqBox, reqCase } = computeRequiredUnits(product, st.bundleQty);
      const remainingCase = reqCase - sumChannel(st.caseBySize);
      const remainingBox = reqBox - sumChannel(st.boxBySize);
      if (remainingCase > 0) pendingBits.push(`${remainingCase} ${unitWord("case", remainingCase)} awaiting size assignment`);
      if (remainingBox > 0) pendingBits.push(`${remainingBox} ${unitWord("box", remainingBox)} awaiting size assignment`);
    }

    entries.push({
      name: product.name || product.slug,
      bundleBits,
      caseBits,
      boxBits,
      pendingBits,
    });
  }
  return entries;
}

function currentSelectionSummaryHtml(opts = {}) {
  const entries = currentSelectionEntries();
  const emptyMessage = opts.emptyMessage || "No items selected yet.";
  const showPending = opts.showPending !== false;
  const compact = opts.compact === true;
  if (!entries.length) {
    return `<p class="sg-muted" style="margin:0">${escapeHtml(emptyMessage)}</p>`;
  }
  return `<div class="mo-item-summaries${compact ? " mo-item-summaries--compact" : ""}">
    ${entries
      .map((entry) => {
        const sizeBits = [];
        if (entry.caseBits.length) sizeBits.push(`Cases: ${entry.caseBits.join(", ")}`);
        if (entry.boxBits.length) sizeBits.push(`Boxes: ${entry.boxBits.join(", ")}`);
        const pendingHtml =
          showPending && entry.pendingBits.length
            ? `<div class="mo-item-summary__pending">${escapeHtml(entry.pendingBits.join(" · "))}</div>`
            : "";
        return `<div class="mo-item-summary">
          <strong>${escapeHtml(entry.name)}</strong>
          ${entry.bundleBits.length ? `<div class="sg-muted">${escapeHtml(entry.bundleBits.join(" · "))}</div>` : ""}
          ${sizeBits.length ? `<div class="sg-muted">${escapeHtml(sizeBits.join(" · "))}</div>` : ""}
          ${pendingHtml}
        </div>`;
      })
      .join("")}
  </div>`;
}

function renderProductsSummary() {
  const host = getEl("mo-products-summary");
  if (!host) return;
  const staleHtml =
    lastQuote && estimateStale
      ? `<p class="sg-inline-warn" style="margin:0 0 10px">${icon("alert-triangle", 14)}<span>Current selection changed after the last quote. Recalculate totals.</span></p>`
      : "";
  host.innerHTML = `
    <div class="mo-selection-summary">
      <p class="mo-selection-summary__title">Current selection</p>
      ${staleHtml}
      ${currentSelectionSummaryHtml({ showPending: true })}
    </div>
  `;
}

function renderStepPanel({ slug, stepKey, badge, title, help, bodyHtml, open, extraClass = "" }) {
  const safeSlug = escapeHtml(slug);
  const safeStepKey = escapeHtml(stepKey);
  const bodyId = `mo-step-${safeSlug}-${safeStepKey}`;
  return `<section class="mo-step${extraClass}${open ? " is-open" : " is-collapsed"}">
    <button type="button" class="mo-step__toggle" data-mo-step-toggle data-slug="${safeSlug}" data-step="${safeStepKey}" aria-expanded="${open ? "true" : "false"}" aria-controls="${bodyId}">
      <span class="mo-step__head">
        <span class="mo-step__badge">${escapeHtml(badge)}</span>
        <span class="mo-step__title">${escapeHtml(title)}</span>
      </span>
      <span class="mo-step__chevron" aria-hidden="true">${icon("chevron-down", 16)}</span>
    </button>
    <div class="mo-step__body" id="${bodyId}"${open ? "" : " hidden"}>
      ${open ? `${help ? `<p class="mo-step__help">${escapeHtml(help)}</p>` : ""}${bodyHtml}` : ""}
    </div>
  </section>`;
}

function sizeStockChip(product, size, channel) {
  if (isManualSizeOutOfStock(product, size, channel)) return statusChip("Out of stock", "danger");
  const lines = Array.isArray(product?.inventory?.lines) ? product.inventory.lines : [];
  const line = lines.find(
    (l) => l.productSlug === product.slug && l.size === size && l.channel === channel && l.track === true,
  );
  if (line) {
    const avail =
      line.available != null && Number.isFinite(Number(line.available))
        ? Math.max(0, Number(line.available))
        : Math.max(0, Math.floor(Number(line.onHand) || 0) - Math.floor(Number(line.reserved) || 0));
    const thr = Math.max(0, Math.floor(Number(line.lowStockThreshold) || 0));
    if (thr > 0 && avail > 0 && avail <= thr) return statusChip("Low stock", "warning");
  }
  return statusChip("In stock", "success");
}

function allocationProgressForChannel(product, st, channel) {
  const map = channel === "box" ? st.boxBySize : st.caseBySize;
  const { reqBox, reqCase } = computeRequiredUnits(product, st.bundleQty);
  const req = channel === "box" ? reqBox : reqCase;
  const assigned = sumChannel(map);
  const remaining = req - assigned;
  const kind = channel === "box" ? "box" : "case";
  const complete = req > 0 && assigned === req;
  const incomplete = req > 0 && assigned !== req;
  let statusHtml = "";
  if (req < 1) {
    statusHtml = "";
  } else if (complete) {
    statusHtml = "";
  } else if (remaining > 0) {
    statusHtml = `<p class="mo-alloc-status mo-alloc-status--warn">${icon("alert-triangle", 14)}<span>Assign ${remaining} more ${unitWord(kind, remaining)} to continue.</span></p>`;
  } else {
    statusHtml = `<p class="mo-alloc-status mo-alloc-status--warn">${icon("alert-triangle", 14)}<span>Remove ${Math.abs(remaining)} ${unitWord(kind, remaining)} to match the package total.</span></p>`;
  }
  const progressLabel =
    req < 1
      ? ""
      : remaining > 0
        ? `Assigned ${assigned} of ${req} ${unitWord(kind, req)} · ${remaining} ${unitWord(kind, remaining)} remaining`
        : complete
          ? `Assigned ${assigned} of ${req} ${unitWord(kind, req)}`
          : `Assigned ${assigned} of ${req} ${unitWord(kind, req)}`;

  return { req, assigned, remaining, complete, incomplete, kind, statusHtml, progressLabel };
}

function productAllocationIssues(product) {
  ensureProductState(product);
  const st = productState[product.slug];
  const name = product.name || product.slug;
  const hasCatalogBundles = Array.isArray(product.bundles) && product.bundles.length > 0;
  /** @type {{ message: string, focus: string }[]} */
  const issues = [];

  const quantities = compactQuantities(st.caseBySize, siteSizes);
  const boxQuantities = compactQuantities(st.boxBySize, siteSizes);
  const blocked = [...new Set([...Object.keys(quantities), ...Object.keys(boxQuantities)])].filter(
    (size) =>
      (Math.floor(Number(quantities[size]) || 0) > 0 && isManualSizeOutOfStock(product, size, "case")) ||
      (Math.floor(Number(boxQuantities[size]) || 0) > 0 && isManualSizeOutOfStock(product, size, "box")),
  );
  if (blocked.length) {
    issues.push({
      message: `Remove out-of-stock quantity for ${name} (${blocked.join(", ")}).`,
      focus: `product:${product.slug}`,
    });
  }

  if (!hasCatalogBundles) {
    return issues;
  }

  if (!hasAnyBundleSelection(st.bundleQty)) return issues;

  const bundleLines = bundleLinesPayload(st.bundleQty);
  const { reqBox, reqCase } = computeRequiredUnits(product, st.bundleQty);
  const sumBox = sumChannel(st.boxBySize);
  const sumCase = sumChannel(st.caseBySize);

  if (!safeIsBundleAllocationValid(product, bundleLines, st.caseBySize, st.boxBySize)) {
    if (showBoxColumn(product, st.bundleQty) && reqBox > 0 && sumBox !== reqBox) {
      const remaining = reqBox - sumBox;
      issues.push({
        message:
          remaining > 0
            ? `Assign sizes for ${name} (${remaining} more ${unitWord("box", remaining)})`
            : `Fix size allocation for ${name} (too many boxes assigned)`,
        focus: `product:${product.slug}`,
      });
    }
    if (showCaseColumn(product, st.bundleQty) && reqCase > 0 && sumCase !== reqCase) {
      const remaining = reqCase - sumCase;
      issues.push({
        message:
          remaining > 0
            ? `Assign sizes for ${name} (${remaining} more ${unitWord("case", remaining)})`
            : `Fix size allocation for ${name} (too many cases assigned)`,
        focus: `product:${product.slug}`,
      });
    }
    if (!issues.some((i) => i.message.startsWith("Assign sizes") || i.message.startsWith("Fix size"))) {
      issues.push({
        message: `Assign sizes for ${name}`,
        focus: `product:${product.slug}`,
      });
    }
  } else if (
    !blocked.length &&
    !inventoryAllowsAllocations(product, quantities, boxQuantities, supportedSizesForProduct(product))
  ) {
    issues.push({
      message: `Reduce quantities for ${name} — selected sizes exceed sellable stock`,
      focus: `product:${product.slug}`,
    });
  }

  return issues;
}

function productAllocationComplete(product) {
  return productAllocationIssues(product).length === 0;
}

function hasIncompleteProductAllocations() {
  for (const p of products) {
    const st = productState[p.slug];
    if (!st) continue;
    const hasCatalogBundles = Array.isArray(p.bundles) && p.bundles.length > 0;
    if (hasCatalogBundles && !hasAnyBundleSelection(st.bundleQty)) continue;
    if (!hasCatalogBundles && sumChannel(st.caseBySize) + sumChannel(st.boxBySize) === 0) continue;
    if (productAllocationIssues(p).length) return true;
  }
  return false;
}

/**
 * Estimate-only eligibility. Does not require payment intent, carrier rate, ship date, or create readiness.
 * @returns {{ ok: boolean, blockers: { id: string, message: string, focus: string }[], items: object[] }}
 */
function estimateEligibility() {
  /** @type {{ id: string, message: string, focus: string }[]} */
  const blockers = [];
  const cust = readCustomer();

  if (!cust.name) {
    blockers.push({ id: "cust-name", message: "Add customer full name", focus: "mo-cust-name" });
  }
  if (!cust.email || !cust.email.includes("@")) {
    blockers.push({ id: "cust-email", message: "Add customer email", focus: "mo-cust-email" });
  }
  if (cust.phone) {
    const digits = cust.phone.replace(/\D/g, "");
    if (digits.length < 10) {
      blockers.push({
        id: "cust-phone",
        message: "Enter a valid phone (at least 10 digits) or clear the field",
        focus: "mo-cust-phone",
      });
    }
  }

  const fm = getFulfillment();
  if (fm !== "carrier" && fm !== "local_delivery" && fm !== "pickup") {
    blockers.push({ id: "fulfillment", message: "Choose a fulfillment method", focus: "mo-fulfillment" });
  }
  if (fm === "carrier") {
    const a = readAddress();
    if (!a.line1) blockers.push({ id: "addr-line1", message: "Complete carrier address (street)", focus: "mo-addr-line1" });
    if (!a.city) blockers.push({ id: "addr-city", message: "Complete carrier address (city)", focus: "mo-addr-city" });
    if (!a.state) blockers.push({ id: "addr-state", message: "Complete carrier address (state)", focus: "mo-addr-state" });
    if (!a.postalCode) {
      blockers.push({ id: "addr-zip", message: "Complete carrier address (ZIP)", focus: "mo-addr-zip" });
    }
  }
  if (fm === "local_delivery") {
    const a = readAddress();
    if (!a.state) {
      blockers.push({
        id: "addr-state",
        message: "Local delivery requires a state",
        focus: "mo-addr-state",
      });
    }
    if (!a.postalCode || a.postalCode.replace(/\D/g, "").length < 5) {
      blockers.push({
        id: "addr-zip",
        message: "Local delivery requires a five-digit ZIP",
        focus: "mo-addr-zip",
      });
    }
    // Browser Hardin ZIP membership is advisory only — never a blocker.
  }

  for (const p of products) {
    for (const issue of productAllocationIssues(p)) {
      blockers.push({
        id: `product-${p.slug}-${issue.message}`,
        message: issue.message,
        focus: issue.focus,
      });
    }
  }

  const { items, errors: itemErrors } = buildItemsFromState();
  for (const err of itemErrors) {
    if (!blockers.some((b) => b.message === err || b.message.includes(String(err).split(":")[0] || ""))) {
      blockers.push({ id: `item-${err}`, message: err, focus: "mo-products" });
    }
  }
  if (!items.length && !blockers.some((b) => b.focus.startsWith("product:") || b.id.startsWith("product-"))) {
    blockers.push({
      id: "items",
      message: "Add at least one product package quantity",
      focus: "mo-products",
    });
  }

  return { ok: blockers.length === 0 && items.length > 0, blockers, items };
}

function renderEstimateChecklist(blockers) {
  const host = getEl("mo-estimate-checklist");
  if (!host) return;
  if (!blockers.length) {
    host.innerHTML = "";
    setPanelVisible(host, false);
    return;
  }
  setPanelVisible(host, true);
  host.innerHTML = `
    <p class="mo-estimate-checklist__title">Cannot calculate yet</p>
    <ul class="mo-estimate-checklist__list">
      ${blockers.map((b) => `<li>${escapeHtml(b.message)}</li>`).join("")}
    </ul>`;
}

function focusEstimateBlocker(blocker) {
  if (!blocker?.focus) return;
  const focus = blocker.focus;
  if (focus.startsWith("product:")) {
    const slug = focus.slice("product:".length);
    openProductSlugs.add(slug);
    renderProducts();
    const card = document.querySelector(`[data-product-slug="${CSS.escape(slug)}"]`);
    card?.classList.add("is-attention");
    card?.scrollIntoView({ behavior: "smooth", block: "center" });
    setTimeout(() => card?.classList.remove("is-attention"), 2400);
    return;
  }
  if (focus === "mo-products") {
    getEl("mo-products")?.scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }
  if (focus === "mo-fulfillment") {
    document.querySelector('input[name="mo_fulfillment"]:checked')?.closest(".mo-radio-row")?.scrollIntoView({
      behavior: "smooth",
      block: "center",
    });
    return;
  }
  const el = getEl(focus);
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.classList.add("mo-field-attention");
  try {
    el.focus({ preventScroll: true });
  } catch {
    el.focus?.();
  }
  setTimeout(() => el.classList.remove("mo-field-attention"), 2400);
}

function syncEstimateButtonState() {
  const btn = getEl("mo-estimate-btn");
  const wrap = getEl("mo-estimate-wrap");
  const hit = getEl("mo-estimate-hit");
  const elig = estimateEligibility();
  renderEstimateChecklist(elig.ok ? [] : elig.blockers);
  if (wrap) wrap.classList.toggle("is-blocked", !elig.ok);
  if (hit) setPanelVisible(hit, !elig.ok && !estimateInFlight);
  if (btn && !estimateInFlight) {
    btn.disabled = !elig.ok;
    btn.title = elig.ok ? "Calculate merchandise, tax, shipping, and discounts." : "Fix the items below, then calculate.";
  }

  syncSendLinkButtonState();
}

function fulfillmentLabel(fm) {
  if (fm === "local_delivery") return "Local delivery";
  if (fm === "pickup") return "Pickup";
  return "Ship with carrier";
}

function kvHtml(pairs) {
  const rows = pairs
    .filter((p) => p)
    .map(([k, v]) => `<div class="sg-kv__row"><dt>${escapeHtml(k)}</dt><dd>${v}</dd></div>`)
    .join("");
  return `<dl class="sg-kv">${rows}</dl>`;
}

function carrierRateReady() {
  if (getFulfillment() !== "carrier") return true;
  if (!lastQuote || estimateStale) return false;
  const status = String(lastQuote?.shipping?.quoteStatus || "").trim();
  // Old create/send flow required a fresh rated carrier quote before create.
  if (status !== "rated") return false;
  const options = Array.isArray(lastQuote.shippingRateOptions) ? lastQuote.shippingRateOptions : [];
  const rateId =
    selectedRateId ||
    String(lastQuote?.shipping?.providerQuoteId || "").trim() ||
    String(selectedShippingRateSnapshot?.id || "").trim();
  if (!rateId) return false;
  if (options.length) {
    return (
      options.some((o) => String(o?.id || "").trim() === rateId) ||
      rateId === String(lastQuote?.shipping?.providerQuoteId || "").trim()
    );
  }
  return true;
}

/**
 * Create + send payment link eligibility.
 * Square payment link for carrier (with rate), approved local delivery, or pickup.
 * @returns {{ ok: boolean, reason: string, items: object[] }}
 */
function createSendLinkEligibility() {
  const fm = getFulfillment();
  if (fm !== "carrier" && fm !== "local_delivery" && fm !== "pickup") {
    return { ok: false, reason: "Choose a fulfillment method.", items: [] };
  }

  const cust = readCustomer();
  if (!cust.name) return { ok: false, reason: "Customer full name is required.", items: [] };
  if (!cust.email || !cust.email.includes("@")) {
    return { ok: false, reason: "A valid customer email is required.", items: [] };
  }
  if (cust.phone) {
    const digits = cust.phone.replace(/\D/g, "");
    if (digits.length < 10) {
      return { ok: false, reason: "Phone must have at least 10 digits when provided.", items: [] };
    }
  }

  if (fm === "carrier") {
    const a = readAddress();
    if (!a.line1 || !a.city || !a.state || !a.postalCode) {
      return { ok: false, reason: "Complete the ship-to address for carrier shipping.", items: [] };
    }
  }
  if (fm === "local_delivery") {
    const a = readAddress();
    if (!a.state || !a.postalCode || a.postalCode.replace(/\D/g, "").length < 5) {
      return {
        ok: false,
        reason: "Local delivery requires state and a five-digit ZIP for the quote.",
        items: [],
      };
    }
    // Out-of-list Hardin ZIP is advisory only — still eligible to submit.
  }

  for (const p of products) {
    const issues = productAllocationIssues(p);
    if (issues.length) {
      return { ok: false, reason: issues[0].message, items: [] };
    }
  }

  const { items, errors: itemErrors } = buildItemsFromState();
  if (itemErrors.length) return { ok: false, reason: itemErrors[0], items: [] };
  if (!items.length) return { ok: false, reason: "Add at least one valid product line.", items: [] };

  if (!lastQuote) {
    return { ok: false, reason: "Calculate totals before sending a payment link.", items };
  }
  if (estimateStale) {
    return { ok: false, reason: "Quote is stale. Recalculate totals before sending a payment link.", items };
  }
  if (lastQuote.canCheckout === false) {
    return { ok: false, reason: "Quote is not ready for checkout. Resolve estimate issues and recalculate.", items };
  }

  if (fm === "carrier" && !carrierRateReady()) {
    return {
      ok: false,
      reason: "Select a shipping rate before creating the order and sending the payment link.",
      items,
    };
  }

  return { ok: true, reason: "", items };
}

function syncSendLinkButtonState() {
  const btn = getEl("mo-send-link-btn");
  const helper = getEl("mo-create-helper");
  const stageEl = getEl("mo-submit-stage");
  if (btn) {
    if (paymentLinkInFlight || estimateInFlight) {
      btn.disabled = true;
    } else {
      const elig = createSendLinkEligibility();
      btn.disabled = !elig.ok;
      btn.title = elig.ok
        ? "Create the order and email a Square payment link."
        : elig.reason || "Not ready to send a payment link.";
      btn.classList.toggle("sg-btn--primary", elig.ok);
      btn.classList.toggle("mo-btn-deferred", !elig.ok);
    }
  }
  if (stageEl) {
    if (paymentLinkInFlight && paymentLinkStage) {
      stageEl.textContent = paymentLinkStage;
      setPanelVisible(stageEl, true);
    } else {
      stageEl.textContent = "";
      setPanelVisible(stageEl, false);
    }
  }
  if (!helper) return;
  if (paymentLinkInFlight) {
    helper.textContent = paymentLinkStage || "Working…";
    return;
  }
  const sendElig = createSendLinkEligibility();
  if (sendElig.ok) {
    helper.textContent =
      "Ready: confirm to create a draft, create a Square payment link, and attempt to email the customer. Inventory is not reserved or decremented.";
  } else {
    helper.textContent = sendElig.reason || "Calculate a fresh estimate before sending a payment link.";
  }
}

function setFormLocked(locked) {
  const page = getEl("sg-page");
  if (!page) return;
  const nodes = page.querySelectorAll("input, select, textarea, button");
  for (const el of nodes) {
    if (!(el instanceof HTMLElement)) continue;
    if (el.id === "mo-send-confirm-cancel") continue;
    if (locked) {
      if (!el.dataset.moLockPrev) el.dataset.moLockPrev = el.disabled ? "1" : "0";
      el.disabled = true;
    } else if (el.dataset.moLockPrev != null) {
      el.disabled = el.dataset.moLockPrev === "1";
      delete el.dataset.moLockPrev;
    }
  }
  if (!locked) {
    syncEstimateButtonState();
    syncSendLinkButtonState();
  }
}

function selectedCarrierRateId() {
  return (
    selectedRateId ||
    String(lastQuote?.shipping?.providerQuoteId || "").trim() ||
    String(selectedShippingRateSnapshot?.id || "").trim() ||
    ""
  );
}

function applyCarrierRateFieldsToPayload(target) {
  if (!target || getFulfillment() !== "carrier" || !lastQuote || estimateStale) return;
  const rid = selectedCarrierRateId();
  if (rid) {
    target.selectedShippingRateObjectId = rid;
    applyShippingRateStabilityFieldsToPayload(target, lastQuote, rid);
  }
  applySelectedShippingSnapshotToPayload(target);
}

function formatAddressSummary(addr) {
  return formatManualOrderAddressSummary(addr);
}

function addressForCreate(fm) {
  if (fm === "pickup") {
    return {
      line1: "In-store / pickup (see staff notes)",
      line2: "",
      city: "Savannah",
      state: "TN",
      postalCode: "38372",
      country: "US",
    };
  }
  return readAddress();
}

function buildCreateSendLinkPayload(items) {
  const fm = getFulfillment();
  if (fm !== "carrier" && fm !== "local_delivery" && fm !== "pickup") {
    throw new Error("Choose a fulfillment method.");
  }
  if (fm === "local_delivery") {
    const a = readAddress();
    if (!a.state || !a.postalCode || a.postalCode.replace(/\D/g, "").length < 5) {
      throw new Error("Local delivery requires state and a five-digit ZIP for the quote.");
    }
    // Browser ZIP allowlist is advisory; backend remains authoritative.
  }
  if (fm === "carrier" && !carrierRateReady()) {
    throw new Error("Select a shipping rate before creating the order and sending the payment link.");
  }
  const cust = readCustomer();
  const body = {
    name: cust.name,
    email: cust.email,
    phone: cust.phone,
    address: addressForCreate(fm),
    items,
    fulfillmentMethod: fm,
    paymentFlow: "square_payment_link", // fixed — no user-selectable payment flow
    localDeliveryNote: fm === "local_delivery" ? readLocalDeliveryNote() : "",
    shipmentDate: readExpectedShipDate() || null,
    ...manualDiscountPayloadFields(),
  };
  applyCarrierRateFieldsToPayload(body);
  return body;
}

function buildSendLinkPayload(orderId) {
  const payload = {
    orderId: String(orderId || "").trim(),
    shipmentDate: readExpectedShipDate() || null,
  };
  applyCarrierRateFieldsToPayload(payload);
  return payload;
}

function itemsSummaryHtml(items) {
  if (!items?.length) return `<p class="sg-muted">No items</p>`;
  const rows = items
    .map((it) => {
      const product = products.find((p) => p.slug === it.slug);
      const name = product?.name || it.slug;
      const parts = [];
      if (Array.isArray(it.bundleLines) && it.bundleLines.length) {
        for (const bl of it.bundleLines) {
          const b = (product?.bundles || []).find((x) => x.id === bl.id);
          parts.push(`${b?.label || bl.id} × ${bl.qty}`);
        }
      }
      const caseBits = Object.entries(it.quantities || {})
        .filter(([, n]) => Math.floor(Number(n) || 0) > 0)
        .map(([s, n]) => `${s}: ${n} case`);
      const boxBits = Object.entries(it.boxQuantities || {})
        .filter(([, n]) => Math.floor(Number(n) || 0) > 0)
        .map(([s, n]) => `${s}: ${n} box`);
      const sizeLine = [...caseBits, ...boxBits].join(", ");
      return `<div class="mo-item-summary">
        <strong>${escapeHtml(name)}</strong>
        ${parts.length ? `<div class="sg-muted">${escapeHtml(parts.join(" · "))}</div>` : ""}
        ${sizeLine ? `<div class="sg-muted">${escapeHtml(sizeLine)}</div>` : ""}
      </div>`;
    })
    .join("");
  return `<div class="mo-item-summaries">${rows}</div>`;
}

function quoteSummaryBits() {
  const v = quoteView(lastQuote);
  const discount =
    v.discountFormatted
      ? (() => {
          const appliedManualDiscount = normalizeManualDiscountSelection(
            lastQuote?.merchandise?.manualDiscount || lastQuote?.manualDiscount,
          );
          if (appliedManualDiscount.type !== "none") {
            return `${manualDiscountLabel(appliedManualDiscount)} · −${v.discountFormatted}`;
          }
          return `−${v.discountFormatted}`;
        })()
      : "None";
  const rateLabel =
    getFulfillment() === "carrier"
      ? lastQuote?.shipping?.serviceLabel ||
        selectedShippingRateSnapshot?.serviceLabel ||
        shippingStatusLabel(v)
      : "—";
  return {
    merchandise: v.merchandiseFormatted,
    discount: discount || "None",
    tax: v.taxFormatted,
    shipping: v.shippingFormatted,
    shippingLabel: rateLabel,
    total: v.totalFormatted,
  };
}

function setSendLinkConfirmErr(msg) {
  const el = getEl("mo-send-confirm-err");
  if (!el) return;
  if (msg) {
    el.textContent = msg;
    el.hidden = false;
    el.classList.remove("sg-hide");
  } else {
    el.textContent = "";
    el.hidden = true;
    el.classList.add("sg-hide");
  }
}

function openSendLinkConfirm() {
  const elig = createSendLinkEligibility();
  if (!elig.ok) {
    toast(elig.reason || "Cannot send payment link yet.", "danger");
    syncSendLinkButtonState();
    return;
  }

  const cust = readCustomer();
  const fm = getFulfillment();
  const q = quoteSummaryBits();
  const localNote = fm === "local_delivery" ? readLocalDeliveryNote() : "";
  const addr = addressForCreate(fm);
  const PHRASE = SEND_PAYMENT_LINK_PHRASE;

  const bodyHtml = `
    <div class="sg-confirm">
      <div class="sg-warn-banner sg-warn-banner--danger" role="alert">
        ${icon("alert-triangle", 16)}
        <span>This creates a Manual Order draft, creates a Square payment link, and attempts to email the customer. It does not reserve or decrement inventory. Payment is not collected here. If email fails, a valid order and payment link may still exist — do not automatically retry.</span>
      </div>
      <h3 class="sg-confirm__title">Create and send payment link?</h3>
      <div class="sg-confirm__summary">
        ${kvHtml([
          ["Customer", escapeHtml(cust.name)],
          ["Email", escapeHtml(cust.email)],
          ["Phone", escapeHtml(cust.phone || "—")],
          ["Fulfillment", escapeHtml(fulfillmentLabel(fm))],
          fm === "local_delivery" && localNote
            ? ["Local delivery note", escapeHtml(localNote)]
            : fm === "local_delivery"
              ? ["Local delivery note", '<span class="sg-muted">None</span>']
              : null,
          fm === "pickup"
            ? ["Ship-to / pickup", escapeHtml("Stored Savannah pickup address")]
            : ["Ship-to address", formatAddressSummary(addr)],
          fm === "carrier"
            ? ["Selected shipping rate", escapeHtml(String(q.shippingLabel || "—"))]
            : null,
          ["Merchandise", escapeHtml(q.merchandise)],
          ["Discount", escapeHtml(String(q.discount))],
          ["Tax", escapeHtml(q.tax)],
          ["Shipping", escapeHtml(q.shipping)],
          ["Total", `<strong>${escapeHtml(q.total)}</strong>`],
          ["Payment flow", "Square payment link"],
        ])}
        <h4 class="sg-drawer-section__title" style="font-size:13px;margin:14px 0 6px">Items / quantities</h4>
        ${itemsSummaryHtml(elig.items)}
      </div>
      <p class="sg-meta-note">Backend will re-quote shipping, tax, and the selected manual discount before it creates the draft and payment link. Browser totals are preview only.</p>
      <label class="sg-field" style="margin-top:14px">
        <span class="sg-field__label">Type <span class="sg-mono">${escapeHtml(PHRASE)}</span> to enable</span>
        <input type="text" class="sg-input" id="mo-send-type-confirm" autocomplete="off" spellcheck="false" placeholder="${escapeHtml(PHRASE)}" />
      </label>
      <p class="sg-error sg-hide" id="mo-send-confirm-err" role="alert" hidden></p>
      <div class="sg-drawer-actions">
        <button type="button" class="sg-btn sg-btn--ghost" id="mo-send-confirm-cancel">Cancel</button>
        <button type="button" class="sg-btn sg-btn--primary" id="mo-send-confirm-btn" disabled>Create and send payment link</button>
      </div>
    </div>`;

  setDrawerCloseGuard(() => !paymentLinkInFlight);
  openDrawer({ title: "Create and send payment link?", bodyHtml });
  document.getElementById("sg-drawer")?.classList.remove("sg-drawer--wide");

  const typeInput = getEl("mo-send-type-confirm");
  const confirmBtn = getEl("mo-send-confirm-btn");
  const syncConfirmEnabled = () => {
    if (!confirmBtn || paymentLinkInFlight) return;
    confirmBtn.disabled = String(typeInput?.value || "") !== PHRASE;
  };
  typeInput?.addEventListener("input", () => {
    setSendLinkConfirmErr("");
    syncConfirmEnabled();
  });
  typeInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (confirmBtn && !confirmBtn.disabled) confirmBtn.click();
    }
  });
  syncConfirmEnabled();
  typeInput?.focus();

  getEl("mo-send-confirm-cancel")?.addEventListener("click", () => {
    if (paymentLinkInFlight) return;
    closeDrawer();
  });
  confirmBtn?.addEventListener("click", () => {
    if (String(typeInput?.value || "") !== PHRASE) {
      setSendLinkConfirmErr(`Type ${PHRASE} exactly to continue.`);
      syncConfirmEnabled();
      return;
    }
    void submitCreateAndSendLink();
  });
}

async function submitCreateAndSendLink() {
  if (paymentLinkInFlight) return;
  const PHRASE = SEND_PAYMENT_LINK_PHRASE;
  const elig = createSendLinkEligibility();
  if (!elig.ok) {
    setSendLinkConfirmErr(elig.reason || "Cannot send payment link.");
    return;
  }
  if (String(getEl("mo-send-type-confirm")?.value || "") !== PHRASE) {
    setSendLinkConfirmErr(`Type ${PHRASE} exactly to continue.`);
    return;
  }

  paymentLinkInFlight = true;
  paymentLinkStage = "Creating order draft";
  const confirmBtn = getEl("mo-send-confirm-btn");
  const cancelBtn = getEl("mo-send-confirm-cancel");
  const drawerCloseBtn = document.getElementById("sg-drawer-close");
  if (drawerCloseBtn) drawerCloseBtn.disabled = true;
  setSendLinkConfirmErr("");
  if (confirmBtn) {
    confirmBtn.disabled = true;
    confirmBtn.textContent = "Creating order draft…";
  }
  if (cancelBtn) cancelBtn.disabled = true;
  setFormLocked(true);
  syncSendLinkButtonState();

  /** @type {null | { orderId: string, orderRef: string, totalFormatted: string }} */
  let created = null;

  try {
    const token = await getToken();
    if (!token) throw new ManualOrderLocalAuthError("Sign in again to create the order.");

    const createPayload = buildCreateSendLinkPayload(elig.items);
    if (createPayload.paymentFlow !== "square_payment_link") {
      throw new Error("This page only supports Square payment links.");
    }

    const createData = await fetchManualOrderPost("/api/admin-manual-order-create", token, createPayload);
    const createdOrderId = String(createData?.orderId || "").trim();
    if (!createdOrderId) {
      // 2xx without orderId is create_uncertain — do not retry from this page.
      closeDrawer({ force: true });
      showSendLinkResult({
        orderId: "",
        orderRef: "",
        totalFormatted: String(createData?.totalFormatted || quoteSummaryBits().total || "—"),
        checkoutUrl: "",
        emailed: false,
        warning:
          "The order may have been created. Do not submit the form again. Check Orders v2 and Legacy admin.",
        outcome: "create_uncertain",
      });
      return;
    }
    created = {
      orderId: createdOrderId,
      orderRef: String(createData.orderRef || createData.orderId || ""),
      totalFormatted: String(createData.totalFormatted || quoteSummaryBits().total || "—"),
    };
    lastCreatedOrder = created;

    paymentLinkStage = "Creating Square payment link";
    if (confirmBtn) confirmBtn.textContent = "Creating Square payment link…";
    syncSendLinkButtonState();

    const sendPayload = buildSendLinkPayload(created.orderId);
    let sendData;
    try {
      // send-link persists the Square URL then attempts email server-side.
      paymentLinkStage = "Sending customer email";
      if (confirmBtn) confirmBtn.textContent = "Creating link and sending email…";
      syncSendLinkButtonState();
      sendData = await fetchManualOrderPost("/api/admin-manual-order-send-link", token, sendPayload);
    } catch (sendErr) {
      const classified =
        sendErr instanceof ReportPostError
          ? classifyManualOrderSendLinkFailure(
              sendErr.body || {},
              sendErr.message || "",
            )
          : classifyManualOrderSendLinkFailure({}, "", { transportUncertain: true });
      closeDrawer({ force: true });
      showSendLinkResult({
        ...created,
        checkoutUrl: classified.checkoutUrl,
        emailed: classified.emailed,
        warning: classified.warning,
        outcome: classified.outcome,
        squareOutcomeUncertain: classified.squareOutcomeUncertain === true,
      });
      return;
    }

    closeDrawer({ force: true });
    const classified = classifyManualOrderSendLinkSuccess(sendData);
    if (classified.outcome === "success") {
      toast(`Payment link emailed for ${created.orderRef}.`, "success");
    } else if (classified.outcome === "email_failed") {
      toast(
        classified.warning || `Order ${created.orderRef} created; payment link email was not sent.`,
        "danger",
      );
    } else {
      toast("Payment link confirmation is incomplete. Do not resubmit.", "danger");
    }
    showSendLinkResult({
      ...created,
      checkoutUrl: classified.checkoutUrl,
      emailed: classified.emailed,
      warning: classified.warning,
      outcome: classified.outcome,
    });
  } catch (error) {
    const msg =
      error instanceof ReportPostError
        ? error.message
        : error?.message || "Could not create order or send payment link.";

    if (created?.orderId) {
      closeDrawer({ force: true });
      toast("The order was created, but the payment link was not confirmed.", "danger");
      showSendLinkResult({
        ...created,
        checkoutUrl: "",
        emailed: false,
        warning: msg,
        outcome: "draft_only",
      });
    } else if (isManualOrderLocalAuthError(error)) {
      // Missing token — definite local auth; no create request was made.
      setSendLinkConfirmErr(msg);
      const restored = preCreateRejectionControlState({
        phraseInputValue: getEl("mo-send-type-confirm")?.value,
        phrase: PHRASE,
      });
      setFormLocked(restored.formLocked);
      if (cancelBtn) cancelBtn.disabled = restored.cancelDisabled;
      if (confirmBtn) {
        confirmBtn.textContent = restored.confirmText;
        confirmBtn.disabled = restored.confirmDisabled;
      }
      const drawerCloseBtnRestored = document.getElementById("sg-drawer-close");
      if (drawerCloseBtnRestored) drawerCloseBtnRestored.disabled = false;
    } else {
      const createKind = classifyManualOrderCreateFailure(error);
      if (createKind === "create_uncertain") {
        closeDrawer({ force: true });
        toast("Create result is uncertain. Do not submit again.", "danger");
        showSendLinkResult({
          orderId: "",
          orderRef: "",
          totalFormatted: quoteSummaryBits().total || "—",
          checkoutUrl: "",
          emailed: false,
          warning:
            "The order may have been created. Do not submit the form again. Check Orders v2 and Legacy admin.",
          outcome: "create_uncertain",
        });
      } else {
        // Definite pre-insert rejection (verified create-handler 400/401/403/405).
        setSendLinkConfirmErr(msg);
        const restored = preCreateRejectionControlState({
          phraseInputValue: getEl("mo-send-type-confirm")?.value,
          phrase: PHRASE,
        });
        setFormLocked(restored.formLocked);
        if (cancelBtn) cancelBtn.disabled = restored.cancelDisabled;
        if (confirmBtn) {
          confirmBtn.textContent = restored.confirmText;
          confirmBtn.disabled = restored.confirmDisabled;
        }
        const drawerCloseBtnRestored = document.getElementById("sg-drawer-close");
        if (drawerCloseBtnRestored) drawerCloseBtnRestored.disabled = false;
      }
    }
  } finally {
    paymentLinkInFlight = false;
    paymentLinkStage = "";
    setDrawerCloseGuard(null);
    const drawerCloseBtn = document.getElementById("sg-drawer-close");
    if (drawerCloseBtn) drawerCloseBtn.disabled = false;
    syncSendLinkButtonState();
  }
}

/**
 * Result panel outcomes:
 * - success — Square link persisted + email sent
 * - email_failed — link persisted; email false/throw; claim kept; Create another allowed
 * - draft_only — draft exists; link not confirmed; Orders/Legacy only
 * - link_uncertain — Square may exist / squareOutcomeUncertain; Orders/Legacy only
 * - create_uncertain — create may have inserted; no same-page retry; Orders/Legacy only
 *
 * @param {{
 *   orderId: string,
 *   orderRef: string,
 *   totalFormatted: string,
 *   checkoutUrl?: string,
 *   emailed?: boolean,
 *   warning?: string,
 *   squareOutcomeUncertain?: boolean,
 *   outcome: "success" | "email_failed" | "draft_only" | "link_uncertain" | "create_uncertain",
 * }} result
 */
function showSendLinkResult(result) {
  const actions = getEl("mo-actions");
  const panel = getEl("mo-create-result");
  if (actions) setPanelVisible(actions, false);
  if (!panel) return;
  setPanelVisible(panel, true);

  const checkoutUrl = String(result.checkoutUrl || "").trim();
  const warning = String(result.warning || "").trim();
  const emailed = result.emailed === true;
  const squareOutcomeUncertain = result.squareOutcomeUncertain === true;
  const outcome = result.outcome || (emailed ? "success" : checkoutUrl ? "email_failed" : "draft_only");

  let statusTitle = "Payment link sent";
  let statusNote = "Square payment link was created and emailed to the customer.";
  let bannerClass = "";
  if (outcome === "create_uncertain") {
    statusTitle = "Create result uncertain — do not retry";
    statusNote =
      "The order may have been created. Do not submit the form again. Check Orders v2 and Legacy admin.";
    bannerClass = "sg-warn-banner--danger";
  } else if (outcome === "draft_only") {
    statusTitle = "Draft created — payment link not confirmed";
    statusNote =
      "Draft order was created. Payment link was not confirmed. Do not submit this form again from this page. Check the order in Legacy admin before taking further action.";
    bannerClass = "sg-warn-banner--danger";
  } else if (outcome === "link_uncertain") {
    statusTitle = squareOutcomeUncertain
      ? "Payment link outcome uncertain"
      : "Payment link may exist — do not retry";
    statusNote = squareOutcomeUncertain
      ? "Payment link outcome is uncertain. Do not resubmit. Check Orders v2, Square, and Legacy admin before taking further action."
      : warning ||
        "Square may have created a payment link, but confirmation failed. Do not retry from this page. Check Legacy admin.";
    bannerClass = "sg-warn-banner--danger";
  } else if (outcome === "email_failed") {
    statusTitle = "Payment link created — email not sent";
    statusNote =
      "Order was created. Square payment link was created. Customer email was not sent. Do not create another order or payment link. Copy and send the existing link manually.";
    bannerClass = "sg-warn-banner--danger";
  }

  const warnBanner =
    outcome !== "success"
      ? `<div class="sg-warn-banner ${bannerClass}" role="alert" style="margin-bottom:12px">
          ${icon("alert-triangle", 16)}
          <span>${escapeHtml(warning || statusNote)}</span>
        </div>`
      : "";

  const copyBtn = checkoutUrl
    ? `<button type="button" class="sg-btn sg-btn--ghost" id="mo-copy-link-btn">Copy payment link</button>`
    : "";
  const openLinkBtn = checkoutUrl
    ? `<a class="sg-btn sg-btn--ghost" href="${escapeHtml(checkoutUrl)}" target="_blank" rel="noopener noreferrer">Open payment link</a>`
    : "";
  const createAnotherBtn = allowCreateAnotherManualOrder(outcome)
    ? `<button type="button" class="sg-btn sg-btn--ghost" id="mo-create-another-btn">Create another order</button>`
    : "";

  const refRows = [
    result.orderRef
      ? ["Reference", `<span class="sg-mono">${escapeHtml(result.orderRef)}</span>`]
      : null,
    result.orderId
      ? ["Order ID", `<span class="sg-mono">${escapeHtml(result.orderId)}</span>`]
      : null,
    ["Total", escapeHtml(result.totalFormatted || "—")],
    [
      "Payment-link status",
      outcome === "success" || outcome === "email_failed"
        ? "Created"
        : outcome === "link_uncertain" || outcome === "create_uncertain"
          ? "Uncertain"
          : "Not confirmed",
    ],
    ["Email status", emailed ? "Sent" : "Not sent"],
    checkoutUrl
      ? [
          "Payment link",
          `<a href="${escapeHtml(checkoutUrl)}" target="_blank" rel="noopener noreferrer" class="sg-mono">${escapeHtml(checkoutUrl)}</a>`,
        ]
      : null,
  ];

  panel.innerHTML = `
    <div class="mo-success-card">
      <h3 class="mo-success-card__title">${icon(outcome === "success" ? "check" : "alert-triangle", 16)}<span>${escapeHtml(statusTitle)}</span></h3>
      ${warnBanner}
      ${outcome === "success" ? `<p class="sg-meta-note" style="margin:0 0 12px">${escapeHtml(statusNote)}</p>` : ""}
      ${outcome === "create_uncertain" || (outcome === "link_uncertain" && squareOutcomeUncertain) ? `<p class="sg-meta-note" style="margin:0 0 12px">${escapeHtml(statusNote)}</p>` : ""}
      ${kvHtml(refRows)}
      <p class="sg-meta-note" style="margin:12px 0 0">Creating a draft does not reserve inventory. Creating or emailing a payment link does not decrement inventory. Payment does not itself decrement stock for Manual Order payment links. Fulfillment remains in the existing admin workflow — this page does not mark shipped or purchase labels.</p>
      <div class="sg-ship-to-actions" style="margin-top:14px">
        <a class="sg-btn sg-btn--primary" href="${ORDERS_V2_HREF}">Open in Orders</a>
        <a class="sg-btn sg-btn--ghost" href="${LEGACY_MANUAL_ORDER_HREF}">Open Legacy admin</a>
        ${openLinkBtn}
        ${copyBtn}
        ${createAnotherBtn}
      </div>
    </div>`;
  getEl("mo-create-another-btn")?.addEventListener("click", () => resetForAnotherOrder());
  getEl("mo-copy-link-btn")?.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(checkoutUrl);
      toast("Payment link copied.", "success");
    } catch {
      toast("Could not copy link. Select it manually.", "danger");
    }
  });
}

function resetForAnotherOrder() {
  lastCreatedOrder = null;
  lastQuote = null;
  estimateStale = false;
  // Invalidate any prior in-flight estimate so a late response cannot become usable.
  estimateInputRevision += 1;
  manualDiscountSelection = defaultManualDiscountSelection();
  selectedRateId = null;
  selectedShippingRateSnapshot = null;
  allocationSubmitAttempted = false;
  productState = {};
  openProductSlugs.clear();
  for (const p of products) ensureProductState(p);

  const name = getEl("mo-cust-name");
  const email = getEl("mo-cust-email");
  const phone = getEl("mo-cust-phone");
  if (name) name.value = "";
  if (email) email.value = "";
  if (phone) phone.value = "";

  for (const id of [
    "mo-addr-line1",
    "mo-addr-line2",
    "mo-addr-city",
    "mo-addr-zip",
    "mo-local-note",
    "mo-ship-date",
  ]) {
    const el = getEl(id);
    if (el) el.value = "";
  }
  const state = getEl("mo-addr-state");
  if (state) state.value = "";
  const country = getEl("mo-addr-country");
  if (country) country.value = "US";

  const carrier = document.querySelector('input[name="mo_fulfillment"][value="carrier"]');
  if (carrier instanceof HTMLInputElement) carrier.checked = true;

  const errEl = getEl("mo-page-error");
  if (errEl) {
    errEl.hidden = true;
    errEl.textContent = "";
  }

  setPanelVisible(getEl("mo-create-result"), false);
  setPanelVisible(getEl("mo-actions"), true);
  setFormLocked(false);
  renderDiscountPanel();
  renderProducts();
  renderQuotePreview(null);
  syncFulfillmentUi();

  syncEstimateButtonState();
  syncSendLinkButtonState();
  toast("Form cleared. Ready for another order.", "success");
  getEl("mo-cust-name")?.focus();
}

function renderSizeColumn(product, st, channel) {
  const map = channel === "box" ? st.boxBySize : st.caseBySize;
  const progress = allocationProgressForChannel(product, st, channel);
  const { req, assigned, incomplete, kind } = progress;
  const title = kind === "box" ? "Boxes by size" : "Cases by size";

  return `<div class="mo-size-col${incomplete ? " is-incomplete" : progress.complete ? " is-complete" : ""}">
    <div class="mo-size-col__head">
      <span class="mo-size-col__title">${escapeHtml(title)}</span>
    </div>
    <div class="mo-size-rows">
      ${supportedSizesForProduct(product)
        .map((size) => {
          const qty = Math.floor(Number(map[size]) || 0);
          const oos = isManualSizeOutOfStock(product, size, channel);
          const plusDisabled = req < 1 || assigned >= req || oos;
          // Minus stays enabled for OOS rows that still have quantity so staff can clear them.
          const minusDisabled = qty < 1;
          return `<div class="mo-size-row${oos ? " is-oos" : ""}${oos && qty > 0 ? " has-invalid-qty" : ""}">
            <div class="mo-size-row__meta">
              <span class="mo-size-row__label">${escapeHtml(size)}</span>
              ${sizeStockChip(product, size, channel)}
            </div>
            <div class="mo-qty">
              <button type="button" class="sg-btn sg-btn--ghost sg-btn--sm mo-qty__btn" data-mo-size-step data-slug="${escapeHtml(product.slug)}" data-channel="${escapeHtml(channel)}" data-size="${escapeHtml(size)}" data-delta="-1" ${minusDisabled ? "disabled" : ""} aria-label="Decrease ${escapeHtml(size)}">−</button>
              <strong class="mo-qty__value">${qty}</strong>
              <button type="button" class="sg-btn sg-btn--ghost sg-btn--sm mo-qty__btn" data-mo-size-step data-slug="${escapeHtml(product.slug)}" data-channel="${escapeHtml(channel)}" data-size="${escapeHtml(size)}" data-delta="1" ${plusDisabled ? "disabled" : ""} aria-label="Increase ${escapeHtml(size)}">+</button>
            </div>
          </div>`;
        })
        .join("")}
    </div>
  </div>`;
}

function renderBundleStep(product, st, oos) {
  const isOpen = st.ui?.bundleOpen !== false;
  const bundlesHtml = (product.bundles || [])
    .map((b) => {
      const qty = Math.floor(st.bundleQty[b.id] || 0);
      const label = b.label || b.id;
      const price = b.priceFormatted || formatCurrency(b.priceCents || 0);
      const kind = String(b.kind || "case").toLowerCase() === "box" ? "box" : "case";
      const units = Math.max(0, Math.floor(Number(b.units) || 0));
      const selectedTotal =
        qty > 0 && units > 0 ? `${qty * units} ${unitWord(kind, qty * units)} selected` : "";
      return `<div class="mo-bundle-row${qty > 0 ? " is-selected" : ""}">
        <div class="mo-bundle-row__info">
          <div class="mo-bundle-row__name">${escapeHtml(label)}</div>
          <div class="mo-bundle-row__meta">
            <span class="mo-bundle-row__price">${escapeHtml(price)}</span>
            ${selectedTotal ? `<span class="mo-bundle-row__selected-total">${escapeHtml(selectedTotal)}</span>` : ""}
          </div>
        </div>
        <div class="mo-qty">
          <button type="button" class="sg-btn sg-btn--ghost sg-btn--sm mo-qty__btn" data-mo-bundle-step data-slug="${escapeHtml(product.slug)}" data-bundle="${escapeHtml(b.id)}" data-delta="-1" ${oos || qty < 1 ? "disabled" : ""} aria-label="Decrease ${escapeHtml(label)}">−</button>
          <strong class="mo-qty__value">${qty}</strong>
          <button type="button" class="sg-btn sg-btn--ghost sg-btn--sm mo-qty__btn" data-mo-bundle-step data-slug="${escapeHtml(product.slug)}" data-bundle="${escapeHtml(b.id)}" data-delta="1" ${oos ? "disabled" : ""} aria-label="Increase ${escapeHtml(label)}">+</button>
        </div>
      </div>`;
    })
    .join("");

  return renderStepPanel({
    slug: product.slug,
    stepKey: "bundle",
    badge: "Step 1",
    title: "Choose package quantity",
    help: "Select the bundle first, then select size in Step 2.",
    bodyHtml: `<div class="mo-bundle-list">${bundlesHtml}</div>`,
    open: isOpen,
  });
}

function renderAssignSizesStep(product, st) {
  const hasSelection = hasAnyBundleSelection(st.bundleQty);
  const isOpen = hasSelection ? st.ui?.sizeOpen !== false : st.ui?.sizeOpen === true;
  if (!hasSelection) {
    return renderStepPanel({
      slug: product.slug,
      stepKey: "size",
      badge: "Step 2",
      title: "Assign sizes",
      help: "Match every selected box or case with a size before moving on.",
      bodyHtml: "",
      open: isOpen,
      extraClass: " mo-step--sizes mo-step--waiting",
    });
  }

  const sizeCols = [];
  const progressWarnings = [];
  const progressChannels = [];
  if (showCaseColumn(product, st.bundleQty)) sizeCols.push(renderSizeColumn(product, st, "case"));
  if (showBoxColumn(product, st.bundleQty)) sizeCols.push(renderSizeColumn(product, st, "box"));
  if (showCaseColumn(product, st.bundleQty)) progressChannels.push("case");
  if (showBoxColumn(product, st.bundleQty)) progressChannels.push("box");

  const warnParts = [];
  for (const channel of progressChannels) {
    const progress = allocationProgressForChannel(product, st, channel);
    if (progress.req < 1 || progress.complete) continue;
    const prefix = progressChannels.length > 1 ? `${channel === "box" ? "Boxes" : "Cases"} by size: ` : "";
    if (progress.remaining > 0) {
      progressWarnings.push(`${prefix}assign ${progress.remaining} more ${unitWord(channel, progress.remaining)}.`);
      continue;
    }
    progressWarnings.push(`${prefix}remove ${Math.abs(progress.remaining)} ${unitWord(channel, progress.remaining)} to match the selected bundle.`);
  }

  const stockIssues = productAllocationIssues(product).filter((i) =>
    /out-of-stock|exceed sellable/i.test(i.message),
  );
  const hasOosQty = stockIssues.some((i) => /out-of-stock/i.test(i.message));
  for (const issue of stockIssues) warnParts.push(issue.message);
  warnParts.push(...progressWarnings);

  const allComplete = warnParts.length === 0 && safeIsBundleAllocationValid(
    product,
    bundleLinesPayload(st.bundleQty),
    st.caseBySize,
    st.boxBySize,
  );

  const stepHelp = hasOosQty
    ? "Remove out-of-stock quantities before calculating totals."
    : "Match every selected box or case with a size before moving to the rest of the order.";

  const warnHtml = warnParts.length
    ? warnParts
        .map(
          (w) =>
            `<p class="mo-alloc-status mo-alloc-status--warn">${icon("alert-triangle", 14)}<span>${escapeHtml(w)}</span></p>`,
        )
        .join("")
    : "";
  const okHtml = allComplete
    ? `<p class="mo-alloc-status mo-alloc-status--ok">${icon("check", 14)}<span>Size allocation complete.</span></p>`
    : "";

  return renderStepPanel({
    slug: product.slug,
    stepKey: "size",
    badge: "Step 2",
    title: "Assign sizes",
    help: stepHelp,
    bodyHtml: `${okHtml}${warnHtml}<div class="mo-size-grid${sizeCols.length === 1 ? " mo-size-grid--single" : ""}">${sizeCols.join("")}</div>`,
    open: isOpen,
    extraClass: ` mo-step--sizes${allComplete ? "" : " is-incomplete"}`,
  });
}

function renderProductCard(product) {
  ensureProductState(product);
  const st = productState[product.slug];
  const open = openProductSlugs.has(product.slug);
  const hasBundles = Array.isArray(product.bundles) && product.bundles.length > 0;
  const oos = isManualProductOutOfStock(product);

  let body = "";
  if (open) {
    if (hasBundles) {
      body = `<div class="mo-product__body">
        ${renderBundleStep(product, st, oos)}
        ${renderAssignSizesStep(product, st)}
      </div>`;
    } else {
      body = `<div class="mo-product__body">
        <div class="mo-step">
          <div class="mo-step__head">
            <span class="mo-step__badge">Sizes</span>
            <h3 class="mo-step__title">Assign case quantities by size</h3>
          </div>
          <p class="mo-step__help">Legacy catalog product — enter case quantities directly.</p>
          <div class="mo-size-grid">${renderSizeColumn(product, st, "case")}</div>
        </div>
      </div>`;
    }
  }

  return `<div class="mo-product${open ? " is-open" : ""}${oos ? " is-oos" : ""}" data-product-slug="${escapeHtml(product.slug)}">
    <button type="button" class="mo-product__toggle" data-mo-toggle-product="${escapeHtml(product.slug)}">
      <span class="mo-product__title">${escapeHtml(product.name || product.slug)}</span>
      ${productStockChip(product)}
      <span class="sg-muted">${open ? "Hide" : "Add"}</span>
    </button>
    ${body}
  </div>`;
}

function renderProducts() {
  const host = getEl("mo-products");
  if (!host) return;
  if (!products.length) {
    host.innerHTML = `<p class="sg-muted">No products loaded.</p>`;
    renderProductsSummary();
    syncEstimateButtonState();
    return;
  }
  host.innerHTML = products.map((p) => renderProductCard(p)).join("");
  renderProductsSummary();
  syncEstimateButtonState();
}

function renderRates(data) {
  const host = getEl("mo-rates");
  const wrap = getEl("mo-rates-wrap");
  if (!host || !wrap) return;
  const fm = getFulfillment();
  const options = Array.isArray(data?.shippingRateOptions) ? data.shippingRateOptions : [];
  if (fm !== "carrier" || !options.length) {
    setPanelVisible(wrap, false);
    host.innerHTML = "";
    return;
  }
  setPanelVisible(wrap, true);
  const selected = selectedRateId || String(data?.shipping?.providerQuoteId || "").trim();
  host.innerHTML = options
    .map((o) => {
      const id = String(o?.id || "").trim();
      const label = String(o?.serviceLabel || o?.serviceCode || "Service").trim();
      const provider = String(o?.provider || "").trim();
      const amount = o?.amountFormatted || (o?.amountCents != null ? formatCurrency(o.amountCents) : "—");
      const days = o?.estimatedDays != null ? `${o.estimatedDays} day(s)` : "";
      const checked = id && id === selected ? " checked" : "";
      return `<label class="mo-rate-option">
        <input type="radio" name="mo_ship_rate" value="${escapeHtml(id)}"${checked} />
        <span class="mo-rate-option__body">
          <strong>${escapeHtml(label)}</strong>
          <span class="sg-muted">${escapeHtml([provider, amount, days].filter(Boolean).join(" · "))}</span>
        </span>
      </label>`;
    })
    .join("");
}

function renderQuotePreview(data) {
  const host = getEl("mo-quote-body");
  const stale = getEl("mo-quote-stale");
  if (!host) return;
  if (!data) {
    host.innerHTML = `<p class="sg-muted" style="margin:0">Run Calculate totals to preview merchandise, tax, shipping, and discounts.</p>`;
    setPanelVisible(stale, false);
    renderProductsSummary();
    return;
  }
  const v = quoteView(data);
  const discountLine = v.discountFormatted
    ? `<div class="mo-quote-row"><span>Discount</span><strong>−${escapeHtml(v.discountFormatted)}</strong></div>`
    : "";
  const shipLine =
    v.shippingStatus === "rated"
      ? `<div class="mo-quote-row"><span>Shipping</span><strong>${escapeHtml(v.shippingFormatted)}${v.shippingServiceLabel ? ` · ${escapeHtml(v.shippingServiceLabel)}` : ""}</strong></div>
         <div class="mo-quote-row"><span>Residential surcharge</span><span>${escapeHtml(v.residentialSurchargeFormatted || "—")}</span></div>`
      : `<div class="mo-quote-row"><span>Shipping</span><span>${escapeHtml(shippingStatusLabel(v))}</span></div>`;

  const quoteChips = [];
  const appliedManualDiscount = normalizeManualDiscountSelection(
    data?.merchandise?.manualDiscount || data?.manualDiscount || manualDiscountSelection,
  );
  if (appliedManualDiscount.type !== "none" && v.discountFormatted) {
    quoteChips.push(statusChip(manualDiscountLabel(appliedManualDiscount), "success"));
  }

  const warnings = (v.warnings || [])
    .map((w) => `<div class="sg-inline-warn" style="margin-top:8px">${icon("alert-triangle", 14)}<span>${escapeHtml(String(w))}</span></div>`)
    .join("");
  const err = v.userFacingError
    ? `<div class="sg-inline-warn" style="margin-top:8px">${icon("alert-triangle", 14)}<span>${escapeHtml(v.userFacingError)}</span></div>`
    : "";
  const checkoutNote = v.canCheckout
    ? ""
    : `<p class="sg-meta-note" style="margin:10px 0 0">Quote is not ready for checkout. Resolve issues above and recalculate.</p>`;
  const itemsHtml = currentSelectionSummaryHtml({
    emptyMessage: "No items selected yet.",
    showPending: false,
    compact: true,
  });
  const itemNames = currentSelectionEntries()
    .map((entry) => entry.name)
    .join(" · ");

  host.innerHTML = `
    <div class="mo-quote-rows">
      <div class="mo-quote-row">
        <span class="mo-quote-row__stack">
          <span>Merchandise</span>
          ${itemNames ? `<span class="mo-quote-row__detail">${escapeHtml(itemNames)}</span>` : ""}
        </span>
        <strong>${escapeHtml(v.merchandiseFormatted)}</strong>
      </div>
      ${discountLine}
      ${shipLine}
      <div class="mo-quote-row"><span>Tax</span><strong>${escapeHtml(v.taxFormatted)}</strong></div>
      <div class="mo-quote-row mo-quote-row--meta"><span></span><span class="sg-muted">Destination: ${escapeHtml(v.destinationState || "—")} · Source: ${escapeHtml(taxSourceLabel(v.taxSource))}</span></div>
      <div class="mo-quote-row mo-quote-row--total"><span>Total</span><strong>${escapeHtml(v.totalFormatted)}</strong></div>
    </div>
    <div class="mo-quote-items">
      <p class="mo-quote-items__label">Items in this order</p>
      ${itemsHtml}
    </div>
    ${quoteChips.length ? `<div class="mo-quote-chips" style="margin-top:10px">${quoteChips.join(" ")}</div>` : ""}
    ${err}${warnings}${checkoutNote}
  `;
  setPanelVisible(stale, Boolean(lastQuote) && estimateStale);
  renderRates(data);
  renderProductsSummary();
}

function validateBeforeEstimate() {
  allocationSubmitAttempted = true;
  renderProducts();
  const elig = estimateEligibility();
  return {
    ok: elig.ok,
    errors: elig.blockers.map((b) => b.message),
    items: elig.items,
    blockers: elig.blockers,
  };
}

function buildEstimatePayload(items) {
  const fm = getFulfillment();
  const address =
    fm === "pickup"
      ? {
          line1: "In-store / pickup (see staff notes)",
          line2: "",
          city: "Savannah",
          state: "TN",
          postalCode: "38372",
          country: "US",
        }
      : readAddress();

  const body = {
    items,
    address,
    fulfillmentMethod: fm,
    localDeliveryNote: fm === "local_delivery" ? readLocalDeliveryNote() : "",
    ...manualDiscountPayloadFields(),
  };

  if (fm === "carrier") {
    const rateId = selectedRateId || String(lastQuote?.shipping?.providerQuoteId || "").trim();
    if (rateId) {
      body.selectedShippingRateObjectId = rateId;
      applyShippingRateStabilityFieldsToPayload(body, lastQuote, rateId);
    }
    applySelectedShippingSnapshotToPayload(body);
  }

  return body;
}

async function runEstimate() {
  const errEl = getEl("mo-page-error");
  if (errEl) {
    errEl.hidden = true;
    errEl.textContent = "";
  }
  if (paymentLinkInFlight) return;

  const { ok, errors, items, blockers } = validateBeforeEstimate();
  renderEstimateChecklist(ok ? [] : blockers);
  if (!ok) {
    if (errEl) {
      errEl.textContent = errors.join("\n");
      errEl.hidden = false;
    }
    toast(errors[0] || "Fix validation errors before estimating.", "danger");
    focusEstimateBlocker(blockers[0]);
    syncEstimateButtonState();
    return;
  }

  // Capture revision + immutable payload before any await (token or network).
  const capturedRevision = estimateInputRevision;
  const capturedPayload = buildEstimatePayload(items);

  const btn = getEl("mo-estimate-btn");
  // Production helper sets in-flight before the first await (token).
  const result = await runGuardedManualOrderEstimate({
    get inFlight() {
      return estimateInFlight;
    },
    setInFlight(v) {
      estimateInFlight = v;
      if (v) {
        if (btn) {
          btn.disabled = true;
          btn.textContent = "Calculating…";
        }
        syncEstimateButtonState();
      } else if (btn) {
        btn.textContent = "Calculate totals";
      }
    },
    capturedRevision,
    getCurrentRevision: () => estimateInputRevision,
    validate: () => ({ ok: true, payload: capturedPayload }),
    getToken,
    post: async (token, payload) =>
      fetchManualOrderPost("/api/admin-manual-order-estimate", token, payload),
  });

  try {
    if (!result.started) return;
    if (result.reason === "auth") {
      toast("Sign in again to calculate totals.", "danger");
      return;
    }
    if (result.reason === "inputs_changed") {
      // Discard stale response — keep any prior quote only as stale; never enable submit.
      if (lastQuote) {
        estimateStale = true;
        setPanelVisible(getEl("mo-quote-stale"), true);
      }
      const msg =
        "Order details changed while totals were calculating. Recalculate before creating the order.";
      if (errEl) {
        errEl.textContent = msg;
        errEl.hidden = false;
      }
      toast(msg, "danger");
      return;
    }
    if (!result.ok) {
      const error = result.error;
      const msg =
        error instanceof ReportPostError
          ? error.message
          : error?.message || "Estimate failed.";
      if (errEl) {
        errEl.textContent = msg;
        errEl.hidden = false;
      }
      toast(msg, "danger");
      return;
    }

    const data = result.data;
    lastQuote = data;
    estimateStale = false;

    const providerRateId = String(data?.shipping?.providerQuoteId || "").trim();
    if (getFulfillment() === "carrier") {
      selectedRateId = selectedRateId && Array.isArray(data.shippingRateOptions)
        ? data.shippingRateOptions.some((o) => String(o?.id || "") === selectedRateId)
          ? selectedRateId
          : providerRateId || null
        : providerRateId || null;
      captureRateSnapshotFromQuote(data, selectedRateId);
    } else {
      selectedRateId = null;
      selectedShippingRateSnapshot = null;
    }

    renderQuotePreview(data);
    syncFulfillmentUi();
    toast("Quote updated.", "success");
  } finally {
    syncEstimateButtonState();
  }
}

async function onRateSelected(rateId) {
  selectedRateId = String(rateId || "").trim() || null;
  captureRateSnapshotFromQuote(lastQuote, selectedRateId);
  markEstimateInputsChanged();
  // Re-estimate with selected rate so totals match selection.
  await runEstimate();
}

function sectionTitleHtml(iconName, label) {
  return `${icon(iconName, 16)}<span>${escapeHtml(label)}</span>`;
}

function pageHtml() {
  const stateOpts =
    `<option value="">Select state</option>` + US_STATES.map((s) => `<option value="${s}">${s}</option>`).join("");

  const customer = card({
    titleHtml: sectionTitleHtml("user", "Customer"),
    bodyHtml: `<div class="mo-grid mo-grid--compact-y">
      <label class="sg-field"><span class="sg-field__label">Full name</span><input class="sg-input" id="mo-cust-name" type="text" autocomplete="name" required /></label>
      <label class="sg-field"><span class="sg-field__label">Email</span><input class="sg-input" id="mo-cust-email" type="email" autocomplete="email" required /></label>
      <label class="sg-field"><span class="sg-field__label">Phone <span class="sg-field__optional">(optional)</span></span><input class="sg-input" id="mo-cust-phone" type="tel" autocomplete="tel" /></label>
    </div>`,
  });

  const productsCard = card({
    titleHtml: sectionTitleHtml("package", "Products / line items"),
    bodyHtml: `<div id="mo-products" class="mo-products"><p class="sg-muted">Loading products…</p></div>
      <div id="mo-products-summary" style="margin-top:12px"></div>`,
  });

  const fulfillment = card({
    titleHtml: sectionTitleHtml("truck", "Fulfillment"),
    bodyHtml: `
      <div class="mo-radio-row" role="radiogroup" aria-label="Fulfillment method">
        <label class="mo-radio"><input type="radio" name="mo_fulfillment" value="carrier" checked /><span class="mo-radio__label">${icon("truck", 16)}<span>Ship with carrier</span></span></label>
        <label class="mo-radio"><input type="radio" name="mo_fulfillment" value="local_delivery" /><span class="mo-radio__label">${icon("map-pin", 16)}<span>Local delivery</span></span></label>
        <label class="mo-radio"><input type="radio" name="mo_fulfillment" value="pickup" /><span class="mo-radio__label">${icon("store", 16)}<span>Pickup</span></span></label>
      </div>
      <div id="mo-local-area-advisory" class="sg-warn-banner sg-hide" hidden role="status" style="margin:10px 0 0"></div>
      <div id="mo-pickup-note" class="sg-inline-warn mo-fulfillment-callout sg-hide" hidden>${icon("info", 14)}<span>${escapeHtml(PICKUP_NOTE)}</span></div>
      <div id="mo-local-note-wrap" class="mo-fulfillment-panel sg-hide" hidden>
        <label class="sg-field mo-field-full" style="margin-bottom:0">
          <span class="sg-field__label">Local delivery note <span class="sg-field__optional">(optional)</span></span>
          <textarea class="sg-input sg-textarea" id="mo-local-note" rows="3" placeholder="Gate code, time window, delivery instructions, etc."></textarea>
        </label>
      </div>
      <div id="mo-address-block" class="mo-address mo-fulfillment-panel">
        <div class="mo-grid mo-grid--compact-y">
          <label class="sg-field mo-grid__full"><span class="sg-field__label">Street address</span><input class="sg-input" id="mo-addr-line1" type="text" autocomplete="address-line1" /></label>
          <label class="sg-field mo-grid__full"><span class="sg-field__label">Apt, suite <span class="sg-field__optional">(optional)</span></span><input class="sg-input" id="mo-addr-line2" type="text" autocomplete="address-line2" /></label>
          <label class="sg-field"><span class="sg-field__label">City</span><input class="sg-input" id="mo-addr-city" type="text" autocomplete="address-level2" /></label>
          <label class="sg-field"><span class="sg-field__label">State</span><select class="sg-input" id="mo-addr-state">${stateOpts}</select></label>
          <label class="sg-field"><span class="sg-field__label">ZIP</span><input class="sg-input" id="mo-addr-zip" type="text" inputmode="numeric" autocomplete="postal-code" /></label>
          <label class="sg-field"><span class="sg-field__label">Country</span><input class="sg-input" id="mo-addr-country" type="text" value="US" readonly /></label>
        </div>
      </div>
      <div id="mo-ship-date-wrap" class="mo-fulfillment-panel">
        <label class="sg-field mo-field-full" style="margin-bottom:0">
          <span class="sg-field__label">Expected ship date <span class="sg-field__optional">(optional)</span></span>
          <input class="sg-input" id="mo-ship-date" type="date" />
        </label>
      </div>
      <div id="mo-rates-wrap" class="mo-fulfillment-panel sg-hide" hidden>
        <p class="sg-drawer-section__title" style="margin-bottom:8px">Carrier service</p>
        <div id="mo-rates" class="mo-rates"></div>
        <p class="sg-meta-note" style="margin:8px 0 0">Selecting a rate recalculates the quote. Totals are not saved until you create and send a payment link.</p>
      </div>`,
  });

  const discount = card({
    titleHtml: sectionTitleHtml("tag", "Discount"),
    bodyHtml: `<div id="mo-discount-panel"></div>`,
  });

  const quote = card({
    titleHtml: sectionTitleHtml("receipt", "Estimate / quote preview"),
    bodyHtml: `
      <div class="mo-estimate-actions" id="mo-estimate-wrap">
        <div class="mo-estimate-actions__btnrow">
          <button type="button" class="sg-btn sg-btn--primary" id="mo-estimate-btn">${icon("receipt", 14)}<span>Calculate totals</span></button>
          <button type="button" class="mo-estimate-hit sg-hide" id="mo-estimate-hit" hidden aria-label="Show why Calculate totals is unavailable"></button>
        </div>
        <div id="mo-estimate-checklist" class="mo-estimate-checklist sg-hide" hidden></div>
      </div>
      <p class="sg-inline-warn mo-quote-stale sg-hide" id="mo-quote-stale" hidden>${icon("alert-triangle", 14)}<span>Inputs changed since the last quote. Recalculate before relying on these totals.</span></p>
      <div id="mo-quote-body"><p class="sg-muted" style="margin:0">Run Calculate totals to preview merchandise, tax, shipping, and discounts.</p></div>`,
  });

  const actions = `<div class="mo-future-actions" id="mo-actions">
    <p class="sg-meta-note" id="mo-create-helper" style="margin:0 0 10px">Calculate totals, then create and send a Square payment link.</p>
    <p class="sg-meta-note sg-hide" id="mo-submit-stage" hidden style="margin:0 0 10px"></p>
    <div class="mo-future-actions__btns">
      <button type="button" class="sg-btn mo-btn-deferred" id="mo-send-link-btn" disabled title="Complete a fresh estimate first.">Create and send payment link</button>
    </div>
  </div>
  <div id="mo-create-result" class="sg-hide" hidden></div>`;

  return `${pageHeader({
    title: "Manual Order",
    subtitle:
      "Create a Manual Order draft and email a Square payment link for carrier shipping, local delivery, or pickup. Payment collection and fulfillment stay outside this page.",
  })}
  <p id="mo-page-error" class="sg-error" role="alert" hidden style="white-space:pre-wrap"></p>
  <div class="mo-stack">
    ${customer}
    ${productsCard}
    ${fulfillment}
    ${discount}
    ${quote}
    ${actions}
  </div>`;
}

function wirePage() {
  const page = getEl("sg-page");
  if (!page) return;

  page.addEventListener("click", (e) => {
    const discountOption = e.target.closest("[data-mo-discount-option]");
    if (discountOption) {
      openManualDiscountDialog(
        discountOption.getAttribute("data-type"),
        discountOption.getAttribute("data-value"),
      );
      return;
    }
    const stepToggle = e.target.closest("[data-mo-step-toggle]");
    if (stepToggle) {
      const slug = stepToggle.getAttribute("data-slug");
      const step = stepToggle.getAttribute("data-step");
      const product = products.find((item) => item.slug === slug);
      if (!product) return;
      ensureProductState(product);
      if (step === "bundle") {
        const next = !productState[slug].ui.bundleOpen;
        productState[slug].ui.bundleOpen = next;
        if (next) productState[slug].ui.sizeOpen = false;
      }
      if (step === "size") {
        const next = !productState[slug].ui.sizeOpen;
        productState[slug].ui.sizeOpen = next;
        if (next) productState[slug].ui.bundleOpen = false;
      }
      renderProducts();
      return;
    }
    const toggle = e.target.closest("[data-mo-toggle-product]");
    if (toggle) {
      const slug = toggle.getAttribute("data-mo-toggle-product");
      if (openProductSlugs.has(slug)) openProductSlugs.delete(slug);
      else openProductSlugs.add(slug);
      renderProducts();
      return;
    }
    const bundleBtn = e.target.closest("[data-mo-bundle-step]");
    if (bundleBtn && !bundleBtn.disabled) {
      applyBundleDelta(
        bundleBtn.getAttribute("data-slug"),
        bundleBtn.getAttribute("data-bundle"),
        Number(bundleBtn.getAttribute("data-delta")) || 0,
      );
      return;
    }
    const sizeBtn = e.target.closest("[data-mo-size-step]");
    if (sizeBtn && !sizeBtn.disabled) {
      handleSizeStep(
        sizeBtn.getAttribute("data-slug"),
        sizeBtn.getAttribute("data-channel"),
        sizeBtn.getAttribute("data-size"),
        Number(sizeBtn.getAttribute("data-delta")) || 0,
      );
    }
  });

  page.addEventListener("change", (e) => {
    const t = e.target;
    if (!(t instanceof HTMLElement)) return;
    if (t.getAttribute("name") === "mo_fulfillment") {
      markEstimateInputsChanged();
      syncFulfillmentUi();
      syncEstimateButtonState();
      return;
    }
    if (t.getAttribute("name") === "mo_ship_rate" && t instanceof HTMLInputElement) {
      void onRateSelected(t.value);
      return;
    }
    if (
      t.id?.startsWith("mo-addr-") ||
      t.id === "mo-local-note" ||
      t.id === "mo-ship-date" ||
      t.id === "mo-cust-name" ||
      t.id === "mo-cust-email" ||
      t.id === "mo-cust-phone"
    ) {
      markEstimateInputsChanged();
      if (t.id?.startsWith("mo-addr-")) syncLocalDeliveryAdvisory();
      return;
    }
  });

  page.addEventListener("input", (e) => {
    const t = e.target;
    if (!(t instanceof HTMLElement)) return;
    if (
      t.id === "mo-cust-name" ||
      t.id === "mo-cust-email" ||
      t.id === "mo-cust-phone" ||
      t.id?.startsWith("mo-addr-") ||
      t.id === "mo-local-note" ||
      t.id === "mo-ship-date"
    ) {
      // Typing while an estimate is pending must invalidate the revision immediately.
      markEstimateInputsChanged();
      if (t.id?.startsWith("mo-addr-")) syncLocalDeliveryAdvisory();
    }
  });

  getEl("mo-estimate-btn")?.addEventListener("click", () => void runEstimate());
  getEl("mo-estimate-hit")?.addEventListener("click", () => {
    const elig = estimateEligibility();
    renderEstimateChecklist(elig.blockers);
    allocationSubmitAttempted = true;
    renderProducts();
    focusEstimateBlocker(elig.blockers[0]);
    toast(elig.blockers[0]?.message || "Fix the checklist items before calculating.", "danger");
  });
  getEl("mo-send-link-btn")?.addEventListener("click", () => {
    if (paymentLinkInFlight) return;
    openSendLinkConfirm();
  });

  syncFulfillmentUi();
  syncEstimateButtonState();
}

async function loadProducts() {
  const res = await fetch("/api/products");
  if (!res.ok) throw new Error("Could not load products.");
  const data = await res.json();
  if (Array.isArray(data?.site?.sizes)) siteSizes = data.site.sizes;
  products = Array.isArray(data?.products) ? data.products : [];
  productState = {};
  for (const p of products) ensureProductState(p);
  renderProducts();
}

function renderPage() {
  const page = getEl("sg-page");
  if (!page) return;
  page.innerHTML = pageHtml();
  renderDiscountPanel();
  wirePage();
}

/** Browser-only boot. Skipped under Node harness imports. */
if (typeof document !== "undefined") {
  bootAdminV2Page({
    activeNav: "order-builder",
    topbarLeftHtml: orderBuilderModeSwitch("manual", { location: "topbar" }),
    onEnter: async (_session, ctx) => {
      getToken = ctx.getAccessToken;
      renderPage();
      try {
        await loadProducts();
      } catch (error) {
        toast(error?.message || "Could not load products.", "danger");
        const host = getEl("mo-products");
        if (host) host.innerHTML = `<p class="sg-error">${escapeHtml(error?.message || "Could not load products.")}</p>`;
      }
    },
    onRefresh: async () => {
      try {
        await loadProducts();
        toast("Catalog refreshed.", "success");
      } catch (error) {
        toast(error?.message || "Could not refresh products.", "danger");
      }
    },
  });
}
