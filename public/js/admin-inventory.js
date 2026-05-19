import {
  clearAdminSessionUser,
  createSupabaseAdminClient,
  fetchReportJson,
  fetchReportPost,
  fetchSupabasePublicConfig,
  primeAdminSessionUser,
  renderAdminNav,
  shouldBootstrapAdminSignedIn,
} from "./admin-shared.js";

/** @type {import("@supabase/supabase-js").SupabaseClient | null} */
let supabase = null;

/** Catalog groups from last successful stock load (commitment form product/size options). */
let lastEditorGroupsCache = [];
/** @type {{ overrides: object[] }} */
let lastStockOverrideHistoryCache = { overrides: [] };

/** Unshipped commitment rows from last load (edit lookup). */
let lastCommitmentRowsCache = [];

/** Pending lines for multi-line order builder (not yet saved). */
let pendingOrderLines = [];
let pendingLineSeq = 1;

/** Pending expected lines for create incoming batch builder. */
let pendingIncomingLines = [];
let pendingIncomingLineSeq = 1;

/** Last `incomingInventory.rows` from stock load (batch edit lookup). */
let lastIncomingRowsPayload = [];

/** Last stock payload passed to `renderIncomingBatchesList` (for filter re-render). */
let lastStockPayloadForIncoming = null;

/** Active batch filter: upcoming | all | on_hold | arrived | received | cancelled */
let incomingBatchesFilterId = "upcoming";

/** When set, batch details dialog should stay open / refresh after `renderIncomingBatchesList`. */
let incomingDetailsOpenBatchId = null;

/** Pending batch id while “Edit shipment record?” warning is open. */
let pendingIncomingEditBatchId = null;

/** Pending batch id while “Release shipment from hold?” warning is open. */
let pendingReleaseHoldBatchId = null;

/** Line id → { batch, line } for edit line dialog. */
let lastIncomingLineLookup = new Map();

function showLogin() {
  document.getElementById("admin-login").hidden = false;
  document.getElementById("admin-app").hidden = true;
}

function showApp() {
  document.getElementById("admin-login").hidden = true;
  document.getElementById("admin-app").hidden = false;
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Split batch notes for display when a new bracketed label starts (e.g. `[On hold]`, `[Arrival check …]`).
 * Plain text without that pattern stays a single entry.
 * @param {string} notesRaw
 * @returns {string[]}
 */
function splitIncomingBatchNoteEntries(notesRaw) {
  const t = String(notesRaw ?? "").trim();
  if (!t) {
    return [];
  }
  const parts = t
    .split(/(?=\[[^\]]+\])/)
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length ? parts : [t];
}

/**
 * Escaped HTML for View details notes (title + list). Does not mutate stored notes.
 * @param {string} notesRaw
 */
function incomingBatchDetailsNotesSectionHtml(notesRaw) {
  const entries = splitIncomingBatchNoteEntries(notesRaw);
  if (!entries.length) {
    return "";
  }
  const lis = entries
    .map((line) => `<li class="inv-incoming-details-notes__item">${escapeHtml(line)}</li>`)
    .join("");
  return `<p class="inv-incoming-details-notes__title">Notes</p><ul class="inv-incoming-details-notes__list">${lis}</ul>`;
}

/** Local calendar date `YYYY-MM-DD` for date inputs. */
function localIsoToday() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * @param {number} cases
 * @param {number} boxes
 * @param {string} [suffix] e.g. "sold" or "left"
 */
function formatCasesBoxesLine(cases, boxes, suffix) {
  const c = Math.max(0, Math.floor(Number(cases) || 0));
  const b = Math.max(0, Math.floor(Number(boxes) || 0));
  const cLabel = c === 1 ? "Case" : "Cases";
  const bLabel = b === 1 ? "Box" : "Boxes";
  const tail = suffix ? ` ${suffix}` : "";
  return `${c} ${cLabel} ${b} ${bLabel}${tail}`;
}

/** Two-line cases/boxes for inventory KPI cards (inner HTML). */
function formatCasesBoxesKpiHtml(cases, boxes) {
  const c = Math.max(0, Math.floor(Number(cases) || 0));
  const b = Math.max(0, Math.floor(Number(boxes) || 0));
  const cLabel = c === 1 ? "Case" : "Cases";
  const bLabel = b === 1 ? "Box" : "Boxes";
  return `<span class="inv-summary__figures-row">${escapeHtml(String(c))} ${escapeHtml(cLabel)}</span><span class="inv-summary__figures-row">${escapeHtml(String(b))} ${escapeHtml(bLabel)}</span>`;
}

/** Physical on-hand string for read-only stock column (e.g. "20 Cases 2 Boxes"). */
function formatCasesBoxesInStock(cases, boxes) {
  return formatCasesBoxesLine(cases, boxes, "");
}

/**
 * Convert a non-negative box-equivalent total into display cases + loose boxes for one pack size.
 * @param {number} totalBoxes
 * @param {number} boxesPerCase
 */
function formatCasesBoxesFromBoxEquivalent(totalBoxes, boxesPerCase) {
  const bpc = Math.max(1, Math.floor(Number(boxesPerCase) || 10));
  const t = Math.max(0, Math.floor(Number(totalBoxes) || 0));
  return {
    cases: Math.floor(t / bpc),
    boxes: t % bpc,
  };
}

/** @param {object | null | undefined} line */
function trackedLine(line) {
  return Boolean(line && line.track === true && line.active !== false);
}

/**
 * Raw availability before clamping (null if line not tracked).
 * @param {object | null | undefined} line
 */
function lineAvailabilityRaw(line) {
  if (!trackedLine(line)) {
    return null;
  }
  return (Number(line.onHand) || 0) - (Number(line.reserved) || 0);
}

/**
 * Sellable box-equivalent for one variant (matches server idea: case avail × bpc + box avail).
 * Null if neither channel is tracked.
 */
function sellableBoxEquivalent(caseLine, boxLine, boxesPerCase) {
  const bpc = Math.max(1, Math.floor(Number(boxesPerCase) || 10));
  let tracked = false;
  let total = 0;
  const cr = lineAvailabilityRaw(caseLine);
  if (cr != null) {
    tracked = true;
    total += Math.max(0, Math.floor(cr)) * bpc;
  }
  const br = lineAvailabilityRaw(boxLine);
  if (br != null) {
    tracked = true;
    total += Math.max(0, Math.floor(br));
  }
  return tracked ? total : null;
}

/**
 * True if reserved exceeds on-hand on any tracked line (data inconsistency).
 */
function variantNeedsReview(caseLine, boxLine) {
  if (trackedLine(caseLine) && (Number(caseLine.onHand) || 0) < (Number(caseLine.reserved) || 0)) {
    return true;
  }
  if (trackedLine(boxLine) && (Number(boxLine.onHand) || 0) < (Number(boxLine.reserved) || 0)) {
    return true;
  }
  return false;
}

/**
 * Low-stock threshold in box-equivalents: max of reorder thresholds from case/box lines (each in its own units),
 * or a simple fallback of max(boxesPerCase, 10) ≈ "1 case or 10 boxes" worth of boxes.
 */
function variantLowThresholdBoxes(caseLine, boxLine, boxesPerCase) {
  const bpc = Math.max(1, Math.floor(Number(boxesPerCase) || 10));
  let th = 0;
  let hasExplicit = false;
  const ct =
    caseLine?.reorderThreshold != null && caseLine.reorderThreshold !== ""
      ? Math.max(0, Math.floor(Number(caseLine.reorderThreshold)))
      : null;
  const bt =
    boxLine?.reorderThreshold != null && boxLine.reorderThreshold !== ""
      ? Math.max(0, Math.floor(Number(boxLine.reorderThreshold)))
      : null;
  if (ct != null && ct > 0) {
    hasExplicit = true;
    th = Math.max(th, ct * bpc);
  }
  if (bt != null && bt > 0) {
    hasExplicit = true;
    th = Math.max(th, bt);
  }
  if (!hasExplicit) {
    th = Math.max(bpc, 10);
  }
  return th;
}

/**
 * @param {Map<string, object>} index
 * @param {string} slug
 * @param {string} size
 */
function getVariantLines(index, slug, size) {
  const caseLine = index.get(`${slug}\t${size}\tcase`) || null;
  const boxLine = index.get(`${slug}\t${size}\tbox`) || null;
  return { caseLine, boxLine };
}

/**
 * @param {object[]} lines
 * @returns {Map<string, object>}
 */
function buildLineIndex(lines) {
  const map = new Map();
  const list = Array.isArray(lines) ? lines : [];
  for (const line of list) {
    if (!line || typeof line !== "object") {
      continue;
    }
    const slug = String(line.productSlug || "").trim();
    const size = String(line.size || "").trim();
    const ch = String(line.channel || "").toLowerCase();
    const channel = ch === "cases" ? "case" : ch === "boxes" ? "box" : ch;
    if (!slug || !size || (channel !== "case" && channel !== "box")) {
      continue;
    }
    map.set(`${slug}\t${size}\t${channel}`, line);
  }
  return map;
}

/**
 * Reference boxes-per-case for KPI math: max across catalog (≥10 default) so case rows convert consistently.
 * @param {object[]} groups editor.groups
 */
function referenceBoxesPerCaseFromEditor(groups) {
  const gs = Array.isArray(groups) ? groups : [];
  let ref = 10;
  for (const g of gs) {
    ref = Math.max(ref, Math.max(1, Math.floor(Number(g.boxesPerCase) || 10)));
  }
  return Math.max(1, ref);
}

function hasMixedBoxesPerCaseInEditor(groups) {
  const gs = Array.isArray(groups) ? groups : [];
  const set = new Set();
  for (const g of gs) {
    set.add(Math.max(1, Math.floor(Number(g.boxesPerCase) || 10)));
  }
  return set.size > 1;
}

/**
 * Estimated availability: physical − open orders − Amazon FBM (raw API quantities),
 * converted with one reference BPC for rollover; clamp ≥0 (never above physical in equivalent units).
 */
function estimatedAvailableCasesBoxes(
  remainingCases,
  remainingBoxes,
  orderCases,
  orderBoxes,
  amazonCases,
  amazonBoxes,
  bpc,
) {
  const b = Math.max(1, Math.floor(Number(bpc) || 10));
  const rc = Math.max(0, Math.floor(Number(remainingCases) || 0));
  const rb = Math.max(0, Math.floor(Number(remainingBoxes) || 0));
  const oc = Math.max(0, Math.floor(Number(orderCases) || 0));
  const ob = Math.max(0, Math.floor(Number(orderBoxes) || 0));
  const ac = Math.max(0, Math.floor(Number(amazonCases) || 0));
  const ab = Math.max(0, Math.floor(Number(amazonBoxes) || 0));
  const physEquiv = rc * b + rb;
  const demandEquiv = oc * b + ob + ac * b + ab;
  const availEquiv = Math.max(0, physEquiv - demandEquiv);
  return formatCasesBoxesFromBoxEquivalent(availEquiv, b);
}

function salesChannelLabel(channel) {
  const c = String(channel || "").trim().toLowerCase();
  if (c === "amazon_fbm") {
    return "Amazon FBM";
  }
  if (c === "wholesale") {
    return "Wholesale";
  }
  if (c === "manual_external") {
    return "Manual external";
  }
  return c || "—";
}

function buildSlugToCatalogName(groups) {
  const map = new Map();
  const gs = Array.isArray(groups) ? groups : [];
  for (const g of gs) {
    const slug = String(g.productSlug || "").trim();
    if (!slug) {
      continue;
    }
    map.set(slug, String(g.catalogProductName ?? g.productSlug ?? slug));
  }
  return map;
}

function formatSoldDateDisplay(iso) {
  if (!iso) {
    return "—";
  }
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return "—";
  }
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/**
 * @param {HTMLSelectElement | null} selectEl
 * @param {object[]} groups
 * @param {{ skipPlaceholder?: boolean }} [opts]
 */
function fillProductSelect(selectEl, groups, opts = {}) {
  if (!selectEl) {
    return;
  }
  const prev = selectEl.value;
  selectEl.innerHTML = "";
  if (!opts.skipPlaceholder) {
    const ph = document.createElement("option");
    ph.value = "";
    ph.textContent = "Select product…";
    selectEl.appendChild(ph);
  }
  const gs = Array.isArray(groups) ? groups : [];
  for (const g of gs) {
    const slug = String(g.productSlug || "").trim();
    if (!slug) {
      continue;
    }
    const label = String(g.catalogProductName ?? g.productSlug ?? slug);
    const opt = document.createElement("option");
    opt.value = slug;
    opt.textContent = label;
    selectEl.appendChild(opt);
  }
  if (prev && [...selectEl.options].some((o) => o.value === prev)) {
    selectEl.value = prev;
  }
}

/**
 * @param {HTMLSelectElement | null} sizeSel
 * @param {string} slug
 * @param {object[]} groups
 * @param {string} [preferredSize]
 */
function syncSizeSelectForSlug(sizeSel, slug, groups, preferredSize = "") {
  if (!sizeSel) {
    return;
  }
  const prev = preferredSize || sizeSel.value;
  sizeSel.innerHTML = "";
  const ph = document.createElement("option");
  ph.value = "";
  ph.textContent = "Select size…";
  sizeSel.appendChild(ph);

  const productSlug = String(slug || "").trim();
  if (!productSlug) {
    sizeSel.disabled = true;
    return;
  }

  const g = (Array.isArray(groups) ? groups : []).find((x) => String(x.productSlug || "").trim() === productSlug);
  const rows = Array.isArray(g?.rows) ? g.rows : [];
  for (const r of rows) {
    const sz = String(r.size || "").trim();
    if (!sz) {
      continue;
    }
    const opt = document.createElement("option");
    opt.value = sz;
    opt.textContent = sz;
    sizeSel.appendChild(opt);
  }
  sizeSel.disabled = rows.length === 0;
  if (prev && [...sizeSel.options].some((o) => o.value === prev)) {
    sizeSel.value = prev;
  }
}

function commitmentGroupSortKey(r) {
  const ch = String(r.channel || "").trim();
  const ext = String(r.external_order_id || "").trim();
  return `${ch}\n${ext}`;
}

function incomingBatchLineActionsAllowed(status) {
  const s = String(status || "").trim();
  return s === "planned" || s === "in_transit" || s === "arrived" || s === "on_hold";
}

function incomingBatchStatusDisplayLabel(status) {
  const s = String(status || "").trim();
  if (s === "in_transit") {
    return "In transit";
  }
  if (s === "planned") {
    return "Planned";
  }
  if (s === "arrived") {
    return "Arrived";
  }
  if (s === "on_hold") {
    return "On hold";
  }
  if (s === "received") {
    return "Received";
  }
  if (s === "cancelled") {
    return "Cancelled";
  }
  return s || "—";
}

