/*
 * SAI Goods admin-v2 — Walk-in Order (Phase W0–W4: estimate + unpaid drafts + mark-paid + quick-pay).
 *
 * Connected:
 *   - GET  /api/products
 *   - POST /api/admin-walk-in-order-estimate
 *   - GET  /api/admin-walk-in-order-drafts        (list + ?id= for open/enrich)
 *   - POST /api/admin-walk-in-order-create
 *   - POST /api/admin-walk-in-order-update-draft
 *   - POST /api/admin-walk-in-order-delete-draft
 *   - POST /api/admin-walk-in-order-mark-paid
 *   - POST /api/admin-walk-in-order-quick-pay
 *
 * NOT connected: handoff, frontend inventory APIs, Square/payment-link.
 *
 * Does not import from admin-manual-order.js — product helpers are duplicated inline.
 */

import { formatCurrency } from "../catalog.js";
import { isBundleAllocationValid, requiredUnitsFromBundleLines } from "../bundle-validation.js";
import {
  inventoryAllowsAllocations,
  isProductStorefrontOutOfStock,
  isSizeChannelPurchasable,
} from "../size-availability.js";
import { fetchReportJson, fetchReportPost, ReportPostError } from "../admin-shared.js";
import { card, closeDrawer, escapeHtml, icon, openDrawer, pageHeader, statusChip, toast } from "./ui.js";
import { bootAdminV2Page } from "./page-boot.js";

const CREATE_DRAFT_PHRASE = "CREATE DRAFT";
const UPDATE_DRAFT_PHRASE = "UPDATE DRAFT";
const DELETE_DRAFT_PHRASE = "DELETE DRAFT";
const MARK_PAID_PHRASE = "MARK PAID";
const CHARGE_WALK_IN_PHRASE = "CHARGE WALK-IN";

/** @type {() => Promise<string|undefined>} */
let getToken = async () => undefined;

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
let estimateInFlight = false;

/** @type {string|null} */
let editingOrderId = null;
/** @type {string|null} */
let editingOrderRef = null;
/** @type {object|null} */
let editingOrderMeta = null; // full loaded draft row
/** Fingerprint of last saved draft form (customer + discount + items). */
let savedDraftFingerprint = null;
let createDraftInFlight = false;
let updateDraftInFlight = false;
let deleteDraftInFlight = false;
let markPaidInFlight = false;
let quickPayInFlight = false;

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

function isWalkInProductOutOfStock(product) {
  return isProductStorefrontOutOfStock(product, supportedSizesForProduct(product));
}

function isWalkInSizeOutOfStock(product, size, channel = "case") {
  return !isSizeChannelPurchasable(product, size, channel);
}

function productStockChip(product) {
  if (isWalkInProductOutOfStock(product)) return statusChip("Out of stock", "danger");
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
      const blocked = Object.keys(quantities).filter((size) => isWalkInSizeOutOfStock(p, size, "case"));
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
        (Math.floor(Number(quantities[size]) || 0) > 0 && isWalkInSizeOutOfStock(p, size, "case")) ||
        (Math.floor(Number(boxQuantities[size]) || 0) > 0 && isWalkInSizeOutOfStock(p, size, "box")),
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
  if (!product || isWalkInProductOutOfStock(product)) return;
  ensureProductState(product);
  const st = productState[slug];
  const prevReq = computeRequiredUnits(product, st.bundleQty);
  const next = Math.max(0, Math.floor(Number(st.bundleQty[bundleId]) || 0) + delta);
  st.bundleQty[bundleId] = next;
  const nextReq = computeRequiredUnits(product, st.bundleQty);
  applyBundleRequirementDeltas(slug, prevReq, nextReq);
  markEstimateStale();
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
  const oos = isWalkInSizeOutOfStock(product, size, channel);

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
  markEstimateStale();
  renderProducts();
}

/* --------------------------------------------------------------- form reads */

function readCustomer() {
  return {
    name: String(getEl("wi-cust-name")?.value || "").trim(),
    email: String(getEl("wi-cust-email")?.value || "").trim(),
    phone: String(getEl("wi-cust-phone")?.value || "").trim(),
  };
}

function readApplyLocalDiscount() {
  return getEl("wi-apply-discount")?.checked === true;
}

function normalizeQtyMap(map) {
  const out = {};
  for (const [k, v] of Object.entries(map || {})) {
    const n = Math.floor(Number(v) || 0);
    if (n > 0) out[String(k)] = n;
  }
  return out;
}

function normalizeItemsFingerprint(items) {
  return (items || [])
    .map((it) => ({
      slug: String(it?.slug || ""),
      bundleLines: (Array.isArray(it?.bundleLines) ? it.bundleLines : [])
        .map((b) => ({
          id: String(b?.id || ""),
          qty: Math.floor(Number(b?.qty) || 0),
        }))
        .filter((b) => b.id && b.qty > 0)
        .sort((a, b) => a.id.localeCompare(b.id)),
      quantities: normalizeQtyMap(it?.quantities),
      boxQuantities: normalizeQtyMap(it?.boxQuantities),
    }))
    .filter(
      (it) =>
        it.slug &&
        (it.bundleLines.length ||
          Object.keys(it.quantities).length ||
          Object.keys(it.boxQuantities).length),
    )
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

/** Raw product-state items (ignores allocation validity) for dirty-form compare. */
function liveItemsFromProductState() {
  const items = [];
  for (const p of products) {
    const st = productState[p.slug];
    if (!st) continue;
    const bundleLines = Object.entries(st.bundleQty || {})
      .map(([id, qty]) => ({ id: String(id), qty: Math.floor(Number(qty) || 0) }))
      .filter((b) => b.qty > 0);
    const quantities = normalizeQtyMap(st.caseBySize);
    const boxQuantities = normalizeQtyMap(st.boxBySize);
    if (!bundleLines.length && !Object.keys(quantities).length && !Object.keys(boxQuantities).length) {
      continue;
    }
    items.push({ slug: p.slug, bundleLines, quantities, boxQuantities });
  }
  return items;
}

function draftFormFingerprint({ name, email, phone, applyEligibleLocalDiscount, items }) {
  return JSON.stringify({
    name: String(name || "").trim(),
    email: String(email || "").trim().toLowerCase(),
    phone: String(phone || "").trim().replace(/\D/g, ""),
    applyEligibleLocalDiscount: Boolean(applyEligibleLocalDiscount),
    items: normalizeItemsFingerprint(items),
  });
}

function liveDraftFingerprint() {
  const cust = readCustomer();
  return draftFormFingerprint({
    name: cust.name,
    email: cust.email,
    phone: cust.phone,
    applyEligibleLocalDiscount: readApplyLocalDiscount(),
    items: liveItemsFromProductState(),
  });
}

function isEditingDraftDirty() {
  if (!editingOrderId || !editingOrderMeta || savedDraftFingerprint == null) return false;
  return liveDraftFingerprint() !== savedDraftFingerprint;
}

function setPanelVisible(el, visible) {
  if (!el) return;
  el.classList.toggle("sg-hide", !visible);
  el.hidden = !visible;
}

function setQuoteStaleMessage(text) {
  const stale = getEl("wi-quote-stale");
  if (!stale) return;
  const span = stale.querySelector("span");
  if (span) {
    span.textContent =
      text || "Inputs changed since the last quote. Recalculate before relying on these totals.";
  }
}

function markEstimateStale() {
  if (!lastQuote) {
    syncEstimateButtonState();
    return;
  }
  estimateStale = true;
  setQuoteStaleMessage();
  setPanelVisible(getEl("wi-quote-stale"), true);
  syncEstimateButtonState();
}

/* --------------------------------------------------------------- quote view */

function taxSourceLabel(source) {
  const s = String(source || "").trim();
  if (s === "tn" || s === "tn_zero") return "TN sales tax";
  if (s === "no_nexus") return "No nexus / not collected";
  if (!s) return "TN sales tax";
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
      shippingStatus: String(data?.shipping?.quoteStatus || "").trim() || "included_in_merchandise",
      shippingFormatted: data?.shipping?.amountFormatted || "—",
      taxFormatted: data?.tax?.amountFormatted || data?.taxFormatted || "—",
      taxSource: data?.tax?.source || data?.taxSource || "",
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
    taxFormatted: data?.taxFormatted || "—",
    taxSource: data?.taxSource || "",
    totalFormatted: data?.totalFormatted || "—",
    warnings: Array.isArray(data?.warnings) ? data.warnings : [],
    userFacingError: null,
    canCheckout: true,
  };
}

function shippingDisplayLabel(v) {
  if (v?.shippingStatus === "included_in_merchandise" || v?.shippingStatus === "not_requested") {
    return "Included / pickup";
  }
  if (v?.shippingStatus === "rated" && v.shippingFormatted) {
    return `${v.shippingFormatted} (pickup)`;
  }
  return "Included / pickup";
}

/* --------------------------------------------------------------- product render */

function unitWord(kind, n) {
  const isBox = String(kind || "case").toLowerCase() === "box";
  if (Math.abs(n) === 1) return isBox ? "box" : "case";
  return isBox ? "boxes" : "cases";
}

function sizeStockChip(product, size, channel) {
  if (isWalkInSizeOutOfStock(product, size, channel)) return statusChip("Out of stock", "danger");
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
      (Math.floor(Number(quantities[size]) || 0) > 0 && isWalkInSizeOutOfStock(product, size, "case")) ||
      (Math.floor(Number(boxQuantities[size]) || 0) > 0 && isWalkInSizeOutOfStock(product, size, "box")),
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

/**
 * Estimate-only eligibility. Does not require payment method, receipt, draft, or existing quote.
 * Email and phone are optional; when set they must be valid.
 * @returns {{ ok: boolean, blockers: { id: string, message: string, focus: string }[], items: object[] }}
 */
function estimateEligibility() {
  /** @type {{ id: string, message: string, focus: string }[]} */
  const blockers = [];
  const cust = readCustomer();

  if (!cust.name) {
    blockers.push({ id: "cust-name", message: "Add customer full name", focus: "wi-cust-name" });
  }
  if (cust.email && !cust.email.includes("@")) {
    blockers.push({
      id: "cust-email",
      message: "Enter a valid email (must include @) or clear the field",
      focus: "wi-cust-email",
    });
  }
  if (cust.phone) {
    const digits = cust.phone.replace(/\D/g, "");
    if (digits.length < 10) {
      blockers.push({
        id: "cust-phone",
        message: "Enter a valid phone (at least 10 digits) or clear the field",
        focus: "wi-cust-phone",
      });
    }
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
      blockers.push({ id: `item-${err}`, message: err, focus: "wi-products" });
    }
  }
  if (!items.length && !blockers.some((b) => b.focus.startsWith("product:") || b.id.startsWith("product-"))) {
    blockers.push({
      id: "items",
      message: "Add at least one product package quantity",
      focus: "wi-products",
    });
  }

  return { ok: blockers.length === 0 && items.length > 0, blockers, items };
}

