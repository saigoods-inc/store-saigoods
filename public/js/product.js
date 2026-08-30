import {
  bundleCardPricePerHtml,
  formatCurrency,
  formatSizeDisplayLabel,
  getCartQuote,
  getProduct,
  storefrontSizesForProduct,
} from "./catalog.js";
import { getCart, setProductQuantities } from "./cart-store.js";
import { formatBundleCardSizeSummaryHtml, perBundleSummaryMap } from "./bundle-size-summary.js";
import { responsiveRasterImg } from "./image-utils.js";
import {
  inventoryAllowsAllocations,
  isSizeChannelPurchasable,
  isStorefrontGlobalOutOfStock,
  sizesOrderedForAllocation,
} from "./size-availability.js";
import { escapeHtml, initSite, showToast } from "./site.js";
import { trackAddToCart, trackViewItem } from "./analytics.js";

const productRoot = document.querySelector("[data-product-detail]");
const currentUrl = new URL(window.location.href);
const productPathMatch = currentUrl.pathname.match(/^\/products\/([^/]+)\/?$/);
const slug = productPathMatch
  ? decodeURIComponent(productPathMatch[1])
  : currentUrl.searchParams.get("slug");

let store;
let product;
let selectedImageIndex = 0;
/** @type {Record<string, number>} */
let bundleQty = {};
/** @type {Record<string, number>} */
let caseBySize = {};
/** @type {Record<string, number>} */
let boxBySize = {};

/** When true, show bundle total mismatch styling (only set after failed Add to cart / Checkout). */
let bundleSubmitAttempted = false;

/** Which bundle's size dropdown is open (`bundle.id`), or null. */
let openBundleDropdownId = null;
let purchaseLimitCheckInFlight = false;

const CUSTOMER_PURCHASE_LIMIT_MESSAGE =
  "Orders are limited to 10 shipping packages. Please reduce the quantity or complete your current order before adding more.";

function sortBundlesHierarchically(bundles) {
  return [...(bundles || [])].sort((a, b) => {
    const kindDifference = (a.kind === "box" ? 0 : 1) - (b.kind === "box" ? 0 : 1);
    if (kindDifference) return kindDifference;
    const unitDifference = (Number(a.units) || 0) - (Number(b.units) || 0);
    return unitDifference || String(a.label || "").localeCompare(String(b.label || ""));
  });
}

document.addEventListener("DOMContentLoaded", init);

async function init() {
  store = await initSite({ page: "product" });
  product = await getProduct(slug);

  if (!product) {
    renderMissingProduct();
    return;
  }

  applyProductMetadata(product);

  const sizes = storefrontSizesForProduct(product, store);
  const bundles = sortBundlesHierarchically(product.bundles);

  bundleQty = Object.fromEntries(bundles.map((b) => [b.id, 0]));
  caseBySize = sizes.reduce((acc, size) => {
    acc[size] = 0;
    return acc;
  }, {});
  boxBySize = sizes.reduce((acc, size) => {
    acc[size] = 0;
    return acc;
  }, {});

  hydrateProductStateFromCart();
  renderProduct();
  trackViewItem(product);
  productRoot.addEventListener("click", handleProductClick);
  document.addEventListener("click", onClickOutsideOpenBundle, false);
}

function applyProductMetadata(currentProduct) {
  const canonicalUrl = `${window.location.origin}/products/${encodeURIComponent(currentProduct.slug)}`;
  const description = String(currentProduct.subtext || currentProduct.description || "").trim();
  document.title = `${currentProduct.name} | SAI Goods`;

  const descriptionMeta = document.querySelector('meta[name="description"]');
  if (descriptionMeta && description) descriptionMeta.setAttribute("content", description);

  let canonical = document.querySelector('link[rel="canonical"]');
  if (!canonical) {
    canonical = document.createElement("link");
    canonical.setAttribute("rel", "canonical");
    document.head.append(canonical);
  }
  canonical.setAttribute("href", canonicalUrl);
}

/**
 * Restore Bundle & Price and Size & Quantity from the cart line for this slug (e.g. cart “Edit”).
 */