function incomingBatchStatusBadgeClass(status) {
  const s = String(status || "").trim();
  if (s === "planned") {
    return "inv-status-badge inv-status-badge--planned";
  }
  if (s === "in_transit") {
    return "inv-status-badge inv-status-badge--in_transit";
  }
  if (s === "arrived") {
    return "inv-status-badge inv-status-badge--arrived";
  }
  if (s === "on_hold") {
    return "inv-status-badge inv-status-badge--on_hold inv-inc-status--on-hold";
  }
  if (s === "received") {
    return "inv-status-badge inv-status-badge--received";
  }
  if (s === "cancelled") {
    return "inv-status-badge inv-status-badge--cancelled";
  }
  return "inv-status-badge";
}

function setIncomingFeedback(text, isError) {
  const el = document.getElementById("inv-incoming-feedback");
  if (!el) {
    return;
  }
  if (!text) {
    el.hidden = true;
    el.textContent = "";
    el.classList.remove("inv-commit-feedback--error");
    return;
  }
  el.hidden = false;
  el.textContent = text;
  el.classList.toggle("inv-commit-feedback--error", Boolean(isError));
}

function renderIncomingPendingLinesTable() {
  const tbody = document.getElementById("inv-inc-pending-tbody");
  if (!tbody) {
    return;
  }
  if (!pendingIncomingLines.length) {
    tbody.innerHTML = `<tr><td colspan="4" class="admin-muted">No lines yet. Add expected products above.</td></tr>`;
    return;
  }
  tbody.innerHTML = pendingIncomingLines
    .map((line) => {
      const qty = formatCasesBoxesInStock(line.expected_cases, line.expected_boxes);
      return `<tr>
  <td>${escapeHtml(line.productLabel)}</td>
  <td>${escapeHtml(line.size)}</td>
  <td class="inv-commitments-num">${escapeHtml(qty)}</td>
  <td><button type="button" class="admin-btn admin-btn--small" data-inc-pending-remove="${escapeHtml(String(line.localId))}">Remove</button></td>
</tr>`;
    })
    .join("");
}

function onAddIncomingLine() {
  const slug = String(document.getElementById("inv-inc-line-product")?.value || "").trim();
  const size = String(document.getElementById("inv-inc-line-size")?.value || "").trim();
  const expected_cases = Math.max(0, Math.floor(Number(document.getElementById("inv-inc-line-cases")?.value) || 0));
  const expected_boxes = Math.max(0, Math.floor(Number(document.getElementById("inv-inc-line-boxes")?.value) || 0));

  if (!slug || !size) {
    setIncomingFeedback("Select a product and size for the line.", true);
    return;
  }
  if (expected_cases <= 0 && expected_boxes <= 0) {
    setIncomingFeedback("Enter at least one expected case or box.", true);
    return;
  }

  const g = lastEditorGroupsCache.find((x) => String(x.productSlug || "").trim() === slug);
  const productLabel = String(g?.catalogProductName ?? g?.productSlug ?? slug);

  pendingIncomingLines.push({
    localId: `inc${pendingIncomingLineSeq++}`,
    product_slug: slug,
    size,
    productLabel,
    expected_cases,
    expected_boxes,
  });

  const casesEl = document.getElementById("inv-inc-line-cases");
  const boxesEl = document.getElementById("inv-inc-line-boxes");
  if (casesEl) {
    casesEl.value = "0";
  }
  if (boxesEl) {
    boxesEl.value = "0";
  }
  setIncomingFeedback("", false);
  renderIncomingPendingLinesTable();
}

/**
 * Read-only line rows for View details (no actions column).
 * @param {object[]} lines
 * @param {string} status
 * @param {Map<string, string>} slugToName
 */
function incomingBatchDetailsReadonlyLineRowsHtml(lines, status, slugToName) {
  if (!Array.isArray(lines) || !lines.length) {
    return `<tr><td colspan="4" class="admin-muted">No lines.</td></tr>`;
  }
  return lines
    .map((ln) => {
      const slug = String(ln.product_slug || "").trim();
      const pname = escapeHtml(slugToName.get(slug) || slug || "—");
      const sz = escapeHtml(String(ln.size ?? ""));
      const exp = escapeHtml(formatCasesBoxesInStock(Number(ln.expected_cases) || 0, Number(ln.expected_boxes) || 0));
      const recv = escapeHtml(
        formatCasesBoxesInStock(Number(ln.received_cases) || 0, Number(ln.received_boxes) || 0),
      );
      return `<tr>
  <td>${pname}</td>
  <td>${sz}</td>
  <td class="inv-commitments-num">${exp}</td>
  <td class="inv-commitments-num">${recv}</td>
</tr>`;
    })
    .join("");
}

/**
 * Expected lines table for Edit batch dialog (edit/delete when allowed).
 * @param {string} batchId
 * @param {object[]} lines
 * @param {string} status
 * @param {Map<string, string>} slugToName
 */
function incomingBatchEditBatchLineRowsHtml(batchId, lines, status, slugToName) {
  const st = String(status || "").trim();
  const bidEsc = escapeHtml(String(batchId));
  if (!Array.isArray(lines) || !lines.length) {
    return `<tr><td colspan="4" class="admin-muted">No lines.</td></tr>`;
  }
  const allow = incomingBatchLineActionsAllowed(st);
  return lines
    .map((ln) => {
      const slug = String(ln.product_slug || "").trim();
      const pname = escapeHtml(slugToName.get(slug) || slug || "—");
      const sz = escapeHtml(String(ln.size ?? ""));
      const exp = escapeHtml(formatCasesBoxesInStock(Number(ln.expected_cases) || 0, Number(ln.expected_boxes) || 0));
      const lid = escapeHtml(String(ln.id ?? ""));
      const lineActs =
        allow && lines.length > 1
          ? `<button type="button" class="admin-btn admin-btn--small" data-incoming-action="edit-line" data-line-id="${lid}" data-batch-id="${bidEsc}">Edit</button>
    <button type="button" class="admin-btn admin-btn--small" data-incoming-action="delete-line" data-line-id="${lid}" data-batch-id="${bidEsc}">Delete</button>`
          : allow && lines.length <= 1
            ? `<button type="button" class="admin-btn admin-btn--small" data-incoming-action="edit-line" data-line-id="${lid}" data-batch-id="${bidEsc}">Edit</button>
    <span class="admin-muted inv-incoming-last-line-hint" title="Add another line before deleting this one.">Delete</span>`
            : "—";

      return `<tr>
  <td>${pname}</td>
  <td>${sz}</td>
  <td class="inv-commitments-num">${exp}</td>
  <td>${lineActs}</td>
</tr>`;
    })
    .join("");
}

/**
 * @param {string} batchId
 */
function populateIncomingEditBatchLinesTable(batchId) {
  const tbody = document.getElementById("inv-inc-edit-batch-lines-tbody");
  const delWrap = document.getElementById("inv-inc-edit-batch-planned-delete-wrap");
  const delBtn = document.getElementById("inv-inc-edit-batch-delete-btn");
  if (!tbody) {
    return;
  }
  const entry = lastIncomingRowsPayload.find((r) => String(r.batch?.id) === String(batchId));
  const lines = Array.isArray(entry?.lines) ? entry.lines : [];
  const st = String(entry?.batch?.status || "").trim();
  const slugToName = buildSlugToCatalogName(lastEditorGroupsCache);
  tbody.innerHTML = incomingBatchEditBatchLineRowsHtml(batchId, lines, st, slugToName);

  if (delWrap) {
    delWrap.hidden = st !== "planned";
  }
  if (delBtn) {
    delBtn.setAttribute("data-batch-id", String(batchId));
  }
}

function refreshIncomingEditBatchLinesTable() {
  const dlg = document.getElementById("inv-incoming-edit-batch-dialog");
  if (!dlg || !dlg.open) {
    return;
  }
  const id = String(document.getElementById("inv-inc-edit-batch-id")?.value || "").trim();
  if (id) {
    populateIncomingEditBatchLinesTable(id);
  }
}

function incomingBatchViewDetailsButtonHtml(batchId) {
  const bid = escapeHtml(String(batchId));
  return `<button type="button" class="admin-btn admin-btn--small inv-incoming-batch-card__action inv-incoming-view-details" data-incoming-action="view-batch" data-batch-id="${bid}">View details</button>`;
}

function incomingBatchActionsHtml(batchId, status) {
  const bid = escapeHtml(String(batchId));
  const st = String(status || "").trim();
  const actions = [incomingBatchViewDetailsButtonHtml(batchId)];
  if (st === "planned") {
    actions.push(
      `<button type="button" class="admin-btn admin-btn--small inv-incoming-batch-card__action" data-incoming-action="edit-batch" data-batch-id="${bid}">Edit batch</button>`,
      `<button type="button" class="admin-btn admin-btn--small inv-incoming-batch-card__action" data-incoming-action="mark-in_transit" data-batch-id="${bid}">Mark in transit</button>`,
      `<button type="button" class="admin-btn admin-btn--small inv-incoming-batch-card__action" data-incoming-action="mark-arrived" data-batch-id="${bid}">Mark arrived</button>`,
    );
  } else if (st === "in_transit") {
    actions.push(
      `<button type="button" class="admin-btn admin-btn--small inv-incoming-batch-card__action" data-incoming-action="edit-batch" data-batch-id="${bid}">Edit batch</button>`,
      `<button type="button" class="admin-btn admin-btn--small inv-incoming-batch-card__action" data-incoming-action="mark-arrived" data-batch-id="${bid}">Mark arrived</button>`,
    );
  } else if (st === "arrived") {
    actions.push(
      `<button type="button" class="admin-btn admin-btn--small inv-incoming-batch-card__action" data-incoming-action="edit-batch" data-batch-id="${bid}">Edit batch</button>`,
      `<button type="button" class="admin-btn admin-btn--small inv-incoming-batch-card__action inv-incoming-action--hold" data-incoming-action="place-on-hold" data-batch-id="${bid}">Place on hold</button>`,
      `<button type="button" class="admin-btn admin-btn--small inv-incoming-batch-card__action inv-incoming-action--receive admin-btn--primary" data-incoming-action="receive-batch" data-batch-id="${bid}">Approve &amp; receive stock</button>`,
    );
  } else if (st === "on_hold") {
    actions.push(
      `<button type="button" class="admin-btn admin-btn--small inv-incoming-batch-card__action" data-incoming-action="edit-batch" data-batch-id="${bid}">Edit batch</button>`,
      `<button type="button" class="admin-btn admin-btn--small inv-incoming-batch-card__action" data-incoming-action="release-hold" data-batch-id="${bid}">Release hold</button>`,
    );
  }
  return actions.join("\n    ");
}

const INCOMING_BATCH_FILTER_DEFS = [
  { id: "upcoming", label: "Upcoming" },
  { id: "all", label: "All" },
  { id: "on_hold", label: "On hold" },
  { id: "arrived", label: "Arrived" },
  { id: "received", label: "Received" },
  { id: "cancelled", label: "Cancelled" },
];

/**
 * @param {object} row incomingInventory.rows item
 * @param {string} filterId
 */
function incomingBatchRowMatchesFilter(row, filterId) {
  const st = String(row?.batch?.status || "").trim();
  const fid = String(filterId || "upcoming");
  if (fid === "all") {
    return true;
  }
  if (fid === "upcoming") {
    return st === "planned" || st === "in_transit";
  }
  if (fid === "on_hold") {
    return st === "on_hold";
  }
  if (fid === "arrived") {
    return st === "arrived";
  }
  if (fid === "received") {
    return st === "received";
  }
  if (fid === "cancelled") {
    return st === "cancelled";
  }
  return true;
}

/**
 * @param {object[]} rows
 */
function computeIncomingBatchFilterCounts(rows) {
  const c = { all: 0, upcoming: 0, on_hold: 0, arrived: 0, received: 0, cancelled: 0 };
  for (const row of rows) {
    const st = String(row?.batch?.status || "").trim();
    c.all += 1;
    if (st === "planned" || st === "in_transit") {
      c.upcoming += 1;
    }
    if (st === "on_hold") {
      c.on_hold += 1;
    }
    if (st === "arrived") {
      c.arrived += 1;
    }
    if (st === "received") {
      c.received += 1;
    }
    if (st === "cancelled") {
      c.cancelled += 1;
    }
  }
  return c;
}

function syncIncomingBatchesFilterSelect(counts) {
  const sel = document.getElementById("inv-incoming-batch-filter");
  if (!sel || !(sel instanceof HTMLSelectElement)) {
    return;
  }
  const validIds = new Set(INCOMING_BATCH_FILTER_DEFS.map((d) => d.id));
  let active = String(incomingBatchesFilterId || "upcoming");
  if (!validIds.has(active)) {
    active = "upcoming";
    incomingBatchesFilterId = active;
  }
  for (const def of INCOMING_BATCH_FILTER_DEFS) {
    const opt = sel.querySelector(`option[value="${def.id}"]`);
    if (opt) {
      const countVal = Number(counts?.[def.id]) || 0;
      opt.textContent = `${def.label} (${countVal})`;
    }
  }
  sel.value = active;
}

