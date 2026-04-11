import { formatCurrency, getProduct } from "./catalog.js";
import { getCart, setProductQuantities } from "./cart-store.js";
import { formatBundleCardSizeSummaryHtml, perBundleSummaryMap } from "./bundle-size-summary.js";
import { escapeHtml, initSite, showToast } from "./site.js";

const productRoot = document.querySelector("[data-product-detail]");
const currentUrl = new URL(window.location.href);
const slug = currentUrl.searchParams.get("slug");

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

document.addEventListener("DOMContentLoaded", init);

async function init() {
  store = await initSite({ page: "product" });
  product = await getProduct(slug);

  if (!product) {
    renderMissingProduct();
    return;
  }

  const sizes = store.site.sizes;
  const bundles = product.bundles || [];

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
  productRoot.addEventListener("click", handleProductClick);
  document.addEventListener("click", onClickOutsideOpenBundle, false);
}

/**
 * Restore Bundle & Price and Size & Quantity from the cart line for this slug (e.g. cart “Edit”).
 */
function hydrateProductStateFromCart() {
  const sizes = store.site.sizes;
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

/** Round-robin distribution of `total` units across `sizes` (used when bundle requirements change). */
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

/**
 * When box/case bundle counts change, re-fill only the affected channel so totals match
 * the new requirement. Size steppers never auto-adjust each other.
 */
function applyBundleRequirementDeltas(prevReq, nextReq, sizes) {
  if (nextReq.reqBox !== prevReq.reqBox) {
    boxBySize = defaultSpread(nextReq.reqBox, sizes);
  }
  if (nextReq.reqCase !== prevReq.reqCase) {
    caseBySize = defaultSpread(nextReq.reqCase, sizes);
  }
}

function applyBundleDelta(bundleId, delta) {
  bundleSubmitAttempted = false;
  const sizes = store.site.sizes;
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
  if ((bundleQty[bundleId] || 0) >= 1) {
    openBundleDropdownId = bundleId;
    return;
  }
  bundleSubmitAttempted = false;
  const sizes = store.site.sizes;
  const prevReq = computeRequiredUnits();
  bundleQty = { ...bundleQty, [bundleId]: 1 };
  openBundleDropdownId = bundleId;
  const nextReq = computeRequiredUnits();
  applyBundleRequirementDeltas(prevReq, nextReq, sizes);
}

function bundleSubtotalCents() {
  const bundles = product.bundles || [];
  let total = 0;
  for (const b of bundles) {
    const q = Math.floor(bundleQty[b.id] || 0);
    if (q < 1) {
      continue;
    }
    total += q * Math.max(0, Number(b.priceCents) || 0);
  }
  return total;
}

function bundleLinesPayload() {
  return Object.entries(bundleQty)
    .filter(([, q]) => q > 0)
    .map(([id, qty]) => ({ id, qty }));
}

function allocationValid() {
  const { reqBox, reqCase } = computeRequiredUnits();
  return sumChannel(boxBySize) === reqBox && sumChannel(caseBySize) === reqCase;
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
 */
function renderBundleCard(b, err) {
  const id = escapeHtml(b.id);
  const qty = Math.floor(bundleQty[b.id] || 0);
  const selected = qty > 0 ? " is-selected" : "";
  const badgePopular =
    String(b.badge || "").toLowerCase() === "popular"
      ? `<span class="bundle-card__badge bundle-card__badge--popular">Most popular🔥</span>`
      : "";
  const saveCents = Math.max(0, Number(b.saveCents) || 0);
  const badgeSave = saveCents
    ? `<span class="bundle-card__badge bundle-card__badge--save">Save ${formatCurrency(saveCents)}</span>`
    : "";

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
      panelInner = renderSizeColumn("Carton Bundle", "case", caseBySize, {
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

  const sizes = store.site.sizes;
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

  return `
    <div class="bundle-card${selected}" data-bundle-id="${id}">
      <div class="bundle-card__badges" aria-hidden="true">${badgePopular}${badgeSave}</div>
      <div class="bundle-card__row">
        <button type="button" class="bundle-card__main" data-action="bundle-select" data-bundle-id="${id}" aria-label="Select ${escapeHtml(b.label)}">
          <span class="bundle-card__title">${escapeHtml(b.label)}</span>
          <span class="bundle-card__price">${formatCurrency(b.priceCents)}/bundle</span>
        </button>
        <div class="bundle-card__stepper qty-control qty-control--round">
          <button type="button" data-action="bundle-decrease" data-bundle-id="${id}" aria-label="Decrease ${escapeHtml(b.label)} packs">−</button>
          <strong>${qty}</strong>
          <button type="button" data-action="bundle-increase" data-bundle-id="${id}" aria-label="Increase ${escapeHtml(b.label)} packs">+</button>
        </div>
      </div>
      ${collapsedSummaryBlock}
      ${expandBlock}
    </div>
  `;
}

function renderSizeColumn(title, channel, map, { invalid = false, hint = "", hideHeader = false } = {}) {
  const sizes = store.site.sizes;
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
          .map(
            (size) => `
          <div class="size-row">
            <span class="size-row__label">${escapeHtml(size)}</span>
            <div class="qty-control qty-control--round">
              <button type="button" data-action="size-step" data-channel="${channel}" data-size="${escapeHtml(size)}" data-delta="-1" aria-label="Decrease ${escapeHtml(size)} ${channel} count">−</button>
              <strong>${map[size] || 0}</strong>
              <button type="button" data-action="size-step" data-channel="${channel}" data-size="${escapeHtml(size)}" data-delta="1" aria-label="Increase ${escapeHtml(size)} ${channel} count"${
                plusDisabled ? " disabled" : ""
              }>+</button>
            </div>
          </div>
        `,
          )
          .join("")}
      </div>
    </div>
  `;
}

/** Gloves ship 100 pieces per box by weight; case size from `boxesPerCase` in catalog data. */
function casePackagingNote(product) {
  const boxes = Math.max(1, Math.floor(Number(product.boxesPerCase) || 10));
  const pieces = boxes * 100;
  const boxNoun = boxes === 1 ? "box" : "boxes";
  return `1 case contains ${boxes} ${boxNoun}, and each case totals ${pieces.toLocaleString("en-US")} pieces by weight.`;
}

function renderProduct() {
  const thumbIndexes = product.gallery.slice(0, 4).map((_, index) => index);
  const subtotal = bundleSubtotalCents();
  const bundles = product.bundles || [];
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
    ? `Total cases must equal ${reqUnits.reqCase} to match your bundle packs. Current: ${sumCases}.`
    : "";
  const hasSizeSelection = sumCases + sumBoxes > 0;
  const canClickActions =
    hasAnyBundleSelection() && subtotal > 0 && hasSizeSelection;

  const err = { showBoxError, showCaseError, boxHint, caseHint };
  const bundleSection =
    bundles.length > 0
      ? `
        <div class="detail-block detail-block--bundles">
          <h3>Bundle &amp; Price</h3>
          <div class="bundle-grid">
            ${bundles.map((b) => renderBundleCard(b, err)).join("")}
          </div>
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
                  <img src="${escapeHtml(product.gallery[index])}" alt="${escapeHtml(product.name)} image ${index + 1}" />
                </button>
              `,
            )
            .join("")}
        </div>

        <div class="product-gallery__main">
          <img src="${escapeHtml(product.gallery[selectedImageIndex])}" alt="${escapeHtml(product.name)} main image" />
        </div>
      </div>

      <div class="product-info">
        <h2>${escapeHtml(product.name)}</h2>
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

        <div class="selection-summary">
          <div class="selection-summary__subtotal-row">
            <span class="selection-summary__subtotal-label">Subtotal</span>
            <span class="selection-summary__subtotal-amount">${formatCurrency(subtotal)}</span>
          </div>
        </div>

        <div class="product-actions">
          <button class="button button--primary button--with-icon" type="button" data-action="add-to-cart" ${
            !canClickActions ? "disabled" : ""
          }>
            <img src="/img/cart-icon.svg" alt="" aria-hidden="true" class="button__icon" />
            <span>Add to cart</span>
          </button>
          <button
            class="button button--secondary"
            type="button"
            data-action="checkout"
            ${!canClickActions ? "disabled" : ""}
          >
            Go to checkout
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
    selectBundleCard(target.dataset.bundleId);
    renderProduct();
    return;
  }

  if (action === "bundle-increase") {
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
    if (!allocationValid()) {
      bundleSubmitAttempted = true;
      focusBundleForAllocationError();
      showToast(
        "Adjust box and case totals above to match your bundle packs before adding to cart.",
        "error",
      );
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
    const parts = [];
    const cb = sumChannel(caseBySize);
    const bb = sumChannel(boxBySize);
    if (cb) {
      parts.push(`${cb} case${cb === 1 ? "" : "s"}`);
    }
    if (bb) {
      parts.push(`${bb} box${bb === 1 ? "" : "es"}`);
    }
    showToast(`Added ${parts.join(" · ")} to your cart.`, "success");
    return;
  }

  if (action === "checkout") {
    if (!allocationValid()) {
      bundleSubmitAttempted = true;
      focusBundleForAllocationError();
      showToast(
        "Adjust box and case totals above to match your bundle packs before checkout.",
        "error",
      );
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