/**
 * Create/update unpaid walk-in draft eligibility (same bar as create).
 * @returns {{ ok: boolean, reason: string, items: object[] }}
 */
function draftSaveEligibility() {
  const cust = readCustomer();
  if (!cust.name) return { ok: false, reason: "Add customer full name", items: [] };
  if (cust.email && !cust.email.includes("@")) {
    return { ok: false, reason: "Enter a valid email (must include @) or clear the field", items: [] };
  }
  if (cust.phone) {
    const digits = cust.phone.replace(/\D/g, "");
    if (digits.length < 10) {
      return {
        ok: false,
        reason: "Enter a valid phone (at least 10 digits) or clear the field",
        items: [],
      };
    }
  }

  for (const p of products) {
    const issues = productAllocationIssues(p);
    if (issues.length) return { ok: false, reason: issues[0].message, items: [] };
  }

  const { items, errors: itemErrors } = buildItemsFromState();
  if (itemErrors.length) return { ok: false, reason: itemErrors[0], items: [] };
  if (!items.length) return { ok: false, reason: "Add at least one product package quantity", items: [] };

  if (!lastQuote) {
    return { ok: false, reason: "Calculate totals before saving a draft", items };
  }
  if (estimateStale) {
    return { ok: false, reason: "Quote is stale. Recalculate totals before saving", items };
  }
  if (lastQuote.canCheckout === false) {
    return {
      ok: false,
      reason: "Quote is not ready for checkout. Resolve estimate issues and recalculate",
      items,
    };
  }

  return { ok: true, reason: "", items };
}

/**
 * Quick-pay eligibility for a new walk-in order (create + pay in one step).
 * Reuses draftSaveEligibility core, then blocks editing drafts and requires email when receipt is checked.
 * @returns {{ ok: boolean, reason: string, items: object[] }}
 */
function quickPayEligibility() {
  if (editingOrderId) {
    return {
      ok: false,
      reason: "Quick-pay is for new orders. Use Mark paid on an open draft.",
      items: [],
    };
  }

  const base = draftSaveEligibility();
  if (!base.ok) return base;

  if (readQuickSendReceipt()) {
    const email = readCustomer().email;
    if (!email || !email.includes("@")) {
      return {
        ok: false,
        reason: "Add a customer email to send a receipt.",
        items: base.items,
      };
    }
  }

  return { ok: true, reason: "", items: base.items };
}

function readPaymentMethod() {
  return String(document.querySelector('input[name="wi_pay_method"]:checked')?.value || "")
    .trim()
    .toLowerCase();
}

function readSendReceipt() {
  return getEl("wi-send-receipt")?.checked === true;
}

function readQuickSendReceipt() {
  return getEl("wi-quick-receipt")?.checked === true;
}

function resetPaymentUi() {
  const cash = document.querySelector('input[name="wi_pay_method"][value="cash"]');
  if (cash instanceof HTMLInputElement) cash.checked = true;
  const receipt = getEl("wi-send-receipt");
  if (receipt instanceof HTMLInputElement) receipt.checked = false;
  const hint = getEl("wi-receipt-hint");
  if (hint) {
    hint.textContent = "";
    setPanelVisible(hint, false);
  }
  const quickReceipt = getEl("wi-quick-receipt");
  if (quickReceipt instanceof HTMLInputElement) quickReceipt.checked = false;
  const quickHint = getEl("wi-quick-receipt-hint");
  if (quickHint) {
    quickHint.textContent = "";
    setPanelVisible(quickHint, false);
  }
}

/**
 * Mark-paid eligibility for an already-saved walk-in draft (no fresh quote required).
 * @returns {{ ok: boolean, reason: string }}
 */
function markPaidEligibility() {
  if (!editingOrderId || !editingOrderMeta) {
    return { ok: false, reason: "Open a walk-in draft to collect payment." };
  }
  if (String(editingOrderMeta.order_source) !== "walk_in") {
    return { ok: false, reason: "Only walk-in drafts can be marked paid here." };
  }
  if (String(editingOrderMeta.order_status) !== "draft") {
    return { ok: false, reason: "Only draft walk-in orders can be marked paid." };
  }
  if (String(editingOrderMeta.status) === "paid") {
    return { ok: false, reason: "This order is already paid." };
  }
  if (isEditingDraftDirty()) {
    return {
      ok: false,
      reason: "Save or discard changes before marking this draft paid.",
    };
  }

  for (const p of products) {
    const issues = productAllocationIssues(p);
    if (issues.length) {
      return { ok: false, reason: `${issues[0].message}. Fix allocation or revert before marking paid.` };
    }
  }
  const { errors: itemErrors } = buildItemsFromState();
  if (itemErrors.length) {
    return { ok: false, reason: `${itemErrors[0]}. Fix items or revert before marking paid.` };
  }

  const method = readPaymentMethod();
  if (method !== "cash" && method !== "check") {
    return { ok: false, reason: "Select cash or check." };
  }

  if (readSendReceipt()) {
    const savedEmail = String(editingOrderMeta.customer_email || "").trim();
    if (!savedEmail || !savedEmail.includes("@")) {
      return {
        ok: false,
        reason: "Saved draft has no customer email. Update the draft with an email, or uncheck receipt.",
      };
    }
  }

  return { ok: true, reason: "" };
}

function syncPaymentPanel() {
  const el = getEl("wi-payment-card");
  if (!el) return;
  const visible =
    Boolean(editingOrderId) &&
    Boolean(editingOrderMeta) &&
    String(editingOrderMeta.order_source) === "walk_in" &&
    String(editingOrderMeta.order_status) === "draft" &&
    String(editingOrderMeta.status) !== "paid";
  setPanelVisible(el, visible);
}

function syncDirtyGuardPanel() {
  const el = getEl("wi-dirty-guard");
  if (!el) return;
  const dirty =
    Boolean(editingOrderId) &&
    Boolean(editingOrderMeta) &&
    String(editingOrderMeta.order_status) === "draft" &&
    String(editingOrderMeta.status) !== "paid" &&
    isEditingDraftDirty();
  setPanelVisible(el, dirty);
}

function syncMarkPaidButtonState() {
  syncPaymentPanel();
  syncDirtyGuardPanel();
  const btn = getEl("wi-mark-paid-btn");
  const hint = getEl("wi-receipt-hint");
  const elig = markPaidEligibility();
  const dirty = isEditingDraftDirty();
  const inFlight =
    markPaidInFlight ||
    quickPayInFlight ||
    createDraftInFlight ||
    updateDraftInFlight ||
    deleteDraftInFlight ||
    estimateInFlight;

  if (hint) {
    if (dirty) {
      hint.textContent =
        "Receipt uses the saved draft customer email. Save or discard changes before marking paid.";
      setPanelVisible(hint, true);
    } else if (readSendReceipt()) {
      const savedEmail = String(editingOrderMeta?.customer_email || "").trim();
      if (!savedEmail || !savedEmail.includes("@")) {
        hint.textContent =
          "Saved draft has no customer email. Update the draft with an email to send a receipt.";
        setPanelVisible(hint, true);
      } else {
        hint.textContent = `Receipt will use the saved draft email (${savedEmail}).`;
        setPanelVisible(hint, true);
      }
    } else {
      hint.textContent = "Receipt uses the saved draft customer email when enabled.";
      setPanelVisible(hint, Boolean(editingOrderId));
    }
  }

  if (!btn) return;
  const enable = elig.ok && !inFlight;
  btn.disabled = !enable;
  btn.title = enable
    ? "Record cash/check payment for this draft."
    : elig.reason || (inFlight ? "Working…" : "Not ready to mark paid.");
  btn.classList.toggle("sg-btn--primary", enable);
  btn.classList.toggle("mo-btn-deferred", !enable);
}

function syncQuickPayPanel() {
  const el = getEl("wi-quick-pay-block");
  if (!el) return;
  setPanelVisible(el, !editingOrderId);
}

function syncQuickPayButtonState() {
  syncQuickPayPanel();
  const cashBtn = getEl("wi-charge-cash");
  const checkBtn = getEl("wi-charge-check");
  const hint = getEl("wi-quick-receipt-hint");
  const elig = quickPayEligibility();
  const inFlight =
    quickPayInFlight ||
    createDraftInFlight ||
    updateDraftInFlight ||
    deleteDraftInFlight ||
    markPaidInFlight ||
    estimateInFlight;

  if (hint) {
    const needEmail = readQuickSendReceipt() && !String(readCustomer().email || "").includes("@");
    if (needEmail) {
      hint.textContent = "Add a customer email to send a receipt.";
      setPanelVisible(hint, true);
    } else {
      hint.textContent = "";
      setPanelVisible(hint, false);
    }
  }

  const enable = elig.ok && !inFlight;
  const title = enable
    ? "Create the walk-in order and record payment in one step."
    : elig.reason || (inFlight ? "Working…" : "Not ready to charge.");

  for (const btn of [cashBtn, checkBtn]) {
    if (!btn) continue;
    btn.disabled = !enable;
    btn.title = title;
    btn.classList.toggle("sg-btn--primary", enable);
    btn.classList.toggle("mo-btn-deferred", !enable);
  }
}