function renderIncomingBatchesList(payload) {
  const root = document.getElementById("inv-incoming-batches-list");
  if (!root) {
    return;
  }

  lastStockPayloadForIncoming = payload;
  lastIncomingLineLookup = new Map();
  const rows = Array.isArray(payload?.incomingInventory?.rows) ? payload.incomingInventory.rows : [];
  lastIncomingRowsPayload = rows;

  const filterCounts = computeIncomingBatchFilterCounts(rows);
  syncIncomingBatchesFilterSelect(filterCounts);

  if (!rows.length) {
    root.innerHTML = `<p class="admin-muted">No incoming batches yet.</p>`;
    if (incomingDetailsOpenBatchId) {
      incomingDetailsOpenBatchId = null;
      closeIncomingBatchDetailsDialog();
    }
    return;
  }

  const displayRows = rows.filter((row) => incomingBatchRowMatchesFilter(row, incomingBatchesFilterId));

  for (const row of rows) {
    const b = row.batch || {};
    const lines = Array.isArray(row.lines) ? row.lines : [];
    for (const ln of lines) {
      lastIncomingLineLookup.set(String(ln.id), { batch: b, line: ln });
    }
  }

  if (!displayRows.length) {
    const fid = String(incomingBatchesFilterId || "upcoming");
    let emptyMsg = "No incoming batches match this filter.";
    if (fid === "upcoming") {
      emptyMsg = "No upcoming incoming batches.";
    }
    root.innerHTML = `<p class="admin-muted">${emptyMsg}</p>`;
    const reopenId = incomingDetailsOpenBatchId;
    if (reopenId && rows.some((r) => String(r.batch?.id) === String(reopenId))) {
      openIncomingBatchDetailsDialog(reopenId);
    } else if (reopenId) {
      incomingDetailsOpenBatchId = null;
      closeIncomingBatchDetailsDialog();
    }
    return;
  }

  const totEsc = (expCases, expBoxes) => escapeHtml(formatCasesBoxesInStock(expCases, expBoxes));

  const parts = [];
  for (const row of displayRows) {
    const b = row.batch || {};
    const lines = Array.isArray(row.lines) ? row.lines : [];
    const bid = String(b.id || "");
    const st = String(b.status || "").trim();
    const badgeLabel = incomingBatchStatusDisplayLabel(st);
    const badgeClass = incomingBatchStatusBadgeClass(st);

    let expCases = 0;
    let expBoxes = 0;
    for (const ln of lines) {
      expCases += Math.max(0, Math.floor(Number(ln.expected_cases) || 0));
      expBoxes += Math.max(0, Math.floor(Number(ln.expected_boxes) || 0));
    }

    const containerDisp =
      b.container_number != null && String(b.container_number).trim()
        ? escapeHtml(String(b.container_number).trim())
        : "—";
    const poDisp =
      b.po_number != null && String(b.po_number).trim() ? escapeHtml(String(b.po_number).trim()) : "—";
    const supplierDisp =
      b.supplier != null && String(b.supplier).trim() ? escapeHtml(String(b.supplier).trim()) : "—";
    const etaShort =
      b.eta_date != null && String(b.eta_date).trim()
        ? escapeHtml(String(b.eta_date).trim().slice(0, 10))
        : "—";
    const arrivalRaw = b.arrival_date != null ? String(b.arrival_date).trim() : "";
    const arrivalDisp = arrivalRaw ? escapeHtml(arrivalRaw.slice(0, 10)) : "—";

    const actionsHtml = incomingBatchActionsHtml(bid, st);

    let receivedMeta = "";
    if (st === "received") {
      const ra = b.received_at ? formatSoldDateDisplay(b.received_at) : "—";
      const rb = b.received_by != null && String(b.received_by).trim() ? escapeHtml(String(b.received_by).trim()) : "—";
      receivedMeta = `<p class="inv-incoming-batch-card__received-meta">Received ${escapeHtml(ra)} · By ${rb}</p>`;
    }

    parts.push(`<article class="inv-incoming-batch-card inv-incoming-batch-card--compact" data-incoming-batch-card="${escapeHtml(bid)}">
  <div class="inv-incoming-batch-card__header">
    <div class="inv-incoming-batch-card__body">
      <div class="inv-incoming-batch-card__title-row">
        <h4 class="inv-incoming-batch-card__title">${escapeHtml(String(b.batch_name || "Batch"))}</h4>
        <span class="${badgeClass}" aria-label="Status">${escapeHtml(badgeLabel)}</span>
      </div>
      <p class="inv-incoming-batch-card__meta inv-incoming-batch-card__meta-primary">
        <strong>Container:</strong> ${containerDisp} · <strong>PO:</strong> ${poDisp} · <strong>Supplier:</strong> ${supplierDisp}
      </p>
      <p class="inv-incoming-batch-card__meta inv-incoming-batch-card__meta-compact">
        <strong>ETA:</strong> ${etaShort} · <strong>Arrival:</strong> ${arrivalDisp} · <strong>Total expected:</strong> ${totEsc(expCases, expBoxes)}
      </p>
      ${receivedMeta}
    </div>
    <div class="inv-incoming-batch-card__actions">${actionsHtml}</div>
  </div>
</article>`);
  }

  root.innerHTML = parts.join("\n");

  const reopenId = incomingDetailsOpenBatchId;
  if (reopenId && rows.some((r) => String(r.batch?.id) === String(reopenId))) {
    openIncomingBatchDetailsDialog(reopenId);
  } else if (reopenId) {
    incomingDetailsOpenBatchId = null;
    closeIncomingBatchDetailsDialog();
  }
}

function closeIncomingBatchDetailsDialog() {
  const dlg = document.getElementById("inv-incoming-batch-details-dialog");
  if (dlg && typeof dlg.close === "function") {
    dlg.close();
  }
  incomingDetailsOpenBatchId = null;
}

function openIncomingBatchDetailsDialog(batchId) {
  const dlg = document.getElementById("inv-incoming-batch-details-dialog");
  const entry = lastIncomingRowsPayload.find((r) => String(r.batch?.id) === String(batchId));
  if (!dlg || !entry?.batch) {
    return;
  }
  const b = entry.batch;
  const lines = Array.isArray(entry.lines) ? entry.lines : [];
  const st = String(b.status || "").trim();
  const slugToName = buildSlugToCatalogName(lastEditorGroupsCache);

  const heading = document.getElementById("inv-inc-details-heading");
  if (heading) {
    heading.textContent = String(b.batch_name || "Batch");
  }

  const badgeEl = document.getElementById("inv-inc-details-badge");
  if (badgeEl) {
    badgeEl.className = incomingBatchStatusBadgeClass(st);
    badgeEl.textContent = incomingBatchStatusDisplayLabel(st);
  }

  const mp = document.getElementById("inv-inc-details-meta-primary");
  if (mp) {
    const c = b.container_number != null && String(b.container_number).trim() ? String(b.container_number).trim() : "—";
    const p = b.po_number != null && String(b.po_number).trim() ? String(b.po_number).trim() : "—";
    const s = b.supplier != null && String(b.supplier).trim() ? String(b.supplier).trim() : "—";
    mp.textContent = `Container: ${c} · PO: ${p} · Supplier: ${s}`;
  }

  const mt = document.getElementById("inv-inc-details-meta-timing");
  if (mt) {
    const e = b.eta_date != null && String(b.eta_date).trim() ? String(b.eta_date).trim().slice(0, 10) : "—";
    const a =
      b.arrival_date != null && String(b.arrival_date).trim()
        ? String(b.arrival_date).trim().slice(0, 10)
        : "—";
    mt.textContent = `ETA: ${e} · Arrival: ${a}`;
  }

  const tot = document.getElementById("inv-inc-details-total");
  if (tot) {
    let expCases = 0;
    let expBoxes = 0;
    for (const ln of lines) {
      expCases += Math.max(0, Math.floor(Number(ln.expected_cases) || 0));
      expBoxes += Math.max(0, Math.floor(Number(ln.expected_boxes) || 0));
    }
    tot.textContent = `Total expected: ${formatCasesBoxesInStock(expCases, expBoxes)}`;
  }

  const recvEl = document.getElementById("inv-inc-details-received");
  if (recvEl) {
    if (st === "received") {
      const ra = b.received_at ? formatSoldDateDisplay(b.received_at) : "—";
      const rb = b.received_by != null && String(b.received_by).trim() ? String(b.received_by).trim() : "—";
      recvEl.hidden = false;
      recvEl.textContent = `Received ${ra} · By ${rb}`;
    } else {
      recvEl.hidden = true;
      recvEl.textContent = "";
    }
  }

  const notesWrap = document.getElementById("inv-inc-details-notes-wrap");
  if (notesWrap) {
    const notesRaw = b.notes != null ? String(b.notes).trim() : "";
    if (notesRaw) {
      notesWrap.hidden = false;
      notesWrap.innerHTML = incomingBatchDetailsNotesSectionHtml(notesRaw);
    } else {
      notesWrap.hidden = true;
      notesWrap.innerHTML = "";
    }
  }

  const tbody = document.getElementById("inv-inc-details-lines-tbody");
  if (tbody) {
    tbody.innerHTML = incomingBatchDetailsReadonlyLineRowsHtml(lines, st, slugToName);
  }

  incomingDetailsOpenBatchId = String(batchId);
  if (typeof dlg.showModal === "function") {
    dlg.showModal();
  }
}

function closeIncomingBatchEditDialog() {
  const dlg = document.getElementById("inv-incoming-edit-batch-dialog");
  if (dlg && typeof dlg.close === "function") {
    dlg.close();
  }
}

function closeIncomingEditBatchWarningDialog() {
  const dlg = document.getElementById("inv-incoming-edit-warning-dialog");
  if (dlg && typeof dlg.close === "function") {
    dlg.close();
  }
  pendingIncomingEditBatchId = null;
}

function openIncomingEditBatchWarningDialog(batchId) {
  const dlg = document.getElementById("inv-incoming-edit-warning-dialog");
  if (!dlg) {
    return;
  }
  pendingIncomingEditBatchId = String(batchId || "").trim();
  if (!pendingIncomingEditBatchId) {
    return;
  }
  if (typeof dlg.showModal === "function") {
    dlg.showModal();
  }
}

function proceedIncomingEditBatchFromWarning() {
  const id = pendingIncomingEditBatchId;
  pendingIncomingEditBatchId = null;
  const warn = document.getElementById("inv-incoming-edit-warning-dialog");
  if (warn && typeof warn.close === "function") {
    warn.close();
  }
  if (id) {
    openIncomingBatchEditDialog(id);
  }
}

function closeIncomingReleaseHoldWarningDialog() {
  const dlg = document.getElementById("inv-incoming-release-hold-warning-dialog");
  if (dlg && typeof dlg.close === "function") {
    dlg.close();
  }
  pendingReleaseHoldBatchId = null;
}

function openIncomingReleaseHoldWarningDialog(batchId) {
  const dlg = document.getElementById("inv-incoming-release-hold-warning-dialog");
  if (!dlg) {
    return;
  }
  pendingReleaseHoldBatchId = String(batchId || "").trim();
  if (!pendingReleaseHoldBatchId) {
    return;
  }
  if (typeof dlg.showModal === "function") {
    dlg.showModal();
  }
}

/**
 * @param {import("@supabase/supabase-js").Session} session
 */
async function onIncomingReleaseHoldProceed(session) {
  const batchId = pendingReleaseHoldBatchId;
  const dlg = document.getElementById("inv-incoming-release-hold-warning-dialog");
  if (dlg && typeof dlg.close === "function") {
    dlg.close();
  }
  pendingReleaseHoldBatchId = null;
  if (!batchId || !session) {
    return;
  }

  const entry = lastIncomingRowsPayload.find((r) => String(r.batch?.id) === String(batchId));
  if (String(entry?.batch?.status || "").trim() !== "on_hold") {
    setIncomingFeedback("Only on-hold batches can be released.", true);
    return;
  }

  const prevNotes = entry?.batch?.notes ?? "";
  const notes = appendIncomingBatchNote(prevNotes, `[Hold released ${localIsoToday()}]`);
  try {
    await fetchReportPost("/api/admin-inventory", session.access_token, {
      action: "incoming_batch_update",
      id: batchId,
      batch: { status: "arrived", notes },
    });
    await loadStock(session);
    setIncomingFeedback("Hold released. Batch is back in arrived status.", false);
  } catch (e) {
    setIncomingFeedback(e?.message || "Could not release hold.", true);
  }
}

function openIncomingBatchEditDialog(batchId) {
  const dlg = document.getElementById("inv-incoming-edit-batch-dialog");
  const entry = lastIncomingRowsPayload.find((r) => String(r.batch?.id) === String(batchId));
  if (!dlg || !entry?.batch) {
    return;
  }
  const b = entry.batch;

  const idEl = document.getElementById("inv-inc-edit-batch-id");
  if (idEl) {
    idEl.value = String(b.id ?? "");
  }
  const nm = document.getElementById("inv-inc-edit-name");
  if (nm) {
    nm.value = b.batch_name != null ? String(b.batch_name) : "";
  }
  const ct = document.getElementById("inv-inc-edit-container");
  if (ct) {
    ct.value = b.container_number != null ? String(b.container_number) : "";
  }
  const po = document.getElementById("inv-inc-edit-po");
  if (po) {
    po.value = b.po_number != null ? String(b.po_number) : "";
  }
  const sup = document.getElementById("inv-inc-edit-supplier");
  if (sup) {
    sup.value = b.supplier != null ? String(b.supplier) : "";
  }
  const eta = document.getElementById("inv-inc-edit-eta");
  if (eta) {
    eta.value = b.eta_date ? String(b.eta_date).slice(0, 10) : "";
  }
  const arr = document.getElementById("inv-inc-edit-arrival");
  if (arr) {
    arr.value = b.arrival_date ? String(b.arrival_date).slice(0, 10) : "";
  }
  const stEl = document.getElementById("inv-inc-edit-status");
  if (stEl) {
    const st = String(b.status || "planned").trim();
    stEl.value = [...stEl.options].some((o) => o.value === st) ? st : "planned";
  }
  const notes = document.getElementById("inv-inc-edit-notes");
  if (notes) {
    notes.value = b.notes != null ? String(b.notes) : "";
  }

  populateIncomingEditBatchLinesTable(String(b.id ?? ""));

  if (typeof dlg.showModal === "function") {
    dlg.showModal();
  }
}

function closeIncomingLineEditDialog() {
  const dlg = document.getElementById("inv-incoming-edit-line-dialog");
  if (dlg && typeof dlg.close === "function") {
    dlg.close();
  }
}

function openIncomingLineEditDialog(lineId) {
  const dlg = document.getElementById("inv-incoming-edit-line-dialog");
  const found = lastIncomingLineLookup.get(String(lineId));
  if (!dlg || !found?.line) {
    return;
  }
  const ln = found.line;

  const idEl = document.getElementById("inv-inc-edit-line-id");
  if (idEl) {
    idEl.value = String(ln.id ?? "");
  }

  const prodSel = document.getElementById("inv-inc-edit-line-product");
  fillProductSelect(prodSel, lastEditorGroupsCache, { skipPlaceholder: true });
  const pslug = String(ln.product_slug || "").trim();
  if (prodSel && pslug && [...prodSel.options].some((o) => o.value === pslug)) {
    prodSel.value = pslug;
  }

  const sizeSel = document.getElementById("inv-inc-edit-line-size");
  syncSizeSelectForSlug(sizeSel, pslug, lastEditorGroupsCache, String(ln.size || ""));
  const sz = String(ln.size || "").trim();
  if (sizeSel && sz && [...sizeSel.options].some((o) => o.value === sz)) {
    sizeSel.value = sz;
  }

  const ec = document.getElementById("inv-inc-edit-line-exp-cases");
  const eb = document.getElementById("inv-inc-edit-line-exp-boxes");
  if (ec) {
    ec.value = String(Math.max(0, Math.floor(Number(ln.expected_cases) || 0)));
  }
  if (eb) {
    eb.value = String(Math.max(0, Math.floor(Number(ln.expected_boxes) || 0)));
  }

  if (typeof dlg.showModal === "function") {
    dlg.showModal();
  }
}

function closeIncomingReceiveDialog() {
  const dlg = document.getElementById("inv-incoming-receive-dialog");
  if (dlg && typeof dlg.close === "function") {
    dlg.close();
  }
}