function hydrateProductStateFromCart() {
  const sizes = storefrontSizesForProduct(product, store);
  const bundles = product.bundles || [];
  const knownIds = new Set(bundles.map((b) => b.id));

  const row = getCart(sizes).find((item) => item.slug === product.slug);
  if (!row) {
    return;
  }

  bundleQty = Object.fromEntries(bundles.map((b) => [b.id, 0]));
  for (const line of row.bundleLines || []) {
    const id = String(line.id || "").trim();
    const q = Math.floor(Number(line.qty) || 0);
    if (knownIds.has(id) && q > 0) {
      bundleQty[id] = q;
    }
  }

  for (const size of sizes) {
    caseBySize[size] = Math.floor(Number(row.quantities?.[size]) || 0);
    boxBySize[size] = Math.floor(Number(row.boxQuantities?.[size]) || 0);
  }

  bundleSubmitAttempted = false;
  openBundleDropdownId = null;
}

function onClickOutsideOpenBundle(e) {
  if (openBundleDropdownId === null) {
    return;
  }
  // Clicks on cart/checkout are handled by handleProductClick on the product root first, but the
  // event still bubbles here. Those actions may open the bundle panel for validation — do not close.
  if (e.target.closest('[data-action="add-to-cart"], [data-action="checkout"]')) {
    return;
  }
  const card = e.target.closest("[data-bundle-id]");
  if (card && card.dataset.bundleId === openBundleDropdownId) {
    return;
  }
  openBundleDropdownId = null;
  renderProduct();
}

