import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.8";
import { formatCurrency } from "./catalog.js";
import { isBundleAllocationValid, requiredUnitsFromBundleLines } from "./bundle-validation.js";
import {
  clearAdminSessionUser,
  fetchReportPost,
  fetchSupabasePublicConfig,
  primeAdminSessionUser,
  renderAdminNav,
  shouldBootstrapAdminSignedIn,
} from "./admin-shared.js";

const US_STATES = [
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA", "HI", "ID", "IL", "IN", "IA", "KS", "KY",
  "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND",
  "OH", "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY", "DC",
];

let supabase = null;
let siteSizes = ["Small", "Medium", "Large", "X Large"];
let products = [];
/** @type {string | null} */
let lastCreatedOrderId = null;
/** @type {object | null} */
let lastQuote = null;

/**
 * @typedef {{ bundleQty: Record<string, number>, caseBySize: Record<string, number>, boxBySize: Record<string, number>, openBundleDropdownId: string | null }} ProductLineState
 */

/** @type {Record<string, ProductLineState>} */
let productState = {};

/** After failed estimate/save: show bundle/size mismatch styling (mirrors product page). */
let allocationSubmitAttempted = false;

function showLogin() {
  document.getElementById("admin-login").hidden = false;
  document.getElementById("admin-app").hidden = true;
}

function showApp() {
  document.getElementById("admin-login").hidden = true;
  document.getElementById("admin-app").hidden = false;
}