function openIncomingReceiveDialog(batchId) {
  const dlg = document.getElementById("inv-incoming-receive-dialog");
  const entry = lastIncomingRowsPayload.find((r) => String(r.batch?.id) === String(batchId));
  if (!dlg || !entry?.batch || String(entry.batch.status || "").trim() !== "arrived") {
    setIncomingFeedback("Only batches in arrived status can be received.", true);
    return;
  }
  const lines = Array.isArray(entry.lines) ? entry.lines : [];
  if (!lines.length) {
    setIncomingFeedback("This batch has no lines to receive.", true);
    return;
  }

  const slugToName = buildSlugToCatalogName(lastEditorGroupsCache);

  const idEl = document.getElementById("inv-inc-receive-batch-id");
  if (idEl) {
    idEl.value = String(batchId);
  }
  const noteEl = document.getElementById("inv-inc-receive-note");
  if (noteEl) {
    noteEl.value = "";
  }

  const tbody = document.getElementById("inv-inc-receive-tbody");
  if (tbody) {
    tbody.innerHTML = lines
      .map((ln) => {
        const slug = String(ln.product_slug || "").trim();
        const pname = escapeHtml(slugToName.get(slug) || slug || "—");
        const sz = escapeHtml(String(ln.size ?? ""));
        const ec = Math.max(0, Math.floor(Number(ln.expected_cases) || 0));
        const eb = Math.max(0, Math.floor(Number(ln.expected_boxes) || 0));
        const lid = escapeHtml(String(ln.id ?? ""));
        return `<tr data-receive-line-id="${lid}">
  <td>${pname}</td>
  <td>${sz}</td>
  <td class="inv-commitments-num">${ec}</td>
  <td class="inv-commitments-num">${eb}</td>
  <td><input type="number" class="inv-inc-recv-cases" min="0" step="1" value="${ec}" aria-label="Received cases" /></td>
  <td><input type="number" class="inv-inc-recv-boxes" min="0" step="1" value="${eb}" aria-label="Received boxes" /></td>
</tr>`;
      })
      .join("");
  }

  if (typeof dlg.showModal === "function") {
    dlg.showModal();
  }
}

function closeIncomingArrivalReviewDialog() {
  const dlg = document.getElementById("inv-incoming-arrival-review-dialog");
  if (dlg && typeof dlg.close === "function") {
    dlg.close();
  }
}

function syncArrivalReviewResults() {
  const tbody = document.getElementById("inv-inc-arrival-review-tbody");
  const mismatchWrap = document.getElementById("inv-inc-arrival-review-mismatch-wrap");
  const issueEl = document.getElementById("inv-inc-arrival-review-issue");
  const confirmBtn = document.getElementById("inv-inc-arrival-review-confirm");
  const holdBtn = document.getElementById("inv-inc-arrival-review-hold");
  if (!tbody) {
    return;
  }

  let allMatch = true;
  for (const tr of tbody.querySelectorAll("tr[data-arrival-line-id]")) {
    const ec = Math.max(0, Math.floor(Number(tr.getAttribute("data-expected-cases")) || 0));
    const eb = Math.max(0, Math.floor(Number(tr.getAttribute("data-expected-boxes")) || 0));
    const acInp = tr.querySelector(".inv-inc-arrival-act-cases");
    const abInp = tr.querySelector(".inv-inc-arrival-act-boxes");
    for (const inp of [acInp, abInp]) {
      if (inp instanceof HTMLInputElement) {
        let v = Number(inp.value);
        if (!Number.isFinite(v)) {
          v = 0;
        }
        v = Math.max(0, Math.floor(v));
        if (inp.value !== String(v)) {
          inp.value = String(v);
        }
      }
    }
    const ac = Math.max(0, Math.floor(Number(acInp?.value) || 0));
    const ab = Math.max(0, Math.floor(Number(abInp?.value) || 0));
    const match = ac === ec && ab === eb;
    if (!match) {
      allMatch = false;
    }
    const cell = tr.querySelector(".inv-arrival-result");
    if (cell) {
      cell.textContent = match ? "Match" : "Mismatch";
      cell.classList.toggle("inv-arrival-result--match", match);
      cell.classList.toggle("inv-arrival-result--mismatch", !match);
    }
  }

  if (mismatchWrap) {
    mismatchWrap.hidden = allMatch;
  }
  if (issueEl && allMatch) {
    issueEl.value = "";
  }

  const issue = String(issueEl?.value || "").trim();
  if (confirmBtn) {
    confirmBtn.disabled = !allMatch;
  }
  if (holdBtn) {
    holdBtn.disabled = allMatch || !issue;
  }
}

function buildArrivalReviewTbodyHtml(lines, slugToName) {
  if (!Array.isArray(lines) || !lines.length) {
    return `<tr><td colspan="6" class="admin-muted">No lines.</td></tr>`;
  }
  return lines
    .map((ln) => {
      const slug = String(ln.product_slug || "").trim();
      const pname = escapeHtml(slugToName.get(slug) || slug || "—");
      const sz = escapeHtml(String(ln.size ?? ""));
      const ec = Math.max(0, Math.floor(Number(ln.expected_cases) || 0));
      const eb = Math.max(0, Math.floor(Number(ln.expected_boxes) || 0));
      const exp = escapeHtml(formatCasesBoxesInStock(ec, eb));
      const lid = escapeHtml(String(ln.id ?? ""));
      return `<tr data-arrival-line-id="${lid}" data-expected-cases="${ec}" data-expected-boxes="${eb}">
  <td>${pname}</td>
  <td>${sz}</td>
  <td class="inv-commitments-num">${exp}</td>
  <td class="inv-commitments-num"><input type="number" class="inv-inc-arrival-act-cases" min="0" step="1" value="${ec}" aria-label="Actual counted cases" /></td>
  <td class="inv-commitments-num"><input type="number" class="inv-inc-arrival-act-boxes" min="0" step="1" value="${eb}" aria-label="Actual counted boxes" /></td>
  <td><span class="inv-arrival-result inv-arrival-result--match">Match</span></td>
</tr>`;
    })
    .join("");
}

function openIncomingArrivalReviewDialog(batchId) {
  const dlg = document.getElementById("inv-incoming-arrival-review-dialog");
  const entry = lastIncomingRowsPayload.find((r) => String(r.batch?.id) === String(batchId));
  const st = String(entry?.batch?.status || "").trim();
  if (!dlg || !entry?.batch || (st !== "planned" && st !== "in_transit")) {
    setIncomingFeedback("Only planned or in-transit batches can go through arrival review.", true);
    return;
  }
  const lines = Array.isArray(entry.lines) ? entry.lines : [];
  if (!lines.length) {
    setIncomingFeedback("This batch has no lines to review.", true);
    return;
  }

  const slugToName = buildSlugToCatalogName(lastEditorGroupsCache);
  const idEl = document.getElementById("inv-inc-arrival-review-batch-id");
  if (idEl) {
    idEl.value = String(batchId);
  }
  const dateEl = document.getElementById("inv-inc-arrival-review-date");
  if (dateEl) {
    dateEl.value = localIsoToday();
  }
  const tbody = document.getElementById("inv-inc-arrival-review-tbody");
  if (tbody) {
    tbody.innerHTML = buildArrivalReviewTbodyHtml(lines, slugToName);
  }
  const issueEl = document.getElementById("inv-inc-arrival-review-issue");
  if (issueEl) {
    issueEl.value = "";
  }
  syncArrivalReviewResults();

  if (typeof dlg.showModal === "function") {
    dlg.showModal();
  }
}

function closeIncomingMarkArrivedDialog() {
  closeIncomingArrivalReviewDialog();
}

function openIncomingMarkArrivedDialog(batchId) {
  openIncomingArrivalReviewDialog(batchId);
}

function closeIncomingPlaceHoldDialog() {
  const dlg = document.getElementById("inv-incoming-place-hold-dialog");
  if (dlg && typeof dlg.close === "function") {
    dlg.close();
  }
}

function openIncomingPlaceHoldDialog(batchId) {
  const dlg = document.getElementById("inv-incoming-place-hold-dialog");
  const entry = lastIncomingRowsPayload.find((r) => String(r.batch?.id) === String(batchId));
  const st = String(entry?.batch?.status || "").trim();
  if (!dlg || !entry?.batch || st !== "arrived") {
    setIncomingFeedback("Only arrived batches can be placed on hold.", true);
    return;
  }
  const idEl = document.getElementById("inv-inc-place-hold-batch-id");
  if (idEl) {
    idEl.value = String(batchId);
  }
  const issueEl = document.getElementById("inv-inc-place-hold-issue");
  if (issueEl) {
    issueEl.value = "";
  }
  if (typeof dlg.showModal === "function") {
    dlg.showModal();
  }
}

/** @param {unknown} existing @param {string} addition */
function appendIncomingBatchNote(existing, addition) {
  const a = String(existing ?? "").trim();
  const b = String(addition ?? "").trim();
  if (!b) {
    return a || null;
  }
  if (!a) {
    return b;
  }
  return `${a}\n\n${b}`;
}

/**
 * @param {import("@supabase/supabase-js").Session} session
 */
async function onIncomingArrivalReviewConfirm(session) {
  const batchId = String(document.getElementById("inv-inc-arrival-review-batch-id")?.value || "").trim();
  const arrival_date = String(document.getElementById("inv-inc-arrival-review-date")?.value || "").trim();
  if (!batchId) {
    return;
  }
  if (!arrival_date) {
    setIncomingFeedback("Select an actual arrival date.", true);
    return;
  }

  syncArrivalReviewResults();
  const tbody = document.getElementById("inv-inc-arrival-review-tbody");
  if (!tbody) {
    return;
  }
  for (const tr of tbody.querySelectorAll("tr[data-arrival-line-id]")) {
    const ec = Math.max(0, Math.floor(Number(tr.getAttribute("data-expected-cases")) || 0));
    const eb = Math.max(0, Math.floor(Number(tr.getAttribute("data-expected-boxes")) || 0));
    const ac = Math.max(0, Math.floor(Number(tr.querySelector(".inv-inc-arrival-act-cases")?.value) || 0));
    const ab = Math.max(0, Math.floor(Number(tr.querySelector(".inv-inc-arrival-act-boxes")?.value) || 0));
    if (ac !== ec || ab !== eb) {
      setIncomingFeedback("All lines must match expected quantities before confirming arrived, or use Place on hold.", true);
      return;
    }
  }

  const entry = lastIncomingRowsPayload.find((r) => String(r.batch?.id) === String(batchId));
  const prevNotes = entry?.batch?.notes ?? "";
  const noteLine = `[Arrival check ${arrival_date}] Physical count matched expected stock.`;
  const notes = appendIncomingBatchNote(prevNotes, noteLine);

  const saveBtn = document.getElementById("inv-inc-arrival-review-confirm");
  try {
    if (saveBtn) {
      saveBtn.disabled = true;
    }
    await fetchReportPost("/api/admin-inventory", session.access_token, {
      action: "incoming_batch_update",
      id: batchId,
      batch: { status: "arrived", arrival_date, notes },
    });
    closeIncomingArrivalReviewDialog();
    await loadStock(session);
    setIncomingFeedback("Shipment marked as arrived after arrival review.", false);
  } catch (e) {
    setIncomingFeedback(e?.message || "Could not complete arrival review.", true);
  } finally {
    if (saveBtn) {
      saveBtn.disabled = false;
    }
  }
}

/**
 * @param {import("@supabase/supabase-js").Session} session
 */
async function onIncomingArrivalReviewPlaceHold(session) {
  const batchId = String(document.getElementById("inv-inc-arrival-review-batch-id")?.value || "").trim();
  const arrival_date = String(document.getElementById("inv-inc-arrival-review-date")?.value || "").trim();
  const issue = String(document.getElementById("inv-inc-arrival-review-issue")?.value || "").trim();
  if (!batchId) {
    return;
  }
  if (!arrival_date) {
    setIncomingFeedback("Select an actual arrival date before placing on hold.", true);
    return;
  }
  if (!issue) {
    setIncomingFeedback("Issue note is required to place on hold after a count mismatch.", true);
    return;
  }

  syncArrivalReviewResults();
  const tbody = document.getElementById("inv-inc-arrival-review-tbody");
  if (!tbody) {
    return;
  }
  const entry = lastIncomingRowsPayload.find((r) => String(r.batch?.id) === String(batchId));
  const lines = Array.isArray(entry?.lines) ? entry.lines : [];
  const byId = new Map(lines.map((ln) => [String(ln.id), ln]));
  let hasMismatch = false;
  const mismatchLines = [];
  const slugToName = buildSlugToCatalogName(lastEditorGroupsCache);
  for (const tr of tbody.querySelectorAll("tr[data-arrival-line-id]")) {
    const lid = String(tr.getAttribute("data-arrival-line-id") || "").trim();
    const ln = byId.get(lid);
    if (!ln) {
      continue;
    }
    const ec = Math.max(0, Math.floor(Number(tr.getAttribute("data-expected-cases")) || 0));
    const eb = Math.max(0, Math.floor(Number(tr.getAttribute("data-expected-boxes")) || 0));
    const ac = Math.max(0, Math.floor(Number(tr.querySelector(".inv-inc-arrival-act-cases")?.value) || 0));
    const ab = Math.max(0, Math.floor(Number(tr.querySelector(".inv-inc-arrival-act-boxes")?.value) || 0));
    const slug = String(ln.product_slug || "").trim();
    const label = slugToName.get(slug) || slug || "—";
    const sz = String(ln.size ?? "");
    if (ac !== ec || ab !== eb) {
      hasMismatch = true;
      mismatchLines.push(`- ${label} (${sz}): expected ${ec} cases ${eb} boxes, counted ${ac} cases ${ab} boxes`);
    }
  }

  if (!hasMismatch) {
    setIncomingFeedback("Counts match expected; use Confirm arrived instead of placing on hold.", true);
    return;
  }

  const prevNotes = entry?.batch?.notes ?? "";
  const block = `[Arrival check ${arrival_date}] Count mismatch found.\n${mismatchLines.join("\n")}\n\nOperator note: ${issue}`;
  const notes = appendIncomingBatchNote(prevNotes, block);

  const holdBtn = document.getElementById("inv-inc-arrival-review-hold");
  try {
    if (holdBtn) {
      holdBtn.disabled = true;
    }
    await fetchReportPost("/api/admin-inventory", session.access_token, {
      action: "incoming_batch_update",
      id: batchId,
      batch: { status: "on_hold", arrival_date, notes },
    });
    closeIncomingArrivalReviewDialog();
    await loadStock(session);
    setIncomingFeedback("Batch placed on hold from arrival review.", false);
  } catch (e) {
    setIncomingFeedback(e?.message || "Could not place batch on hold.", true);
  } finally {
    if (holdBtn) {
      holdBtn.disabled = false;
    }
    syncArrivalReviewResults();
  }
}

/**
 * @param {import("@supabase/supabase-js").Session} session
 */