function syncDraftSaveButtonState() {
  const btn = getEl("wi-save-draft-btn");
  const helper = getEl("wi-save-helper");
  const editing = Boolean(editingOrderId);
  const label = editing ? "Update walk-in draft" : "Create unpaid walk-in order";
  const inFlight =
    createDraftInFlight ||
    updateDraftInFlight ||
    deleteDraftInFlight ||
    estimateInFlight ||
    markPaidInFlight ||
    quickPayInFlight;
  const laterNote = editing
    ? "Use Mark paid on this draft to record cash or check payment."
    : "Or use Charge cash/check to create and pay in one step.";

  if (btn) {
    btn.textContent = label;
    if (inFlight) {
      btn.disabled = true;
      btn.classList.remove("sg-btn--primary");
      btn.classList.add("mo-btn-deferred");
    } else {
      const elig = draftSaveEligibility();
      btn.disabled = !elig.ok;
      btn.title = elig.ok
        ? editing
          ? "Update this unpaid walk-in draft."
          : "Create an unpaid walk-in draft (no payment recorded)."
        : elig.reason || "Not ready to save a draft.";
      btn.classList.toggle("sg-btn--primary", elig.ok);
      btn.classList.toggle("mo-btn-deferred", !elig.ok);
    }
  }

  if (helper) {
    if (inFlight) {
      helper.textContent = editing
        ? "Updating draft…"
        : quickPayInFlight
          ? "Charging…"
          : "Creating draft…";
    } else {
      const elig = draftSaveEligibility();
      if (elig.ok) {
        helper.textContent = editing
          ? `Ready to update this unpaid walk-in draft. ${laterNote}`
          : `Ready to create an unpaid walk-in draft. ${laterNote}`;
      } else {
        helper.textContent = elig.reason
          ? `${elig.reason}. ${laterNote}`
          : `Complete the form and calculate totals to save a draft. ${laterNote}`;
      }
    }
  }

  syncMarkPaidButtonState();
  syncQuickPayButtonState();
}

function renderEstimateChecklist(blockers) {
  const host = getEl("wi-estimate-checklist");
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
    const cardEl = document.querySelector(`[data-product-slug="${CSS.escape(slug)}"]`);
    cardEl?.classList.add("is-attention");
    cardEl?.scrollIntoView({ behavior: "smooth", block: "center" });
    setTimeout(() => cardEl?.classList.remove("is-attention"), 2400);
    return;
  }
  if (focus === "wi-products") {
    getEl("wi-products")?.scrollIntoView({ behavior: "smooth", block: "center" });
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
  const btn = getEl("wi-estimate-btn");
  const wrap = getEl("wi-estimate-wrap");
  const hit = getEl("wi-estimate-hit");
  const elig = estimateEligibility();
  renderEstimateChecklist(elig.ok ? [] : elig.blockers);
  if (wrap) wrap.classList.toggle("is-blocked", !elig.ok);
  if (hit) setPanelVisible(hit, !elig.ok && !estimateInFlight);
  if (btn && !estimateInFlight) {
    btn.disabled = !elig.ok;
    btn.title = elig.ok
      ? "Calculate merchandise, tax, and discounts for this walk-in order."
      : "Fix the items below, then calculate.";
  }
  syncDraftSaveButtonState();
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
          const oos = isWalkInSizeOutOfStock(product, size, channel);
          const plusDisabled = req < 1 || assigned >= req || oos;
          const minusDisabled = qty < 1;
          return `<div class="mo-size-row${oos ? " is-oos" : ""}${oos && qty > 0 ? " has-invalid-qty" : ""}">
            <div class="mo-size-row__meta">
              <span class="mo-size-row__label">${escapeHtml(size)}</span>
              ${sizeStockChip(product, size, channel)}
            </div>
            <div class="mo-qty">
              <button type="button" class="sg-btn sg-btn--ghost sg-btn--sm mo-qty__btn" data-wi-size-step data-slug="${escapeHtml(product.slug)}" data-channel="${escapeHtml(channel)}" data-size="${escapeHtml(size)}" data-delta="-1" ${minusDisabled ? "disabled" : ""} aria-label="Decrease ${escapeHtml(size)}">−</button>
              <strong class="mo-qty__value">${qty}</strong>
              <button type="button" class="sg-btn sg-btn--ghost sg-btn--sm mo-qty__btn" data-wi-size-step data-slug="${escapeHtml(product.slug)}" data-channel="${escapeHtml(channel)}" data-size="${escapeHtml(size)}" data-delta="1" ${plusDisabled ? "disabled" : ""} aria-label="Increase ${escapeHtml(size)}">+</button>
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
          <button type="button" class="sg-btn sg-btn--ghost sg-btn--sm mo-qty__btn" data-wi-bundle-step data-slug="${escapeHtml(product.slug)}" data-bundle="${escapeHtml(b.id)}" data-delta="-1" ${oos || qty < 1 ? "disabled" : ""} aria-label="Decrease ${escapeHtml(label)}">−</button>
          <strong class="mo-qty__value">${qty}</strong>
          <button type="button" class="sg-btn sg-btn--ghost sg-btn--sm mo-qty__btn" data-wi-bundle-step data-slug="${escapeHtml(product.slug)}" data-bundle="${escapeHtml(b.id)}" data-delta="1" ${oos ? "disabled" : ""} aria-label="Increase ${escapeHtml(label)}">+</button>
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

  const allComplete =
    warnParts.length === 0 &&
    safeIsBundleAllocationValid(
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
  const oos = isWalkInProductOutOfStock(product);

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
    <button type="button" class="mo-product__toggle" data-wi-toggle-product="${escapeHtml(product.slug)}">
      <span class="mo-product__title">${escapeHtml(product.name || product.slug)}</span>
      ${productStockChip(product)}
      <span class="sg-muted">${open ? "Hide" : "Add"}</span>
    </button>
    ${body}
  </div>`;
}

function renderProducts() {
  const host = getEl("wi-products");
  if (!host) return;
  if (!products.length) {
    host.innerHTML = `<p class="sg-muted">No products loaded.</p>`;
    syncEstimateButtonState();
    return;
  }
  host.innerHTML = products.map((p) => renderProductCard(p)).join("");
  syncEstimateButtonState();
}