function readAddressFromForm(form) {
  return {
    line1: String(form.addr_line1?.value || "").trim(),
    line2: String(form.addr_line2?.value || "").trim(),
    city: String(form.addr_city?.value || "").trim(),
    state: String(form.addr_state?.value || "").trim().toUpperCase(),
    postalCode: String(form.addr_zip?.value || "").trim(),
    country: "US",
  };
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
  const st = productState[slug];
  if (nextReq.reqBox !== prevReq.reqBox) {
    st.boxBySize = defaultSpread(nextReq.reqBox, siteSizes);
  }
  if (nextReq.reqCase !== prevReq.reqCase) {
    st.caseBySize = defaultSpread(nextReq.reqCase, siteSizes);
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
    return isBundleAllocationValid(product, bundleLines, caseMap, boxMap, siteSizes);
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

    const hasCatalogBundles = Array.isArray(p.bundles) && p.bundles.length > 0;
    const bundleLines = bundleLinesPayload(st.bundleQty);
    const sumCase = sumChannel(st.caseBySize);
    const sumBox = sumChannel(st.boxBySize);

    if (!hasCatalogBundles) {
      const quantities = compactQuantities(st.caseBySize, siteSizes);
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
    items.push({
      slug: p.slug,
      bundleLines,
      quantities,
      boxQuantities,
    });
  }

  return { items, errors };
}

function formatChannelSizeSummaryHtml(map) {
  const segments = [];
  for (const size of siteSizes) {
    const q = Math.floor(Number(map[size])) || 0;
    if (q > 0) {
      segments.push(`${q} ${size}`);
    }
  }
  if (segments.length === 0) {
    return "";
  }
  return segments
    .map(
      (seg) =>
        `<span class="bundle-card__size-summary-seg">${escapeHtml(seg)}</span>`,
    )
    .join('<span class="bundle-card__size-summary-sep" aria-hidden="true">•</span>');
}

function productSummaryStatus(product) {
  const st = productState[product.slug];
  if (!st) {
    return "—";
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
            (size) => `
          <div class="size-row">
            <span class="size-row__label">${escapeHtml(size)}</span>
            <div class="qty-control qty-control--round">
              <button type="button" data-action="size-step" data-slug="${escapeHtml(product.slug)}" data-channel="${escapeHtml(channel)}" data-size="${escapeHtml(size)}" data-delta="-1" aria-label="Decrease ${escapeHtml(size)} ${channel} count">−</button>
              <strong>${map[size] || 0}</strong>
              <button type="button" data-action="size-step" data-slug="${escapeHtml(product.slug)}" data-channel="${escapeHtml(channel)}" data-size="${escapeHtml(size)}" data-delta="1" aria-label="Increase ${escapeHtml(size)} ${channel} count"${
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

function renderBundleCard(product, st, b, err) {
  const id = escapeHtml(b.id);
  const qty = Math.floor(st.bundleQty[b.id] || 0);
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
  const summaryHtml =
    mapForKind &&
    qty > 0 &&
    !showExpand &&
    ((kind === "box" && showBoxColumn(product, st.bundleQty)) ||
      (kind === "case" && showCaseColumn(product, st.bundleQty)))
      ? formatChannelSizeSummaryHtml(mapForKind)
      : "";
  const collapsedSummaryBlock =
    summaryHtml !== ""
      ? `<p class="bundle-card__size-summary">${summaryHtml}</p>`
      : "";

  return `
    <div class="bundle-card${selected}" data-bundle-id="${id}">
      <div class="bundle-card__badges" aria-hidden="true">${badgePopular}${badgeSave}</div>
      <div class="bundle-card__row">
        <button type="button" class="bundle-card__main" data-action="bundle-select" data-slug="${escapeHtml(product.slug)}" data-bundle-id="${id}" aria-label="Select ${escapeHtml(b.label)}">
          <span class="bundle-card__title">${escapeHtml(b.label)}</span>
          <span class="bundle-card__price">${formatCurrency(b.priceCents)}/bundle</span>
        </button>
        <div class="bundle-card__stepper qty-control qty-control--round">
          <button type="button" data-action="bundle-decrease" data-slug="${escapeHtml(product.slug)}" data-bundle-id="${id}" aria-label="Decrease ${escapeHtml(b.label)} packs">−</button>
          <strong>${qty}</strong>
          <button type="button" data-action="bundle-increase" data-slug="${escapeHtml(product.slug)}" data-bundle-id="${id}" aria-label="Increase ${escapeHtml(b.label)} packs">+</button>
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
        <p class="admin-muted manual-selection-note">Final merchandise total uses the same server rules as checkout (including Hardin tier when a promo code applies).</p>
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
      return `<label>${escapeHtml(sz)} cases <input type="number" min="0" step="1" name="${escapeHtml(nm)}" data-action="legacy-cases" data-slug="${escapeHtml(product.slug)}" data-size="${escapeHtml(sz)}" value="${v ? String(v) : ""}" /></label>`;
    })
    .join("");
  return `<div class="manual-product-sizes">${sizeFields}</div>`;
}

function renderProductBlock(product, index) {
  ensureProductState(product);
  const hasBundles = Array.isArray(product.bundles) && product.bundles.length > 0;
  const status = escapeHtml(productSummaryStatus(product));
  const issue = productHasAllocationIssue(product);
  const openAttr =
    allocationSubmitAttempted && issue ? " open" : index === 0 ? " open" : "";
  const invalidClass = allocationSubmitAttempted && issue ? " manual-product-details--warn" : "";

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
  wrap.innerHTML = products.map((p, i) => renderProductBlock(p, i)).join("");
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
    selectBundleCard(slug, t.dataset.bundleId);
    renderProductInputs();
    return;
  }
  if (action === "bundle-increase") {
    applyBundleDelta(slug, t.dataset.bundleId, 1);
    renderProductInputs();
    return;
  }
  if (action === "bundle-decrease") {
    applyBundleDelta(slug, t.dataset.bundleId, -1);
    renderProductInputs();
    return;
  }
  if (action === "size-step") {
    const delta = Number(t.dataset.delta) || 0;
    handleSizeStep(slug, t.dataset.channel, t.dataset.size, delta);
    renderProductInputs();
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
  if (!st) {
    return;
  }
  const n = Math.max(0, Math.floor(Number(t.value) || 0));
  st.caseBySize[size] = n;
}