async function onIncomingPlaceHoldSave(session) {
  const batchId = String(document.getElementById("inv-inc-place-hold-batch-id")?.value || "").trim();
  const issue = String(document.getElementById("inv-inc-place-hold-issue")?.value || "").trim();
  if (!batchId) {
    return;
  }
  if (!issue) {
    setIncomingFeedback("Issue note is required to place a batch on hold.", true);
    return;
  }

  const entry = lastIncomingRowsPayload.find((r) => String(r.batch?.id) === String(batchId));
  const st = String(entry?.batch?.status || "").trim();
  if (st !== "arrived") {
    setIncomingFeedback("Only arrived batches can be placed on hold.", true);
    return;
  }

  const prevNotes = entry?.batch?.notes ?? "";
  const notes = appendIncomingBatchNote(prevNotes, `[On hold] ${issue}`);

  const saveBtn = document.getElementById("inv-inc-place-hold-save");
  try {
    if (saveBtn) {
      saveBtn.disabled = true;
    }
    await fetchReportPost("/api/admin-inventory", session.access_token, {
      action: "incoming_batch_update",
      id: batchId,
      batch: { status: "on_hold", notes },
    });
    closeIncomingPlaceHoldDialog();
    await loadStock(session);
    setIncomingFeedback("Batch placed on hold.", false);
  } catch (e) {
    setIncomingFeedback(e?.message || "Could not place batch on hold.", true);
  } finally {
    if (saveBtn) {
      saveBtn.disabled = false;
    }
  }
}

/**
 * @param {import("@supabase/supabase-js").Session} session
 */
async function onSaveIncomingBatch(session) {
  const batch_name = String(document.getElementById("inv-inc-batch-name")?.value || "").trim();
  if (!batch_name) {
    setIncomingFeedback("Batch name is required.", true);
    return;
  }
  if (!pendingIncomingLines.length) {
    setIncomingFeedback("Add at least one expected stock line.", true);
    return;
  }

  const status = String(document.getElementById("inv-inc-status")?.value || "planned").trim();
  if (status !== "planned" && status !== "in_transit") {
    setIncomingFeedback("New batches can only be created as planned or in transit.", true);
    return;
  }

  const etaRaw = String(document.getElementById("inv-inc-eta")?.value || "").trim();

  const batchPayload = {
    batch_name,
    container_number: String(document.getElementById("inv-inc-container")?.value || "").trim() || null,
    po_number: String(document.getElementById("inv-inc-po")?.value || "").trim() || null,
    supplier: String(document.getElementById("inv-inc-supplier")?.value || "").trim() || null,
    eta_date: etaRaw || null,
    status,
    notes: String(document.getElementById("inv-inc-notes")?.value || "").trim() || null,
  };

  const btn = document.getElementById("inv-inc-save-batch");
  try {
    if (btn) {
      btn.disabled = true;
    }
    setIncomingFeedback("", false);

    const created = await fetchReportPost("/api/admin-inventory", session.access_token, {
      action: "incoming_batch_create",
      batch: batchPayload,
    });

    const batchObj = created?.batch;
    const newId = batchObj?.id != null ? String(batchObj.id) : "";
    if (!newId) {
      throw new Error("Server did not return a batch id.");
    }

    for (const line of pendingIncomingLines) {
      await fetchReportPost("/api/admin-inventory", session.access_token, {
        action: "incoming_batch_line_create",
        batch_id: newId,
        line: {
          product_slug: line.product_slug,
          size: line.size,
          expected_cases: line.expected_cases,
          expected_boxes: line.expected_boxes,
        },
      });
    }

    pendingIncomingLines = [];
    renderIncomingPendingLinesTable();
    document.getElementById("inv-inc-batch-name").value = "";
    document.getElementById("inv-inc-container").value = "";
    document.getElementById("inv-inc-po").value = "";
    document.getElementById("inv-inc-supplier").value = "";
    document.getElementById("inv-inc-eta").value = "";
    document.getElementById("inv-inc-status").value = "planned";
    document.getElementById("inv-inc-notes").value = "";

    await loadStock(session);
    setIncomingFeedback("Incoming batch saved.", false);
  } catch (e) {
    setIncomingFeedback(e?.message || "Could not save incoming batch.", true);
  } finally {
    if (btn) {
      btn.disabled = false;
    }
  }
}

/**
 * @param {import("@supabase/supabase-js").Session} session
 */
async function onIncomingBatchEditSave(session) {
  const id = String(document.getElementById("inv-inc-edit-batch-id")?.value || "").trim();
  if (!id) {
    return;
  }

  const status = String(document.getElementById("inv-inc-edit-status")?.value || "").trim();
  if (status === "received") {
    setIncomingFeedback("Cannot set status to received from edit.", true);
    return;
  }

  const etaRaw = String(document.getElementById("inv-inc-edit-eta")?.value || "").trim();
  const arrivalRaw = String(document.getElementById("inv-inc-edit-arrival")?.value || "").trim();

  const batchPayload = {
    batch_name: String(document.getElementById("inv-inc-edit-name")?.value || "").trim(),
    container_number: String(document.getElementById("inv-inc-edit-container")?.value || "").trim() || null,
    po_number: String(document.getElementById("inv-inc-edit-po")?.value || "").trim() || null,
    supplier: String(document.getElementById("inv-inc-edit-supplier")?.value || "").trim() || null,
    eta_date: etaRaw || null,
    arrival_date: arrivalRaw || null,
    status,
    notes: String(document.getElementById("inv-inc-edit-notes")?.value || "").trim() || null,
  };

  if (!batchPayload.batch_name) {
    setIncomingFeedback("Batch name is required.", true);
    return;
  }

  const saveBtn = document.getElementById("inv-inc-edit-batch-save");
  try {
    if (saveBtn) {
      saveBtn.disabled = true;
    }
    await fetchReportPost("/api/admin-inventory", session.access_token, {
      action: "incoming_batch_update",
      id,
      batch: batchPayload,
    });
    closeIncomingBatchEditDialog();
    await loadStock(session);
    setIncomingFeedback("Batch updated.", false);
  } catch (e) {
    setIncomingFeedback(e?.message || "Could not update batch.", true);
  } finally {
    if (saveBtn) {
      saveBtn.disabled = false;
    }
  }
}

/**
 * @param {import("@supabase/supabase-js").Session} session
 */
async function onIncomingLineEditSave(session) {
  const id = String(document.getElementById("inv-inc-edit-line-id")?.value || "").trim();
  if (!id) {
    return;
  }

  const product_slug = String(document.getElementById("inv-inc-edit-line-product")?.value || "").trim();
  const size = String(document.getElementById("inv-inc-edit-line-size")?.value || "").trim();
  const expected_cases = Math.max(0, Math.floor(Number(document.getElementById("inv-inc-edit-line-exp-cases")?.value) || 0));
  const expected_boxes = Math.max(0, Math.floor(Number(document.getElementById("inv-inc-edit-line-exp-boxes")?.value) || 0));

  if (!product_slug || !size) {
    setIncomingFeedback("Edit line: select product and size.", true);
    return;
  }
  if (expected_cases <= 0 && expected_boxes <= 0) {
    setIncomingFeedback("Edit line: at least one expected case or box.", true);
    return;
  }

  const saveBtn = document.getElementById("inv-inc-edit-line-save");
  try {
    if (saveBtn) {
      saveBtn.disabled = true;
    }
    await fetchReportPost("/api/admin-inventory", session.access_token, {
      action: "incoming_batch_line_update",
      id,
      line: { product_slug, size, expected_cases, expected_boxes },
    });
    closeIncomingLineEditDialog();
    await loadStock(session);
    setIncomingFeedback("Line updated.", false);
  } catch (e) {
    setIncomingFeedback(e?.message || "Could not update line.", true);
  } finally {
    if (saveBtn) {
      saveBtn.disabled = false;
    }
  }
}

/**
 * @param {import("@supabase/supabase-js").Session} session
 */
async function onIncomingReceiveConfirm(session) {
  const batchId = String(document.getElementById("inv-inc-receive-batch-id")?.value || "").trim();
  const tbody = document.getElementById("inv-inc-receive-tbody");
  if (!batchId || !tbody) {
    return;
  }

  /** @type {{ line_id: string, received_cases: number, received_boxes: number }[]} */
  const lines = [];
  let total = 0;

  for (const tr of tbody.querySelectorAll("tr[data-receive-line-id]")) {
    const line_id = String(tr.getAttribute("data-receive-line-id") || "").trim();
    const rc = Math.max(0, Math.floor(Number(tr.querySelector(".inv-inc-recv-cases")?.value) || 0));
    const rb = Math.max(0, Math.floor(Number(tr.querySelector(".inv-inc-recv-boxes")?.value) || 0));
    lines.push({ line_id, received_cases: rc, received_boxes: rb });
    total += rc + rb;
  }

  if (!lines.length) {
    setIncomingFeedback("No lines to receive.", true);
    return;
  }
  if (total < 1) {
    setIncomingFeedback("Total received quantity must be greater than zero.", true);
    return;
  }

  const note = String(document.getElementById("inv-inc-receive-note")?.value || "").trim() || null;

  const confirmBtn = document.getElementById("inv-inc-receive-confirm");
  try {
    if (confirmBtn) {
      confirmBtn.disabled = true;
    }
    await fetchReportPost("/api/admin-inventory", session.access_token, {
      action: "incoming_batch_receive",
      id: batchId,
      lines,
      note,
    });
    closeIncomingReceiveDialog();
    await loadStock(session);
    setIncomingFeedback("Batch received into physical stock.", false);
  } catch (e) {
    setIncomingFeedback(e?.message || "Receive failed.", true);
  } finally {
    if (confirmBtn) {
      confirmBtn.disabled = false;
    }
  }
}

/**
 * @param {import("@supabase/supabase-js").Session} session
 * @param {HTMLElement} btn
 */
async function handleIncomingSectionClick(session, btn) {
  const action = btn.getAttribute("data-incoming-action");
  const batchId = btn.getAttribute("data-batch-id");
  const lineId = btn.getAttribute("data-line-id");

  try {
    if (action === "view-batch" && batchId) {
      openIncomingBatchDetailsDialog(batchId);
      return;
    }
    if (action === "edit-batch" && batchId) {
      openIncomingEditBatchWarningDialog(batchId);
      return;
    }
    if (action === "receive-batch" && batchId) {
      openIncomingReceiveDialog(batchId);
      return;
    }
    if (action === "edit-line" && lineId) {
      openIncomingLineEditDialog(lineId);
      return;
    }

    if (action === "delete-batch" && batchId) {
      if (
        !window.confirm(
          "Delete this incoming batch? Only planned batches can be deleted. Lines will be removed with the batch.",
        )
      ) {
        return;
      }
      await fetchReportPost("/api/admin-inventory", session.access_token, {
        action: "incoming_batch_delete",
        id: batchId,
      });
      await loadStock(session);
      setIncomingFeedback("Batch deleted.", false);
      closeIncomingBatchEditDialog();
      return;
    }

    if (action === "cancel-batch" && batchId) {
      if (
        !window.confirm(
          "Cancel this incoming batch? It will no longer count toward incoming stock. This does not change physical inventory.",
        )
      ) {
        return;
      }
      await fetchReportPost("/api/admin-inventory", session.access_token, {
        action: "incoming_batch_update",
        id: batchId,
        batch: { status: "cancelled" },
      });
      await loadStock(session);
      setIncomingFeedback("Batch cancelled.", false);
      return;
    }

    if (action === "delete-line" && lineId && batchId) {
      const entry = lastIncomingRowsPayload.find((r) => String(r.batch?.id) === String(batchId));
      const n = Array.isArray(entry?.lines) ? entry.lines.length : 0;
      if (n <= 1) {
        setIncomingFeedback("Cannot delete the last line. Add another line first or delete the whole batch.", true);
        return;
      }
      if (!window.confirm("Delete this expected line from the batch?")) {
        return;
      }
      await fetchReportPost("/api/admin-inventory", session.access_token, {
        action: "incoming_batch_line_delete",
        id: lineId,
      });
      await loadStock(session);
      setIncomingFeedback("Line deleted.", false);
      return;
    }

    if (action === "mark-in_transit" && batchId) {
      await fetchReportPost("/api/admin-inventory", session.access_token, {
        action: "incoming_batch_update",
        id: batchId,
        batch: { status: "in_transit" },
      });
      await loadStock(session);
      setIncomingFeedback("Marked in transit.", false);
      return;
    }

    if (action === "mark-arrived" && batchId) {
      openIncomingMarkArrivedDialog(batchId);
      return;
    }

    if (action === "place-on-hold" && batchId) {
      openIncomingPlaceHoldDialog(batchId);
      return;
    }

    if (action === "release-hold" && batchId) {
      const entry = lastIncomingRowsPayload.find((r) => String(r.batch?.id) === String(batchId));
      if (String(entry?.batch?.status || "").trim() !== "on_hold") {
        setIncomingFeedback("Only on-hold batches can be released.", true);
        return;
      }
      openIncomingReleaseHoldWarningDialog(batchId);
      return;
    }
  } catch (e) {
    setIncomingFeedback(e?.message || "Action failed.", true);
  }
}

function renderPendingOrderLinesTable() {
  const tbody = document.getElementById("inv-pending-lines-tbody");
  if (!tbody) {
    return;
  }
  if (!pendingOrderLines.length) {
    tbody.innerHTML = `<tr><td colspan="4" class="admin-muted">No lines yet. Add one or more products above.</td></tr>`;
    return;
  }
  tbody.innerHTML = pendingOrderLines
    .map((line) => {
      const qty = formatCasesBoxesInStock(line.quantity_cases, line.quantity_boxes);
      return `<tr>
  <td>${escapeHtml(line.productLabel)}</td>
  <td>${escapeHtml(line.size)}</td>
  <td class="inv-commitments-num">${escapeHtml(qty)}</td>
  <td><button type="button" class="admin-btn admin-btn--small" data-pending-remove="${escapeHtml(String(line.localId))}">Remove</button></td>
</tr>`;
    })
    .join("");
}

function onAddOrderLine() {
  const slug = String(document.getElementById("inv-order-line-product")?.value || "").trim();
  const size = String(document.getElementById("inv-order-line-size")?.value || "").trim();
  const quantity_cases = Math.max(0, Math.floor(Number(document.getElementById("inv-order-line-cases")?.value) || 0));
  const quantity_boxes = Math.max(0, Math.floor(Number(document.getElementById("inv-order-line-boxes")?.value) || 0));

  if (!slug || !size) {
    setCommitFeedback("Select a product and size for the line.", true);
    return;
  }
  if (quantity_cases <= 0 && quantity_boxes <= 0) {
    setCommitFeedback("Enter at least one case or box for the line.", true);
    return;
  }

  const g = lastEditorGroupsCache.find((x) => String(x.productSlug || "").trim() === slug);
  const productLabel = String(g?.catalogProductName ?? g?.productSlug ?? slug);

  pendingOrderLines.push({
    localId: `p${pendingLineSeq++}`,
    product_slug: slug,
    size,
    productLabel,
    quantity_cases,
    quantity_boxes,
  });

  const casesEl = document.getElementById("inv-order-line-cases");
  const boxesEl = document.getElementById("inv-order-line-boxes");
  if (casesEl) {
    casesEl.value = "0";
  }
  if (boxesEl) {
    boxesEl.value = "0";
  }
  setCommitFeedback("", false);
  renderPendingOrderLinesTable();
}

/**
 * @param {import("@supabase/supabase-js").Session} session
 */