function renderQuotePreview(data) {
  const host = getEl("wi-quote-body");
  const stale = getEl("wi-quote-stale");
  if (!host) return;
  if (!data) {
    host.innerHTML = `<p class="sg-muted" style="margin:0">Run Calculate totals to preview merchandise, tax, and discounts.</p>`;
    setPanelVisible(stale, false);
    setQuoteStaleMessage();
    return;
  }
  const v = quoteView(data);
  const discountLine = v.discountFormatted
    ? `<div class="mo-quote-row"><span>Discount</span><strong>−${escapeHtml(v.discountFormatted)}</strong></div>`
    : "";

  const hardinBits = [];
  if (data.hardinDiscountApplied) hardinBits.push(statusChip("Local discount applied", "success"));
  if (data.adminLocalDiscountForced) hardinBits.push(statusChip("Staff override", "warning"));
  if (data.adminLocalDiscountNeedsOverride && !data.hardinDiscountApplied) {
    hardinBits.push(statusChip("Not eligible", "warning"));
  }
  if (data.adminLocalDiscountDeclined) hardinBits.push(statusChip("Declined by ZIP", "neutral"));

  const warnings = (v.warnings || [])
    .map(
      (w) =>
        `<div class="sg-inline-warn" style="margin-top:8px">${icon("alert-triangle", 14)}<span>${escapeHtml(String(w))}</span></div>`,
    )
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
      <div class="mo-quote-row"><span>Shipping</span><span>${escapeHtml(shippingDisplayLabel(v))}</span></div>
      <div class="mo-quote-row"><span>Tax</span><strong>${escapeHtml(v.taxFormatted)}</strong></div>
      <div class="mo-quote-row mo-quote-row--meta"><span></span><span class="sg-muted">Destination: Savannah TN / 38372 · Source: ${escapeHtml(
        taxSourceLabel(v.taxSource) === "—" ? "TN sales tax" : taxSourceLabel(v.taxSource),
      )}</span></div>
      <div class="mo-quote-row mo-quote-row--total"><span>Total</span><strong>${escapeHtml(v.totalFormatted)}</strong></div>
    </div>
    ${hardinBits.length ? `<div class="mo-quote-chips" style="margin-top:10px">${hardinBits.join(" ")}</div>` : ""}
    ${err}${warnings}${checkoutNote}
  `;
  setPanelVisible(stale, Boolean(lastQuote) && estimateStale);
  if (!(Boolean(lastQuote) && estimateStale)) setQuoteStaleMessage();
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
  return {
    items,
    address: {},
    applyEligibleLocalDiscount: readApplyLocalDiscount(),
    forceApplyEligibleLocalDiscount: false,
    fulfillmentMethod: "carrier",
    localDeliveryNote: "",
  };
}

async function runEstimate() {
  const errEl = getEl("wi-page-error");
  if (errEl) {
    errEl.hidden = true;
    errEl.textContent = "";
  }
  if (estimateInFlight) return;

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

  const token = await getToken();
  if (!token) {
    toast("Sign in again to calculate totals.", "danger");
    return;
  }

  estimateInFlight = true;
  const btn = getEl("wi-estimate-btn");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Calculating…";
  }

  try {
    const payload = buildEstimatePayload(items);
    const data = await fetchReportPost("/api/admin-walk-in-order-estimate", token, payload);
    lastQuote = data;
    estimateStale = false;
    renderQuotePreview(data);
    syncEstimateButtonState();
    toast("Quote updated.", "success");
  } catch (error) {
    const msg =
      error instanceof ReportPostError ? error.message : error?.message || "Estimate failed.";
    if (errEl) {
      errEl.textContent = msg;
      errEl.hidden = false;
    }
    toast(msg, "danger");
  } finally {
    estimateInFlight = false;
    if (btn) {
      btn.innerHTML = `${icon("receipt", 14)}<span>Calculate totals</span>`;
    }
    syncEstimateButtonState();
  }
}

/* --------------------------------------------------------------- drafts */

function formatDraftWhen(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  } catch {
    return "—";
  }
}

function draftStatusChip(status) {
  const s = String(status || "draft").trim().toLowerCase();
  if (s === "draft") return statusChip("Draft", "warning");
  if (s === "paid") return statusChip("Paid", "success");
  return statusChip(s || "Draft", "neutral");
}

async function enrichDraftItemCount(draftId, token) {
  try {
    const data = await fetchReportJson(
      `/api/admin-walk-in-order-drafts?id=${encodeURIComponent(draftId)}`,
      token,
    );
    const items = Array.isArray(data?.order?.items) ? data.order.items : null;
    if (!items) return null;
    return items.length;
  } catch {
    return null;
  }
}

function renderDraftRow(draft, itemCount) {
  const ref = draft.order_ref || "—";
  const id = draft.id || "—";
  const customer = draft.customer_name || "—";
  const email = draft.customer_email || "";
  const total = formatCurrency(draft.total_cents);
  const when = formatDraftWhen(draft.created_at || draft.updated_at);
  const itemsLabel = itemCount == null ? "—" : String(itemCount);
  const draftId = String(draft.id || "");

  return `<div class="wi-draft-row" data-draft-id="${escapeHtml(draftId)}">
    <div class="wi-draft-row__main">
      <div>
        <strong>${escapeHtml(String(ref))}</strong>
        ${draftStatusChip(draft.order_status)}
      </div>
      <span class="sg-muted sg-mono" style="font-size:12px">ID ${escapeHtml(String(id))}</span>
      <span class="sg-muted">${escapeHtml(String(customer))}</span>
      <span class="sg-muted">${escapeHtml(total)} · ${escapeHtml(itemsLabel)} item${itemCount === 1 ? "" : "s"} · Created ${escapeHtml(when)}</span>
    </div>
    <div class="wi-draft-row__actions">
      <button type="button" class="sg-btn sg-btn--ghost sg-btn--sm" data-wi-open-draft="${escapeHtml(draftId)}">Open draft</button>
      <button type="button" class="sg-btn sg-btn--ghost sg-btn--sm" data-wi-delete-draft="${escapeHtml(draftId)}" data-draft-ref="${escapeHtml(String(ref))}" data-draft-customer="${escapeHtml(String(customer))}" data-draft-email="${escapeHtml(String(email))}" data-draft-total="${escapeHtml(total)}" data-draft-items="${escapeHtml(itemsLabel)}">Delete</button>
      <button type="button" class="sg-btn sg-btn--ghost sg-btn--sm mo-btn-deferred" disabled title="Open the draft to collect payment.">Mark paid</button>
    </div>
  </div>`;
}

async function loadDrafts() {
  const host = getEl("wi-drafts-list");
  if (!host) return;

  const token = await getToken();
  if (!token) {
    host.innerHTML = `<p class="sg-muted">Sign in to load drafts.</p>`;
    return;
  }

  host.innerHTML = `<p class="sg-muted">Loading drafts…</p>`;

  try {
    const data = await fetchReportJson("/api/admin-walk-in-order-drafts", token);
    const list = Array.isArray(data?.drafts) ? data.drafts : [];
    if (!list.length) {
      host.innerHTML = `<p class="sg-muted">No open walk-in drafts.</p>`;
      return;
    }

    const counts = await Promise.all(list.map((d) => enrichDraftItemCount(d.id, token)));
    host.innerHTML = `<div class="wi-drafts-list">${list
      .map((d, i) => renderDraftRow(d, counts[i]))
      .join("")}</div>`;
  } catch (error) {
    host.innerHTML = `<p class="sg-error">${escapeHtml(error?.message || "Could not load drafts.")}</p>`;
  }
}

/* --------------------------------------------------------------- draft save / edit */

function kvHtml(pairs) {
  const rows = pairs
    .filter((p) => p)
    .map(([k, v]) => `<div class="sg-kv__row"><dt>${escapeHtml(k)}</dt><dd>${v}</dd></div>`)
    .join("");
  return `<dl class="sg-kv">${rows}</dl>`;
}

function itemsSummaryHtml(items) {
  const rows = (items || [])
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

function quoteTotalLabel() {
  if (!lastQuote) return "—";
  const v = quoteView(lastQuote);
  return v.totalFormatted || "—";
}

function buildDraftPayload(items) {
  const cust = readCustomer();
  return {
    name: cust.name,
    email: cust.email || null,
    phone: cust.phone || null,
    items,
    applyEligibleLocalDiscount: readApplyLocalDiscount(),
    forceStockOverride: false,
  };
}

function resetProductStateFromCatalog() {
  productState = {};
  for (const p of products) ensureProductState(p);
}

function hydrateProductStateFromOrder(order) {
  resetProductStateFromCatalog();
  openProductSlugs.clear();
  const items = Array.isArray(order.items) ? order.items : [];
  for (const p of products) {
    const row = items.find((i) => String(i.slug) === p.slug);
    if (!row) continue;
    const st = productState[p.slug];
    const bundles = p.bundles || [];
    st.bundleQty = Object.fromEntries(bundles.map((b) => [b.id, 0]));
    for (const line of row.bundleLines || []) {
      const id = String(line.id || "").trim();
      const q = Math.floor(Number(line.qty) || 0);
      if (id in st.bundleQty) st.bundleQty[id] = q;
    }
    for (const sz of siteSizes) {
      st.caseBySize[sz] = Math.floor(Number(row.quantities?.[sz]) || 0);
      st.boxBySize[sz] = Math.floor(Number(row.boxQuantities?.[sz]) || 0);
    }
    if (hasAnyBundleSelection(st.bundleQty) || sumChannel(st.caseBySize) + sumChannel(st.boxBySize) > 0) {
      openProductSlugs.add(p.slug);
    }
  }
}

function fillFormFromOrder(order) {
  const nameEl = getEl("wi-cust-name");
  const emailEl = getEl("wi-cust-email");
  const phoneEl = getEl("wi-cust-phone");
  if (nameEl) nameEl.value = order.customer_name || "";
  if (emailEl) emailEl.value = order.customer_email || "";
  if (phoneEl) phoneEl.value = order.customer_phone || "";
  const cb = getEl("wi-apply-discount");
  if (cb) cb.checked = order.is_hardin_discount === true;
}

function setEditingBanner(text, visible) {
  const el = getEl("wi-editing-banner");
  if (!el) return;
  const textEl = el.querySelector("[data-wi-editing-text]");
  if (textEl) textEl.textContent = text || "";
  else el.textContent = text || "";
  setPanelVisible(el, Boolean(visible));
}

function hideDraftResult() {
  const result = getEl("wi-draft-result");
  if (!result) return;
  result.innerHTML = "";
  setPanelVisible(result, false);
  const actions = getEl("wi-actions");
  if (actions) setPanelVisible(actions, true);
}

function clearFormNewOrder() {
  editingOrderId = null;
  editingOrderRef = null;
  editingOrderMeta = null;
  savedDraftFingerprint = null;
  allocationSubmitAttempted = false;
  lastQuote = null;
  estimateStale = false;
  if (getEl("wi-cust-name")) getEl("wi-cust-name").value = "";
  if (getEl("wi-cust-email")) getEl("wi-cust-email").value = "";
  if (getEl("wi-cust-phone")) getEl("wi-cust-phone").value = "";
  const cb = getEl("wi-apply-discount");
  if (cb) cb.checked = false;
  resetPaymentUi();
  setEditingBanner("", false);
  hideDraftResult();
  renderQuotePreview(null);
  resetProductStateFromCatalog();
  openProductSlugs.clear();
  renderProducts();
  syncEstimateButtonState();
}

async function openDraftForEdit(orderId) {
  const errEl = getEl("wi-page-error");
  if (errEl) {
    errEl.hidden = true;
    errEl.textContent = "";
  }
  const token = await getToken();
  if (!token) {
    toast("Sign in again to open a draft.", "danger");
    return;
  }

  try {
    const data = await fetchReportJson(
      `/api/admin-walk-in-order-drafts?id=${encodeURIComponent(orderId)}`,
      token,
    );
    const order = data?.order;
    if (!order?.id) throw new Error("Draft not found.");

    hideDraftResult();
    hydrateProductStateFromOrder(order);
    fillFormFromOrder(order);
    editingOrderId = String(order.id);
    editingOrderRef = String(order.order_ref || order.id);
    editingOrderMeta = order;
    // Baseline = hydrated form (saved draft as loaded). Mark paid stays blocked until form matches this again.
    savedDraftFingerprint = liveDraftFingerprint();
    lastQuote = null;
    estimateStale = false;
    allocationSubmitAttempted = false;
    resetPaymentUi();

    setEditingBanner(`Editing walk-in draft ${editingOrderRef}`, true);
    renderQuotePreview(null);
    setQuoteStaleMessage("Recalculate totals after loading a draft.");
    setPanelVisible(getEl("wi-quote-stale"), true);
    renderProducts();
    syncEstimateButtonState();

    getEl("wi-cust-name")?.scrollIntoView({ behavior: "smooth", block: "start" });
    toast(`Opened draft ${editingOrderRef}.`, "success");

    if (estimateEligibility().ok) {
      void runEstimate();
    }
  } catch (error) {
    const msg = error?.message || "Could not open draft.";
    if (errEl) {
      errEl.textContent = msg;
      errEl.hidden = false;
    }
    toast(msg, "danger");
  }
}

function setConfirmErr(id, msg) {
  const el = getEl(id);
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

function openCreateOrUpdateConfirm() {
  const editing = Boolean(editingOrderId);
  const elig = draftSaveEligibility();
  if (!elig.ok) {
    toast(elig.reason || "Cannot save draft yet.", "danger");
    syncDraftSaveButtonState();
    return;
  }

  const cust = readCustomer();
  const PHRASE = editing ? UPDATE_DRAFT_PHRASE : CREATE_DRAFT_PHRASE;
  const title = editing ? "Update walk-in draft?" : "Create unpaid walk-in draft?";
  const warn = editing
    ? "This will update the unpaid walk-in draft. No payment will be recorded and inventory will not change."
    : "This will create an unpaid walk-in draft. No payment will be recorded and inventory will not change.";
  const confirmLabel = editing ? "Update draft" : "Create walk-in draft";
  const typeId = editing ? "wi-update-type-confirm" : "wi-create-type-confirm";
  const errId = editing ? "wi-update-confirm-err" : "wi-create-confirm-err";
  const btnId = editing ? "wi-update-confirm-btn" : "wi-create-confirm-btn";
  const cancelId = editing ? "wi-update-confirm-cancel" : "wi-create-confirm-cancel";

  const bodyHtml = `
    <div class="sg-confirm">
      <div class="sg-warn-banner sg-warn-banner--danger" role="alert">
        ${icon("alert-triangle", 16)}
        <span>${escapeHtml(warn)}</span>
      </div>
      <h3 class="sg-confirm__title">${escapeHtml(title)}</h3>
      <div class="sg-confirm__summary">
        ${kvHtml([
          ["Customer", escapeHtml(cust.name)],
          ["Email", escapeHtml(cust.email || "—")],
          ["Phone", escapeHtml(cust.phone || "—")],
          editing ? ["Draft", escapeHtml(editingOrderRef || editingOrderId || "—")] : null,
          ["Items", escapeHtml(String(elig.items.length))],
          ["Total", `<strong>${escapeHtml(quoteTotalLabel())}</strong>`],
        ])}
        <h4 class="sg-drawer-section__title" style="font-size:13px;margin:14px 0 6px">Items / quantities</h4>
        ${itemsSummaryHtml(elig.items)}
      </div>
      <p class="sg-meta-note">No payment will be recorded. Use Charge cash/check on a new order, or Mark paid when editing a draft.</p>
      <label class="sg-field" style="margin-top:14px">
        <span class="sg-field__label">Type <span class="sg-mono">${escapeHtml(PHRASE)}</span> to enable</span>
        <input type="text" class="sg-input" id="${typeId}" autocomplete="off" spellcheck="false" placeholder="${escapeHtml(PHRASE)}" />
      </label>
      <p class="sg-error sg-hide" id="${errId}" role="alert" hidden></p>
      <div class="sg-drawer-actions">
        <button type="button" class="sg-btn sg-btn--ghost" id="${cancelId}">Cancel</button>
        <button type="button" class="sg-btn sg-btn--primary" id="${btnId}" disabled>${escapeHtml(confirmLabel)}</button>
      </div>
    </div>`;

  openDrawer({ title, bodyHtml });
  document.getElementById("sg-drawer")?.classList.remove("sg-drawer--wide");

  const typeInput = getEl(typeId);
  const confirmBtn = getEl(btnId);
  const inFlight = () => (editing ? updateDraftInFlight : createDraftInFlight);
  const syncConfirmEnabled = () => {
    if (!confirmBtn || inFlight()) return;
    confirmBtn.disabled = String(typeInput?.value || "") !== PHRASE;
  };
  typeInput?.addEventListener("input", () => {
    setConfirmErr(errId, "");
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

  getEl(cancelId)?.addEventListener("click", () => closeDrawer());
  confirmBtn?.addEventListener("click", () => {
    if (String(typeInput?.value || "") !== PHRASE) {
      setConfirmErr(errId, `Type ${PHRASE} exactly to continue.`);
      syncConfirmEnabled();
      return;
    }
    if (editing) void submitUpdateDraft();
    else void submitCreateDraft();
  });
}

function showCreateDraftSuccess(created) {
  const actions = getEl("wi-actions");
  const paymentCard = getEl("wi-payment-card");
  const result = getEl("wi-draft-result");
  if (actions) setPanelVisible(actions, false);
  if (paymentCard) setPanelVisible(paymentCard, false);
  if (!result) return;
  setPanelVisible(result, true);
  result.innerHTML = `
    <div class="mo-success-card">
      <h3 class="mo-success-card__title">${icon("check", 16)}<span>Unpaid walk-in draft created</span></h3>
      <p class="sg-meta-note" style="margin:0 0 12px">No payment was recorded. Open the draft to mark paid, or use Charge cash/check on a new order.</p>
      ${kvHtml([
        ["Reference", `<span class="sg-mono">${escapeHtml(created.orderRef)}</span>`],
        ["Order ID", `<span class="sg-mono">${escapeHtml(created.orderId)}</span>`],
        ["Total", escapeHtml(created.totalFormatted)],
      ])}
      <div class="sg-ship-to-actions" style="margin-top:14px">
        <a class="sg-btn sg-btn--primary" href="/admin-v2/orders">Open in Orders</a>
        <button type="button" class="sg-btn sg-btn--ghost" id="wi-create-another-btn">Create another walk-in order</button>
      </div>
    </div>`;
  getEl("wi-create-another-btn")?.addEventListener("click", () => clearFormNewOrder());
}

function showPaidSuccess(paid) {
  const actions = getEl("wi-actions");
  const paymentCard = getEl("wi-payment-card");
  const result = getEl("wi-draft-result");
  if (actions) setPanelVisible(actions, false);
  if (paymentCard) setPanelVisible(paymentCard, false);
  if (!result) return;
  setPanelVisible(result, true);

  const receiptLabel =
    paid.receiptEmailAttempted === true
      ? paid.receiptEmailSent === true
        ? "Receipt email sent"
        : `Receipt not sent (${paid.receiptEmailReason || "see server logs"})`
      : "Receipt email skipped";

  const inventoryBanner = paid.inventoryWarning
    ? `<div class="sg-warn-banner" role="alert" style="margin-bottom:12px">
        ${icon("alert-triangle", 16)}
        <span>${escapeHtml(String(paid.inventoryWarning))}</span>
      </div>`
    : "";

  const title = paid.quickPay === true ? "Walk-in order charged" : "Walk-in order marked paid";

  result.innerHTML = `
    <div class="mo-success-card">
      <h3 class="mo-success-card__title">${icon("check", 16)}<span>${escapeHtml(title)}</span></h3>
      <p class="sg-meta-note" style="margin:0 0 12px">Complete physical handoff later from Orders v2.</p>
      ${inventoryBanner}
      ${kvHtml([
        ["Reference", `<span class="sg-mono">${escapeHtml(paid.orderRef)}</span>`],
        ["Order ID", `<span class="sg-mono">${escapeHtml(paid.orderId)}</span>`],
        ["Payment", escapeHtml(String(paid.paymentMethod || "—"))],
        paid.totalFormatted ? ["Total", `<strong>${escapeHtml(paid.totalFormatted)}</strong>`] : null,
        ["Receipt", escapeHtml(receiptLabel)],
      ])}
      <div class="sg-ship-to-actions" style="margin-top:14px">
        <a class="sg-btn sg-btn--primary" href="/admin-v2/orders">Open in Orders</a>
        <button type="button" class="sg-btn sg-btn--ghost" id="wi-create-another-btn">Create another walk-in order</button>
      </div>
    </div>`;
  getEl("wi-create-another-btn")?.addEventListener("click", () => clearFormNewOrder());
}

async function submitCreateDraft() {
  if (createDraftInFlight || updateDraftInFlight) return;
  const PHRASE = CREATE_DRAFT_PHRASE;
  const elig = draftSaveEligibility();
  if (!elig.ok) {
    setConfirmErr("wi-create-confirm-err", elig.reason || "Cannot create draft.");
    return;
  }
  if (String(getEl("wi-create-type-confirm")?.value || "") !== PHRASE) {
    setConfirmErr("wi-create-confirm-err", `Type ${PHRASE} exactly to continue.`);
    return;
  }

  createDraftInFlight = true;
  const confirmBtn = getEl("wi-create-confirm-btn");
  const cancelBtn = getEl("wi-create-confirm-cancel");
  setConfirmErr("wi-create-confirm-err", "");
  if (confirmBtn) {
    confirmBtn.disabled = true;
    confirmBtn.textContent = "Creating…";
  }
  if (cancelBtn) cancelBtn.disabled = true;
  syncDraftSaveButtonState();

  try {
    const token = await getToken();
    if (!token) throw new Error("Sign in again to create the draft.");

    const data = await fetchReportPost(
      "/api/admin-walk-in-order-create",
      token,
      buildDraftPayload(elig.items),
    );
    const created = {
      orderId: String(data.orderId || ""),
      orderRef: String(data.orderRef || data.orderId || ""),
      totalFormatted: String(data.totalFormatted || quoteTotalLabel()),
    };

    closeDrawer();
    toast(`Walk-in draft ${created.orderRef} created.`, "success");
    editingOrderId = null;
    editingOrderRef = null;
    editingOrderMeta = null;
    setEditingBanner("", false);
    showCreateDraftSuccess(created);
    await loadDrafts();
  } catch (error) {
    const msg =
      error instanceof ReportPostError
        ? error.message
        : error?.message || "Could not create walk-in draft.";
    setConfirmErr("wi-create-confirm-err", msg);
    if (confirmBtn) {
      confirmBtn.disabled = String(getEl("wi-create-type-confirm")?.value || "") !== PHRASE;
      confirmBtn.textContent = "Create walk-in draft";
    }
    if (cancelBtn) cancelBtn.disabled = false;
  } finally {
    createDraftInFlight = false;
    syncDraftSaveButtonState();
  }
}

async function submitUpdateDraft() {
  if (updateDraftInFlight || createDraftInFlight || !editingOrderId) return;
  const PHRASE = UPDATE_DRAFT_PHRASE;
  const elig = draftSaveEligibility();
  if (!elig.ok) {
    setConfirmErr("wi-update-confirm-err", elig.reason || "Cannot update draft.");
    return;
  }
  if (String(getEl("wi-update-type-confirm")?.value || "") !== PHRASE) {
    setConfirmErr("wi-update-confirm-err", `Type ${PHRASE} exactly to continue.`);
    return;
  }

  updateDraftInFlight = true;
  const confirmBtn = getEl("wi-update-confirm-btn");
  const cancelBtn = getEl("wi-update-confirm-cancel");
  setConfirmErr("wi-update-confirm-err", "");
  if (confirmBtn) {
    confirmBtn.disabled = true;
    confirmBtn.textContent = "Updating…";
  }
  if (cancelBtn) cancelBtn.disabled = true;
  syncDraftSaveButtonState();

  try {
    const token = await getToken();
    if (!token) throw new Error("Sign in again to update the draft.");

    const data = await fetchReportPost("/api/admin-walk-in-order-update-draft", token, {
      orderId: editingOrderId,
      ...buildDraftPayload(elig.items),
    });

    editingOrderId = String(data.orderId || editingOrderId);
    editingOrderRef = String(data.orderRef || editingOrderRef || editingOrderId);
    const cust = readCustomer();
    const { items } = buildItemsFromState();
    editingOrderMeta = {
      ...(editingOrderMeta || {}),
      id: editingOrderId,
      order_ref: editingOrderRef,
      order_source: "walk_in",
      order_status: "draft",
      status: editingOrderMeta?.status || "pending",
      customer_name: cust.name,
      customer_email: cust.email || null,
      customer_phone: cust.phone || null,
      is_hardin_discount: readApplyLocalDiscount(),
      items: items.length ? items : editingOrderMeta?.items,
      total_cents:
        lastQuote?.totals?.totalCents ??
        lastQuote?.totalCents ??
        editingOrderMeta?.total_cents,
    };
    savedDraftFingerprint = liveDraftFingerprint();
    setEditingBanner(`Editing walk-in draft ${editingOrderRef}`, true);

    closeDrawer();
    toast(`Walk-in draft ${editingOrderRef} updated.`, "success");
    await loadDrafts();
    syncMarkPaidButtonState();
  } catch (error) {
    const msg =
      error instanceof ReportPostError
        ? error.message
        : error?.message || "Could not update walk-in draft.";
    setConfirmErr("wi-update-confirm-err", msg);
    if (confirmBtn) {
      confirmBtn.disabled = String(getEl("wi-update-type-confirm")?.value || "") !== PHRASE;
      confirmBtn.textContent = "Update draft";
    }
    if (cancelBtn) cancelBtn.disabled = false;
  } finally {
    updateDraftInFlight = false;
    syncDraftSaveButtonState();
  }
}

function openDeleteDraftConfirm(orderId, meta = {}) {
  if (!orderId) return;
  const PHRASE = DELETE_DRAFT_PHRASE;
  const ref = meta.ref || orderId;
  const bodyHtml = `
    <div class="sg-confirm">
      <div class="sg-warn-banner sg-warn-banner--danger" role="alert">
        ${icon("alert-triangle", 16)}
        <span>This will delete the unpaid walk-in draft. This does not affect paid orders or inventory.</span>
      </div>
      <h3 class="sg-confirm__title">Delete walk-in draft?</h3>
      <div class="sg-confirm__summary">
        ${kvHtml([
          ["Draft", escapeHtml(String(ref))],
          ["Customer", escapeHtml(String(meta.customer || "—"))],
          ["Email", escapeHtml(String(meta.email || "—"))],
          ["Items", escapeHtml(String(meta.itemsLabel || "—"))],
          ["Total", escapeHtml(String(meta.total || "—"))],
        ])}
      </div>
      <label class="sg-field" style="margin-top:14px">
        <span class="sg-field__label">Type <span class="sg-mono">${escapeHtml(PHRASE)}</span> to enable</span>
        <input type="text" class="sg-input" id="wi-delete-type-confirm" autocomplete="off" spellcheck="false" placeholder="${escapeHtml(PHRASE)}" />
      </label>
      <p class="sg-error sg-hide" id="wi-delete-confirm-err" role="alert" hidden></p>
      <div class="sg-drawer-actions">
        <button type="button" class="sg-btn sg-btn--ghost" id="wi-delete-confirm-cancel">Cancel</button>
        <button type="button" class="sg-btn sg-btn--primary" id="wi-delete-confirm-btn" disabled>Delete draft</button>
      </div>
    </div>`;

  openDrawer({ title: "Delete walk-in draft?", bodyHtml });
  document.getElementById("sg-drawer")?.classList.remove("sg-drawer--wide");

  const typeInput = getEl("wi-delete-type-confirm");
  const confirmBtn = getEl("wi-delete-confirm-btn");
  const syncConfirmEnabled = () => {
    if (!confirmBtn || deleteDraftInFlight) return;
    confirmBtn.disabled = String(typeInput?.value || "") !== PHRASE;
  };
  typeInput?.addEventListener("input", () => {
    setConfirmErr("wi-delete-confirm-err", "");
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

  getEl("wi-delete-confirm-cancel")?.addEventListener("click", () => closeDrawer());
  confirmBtn?.addEventListener("click", () => {
    if (String(typeInput?.value || "") !== PHRASE) {
      setConfirmErr("wi-delete-confirm-err", `Type ${PHRASE} exactly to continue.`);
      syncConfirmEnabled();
      return;
    }
    void submitDeleteDraft(orderId);
  });
}

async function submitDeleteDraft(orderId) {
  if (deleteDraftInFlight || !orderId) return;
  const PHRASE = DELETE_DRAFT_PHRASE;
  if (String(getEl("wi-delete-type-confirm")?.value || "") !== PHRASE) {
    setConfirmErr("wi-delete-confirm-err", `Type ${PHRASE} exactly to continue.`);
    return;
  }

  deleteDraftInFlight = true;
  const confirmBtn = getEl("wi-delete-confirm-btn");
  const cancelBtn = getEl("wi-delete-confirm-cancel");
  setConfirmErr("wi-delete-confirm-err", "");
  if (confirmBtn) {
    confirmBtn.disabled = true;
    confirmBtn.textContent = "Deleting…";
  }
  if (cancelBtn) cancelBtn.disabled = true;
  syncDraftSaveButtonState();

  try {
    const token = await getToken();
    if (!token) throw new Error("Sign in again to delete the draft.");

    await fetchReportPost("/api/admin-walk-in-order-delete-draft", token, { orderId });
    closeDrawer();
    toast("Walk-in draft deleted.", "success");
    if (String(editingOrderId) === String(orderId)) {
      clearFormNewOrder();
    }
    await loadDrafts();
  } catch (error) {
    const msg =
      error instanceof ReportPostError
        ? error.message
        : error?.message || "Could not delete walk-in draft.";
    setConfirmErr("wi-delete-confirm-err", msg);
    if (confirmBtn) {
      confirmBtn.disabled = String(getEl("wi-delete-type-confirm")?.value || "") !== PHRASE;
      confirmBtn.textContent = "Delete draft";
    }
    if (cancelBtn) cancelBtn.disabled = false;
  } finally {
    deleteDraftInFlight = false;
    syncDraftSaveButtonState();
  }
}

function markPaidConfirmTotals() {
  if (lastQuote) {
    const v = quoteView(lastQuote);
    return {
      discount: v.discountFormatted ? `−${v.discountFormatted}` : "—",
      tax: v.taxFormatted || "—",
      total: v.totalFormatted || "—",
    };
  }
  const cents = editingOrderMeta?.total_cents;
  return {
    discount: "—",
    tax: "—",
    total: cents != null && Number.isFinite(Number(cents)) ? formatCurrency(cents) : "—",
  };
}

function openMarkPaidConfirm() {
  const elig = markPaidEligibility();
  if (!elig.ok) {
    toast(elig.reason || "Cannot mark paid yet.", "danger");
    syncMarkPaidButtonState();
    return;
  }

  const method = readPaymentMethod();
  const sendReceipt = readSendReceipt();
  const saved = editingOrderMeta || {};
  const savedEmail = String(saved.customer_email || "").trim();
  const summaryItems = Array.isArray(saved.items) ? saved.items : [];
  const totals = markPaidConfirmTotals();
  const PHRASE = MARK_PAID_PHRASE;
  const title = "Mark walk-in order as paid?";

  const bodyHtml = `
    <div class="sg-confirm">
      <div class="sg-warn-banner sg-warn-banner--danger" role="alert">
        ${icon("alert-triangle", 16)}
        <span>This will record payment and may decrement inventory. Confirm that cash or check payment has been received before continuing.</span>
      </div>
      <h3 class="sg-confirm__title">${escapeHtml(title)}</h3>
      <div class="sg-confirm__summary">
        ${kvHtml([
          ["Draft", escapeHtml(editingOrderRef || editingOrderId || "—")],
          ["Order ID", `<span class="sg-mono">${escapeHtml(editingOrderId || "—")}</span>`],
          ["Customer", escapeHtml(String(saved.customer_name || "—"))],
          ["Payment method", escapeHtml(method === "check" ? "Check" : "Cash")],
          [
            "Receipt email",
            escapeHtml(
              sendReceipt
                ? savedEmail
                  ? `Will send to saved draft email (${savedEmail})`
                  : "Will send (saved draft email missing)"
                : "Will skip",
            ),
          ],
          ["Discount", escapeHtml(totals.discount)],
          ["Tax", escapeHtml(totals.tax)],
          ["Total", `<strong>${escapeHtml(totals.total)}</strong>`],
          ["Status", "draft"],
        ])}
        <h4 class="sg-drawer-section__title" style="font-size:13px;margin:14px 0 6px">Items / quantities (saved draft)</h4>
        ${itemsSummaryHtml(summaryItems)}
      </div>
      <p class="sg-meta-note">Payment applies to the saved draft in the database. Receipt uses the saved draft customer email.</p>
      <label class="sg-field" style="margin-top:14px">
        <span class="sg-field__label">Type <span class="sg-mono">${escapeHtml(PHRASE)}</span> to enable</span>
        <input type="text" class="sg-input" id="wi-mark-paid-type-confirm" autocomplete="off" spellcheck="false" placeholder="${escapeHtml(PHRASE)}" />
      </label>
      <p class="sg-error sg-hide" id="wi-mark-paid-confirm-err" role="alert" hidden></p>
      <div class="sg-drawer-actions">
        <button type="button" class="sg-btn sg-btn--ghost" id="wi-mark-paid-confirm-cancel">Cancel</button>
        <button type="button" class="sg-btn sg-btn--primary" id="wi-mark-paid-confirm-btn" disabled>Mark paid and update inventory</button>
      </div>
    </div>`;

  openDrawer({ title, bodyHtml });
  document.getElementById("sg-drawer")?.classList.remove("sg-drawer--wide");

  const typeInput = getEl("wi-mark-paid-type-confirm");
  const confirmBtn = getEl("wi-mark-paid-confirm-btn");
  const syncConfirmEnabled = () => {
    if (!confirmBtn || markPaidInFlight) return;
    confirmBtn.disabled = String(typeInput?.value || "") !== PHRASE;
  };
  typeInput?.addEventListener("input", () => {
    setConfirmErr("wi-mark-paid-confirm-err", "");
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

  getEl("wi-mark-paid-confirm-cancel")?.addEventListener("click", () => closeDrawer());
  confirmBtn?.addEventListener("click", () => {
    if (String(typeInput?.value || "") !== PHRASE) {
      setConfirmErr("wi-mark-paid-confirm-err", `Type ${PHRASE} exactly to continue.`);
      syncConfirmEnabled();
      return;
    }
    void submitMarkPaid();
  });
}

async function submitMarkPaid() {
  if (markPaidInFlight) return;
  const PHRASE = MARK_PAID_PHRASE;
  const elig = markPaidEligibility();
  if (!elig.ok || !editingOrderId) {
    setConfirmErr("wi-mark-paid-confirm-err", elig.reason || "Cannot mark paid.");
    if (isEditingDraftDirty()) {
      closeDrawer();
      syncMarkPaidButtonState();
      toast("Save or discard changes before marking this draft paid.", "danger");
    }
    return;
  }
  if (String(getEl("wi-mark-paid-type-confirm")?.value || "") !== PHRASE) {
    setConfirmErr("wi-mark-paid-confirm-err", `Type ${PHRASE} exactly to continue.`);
    return;
  }

  const paymentMethod = readPaymentMethod();
  const sendReceipt = readSendReceipt();

  markPaidInFlight = true;
  const confirmBtn = getEl("wi-mark-paid-confirm-btn");
  const cancelBtn = getEl("wi-mark-paid-confirm-cancel");
  setConfirmErr("wi-mark-paid-confirm-err", "");
  if (confirmBtn) {
    confirmBtn.disabled = true;
    confirmBtn.textContent = "Marking paid…";
  }
  if (cancelBtn) cancelBtn.disabled = true;
  syncDraftSaveButtonState();

  try {
    const token = await getToken();
    if (!token) throw new Error("Sign in again to mark paid.");

    const data = await fetchReportPost("/api/admin-walk-in-order-mark-paid", token, {
      orderId: editingOrderId,
      paymentMethod,
      sendReceipt,
    });

    const paid = {
      orderId: String(data.orderId || editingOrderId),
      orderRef: String(data.orderRef || editingOrderRef || editingOrderId),
      paymentMethod: String(data.paymentMethod || paymentMethod),
      receiptEmailAttempted: data.receiptEmailAttempted === true,
      receiptEmailSent: data.receiptEmailSent === true,
      receiptEmailReason: data.receiptEmailReason || null,
      inventoryWarning: data.inventoryWarning || null,
    };

    closeDrawer();
    toast(`Walk-in order ${paid.orderRef} marked paid.`, "success");
    clearFormNewOrder();
    showPaidSuccess(paid);
    await loadDrafts();
  } catch (error) {
    const msg =
      error instanceof ReportPostError
        ? error.message
        : error?.message || "Could not mark walk-in order paid.";
    setConfirmErr("wi-mark-paid-confirm-err", msg);
    if (confirmBtn) {
      confirmBtn.disabled = String(getEl("wi-mark-paid-type-confirm")?.value || "") !== PHRASE;
      confirmBtn.textContent = "Mark paid and update inventory";
    }
    if (cancelBtn) cancelBtn.disabled = false;
  } finally {
    markPaidInFlight = false;
    syncDraftSaveButtonState();
  }
}

function openQuickPayConfirm(paymentMethod) {
  const method = String(paymentMethod || "")
    .trim()
    .toLowerCase();
  if (method !== "cash" && method !== "check") {
    toast("Select cash or check.", "danger");
    return;
  }

  const elig = quickPayEligibility();
  if (!elig.ok) {
    toast(elig.reason || "Cannot charge yet.", "danger");
    syncQuickPayButtonState();
    return;
  }

  const cust = readCustomer();
  const sendReceipt = readQuickSendReceipt();
  const v = lastQuote ? quoteView(lastQuote) : null;
  const PHRASE = CHARGE_WALK_IN_PHRASE;
  const title = "Charge walk-in order?";

  const bodyHtml = `
    <div class="sg-confirm">
      <div class="sg-warn-banner sg-warn-banner--danger" role="alert">
        ${icon("alert-triangle", 16)}
        <span>This will create the walk-in order, record payment, and may decrement inventory. Confirm that payment has been received before continuing.</span>
      </div>
      <h3 class="sg-confirm__title">${escapeHtml(title)}</h3>
      <div class="sg-confirm__summary">
        ${kvHtml([
          ["Customer", escapeHtml(cust.name)],
          ["Payment method", escapeHtml(method === "check" ? "Check" : "Cash")],
          ["Receipt email", escapeHtml(sendReceipt ? "Will send" : "Will skip")],
          ["Items", escapeHtml(String(elig.items.length))],
          ["Discount", escapeHtml(v?.discountFormatted ? `−${v.discountFormatted}` : "—")],
          ["Tax", escapeHtml(v?.taxFormatted || "—")],
          ["Total", `<strong>${escapeHtml(v?.totalFormatted || "—")}</strong>`],
        ])}
        <h4 class="sg-drawer-section__title" style="font-size:13px;margin:14px 0 6px">Items / quantities</h4>
        ${itemsSummaryHtml(elig.items)}
      </div>
      <label class="sg-field" style="margin-top:14px">
        <span class="sg-field__label">Type <span class="sg-mono">${escapeHtml(PHRASE)}</span> to enable</span>
        <input type="text" class="sg-input" id="wi-quick-pay-type-confirm" autocomplete="off" spellcheck="false" placeholder="${escapeHtml(PHRASE)}" />
      </label>
      <p class="sg-error sg-hide" id="wi-quick-pay-confirm-err" role="alert" hidden></p>
      <div class="sg-drawer-actions">
        <button type="button" class="sg-btn sg-btn--ghost" id="wi-quick-pay-confirm-cancel">Cancel</button>
        <button type="button" class="sg-btn sg-btn--primary" id="wi-quick-pay-confirm-btn" disabled>Charge and update inventory</button>
      </div>
    </div>`;

  openDrawer({ title, bodyHtml });
  document.getElementById("sg-drawer")?.classList.remove("sg-drawer--wide");

  const typeInput = getEl("wi-quick-pay-type-confirm");
  const confirmBtn = getEl("wi-quick-pay-confirm-btn");
  const syncConfirmEnabled = () => {
    if (!confirmBtn || quickPayInFlight) return;
    confirmBtn.disabled = String(typeInput?.value || "") !== PHRASE;
  };
  typeInput?.addEventListener("input", () => {
    setConfirmErr("wi-quick-pay-confirm-err", "");
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

  getEl("wi-quick-pay-confirm-cancel")?.addEventListener("click", () => closeDrawer());
  confirmBtn?.addEventListener("click", () => {
    if (String(typeInput?.value || "") !== PHRASE) {
      setConfirmErr("wi-quick-pay-confirm-err", `Type ${PHRASE} exactly to continue.`);
      syncConfirmEnabled();
      return;
    }
    void submitQuickPay(method);
  });
}

async function submitQuickPay(paymentMethod) {
  if (quickPayInFlight) return;
  const method = String(paymentMethod || "")
    .trim()
    .toLowerCase();
  const PHRASE = CHARGE_WALK_IN_PHRASE;
  const elig = quickPayEligibility();
  if (!elig.ok) {
    setConfirmErr("wi-quick-pay-confirm-err", elig.reason || "Cannot charge.");
    return;
  }
  if (method !== "cash" && method !== "check") {
    setConfirmErr("wi-quick-pay-confirm-err", "Select cash or check.");
    return;
  }
  if (String(getEl("wi-quick-pay-type-confirm")?.value || "") !== PHRASE) {
    setConfirmErr("wi-quick-pay-confirm-err", `Type ${PHRASE} exactly to continue.`);
    return;
  }

  const sendReceipt = readQuickSendReceipt();

  quickPayInFlight = true;
  const confirmBtn = getEl("wi-quick-pay-confirm-btn");
  const cancelBtn = getEl("wi-quick-pay-confirm-cancel");
  setConfirmErr("wi-quick-pay-confirm-err", "");
  if (confirmBtn) {
    confirmBtn.disabled = true;
    confirmBtn.textContent = "Charging…";
  }
  if (cancelBtn) cancelBtn.disabled = true;
  syncDraftSaveButtonState();

  try {
    const token = await getToken();
    if (!token) throw new Error("Sign in again to charge.");

    const draft = buildDraftPayload(elig.items);
    const data = await fetchReportPost("/api/admin-walk-in-order-quick-pay", token, {
      name: draft.name,
      email: draft.email,
      phone: draft.phone,
      items: draft.items,
      applyEligibleLocalDiscount: draft.applyEligibleLocalDiscount,
      paymentMethod: method,
      sendReceipt,
    });

    const paid = {
      orderId: String(data.orderId || ""),
      orderRef: String(data.orderRef || data.orderId || ""),
      paymentMethod: String(data.paymentMethod || method),
      totalFormatted: data.totalFormatted || quoteTotalLabel(),
      receiptEmailAttempted: data.receiptEmailAttempted === true,
      receiptEmailSent: data.receiptEmailSent === true,
      receiptEmailReason: data.receiptEmailReason || null,
      inventoryWarning: data.inventoryWarning || null,
      quickPay: true,
    };

    closeDrawer();
    toast(`Walk-in order ${paid.orderRef} charged.`, "success");
    clearFormNewOrder();
    showPaidSuccess(paid);
    await loadDrafts();
  } catch (error) {
    const msg =
      error instanceof ReportPostError
        ? error.message
        : error?.message || "Could not charge walk-in order.";
    setConfirmErr("wi-quick-pay-confirm-err", msg);
    if (confirmBtn) {
      confirmBtn.disabled = String(getEl("wi-quick-pay-type-confirm")?.value || "") !== PHRASE;
      confirmBtn.textContent = "Charge and update inventory";
    }
    if (cancelBtn) cancelBtn.disabled = false;
  } finally {
    quickPayInFlight = false;
    syncDraftSaveButtonState();
  }
}

/* --------------------------------------------------------------- page */

function pageHtml() {
  const draftsCard = card({
    title: "Open walk-in drafts",
    actionHtml: `<button type="button" class="sg-btn sg-btn--ghost sg-btn--sm" id="wi-new-order-btn">New order</button>`,
    bodyHtml: `
      <div id="wi-drafts-list"><p class="sg-muted">Loading drafts…</p></div>
      <p class="sg-meta-note" style="margin:12px 0 0">Open a draft to collect payment (Mark paid). For new orders, use Charge cash/check to create and pay in one step.</p>`,
  });

  const customer = card({
    title: "Customer",
    bodyHtml: `<div class="mo-grid">
      <label class="sg-field"><span class="sg-field__label">Full name</span><input class="sg-input" id="wi-cust-name" type="text" autocomplete="name" required /></label>
      <label class="sg-field"><span class="sg-field__label">Email <span class="sg-field__optional">(optional)</span></span><input class="sg-input" id="wi-cust-email" type="email" autocomplete="email" /></label>
      <label class="sg-field"><span class="sg-field__label">Phone <span class="sg-field__optional">(optional)</span></span><input class="sg-input" id="wi-cust-phone" type="tel" autocomplete="tel" /></label>
    </div>`,
  });

  const productsCard = card({
    title: "Products / line items",
    bodyHtml: `<p class="sg-meta-note" style="margin:0 0 12px">For each product: choose a package quantity, then assign sizes until the totals match.</p>
      <div id="wi-products" class="mo-products"><p class="sg-muted">Loading products…</p></div>`,
  });

  const discount = card({
    title: "Discount",
    bodyHtml: `
      <label class="mo-check">
        <input type="checkbox" id="wi-apply-discount" />
        <span>Apply eligible local discount</span>
      </label>
      <p class="sg-meta-note" style="margin:8px 0 0">Walk-in orders use the Savannah pickup location and local walk-in pricing rules. No ZIP entry is required.</p>`,
  });

  const quote = card({
    title: "Estimate / quote preview",
    bodyHtml: `
      <div class="mo-estimate-actions" id="wi-estimate-wrap">
        <div class="mo-estimate-actions__btnrow">
          <button type="button" class="sg-btn sg-btn--primary" id="wi-estimate-btn">${icon("receipt", 14)}<span>Calculate totals</span></button>
          <button type="button" class="mo-estimate-hit sg-hide" id="wi-estimate-hit" hidden aria-label="Show why Calculate totals is unavailable"></button>
        </div>
        <div id="wi-estimate-checklist" class="mo-estimate-checklist sg-hide" hidden></div>
      </div>
      <p class="sg-inline-warn mo-quote-stale sg-hide" id="wi-quote-stale" hidden>${icon("alert-triangle", 14)}<span>Inputs changed since the last quote. Recalculate before relying on these totals.</span></p>
      <div id="wi-quote-body"><p class="sg-muted" style="margin:0">Run Calculate totals to preview merchandise, tax, and discounts.</p></div>`,
  });

  const payment = `<div id="wi-payment-card" class="sg-hide" hidden>${card({
    title: "Collect payment",
    bodyHtml: `
      <div id="wi-dirty-guard" class="sg-hide" hidden>
        <div class="sg-warn-banner sg-warn-banner--danger" role="alert">
          ${icon("alert-triangle", 16)}
          <span>Save or discard changes before marking this draft paid.</span>
        </div>
        <div class="mo-future-actions__btns" style="margin-top:12px">
          <button type="button" class="sg-btn sg-btn--primary" id="wi-dirty-save-btn">Update walk-in draft</button>
          <button type="button" class="sg-btn sg-btn--ghost" id="wi-dirty-discard-btn">Discard changes</button>
        </div>
      </div>
      <div class="mo-radio-row" role="radiogroup" aria-label="Payment method">
        <label class="mo-radio">
          <input type="radio" name="wi_pay_method" value="cash" checked />
          <span>Cash</span>
        </label>
        <label class="mo-radio">
          <input type="radio" name="wi_pay_method" value="check" />
          <span>Check</span>
        </label>
      </div>
      <label class="mo-check" style="margin-top:14px">
        <input type="checkbox" id="wi-send-receipt" />
        <span>Send receipt email after marking paid</span>
      </label>
      <p class="sg-meta-note sg-hide" id="wi-receipt-hint" hidden style="margin:8px 0 0"></p>
      <p class="sg-meta-note" style="margin:12px 0 0">Recording payment reduces inventory. Physical handoff is completed later from Orders v2.</p>
      <div style="margin-top:14px">
        <button type="button" class="sg-btn mo-btn-deferred" id="wi-mark-paid-btn" disabled title="Open a walk-in draft to collect payment.">Mark paid</button>
      </div>`,
  })}</div>`;

  const actions = `<div class="mo-future-actions" id="wi-actions">
    <div class="mo-future-actions__btns">
      <button type="button" class="sg-btn mo-btn-deferred" id="wi-save-draft-btn" disabled title="Complete a fresh quote to save a draft.">Create unpaid walk-in order</button>
    </div>
    <div id="wi-quick-pay-block">
      <label class="mo-check">
        <input type="checkbox" id="wi-quick-receipt" />
        <span>Send receipt email after charging</span>
      </label>
      <p class="sg-meta-note sg-hide" id="wi-quick-receipt-hint" hidden></p>
      <p class="sg-meta-note">Quick-pay creates the walk-in order and records payment in one step. Inventory may be reduced when payment is recorded. Physical handoff is completed later from Orders v2.</p>
      <div class="mo-future-actions__btns">
        <button type="button" class="sg-btn mo-btn-deferred" id="wi-charge-cash" disabled title="Complete a fresh quote to charge.">Charge cash</button>
        <button type="button" class="sg-btn mo-btn-deferred" id="wi-charge-check" disabled title="Complete a fresh quote to charge.">Charge check</button>
      </div>
    </div>
    <p class="sg-meta-note" id="wi-save-helper" style="margin:10px 0 0">Create unpaid drafts, or use Charge cash/check for new orders. Mark paid is available when editing a draft.</p>
  </div>
  <div id="wi-draft-result" class="sg-hide" hidden></div>`;

  return `${pageHeader({
    title: "Walk-in Order",
    subtitle:
      "Create an in-person order, estimate totals, then Charge cash/check for new orders or Mark paid on open drafts.",
  })}
  <p class="wi-helper-banner sg-meta-note" style="margin:0 0 16px">${icon("info", 14)}<span>Walk-in payment reduces inventory when payment is recorded. Physical handoff is completed later from Orders v2.</span></p>
  <p id="wi-editing-banner" class="wi-editing-banner sg-hide" hidden><span data-wi-editing-text></span></p>
  <p id="wi-page-error" class="sg-error" role="alert" hidden style="white-space:pre-wrap"></p>
  <div class="mo-stack">
    ${draftsCard}
    ${customer}
    ${productsCard}
    ${discount}
    ${quote}
    ${payment}
    ${actions}
  </div>`;
}

function wirePage() {
  const page = getEl("sg-page");
  if (!page) return;

  page.addEventListener("click", (e) => {
    const toggle = e.target.closest("[data-wi-toggle-product]");
    if (toggle) {
      const slug = toggle.getAttribute("data-wi-toggle-product");
      if (openProductSlugs.has(slug)) openProductSlugs.delete(slug);
      else openProductSlugs.add(slug);
      renderProducts();
      return;
    }
    const bundleBtn = e.target.closest("[data-wi-bundle-step]");
    if (bundleBtn && !bundleBtn.disabled) {
      applyBundleDelta(
        bundleBtn.getAttribute("data-slug"),
        bundleBtn.getAttribute("data-bundle"),
        Number(bundleBtn.getAttribute("data-delta")) || 0,
      );
      return;
    }
    const sizeBtn = e.target.closest("[data-wi-size-step]");
    if (sizeBtn && !sizeBtn.disabled) {
      handleSizeStep(
        sizeBtn.getAttribute("data-slug"),
        sizeBtn.getAttribute("data-channel"),
        sizeBtn.getAttribute("data-size"),
        Number(sizeBtn.getAttribute("data-delta")) || 0,
      );
      return;
    }
    const openDraftBtn = e.target.closest("[data-wi-open-draft]");
    if (openDraftBtn && !openDraftBtn.disabled) {
      void openDraftForEdit(openDraftBtn.getAttribute("data-wi-open-draft"));
      return;
    }
    const deleteDraftBtn = e.target.closest("[data-wi-delete-draft]");
    if (deleteDraftBtn && !deleteDraftBtn.disabled) {
      openDeleteDraftConfirm(deleteDraftBtn.getAttribute("data-wi-delete-draft"), {
        ref: deleteDraftBtn.getAttribute("data-draft-ref") || "",
        customer: deleteDraftBtn.getAttribute("data-draft-customer") || "",
        email: deleteDraftBtn.getAttribute("data-draft-email") || "",
        total: deleteDraftBtn.getAttribute("data-draft-total") || "",
        itemsLabel: deleteDraftBtn.getAttribute("data-draft-items") || "",
      });
      return;
    }
  });

  page.addEventListener("change", (e) => {
    const t = e.target;
    if (!(t instanceof HTMLElement)) return;
    if (t.id === "wi-apply-discount") {
      markEstimateStale();
      return;
    }
    if (t.id === "wi-cust-name" || t.id === "wi-cust-email" || t.id === "wi-cust-phone") {
      markEstimateStale();
      if (t.id === "wi-cust-email") {
        syncMarkPaidButtonState();
        syncQuickPayButtonState();
      }
      return;
    }
    if (t.name === "wi_pay_method" || t.id === "wi-send-receipt") {
      syncMarkPaidButtonState();
      return;
    }
    if (t.id === "wi-quick-receipt") {
      syncQuickPayButtonState();
    }
  });

  page.addEventListener("input", (e) => {
    const t = e.target;
    if (!(t instanceof HTMLElement)) return;
    if (t.id === "wi-cust-name" || t.id === "wi-cust-email" || t.id === "wi-cust-phone") {
      syncEstimateButtonState();
      syncMarkPaidButtonState();
      if (t.id === "wi-cust-email") {
        syncQuickPayButtonState();
      }
    }
  });

  getEl("wi-estimate-btn")?.addEventListener("click", () => void runEstimate());
  getEl("wi-estimate-hit")?.addEventListener("click", () => {
    const elig = estimateEligibility();
    renderEstimateChecklist(elig.blockers);
    allocationSubmitAttempted = true;
    renderProducts();
    focusEstimateBlocker(elig.blockers[0]);
    toast(elig.blockers[0]?.message || "Fix the checklist items before calculating.", "danger");
  });
  getEl("wi-save-draft-btn")?.addEventListener("click", () => openCreateOrUpdateConfirm());
  getEl("wi-dirty-save-btn")?.addEventListener("click", () => openCreateOrUpdateConfirm());
  getEl("wi-dirty-discard-btn")?.addEventListener("click", () => {
    if (!editingOrderId) return;
    void openDraftForEdit(editingOrderId);
  });
  getEl("wi-mark-paid-btn")?.addEventListener("click", () => openMarkPaidConfirm());
  getEl("wi-charge-cash")?.addEventListener("click", () => openQuickPayConfirm("cash"));
  getEl("wi-charge-check")?.addEventListener("click", () => openQuickPayConfirm("check"));
  getEl("wi-new-order-btn")?.addEventListener("click", () => clearFormNewOrder());

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

async function enterPage() {
  renderPage();
  const tasks = [];
  tasks.push(
    loadProducts().catch((error) => {
      toast(error?.message || "Could not load products.", "danger");
      const host = getEl("wi-products");
      if (host) {
        host.innerHTML = `<p class="sg-error">${escapeHtml(error?.message || "Could not load products.")}</p>`;
      }
    }),
  );
  tasks.push(loadDrafts());
  await Promise.all(tasks);
}

bootAdminV2Page({
  activeNav: "walk-in-order",
  onEnter: async (_session, ctx) => {
    getToken = ctx.getAccessToken;
    await enterPage();
  },
  onRefresh: async () => {
    try {
      await Promise.all([loadProducts(), loadDrafts()]);
      toast("Catalog and drafts refreshed.", "success");
    } catch (error) {
      toast(error?.message || "Could not refresh.", "danger");
    }
  },
});