function fillStateSelect() {
  const sel = document.getElementById("addr_state");
  if (!sel) {
    return;
  }
  sel.innerHTML = `<option value="">Select</option>${US_STATES.map((c) => `<option value="${c}">${c}</option>`).join("")}`;
}

async function getSessionToken() {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  return session?.access_token || null;
}

async function runEstimate() {
  const form = document.getElementById("manual-order-form");
  const errEl = document.getElementById("admin-load-error");
  errEl.hidden = true;

  const { items, errors } = buildItemsFromState();
  if (errors.length) {
    allocationSubmitAttempted = true;
    renderProductInputs();
    errEl.textContent = errors.join("\n");
    errEl.hidden = false;
    return null;
  }

  if (!items.length) {
    errEl.textContent = "Add at least one product line (bundles + matching sizes, or legacy case counts).";
    errEl.hidden = false;
    return null;
  }

  allocationSubmitAttempted = false;
  renderProductInputs();

  const address = readAddressFromForm(form);
  const discountCode = String(form.discount_code?.value || "").trim();

  const token = await getSessionToken();
  if (!token) {
    errEl.textContent = "Sign in again.";
    errEl.hidden = false;
    return null;
  }

  const body = { items, address, discountCode };
  const data = await fetchReportPost("/api/admin-manual-order-estimate", token, body);
  lastQuote = data;

  const preview = document.getElementById("manual-preview");
  const pre = document.getElementById("manual-preview-body");
  const lines = [
    `Merchandise: ${data.originalMerchandiseSubtotalFormatted || data.subtotalFormatted}`,
  ];
  if (data.merchandiseDiscountFormatted && Number(data.merchandiseDiscountCents) > 0) {
    lines.push(`Discount: −${data.merchandiseDiscountFormatted}`);
  }
  lines.push(
    `Shipping: ${data.shippingCents === 0 ? "Free" : data.shippingFormatted}`,
    `Tax: ${data.taxFormatted}`,
    `Total: ${data.totalFormatted}`,
  );
  if (Array.isArray(data.warnings) && data.warnings.length) {
    lines.push("", ...data.warnings.map((w) => `Note: ${w}`));
  }
  pre.textContent = lines.join("\n");
  preview.hidden = false;

  return data;
}

async function saveDraft() {
  const form = document.getElementById("manual-order-form");
  const errEl = document.getElementById("admin-load-error");
  errEl.hidden = true;

  const { items, errors } = buildItemsFromState();
  if (errors.length) {
    allocationSubmitAttempted = true;
    renderProductInputs();
    errEl.textContent = errors.join("\n");
    errEl.hidden = false;
    return;
  }

  if (!items.length) {
    errEl.textContent = "Add at least one product line before saving.";
    errEl.hidden = false;
    return;
  }

  allocationSubmitAttempted = false;
  renderProductInputs();

  const address = readAddressFromForm(form);
  const token = await getSessionToken();
  if (!token) {
    errEl.textContent = "Sign in again.";
    errEl.hidden = false;
    return;
  }

  const body = {
    name: String(form.cust_name?.value || "").trim(),
    email: String(form.cust_email?.value || "").trim(),
    phone: String(form.cust_phone?.value || "").trim(),
    address,
    items,
    discountCode: String(form.discount_code?.value || "").trim(),
  };

  const data = await fetchReportPost("/api/admin-manual-order-create", token, body);
  lastCreatedOrderId = data.orderId;
  document.getElementById("btn-send-link").disabled = false;

  const resEl = document.getElementById("manual-result");
  const textEl = document.getElementById("manual-result-text");
  textEl.textContent = `Reference ${data.orderRef} · Total ${data.totalFormatted}\nYou can now send the payment link email to the customer.`;
  resEl.hidden = false;
}