async function onSaveOrderCommitments(session) {
  const channel = String(document.getElementById("inv-order-channel")?.value || "amazon_fbm").trim();
  const externalRaw = String(document.getElementById("inv-order-external-id")?.value || "").trim();
  const soldDate = String(document.getElementById("inv-order-sold-at")?.value || "").trim();
  const notesRaw = String(document.getElementById("inv-order-notes")?.value || "").trim();

  const external_order_id = externalRaw || null;
  const sold_at = soldDate ? `${soldDate}T12:00:00.000Z` : null;
  const notes = notesRaw || null;

  if (!pendingOrderLines.length) {
    setCommitFeedback("Add at least one line item before saving.", true);
    return;
  }

  const btn = document.getElementById("inv-order-save-commitments");
  try {
    if (btn) {
      btn.disabled = true;
    }
    setCommitFeedback("", false);
    for (const line of pendingOrderLines) {
      await fetchReportPost("/api/admin-inventory", session.access_token, {
        action: "channel_commitment_create",
        commitment: {
          channel,
          external_order_id,
          product_slug: line.product_slug,
          size: line.size,
          quantity_cases: line.quantity_cases,
          quantity_boxes: line.quantity_boxes,
          status: "unshipped",
          sold_at,
          notes,
        },
      });
    }
    const n = pendingOrderLines.length;
    const chLabel = salesChannelLabel(channel);
    pendingOrderLines = [];
    renderPendingOrderLinesTable();
    const extEl = document.getElementById("inv-order-external-id");
    const soldEl = document.getElementById("inv-order-sold-at");
    const notesEl = document.getElementById("inv-order-notes");
    if (extEl) {
      extEl.value = "";
    }
    if (soldEl) {
      soldEl.value = "";
    }
    if (notesEl) {
      notesEl.value = "";
    }
    await loadStock(session);
    setCommitFeedback(`Added ${n} commitment line${n === 1 ? "" : "s"} for ${chLabel} order.`, false);
  } catch (e) {
    setCommitFeedback(e?.message || "Save stopped on error. Fix and try again.", true);
  } finally {
    if (btn) {
      btn.disabled = false;
    }
  }
}

function openCommitmentEditDialog(commitmentId) {
  const dlg = document.getElementById("inv-commit-edit-dialog");
  const row = lastCommitmentRowsCache.find((x) => String(x.id) === String(commitmentId));
  if (!dlg || !row) {
    return;
  }

  const idEl = document.getElementById("inv-edit-commit-id");
  if (idEl) {
    idEl.value = String(row.id ?? "");
  }

  const chEl = document.getElementById("inv-edit-channel");
  if (chEl) {
    const ch = String(row.channel || "amazon_fbm").trim();
    chEl.value = [...chEl.options].some((o) => o.value === ch) ? ch : "amazon_fbm";
  }

  const extEl = document.getElementById("inv-edit-external-id");
  if (extEl) {
    extEl.value = row.external_order_id != null ? String(row.external_order_id) : "";
  }

  const prodSel = document.getElementById("inv-edit-product");
  fillProductSelect(prodSel, lastEditorGroupsCache, { skipPlaceholder: true });
  const pslug = String(row.product_slug || "").trim();
  if (prodSel && pslug && [...prodSel.options].some((o) => o.value === pslug)) {
    prodSel.value = pslug;
  }

  const sizeSel = document.getElementById("inv-edit-size");
  syncSizeSelectForSlug(sizeSel, pslug, lastEditorGroupsCache, String(row.size || ""));
  const sz = String(row.size || "").trim();
  if (sizeSel && sz && [...sizeSel.options].some((o) => o.value === sz)) {
    sizeSel.value = sz;
  }

  const casesEl = document.getElementById("inv-edit-cases");
  const boxesEl = document.getElementById("inv-edit-boxes");
  if (casesEl) {
    casesEl.value = String(Math.max(0, Math.floor(Number(row.quantity_cases) || 0)));
  }
  if (boxesEl) {
    boxesEl.value = String(Math.max(0, Math.floor(Number(row.quantity_boxes) || 0)));
  }

  const soldEl = document.getElementById("inv-edit-sold-at");
  if (soldEl) {
    const iso = row.sold_at ? String(row.sold_at) : "";
    soldEl.value = iso && iso.length >= 10 ? iso.slice(0, 10) : "";
  }

  const notesEl = document.getElementById("inv-edit-notes");
  if (notesEl) {
    notesEl.value = row.notes != null ? String(row.notes) : "";
  }

  if (typeof dlg.showModal === "function") {
    dlg.showModal();
  }
}

function closeCommitmentEditDialog() {
  const dlg = document.getElementById("inv-commit-edit-dialog");
  if (dlg && typeof dlg.close === "function") {
    dlg.close();
  }
}

/**
 * @param {import("@supabase/supabase-js").Session} session
 */
async function onCommitmentEditSave(session) {
  const id = String(document.getElementById("inv-edit-commit-id")?.value || "").trim();
  if (!id) {
    return;
  }

  const channel = String(document.getElementById("inv-edit-channel")?.value || "amazon_fbm").trim();
  const externalRaw = String(document.getElementById("inv-edit-external-id")?.value || "").trim();
  const product_slug = String(document.getElementById("inv-edit-product")?.value || "").trim();
  const size = String(document.getElementById("inv-edit-size")?.value || "").trim();
  const quantity_cases = Math.max(0, Math.floor(Number(document.getElementById("inv-edit-cases")?.value) || 0));
  const quantity_boxes = Math.max(0, Math.floor(Number(document.getElementById("inv-edit-boxes")?.value) || 0));
  const soldDate = String(document.getElementById("inv-edit-sold-at")?.value || "").trim();
  const notesRaw = String(document.getElementById("inv-edit-notes")?.value || "").trim();

  if (!product_slug || !size) {
    setCommitFeedback("Edit: select product and size.", true);
    return;
  }
  if (quantity_cases <= 0 && quantity_boxes <= 0) {
    setCommitFeedback("Edit: enter at least one case or box.", true);
    return;
  }

  const sold_at = soldDate ? `${soldDate}T12:00:00.000Z` : null;
  const notes = notesRaw || null;
  const external_order_id = externalRaw || null;

  const saveBtn = document.getElementById("inv-commit-edit-save");
  try {
    if (saveBtn) {
      saveBtn.disabled = true;
    }
    await fetchReportPost("/api/admin-inventory", session.access_token, {
      action: "channel_commitment_update",
      id,
      commitment: {
        channel,
        external_order_id,
        product_slug,
        size,
        quantity_cases,
        quantity_boxes,
        sold_at,
        notes,
      },
    });
    closeCommitmentEditDialog();
    setCommitFeedback("Commitment updated.", false);
    await loadStock(session);
  } catch (e) {
    setCommitFeedback(e?.message || "Could not save edits.", true);
  } finally {
    if (saveBtn) {
      saveBtn.disabled = false;
    }
  }
}

function setCommitFeedback(text, isError) {
  const el = document.getElementById("inv-commit-feedback");
  if (!el) {
    return;
  }
  if (!text) {
    el.hidden = true;
    el.textContent = "";
    el.classList.remove("inv-commit-feedback--error");
    return;
  }
  el.hidden = false;
  el.textContent = text;
  el.classList.toggle("inv-commit-feedback--error", Boolean(isError));
}

/**
 * @param {object} payload
 */
function renderOpenCommitmentsTable(payload) {
  const tbody = document.getElementById("inv-commitments-tbody");
  if (!tbody) {
    return;
  }
  const rows = Array.isArray(payload?.salesChannelCommitments?.rows) ? [...payload.salesChannelCommitments.rows] : [];
  const slugToName = buildSlugToCatalogName(payload?.editor?.groups || []);

  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="4" class="admin-muted">No open external commitments.</td></tr>`;
    return;
  }

  rows.sort((a, b) => {
    const ka = commitmentGroupSortKey(a);
    const kb = commitmentGroupSortKey(b);
    if (ka !== kb) {
      return ka.localeCompare(kb);
    }
    const pa = String(a.product_slug || "");
    const pb = String(b.product_slug || "");
    if (pa !== pb) {
      return pa.localeCompare(pb);
    }
    return String(a.size || "").localeCompare(String(b.size || ""));
  });

  /** @type {string[]} */
  const html = [];
  let lastGroupKey = null;

  for (const r of rows) {
    const gkey = commitmentGroupSortKey(r);
    if (gkey !== lastGroupKey) {
      lastGroupKey = gkey;
      const chLabel = escapeHtml(salesChannelLabel(r.channel));
      const extDisp =
        r.external_order_id != null && String(r.external_order_id).trim()
          ? escapeHtml(String(r.external_order_id).trim())
          : "—";
      const sold = escapeHtml(formatSoldDateDisplay(r.sold_at));
      const noteTxt =
        r.notes != null && String(r.notes).trim() ? escapeHtml(String(r.notes).trim()) : "—";
      html.push(`<tr class="inv-commit-group-header">
  <td colspan="4" class="inv-commit-group-header__cell">
    <div class="inv-commit-group-header__title">${chLabel} · <span class="inv-commit-group-header__id">${extDisp}</span></div>
    <div class="inv-commit-group-header__meta">Sold date: ${sold} · Notes: ${noteTxt}</div>
  </td>
</tr>`);
    }

    const id = escapeHtml(String(r.id ?? ""));
    const slug = String(r.product_slug ?? "").trim();
    const pname = escapeHtml(slugToName.get(slug) || slug || "—");
    const qty = escapeHtml(
      formatCasesBoxesInStock(
        Math.max(0, Math.floor(Number(r.quantity_cases) || 0)),
        Math.max(0, Math.floor(Number(r.quantity_boxes) || 0)),
      ),
    );

    html.push(`<tr class="inv-commit-line-row">
  <td>${pname}</td>
  <td>${escapeHtml(String(r.size ?? ""))}</td>
  <td class="inv-commitments-num">${qty}</td>
  <td class="inv-commitments-actions">
    <button type="button" class="admin-btn admin-btn--small" data-commit-action="edit" data-commit-id="${id}">Edit</button>
    <button type="button" class="admin-btn admin-btn--small" data-commit-action="ship" data-commit-id="${id}">Mark shipped</button>
    <button type="button" class="admin-btn admin-btn--small" data-commit-action="cancel" data-commit-id="${id}">Cancel</button>
    <button type="button" class="admin-btn admin-btn--small" data-commit-action="delete" data-commit-id="${id}">Delete</button>
  </td>
</tr>`);
  }

  tbody.innerHTML = html.join("");
}

/**
 * @typedef {"in_stock" | "low" | "empty" | "review"} InvHealthStatus
 */

/**
 * @param {object} payload
 * @returns {{ rows: object[], lowCount: number, emptyCount: number }}
 */
function buildInventoryHealthRows(payload) {
  const editor = payload?.editor || null;
  const groups = Array.isArray(editor?.groups) ? editor.groups : [];
  const index = buildLineIndex(payload?.lines);

  /** @type {object[]} */
  const rows = [];
  let lowCount = 0;
  let emptyCount = 0;

  for (const g of groups) {
    const slug = String(g.productSlug || "").trim();
    const bpc = Math.max(1, Math.floor(Number(g.boxesPerCase) || 10));
    const productName = g.catalogProductName ?? g.productSlug ?? "";
    const list = Array.isArray(g.rows) ? g.rows : [];

    for (const r of list) {
      const size = String(r.size || "").trim();
      if (!slug || !size) {
        continue;
      }
      const { caseLine, boxLine } = getVariantLines(index, slug, size);

      const physC = Math.max(0, Math.floor(Number(r.casesOnHand) || 0));
      const physB = Math.max(0, Math.floor(Number(r.boxesOnHand) || 0));
      const resC = caseLine ? Math.max(0, Math.floor(Number(caseLine.reserved) || 0)) : 0;
      const resB = boxLine ? Math.max(0, Math.floor(Number(boxLine.reserved) || 0)) : 0;

      const physicalStr = formatCasesBoxesInStock(physC, physB);
      const reservedStr = formatCasesBoxesInStock(resC, resB);

      const review = variantNeedsReview(caseLine, boxLine);
      const sellable = sellableBoxEquivalent(caseLine, boxLine, bpc);
      const thresholdBoxes = variantLowThresholdBoxes(caseLine, boxLine, bpc);

      /** @type {InvHealthStatus} */
      let status = "in_stock";
      let availableStr = "—";

      if (!trackedLine(caseLine) && !trackedLine(boxLine)) {
        status = "review";
        availableStr = "—";
      } else if (review) {
        status = "review";
        const eq = sellable == null ? 0 : sellable;
        const { cases: ac, boxes: ab } = formatCasesBoxesFromBoxEquivalent(eq, bpc);
        availableStr = formatCasesBoxesInStock(ac, ab);
      } else if (sellable == null) {
        status = "review";
      } else if (sellable <= 0) {
        status = "empty";
        emptyCount += 1;
        const { cases: ac, boxes: ab } = formatCasesBoxesFromBoxEquivalent(sellable, bpc);
        availableStr = formatCasesBoxesInStock(ac, ab);
      } else if (sellable <= thresholdBoxes) {
        status = "low";
        lowCount += 1;
        const { cases: ac, boxes: ab } = formatCasesBoxesFromBoxEquivalent(sellable, bpc);
        availableStr = formatCasesBoxesInStock(ac, ab);
      } else {
        const { cases: ac, boxes: ab } = formatCasesBoxesFromBoxEquivalent(sellable, bpc);
        availableStr = formatCasesBoxesInStock(ac, ab);
      }

      rows.push({
        productSlug: slug,
        productName,
        size,
        physicalStr,
        reservedStr,
        availableStr,
        status,
      });
    }
  }

  return { rows, lowCount, emptyCount };
}

function statusBadgeClass(status) {
  switch (status) {
    case "empty":
      return "inv-badge inv-badge--empty";
    case "low":
      return "inv-badge inv-badge--low";
    case "review":
      return "inv-badge inv-badge--review";
    default:
      return "inv-badge inv-badge--ok";
  }
}

function statusLabel(status) {
  switch (status) {
    case "empty":
      return "Empty";
    case "low":
      return "Low stock";
    case "review":
      return "Review";
    default:
      return "In stock";
  }
}

/**
 * @param {object} payload
 */
function renderInventoryHealthTable(payload) {
  const tbody = document.getElementById("inv-health-tbody");
  if (!tbody) {
    return;
  }
  const { rows } = buildInventoryHealthRows(payload);

  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="admin-muted">No catalog products.</td></tr>`;
    return;
  }

  tbody.innerHTML = rows
    .map((r, i) => {
      const next = rows[i + 1];
      const slugCur = String(r.productSlug || "").trim();
      const slugNext = next ? String(next.productSlug || "").trim() : "";
      const isGroupEnd = !next || slugNext !== slugCur;
      const rowClass = isGroupEnd ? ' class="inv-health-row--group-end"' : "";
      return `<tr${rowClass}>
  <td class="inv-health-product">${escapeHtml(r.productName)}</td>
  <td class="inv-health-size">${escapeHtml(r.size)}</td>
  <td class="inv-health-num">${escapeHtml(r.physicalStr)}</td>
  <td class="inv-health-num">${escapeHtml(r.reservedStr)}</td>
  <td class="inv-health-num">${escapeHtml(r.availableStr)}</td>
  <td><span class="${statusBadgeClass(r.status)}">${escapeHtml(statusLabel(r.status))}</span></td>
</tr>`;
    })
    .join("");
}

