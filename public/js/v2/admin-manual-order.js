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
import { card, closeDrawer, escapeHtml, icon, openDrawer, pageHeader, setDrawerCloseGuard, statusChip, toast } from "./ui.js";
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

/** @type {object[]} */
let products = [];
/** @type {string[]} */
let siteSizes = ["S", "M", "L", "XL"];
/** @type {Record<string, { bundleQty: Record<string, number>, caseBySize: Record<string, number>, boxBySize: Record<string, number> }>} */
let productState = {};
/** Slugs with expanded product detail. */
const openProductSlugs = new Set();
let allocationSubmitAttempted = false;
/** @type {object|null} */
let lastQuote = null;
let estimateStale = false;
let discountOverrideConfirmed = false;
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
  if (productState[slug]) return;
  const bundles = product.bundles || [];
  productState[slug] = {
    bundleQty: Object.fromEntries(bundles.map((b) => [b.id, 0])),
    caseBySize: Object.fromEntries(siteSizes.map((s) => [s, 0])),
    boxBySize: Object.fromEntries(siteSizes.map((s) => [s, 0])),
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
  const prevReq = computeRequiredUnits(product, st.bundleQty);
  const next = Math.max(0, Math.floor(Number(st.bundleQty[bundleId]) || 0) + delta);
  st.bundleQty[bundleId] = next;
  const nextReq = computeRequiredUnits(product, st.bundleQty);
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

function readApplyLocalDiscount() {
  return getEl("mo-apply-discount")?.checked === true;
}

function readLocalDeliveryNote() {
  return String(getEl("mo-local-note")?.value || "").trim();
}

function readExpectedShipDate() {
  const s = String(getEl("mo-ship-date")?.value || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : "";
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
  setPanelVisible(getEl("mo-quote-stale"), true);
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

  const helper = getEl("mo-fulfillment-helper");
  const pickupNote = getEl("mo-pickup-note");
  const localNote = getEl("mo-local-note-wrap");
  const addrBlock = getEl("mo-address-block");
  const shipDate = getEl("mo-ship-date-wrap");
  const rates = getEl("mo-rates-wrap");

  if (helper) {
    if (isCarrier) {
      helper.textContent = "Full shipping address is required for carrier quotes.";
    } else if (isLocal) {
      helper.textContent =
        "Local delivery requires state and a five-digit ZIP for quoting. The browser ZIP check is advisory; the server remains authoritative.";
    } else {
      helper.textContent = "";
    }
    setPanelVisible(helper, isCarrier || isLocal);
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
  const applyEligibleLocalDiscount = readApplyLocalDiscount();
  const body = {
    name: cust.name,
    email: cust.email,
    phone: cust.phone,
    address: addressForCreate(fm),
    items,
    applyEligibleLocalDiscount,
    adminLocalDiscountOverride: applyEligibleLocalDiscount && discountOverrideConfirmed,
    fulfillmentMethod: fm,
    paymentFlow: "square_payment_link", // fixed — no user-selectable payment flow
    localDeliveryNote: fm === "local_delivery" ? readLocalDeliveryNote() : "",
    shipmentDate: readExpectedShipDate() || null,
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
    v.discountFormatted ||
    (Number(lastQuote?.merchandise?.discountCents || lastQuote?.merchandiseDiscountCents || 0) > 0
      ? lastQuote?.merchandise?.discountFormatted || lastQuote?.merchandiseDiscountFormatted
      : "None");
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
      <p class="sg-meta-note">Backend will re-quote before create and send-link. Browser totals are preview only.</p>
      <p class="sg-meta-note">Local-delivery ZIP checks in this browser are advisory; the server remains authoritative.</p>
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
  discountOverrideConfirmed = false;
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

  const applyDisc = getEl("mo-apply-discount");
  if (applyDisc) applyDisc.checked = false;

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
  const { req, assigned, incomplete, progressLabel, statusHtml, kind } = progress;
  const title = kind === "box" ? "Boxes by size" : "Cases by size";

  return `<div class="mo-size-col${incomplete ? " is-incomplete" : progress.complete ? " is-complete" : ""}">
    <div class="mo-size-col__head">
      <span class="mo-size-col__title">${escapeHtml(title)}</span>
      ${progressLabel ? `<span class="mo-size-col__progress">${escapeHtml(progressLabel)}</span>` : ""}
    </div>
    ${statusHtml}
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
  const bundlesHtml = (product.bundles || [])
    .map((b) => {
      const qty = Math.floor(st.bundleQty[b.id] || 0);
      const label = b.label || b.id;
      const price = b.priceFormatted || formatCurrency(b.priceCents || 0);
      const kind = String(b.kind || "case").toLowerCase() === "box" ? "box" : "case";
      const units = Math.max(0, Math.floor(Number(b.units) || 0));
      const perPack = units > 0 ? `Adds ${units} ${unitWord(kind, units)}` : "";
      const selectedTotal =
        qty > 0 && units > 0 ? `${qty * units} ${unitWord(kind, qty * units)} selected` : "";
      return `<div class="mo-bundle-row${qty > 0 ? " is-selected" : ""}">
        <div class="mo-bundle-row__info">
          <div class="mo-bundle-row__name">${escapeHtml(label)}</div>
          <div class="mo-bundle-row__meta">
            <span class="mo-bundle-row__price">${escapeHtml(price)}</span>
            ${perPack ? `<span class="mo-bundle-row__adds">${escapeHtml(perPack)}</span>` : ""}
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

  return `<div class="mo-step">
    <div class="mo-step__head">
      <span class="mo-step__badge">Step 1</span>
      <h3 class="mo-step__title">Choose package quantity</h3>
    </div>
    <p class="mo-step__help">Select how many boxes or cases the customer wants.</p>
    <div class="mo-bundle-list">${bundlesHtml}</div>
  </div>`;
}

function renderAssignSizesStep(product, st) {
  const hasSelection = hasAnyBundleSelection(st.bundleQty);
  if (!hasSelection) {
    return `<div class="mo-step mo-step--sizes mo-step--waiting">
      <div class="mo-step__head">
        <span class="mo-step__badge">Step 2</span>
        <h3 class="mo-step__title">Assign sizes</h3>
      </div>
      <p class="mo-step__help">Assign sizes to match the total selected above.</p>
      <p class="mo-step__empty">Choose a package quantity above to assign sizes.</p>
    </div>`;
  }

  const sizeCols = [];
  if (showCaseColumn(product, st.bundleQty)) sizeCols.push(renderSizeColumn(product, st, "case"));
  if (showBoxColumn(product, st.bundleQty)) sizeCols.push(renderSizeColumn(product, st, "box"));

  const { reqBox, reqCase } = computeRequiredUnits(product, st.bundleQty);
  const sumBox = sumChannel(st.boxBySize);
  const sumCase = sumChannel(st.caseBySize);
  const name = product.name || product.slug;
  const summaryParts = [];
  const warnParts = [];

  if (showBoxColumn(product, st.bundleQty) && reqBox > 0) {
    const remaining = reqBox - sumBox;
    summaryParts.push(
      `Selected: ${reqBox} ${unitWord("box", reqBox)} · Assigned: ${sumBox} ${unitWord("box", sumBox)} · Remaining: ${Math.max(0, remaining)} ${unitWord("box", Math.max(0, remaining))}`,
    );
    if (remaining > 0) {
      warnParts.push(`${name}: Assign ${remaining} more ${unitWord("box", remaining)} to continue.`);
    } else if (remaining < 0) {
      warnParts.push(`${name}: Remove ${Math.abs(remaining)} ${unitWord("box", remaining)} to match the package total.`);
    }
  }
  if (showCaseColumn(product, st.bundleQty) && reqCase > 0) {
    const remaining = reqCase - sumCase;
    summaryParts.push(
      `Selected: ${reqCase} ${unitWord("case", reqCase)} · Assigned: ${sumCase} ${unitWord("case", sumCase)} · Remaining: ${Math.max(0, remaining)} ${unitWord("case", Math.max(0, remaining))}`,
    );
    if (remaining > 0) {
      warnParts.push(`${name}: Assign ${remaining} more ${unitWord("case", remaining)} to continue.`);
    } else if (remaining < 0) {
      warnParts.push(`${name}: Remove ${Math.abs(remaining)} ${unitWord("case", remaining)} to match the package total.`);
    }
  }

  const stockIssues = productAllocationIssues(product).filter((i) =>
    /out-of-stock|exceed sellable/i.test(i.message),
  );
  const hasOosQty = stockIssues.some((i) => /out-of-stock/i.test(i.message));
  for (const issue of stockIssues) warnParts.push(issue.message);

  const allComplete = warnParts.length === 0 && safeIsBundleAllocationValid(
    product,
    bundleLinesPayload(st.bundleQty),
    st.caseBySize,
    st.boxBySize,
  );

  const stepHelp = hasOosQty
    ? "Remove out-of-stock quantities before calculating totals."
    : "Assign sizes to match the selected package quantity.";

  const summaryHtml = summaryParts.length
    ? `<p class="mo-alloc-summary">${summaryParts.map((s) => escapeHtml(s)).join("<br>")}</p>`
    : "";
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

  return `<div class="mo-step mo-step--sizes${allComplete ? "" : " is-incomplete"}">
    <div class="mo-step__head">
      <span class="mo-step__badge">Step 2</span>
      <h3 class="mo-step__title">Assign sizes</h3>
    </div>
    <p class="mo-step__help">${escapeHtml(stepHelp)}</p>
    ${summaryHtml}
    ${okHtml}${warnHtml}
    <div class="mo-size-grid${sizeCols.length === 1 ? " mo-size-grid--single" : ""}">${sizeCols.join("")}</div>
  </div>`;
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
    syncEstimateButtonState();
    return;
  }
  host.innerHTML = products.map((p) => renderProductCard(p)).join("");
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

  const hardinBits = [];
  if (data.hardinDiscountApplied) hardinBits.push(statusChip("Local discount applied", "success"));
  if (data.adminLocalDiscountForced) hardinBits.push(statusChip("Staff override", "warning"));
  if (data.adminLocalDiscountNeedsOverride && !data.hardinDiscountApplied) {
    hardinBits.push(statusChip("Not eligible", "warning"));
  }
  if (data.adminLocalDiscountDeclined) hardinBits.push(statusChip("Declined by ZIP", "neutral"));

  const warnings = (v.warnings || [])
    .map((w) => `<div class="sg-inline-warn" style="margin-top:8px">${icon("alert-triangle", 14)}<span>${escapeHtml(String(w))}</span></div>`)
    .join("");
  const err = v.userFacingError
    ? `<div class="sg-inline-warn" style="margin-top:8px">${icon("alert-triangle", 14)}<span>${escapeHtml(v.userFacingError)}</span></div>`
    : "";
  const checkoutNote = v.canCheckout
    ? ""
    : `<p class="sg-meta-note" style="margin:10px 0 0">Quote is not ready for checkout. Resolve issues above and recalculate.</p>`;

  host.innerHTML = `
    <div class="mo-quote-rows">
      <div class="mo-quote-row"><span>Merchandise</span><strong>${escapeHtml(v.merchandiseFormatted)}</strong></div>
      ${discountLine}
      ${shipLine}
      <div class="mo-quote-row"><span>Tax</span><strong>${escapeHtml(v.taxFormatted)}</strong></div>
      <div class="mo-quote-row mo-quote-row--meta"><span></span><span class="sg-muted">Destination: ${escapeHtml(v.destinationState || "—")} · Source: ${escapeHtml(taxSourceLabel(v.taxSource))}</span></div>
      <div class="mo-quote-row mo-quote-row--total"><span>Total</span><strong>${escapeHtml(v.totalFormatted)}</strong></div>
    </div>
    ${hardinBits.length ? `<div class="mo-quote-chips" style="margin-top:10px">${hardinBits.join(" ")}</div>` : ""}
    ${err}${warnings}${checkoutNote}
  `;
  setPanelVisible(stale, Boolean(lastQuote) && estimateStale);
  renderRates(data);
  syncDiscountOverridePanel(data);
}

function syncDiscountOverridePanel(data) {
  const panel = getEl("mo-discount-override");
  if (!panel) return;
  const show =
    readApplyLocalDiscount() &&
    data?.adminLocalDiscountNeedsOverride === true &&
    data?.hardinDiscountApplied !== true;
  setPanelVisible(panel, show);
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
    applyEligibleLocalDiscount: readApplyLocalDiscount(),
    forceApplyEligibleLocalDiscount: discountOverrideConfirmed,
    fulfillmentMethod: fm,
    localDeliveryNote: fm === "local_delivery" ? readLocalDeliveryNote() : "",
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
    if (data?.adminLocalDiscountForced) discountOverrideConfirmed = true;

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

function pageHtml() {
  const stateOpts =
    `<option value="">Select state</option>` + US_STATES.map((s) => `<option value="${s}">${s}</option>`).join("");

  const customer = card({
    title: "Customer",
    bodyHtml: `<div class="mo-grid">
      <label class="sg-field"><span class="sg-field__label">Full name</span><input class="sg-input" id="mo-cust-name" type="text" autocomplete="name" required /></label>
      <label class="sg-field"><span class="sg-field__label">Email</span><input class="sg-input" id="mo-cust-email" type="email" autocomplete="email" required /></label>
      <label class="sg-field"><span class="sg-field__label">Phone <span class="sg-field__optional">(optional)</span></span><input class="sg-input" id="mo-cust-phone" type="tel" autocomplete="tel" /></label>
    </div>`,
  });

  const productsCard = card({
    title: "Products / line items",
    bodyHtml: `<p class="sg-meta-note" style="margin:0 0 12px">For each product: choose a package quantity, then assign sizes until the totals match.</p>
      <div id="mo-products" class="mo-products"><p class="sg-muted">Loading products…</p></div>
      <p class="sg-meta-note" style="margin:12px 0 0">Out-of-stock sizes are blocked. Creating a draft or payment link does not reserve or decrement inventory.</p>`,
  });

  const fulfillment = card({
    title: "Fulfillment",
    bodyHtml: `
      <div class="mo-radio-row" role="radiogroup" aria-label="Fulfillment method">
        <label class="mo-radio"><input type="radio" name="mo_fulfillment" value="carrier" checked /><span>Ship with carrier</span></label>
        <label class="mo-radio"><input type="radio" name="mo_fulfillment" value="local_delivery" /><span>Local delivery</span></label>
        <label class="mo-radio"><input type="radio" name="mo_fulfillment" value="pickup" /><span>Pickup</span></label>
      </div>
      <p class="sg-meta-note mo-fulfillment-helper" id="mo-fulfillment-helper">Full shipping address is required for carrier quotes.</p>
      <div id="mo-local-area-advisory" class="sg-warn-banner sg-hide" hidden role="status" style="margin:10px 0 0"></div>
      <div id="mo-pickup-note" class="sg-inline-warn mo-fulfillment-callout sg-hide" hidden>${icon("info", 14)}<span>${escapeHtml(PICKUP_NOTE)}</span></div>
      <div id="mo-local-note-wrap" class="mo-fulfillment-panel sg-hide" hidden>
        <label class="sg-field mo-field-full" style="margin-bottom:0">
          <span class="sg-field__label">Local delivery note <span class="sg-field__optional">(optional)</span></span>
          <textarea class="sg-input sg-textarea" id="mo-local-note" rows="3" placeholder="Gate code, time window, delivery instructions, etc."></textarea>
        </label>
      </div>
      <div id="mo-address-block" class="mo-address mo-fulfillment-panel">
        <div class="mo-grid">
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
    title: "Discount",
    bodyHtml: `
      <label class="mo-check">
        <input type="checkbox" id="mo-apply-discount" />
        <span>Apply eligible local discount (Hardin County, TN delivery — browser ZIP check; eligibility is confirmed by the server)</span>
      </label>
      <p class="sg-meta-note" style="margin:8px 0 0">Checking this requests local pricing. It only applies when the address qualifies, unless you use the staff override after estimate.</p>
      <div id="mo-discount-override" class="mo-override sg-hide" hidden>
        <p class="mo-override__text">This order does not meet discount eligibility rules (shipping ZIP is outside the eligible local area).</p>
        <button type="button" class="sg-btn sg-btn--primary sg-btn--sm" id="mo-discount-override-btn">Continue — apply discount anyway</button>
        <p class="sg-meta-note" style="margin:8px 0 0">Override is sent on the next estimate only. Create and send payment link uses the same override flag. Discount authority remains on the server.</p>
      </div>`,
  });

  const inventoryNote = card({
    title: "Payment link workflow",
    bodyHtml: `
      <p class="sg-meta-note" style="margin:0">This page creates a Manual Order draft and a Square payment link, then attempts to email the customer. Payment is collected only when the customer pays the link.</p>
      <ul class="sg-meta-note" style="margin:10px 0 0;padding-left:18px">
        <li>Creating a draft does not reserve inventory.</li>
        <li>Creating or emailing a payment link does not decrement inventory.</li>
        <li>Stock is revalidated by the backend on estimate, create, and send-link.</li>
        <li>Payment does not itself decrement stock for this Manual Order path.</li>
        <li>Fulfillment stays in the existing admin workflow — this page does not mark shipped or purchase labels.</li>
      </ul>`,
  });

  const quote = card({
    title: "Estimate / quote preview",
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
    ${inventoryNote}
    ${quote}
    ${actions}
  </div>`;
}

function wirePage() {
  const page = getEl("sg-page");
  if (!page) return;

  page.addEventListener("click", (e) => {
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
    if (t.id === "mo-apply-discount") {
      discountOverrideConfirmed = false;
      markEstimateInputsChanged();
      syncDiscountOverridePanel(lastQuote);
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
  getEl("mo-discount-override-btn")?.addEventListener("click", () => {
    discountOverrideConfirmed = true;
    markEstimateInputsChanged();
    void runEstimate();
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
  wirePage();
}

/** Browser-only boot. Skipped under Node harness imports. */
if (typeof document !== "undefined") {
  bootAdminV2Page({
    activeNav: "manual-order",
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
