import { continueToCheckout } from './checkout-entry.js';
import { aggregateAllocations, restoreAllocations } from "./bundle-allocations.js";
import { renderProductIntro, currentDetails as detailsForProduct, detailRows } from "./product-presentation.js";
import {
  bundleCardPricePerHtml,
  formatCurrency,
  formatSizeDisplayLabel,
  getCartQuote,
  getProduct,
  storefrontSizesForProduct,
} from "./catalog.js";
import { getCart, setProductQuantities } from "./cart-store.js";
import { formatBundleCardSizeSummaryHtml } from "./bundle-size-summary.js";
import { responsiveRasterImg } from "./image-utils.js";
import {
  inventoryAllowsAllocations,
  isSizeChannelPurchasable,
  isStorefrontGlobalOutOfStock,
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
let bundleSizes = {};

function syncBundleSizes() {
  const totals = aggregateAllocations(product.bundles || [], bundleQty, bundleSizes, storefrontSizesForProduct(product, store));
  caseBySize = totals.quantities;
  boxBySize = totals.boxQuantities;
}

function saveBundleSizes() {
  try { localStorage.setItem(`saigoods-bundle-sizes:${product.slug}`, JSON.stringify(bundleSizes)); } catch {}
}

/** When true, show bundle total mismatch styling (only set after failed Add to cart / Checkout). */
let bundleSubmitAttempted = false;

/** Which bundle's size dropdown is open (`bundle.id`), or null. */
let openBundleDropdownId = null;
let purchaseLimitCheckInFlight = false;

const CUSTOMER_PURCHASE_LIMIT_MESSAGE =
  "Orders are limited to 10 shipping packages. Please reduce the quantity or complete your current order before adding more.";

const PRODUCT_SEO_COPY = {
  "nitrile-standard": {
    heading: "LYDUS® 4 Mil Nitrile Examination Gloves",
    title: "LYDUS® 4 Mil Nitrile Examination Gloves | SAI Goods",
  },
  "black-nitrile-general": {
    heading: "LYDUS® 5 Mil Black Nitrile Gloves — General",
    title: "LYDUS® 5 Mil Black Nitrile Gloves | SAI Goods",
  },
  "black-nitrile-heavy-duty": {
    heading: "LYDUS® 8 Mil Black Nitrile Gloves — Heavy Duty",
    title: "LYDUS® 8 Mil Black Nitrile Gloves | SAI Goods",
  },
};

function productSeoCopy(currentProduct) {
  return PRODUCT_SEO_COPY[currentProduct.slug] || {
    heading: currentProduct.name,
    title: `${currentProduct.name} | SAI Goods`,
  };
}

function productHeadingHtml(currentProduct) {
  const heading = productSeoCopy(currentProduct).heading;
  const brand = "LYDUS®";
  if (!heading.startsWith(brand)) return escapeHtml(heading);
  return `<span class="product-brand">LYDUS<sup>®</sup></span>${escapeHtml(heading.slice(brand.length))}`;
}

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
  productRoot.addEventListener("keydown", event => {
    if (!event.target.matches('[role="tab"]') || !['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
    event.preventDefault();
    const tabs = [...productRoot.querySelectorAll('[role="tab"]')];
    const index = tabs.indexOf(event.target);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length-1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    activateDetailsTab(tabs[next].dataset.tab); tabs[next].focus();
  });
  document.addEventListener("click", onClickOutsideOpenBundle, false);
}

function applyProductMetadata(currentProduct) {
  const canonicalUrl = `https://store.saigoods.com/products/${encodeURIComponent(currentProduct.slug)}`;
  const rawDescription = String(currentProduct.subtext || currentProduct.description || "").replace(/\s+/g, " ").trim();
  const description = rawDescription.length <= 160 ? rawDescription : `${rawDescription.slice(0, 157).trimEnd()}…`;
  document.title = productSeoCopy(currentProduct).title;

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

  for (const kind of ['box', 'case']) {
    if (!bundles.some(b => b.kind === kind && bundleQty[b.id] > 0)) {
      const b = bundles.find(b => b.kind === kind && Number(b.units) === 1);
      if (b) bundleQty[b.id] = sumChannel(kind === 'box' ? boxBySize : caseBySize);
    }
  }
  let saved;
  try { saved = JSON.parse(localStorage.getItem(`saigoods-bundle-sizes:${product.slug}`)); } catch {}
  bundleSizes = restoreAllocations(bundles, bundleQty, row, sizes, saved);
  syncBundleSizes();
  bundleSubmitAttempted = false;
  openBundleDropdownId = null;
}

function onClickOutsideOpenBundle(e) {
  if (e.target.closest('dialog, [data-action="full-details"], [data-action="close-details"]')) return;
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

function applyBundleDelta(bundleId, delta) {
  if (isStorefrontGlobalOutOfStock(product) && delta > 0) {
    return;
  }
  bundleSubmitAttempted = false;
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
  if (!(bundleQty[bundleId] > 0)) delete bundleSizes[bundleId];
  syncBundleSizes();
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
  bundleQty = { ...bundleQty, [bundleId]: 1 };
  openBundleDropdownId = bundleId;
  if (!(bundleQty[bundleId] > 0)) delete bundleSizes[bundleId];
  syncBundleSizes();
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
  return (product.bundles || []).every(b => sumChannel(bundleSizes[b.id] || {}) === (bundleQty[b.id] || 0) * b.units) && sumChannel(boxBySize) === reqBox && sumChannel(caseBySize) === reqCase;
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
  return (product.bundles || []).find(b => (bundleQty[b.id] || 0) > 0 && sumChannel(bundleSizes[b.id] || {}) !== bundleQty[b.id] * b.units)?.id || null;
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
  const displayOffer = product.storefront?.offers?.find(offer => offer.id === b.id);
  const displayPriceCents = displayOffer?.priceCents ?? b.priceCents;
  const [priceDollars, priceCents] = formatCurrency(displayPriceCents).replace(/^\$/, "").split(".");
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
      panelInner = renderSizeColumn("Boxes Bundle", "box", bundleSizes[b.id] || {}, {
        bundle: b,
        invalid: err.showBoxError,
        hint: err.boxHint,
        hideHeader: true,
      });
    } else if (kind === "case" && showCaseColumn()) {
      panelInner = renderSizeColumn("Carton bundle", "case", bundleSizes[b.id] || {}, {
        bundle: b,
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
      ? (bundleSizes[b.id] || {})
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
        <button type="button" class="bundle-card__main" data-action="bundle-select" data-bundle-id="${id}" aria-label="Select ${escapeHtml(b.label)}, ${formatCurrency(displayPriceCents)} total"${lockBundleUi}>
          <span class="bundle-card__title">${escapeHtml(b.label)}</span>
          <span class="bundle-card__price-total" aria-hidden="true"><sup>$</sup>${escapeHtml(priceDollars)}<sup>${escapeHtml(priceCents)}</sup></span>
          ${bundleCardPricePerHtml(displayPriceCents, b.units, kind)}
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

function renderSizeColumn(title, channel, map, { bundle, invalid = false, hint = "", hideHeader = false } = {}) {
  const sizes = storefrontSizesForProduct(product, store);
  const req = (bundleQty[bundle.id] || 0) * bundle.units;
  const total = sumChannel(map);
  const plusDisabled = req < 1 || total >= req;
  invalid = bundleSubmitAttempted && total !== req;
  hint = invalid ? `Choose ${req} ${channel === "box" ? (req === 1 ? "box" : "boxes") : (req === 1 ? "carton" : "cartons")} for this bundle. Current: ${total}.` : "";

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
      <p class="size-selection-progress" role="status"><span>${total} of ${req} ${channel === "box" ? (req === 1 ? "box" : "boxes") : (req === 1 ? "carton" : "cartons")} selected</span>${total === req ? '<span class="size-selection-progress__ready">Ready</span>' : `<span class="size-selection-progress__remaining">${total < req ? `Choose ${req - total} more ${channel === "box" ? (req - total === 1 ? "box" : "boxes") : (req - total === 1 ? "carton" : "cartons")}` : `Remove ${total - req}`}</span>`}</p>
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
              <button type="button" data-action="size-step" data-bundle-id="${escapeHtml(bundle.id)}" data-channel="${channel}" data-size="${escapeHtml(size)}" data-delta="-1" aria-label="Decrease ${escapeHtml(formatSizeDisplayLabel(size))} ${channel} count"${
                minusDisabled ? " disabled" : ""
              }>−</button>
              <strong>${map[size] || 0}</strong>
              <button type="button" data-action="size-step" data-bundle-id="${escapeHtml(bundle.id)}" data-channel="${channel}" data-size="${escapeHtml(size)}" data-delta="1" aria-label="Increase ${escapeHtml(formatSizeDisplayLabel(size))} ${channel} count"${
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

/** Packaging quantity; case size comes from the catalog. */
function currentDetails() { return detailsForProduct(product); }
function renderDetailsDialog() {
  return `<dialog class="product-details-dialog" aria-label="Product details">
    <div class="product-details-drag-area" aria-hidden="true"></div>
    <div class="product-details-dialog__header"><div class="product-details-tabs" role="tablist" aria-label="Product information">${[['specs','Full specifications'],['shipping','Shipping & returns'],['sizes','Size guide']].map(([id,label],i) => `<button type="button" role="tab" id="details-tab-${id}" aria-controls="details-panel-${id}" aria-selected="${i===0}" tabindex="${i===0 ? 0 : -1}" data-action="details-tab" data-tab="${id}">${label}</button>`).join('')}</div><button type="button" class="product-details-close" data-action="close-details" aria-label="Close product details"><svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M4 4L12 12M12 4L4 12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></button></div>
    <section role="tabpanel" id="details-panel-specs" aria-labelledby="details-tab-specs"><h2>Specifications</h2>${detailRows(currentDetails().full)}</section>
    <section role="tabpanel" id="details-panel-shipping" aria-labelledby="details-tab-shipping" hidden><h2>Shipping</h2><ul><li>Orders ship to addresses within the United States.</li><li>Orders are generally processed within one business day.</li><li>Most orders arrive within 3–5 business days.</li><li>Tracking information is emailed when your order ships.</li></ul><p>Delivery dates are estimates and may vary because of carrier delays, holidays, severe weather, or an incorrect delivery address.</p><p><a href="/shipping">View the complete shipping policy</a></p><h2>Returns</h2><p>Return requests must be submitted within three calendar days of delivery. Products must be unopened, unused, and in their original packaging to qualify.</p><p>Approved refunds are subject to a 10% restocking fee. Eligible customers may instead choose store credit for the full merchandise value.</p><h2>Damaged or incorrect orders</h2><p>Please report damaged, defective, or incorrect items within seven calendar days of delivery. Include your order number and clear photographs of the product and shipping package so our team can assist you.</p><p>To request assistance, contact <a href="mailto:sales@saigoods.com">sales@saigoods.com</a>.</p><a href="/returns">View the complete returns and refunds policy</a></section>
    <section role="tabpanel" id="details-panel-sizes" aria-labelledby="details-tab-sizes" hidden><h2>Find your glove size</h2><p>Measure across the widest part of your palm, excluding the thumb. ${product.slug === "nitrile-standard" ? "Keep your hand relaxed and compare the measurement with the chart below." : "Keep your hand relaxed. Contact us with your measurement for help selecting this product’s size."}</p>${product.slug === 'nitrile-standard' ? `<div class="product-size-table"><table><thead><tr><th scope="col">Glove palm width</th><th scope="col">Size</th></tr></thead><tbody>${[['85 ± 5 mm','Small'],['95 ± 5 mm','Medium'],['105 ± 5 mm','Large'],['115 ± 5 mm','XL']].map(([width,size]) => `<tr><th scope="row">${width}</th><td>${size}</td></tr>`).join('')}</tbody></table></div>` : ''}<h3>How to measure</h3><ol><li>Place your dominant hand flat with your fingers together.</li><li>Measure straight across the widest part of your palm.</li><li>Do not include your thumb.</li>${product.slug === "nitrile-standard" ? "<li>If your measurement falls between two sizes, choose the larger size for a more comfortable fit.</li>" : ""}</ol><h3>Fit check</h3><p>A properly fitted glove should feel secure without restricting finger movement. If the glove feels excessively tight across the palm or fingertips, move up one size.</p><p><strong>Need help choosing?</strong> Contact us at <a href="mailto:sales@saigoods.com">sales@saigoods.com</a>.</p></section>
  </dialog>`;
}
async function closeProductDetails() {
  const dialog = productRoot.querySelector('dialog');
  if (!dialog?.open || dialog.dataset.closing === 'true') return;
  dialog.dataset.closing = 'true';
  const animation = dialog.animate(
    [{transform: getComputedStyle(dialog).transform}, {transform: 'translateY(100vh)'}],
    {duration: matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 200, easing: 'ease-in', fill: 'forwards'}
  );
  await animation.finished.catch(() => {});
  dialog.close();
  animation.cancel();
  delete dialog.dataset.closing;
}
function openProductDetails() {
  const dialog = productRoot.querySelector('dialog');
  const scrollY = window.scrollY;
  const previousStyle = document.body.getAttribute('style');
  document.body.style.position = 'fixed';
  document.body.style.top = `-${scrollY}px`;
  document.body.style.width = '100%';
  dialog.addEventListener('close', () => {
    if (previousStyle === null) document.body.removeAttribute('style');
    else document.body.setAttribute('style', previousStyle);
    window.scrollTo({top: scrollY, behavior: 'instant'});
  }, {once: true});
  dialog.onpointerdown = event => {
    const r = dialog.getBoundingClientRect();
    dialog.dataset.backdropPress = String(event.target === dialog && (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom));
  };
  dialog.onclick = event => {
    const r = dialog.getBoundingClientRect();
    if (dialog.dataset.backdropPress === 'true' && event.target === dialog && (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom)) void closeProductDetails();
  };
  const grip = dialog.querySelector('.product-details-drag-area');
  let drag = null;
  let motion = null;
  const resetDrag = () => { drag = null; motion?.cancel(); dialog.style.removeProperty('transform'); };
  dialog.addEventListener('close', resetDrag, {once: true});
  grip.onpointerdown = event => {
    if (!matchMedia('(max-width: 760px)').matches || !event.isPrimary || event.button !== 0) return;
    motion?.cancel();
    drag = {id: event.pointerId, y: event.clientY, distance: 0};
    grip.setPointerCapture(event.pointerId);
  };
  grip.onpointermove = event => {
    if (!drag || drag.id !== event.pointerId) return;
    drag.distance = Math.max(0, event.clientY - drag.y);
    dialog.style.transform = `translateY(${drag.distance}px)`;
  };
  const finishDrag = (event, cancelled = false) => {
    if (!drag || drag.id !== event.pointerId) return;
    const distance = drag.distance;
    drag = null;
    if (grip.hasPointerCapture(event.pointerId)) grip.releasePointerCapture(event.pointerId);
    const dismiss = !cancelled && distance >= 80;
    const destination = dismiss ? dialog.offsetHeight : 0;
    motion = dialog.animate([{transform: `translateY(${distance}px)`}, {transform: `translateY(${destination}px)`}], {
      duration: matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 180,
      easing: 'ease-out', fill: 'forwards'
    });
    motion.finished.then(() => {
      if (dismiss && dialog.open) dialog.close();
      resetDrag();
    }).catch(() => {});
  };
  grip.onpointerup = event => finishDrag(event);
  grip.onpointercancel = event => finishDrag(event, true);
  dialog.oncancel = event => { event.preventDefault(); void closeProductDetails(); };
  dialog.showModal();
}
function activateDetailsTab(id) {
  const dialog = productRoot.querySelector('dialog');
  dialog.querySelectorAll('[role="tab"]').forEach(tab => { const selected = tab.dataset.tab === id; tab.setAttribute('aria-selected', String(selected)); tab.tabIndex = selected ? 0 : -1; });
  dialog.querySelectorAll('[role="tabpanel"]').forEach(panel => { panel.hidden = panel.id !== `details-panel-${id}`; });
}

function renderRelatedProducts() {
  const related = (store.products || []).filter(item => item.slug !== product.slug).slice(0, 2);
  if (!related.length) return "";
  return `<section class="product-related" aria-labelledby="related-heading"><h2 id="related-heading">Products you may also like</h2><div class="product-related__grid">${related.map(item => {
    const offer = item.storefront?.featuredOffer;
    const [dollars, cents] = offer ? formatCurrency(offer.priceCents).replace(/^\$/, "").split('.') : [];
    const thickness = {'nitrile-standard':'4 mil', 'black-nitrile-general':'5 mil', 'black-nitrile-heavy-duty':'8 mil'}[item.slug] || '';
    return `<article class="product-related__card product-related__card--${escapeHtml(item.intro?.theme || 'stone')}"><div class="product-related__media">${responsiveRasterImg(item.cardImage, {alt: item.name, loading: "lazy", sizes: "(max-width: 800px) 45vw, 480px"})}</div><div class="product-related__body"><p class="product-brand">LYDUS®</p><p class="product-related__price">${offer ? `<span class="product-price-accessible">${escapeHtml(formatCurrency(offer.priceCents))}</span><strong aria-hidden="true"><sup>$</sup>${escapeHtml(dollars)}<sup>${escapeHtml(cents)}</sup></strong> <span>per case</span>` : "See available options"}</p><h3><a class="product-related__link" href="/products/${encodeURIComponent(item.slug)}">${escapeHtml(thickness)} ${escapeHtml(item.name)}</a></h3><p class="product-related__copy">${escapeHtml(item.subtext || "")}</p></div><a class="product-related__buy" href="/products/${encodeURIComponent(item.slug)}" aria-label="Choose sizes and bundles for ${escapeHtml(item.name)}"><svg width="20" height="18" viewBox="0 0 17 15" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M8.5 0C8.70625 0 8.90312 0.084375 9.04375 0.234375L13.5437 4.98438L13.5594 5H16C16.5531 5 17 5.44687 17 6C17 6.45312 16.7 6.83438 16.2875 6.95938L14.8469 13.4344C14.6437 14.35 13.8313 15 12.8938 15H4.10313C3.16563 15 2.35313 14.35 2.15 13.4344L0.7125 6.95938C0.3 6.8375 0 6.45312 0 6C0 5.44687 0.446875 5 1 5H3.44063L3.45625 4.98438L7.95625 0.234375C8.09688 0.084375 8.29375 0 8.5 0ZM8.5 1.84063L5.50625 5H11.4937L8.5 1.84063ZM6 8.25C6 7.83437 5.66563 7.5 5.25 7.5C4.83437 7.5 4.5 7.83437 4.5 8.25V11.75C4.5 12.1656 4.83437 12.5 5.25 12.5C5.66563 12.5 6 12.1656 6 11.75V8.25ZM8.5 7.5C8.08437 7.5 7.75 7.83437 7.75 8.25V11.75C7.75 12.1656 8.08437 12.5 8.5 12.5C8.91563 12.5 9.25 12.1656 9.25 11.75V8.25C9.25 7.83437 8.91563 7.5 8.5 7.5ZM12.5 8.25C12.5 7.83437 12.1656 7.5 11.75 7.5C11.3344 7.5 11 7.83437 11 8.25V11.75C11 12.1656 11.3344 12.5 11.75 12.5C12.1656 12.5 12.5 12.1656 12.5 11.75V8.25Z" fill="currentColor"/></svg></a></article>`;
  }).join("")}</div></section>`;
}

let disposeGallery = () => {};

function renderProduct() {
  disposeGallery();
  const existingPanels = [...productRoot.querySelectorAll("details[data-panel]")];
  const openPanels = new Set(existingPanels.length ? existingPanels.filter(el => el.open).map(el => el.dataset.panel) : []);
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
    hasAnyBundleSelection() && subtotal > 0 && hasSizeSelection && allocationValid();
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
          <h3>Choose Quantity &amp; Price</h3><p class="product-quantity-intro">Select a bundle, then choose sizes in the panel below it.</p>
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
    ${renderProductIntro(product, {selectedImageIndex, openPanels, interactive: true})}
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
    ${renderRelatedProducts()}
    ${renderDetailsDialog()}
  `;
  initProductGallery();
}

function initProductGallery() {
  const track = productRoot.querySelector('.product-gallery__main');
  const dots = [...productRoot.querySelectorAll('[data-thumb-index]')];
  const count = dots.length;
  let timer;
  const update = () => dots.forEach((dot, index) => {
    dot.classList.toggle('is-active', index === selectedImageIndex);
    dot.setAttribute('aria-current', String(index === selectedImageIndex));
  });
  // Include the slide gutter and retain fractional widths when positioning slides.
  const slideStep = () => track.children[1].getBoundingClientRect().left - track.children[0].getBoundingClientRect().left;
  const jump = () => track.scrollTo({left: (selectedImageIndex + 1) * slideStep(), behavior: 'instant'});
  const settle = () => {
    if (!track.isConnected || !track.clientWidth) return;
    const slot = Math.round(track.scrollLeft / slideStep());
    selectedImageIndex = (slot - 1 + count) % count;
    update();
    if (slot === 0 || slot === count + 1) jump();
  };
  track.addEventListener('scroll', () => { clearTimeout(timer); timer = setTimeout(settle, 150); });
  track.addEventListener('scrollend', settle);
  track.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    track.scrollBy({left: slideStep() * (event.key === 'ArrowRight' ? 1 : -1), behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth'});
  });
  const resize = new ResizeObserver(jump);
  resize.observe(track);
  jump();
  update();
  disposeGallery = () => { clearTimeout(timer); resize.disconnect(); };
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

function handleSizeStep(channel, size, delta, bundleId) {
  bundleSubmitAttempted = false;
  if (isStorefrontGlobalOutOfStock(product) && delta > 0) {
    return;
  }
  if (delta > 0 && !isSizeChannelPurchasable(product, size, channel)) {
    return;
  }
  const bundle = product.bundles.find(b => b.id === bundleId);
  if (!bundle) return;
  const map = { ...(bundleSizes[bundleId] || {}) };
  const cur = Math.floor(map[size]) || 0;
  const req = (bundleQty[bundle.id] || 0) * bundle.units;
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

  bundleSizes[bundleId] = map;
  syncBundleSizes();
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
  if (action === "full-details") { openProductDetails(); return; }
  if (action === "close-details") { void closeProductDetails(); return; }
  if (action === "details-tab") { activateDetailsTab(target.dataset.tab); return; }


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
    handleSizeStep(channel, size, delta, target.dataset.bundleId);
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
    saveBundleSizes();
    const cartIcon = productRoot.querySelector('[data-action="add-to-cart"] .button__icon');
    if (cartIcon && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      cartIcon.getAnimations().forEach(animation => animation.cancel());
      cartIcon.animate([
        { transform: 'translateX(0) rotate(0deg)', offset: 0 },
        { transform: 'translateX(-3px) rotate(-14deg)', offset: .18 },
        { transform: 'translateX(3px) rotate(11deg)', offset: .38 },
        { transform: 'translateX(-2px) rotate(-7deg)', offset: .58 },
        { transform: 'translateX(1px) rotate(4deg)', offset: .78 },
        { transform: 'translateX(0) rotate(0deg)', offset: 1 }
      ], { duration: 480, easing: 'ease-out' });
    }
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
    saveBundleSizes();
    target.disabled = true;
    try {
      await continueToCheckout(store);
    } catch (error) {
      showToast(error.message, "error");
    } finally {
      target.disabled = false;
    }
  }
}