/**
 * @param {object | null | undefined} payload
 */
function renderInventoryDashboardSummary(payload) {
  const overview = payload?.overview || null;
  const s = overview?.summary || {};
  const amz = payload?.salesChannelCommitments?.byChannel?.amazon_fbm || {};
  const amzCases = Math.max(0, Math.floor(Number(amz.unshippedCases) || 0));
  const amzBoxes = Math.max(0, Math.floor(Number(amz.unshippedBoxes) || 0));

  const physicalEl = document.getElementById("inv-kpi-physical");
  const ordersShipEl = document.getElementById("inv-kpi-orders-ship");
  const amazonShipEl = document.getElementById("inv-kpi-amazon-ship");
  const incomingEl = document.getElementById("inv-kpi-incoming");
  const availableEl = document.getElementById("inv-kpi-available");
  const lowEmptyEl = document.getElementById("inv-kpi-low-empty");
  const orderNote = document.getElementById("inv-order-metrics-note");

  const incSummary = payload?.incomingInventory?.summary || {};
  const incomingCases = Math.max(0, Math.floor(Number(incSummary.incomingCases) || 0));
  const incomingBoxes = Math.max(0, Math.floor(Number(incSummary.incomingBoxes) || 0));

  if (incomingEl) {
    incomingEl.innerHTML = formatCasesBoxesKpiHtml(incomingCases, incomingBoxes);
    incomingEl.title =
      "Sum of expected cases/boxes on batches in planned, in transit, arrived, or on hold — not physical stock until received.";
  }

  if (physicalEl) {
    physicalEl.innerHTML = formatCasesBoxesKpiHtml(s.remainingCases ?? 0, s.remainingBoxes ?? 0);
    physicalEl.title = "";
  }

  if (ordersShipEl) {
    ordersShipEl.innerHTML = formatCasesBoxesKpiHtml(s.toShipCases ?? 0, s.toShipBoxes ?? 0);
    if (s.toShipMixedPackSizes) {
      ordersShipEl.title = "Paid/unshipped rows in Supabase orders (store/admin flows); mixed boxes-per-case totals.";
    } else {
      ordersShipEl.title = "";
    }
  }

  if (amazonShipEl) {
    amazonShipEl.innerHTML = formatCasesBoxesKpiHtml(amzCases, amzBoxes);
    amazonShipEl.title = "Sum of unshipped sales_channel_commitments for channel amazon_fbm (raw cases/boxes).";
  }

  if (orderNote) {
    if (s.orderMetricsAvailable === false) {
      orderNote.hidden = false;
      orderNote.textContent =
        "Open Orders To Be Shipped needs Supabase server credentials (SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY).";
    } else {
      orderNote.hidden = true;
      orderNote.textContent = "";
    }
  }

  const editor = payload?.editor || null;
  const groups = Array.isArray(editor?.groups) ? editor.groups : [];
  const refBpc = referenceBoxesPerCaseFromEditor(groups);
  const avail = estimatedAvailableCasesBoxes(
    s.remainingCases ?? 0,
    s.remainingBoxes ?? 0,
    s.toShipCases ?? 0,
    s.toShipBoxes ?? 0,
    amzCases,
    amzBoxes,
    refBpc,
  );

  if (availableEl) {
    availableEl.innerHTML = formatCasesBoxesKpiHtml(avail.cases, avail.boxes);
    const mixedCatalog = hasMixedBoxesPerCaseInEditor(groups);
    if (mixedCatalog || s.toShipMixedPackSizes) {
      availableEl.title =
        "Physical minus open orders minus Amazon FBM, using one reference pack size for rollover; approximate when catalog mixes boxes-per-case.";
    } else {
      availableEl.title = "";
    }
  }

  const { lowCount, emptyCount } = buildInventoryHealthRows(payload);
  if (lowEmptyEl) {
    lowEmptyEl.innerHTML = `<span class="inv-summary__figures-row">${escapeHtml(String(lowCount))} low</span><span class="inv-summary__figures-row">${escapeHtml(String(emptyCount))} empty</span>`;
  }
}

/**
 * @param {object | null | undefined} editor
 */
function renderEditorTable(editor) {
  const root = document.getElementById("inv-editor-groups");
  if (!root) {
    return;
  }
  const groups = Array.isArray(editor?.groups) ? editor.groups : [];

  if (!groups.length) {
    root.innerHTML = `<p class="admin-muted inv-editor-groups-empty">No catalog products.</p>`;
    return;
  }

  const thead = `<thead>
    <tr>
      <th scope="col">Size</th>
      <th scope="col" class="inv-editor-num">Cases in stock</th>
      <th scope="col" class="inv-editor-num">Boxes in stock</th>
    </tr>
  </thead>`;

  const html = [];
  for (const g of groups) {
    const title = escapeHtml(g.catalogProductName ?? g.productSlug ?? "");
    const slugSafe = escapeHtml(g.productSlug ?? "");
    const rows = [];
    for (const r of g.rows || []) {
      const slug = escapeHtml(r.productSlug);
      const size = escapeHtml(r.size);
      const cat = escapeHtml(r.catalogProductName ?? "");
      const c = Math.max(0, Math.floor(Number(r.casesOnHand) || 0));
      const b = Math.max(0, Math.floor(Number(r.boxesOnHand) || 0));
      rows.push(`<tr
        class="inv-editor-size-row"
        data-slug="${slug}"
        data-size="${size}"
        data-catalog-name="${cat}"
      >
        <td class="inv-editor-size-cell"><span class="admin-muted">${size}</span></td>
        <td class="inv-editor-num">
          <input
            class="inv-editor-input inv-editor-input--num"
            type="number"
            inputmode="numeric"
            min="0"
            step="1"
            data-field="cases"
            value="${c}"
            aria-label="Cases in stock for ${size}"
          />
        </td>
        <td class="inv-editor-num">
          <input
            class="inv-editor-input inv-editor-input--num"
            type="number"
            inputmode="numeric"
            min="0"
            step="1"
            data-field="boxes"
            value="${b}"
            aria-label="Boxes in stock for ${size}"
          />
        </td>
      </tr>`);
    }

    html.push(`<details class="inv-editor-accordion" data-product-slug="${slugSafe}">
      <summary class="inv-editor-product-title">
        <span class="inv-editor-product-title__text">${title}</span>
      </summary>
      <div class="inv-editor-accordion__panel">
        <table class="admin-table inv-editor-table inv-editor-subtable">
          ${thead}
          <tbody>${rows.join("")}</tbody>
        </table>
      </div>
    </details>`);
  }
  root.innerHTML = html.join("");
}

async function loadStock(session) {
  const errEl = document.getElementById("admin-load-error");
  const loading = document.getElementById("admin-loading");
  errEl.hidden = true;
  loading.hidden = false;
  const status = document.getElementById("inv-save-status");
  if (status) {
    status.textContent = "";
  }
  try {
    const stock = await fetchReportJson("/api/admin-stock", session.access_token);
    const overview = stock?.overview || null;
    const gOos = Boolean(stock?.storefrontGlobalOutOfStock ?? overview?.storefrontGlobalOutOfStock);
    const banner = document.getElementById("inv-global-oos-banner");
    if (banner) {
      if (gOos) {
        banner.hidden = false;
        banner.textContent =
          "Storefront global out-of-stock is ON (store.json → site.storefrontGlobalOutOfStock). " +
          "Customers see sellable stock as zero. Totals below still show physical on-hand for operations.";
      } else {
        banner.hidden = true;
        banner.textContent = "";
      }
    }
    lastEditorGroupsCache = Array.isArray(stock?.editor?.groups) ? stock.editor.groups : [];
    lastStockOverrideHistoryCache =
      stock?.stockOverrideHistory && typeof stock.stockOverrideHistory === "object"
        ? stock.stockOverrideHistory
        : { overrides: [] };
    lastCommitmentRowsCache = Array.isArray(stock?.salesChannelCommitments?.rows) ? stock.salesChannelCommitments.rows : [];
    renderInventoryDashboardSummary(stock);
    renderInventoryHealthTable(stock);
    renderEditorTable(stock?.editor || null);
    fillProductSelect(document.getElementById("inv-order-line-product"), lastEditorGroupsCache);
    const lineSlug = String(document.getElementById("inv-order-line-product")?.value || "").trim();
    syncSizeSelectForSlug(document.getElementById("inv-order-line-size"), lineSlug, lastEditorGroupsCache);
    fillProductSelect(document.getElementById("inv-inc-line-product"), lastEditorGroupsCache);
    const incLineSlug = String(document.getElementById("inv-inc-line-product")?.value || "").trim();
    syncSizeSelectForSlug(document.getElementById("inv-inc-line-size"), incLineSlug, lastEditorGroupsCache);
    renderIncomingBatchesList(stock);
    renderIncomingPendingLinesTable();
    refreshIncomingEditBatchLinesTable();
    renderOpenCommitmentsTable(stock);
    renderPendingOrderLinesTable();
  } catch (e) {
    errEl.textContent = e.message || "Could not load stock.";
    errEl.hidden = false;
  }
  loading.hidden = true;
}

function openStockOverrideWarningDialog() {
  const dlg = document.getElementById("inv-stock-override-warning-dialog");
  if (!dlg) {
    return;
  }
  if (typeof dlg.showModal === "function") {
    dlg.showModal();
  }
}

function closeStockOverrideWarningDialog() {
  const dlg = document.getElementById("inv-stock-override-warning-dialog");
  if (dlg) {
    dlg.close();
  }
}

function formatStockOverrideUnits(cases, boxes) {
  const parts = [];
  if (cases != null && Number.isFinite(Number(cases))) {
    const c = Math.floor(Number(cases));
    parts.push(`${c} case${c === 1 ? "" : "s"}`);
  }
  if (boxes != null && Number.isFinite(Number(boxes))) {
    const b = Math.floor(Number(boxes));
    parts.push(`${b} box${b === 1 ? "" : "es"}`);
  }
  return parts.length ? parts.join(" · ") : "—";
}

function formatStockOverrideDelta(deltaCases, deltaBoxes) {
  const parts = [];
  const dc = Number(deltaCases) || 0;
  const db = Number(deltaBoxes) || 0;
  if (dc !== 0) {
    parts.push(`${dc > 0 ? "+" : ""}${dc} case${Math.abs(dc) === 1 ? "" : "s"}`);
  }
  if (db !== 0) {
    parts.push(`${db > 0 ? "+" : ""}${db} box${Math.abs(db) === 1 ? "" : "es"}`);
  }
  return parts.length ? parts.join(", ") : "—";
}