async function sendPaymentLink() {
  const errEl = document.getElementById("admin-load-error");
  errEl.hidden = true;
  if (!lastCreatedOrderId) {
    errEl.textContent = "Save a draft order first.";
    errEl.hidden = false;
    return;
  }
  const token = await getSessionToken();
  if (!token) {
    errEl.textContent = "Sign in again.";
    errEl.hidden = false;
    return;
  }

  const btn = document.getElementById("btn-send-link");
  btn.disabled = true;
  try {
    const data = await fetchReportPost("/api/admin-manual-order-send-link", token, {
      orderId: lastCreatedOrderId,
    });
    const msg = data.warning || (data.emailed ? "Payment link emailed to the customer." : "Done.");
    document.getElementById("manual-result-text").textContent += `\n\n${msg}`;
    if (data.checkoutUrl && data.warning) {
      document.getElementById("manual-result-text").textContent += `\n\nLink: ${data.checkoutUrl}`;
    }
  } catch (e) {
    errEl.textContent = e.message || "Failed to send link.";
    errEl.hidden = false;
  } finally {
    btn.disabled = false;
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

async function init() {
  let config;
  try {
    config = await fetchSupabasePublicConfig();
  } catch (e) {
    document.getElementById("admin-load-error").textContent =
      e.message || "Add SUPABASE_URL and SUPABASE_ANON_KEY to the server environment.";
    document.getElementById("admin-load-error").hidden = false;
    showLogin();
    document.getElementById("login-form").style.display = "none";
    return;
  }

  supabase = createClient(config.supabaseUrl, config.supabaseAnonKey, {
    auth: { persistSession: true, autoRefreshToken: true },
  });

  fillStateSelect();

  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (session?.user) {
    primeAdminSessionUser(session);
    showApp();
    document.getElementById("admin-user-email").textContent = session.user.email || "";
    renderAdminNav("manual-order");
    await loadProducts();
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
      renderAdminNav("manual-order");
      await loadProducts();
    }
    if (event === "SIGNED_OUT") {
      clearAdminSessionUser();
      showLogin();
    }
  });

  document.getElementById("login-form")?.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const errEl = document.getElementById("login-error");
    errEl.hidden = true;
    const fd = new FormData(ev.target);
    const email = String(fd.get("email") || "").trim();
    const password = String(fd.get("password") || "");
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      errEl.textContent = error.message;
      errEl.hidden = false;
      return;
    }
    const { data: afterLogin } = await supabase.auth.getSession();
    primeAdminSessionUser(afterLogin.session);
    showApp();
    document.getElementById("admin-user-email").textContent = email;
    renderAdminNav("manual-order");
    await loadProducts();
  });

  document.getElementById("admin-logout")?.addEventListener("click", async () => {
    await supabase.auth.signOut();
  });

  const manualRoot = document.getElementById("manual-products");
  manualRoot?.addEventListener("click", onManualProductsClick);
  manualRoot?.addEventListener("input", onManualProductsInput);
  document.addEventListener("click", onDocumentClickBundles, false);

  document.getElementById("btn-estimate")?.addEventListener("click", async () => {
    const btn = document.getElementById("btn-estimate");
    btn.disabled = true;
    try {
      await runEstimate();
    } catch (e) {
      const errEl = document.getElementById("admin-load-error");
      errEl.textContent = e.message || "Estimate failed.";
      errEl.hidden = false;
    } finally {
      btn.disabled = false;
    }
  });

  document.getElementById("btn-save-draft")?.addEventListener("click", async () => {
    const btn = document.getElementById("btn-save-draft");
    btn.disabled = true;
    try {
      await saveDraft();
    } catch (e) {
      const errEl = document.getElementById("admin-load-error");
      errEl.textContent = e.message || "Could not save.";
      errEl.hidden = false;
    } finally {
      btn.disabled = false;
    }
  });

  document.getElementById("btn-send-link")?.addEventListener("click", () => void sendPaymentLink());
}

init();