function computeRequiredUnits() {
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

function sumChannel(map) {
  return Object.values(map).reduce((s, n) => s + (Math.floor(Number(n)) || 0), 0);
}

/**
 * Round-robin distribution of `total` units across `sizesOrder` (used when bundle requirements change).
 * Zeros every key in `allSizes` so out-of-stock sizes never retain stale counts.
 */
function defaultSpread(total, sizesOrder, allSizes) {
  const map = {};
  for (const s of allSizes) {
    map[s] = 0;
  }
  const n = Math.max(0, Math.floor(Number(total) || 0));
  if (!sizesOrder.length) {
    return map;
  }
  for (let i = 0; i < n; i++) {
    map[sizesOrder[i % sizesOrder.length]] += 1;
  }
  return map;
}

/**
 * When box/case bundle counts change, re-fill only the affected channel so totals match
 * the new requirement. Size steppers never auto-adjust each other.
 */
function applyBundleRequirementDeltas(prevReq, nextReq, allSizes) {
  const order = sizesOrderedForAllocation(product, allSizes);
  if (nextReq.reqBox !== prevReq.reqBox) {
    const orderBox = order.filter((s) => isSizeChannelPurchasable(product, s, "box"));
    boxBySize = defaultSpread(nextReq.reqBox, orderBox, allSizes);
  }
  if (nextReq.reqCase !== prevReq.reqCase) {
    const orderCase = order.filter((s) => isSizeChannelPurchasable(product, s, "case"));
    caseBySize = defaultSpread(nextReq.reqCase, orderCase, allSizes);
  }
}

function applyBundleDelta(bundleId, delta) {
  if (isStorefrontGlobalOutOfStock(product) && delta > 0) {
    return;
  }
  bundleSubmitAttempted = false;
  const sizes = storefrontSizesForProduct(product, store);
  const prevReq = computeRequiredUnits();
  const prevQ = Math.floor(bundleQty[bundleId] || 0);
  const nextQ = Math.max(0, prevQ + delta);
  bundleQty = { ...bundleQty, [bundleId]: nextQ };
  if (nextQ < 1) {
    if (openBundleDropdownId === bundleId) {
      openBundleDropdownId = null;
    }
  } else {
    openBundleDropdownId = bundleId;
  }
  const nextReq = computeRequiredUnits();
  applyBundleRequirementDeltas(prevReq, nextReq, sizes);
}

function selectBundleCard(bundleId) {
  if (isStorefrontGlobalOutOfStock(product)) {
    return;
  }
  if ((bundleQty[bundleId] || 0) >= 1) {
    openBundleDropdownId = bundleId;
    return;
  }
  bundleSubmitAttempted = false;
  const sizes = storefrontSizesForProduct(product, store);
  const prevReq = computeRequiredUnits();
  bundleQty = { ...bundleQty, [bundleId]: 1 };
  openBundleDropdownId = bundleId;
  const nextReq = computeRequiredUnits();
  applyBundleRequirementDeltas(prevReq, nextReq, sizes);
}

function bundleSubtotalCents() {
  const bundles = product.bundles || [];
  const caseCount = bundles.reduce((sum, b) => {
    const qty = Math.max(0, Math.floor(bundleQty[b.id] || 0));
    return sum + (String(b.kind).toLowerCase() === "case" ? qty * Math.max(1, Math.floor(Number(b.units) || 1)) : 0);
  }, 0);
  const rule = product.volumePricing;
  const volumeActive = rule?.active === true && caseCount >= Number(rule.minCases) && Number(rule.pricePerCaseCents) > 0;
  let total = 0;
  for (const b of bundles) {
    const q = Math.floor(bundleQty[b.id] || 0);
    if (q < 1) {
      continue;
    }
    const regular = Math.max(0, Number(b.priceCents) || 0);
    const volume = String(b.kind).toLowerCase() === "case"
      ? Math.max(1, Math.floor(Number(b.units) || 1)) * Number(rule?.pricePerCaseCents || 0)
      : regular;
    total += q * (volumeActive ? Math.min(regular, volume) : regular);
  }
  return total;
}

function bundleLinesPayload() {
  return Object.entries(bundleQty)
    .filter(([, q]) => q > 0)
    .map(([id, qty]) => ({ id, qty }));
}

function candidateCartItems() {
  const sizes = store.site.sizes;
  const currentItems = getCart(sizes).filter((item) => item.slug !== product.slug);
  return [
    ...currentItems,
    {
      slug: product.slug,
      quantities: { ...caseBySize },
      boxQuantities: { ...boxBySize },
      bundleLines: bundleLinesPayload(),
    },
  ];
}

function showPurchaseLimitMessage(message = "") {
  const element = document.querySelector("[data-purchase-limit-message]");
  if (!element) return;
  element.textContent = message;
  element.hidden = !message;
}

async function selectionFitsOnlinePurchaseLimit(button) {
  if (purchaseLimitCheckInFlight) return false;
  purchaseLimitCheckInFlight = true;
  if (button) button.disabled = true;
  try {
    const quote = await getCartQuote(candidateCartItems());
    if (quote?.shippingPackageLimit?.exceeded === true) {
      showPurchaseLimitMessage(CUSTOMER_PURCHASE_LIMIT_MESSAGE);
      return false;
    }
    showPurchaseLimitMessage();
    return true;
  } catch (error) {
    showToast(error?.message || "We couldn't verify this order. Please try again.", "error");
    return false;
  } finally {
    purchaseLimitCheckInFlight = false;
    if (button?.isConnected) button.disabled = false;
  }
}

function allocationValid() {
  const { reqBox, reqCase } = computeRequiredUnits();
  return sumChannel(boxBySize) === reqBox && sumChannel(caseBySize) === reqCase;
}

/** Sizes that are out of stock for this product but still have a positive allocation. */
function unavailableSizesWithQuantity() {
  const sizes = storefrontSizesForProduct(product, store);
  const names = [];
  for (const s of sizes) {
    const c = Math.floor(caseBySize[s] || 0);
    const b = Math.floor(boxBySize[s] || 0);
    if (c > 0 && !isSizeChannelPurchasable(product, s, "case")) {
      names.push(s);
    } else if (b > 0 && !isSizeChannelPurchasable(product, s, "box") && !names.includes(s)) {
      names.push(s);
    }
  }
  return names;
}

function hasAnyBundleSelection() {
  return Object.values(bundleQty).some((q) => Math.floor(q || 0) > 0);
}

function showBoxColumn() {
  return (product.bundles || []).some(
    (b) => String(b.kind).toLowerCase() === "box" && (bundleQty[b.id] || 0) > 0,
  );
}

function showCaseColumn() {
  return (product.bundles || []).some(
    (b) => String(b.kind).toLowerCase() === "case" && (bundleQty[b.id] || 0) > 0,
  );
}

/**
 * First bundle card to focus when allocation is invalid: box channel before case if both mismatch.
 * @returns {string|null} bundle id
 */
function bundleIdToOpenForAllocationMismatch() {
  if (!product) {
    return null;
  }
  const bundleList = product.bundles || [];
  const reqUnits = computeRequiredUnits();
  const sumBoxes = sumChannel(boxBySize);
  const sumCases = sumChannel(caseBySize);
  const boxMismatch =
    showBoxColumn() && reqUnits.reqBox > 0 && sumBoxes !== reqUnits.reqBox;
  const caseMismatch =
    showCaseColumn() && reqUnits.reqCase > 0 && sumCases !== reqUnits.reqCase;

  if (boxMismatch) {
    const b = bundleList.find(
      (x) => String(x.kind).toLowerCase() === "box" && (bundleQty[x.id] || 0) > 0,
    );
    if (b) {
      return b.id;
    }
  }
  if (caseMismatch) {
    const b = bundleList.find(
      (x) => String(x.kind).toLowerCase() === "case" && (bundleQty[x.id] || 0) > 0,
    );
    if (b) {
      return b.id;
    }
  }
  return null;
}

function scrollBundleCardIntoView(bundleId) {
  if (!bundleId || !productRoot) {
    return;
  }
  const prefersReduced =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const idStr = String(bundleId);
  const run = () => {
    let card = null;
    for (const el of productRoot.querySelectorAll("[data-bundle-id]")) {
      if (el.dataset.bundleId === idStr) {
        card = el;
        break;
      }
    }
    if (!card) {
      return;
    }
    card.scrollIntoView({
      behavior: prefersReduced ? "auto" : "smooth",
      block: "nearest",
      inline: "nearest",
    });
  };
  requestAnimationFrame(() => {
    requestAnimationFrame(run);
  });
}

function focusBundleForAllocationError() {
  const id = bundleIdToOpenForAllocationMismatch();
  if (id) {
    openBundleDropdownId = id;
  }
  renderProduct();
  if (id) {
    scrollBundleCardIntoView(id);
  }
}

/**
 * @param {{ showBoxError: boolean, showCaseError: boolean, boxHint: string, caseHint: string }} err
 * @param {boolean} globalOos
 */
function renderBundleCard(b, err, globalOos) {
  const id = escapeHtml(b.id);
  const qty = Math.floor(bundleQty[b.id] || 0);
  const selected = qty > 0 ? " is-selected" : "";
  const badgePopular =
    String(b.badge || "").toLowerCase() === "popular"
      ? `<span class="bundle-card__badge bundle-card__badge--popular">Most popular🔥</span>`
      : "";
  const badgeSave = (() => {
    const kind = String(b.kind || "").toLowerCase();
    const units = Math.max(0, Math.floor(Number(b.units) || 0));
    if (kind !== "case" || units < 5) {
      return "";
    }
    const bundles = Array.isArray(product?.bundles) ? product.bundles : [];
    const caseOne = bundles.find((x) => String(x?.kind || "").toLowerCase() === "case" && Number(x?.units) === 1);
    const caseOnePrice = Math.max(0, Math.round(Number(caseOne?.priceCents) || 0));
    const bundlePrice = Math.max(0, Math.round(Number(b?.priceCents) || 0));
    if (caseOnePrice < 1 || bundlePrice < 1) {
      return "";
    }
    const baseline = caseOnePrice * units;
    const savings = Math.max(0, baseline - bundlePrice);
    if (savings < 1) {
      return "";
    }
    return `<span class="bundle-card__badge bundle-card__badge--save">Save ${formatCurrency(savings)}</span>`;
  })();

  const kind = String(b.kind).toLowerCase();
  const showExpand = qty > 0 && openBundleDropdownId === b.id;
  let panelInner = "";
  if (showExpand) {
    if (kind === "box" && showBoxColumn()) {
      panelInner = renderSizeColumn("Boxes Bundle", "box", boxBySize, {
        invalid: err.showBoxError,
        hint: err.boxHint,
        hideHeader: true,
      });
    } else if (kind === "case" && showCaseColumn()) {
      panelInner = renderSizeColumn("Carton bundle", "case", caseBySize, {
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

  const sizes = storefrontSizesForProduct(product, store);
  const mapForKind =
    kind === "box" ? boxBySize : kind === "case" ? caseBySize : null;
  const summaryMap =
    mapForKind &&
    qty > 0 &&
    !showExpand &&
    ((kind === "box" && showBoxColumn()) || (kind === "case" && showCaseColumn()))
      ? perBundleSummaryMap(product, bundleQty, b, mapForKind, sizes)
      : null;
  const summaryHtml = summaryMap ? formatBundleCardSizeSummaryHtml(summaryMap, sizes, escapeHtml) : "";
  const collapsedSummaryBlock =
    summaryHtml !== ""
      ? `<p class="bundle-card__size-summary">${summaryHtml}</p>`
      : "";

  const lockClass = globalOos ? " bundle-card--store-locked" : "";
  const lockBundleUi = globalOos ? " disabled" : "";

  return `
    <div class="bundle-card${selected}${lockClass}" data-bundle-id="${id}">
      <div class="bundle-card__badges" aria-hidden="true">${badgePopular}${badgeSave}</div>
      <div class="bundle-card__row">
        <button type="button" class="bundle-card__main" data-action="bundle-select" data-bundle-id="${id}" aria-label="Select ${escapeHtml(b.label)}, ${formatCurrency(b.priceCents)} total"${lockBundleUi}>
          <span class="bundle-card__title">${escapeHtml(b.label)}</span>
          <span class="bundle-card__price-total">${formatCurrency(b.priceCents)}</span>
          ${bundleCardPricePerHtml(b.priceCents, b.units, kind)}
        </button>
        <div class="bundle-card__stepper qty-control qty-control--round">
          <button type="button" data-action="bundle-decrease" data-bundle-id="${id}" aria-label="Decrease ${escapeHtml(b.label)} packs">−</button>
          <strong>${qty}</strong>
          <button type="button" data-action="bundle-increase" data-bundle-id="${id}" aria-label="Increase ${escapeHtml(b.label)} packs"${lockBundleUi}>+</button>
        </div>
      </div>
      ${collapsedSummaryBlock}
      ${expandBlock}
    </div>
  `;
}

function renderSizeColumn(title, channel, map, { invalid = false, hint = "", hideHeader = false } = {}) {
  const sizes = storefrontSizesForProduct(product, store);
  const { reqBox, reqCase } = computeRequiredUnits();
  const req = channel === "box" ? reqBox : reqCase;
  const total = sumChannel(map);
  const plusDisabled = req < 1 || total >= req;

  const errClass = invalid ? " size-bundle-column--invalid" : "";
  const errMsg =
    invalid && hint
      ? `<p class="size-bundle-column__error" role="alert">${escapeHtml(hint)}</p>`
      : "";
  const headerHtml =
    hideHeader || !String(title || "").trim()
      ? ""
      : `<div class="size-bundle-column__header">${escapeHtml(title)}</div>`;

  return `
    <div class="size-bundle-column${errClass}" data-channel="${channel}">
      ${errMsg}
      ${headerHtml}
      <div class="size-bundle-column__rows">
        ${sizes
          .map((size) => {
            const purchasable = isSizeChannelPurchasable(product, size, channel);
            const cur = Math.floor(map[size] || 0);
            const minusDisabled = cur < 1;
            const plusDisabledForRow = !purchasable || plusDisabled;
            const rowClass = purchasable ? "size-row" : "size-row size-row--unavailable";
            const stockNote = purchasable
              ? ""
              : `<span class="size-row__stock-note">Currently unavailable</span>`;
            return `
          <div class="${rowClass}">
            <span class="size-row__label-wrap">
              <span class="size-row__label">${escapeHtml(formatSizeDisplayLabel(size))}</span>
              ${stockNote}
            </span>
            <div class="qty-control qty-control--round">
              <button type="button" data-action="size-step" data-channel="${channel}" data-size="${escapeHtml(size)}" data-delta="-1" aria-label="Decrease ${escapeHtml(formatSizeDisplayLabel(size))} ${channel} count"${
                minusDisabled ? " disabled" : ""
              }>−</button>
              <strong>${map[size] || 0}</strong>
              <button type="button" data-action="size-step" data-channel="${channel}" data-size="${escapeHtml(size)}" data-delta="1" aria-label="Increase ${escapeHtml(formatSizeDisplayLabel(size))} ${channel} count"${
                plusDisabledForRow ? " disabled" : ""
              }>+</button>
            </div>
          </div>
        `;
          })
          .join("")}
      </div>
    </div>
  `;
}

/** Gloves ship 100 pieces per box by weight; carton size comes from `boxesPerCase`. */
function casePackagingNote(product) {
  const boxes = Math.max(1, Math.floor(Number(product.boxesPerCase) || 10));
  const pieces = boxes * 100;
  const boxNoun = boxes === 1 ? "box" : "boxes";
  return `1 carton contains ${boxes} ${boxNoun}, totaling ${pieces.toLocaleString("en-US")} pieces by weight.`;
}

function renderProduct() {
  const thumbIndexes = product.gallery.slice(0, 4).map((_, index) => index);
  const subtotal = bundleSubtotalCents();
  const volumeRule = product.volumePricing;
  const volumePricingNote = volumeRule?.active === true && Number(volumeRule.minCases) >= 2 && Number(volumeRule.pricePerCaseCents) > 0
    ? `<p class="product-volume-pricing"><strong>Volume price:</strong> ${escapeHtml(String(volumeRule.minCases))}+ cartons of this product are ${formatCurrency(volumeRule.pricePerCaseCents)} per carton, automatically.</p>`
    : "";
  const bundles = sortBundlesHierarchically(product.bundles);
  const reqUnits = computeRequiredUnits();
  const sumBoxes = sumChannel(boxBySize);
  const sumCases = sumChannel(caseBySize);
  const boxMismatch =
    showBoxColumn() && reqUnits.reqBox > 0 && sumBoxes !== reqUnits.reqBox;
  const caseMismatch =
    showCaseColumn() && reqUnits.reqCase > 0 && sumCases !== reqUnits.reqCase;
  const showBoxError = bundleSubmitAttempted && boxMismatch;
  const showCaseError = bundleSubmitAttempted && caseMismatch;
  const boxHint = showBoxError
    ? `Total boxes must equal ${reqUnits.reqBox} to match your bundle packs. Current: ${sumBoxes}.`
    : "";
  const caseHint = showCaseError
    ? `Total cartons must equal ${reqUnits.reqCase} to match your bundle quantity. Current: ${sumCases}.`
    : "";
  const globalOos = isStorefrontGlobalOutOfStock(product);
  const hasSizeSelection = sumCases + sumBoxes > 0;
  const layoutOk =
    hasAnyBundleSelection() && subtotal > 0 && hasSizeSelection && !showBoxError && !showCaseError;
  const inventoryOk = inventoryAllowsAllocations(
    product,
    caseBySize,
    boxBySize,
    storefrontSizesForProduct(product, store),
  );
  const canPurchase = !globalOos && layoutOk && inventoryOk;
  const stockOutOnly = !globalOos && layoutOk && !inventoryOk;
  const primaryCtaLabel = globalOos ? "New stock arriving soon" : stockOutOnly ? "Currently Out of Stock" : "Add to cart";
  const secondaryCtaLabel = globalOos ? "New stock arriving soon" : stockOutOnly ? "Currently Out of Stock" : "Purchase now";

  const err = { showBoxError, showCaseError, boxHint, caseHint };
  const bundleSection =
    bundles.length > 0
      ? `
        <div class="detail-block detail-block--bundles">
          <h3>Bundle &amp; Price</h3>
          <div class="bundle-grid">
            ${bundles.map((b) => renderBundleCard(b, err, globalOos)).join("")}
          </div>
          ${volumePricingNote}
          ${
            !hasAnyBundleSelection()
              ? `<p class="inline-note inline-note--muted product-bundle-hint">Select a bundle, then choose sizes in the panel below it.</p>`
              : ""
          }
        </div>
      `
      : "";

  productRoot.innerHTML = `
    <section class="product-layout">
      <div class="product-gallery">
        <div class="product-gallery__thumbs">
          ${thumbIndexes
            .map(
              (index) => `
                <button
                  class="product-gallery__thumb ${selectedImageIndex === index ? "is-active" : ""}"
                  type="button"
                  data-thumb-index="${index}"
                  aria-label="View product image ${index + 1}"
                >
                  ${responsiveRasterImg(product.gallery[index], {
                    alt: `${product.name} image ${index + 1}`,
                    loading: index === selectedImageIndex ? "eager" : "lazy",
                    fetchpriority: index === 0 ? "high" : "auto",
                    sizes: "(max-width: 768px) 22vw, 120px",
                  })}
                </button>
              `,
            )
            .join("")}
        </div>

        <div class="product-gallery__main">
          ${responsiveRasterImg(product.gallery[selectedImageIndex], {
            alt: `${product.name} main image`,
            loading: "eager",
            fetchpriority: "high",
            sizes: "(max-width: 768px) 100vw, 520px",
          })}
        </div>
      </div>

      <div class="product-info">
        <h1>${escapeHtml(product.name)}</h1>
        <div class="product-info__intro">
          <p class="product-info__copy">${escapeHtml(product.description)}</p>
          <p class="product-info__pack-note">${escapeHtml(casePackagingNote(product))}</p>
        </div>

        <div class="detail-block">
          <h3>About this item</h3>
          <div class="spec-list">
            ${product.specs
              .map(
                (spec) => `
                  <div class="spec-list__row">
                    <span>${escapeHtml(spec.label)}</span>
                    <strong>${escapeHtml(spec.value)}</strong>
                  </div>
                `,
              )
              .join("")}
          </div>
        </div>

        ${bundleSection}

        <p class="product-purchase-limit-message" data-purchase-limit-message role="alert" aria-live="polite" hidden></p>

        <div class="selection-summary">
          <div class="selection-summary__subtotal-row">
            <span class="selection-summary__subtotal-label">Subtotal</span>
            <span class="selection-summary__subtotal-amount">${formatCurrency(subtotal)}</span>
          </div>
        </div>

        <div class="product-actions">
          ${
            globalOos
              ? `<p class="product-actions__oos-hint">This product is currently out of stock. We're restocking soon.</p>`
              : ""
          }
          <button class="button button--primary button--with-icon" type="button" data-action="add-to-cart" ${
            !canPurchase ? "disabled" : ""
          }>
            <img src="/img/cart-icon.svg" alt="" aria-hidden="true" class="button__icon" width="22" height="22" decoding="async" />
            <span>${escapeHtml(primaryCtaLabel)}</span>
          </button>
          <button class="button button--secondary" type="button" data-action="checkout" ${!canPurchase ? "disabled" : ""}>
            ${escapeHtml(secondaryCtaLabel)}
          </button>
        </div>
      </div>
    </section>
  `;
}

function renderMissingProduct() {
  productRoot.innerHTML = `
    <div class="empty-state">
      <h2>Product not found.</h2>
      <p>The item you requested is not in the current SAI Goods catalog.</p>
      <a class="button button--secondary" href="/index.html#products">Return to the store</a>
    </div>
  `;
}

function handleSizeStep(channel, size, delta) {
  bundleSubmitAttempted = false;
  if (isStorefrontGlobalOutOfStock(product) && delta > 0) {
    return;
  }
  if (delta > 0 && !isSizeChannelPurchasable(product, size, channel)) {
    return;
  }
  const map = channel === "box" ? { ...boxBySize } : { ...caseBySize };
  const cur = Math.floor(map[size]) || 0;
  const { reqBox, reqCase } = computeRequiredUnits();
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
    boxBySize = map;
  } else {
    caseBySize = map;
  }
}

async function handleProductClick(event) {
  const target = event.target.closest(
    "[data-thumb-index], [data-action], [data-bundle-id]",
  );

  if (!target || !product) {
    return;
  }

  if (target.dataset.thumbIndex) {
    selectedImageIndex = Number(target.dataset.thumbIndex);
    renderProduct();
    return;
  }

  const action = target.dataset.action;

  if (action === "bundle-select") {
    if (isStorefrontGlobalOutOfStock(product)) {
      return;
    }
    selectBundleCard(target.dataset.bundleId);
    renderProduct();
    return;
  }

  if (action === "bundle-increase") {
    if (isStorefrontGlobalOutOfStock(product)) {
      return;
    }
    applyBundleDelta(target.dataset.bundleId, 1);
    renderProduct();
    return;
  }

  if (action === "bundle-decrease") {
    applyBundleDelta(target.dataset.bundleId, -1);
    renderProduct();
    return;
  }

  if (action === "size-step") {
    const channel = target.dataset.channel;
    const size = target.dataset.size;
    const delta = Number(target.dataset.delta) || 0;
    handleSizeStep(channel, size, delta);
    renderProduct();
    return;
  }

  if (action === "add-to-cart") {
    if (isStorefrontGlobalOutOfStock(product)) {
      return;
    }
    if (!allocationValid()) {
      bundleSubmitAttempted = true;
      focusBundleForAllocationError();
      showToast(
        "Adjust box and carton totals above to match your bundle quantity before adding to cart.",
        "error",
      );
      return;
    }
    const oosSizes = unavailableSizesWithQuantity();
    if (oosSizes.length) {
      showToast(
        `Out-of-stock sizes still have quantity (${oosSizes.join(", ")}). Use − to clear them before adding to cart.`,
        "error",
      );
      return;
    }
    if (!(await selectionFitsOnlinePurchaseLimit(target))) {
      return;
    }
    const cartPayload = {
      quantities: { ...caseBySize },
      boxQuantities: { ...boxBySize },
      bundleLines: bundleLinesPayload(),
    };
    setProductQuantities(product.slug, cartPayload, store.site.sizes);
    void getCartQuote([{ slug: product.slug, ...cartPayload }])
      .then(trackAddToCart)
      .catch(() => {});
    const parts = [];
    const cb = sumChannel(caseBySize);
    const bb = sumChannel(boxBySize);
    if (cb) {
      parts.push(`${cb} carton${cb === 1 ? "" : "s"}`);
    }
    if (bb) {
      parts.push(`${bb} box${bb === 1 ? "" : "es"}`);
    }
    showToast(`Added ${parts.join(" · ")} to your cart.`, "success");
    return;
  }

  if (action === "checkout") {
    if (isStorefrontGlobalOutOfStock(product)) {
      return;
    }
    if (!allocationValid()) {
      bundleSubmitAttempted = true;
      focusBundleForAllocationError();
      showToast(
        "Adjust box and carton totals above to match your bundle quantity before checkout.",
        "error",
      );
      return;
    }
    const oosCheckout = unavailableSizesWithQuantity();
    if (oosCheckout.length) {
      showToast(
        `Out-of-stock sizes still have quantity (${oosCheckout.join(", ")}). Use − to clear them before checkout.`,
        "error",
      );
      return;
    }
    if (!(await selectionFitsOnlinePurchaseLimit(target))) {
      return;
    }
    setProductQuantities(
      product.slug,
      {
        quantities: { ...caseBySize },
        boxQuantities: { ...boxBySize },
        bundleLines: bundleLinesPayload(),
      },
      store.site.sizes,
    );
    window.location.href = "/cart.html";
  }
}