function renderStockOverrideHistory(payload) {
  const root = document.getElementById("inv-stock-override-history");
  if (!root) {
    return;
  }
  const overrides = Array.isArray(payload?.overrides)
    ? payload.overrides
    : Array.isArray(payload)
      ? payload
      : [];
  if (!overrides.length) {
    root.innerHTML = '<p class="admin-muted inv-stock-override-history__empty">No stock overrides recorded yet.</p>';
    return;
  }
  const rows = overrides
    .map((row) => {
      const when = row.createdAt ? new Date(row.createdAt).toLocaleString() : "—";
      const admin = escapeHtml(row.createdBy || "—");
      const product = escapeHtml(row.productName || row.productSlug || "—");
      const size = escapeHtml(row.size || "—");
      const was = escapeHtml(formatStockOverrideUnits(row.oldCases, row.oldBoxes));
      const now = escapeHtml(formatStockOverrideUnits(row.newCases, row.newBoxes));
      const change = escapeHtml(formatStockOverrideDelta(row.deltaCases, row.deltaBoxes));
      const note = escapeHtml(row.overrideNote || row.reason || "—");
      return `<tr>
        <td class="inv-stock-override-history__when">${escapeHtml(when)}</td>
        <td>${admin}</td>
        <td>${product}</td>
        <td>${size}</td>
        <td class="inv-stock-override-history__qty">${was}</td>
        <td class="inv-stock-override-history__qty">${now}</td>
        <td class="inv-stock-override-history__qty">${change}</td>
        <td class="inv-stock-override-history__note">${note}</td>
      </tr>`;
    })
    .join("");
  root.innerHTML = `<div class="admin-table-wrap inv-stock-override-history__table-wrap">
    <table class="admin-table inv-stock-override-history__table">
      <thead>
        <tr>
          <th scope="col">When</th>
          <th scope="col">Admin</th>
          <th scope="col">Product</th>
          <th scope="col">Size</th>
          <th scope="col">Was</th>
          <th scope="col">Now</th>
          <th scope="col">Change</th>
          <th scope="col">Note</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

function openStockEditorDialog() {
  const dlg = document.getElementById("inv-stock-editor-dialog");
  if (!dlg) {
    return;
  }
  const status = document.getElementById("inv-save-status");
  if (status) {
    status.textContent = "";
  }
  renderStockOverrideHistory(lastStockOverrideHistoryCache);
  if (typeof dlg.showModal === "function") {
    dlg.showModal();
  }
}

function closeStockEditorDialog() {
  const dlg = document.getElementById("inv-stock-editor-dialog");
  if (dlg) {
    dlg.close();
  }
}

/**
 * @param {import("@supabase/supabase-js").Session} session
 */
async function saveAllInventoryEdits(session) {
  const status = document.getElementById("inv-save-status");
  const btn = document.getElementById("inv-save-all");
  const root = document.getElementById("inv-editor-groups");
  if (!root) {
    return;
  }

  const patches = [];
  for (const tr of root.querySelectorAll("tr.inv-editor-size-row[data-slug][data-size]")) {
    const slug = String(tr.dataset.slug || "").trim();
    const size = String(tr.dataset.size || "").trim();
    if (!slug || !size) {
      continue;
    }
    const caseInput = tr.querySelector('[data-field="cases"]');
    const boxInput = tr.querySelector('[data-field="boxes"]');
    const cases = Math.max(0, Math.floor(Number(caseInput?.value) || 0));
    const boxes = Math.max(0, Math.floor(Number(boxInput?.value) || 0));
    patches.push({
      productSlug: slug,
      size,
      channel: "case",
      setOnHand: cases,
      track: true,
    });
    patches.push({
      productSlug: slug,
      size,
      channel: "box",
      setOnHand: boxes,
      track: true,
    });
  }

  if (!patches.length) {
    if (status) {
      status.textContent = "Nothing to save.";
    }
    return;
  }

  if (status) {
    status.textContent = "Saving…";
  }
  if (btn) {
    btn.disabled = true;
  }
  try {
    await fetchReportPost("/api/admin-inventory", session.access_token, {
      action: "stock_patch",
      patches,
      reason: "Admin manual on-hand (cases & boxes)",
      source: "physical_stock_override",
    });
    if (status) {
      status.textContent = "Saved.";
    }
    await loadStock(session);
    closeStockEditorDialog();
  } catch (e) {
    if (status) {
      status.textContent = e?.message || "Save failed.";
    }
    const errEl = document.getElementById("admin-load-error");
    if (errEl) {
      errEl.textContent = e?.message || "Save failed.";
      errEl.hidden = false;
    }
  } finally {
    if (btn) {
      btn.disabled = false;
    }
  }
}

async function bootstrap(session) {
  document.getElementById("admin-user-email").textContent = session.user.email || "";
  renderAdminNav("inventory");
  await loadStock(session);
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

  if (supabase) {
    const {
      data: { session },
    } = await supabase.auth.getSession();

    if (session?.user) {
      primeAdminSessionUser(session);
      showApp();
      await bootstrap(session);
    } else {
      showLogin();
    }

    supabase.auth.onAuthStateChange(async (event, sess) => {
      if (event === "SIGNED_IN" && sess?.user) {
        if (!shouldBootstrapAdminSignedIn(sess)) {
          return;
        }
        showApp();
        await bootstrap(sess);
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
    await bootstrap(session);
  });

  document.getElementById("admin-logout")?.addEventListener("click", async () => {
    if (supabase) {
      await supabase.auth.signOut();
    } else {
      showLogin();
    }
  });

  document.getElementById("admin-refresh")?.addEventListener("click", async () => {
    if (!supabase) {
      return;
    }
    const { data: s } = await supabase.auth.getSession();
    if (s?.session) {
      await bootstrap(s.session);
    }
  });

  document.getElementById("inv-open-stock-editor")?.addEventListener("click", () => openStockOverrideWarningDialog());

  document.getElementById("inv-stock-override-warning-cancel")?.addEventListener("click", () =>
    closeStockOverrideWarningDialog(),
  );

  document.getElementById("inv-stock-override-warning-continue")?.addEventListener("click", () => {
    closeStockOverrideWarningDialog();
    openStockEditorDialog();
  });

  document.getElementById("inv-stock-override-warning-dialog")?.addEventListener("cancel", (ev) => {
    ev.preventDefault();
    closeStockOverrideWarningDialog();
  });

  document.getElementById("inv-stock-override-warning-dialog")?.addEventListener("click", (ev) => {
    if (ev.target === ev.currentTarget) {
      closeStockOverrideWarningDialog();
    }
  });

  document.getElementById("inv-stock-editor-cancel")?.addEventListener("click", () => closeStockEditorDialog());

  document.getElementById("inv-stock-editor-dialog")?.addEventListener("cancel", (ev) => {
    ev.preventDefault();
    closeStockEditorDialog();
  });

  document.getElementById("inv-stock-editor-dialog")?.addEventListener("click", (ev) => {
    if (ev.target === ev.currentTarget) {
      closeStockEditorDialog();
    }
  });

  document.getElementById("inv-save-all")?.addEventListener("click", async () => {
    if (!supabase) {
      return;
    }
    const { data: s } = await supabase.auth.getSession();
    if (!s?.session) {
      return;
    }
    await saveAllInventoryEdits(s.session);
  });

  document.getElementById("inv-order-line-product")?.addEventListener("change", () => {
    const slug = String(document.getElementById("inv-order-line-product")?.value || "").trim();
    syncSizeSelectForSlug(document.getElementById("inv-order-line-size"), slug, lastEditorGroupsCache);
  });

  document.getElementById("inv-order-add-line")?.addEventListener("click", () => onAddOrderLine());

  document.getElementById("inv-order-save-commitments")?.addEventListener("click", async () => {
    if (!supabase) {
      return;
    }
    const { data: auth } = await supabase.auth.getSession();
    if (!auth?.session) {
      return;
    }
    await onSaveOrderCommitments(auth.session);
  });

  document.getElementById("inv-edit-product")?.addEventListener("change", () => {
    const slug = String(document.getElementById("inv-edit-product")?.value || "").trim();
    syncSizeSelectForSlug(document.getElementById("inv-edit-size"), slug, lastEditorGroupsCache);
  });

  document.getElementById("inv-commit-edit-save")?.addEventListener("click", async () => {
    if (!supabase) {
      return;
    }
    const { data: auth } = await supabase.auth.getSession();
    if (!auth?.session) {
      return;
    }
    await onCommitmentEditSave(auth.session);
  });

  document.getElementById("inv-commit-edit-cancel")?.addEventListener("click", () => closeCommitmentEditDialog());

  document.getElementById("inv-commit-edit-dialog")?.addEventListener("cancel", (ev) => {
    ev.preventDefault();
    closeCommitmentEditDialog();
  });

  document.getElementById("inv-inc-line-product")?.addEventListener("change", () => {
    const slug = String(document.getElementById("inv-inc-line-product")?.value || "").trim();
    syncSizeSelectForSlug(document.getElementById("inv-inc-line-size"), slug, lastEditorGroupsCache);
  });

  document.getElementById("inv-inc-add-line")?.addEventListener("click", () => onAddIncomingLine());

  document.getElementById("inv-inc-save-batch")?.addEventListener("click", async () => {
    if (!supabase) {
      return;
    }
    const { data: auth } = await supabase.auth.getSession();
    if (!auth?.session) {
      return;
    }
    await onSaveIncomingBatch(auth.session);
  });

  document.getElementById("inv-inc-edit-line-product")?.addEventListener("change", () => {
    const slug = String(document.getElementById("inv-inc-edit-line-product")?.value || "").trim();
    syncSizeSelectForSlug(document.getElementById("inv-inc-edit-line-size"), slug, lastEditorGroupsCache);
  });

  document.getElementById("inv-inc-edit-batch-save")?.addEventListener("click", async () => {
    if (!supabase) {
      return;
    }
    const { data: auth } = await supabase.auth.getSession();
    if (!auth?.session) {
      return;
    }
    await onIncomingBatchEditSave(auth.session);
  });

  document.getElementById("inv-incoming-edit-batch-dialog")?.addEventListener("cancel", (ev) => {
    ev.preventDefault();
    closeIncomingBatchEditDialog();
  });

  document.getElementById("inv-incoming-edit-batch-dialog")?.addEventListener("click", async (ev) => {
    if (ev.target === ev.currentTarget) {
      closeIncomingBatchEditDialog();
      return;
    }
    const t = ev.target;
    if (!(t instanceof HTMLElement) || !supabase) {
      return;
    }
    const btn = t.closest("[data-incoming-action]");
    if (!(btn instanceof HTMLElement)) {
      return;
    }
    const act = btn.getAttribute("data-incoming-action");
    if (act !== "edit-line" && act !== "delete-line" && act !== "delete-batch") {
      return;
    }
    const { data: auth } = await supabase.auth.getSession();
    if (auth?.session) {
      await handleIncomingSectionClick(auth.session, btn);
    }
  });

  document.getElementById("inv-inc-edit-warning-cancel")?.addEventListener("click", () => closeIncomingEditBatchWarningDialog());

  document.getElementById("inv-inc-edit-warning-proceed")?.addEventListener("click", () => proceedIncomingEditBatchFromWarning());

  document.getElementById("inv-incoming-edit-warning-dialog")?.addEventListener("cancel", (ev) => {
    ev.preventDefault();
    closeIncomingEditBatchWarningDialog();
  });

  document.getElementById("inv-incoming-edit-warning-dialog")?.addEventListener("click", (ev) => {
    if (ev.target === ev.currentTarget) {
      closeIncomingEditBatchWarningDialog();
    }
  });

  document.getElementById("inv-inc-release-hold-warning-cancel")?.addEventListener("click", () => closeIncomingReleaseHoldWarningDialog());

  document.getElementById("inv-inc-release-hold-warning-proceed")?.addEventListener("click", async () => {
    if (!supabase) {
      return;
    }
    const { data: auth } = await supabase.auth.getSession();
    if (auth?.session) {
      await onIncomingReleaseHoldProceed(auth.session);
    }
  });

  document.getElementById("inv-incoming-release-hold-warning-dialog")?.addEventListener("cancel", (ev) => {
    ev.preventDefault();
    closeIncomingReleaseHoldWarningDialog();
  });

  document.getElementById("inv-incoming-release-hold-warning-dialog")?.addEventListener("click", (ev) => {
    if (ev.target === ev.currentTarget) {
      closeIncomingReleaseHoldWarningDialog();
    }
  });

  document.getElementById("inv-incoming-batch-filter")?.addEventListener("change", (ev) => {
    const t = ev.target;
    if (!(t instanceof HTMLSelectElement)) {
      return;
    }
    incomingBatchesFilterId = String(t.value || "upcoming");
    if (lastStockPayloadForIncoming) {
      renderIncomingBatchesList(lastStockPayloadForIncoming);
    }
  });

  document.getElementById("inv-inc-edit-line-save")?.addEventListener("click", async () => {
    if (!supabase) {
      return;
    }
    const { data: auth } = await supabase.auth.getSession();
    if (!auth?.session) {
      return;
    }
    await onIncomingLineEditSave(auth.session);
  });

  document.getElementById("inv-inc-edit-line-cancel")?.addEventListener("click", () => closeIncomingLineEditDialog());

  document.getElementById("inv-incoming-edit-line-dialog")?.addEventListener("cancel", (ev) => {
    ev.preventDefault();
    closeIncomingLineEditDialog();
  });

  document.getElementById("inv-inc-receive-confirm")?.addEventListener("click", async () => {
    if (!supabase) {
      return;
    }
    const { data: auth } = await supabase.auth.getSession();
    if (!auth?.session) {
      return;
    }
    await onIncomingReceiveConfirm(auth.session);
  });

  document.getElementById("inv-inc-receive-cancel")?.addEventListener("click", () => closeIncomingReceiveDialog());

  document.getElementById("inv-incoming-receive-dialog")?.addEventListener("cancel", (ev) => {
    ev.preventDefault();
    closeIncomingReceiveDialog();
  });

  document.getElementById("inv-inc-arrival-review-confirm")?.addEventListener("click", async () => {
    if (!supabase) {
      return;
    }
    const { data: auth } = await supabase.auth.getSession();
    if (!auth?.session) {
      return;
    }
    await onIncomingArrivalReviewConfirm(auth.session);
  });

  document.getElementById("inv-inc-arrival-review-hold")?.addEventListener("click", async () => {
    if (!supabase) {
      return;
    }
    const { data: auth } = await supabase.auth.getSession();
    if (!auth?.session) {
      return;
    }
    await onIncomingArrivalReviewPlaceHold(auth.session);
  });

  document.getElementById("inv-inc-arrival-review-cancel")?.addEventListener("click", () => closeIncomingArrivalReviewDialog());

  document.getElementById("inv-incoming-arrival-review-dialog")?.addEventListener("cancel", (ev) => {
    ev.preventDefault();
    closeIncomingArrivalReviewDialog();
  });

  document.getElementById("inv-incoming-arrival-review-dialog")?.addEventListener("input", () => {
    syncArrivalReviewResults();
  });

  document.getElementById("inv-inc-place-hold-save")?.addEventListener("click", async () => {
    if (!supabase) {
      return;
    }
    const { data: auth } = await supabase.auth.getSession();
    if (!auth?.session) {
      return;
    }
    await onIncomingPlaceHoldSave(auth.session);
  });

  document.getElementById("inv-inc-place-hold-cancel")?.addEventListener("click", () => closeIncomingPlaceHoldDialog());

  document.getElementById("inv-incoming-place-hold-dialog")?.addEventListener("cancel", (ev) => {
    ev.preventDefault();
    closeIncomingPlaceHoldDialog();
  });

  document.getElementById("inv-inc-details-close")?.addEventListener("click", () => closeIncomingBatchDetailsDialog());

  document.getElementById("inv-incoming-batch-details-dialog")?.addEventListener("cancel", (ev) => {
    ev.preventDefault();
    closeIncomingBatchDetailsDialog();
  });

  document.querySelector(".inv-incoming")?.addEventListener("click", async (ev) => {
    const t = ev.target;
    if (!(t instanceof HTMLElement)) {
      return;
    }
    const rm = t.closest("[data-inc-pending-remove]");
    if (rm instanceof HTMLElement) {
      const lid = rm.getAttribute("data-inc-pending-remove");
      pendingIncomingLines = pendingIncomingLines.filter((x) => String(x.localId) !== String(lid));
      renderIncomingPendingLinesTable();
      return;
    }
    const btn = t.closest("[data-incoming-action]");
    if (btn instanceof HTMLElement && supabase) {
      const { data: auth } = await supabase.auth.getSession();
      if (auth?.session) {
        await handleIncomingSectionClick(auth.session, btn);
      }
    }
  });

  document.querySelector(".inv-commitments")?.addEventListener("click", (ev) => {
    const rm = ev.target instanceof HTMLElement ? ev.target.closest("[data-pending-remove]") : null;
    if (rm instanceof HTMLElement) {
      const lid = rm.getAttribute("data-pending-remove");
      pendingOrderLines = pendingOrderLines.filter((x) => String(x.localId) !== String(lid));
      renderPendingOrderLinesTable();
      return;
    }
    void onCommitmentsTableClick(ev);
  });
}

/**
 * @param {MouseEvent} ev
 */
async function onCommitmentsTableClick(ev) {
  const t = ev.target;
  if (!(t instanceof HTMLElement) || !supabase) {
    return;
  }
  const btn = t.closest("[data-commit-action]");
  if (!(btn instanceof HTMLElement)) {
    return;
  }
  const action = btn.getAttribute("data-commit-action");
  const id = btn.getAttribute("data-commit-id");
  if (!action || !id) {
    return;
  }

  const { data: auth } = await supabase.auth.getSession();
  const session = auth?.session;
  if (!session) {
    return;
  }

  try {
    if (action === "edit") {
      openCommitmentEditDialog(id);
      return;
    }
    if (action === "delete") {
      if (
        !window.confirm(
          "Delete this commitment line? This only removes the external demand record and will not change physical stock.",
        )
      ) {
        return;
      }
      await fetchReportPost("/api/admin-inventory", session.access_token, {
        action: "channel_commitment_delete",
        id,
      });
      setCommitFeedback("Commitment deleted.", false);
    } else if (action === "ship") {
      await fetchReportPost("/api/admin-inventory", session.access_token, {
        action: "channel_commitment_update_status",
        id,
        status: "shipped",
      });
      setCommitFeedback("Marked shipped.", false);
    } else if (action === "cancel") {
      await fetchReportPost("/api/admin-inventory", session.access_token, {
        action: "channel_commitment_update_status",
        id,
        status: "cancelled",
      });
      setCommitFeedback("Cancelled.", false);
    } else {
      return;
    }
    await loadStock(session);
  } catch (e) {
    setCommitFeedback(e?.message || "Action failed.", true);
  }
}

document.addEventListener("DOMContentLoaded", () => void init());
