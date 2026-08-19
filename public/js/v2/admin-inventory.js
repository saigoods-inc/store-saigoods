/*
 * SAI Goods admin-v2 — Inventory page controller.
 *
 * Reads the unchanged GET /api/admin-stock endpoint and renders KPIs, an
 * inventory-health table, incoming shipments (with a read-only detail drawer),
 * external channel commitments, and stock-override history.
 *
 * Phase 2 enabled the "Update Stock" drawer via POST { action: "stock_patch" }.
 *
 * Phase 3A adds incoming-shipment RECORD management (no receiving into physical
 * stock). The Create/Edit Incoming Shipment drawer writes ONLY through these
 * existing actions, with payload shapes copied verbatim from the old /admin page:
 *   - incoming_batch_create      (new shipment header)
 *   - incoming_batch_update      (edit header metadata / safe status)
 *   - incoming_batch_line_create (add an expected line)
 *   - incoming_batch_line_update (edit an expected line)
 *   - incoming_batch_line_delete (remove an expected line)
 *
 * Phase 3B adds the incoming-shipment STATUS workflow (arrival / hold / release /
 * cancel) via incoming_batch_update with a status change + appended audit note.
 *
 * Phase 3C adds RECEIVING an arrived shipment into physical stock via
 * incoming_batch_receive. This is the first incoming flow that increases physical
 * inventory, so it carries a warning banner, a difference-review step, and a strong
 * "Receive stock into inventory?" confirmation before any POST. The payload
 * ({ id, lines:[{line_id, received_cases, received_boxes}], note }) and prefill-from-
 * expected behaviour are copied verbatim from the old /admin page.
 *
 * Phase 4 adds SALES CHANNEL COMMITMENTS (external orders such as Amazon FBM) via
 * channel_commitment_create / _update / _update_status / _delete. Commitments reserve
 * available-to-sell inventory but never change physical stock directly. Payloads are
 * copied verbatim from the old /admin page (one create POST per product line).
 *
 * Still NOT connected (remain clearly-disabled placeholders): manual_adjust,
 * mark_damaged, set_threshold, toggle_track, incoming_batch_delete.
 */

import { fetchReportJson, fetchReportPost, ReportPostError } from "../admin-shared.js";

import {
  card,
  closeDrawer,
  emptyState,
  escapeHtml,
  icon,
  kpiCard,
  openDrawer,
  statusChip,
  tableShell,
  toast,
} from "./ui.js";

import { bootAdminV2Page } from "./page-boot.js";

let getToken = async () => undefined;
/** @type {object|null} Full GET /api/admin-stock payload. */
let stockData = null;
let incomingFilter = "all";
/**
 * Working state for the Create/Edit Incoming Shipment drawer.
 * @type {null | { mode: "create"|"edit", batchId: string, currentStatus: string,
 *   originalById: Map<string, {product_slug:string,size:string,expected_cases:number,expected_boxes:number}>,
 *   lines: {id: string|null, product_slug: string, size: string, expected_cases: number|string, expected_boxes: number|string}[] }}
 */
let incDraft = null;
/** Guard against double-submit of channel commitment mutations. */
let commitInFlight = false;
/** Guard against double-submit of the stock-affecting receive action. */
let receiveInFlight = false;
/** Guard against double-submit of physical stock_patch overrides. */
let stockPatchInFlight = false;
/** Guard against double-submit of incoming shipment create/update saves. */
let incomingSaveInFlight = false;
/** Guard against double-submit of incoming shipment status changes. */
let incomingStatusInFlight = false;
/** Monotonic generation so overlapping stock loads discard stale responses. */
let stockLoadGen = 0;

function sectionTitleHtml(iconName, label) {
  return `${icon(iconName, 16)}<span>${escapeHtml(label)}</span>`;
}

/**
 * True while any irreversible inventory mutation is in flight.
 * Used to block overlapping Refresh and conflicting workflows.
 */
export function hasInventoryMutationInFlight() {
  return (
    receiveInFlight ||
    stockPatchInFlight ||
    incomingSaveInFlight ||
    incomingStatusInFlight ||
    commitInFlight
  );
}

/**
 * Associate a visible error element with one or more form controls.
 * @param {string} errorId
 * @param {string|string[]|null} controlIds
 * @param {string} [msg]
 */
function setAssociatedFieldError(errorId, controlIds, msg = "") {
  const errEl = document.getElementById(errorId);
  if (errEl) {
    errEl.textContent = msg || "";
    errEl.hidden = !msg;
  }
  const ids = controlIds == null ? [] : Array.isArray(controlIds) ? controlIds : [controlIds];
  for (const id of ids) {
    const ctrl = document.getElementById(id);
    if (!ctrl) continue;
    if (msg) {
      ctrl.setAttribute("aria-invalid", "true");
      ctrl.setAttribute("aria-describedby", errorId);
    } else {
      ctrl.removeAttribute("aria-invalid");
      if (ctrl.getAttribute("aria-describedby") === errorId) {
        ctrl.removeAttribute("aria-describedby");
      }
    }
  }
}

/* --------------------------------------------------------------- helpers */

function getEl(id) {
  return document.getElementById(id);
}

/** "12 Cases · 3 Boxes", dropping any zero component; "—" when both are zero. */
function fmtCB(cases, boxes) {
  const c = Math.max(0, Math.floor(Number(cases) || 0));
  const b = Math.max(0, Math.floor(Number(boxes) || 0));
  const parts = [];
  if (c > 0) parts.push(`${c} ${c === 1 ? "Case" : "Cases"}`);
  if (b > 0) parts.push(`${b} ${b === 1 ? "Box" : "Boxes"}`);
  return parts.length ? parts.join(" · ") : "—";
}

/**
 * Compact KPI headline for a cases/boxes pair: the dominant whole unit as the
 * big number, with the remainder pushed to a "+N boxes" note so KPI values stay
 * on one line and scan cleanly.
 * @returns {{ value: string, note: string }}
 */
function cbHeadline(cases, boxes) {
  const c = Math.max(0, Math.floor(Number(cases) || 0));
  const b = Math.max(0, Math.floor(Number(boxes) || 0));
  if (c === 0 && b === 0) return { value: "—", note: "" };
  if (c === 0) return { value: `${b} ${b === 1 ? "Box" : "Boxes"}`, note: "" };
  return { value: `${c} ${c === 1 ? "Case" : "Cases"}`, note: b > 0 ? `+${b} ${b === 1 ? "box" : "boxes"}` : "" };
}

/** Join a box-remainder note with a context string for the KPI sub line. */
function kpiSub(note, context) {
  return [note, context].filter(Boolean).join(" · ");
}

function fmtDateShort(iso) {
  const t = iso != null ? String(iso).trim() : "";
  return t ? t.slice(0, 10) : "—";
}

function fmtDateTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

function fmtSoldDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/* ------- ported pure stock helpers (kept identical to /admin inventory) --- */

function formatCasesBoxesFromBoxEquivalent(totalBoxes, boxesPerCase) {
  const bpc = Math.max(1, Math.floor(Number(boxesPerCase) || 10));
  const t = Math.max(0, Math.floor(Number(totalBoxes) || 0));
  return { cases: Math.floor(t / bpc), boxes: t % bpc };
}

function trackedLine(line) {
  return Boolean(line && line.track === true && line.active !== false);
}

function lineAvailabilityRaw(line) {
  if (!trackedLine(line)) return null;
  return (Number(line.onHand) || 0) - (Number(line.reserved) || 0);
}

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

function variantNeedsReview(caseLine, boxLine) {
  if (trackedLine(caseLine) && (Number(caseLine.onHand) || 0) < (Number(caseLine.reserved) || 0)) return true;
  if (trackedLine(boxLine) && (Number(boxLine.onHand) || 0) < (Number(boxLine.reserved) || 0)) return true;
  return false;
}

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
  if (!hasExplicit) th = Math.max(bpc, 10);
  return th;
}

function buildLineIndex(lines) {
  const map = new Map();
  const list = Array.isArray(lines) ? lines : [];
  for (const line of list) {
    if (!line || typeof line !== "object") continue;
    const slug = String(line.productSlug || "").trim();
    const size = String(line.size || "").trim();
    const ch = String(line.channel || "").toLowerCase();
    const channel = ch === "cases" ? "case" : ch === "boxes" ? "box" : ch;
    if (!slug || !size || (channel !== "case" && channel !== "box")) continue;
    map.set(`${slug}\t${size}\t${channel}`, line);
  }
  return map;
}

function getVariantLines(index, slug, size) {
  return {
    caseLine: index.get(`${slug}\t${size}\tcase`) || null,
    boxLine: index.get(`${slug}\t${size}\tbox`) || null,
  };
}

function referenceBoxesPerCaseFromEditor(groups) {
  const gs = Array.isArray(groups) ? groups : [];
  let ref = 10;
  for (const g of gs) ref = Math.max(ref, Math.max(1, Math.floor(Number(g.boxesPerCase) || 10)));
  return Math.max(1, ref);
}

function estimatedAvailableCasesBoxes(remCases, remBoxes, ordCases, ordBoxes, amzCases, amzBoxes, bpc) {
  const b = Math.max(1, Math.floor(Number(bpc) || 10));
  const rc = Math.max(0, Math.floor(Number(remCases) || 0));
  const rb = Math.max(0, Math.floor(Number(remBoxes) || 0));
  const oc = Math.max(0, Math.floor(Number(ordCases) || 0));
  const ob = Math.max(0, Math.floor(Number(ordBoxes) || 0));
  const ac = Math.max(0, Math.floor(Number(amzCases) || 0));
  const ab = Math.max(0, Math.floor(Number(amzBoxes) || 0));
  const physEquiv = rc * b + rb;
  const demandEquiv = oc * b + ob + ac * b + ab;
  return formatCasesBoxesFromBoxEquivalent(Math.max(0, physEquiv - demandEquiv), b);
}

function buildSlugToCatalogName(groups) {
  const map = new Map();
  for (const g of Array.isArray(groups) ? groups : []) {
    const slug = String(g.productSlug || "").trim();
    if (slug) map.set(slug, String(g.catalogProductName ?? g.productSlug ?? slug));
  }
  return map;
}

function salesChannelLabel(channel) {
  const c = String(channel || "").trim().toLowerCase();
  if (c === "amazon_fbm") return "Amazon FBM";
  if (c === "wholesale") return "Wholesale";
  if (c === "manual_external") return "Manual external";
  return c || "—";
}

function incomingStatusLabel(status) {
  const s = String(status || "").trim();
  const map = {
    planned: "Planned",
    in_transit: "In transit",
    arrived: "Arrived",
    on_hold: "On hold",
    received: "Received",
    cancelled: "Cancelled",
  };
  return map[s] || s || "—";
}

/** Statuses whose header + expected lines can be edited (mirrors lib INCOMING_BATCH_EDITABLE_STATUSES). */
function isIncomingEditable(status) {
  const s = String(status || "").trim();
  return s === "planned" || s === "in_transit" || s === "arrived" || s === "on_hold";
}

function incomingStatusVariant(status) {
  switch (String(status || "").trim()) {
    case "received":
      return "success";
    case "on_hold":
      return "warning";
    case "arrived":
      return "brand";
    case "cancelled":
      return "neutral";
    default:
      return "info"; // planned / in_transit
  }
}

function splitBatchNotes(notesRaw) {
  const t = String(notesRaw ?? "").trim();
  if (!t) return [];
  const parts = t
    .split(/(?=\[[^\]]+\])/)
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length ? parts : [t];
}

/** A visibly-disabled write control placeholder. */
function disabledBtn(label, iconName, tip) {
  return `<button type="button" class="sg-btn sg-btn--ghost sg-btn--sm" disabled title="${escapeHtml(
    tip || "Not available in read-only view yet",
  )}">${iconName ? icon(iconName, 14) : ""}<span>${escapeHtml(label)}</span></button>`;
}

/** A compact, disabled icon-only placeholder for dense table rows. */
function disabledIconBtn(label, iconName, tip) {
  return `<button type="button" class="sg-btn sg-btn--ghost sg-btn--icon-sm" disabled aria-label="${escapeHtml(
    label,
  )}" title="${escapeHtml(tip || label)}">${icon(iconName, 15)}</button>`;
}

/* --------------------------------------------------------------- data model */

function healthStatusChip(status) {
  switch (status) {
    case "empty":
      return statusChip("Empty", "danger");
    case "low":
      return statusChip("Low stock", "warning");
    case "review":
      return statusChip("Review", "neutral");
    default:
      return statusChip("In stock", "success");
  }
}

/**
 * Build per-variant health rows + low/empty counts, mirroring the old page.
 * @returns {{ rows: object[], lowCount: number, emptyCount: number }}
 */
function buildHealthRows() {
  const groups = Array.isArray(stockData?.editor?.groups) ? stockData.editor.groups : [];
  const index = buildLineIndex(stockData?.lines);
  const rows = [];
  let lowCount = 0;
  let emptyCount = 0;

  for (const g of groups) {
    const slug = String(g.productSlug || "").trim();
    const bpc = Math.max(1, Math.floor(Number(g.boxesPerCase) || 10));
    const productName = g.catalogProductName ?? g.productSlug ?? "";
    for (const r of Array.isArray(g.rows) ? g.rows : []) {
      const size = String(r.size || "").trim();
      if (!slug || !size) continue;
      const { caseLine, boxLine } = getVariantLines(index, slug, size);

      const physC = Math.max(0, Math.floor(Number(r.casesOnHand) || 0));
      const physB = Math.max(0, Math.floor(Number(r.boxesOnHand) || 0));
      const resC = caseLine ? Math.max(0, Math.floor(Number(caseLine.reserved) || 0)) : 0;
      const resB = boxLine ? Math.max(0, Math.floor(Number(boxLine.reserved) || 0)) : 0;
      const incC = caseLine ? Math.max(0, Math.floor(Number(caseLine.incoming) || 0)) : 0;
      const incB = boxLine ? Math.max(0, Math.floor(Number(boxLine.incoming) || 0)) : 0;

      const review = variantNeedsReview(caseLine, boxLine);
      const sellable = sellableBoxEquivalent(caseLine, boxLine, bpc);
      const thresholdBoxes = variantLowThresholdBoxes(caseLine, boxLine, bpc);

      let status = "in_stock";
      let availableStr = "—";

      if (!trackedLine(caseLine) && !trackedLine(boxLine)) {
        status = "review";
      } else if (review) {
        status = "review";
        const { cases: ac, boxes: ab } = formatCasesBoxesFromBoxEquivalent(sellable == null ? 0 : sellable, bpc);
        availableStr = fmtCB(ac, ab);
      } else if (sellable == null) {
        status = "review";
      } else if (sellable <= 0) {
        status = "empty";
        emptyCount += 1;
        availableStr = "—";
      } else if (sellable <= thresholdBoxes) {
        status = "low";
        lowCount += 1;
        const { cases: ac, boxes: ab } = formatCasesBoxesFromBoxEquivalent(sellable, bpc);
        availableStr = fmtCB(ac, ab);
      } else {
        const { cases: ac, boxes: ab } = formatCasesBoxesFromBoxEquivalent(sellable, bpc);
        availableStr = fmtCB(ac, ab);
      }

      rows.push({
        productSlug: slug,
        productName,
        size,
        physicalStr: fmtCB(physC, physB),
        reservedStr: fmtCB(resC, resB),
        incomingStr: fmtCB(incC, incB),
        availableStr,
        status,
      });
    }
  }

  return { rows, lowCount, emptyCount };
}

function amazonReserved() {
  const amz = stockData?.salesChannelCommitments?.byChannel?.amazon_fbm || {};
  return {
    cases: Math.max(0, Math.floor(Number(amz.unshippedCases) || 0)),
    boxes: Math.max(0, Math.floor(Number(amz.unshippedBoxes) || 0)),
  };
}

/* ------------------- variant lookup for the Update Stock drawer ----------- */

/**
 * Flat list of editable variants (product + size) with their current on-hand,
 * sourced from the same editor payload the old /admin page edits.
 * @returns {{ slug: string, productName: string, size: string, cases: number, boxes: number, boxesPerCase: number }[]}
 */
function editorVariantList() {
  const groups = Array.isArray(stockData?.editor?.groups) ? stockData.editor.groups : [];
  const out = [];
  for (const g of groups) {
    const slug = String(g.productSlug || "").trim();
    if (!slug) continue;
    const productName = String(g.catalogProductName ?? g.productSlug ?? slug);
    const bpc = Math.max(1, Math.floor(Number(g.boxesPerCase) || 10));
    for (const r of Array.isArray(g.rows) ? g.rows : []) {
      const size = String(r.size || "").trim();
      if (!size) continue;
      out.push({
        slug,
        productName,
        size,
        cases: Math.max(0, Math.floor(Number(r.casesOnHand) || 0)),
        boxes: Math.max(0, Math.floor(Number(r.boxesOnHand) || 0)),
        boxesPerCase: bpc,
      });
    }
  }
  return out;
}

/** Look up a single variant's current on-hand, or null when not found. */
function variantCurrent(slug, size) {
  const s = String(slug || "").trim();
  const z = String(size || "").trim();
  return editorVariantList().find((v) => v.slug === s && v.size === z) || null;
}

/** "+2 cases, -1 box" / "No change" delta label for the preview. */
function fmtDelta(dCases, dBoxes) {
  const parts = [];
  const c = Number(dCases) || 0;
  const b = Number(dBoxes) || 0;
  if (c !== 0) parts.push(`${c > 0 ? "+" : ""}${c} case${Math.abs(c) === 1 ? "" : "s"}`);
  if (b !== 0) parts.push(`${b > 0 ? "+" : ""}${b} box${Math.abs(b) === 1 ? "" : "es"}`);
  return parts.length ? parts.join(", ") : "No change";
}

/* --------------------------------------------------------------- sections */

function renderKpis(healthCounts) {
  const s = stockData?.overview?.summary || {};
  const inc = stockData?.incomingInventory?.summary || {};
  const groups = Array.isArray(stockData?.editor?.groups) ? stockData.editor.groups : [];
  const amz = amazonReserved();
  const refBpc = referenceBoxesPerCaseFromEditor(groups);
  const avail = estimatedAvailableCasesBoxes(
    s.remainingCases ?? 0,
    s.remainingBoxes ?? 0,
    s.toShipCases ?? 0,
    s.toShipBoxes ?? 0,
    amz.cases,
    amz.boxes,
    refBpc,
  );
  const alerts = (Number(healthCounts.lowCount) || 0) + (Number(healthCounts.emptyCount) || 0);

  const physical = cbHeadline(s.remainingCases ?? 0, s.remainingBoxes ?? 0);
  const reserved = cbHeadline(s.toShipCases ?? 0, s.toShipBoxes ?? 0);
  const external = cbHeadline(amz.cases, amz.boxes);
  const incoming = cbHeadline(inc.incomingCases ?? 0, inc.incomingBoxes ?? 0);
  const available = cbHeadline(avail.cases, avail.boxes);

  const cards = [
    kpiCard({
      label: "Physical on hand",
      value: physical.value,
      sub: kpiSub(physical.note, "Current warehouse count"),
      iconName: "package",
    }),
    kpiCard({
      label: "Open website orders",
      value: reserved.value,
      sub: kpiSub(reserved.note, "Paid orders awaiting shipment"),
      iconName: "shopping-cart",
    }),
    kpiCard({
      label: "Amazon FBM commitments",
      value: external.value,
      sub: kpiSub(external.note, "Unshipped Amazon FBM only"),
      iconName: "truck",
    }),
    kpiCard({
      label: "Incoming (expected)",
      value: incoming.value,
      sub: kpiSub(incoming.note, "Not physical until received"),
      iconName: "inbox",
    }),
    kpiCard({
      label: "Estimated available",
      value: available.value,
      sub: kpiSub(available.note, "On hand − website orders − Amazon FBM"),
      iconName: "bar-chart-3",
    }),
    kpiCard({
      label: "Stock Alerts",
      value: String(alerts),
      sub: `${healthCounts.lowCount || 0} low · ${healthCounts.emptyCount || 0} empty`,
      iconName: "alert-triangle",
      danger: alerts > 0,
    }),
  ];
  return `<div class="sg-grid sg-grid--kpi-6">${cards.join("")}</div>`;
}

function adjustIconBtn(slug, size, productName) {
  const label = `Update stock for ${productName} ${size}`.trim();
  return `<button type="button" class="sg-btn sg-btn--ghost sg-btn--icon-sm" data-adjust-slug="${escapeHtml(
    slug,
  )}" data-adjust-size="${escapeHtml(size)}" aria-label="${escapeHtml(label)}" title="Update stock">${icon(
    "sliders-horizontal",
    15,
  )}</button>`;
}

function renderHealthCard(healthRows) {
  const rowsHtml = healthRows
    .map(
      (r, i) => {
        const next = healthRows[i + 1];
        const groupEnd = !next || String(next.productSlug) !== String(r.productSlug);
        const actions = `<span class="sg-row-actions">
          ${adjustIconBtn(r.productSlug, r.size, r.productName)}
          ${disabledIconBtn("Set threshold", "bar-chart-3", "Reorder thresholds arrive in a later phase")}
        </span>`;
        return `<tr${groupEnd ? ' class="sg-row--group-end"' : ""}>
        <td class="sg-cell-product">${escapeHtml(r.productName)}</td>
        <td class="sg-muted">${escapeHtml(r.size)}</td>
        <td class="sg-table__num sg-nowrap">${escapeHtml(r.physicalStr)}</td>
        <td class="sg-table__num sg-nowrap">${escapeHtml(r.reservedStr)}</td>
        <td class="sg-table__num sg-nowrap">${escapeHtml(r.incomingStr)}</td>
        <td class="sg-table__num sg-nowrap">${escapeHtml(r.availableStr)}</td>
        <td>${healthStatusChip(r.status)}</td>
        <td>${actions}</td>
      </tr>`;
      },
    )
    .join("");

  const table = tableShell({
    columns: [
      { label: "Product" },
      { label: "Size" },
      { label: "Physical on hand", align: "right" },
      { label: "Website reserved", align: "right" },
      { label: "Incoming expected", align: "right" },
      { label: "Est. available*", align: "right" },
      { label: "Status" },
      { label: "Actions" },
    ],
    rowsHtml,
    emptyHtml: emptyState({ title: "No catalog products", text: "Inventory health will appear here." }),
  });

  const updateStock = `<button type="button" class="sg-btn sg-btn--primary sg-btn--sm" id="sg-update-stock">${icon(
    "package",
    14,
  )}<span>Update stock</span></button>`;
  const note = `<p class="sg-note" style="margin-top:var(--sg-space-3)">* Row “Est. available” uses physical on hand minus website line reserved. It does not subtract sales-channel commitments. KPI “Estimated available” subtracts unshipped Amazon FBM commitments only (not wholesale or manual).</p>`;
  return card({
    titleHtml: sectionTitleHtml("package", "Inventory Health"),
    subtitle: "Physical on hand by variant. Incoming is expected only until received.",
    actionHtml: `<span class="sg-batch__actions">${updateStock}</span>`,
    bodyHtml: table + note,
  });
}

/* ---------------------------------------------------------- incoming */

function incomingRows() {
  return Array.isArray(stockData?.incomingInventory?.rows) ? stockData.incomingInventory.rows : [];
}

function incomingMatchesFilter(status) {
  const s = String(status || "").trim();
  switch (incomingFilter) {
    case "all":
      return true;
    case "upcoming":
      return s === "planned" || s === "in_transit" || s === "arrived";
    default:
      return s === incomingFilter;
  }
}

function incomingFilterHtml() {
  const rows = incomingRows();
  const count = (pred) => rows.filter((r) => pred(String(r.batch?.status || "").trim())).length;
  const opts = [
    { value: "all", label: `All (${rows.length})` },
    { value: "upcoming", label: `Upcoming (${count((s) => s === "planned" || s === "in_transit" || s === "arrived")})` },
    { value: "on_hold", label: `On hold (${count((s) => s === "on_hold")})` },
    { value: "received", label: `Received (${count((s) => s === "received")})` },
    { value: "cancelled", label: `Cancelled (${count((s) => s === "cancelled")})` },
  ]
    .map(
      (o) => `<option value="${o.value}"${o.value === incomingFilter ? " selected" : ""}>${escapeHtml(o.label)}</option>`,
    )
    .join("");
  return `<select class="sg-select" id="sg-inc-filter" aria-label="Filter incoming batches by status">${opts}</select>`;
}

function batchCardHtml(row) {
  const b = row.batch || {};
  const lines = Array.isArray(row.lines) ? row.lines : [];
  const bid = String(b.id || "");
  const st = String(b.status || "").trim();

  let expCases = 0;
  let expBoxes = 0;
  for (const ln of lines) {
    expCases += Math.max(0, Math.floor(Number(ln.expected_cases) || 0));
    expBoxes += Math.max(0, Math.floor(Number(ln.expected_boxes) || 0));
  }

  const container = b.container_number ? escapeHtml(String(b.container_number).trim()) : "—";
  const po = b.po_number ? escapeHtml(String(b.po_number).trim()) : "—";
  const supplier = b.supplier ? escapeHtml(String(b.supplier).trim()) : "—";

  const editable = isIncomingEditable(st);

  // Record-only edit + status workflow (Phase 3A/3B); receive enabled when arrived (Phase 3C).
  const editBtn = editable
    ? `<button type="button" class="sg-btn sg-btn--ghost sg-btn--sm" data-batch-edit="${escapeHtml(
        bid,
      )}">${icon("sliders-horizontal", 14)}<span>Edit</span></button>`
    : "";
  const statusBtn =
    editable && statusActionKeysFor(st).length
      ? `<button type="button" class="sg-btn sg-btn--ghost sg-btn--sm" data-batch-status="${escapeHtml(
          bid,
        )}">${icon("refresh-cw", 14)}<span>Update status</span></button>`
      : "";
  // Phase 3C: receiving is enabled for arrived shipments only; other pipeline
  // statuses keep a disabled placeholder so the future action stays visible.
  let writeActions = "";
  if (st === "arrived") {
    writeActions = `<button type="button" class="sg-btn sg-btn--primary sg-btn--sm" data-batch-receive="${escapeHtml(
      bid,
    )}">${icon("package", 14)}<span>Receive stock</span></button>`;
  } else if (st === "planned" || st === "in_transit" || st === "on_hold") {
    writeActions = disabledBtn("Receive", "package", "Only arrived shipments can be received");
  }

  return `<article class="sg-batch">
    <div>
      <div class="sg-batch__title-row">
        <h4 class="sg-batch__title">${escapeHtml(String(b.batch_name || "Batch"))}</h4>
        ${statusChip(incomingStatusLabel(st), incomingStatusVariant(st))}
      </div>
      <p class="sg-batch__meta"><strong>Container:</strong> ${container} · <strong>PO:</strong> ${po} · <strong>Supplier:</strong> ${supplier}</p>
      <p class="sg-batch__meta"><strong>ETA:</strong> ${escapeHtml(fmtDateShort(b.eta_date))} · <strong>Arrival:</strong> ${escapeHtml(
        fmtDateShort(b.arrival_date),
      )} · <strong>Total expected:</strong> ${escapeHtml(fmtCB(expCases, expBoxes))}</p>
    </div>
    <div class="sg-batch__actions">
      <button type="button" class="sg-btn sg-btn--ghost sg-btn--sm" data-batch-view="${escapeHtml(
        bid,
      )}">View details</button>
      ${editBtn}
      ${statusBtn}
      ${writeActions}
    </div>
  </article>`;
}

function incomingListHtml() {
  const rows = incomingRows();
  if (!rows.length) {
    return emptyState({ title: "No incoming batches", text: "Inbound shipment records will appear here." });
  }
  const display = rows.filter((r) => incomingMatchesFilter(r.batch?.status));
  if (!display.length) {
    return emptyState({ title: "No batches match this filter", text: "Try a different status filter." });
  }
  return `<div class="sg-batch-list">${display.map(batchCardHtml).join("")}</div>`;
}

function renderIncomingCard() {
  const createBtn = `<button type="button" class="sg-btn sg-btn--primary sg-btn--sm" id="sg-inc-create">${icon(
    "plus",
    14,
  )}<span>Create incoming shipment</span></button>`;
  const toolbar = `<span class="sg-batch__actions">
    ${incomingFilterHtml()}
    ${createBtn}
  </span>`;
  return card({
    titleHtml: sectionTitleHtml("inbox", "Incoming Inventory"),
    subtitle: "Expected inbound records — physical on hand increases only after Receive",
    actionHtml: toolbar,
    bodyHtml: `<div id="sg-inc-list">${incomingListHtml()}</div>`,
  });
}

function openBatchDrawer(batchId) {
  const row = incomingRows().find((r) => String(r.batch?.id) === String(batchId));
  if (!row) return;
  const b = row.batch || {};
  const lines = Array.isArray(row.lines) ? row.lines : [];
  const slugToName = buildSlugToCatalogName(stockData?.editor?.groups || []);
  const st = String(b.status || "").trim();

  const metaRow = (label, value) =>
    `<div class="sg-detail-row"><span class="sg-detail-row__label">${escapeHtml(
      label,
    )}</span><span class="sg-detail-row__value">${value}</span></div>`;

  let receivedMeta = "";
  if (st === "received") {
    receivedMeta =
      metaRow("Received at", escapeHtml(fmtSoldDate(b.received_at))) +
      metaRow("Received by", escapeHtml(b.received_by ? String(b.received_by).trim() : "—"));
  }

  const linesRows = lines.length
    ? lines
        .map((ln) => {
          const slug = String(ln.product_slug || "").trim();
          const pname = escapeHtml(slugToName.get(slug) || slug || "—");
          return `<tr>
            <td>${pname}</td>
            <td class="sg-muted">${escapeHtml(String(ln.size ?? ""))}</td>
            <td class="sg-table__num">${escapeHtml(fmtCB(ln.expected_cases, ln.expected_boxes))}</td>
            <td class="sg-table__num">${escapeHtml(fmtCB(ln.received_cases, ln.received_boxes))}</td>
          </tr>`;
        })
        .join("")
    : "";
  const linesTable = tableShell({
    columns: [
      { label: "Product" },
      { label: "Size" },
      { label: "Expected", align: "right" },
      { label: "Received", align: "right" },
    ],
    rowsHtml: linesRows,
    emptyHtml: emptyState({ title: "No lines", text: "This batch has no expected stock lines." }),
  });

  const noteEntries = splitBatchNotes(b.notes);
  const notesHtml = noteEntries.length
    ? `<ul class="sg-note-list">${noteEntries.map((n) => `<li>${escapeHtml(n)}</li>`).join("")}</ul>`
    : `<p class="sg-note" style="margin-top:0">No notes recorded.</p>`;

  const body = `
    <div style="margin-bottom:12px">${statusChip(incomingStatusLabel(st), incomingStatusVariant(st))}</div>
    <div class="sg-detail-list">
      ${metaRow("Container", escapeHtml(b.container_number ? String(b.container_number).trim() : "—"))}
      ${metaRow("PO number", escapeHtml(b.po_number ? String(b.po_number).trim() : "—"))}
      ${metaRow("Supplier", escapeHtml(b.supplier ? String(b.supplier).trim() : "—"))}
      ${metaRow("ETA date", escapeHtml(fmtDateShort(b.eta_date)))}
      ${metaRow("Arrival date", escapeHtml(fmtDateShort(b.arrival_date)))}
      ${receivedMeta}
    </div>

    <div class="sg-drawer-section">
      <p class="sg-drawer-section__title">Expected & received lines</p>
      ${linesTable}
    </div>

    <div class="sg-drawer-section">
      <p class="sg-drawer-section__title">Notes</p>
      ${notesHtml}
    </div>

    <div class="sg-drawer-section">
      <p class="sg-note sg-note--readonly">${icon(
        "info",
        14,
        "sg-note__icon",
      )}       ${
        st === "arrived"
          ? "This shipment is arrived. Use Receive stock to add counted quantity into physical inventory."
          : isIncomingEditable(st)
            ? "Editing changes the shipment record only. Receiving into physical inventory is available after status is Arrived."
            : "This shipment can no longer be edited. Receiving is only available while status is Arrived."
      }</p>
      <div class="sg-batch__actions" style="margin-top:var(--sg-space-3)">
        ${
          isIncomingEditable(st)
            ? `<button type="button" class="sg-btn sg-btn--ghost sg-btn--sm" data-batch-edit-drawer="${escapeHtml(
                String(b.id || ""),
              )}">${icon("sliders-horizontal", 14)}<span>Edit shipment</span></button>`
            : disabledBtn("Edit batch", "sliders-horizontal", "This shipment can no longer be edited")
        }
        ${
          isIncomingEditable(st) && statusActionKeysFor(st).length
            ? `<button type="button" class="sg-btn sg-btn--ghost sg-btn--sm" data-batch-status-drawer="${escapeHtml(
                String(b.id || ""),
              )}">${icon("refresh-cw", 14)}<span>Update status</span></button>`
            : ""
        }
        ${
          st === "arrived"
            ? `<button type="button" class="sg-btn sg-btn--primary sg-btn--sm" data-batch-receive-drawer="${escapeHtml(
                String(b.id || ""),
              )}">${icon("package", 14)}<span>Receive stock</span></button>`
            : st === "on_hold" || st === "planned" || st === "in_transit"
              ? disabledBtn("Receive stock", "package", "Only arrived shipments can be received")
              : ""
        }
      </div>
    </div>`;

  openDrawer({ title: String(b.batch_name || "Batch"), bodyHtml: body });
  const editFromDrawer = document.querySelector("button[data-batch-edit-drawer]");
  if (editFromDrawer) {
    editFromDrawer.addEventListener("click", () =>
      openIncomingShipmentDrawer("edit", editFromDrawer.getAttribute("data-batch-edit-drawer")),
    );
  }
  const statusFromDrawer = document.querySelector("button[data-batch-status-drawer]");
  if (statusFromDrawer) {
    statusFromDrawer.addEventListener("click", () =>
      openStatusDrawer(statusFromDrawer.getAttribute("data-batch-status-drawer")),
    );
  }
  const receiveFromDrawer = document.querySelector("button[data-batch-receive-drawer]");
  if (receiveFromDrawer) {
    receiveFromDrawer.addEventListener("click", () =>
      openReceiveDrawer(receiveFromDrawer.getAttribute("data-batch-receive-drawer")),
    );
  }
}

/* --------------------------------------------------------- commitments */

function renderCommitmentsCard() {
  const rows = Array.isArray(stockData?.salesChannelCommitments?.rows)
    ? [...stockData.salesChannelCommitments.rows]
    : [];
  const slugToName = buildSlugToCatalogName(stockData?.editor?.groups || []);

  rows.sort((a, b) => {
    const ca = String(a.channel || "");
    const cb = String(b.channel || "");
    if (ca !== cb) return ca.localeCompare(cb);
    return String(a.product_slug || "").localeCompare(String(b.product_slug || ""));
  });

  const rowsHtml = rows
    .map((r) => {
      const slug = String(r.product_slug ?? "").trim();
      const pname = escapeHtml(slugToName.get(slug) || slug || "—");
      const ext = r.external_order_id ? escapeHtml(String(r.external_order_id).trim()) : "—";
      const cid = escapeHtml(String(r.id ?? ""));
      return `<tr>
        <td class="sg-cell-product">${pname}</td>
        <td class="sg-muted">${escapeHtml(String(r.size ?? ""))}</td>
        <td class="sg-table__num sg-nowrap">${escapeHtml(fmtCB(r.quantity_cases, r.quantity_boxes))}</td>
        <td>${escapeHtml(salesChannelLabel(r.channel))}</td>
        <td class="sg-mono sg-nowrap">${ext}</td>
        <td class="sg-muted sg-nowrap">${escapeHtml(fmtSoldDate(r.sold_at))}</td>
        <td><span class="sg-batch__actions">
          <button type="button" class="sg-btn sg-btn--ghost sg-btn--sm" data-commit-edit="${cid}">${icon(
            "sliders-horizontal",
            14,
          )}<span>Edit</span></button>
          <button type="button" class="sg-btn sg-btn--ghost sg-btn--sm" data-commit-ship="${cid}">${icon(
            "package",
            14,
          )}<span>Mark shipped</span></button>
          <button type="button" class="sg-btn sg-btn--ghost sg-btn--sm" data-commit-cancel="${cid}">Cancel</button>
          <button type="button" class="sg-btn sg-btn--ghost sg-btn--sm sg-btn--danger" data-commit-delete="${cid}">${icon(
            "trash-2",
            14,
          )}<span>Remove</span></button>
        </span></td>
      </tr>`;
    })
    .join("");

  const table = tableShell({
    columns: [
      { label: "Product" },
      { label: "Size" },
      { label: "Quantity", align: "right" },
      { label: "Channel" },
      { label: "Order ID" },
      { label: "Sold" },
      { label: "Actions" },
    ],
    rowsHtml,
    emptyHtml: emptyState({ title: "No external commitments", text: "External channel orders will appear here." }),
  });

  const addBtn = `<button type="button" class="sg-btn sg-btn--primary sg-btn--sm" data-commit-add>${icon(
    "plus",
    14,
  )}<span>Add external order</span></button>`;
  return card({
    titleHtml: sectionTitleHtml("shopping-cart", "Sales Channel Commitments"),
    subtitle:
      "External sold-not-shipped demand (Amazon FBM, wholesale, manual). Only Amazon FBM unshipped quantities reduce the Estimated available KPI. Wholesale and manual are tracked operationally and do not change that KPI. Commitments do not write physical stock or inventory_levels.reserved. Over-commitment is not blocked by the server.",
    actionHtml: `<span class="sg-batch__actions">${addBtn}</span>`,
    bodyHtml: table,
  });
}

/* ----------------------------------------- commitments write (Phase 4) */
/*
 * External sales-channel commitments reserve available-to-sell inventory but never
 * change physical stock directly. All writes go through the existing actions with
 * payload shapes copied verbatim from the old /admin page:
 *   - channel_commitment_create        (one POST per product line)
 *   - channel_commitment_update        (single unshipped row: fields only)
 *   - channel_commitment_update_status (mark shipped / cancel)
 *   - channel_commitment_delete        (remove a row)
 * The backend accepts free-form channel strings; we expose the canonical taxonomy
 * (amazon_fbm / wholesale / manual_external) — there is no "walmart" channel here.
 */

/** Canonical channel taxonomy supported by the backend + KPI aggregation. */
const COMMIT_CHANNELS = [
  ["amazon_fbm", "Amazon FBM"],
  ["wholesale", "Wholesale"],
  ["manual_external", "Manual external / Other"],
];

/** Working state for the Add External Order drawer. */
let commitDraft = null;

function commitChannelOptions(selected) {
  const sel = String(selected || "amazon_fbm").trim();
  const known = COMMIT_CHANNELS.some(([v]) => v === sel);
  const list = known ? COMMIT_CHANNELS : [[sel, salesChannelLabel(sel)], ...COMMIT_CHANNELS];
  return list
    .map(([v, label]) => `<option value="${escapeHtml(v)}"${v === sel ? " selected" : ""}>${escapeHtml(label)}</option>`)
    .join("");
}

/** Find an unshipped commitment row from the current snapshot. */
function findCommitment(id) {
  const rows = Array.isArray(stockData?.salesChannelCommitments?.rows) ? stockData.salesChannelCommitments.rows : [];
  return rows.find((r) => String(r.id) === String(id)) || null;
}

/** ISO sold_at from a yyyy-mm-dd input (noon UTC), matching the old dashboard. */
function soldAtFromDateInput(value) {
  const s = String(value || "").trim();
  return s ? `${s}T12:00:00.000Z` : null;
}

function commitSetErr(id, msg) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = msg || "";
  el.hidden = !msg;
}

function blankCommitLine() {
  const vs = editorVariantList();
  const first = vs[0] || null;
  const slug = first ? first.slug : "";
  const sizes = vs.filter((v) => v.slug === slug);
  return { product_slug: slug, size: sizes[0]?.size || "", quantity_cases: "", quantity_boxes: "" };
}

function commitLineCardHtml(line, idx) {
  const slug = String(line.product_slug || "");
  const size = String(line.size || "");
  const cases = line.quantity_cases === "" || line.quantity_cases == null ? "" : String(line.quantity_cases);
  const boxes = line.quantity_boxes === "" || line.quantity_boxes == null ? "" : String(line.quantity_boxes);
  return `<div class="sg-line" data-idx="${idx}">
    <div class="sg-line__head">
      <span class="sg-line__label">Line ${idx + 1}</span>
      <button type="button" class="sg-btn sg-btn--ghost sg-btn--icon-sm" data-commit-line-remove="${idx}" aria-label="Remove line ${
        idx + 1
      }" title="Remove line">${icon("trash-2", 15)}</button>
    </div>
    <div class="sg-form-grid">
      <label class="sg-field">Product
        <select class="sg-select sg-field__control" data-commit-line-product="${idx}">${updateStockProductOptions(slug)}</select>
      </label>
      <label class="sg-field">Size
        <select class="sg-select sg-field__control" data-commit-line-size="${idx}">${updateStockSizeOptions(slug, size)}</select>
      </label>
    </div>
    <div class="sg-form-grid">
      <label class="sg-field">Quantity cases
        <input class="sg-input sg-field__control" type="number" min="0" step="1" inputmode="numeric" data-commit-line-cases="${idx}" value="${escapeHtml(
          cases,
        )}" />
      </label>
      <label class="sg-field">Quantity boxes
        <input class="sg-input sg-field__control" type="number" min="0" step="1" inputmode="numeric" data-commit-line-boxes="${idx}" value="${escapeHtml(
          boxes,
        )}" />
      </label>
    </div>
  </div>`;
}

function renderCommitLines() {
  const host = document.getElementById("commit-lines");
  if (!host || !commitDraft) return;
  host.innerHTML = commitDraft.lines.length
    ? commitDraft.lines.map((l, i) => commitLineCardHtml(l, i)).join("")
    : `<p class="sg-note" style="margin:0">No product lines yet — add at least one.</p>`;
}

function readCommitLinesFromDom() {
  const host = document.getElementById("commit-lines");
  if (!host || !commitDraft) return commitDraft ? commitDraft.lines : [];
  const out = [];
  host.querySelectorAll(".sg-line").forEach((el) => {
    out.push({
      product_slug: el.querySelector("[data-commit-line-product]")?.value || "",
      size: el.querySelector("[data-commit-line-size]")?.value || "",
      quantity_cases: String(el.querySelector("[data-commit-line-cases]")?.value ?? "").trim(),
      quantity_boxes: String(el.querySelector("[data-commit-line-boxes]")?.value ?? "").trim(),
    });
  });
  return out;
}

/* -- Add External Order drawer (channel_commitment_create, one POST / line) -- */

function openAddCommitmentDrawer() {
  const variants = editorVariantList();
  if (!variants.length) {
    toast("No catalog products available to build a commitment.", "danger");
    return;
  }
  commitDraft = { lines: [blankCommitLine()] };

  const body = `
    <div class="sg-info-banner" role="note">
      <span class="sg-info-banner__icon">${icon("info", 18)}</span>
      <span>Only <strong>Amazon FBM</strong> unshipped commitments reduce the Estimated available KPI. Wholesale and manual commitments are tracked here for operations and do <strong>not</strong> change that KPI. Commitments never change physical on-hand stock. The server does not block over-commitment.</span>
    </div>

    <div id="commit-form">
      <div class="sg-form-grid">
        <label class="sg-field">Sales channel
          <select class="sg-select sg-field__control" id="commit-channel">${commitChannelOptions("amazon_fbm")}</select>
        </label>
        <label class="sg-field">External order ID <span class="sg-field__optional">(optional)</span>
          <input class="sg-input sg-field__control" id="commit-ext" type="text" maxlength="120" placeholder="e.g. 111-2223334-5556667" />
        </label>
      </div>
      <label class="sg-field">Sold date <span class="sg-field__optional">(optional)</span>
        <input class="sg-input sg-field__control" id="commit-sold" type="date" />
      </label>
      <label class="sg-field">Notes <span class="sg-field__optional">(optional)</span>
        <textarea class="sg-input sg-field__control sg-textarea" id="commit-notes" rows="2" maxlength="400" placeholder="Internal note for this external order"></textarea>
      </label>

      <div class="sg-line-head">
        <p class="sg-drawer-section__title" style="margin:0">Product lines</p>
        <button type="button" class="sg-btn sg-btn--ghost sg-btn--sm" id="commit-add-line">${icon("plus", 14)}<span>Add line</span></button>
      </div>
      <div id="commit-lines"></div>
      <p class="sg-field__error" id="commit-err" hidden></p>

      <div class="sg-drawer-actions">
        <button type="button" class="sg-btn sg-btn--ghost" id="commit-cancel">Cancel</button>
        <button type="button" class="sg-btn sg-btn--primary" id="commit-review">Review order</button>
      </div>
    </div>

    <div id="commit-confirm" class="sg-confirm" hidden>
      <h3 class="sg-confirm__title">Add external commitment?</h3>
      <p class="sg-confirm__copy">This records external demand used in estimated-availability math. It <strong>does not</strong> change physical on-hand stock. Over-commitment is not prevented by the server.</p>
      <div class="sg-confirm__summary" id="commit-confirm-summary"></div>
      <p class="sg-error" id="commit-confirm-error" role="alert" hidden></p>
      <div class="sg-drawer-actions">
        <button type="button" class="sg-btn sg-btn--ghost" id="commit-confirm-back">Back</button>
        <button type="button" class="sg-btn sg-btn--primary" id="commit-confirm-btn">Confirm add commitment</button>
      </div>
    </div>`;

  openDrawer({ title: "Add External Order", bodyHtml: body });
  renderCommitLines();
  wireAddCommitmentDrawer();
}

function wireAddCommitmentDrawer() {
  const host = document.getElementById("commit-form");
  if (!host) return;

  document.getElementById("commit-cancel")?.addEventListener("click", () => closeDrawer());

  document.getElementById("commit-add-line")?.addEventListener("click", () => {
    commitDraft.lines = readCommitLinesFromDom();
    commitDraft.lines.push(blankCommitLine());
    renderCommitLines();
  });

  host.addEventListener("click", (e) => {
    const rm = e.target.closest("[data-commit-line-remove]");
    if (!rm) return;
    const idx = Number(rm.getAttribute("data-commit-line-remove"));
    commitDraft.lines = readCommitLinesFromDom();
    commitDraft.lines.splice(idx, 1);
    if (!commitDraft.lines.length) commitDraft.lines.push(blankCommitLine());
    renderCommitLines();
  });

  host.addEventListener("change", (e) => {
    const prod = e.target.closest("[data-commit-line-product]");
    if (prod) {
      const idx = Number(prod.getAttribute("data-commit-line-product"));
      commitDraft.lines = readCommitLinesFromDom();
      const slug = commitDraft.lines[idx].product_slug;
      const sizes = editorVariantList().filter((v) => v.slug === slug);
      commitDraft.lines[idx].size = sizes[0]?.size || "";
      renderCommitLines();
    }
  });

  document.getElementById("commit-review")?.addEventListener("click", () => {
    const built = validateAddCommitment();
    if (!built) return;
    fillAddCommitmentConfirm(built);
    commitSetErr("commit-confirm-error", "");
    document.getElementById("commit-form").hidden = true;
    document.getElementById("commit-confirm").hidden = false;
  });

  document.getElementById("commit-confirm-back")?.addEventListener("click", () => {
    document.getElementById("commit-confirm").hidden = true;
    document.getElementById("commit-form").hidden = false;
  });

  document.getElementById("commit-confirm-btn")?.addEventListener("click", () => submitAddCommitment());
}

/**
 * @returns {null | { channel: string, external_order_id: string|null, sold_at: string|null, notes: string|null, lines: object[] }}
 */
function validateAddCommitment() {
  commitSetErr("commit-err", "");
  commitDraft.lines = readCommitLinesFromDom();
  const lines = commitDraft.lines;
  if (!lines.length) {
    commitSetErr("commit-err", "Add at least one product line.");
    return null;
  }
  const seen = new Set();
  for (let i = 0; i < lines.length; i += 1) {
    const ln = lines[i];
    if (!ln.product_slug || !ln.size) {
      commitSetErr("commit-err", `Line ${i + 1}: choose a product and size.`);
      return null;
    }
    const c = parseWholeQty(ln.quantity_cases);
    const b = parseWholeQty(ln.quantity_boxes);
    if (!c.valid || !b.valid) {
      commitSetErr("commit-err", `Line ${i + 1}: quantities must be whole, non-negative numbers.`);
      return null;
    }
    if (c.value <= 0 && b.value <= 0) {
      commitSetErr("commit-err", `Line ${i + 1}: enter at least one case or box.`);
      return null;
    }
    const key = `${ln.product_slug}\t${ln.size}`;
    if (seen.has(key)) {
      commitSetErr("commit-err", `Line ${i + 1}: duplicate product/size — combine into one line.`);
      return null;
    }
    seen.add(key);
    ln._cases = c.value;
    ln._boxes = b.value;
  }
  const channel = String(document.getElementById("commit-channel")?.value || "amazon_fbm").trim();
  const external_order_id = String(document.getElementById("commit-ext")?.value ?? "").trim() || null;
  const sold_at = soldAtFromDateInput(document.getElementById("commit-sold")?.value);
  const notes = String(document.getElementById("commit-notes")?.value ?? "").trim() || null;
  return { channel, external_order_id, sold_at, notes, lines };
}

function fillAddCommitmentConfirm(built) {
  const slugToName = buildSlugToCatalogName(stockData?.editor?.groups || []);
  let tc = 0;
  let tb = 0;
  const items = built.lines
    .map((ln) => {
      tc += ln._cases;
      tb += ln._boxes;
      return `<li>${escapeHtml(slugToName.get(ln.product_slug) || ln.product_slug)} · ${escapeHtml(
        ln.size,
      )} — ${escapeHtml(fmtCB(ln._cases, ln._boxes))}</li>`;
    })
    .join("");

  // Advisory only — uses current display snapshot; not an authoritative hard block.
  const s = stockData?.overview?.summary || {};
  const amz = amazonReserved();
  const groups = Array.isArray(stockData?.editor?.groups) ? stockData.editor.groups : [];
  const refBpc = referenceBoxesPerCaseFromEditor(groups);
  const avail = estimatedAvailableCasesBoxes(
    s.remainingCases ?? 0,
    s.remainingBoxes ?? 0,
    s.toShipCases ?? 0,
    s.toShipBoxes ?? 0,
    amz.cases,
    amz.boxes,
    refBpc,
  );
  const availBoxes = Math.max(0, Math.floor(Number(avail.cases) || 0)) * refBpc + Math.max(0, Math.floor(Number(avail.boxes) || 0));
  const needBoxes = tc * refBpc + tb;
  const advisory =
    needBoxes > availBoxes
      ? `<div class="sg-warn-banner" role="note" style="margin-bottom:var(--sg-space-3)">
          <span class="sg-warn-banner__icon">${icon("alert-triangle", 18)}</span>
          <span><strong>Advisory:</strong> this commitment (${escapeHtml(fmtCB(tc, tb))}) exceeds the currently displayed estimated available (${escapeHtml(
            fmtCB(avail.cases, avail.boxes),
          )}). The server does not block over-commitment — proceed only if intentional.</span>
        </div>`
      : "";

  const impactLabel =
    String(built.channel || "") === "amazon_fbm"
      ? "Amazon FBM only — reduces Estimated available KPI until shipped"
      : "Operational tracking only — does not change Estimated available KPI";
  const host = document.getElementById("commit-confirm-summary");
  if (host) {
    host.innerHTML = `
      ${advisory}
      <div class="sg-preview__row"><span>Channel</span><strong>${escapeHtml(salesChannelLabel(built.channel))}</strong></div>
      <div class="sg-preview__row"><span>External order ID</span><strong>${built.external_order_id ? escapeHtml(built.external_order_id) : "—"}</strong></div>
      <div class="sg-preview__row"><span>Total quantity</span><strong>${escapeHtml(fmtCB(tc, tb))}</strong></div>
      <div class="sg-preview__row"><span>Availability impact</span><strong>${escapeHtml(impactLabel)}</strong></div>
      <div class="sg-preview__row"><span>Physical stock</span><strong>No change</strong></div>
      <div class="sg-confirm__lines">
        <p class="sg-drawer-section__title" style="margin:0 0 6px">Lines (${built.lines.length})</p>
        <ul class="sg-note-list">${items}</ul>
      </div>`;
  }
}

async function submitAddCommitment() {
  if (hasInventoryMutationInFlight()) return;
  const built = validateAddCommitment();
  const confirmBtn = document.getElementById("commit-confirm-btn");
  const backBtn = document.getElementById("commit-confirm-back");
  if (!built) {
    document.getElementById("commit-confirm").hidden = true;
    document.getElementById("commit-form").hidden = false;
    return;
  }

  commitInFlight = true;
  if (confirmBtn) confirmBtn.disabled = true;
  if (backBtn) backBtn.disabled = true;
  commitSetErr("commit-confirm-error", "");

  let created = 0;
  try {
    // Token acquisition is inside try so session failures hit the same catch/finally cleanup.
    const token = await getToken();
    // One create per line. Successful lines are removed so a retry after a
    // mid-loop failure never double-creates the already-saved lines.
    while (commitDraft.lines.length) {
      const ln = commitDraft.lines[0];
      await fetchReportPost("/api/admin-inventory", token, {
        action: "channel_commitment_create",
        commitment: {
          channel: built.channel,
          external_order_id: built.external_order_id,
          product_slug: ln.product_slug,
          size: ln.size,
          quantity_cases: ln._cases,
          quantity_boxes: ln._boxes,
          status: "unshipped",
          sold_at: built.sold_at,
          notes: built.notes,
        },
      });
      commitDraft.lines.shift();
      created += 1;
    }
    closeDrawer();
    toast(`Added ${created} external commitment line${created === 1 ? "" : "s"}.`, "success");
    await loadStock();
  } catch (error) {
    const base =
      error instanceof ReportPostError
        ? error.message || "The server rejected the commitment."
        : error?.message || "Could not save the commitment.";
    const prefix = created ? `Saved ${created} line${created === 1 ? "" : "s"}. ` : "";
    const detail = `${prefix}${base}`;
    const formDetail = created
      ? `${created} line${created === 1 ? "" : "s"} already saved. Remaining lines below still need saving. ${base}`
      : base;
    commitSetErr("commit-confirm-error", detail);
    commitSetErr("commit-err", formDetail);
    if (confirmBtn) confirmBtn.disabled = false;
    if (backBtn) backBtn.disabled = false;
    // Keep drawer open with remaining unsaved lines for retry (not transactional).
    // Always surface the failure on the visible form panel (confirm is hidden next).
    renderCommitLines();
    document.getElementById("commit-confirm").hidden = true;
    document.getElementById("commit-form").hidden = false;
    if (created) {
      // Refetch so the page reflects partial creates; do not close or clear the draft/error.
      try {
        await loadStock();
      } catch {
        /* preserve drawer, draft, and original save failure message */
      }
    }
  } finally {
    commitInFlight = false;
  }
}

/* -- Edit External Commitment drawer (channel_commitment_update, one row) --- */

function openEditCommitmentDrawer(id) {
  const r = findCommitment(id);
  if (!r) {
    toast("Could not find that commitment.", "danger");
    return;
  }
  const slug = String(r.product_slug || "");
  const size = String(r.size || "");
  const soldDate = r.sold_at ? String(r.sold_at).slice(0, 10) : "";

  const body = `
    <div class="sg-info-banner" role="note">
      <span class="sg-info-banner__icon">${icon("info", 18)}</span>
      <span>Editing a commitment updates estimated-availability demand. It <strong>does not</strong> change physical stock. Only unshipped commitments can be edited. Over-commitment is not blocked by the server.</span>
    </div>

    <div id="cedit-form">
      <div class="sg-form-grid">
        <label class="sg-field">Sales channel
          <select class="sg-select sg-field__control" id="cedit-channel">${commitChannelOptions(r.channel)}</select>
        </label>
        <label class="sg-field">External order ID <span class="sg-field__optional">(optional)</span>
          <input class="sg-input sg-field__control" id="cedit-ext" type="text" maxlength="120" value="${escapeHtml(
            r.external_order_id ? String(r.external_order_id) : "",
          )}" />
        </label>
      </div>
      <div class="sg-form-grid">
        <label class="sg-field">Product
          <select class="sg-select sg-field__control" id="cedit-product">${updateStockProductOptions(slug)}</select>
        </label>
        <label class="sg-field">Size
          <select class="sg-select sg-field__control" id="cedit-size">${updateStockSizeOptions(slug, size)}</select>
        </label>
      </div>
      <div class="sg-form-grid">
        <label class="sg-field">Quantity cases
          <input class="sg-input sg-field__control" type="number" min="0" step="1" inputmode="numeric" id="cedit-cases" value="${Math.max(
            0,
            Math.floor(Number(r.quantity_cases) || 0),
          )}" />
        </label>
        <label class="sg-field">Quantity boxes
          <input class="sg-input sg-field__control" type="number" min="0" step="1" inputmode="numeric" id="cedit-boxes" value="${Math.max(
            0,
            Math.floor(Number(r.quantity_boxes) || 0),
          )}" />
        </label>
      </div>
      <label class="sg-field">Sold date <span class="sg-field__optional">(optional)</span>
        <input class="sg-input sg-field__control" id="cedit-sold" type="date" value="${escapeHtml(soldDate)}" />
      </label>
      <label class="sg-field">Notes <span class="sg-field__optional">(optional)</span>
        <textarea class="sg-input sg-field__control sg-textarea" id="cedit-notes" rows="2" maxlength="400">${escapeHtml(
          r.notes ? String(r.notes) : "",
        )}</textarea>
      </label>
      <p class="sg-field__error" id="cedit-err" hidden></p>

      <div class="sg-drawer-actions">
        <button type="button" class="sg-btn sg-btn--ghost" id="cedit-cancel">Cancel</button>
        <button type="button" class="sg-btn sg-btn--primary" id="cedit-review">Review changes</button>
      </div>
    </div>

    <div id="cedit-confirm" class="sg-confirm" hidden>
      <h3 class="sg-confirm__title">Save commitment changes?</h3>
      <p class="sg-confirm__copy">This updates estimated-availability demand for this external order. It <strong>does not</strong> change physical stock.</p>
      <div class="sg-confirm__summary" id="cedit-confirm-summary"></div>
      <p class="sg-error" id="cedit-confirm-error" role="alert" hidden></p>
      <div class="sg-drawer-actions">
        <button type="button" class="sg-btn sg-btn--ghost" id="cedit-confirm-back">Back</button>
        <button type="button" class="sg-btn sg-btn--primary" id="cedit-confirm-btn">Confirm changes</button>
      </div>
    </div>`;

  openDrawer({ title: "Edit External Commitment", bodyHtml: body });
  wireEditCommitmentDrawer(String(r.id));
}

function wireEditCommitmentDrawer(id) {
  document.getElementById("cedit-cancel")?.addEventListener("click", () => closeDrawer());

  document.getElementById("cedit-product")?.addEventListener("change", () => {
    const slug = document.getElementById("cedit-product").value;
    const sizeSel = document.getElementById("cedit-size");
    if (sizeSel) sizeSel.innerHTML = updateStockSizeOptions(slug, "");
  });

  document.getElementById("cedit-review")?.addEventListener("click", () => {
    const built = validateEditCommitment();
    if (!built) return;
    const slugToName = buildSlugToCatalogName(stockData?.editor?.groups || []);
    const host = document.getElementById("cedit-confirm-summary");
    if (host) {
      host.innerHTML = `
        <div class="sg-preview__row"><span>Channel</span><strong>${escapeHtml(salesChannelLabel(built.channel))}</strong></div>
        <div class="sg-preview__row"><span>External order ID</span><strong>${built.external_order_id ? escapeHtml(built.external_order_id) : "—"}</strong></div>
        <div class="sg-preview__row"><span>Product</span><strong>${escapeHtml(slugToName.get(built.product_slug) || built.product_slug)} · ${escapeHtml(built.size)}</strong></div>
        <div class="sg-preview__row"><span>Quantity</span><strong>${escapeHtml(fmtCB(built.quantity_cases, built.quantity_boxes))}</strong></div>
        <div class="sg-preview__row"><span>Physical stock</span><strong>No direct change</strong></div>`;
    }
    commitSetErr("cedit-confirm-error", "");
    document.getElementById("cedit-form").hidden = true;
    document.getElementById("cedit-confirm").hidden = false;
  });

  document.getElementById("cedit-confirm-back")?.addEventListener("click", () => {
    document.getElementById("cedit-confirm").hidden = true;
    document.getElementById("cedit-form").hidden = false;
  });

  document.getElementById("cedit-confirm-btn")?.addEventListener("click", () => submitEditCommitment(id));
}

function validateEditCommitment() {
  commitSetErr("cedit-err", "");
  const product_slug = String(document.getElementById("cedit-product")?.value || "").trim();
  const size = String(document.getElementById("cedit-size")?.value || "").trim();
  if (!product_slug || !size) {
    commitSetErr("cedit-err", "Choose a product and size.");
    return null;
  }
  const c = parseWholeQty(document.getElementById("cedit-cases")?.value);
  const b = parseWholeQty(document.getElementById("cedit-boxes")?.value);
  if (!c.valid || !b.valid) {
    commitSetErr("cedit-err", "Quantities must be whole, non-negative numbers.");
    return null;
  }
  if (c.value <= 0 && b.value <= 0) {
    commitSetErr("cedit-err", "Enter at least one case or box.");
    return null;
  }
  return {
    channel: String(document.getElementById("cedit-channel")?.value || "amazon_fbm").trim(),
    external_order_id: String(document.getElementById("cedit-ext")?.value ?? "").trim() || null,
    product_slug,
    size,
    quantity_cases: c.value,
    quantity_boxes: b.value,
    sold_at: soldAtFromDateInput(document.getElementById("cedit-sold")?.value),
    notes: String(document.getElementById("cedit-notes")?.value ?? "").trim() || null,
  };
}

async function submitEditCommitment(id) {
  if (hasInventoryMutationInFlight()) return;
  const built = validateEditCommitment();
  const confirmBtn = document.getElementById("cedit-confirm-btn");
  const backBtn = document.getElementById("cedit-confirm-back");
  if (!built) {
    document.getElementById("cedit-confirm").hidden = true;
    document.getElementById("cedit-form").hidden = false;
    return;
  }

  commitInFlight = true;
  if (confirmBtn) confirmBtn.disabled = true;
  if (backBtn) backBtn.disabled = true;
  commitSetErr("cedit-confirm-error", "");

  try {
    const token = await getToken();
    await fetchReportPost("/api/admin-inventory", token, {
      action: "channel_commitment_update",
      id: String(id),
      commitment: {
        channel: built.channel,
        external_order_id: built.external_order_id,
        product_slug: built.product_slug,
        size: built.size,
        quantity_cases: built.quantity_cases,
        quantity_boxes: built.quantity_boxes,
        sold_at: built.sold_at,
        notes: built.notes,
      },
    });
    closeDrawer();
    toast("Commitment updated.", "success");
    await loadStock();
  } catch (error) {
    const msg =
      error instanceof ReportPostError
        ? error.message || "The server rejected the update."
        : error?.message || "Could not update the commitment.";
    commitSetErr("cedit-confirm-error", msg);
    if (confirmBtn) confirmBtn.disabled = false;
    if (backBtn) backBtn.disabled = false;
  } finally {
    commitInFlight = false;
  }
}

/* -- Ship / Cancel / Delete confirmation (status + delete actions) --------- */

const COMMIT_ACTIONS = {
  ship: {
    title: "Mark external commitment as shipped?",
    copy: "This updates the external commitment status. It does not directly change physical stock.",
    confirmLabel: "Confirm mark shipped",
    successMsg: "Commitment marked shipped.",
    danger: false,
  },
  cancel: {
    title: "Cancel this external commitment?",
    copy: "This sets the commitment status to cancelled and removes it from estimated-availability demand. It does not change physical stock.",
    confirmLabel: "Confirm cancel",
    successMsg: "Commitment cancelled.",
    danger: true,
  },
  delete: {
    title: "Remove this external commitment?",
    copy: "Removing this record deletes the external demand used in estimated-availability math. It does not change physical stock.",
    confirmLabel: "Confirm remove",
    successMsg: "Commitment removed.",
    danger: true,
  },
};

function openCommitmentActionDrawer(kind, id) {
  const cfg = COMMIT_ACTIONS[kind];
  const r = findCommitment(id);
  if (!cfg || !r) {
    toast("Could not find that commitment.", "danger");
    return;
  }
  const slugToName = buildSlugToCatalogName(stockData?.editor?.groups || []);
  const pname = escapeHtml(slugToName.get(String(r.product_slug || "")) || r.product_slug || "—");

  const body = `
    <div class="sg-info-banner" role="note">
      <span class="sg-info-banner__icon">${icon("info", 18)}</span>
      <span>${escapeHtml(cfg.copy)}</span>
    </div>
    <div class="sg-confirm__summary">
      <div class="sg-preview__row"><span>Channel</span><strong>${escapeHtml(salesChannelLabel(r.channel))}</strong></div>
      <div class="sg-preview__row"><span>External order ID</span><strong>${r.external_order_id ? escapeHtml(String(r.external_order_id)) : "—"}</strong></div>
      <div class="sg-preview__row"><span>Product</span><strong>${pname} · ${escapeHtml(String(r.size ?? ""))}</strong></div>
      <div class="sg-preview__row"><span>Quantity</span><strong>${escapeHtml(fmtCB(r.quantity_cases, r.quantity_boxes))}</strong></div>
      <div class="sg-preview__row"><span>Physical stock</span><strong>No direct change</strong></div>
    </div>
    <p class="sg-error" id="cact-error" role="alert" hidden></p>
    <div class="sg-drawer-actions">
      <button type="button" class="sg-btn sg-btn--ghost" id="cact-cancel">Back</button>
      <button type="button" class="sg-btn sg-btn--primary${cfg.danger ? " sg-btn--danger" : ""}" id="cact-confirm">${escapeHtml(
        cfg.confirmLabel,
      )}</button>
    </div>`;

  openDrawer({ title: cfg.title, bodyHtml: body });
  document.getElementById("cact-cancel")?.addEventListener("click", () => closeDrawer());
  document.getElementById("cact-confirm")?.addEventListener("click", () => submitCommitmentAction(kind, String(r.id)));
}

async function submitCommitmentAction(kind, id) {
  if (hasInventoryMutationInFlight()) return;
  const cfg = COMMIT_ACTIONS[kind];
  if (!cfg) return;
  const confirmBtn = document.getElementById("cact-confirm");
  const backBtn = document.getElementById("cact-cancel");

  commitInFlight = true;
  if (confirmBtn) confirmBtn.disabled = true;
  if (backBtn) backBtn.disabled = true;
  commitSetErr("cact-error", "");

  const payload =
    kind === "delete"
      ? { action: "channel_commitment_delete", id: String(id) }
      : { action: "channel_commitment_update_status", id: String(id), status: kind === "ship" ? "shipped" : "cancelled" };

  try {
    const token = await getToken();
    await fetchReportPost("/api/admin-inventory", token, payload);
    closeDrawer();
    toast(cfg.successMsg, "success");
    await loadStock();
  } catch (error) {
    const msg =
      error instanceof ReportPostError
        ? error.message || "The server rejected the action."
        : error?.message || "Could not complete the action.";
    commitSetErr("cact-error", msg);
    if (confirmBtn) confirmBtn.disabled = false;
    if (backBtn) backBtn.disabled = false;
  } finally {
    commitInFlight = false;
  }
}

/* ------------------------------------------------------ override history */

function fmtOverrideUnits(cases, boxes) {
  const c = Number.isFinite(Number(cases)) ? Math.floor(Number(cases)) : null;
  const b = Number.isFinite(Number(boxes)) ? Math.floor(Number(boxes)) : null;
  const parts = [];
  if (c) parts.push(`${c} case${c === 1 ? "" : "s"}`);
  if (b) parts.push(`${b} box${b === 1 ? "" : "es"}`);
  // Fall back to a single "0 cases" so a genuine zero state still reads clearly.
  if (!parts.length) {
    if (c === 0 || b === 0) return "0 cases";
    return "—";
  }
  return parts.join(" · ");
}

function fmtOverrideDelta(dc, db) {
  const parts = [];
  const c = Number(dc) || 0;
  const b = Number(db) || 0;
  if (c !== 0) parts.push(`${c > 0 ? "+" : ""}${c} case${Math.abs(c) === 1 ? "" : "s"}`);
  if (b !== 0) parts.push(`${b > 0 ? "+" : ""}${b} box${Math.abs(b) === 1 ? "" : "es"}`);
  return parts.length ? parts.join(", ") : "—";
}

function renderOverrideHistoryCard() {
  const overrides = Array.isArray(stockData?.stockOverrideHistory?.overrides)
    ? stockData.stockOverrideHistory.overrides
    : [];

  const rowsHtml = overrides
    .map(
      (row) => `<tr>
        <td class="sg-muted">${escapeHtml(fmtDateTime(row.createdAt))}</td>
        <td>${escapeHtml(row.createdBy || "—")}</td>
        <td>${escapeHtml(row.productName || row.productSlug || "—")}</td>
        <td class="sg-muted">${escapeHtml(row.size || "—")}</td>
        <td class="sg-table__num sg-nowrap">${escapeHtml(fmtOverrideUnits(row.oldCases, row.oldBoxes))}</td>
        <td class="sg-table__num sg-nowrap">${escapeHtml(fmtOverrideUnits(row.newCases, row.newBoxes))}</td>
        <td class="sg-table__num sg-nowrap">${escapeHtml(fmtOverrideDelta(row.deltaCases, row.deltaBoxes))}</td>
        <td class="sg-muted">${escapeHtml(row.overrideNote || row.reason || "—")}</td>
      </tr>`,
    )
    .join("");

  const count = overrides.length;
  const table = tableShell({
    columns: [
      { label: "When" },
      { label: "Admin" },
      { label: "Product" },
      { label: "Size" },
      { label: "Was", align: "right" },
      { label: "Now", align: "right" },
      { label: "Change", align: "right" },
      { label: "Note" },
    ],
    rowsHtml,
    emptyHtml: emptyState({ title: "No stock overrides recorded yet", text: "Manual stock changes will be logged here." }),
  });

  // Kept visually secondary: a collapsed, muted disclosure so it doesn't dominate the page.
  const body = `<details class="sg-collapse">
    <summary class="sg-collapse__summary">
      <span class="sg-collapse__title">Stock Override History</span>
      <span class="sg-collapse__meta">${count} recorded · read-only</span>
      ${icon("chevron-down", 16, "sg-collapse__chevron")}
    </summary>
    <div class="sg-collapse__body">${table}</div>
  </details>`;
  return card({ bodyHtml: body, className: "sg-card--muted" });
}

/* ------------------------------------------- Update Stock drawer (Phase 2) */
/*
 * The ONLY write flow wired in admin-v2. Overrides physical on-hand for a single
 * variant through the existing stock_patch action, reusing the exact payload the
 * old /admin page sends. Two-step safety: an always-visible warning banner plus a
 * required "Override physical stock?" confirmation before any POST.
 */

/** Options for the product <select> (unique products, in editor order). */
function updateStockProductOptions(selectedSlug) {
  const seen = new Set();
  const opts = [];
  for (const v of editorVariantList()) {
    if (seen.has(v.slug)) continue;
    seen.add(v.slug);
    opts.push(
      `<option value="${escapeHtml(v.slug)}"${v.slug === selectedSlug ? " selected" : ""}>${escapeHtml(
        v.productName,
      )}</option>`,
    );
  }
  return opts.join("");
}

/** Options for the size <select> for a given product. */
function updateStockSizeOptions(slug, selectedSize) {
  return editorVariantList()
    .filter((v) => v.slug === slug)
    .map(
      (v) => `<option value="${escapeHtml(v.size)}"${v.size === selectedSize ? " selected" : ""}>${escapeHtml(v.size)}</option>`,
    )
    .join("");
}

function openUpdateStockDrawer(preselect) {
  const variants = editorVariantList();
  if (!variants.length) {
    toast("No editable products found in the current stock snapshot.", "danger");
    return;
  }

  const initialSlug = preselect?.slug && variants.some((v) => v.slug === preselect.slug) ? preselect.slug : variants[0].slug;
  const sizesForSlug = variants.filter((v) => v.slug === initialSlug);
  const initialSize =
    preselect?.size && sizesForSlug.some((v) => v.size === preselect.size) ? preselect.size : sizesForSlug[0]?.size || "";

  const body = `
    <div class="sg-warn-banner" role="note">
      <span class="sg-warn-banner__icon">${icon("alert-triangle", 18)}</span>
      <span>Stock changes affect available inventory immediately.</span>
    </div>

    <div id="us-form">
      <label class="sg-field">Product
        <select class="sg-select sg-field__control" id="us-product">${updateStockProductOptions(initialSlug)}</select>
      </label>

      <label class="sg-field">Size
        <select class="sg-select sg-field__control" id="us-size">${updateStockSizeOptions(initialSlug, initialSize)}</select>
      </label>

      <div class="sg-current-line">Current physical stock: <strong id="us-current">—</strong></div>

      <div class="sg-form-grid">
        <label class="sg-field">New cases on hand
          <input class="sg-input sg-field__control" id="us-cases" type="number" min="0" step="1" inputmode="numeric" />
        </label>
        <label class="sg-field">New boxes on hand
          <input class="sg-input sg-field__control" id="us-boxes" type="number" min="0" step="1" inputmode="numeric" />
        </label>
      </div>
      <p class="sg-field__error" id="us-err-qty" hidden></p>

      <label class="sg-field">Reason
        <input class="sg-input sg-field__control" id="us-reason" type="text" maxlength="140" placeholder="e.g. Warehouse recount" />
      </label>
      <p class="sg-field__error" id="us-err-reason" hidden></p>

      <label class="sg-field">Override note / internal note <span class="sg-field__optional">(optional)</span>
        <textarea class="sg-input sg-field__control sg-textarea" id="us-note" rows="2" maxlength="300" placeholder="Context for the audit log"></textarea>
      </label>

      <div class="sg-preview">
        <div class="sg-preview__row"><span>Current stock</span><strong id="us-prev-current">—</strong></div>
        <div class="sg-preview__row"><span>New stock</span><strong id="us-prev-new">—</strong></div>
        <div class="sg-preview__row"><span>Difference</span><strong id="us-prev-diff">No change</strong></div>
      </div>

      <p class="sg-error" id="us-error" role="alert" hidden></p>

      <div class="sg-drawer-actions">
        <button type="button" class="sg-btn sg-btn--ghost" id="us-cancel">Cancel</button>
        <button type="button" class="sg-btn sg-btn--primary" id="us-save">Save stock override</button>
      </div>
    </div>

    <div id="us-confirm" class="sg-confirm" hidden>
      <h3 class="sg-confirm__title">Override physical stock?</h3>
      <p class="sg-confirm__copy">This changes physical inventory <strong>immediately</strong> and may affect Estimated Available to Sell. Continue only after verifying the actual warehouse count.</p>
      <div class="sg-confirm__summary" id="us-confirm-summary"></div>
      <p class="sg-error" id="us-confirm-error" role="alert" hidden></p>
      <div class="sg-drawer-actions">
        <button type="button" class="sg-btn sg-btn--ghost" id="us-confirm-back">Back</button>
        <button type="button" class="sg-btn sg-btn--primary" id="us-confirm-btn">Confirm override</button>
      </div>
    </div>`;

  openDrawer({ title: "Update Stock", bodyHtml: body });
  wireUpdateStockDrawer();
}

function wireUpdateStockDrawer() {
  const q = (id) => document.getElementById(id);
  const productSel = q("us-product");
  const sizeSel = q("us-size");
  const casesInput = q("us-cases");
  const boxesInput = q("us-boxes");

  function current() {
    return variantCurrent(productSel?.value, sizeSel?.value);
  }

  function loadVariantIntoInputs() {
    const v = current();
    const cur = q("us-current");
    if (cur) cur.textContent = v ? fmtCB(v.cases, v.boxes) : "—";
    if (v) {
      if (casesInput) casesInput.value = String(v.cases);
      if (boxesInput) boxesInput.value = String(v.boxes);
    }
    clearFieldErrors();
    updatePreview();
  }

  function readQty(input) {
    const raw = String(input?.value ?? "").trim();
    if (raw === "") return { valid: false, value: 0 };
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) return { valid: false, value: 0 };
    return { valid: true, value: Math.floor(n) };
  }

  function updatePreview() {
    const v = current();
    const c = readQty(casesInput);
    const b = readQty(boxesInput);
    const newCases = c.valid ? c.value : v ? v.cases : 0;
    const newBoxes = b.valid ? b.value : v ? v.boxes : 0;
    const pc = q("us-prev-current");
    const pn = q("us-prev-new");
    const pd = q("us-prev-diff");
    if (pc) pc.textContent = v ? fmtCB(v.cases, v.boxes) : "—";
    if (pn) pn.textContent = fmtCB(newCases, newBoxes);
    if (pd) pd.textContent = v ? fmtDelta(newCases - v.cases, newBoxes - v.boxes) : "No change";
  }

  function setErr(id, msg) {
    if (id === "us-err-qty") {
      setAssociatedFieldError("us-err-qty", ["us-cases", "us-boxes"], msg);
      return;
    }
    if (id === "us-err-reason") {
      setAssociatedFieldError("us-err-reason", "us-reason", msg);
      return;
    }
    if (id === "us-error") {
      setAssociatedFieldError("us-error", ["us-product", "us-size"], msg);
      return;
    }
    const el = q(id);
    if (!el) return;
    if (msg) {
      el.textContent = msg;
      el.hidden = false;
    } else {
      el.textContent = "";
      el.hidden = true;
    }
  }

  function clearFieldErrors() {
    setErr("us-err-qty", "");
    setErr("us-err-reason", "");
    setErr("us-error", "");
  }

  /** @returns {null | { slug, size, productName, cases, boxes, reason, note }} */
  function validate() {
    clearFieldErrors();
    const v = current();
    if (!productSel?.value || !sizeSel?.value || !v) {
      setErr("us-error", "Select a product and size.");
      return null;
    }
    const c = readQty(casesInput);
    const b = readQty(boxesInput);
    if (!c.valid || !b.valid) {
      setErr("us-err-qty", "Enter whole, non-negative numbers for cases and boxes.");
      return null;
    }
    if (c.value === v.cases && b.value === v.boxes) {
      setErr("us-err-qty", "New stock matches current — change a value to override.");
      return null;
    }
    const reason = String(q("us-reason")?.value ?? "").trim();
    if (!reason) {
      setErr("us-err-reason", "A reason is required for the audit log.");
      return null;
    }
    const note = String(q("us-note")?.value ?? "").trim();
    return { slug: v.slug, size: v.size, productName: v.productName, cases: c.value, boxes: b.value, reason, note, cur: v };
  }

  productSel?.addEventListener("change", () => {
    if (sizeSel) sizeSel.innerHTML = updateStockSizeOptions(productSel.value);
    loadVariantIntoInputs();
  });
  sizeSel?.addEventListener("change", loadVariantIntoInputs);
  casesInput?.addEventListener("input", updatePreview);
  boxesInput?.addEventListener("input", updatePreview);

  q("us-cancel")?.addEventListener("click", () => closeDrawer());

  q("us-save")?.addEventListener("click", () => {
    const data = validate();
    if (!data) return;
    const summary = q("us-confirm-summary");
    const zeroWarn =
      data.cases === 0 && data.boxes === 0
        ? `<div class="sg-warn-banner" role="alert" style="margin-bottom:var(--sg-space-3)">
            <span class="sg-warn-banner__icon">${icon("alert-triangle", 18)}</span>
            <span><strong>Zero stock warning:</strong> confirming will set this product/size to <strong>0 cases and 0 boxes</strong> of physical on hand.</span>
          </div>`
        : data.cases === 0 || data.boxes === 0
          ? `<div class="sg-warn-banner" role="alert" style="margin-bottom:var(--sg-space-3)">
              <span class="sg-warn-banner__icon">${icon("alert-triangle", 18)}</span>
              <span><strong>Zero channel warning:</strong> one channel will be set to <strong>zero</strong> (${escapeHtml(
                fmtCB(data.cases, data.boxes),
              )}).</span>
            </div>`
          : "";
    if (summary) {
      summary.innerHTML = `
        ${zeroWarn}
        <div class="sg-preview__row"><span>Product</span><strong>${escapeHtml(data.productName)} · ${escapeHtml(
          data.size,
        )}</strong></div>
        <div class="sg-preview__row"><span>Current</span><strong>${escapeHtml(fmtCB(data.cur.cases, data.cur.boxes))}</strong></div>
        <div class="sg-preview__row"><span>New</span><strong>${escapeHtml(fmtCB(data.cases, data.boxes))}</strong></div>
        <div class="sg-preview__row"><span>Difference</span><strong>${escapeHtml(
          fmtDelta(data.cases - data.cur.cases, data.boxes - data.cur.boxes),
        )}</strong></div>`;
    }
    setErr("us-confirm-error", "");
    const form = q("us-form");
    const confirmEl = q("us-confirm");
    if (form) form.hidden = true;
    if (confirmEl) confirmEl.hidden = false;
  });

  q("us-confirm-back")?.addEventListener("click", () => {
    const form = q("us-form");
    const confirmEl = q("us-confirm");
    if (confirmEl) confirmEl.hidden = true;
    if (form) form.hidden = false;
  });

  q("us-confirm-btn")?.addEventListener("click", () => submitStockOverride(validate));

  loadVariantIntoInputs();
}

async function submitStockOverride(validate) {
  if (hasInventoryMutationInFlight()) return; // hard guard against double-submit / overlapping mutations
  const data = validate();
  const confirmBtn = document.getElementById("us-confirm-btn");
  const backBtn = document.getElementById("us-confirm-back");
  const saveBtn = document.getElementById("us-save");
  const cancelBtn = document.getElementById("us-cancel");
  const productSel = document.getElementById("us-product");
  const sizeSel = document.getElementById("us-size");
  const casesInput = document.getElementById("us-cases");
  const boxesInput = document.getElementById("us-boxes");
  const reasonInput = document.getElementById("us-reason");
  const noteInput = document.getElementById("us-note");
  if (!data) {
    // Validation regressed (rare) — return to the form to show the field error.
    const form = document.getElementById("us-form");
    const confirmEl = document.getElementById("us-confirm");
    if (confirmEl) confirmEl.hidden = true;
    if (form) form.hidden = false;
    return;
  }

  const setConfirmErr = (msg) => {
    const el = document.getElementById("us-confirm-error");
    if (!el) return;
    el.textContent = msg || "";
    el.hidden = !msg;
  };

  const setSavingUi = (saving) => {
    const controls = [confirmBtn, backBtn, saveBtn, cancelBtn, productSel, sizeSel, casesInput, boxesInput, reasonInput, noteInput];
    for (const el of controls) {
      if (el) el.disabled = saving;
    }
    if (confirmBtn) confirmBtn.textContent = saving ? "Saving…" : "Confirm override";
  };

  stockPatchInFlight = true;
  setSavingUi(true);
  setConfirmErr("");

  // Exact payload shape from the old /admin page: one patch per channel, setOnHand,
  // track:true, with source flagged so the backend records a stock-override entry.
  // Displayed stock is not changed until loadStock() completes after a successful POST.
  const payload = {
    action: "stock_patch",
    patches: [
      { productSlug: data.slug, size: data.size, channel: "case", setOnHand: data.cases, track: true },
      { productSlug: data.slug, size: data.size, channel: "box", setOnHand: data.boxes, track: true },
    ],
    reason: data.reason,
    source: "physical_stock_override",
    overrideNote: data.note || null,
  };

  try {
    const token = await getToken();
    await fetchReportPost("/api/admin-inventory", token, payload);
    closeDrawer();
    toast("Physical stock updated.", "success");
    await loadStock();
  } catch (error) {
    const msg =
      error instanceof ReportPostError
        ? error.message || "The server rejected the stock override."
        : error?.message || "Could not update stock.";
    setConfirmErr(msg);
    setSavingUi(false);
  } finally {
    stockPatchInFlight = false;
  }
}

/* -------------------------------------- Incoming Shipment drawer (Phase 3A) */
/*
 * Create / edit an incoming-shipment RECORD (header + expected lines). Writes only
 * through incoming_batch_create/update and incoming_batch_line_create/update/delete,
 * with payloads copied from the old /admin page. Never receives stock into physical
 * inventory. The submit is retry-safe: the header is created once (draft then flips
 * to edit) and created line ids are synced back to the DOM so a retry after a partial
 * failure updates instead of duplicating.
 */

/** Parse an expected-quantity field: blank means 0; only whole non-negatives are valid. */
function parseWholeQty(raw) {
  const s = String(raw ?? "").trim();
  if (s === "") return { valid: true, value: 0 };
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) return { valid: false, value: 0 };
  return { valid: true, value: Math.floor(n) };
}

/** A fresh expected line defaulting to the first catalog variant. */
function blankIncomingLine() {
  const vs = editorVariantList();
  const first = vs[0] || null;
  const slug = first ? first.slug : "";
  const sizes = vs.filter((v) => v.slug === slug);
  return { id: null, product_slug: slug, size: sizes[0]?.size || "", expected_cases: "", expected_boxes: "" };
}

/** Status <select> options — create: planned/in_transit; edit: current + safe planning moves only. */
function incStatusOptions(mode, currentStatus) {
  const cur = String(currentStatus || "").trim();
  let values;
  if (mode === "create") {
    values = ["planned", "in_transit"];
  } else if (cur === "planned") {
    values = ["planned", "in_transit"];
  } else if (cur === "in_transit") {
    values = ["in_transit"];
  } else {
    values = [cur || "planned"];
  }
  const selected = values.includes(cur) ? cur : values[0];
  return values
    .map((v) => `<option value="${v}"${v === selected ? " selected" : ""}>${escapeHtml(incomingStatusLabel(v))}</option>`)
    .join("");
}

function incLineCardHtml(line, idx) {
  const slug = String(line.product_slug || "");
  const size = String(line.size || "");
  const cases = line.expected_cases === "" || line.expected_cases == null ? "" : String(line.expected_cases);
  const boxes = line.expected_boxes === "" || line.expected_boxes == null ? "" : String(line.expected_boxes);
  return `<div class="sg-line" data-idx="${idx}"${line.id ? ` data-line-id="${escapeHtml(String(line.id))}"` : ""}>
    <div class="sg-line__head">
      <span class="sg-line__label">Line ${idx + 1}</span>
      <button type="button" class="sg-btn sg-btn--ghost sg-btn--icon-sm" data-inc-line-remove="${idx}" aria-label="Remove line ${
        idx + 1
      }" title="Remove line">${icon("trash-2", 15)}</button>
    </div>
    <div class="sg-form-grid">
      <label class="sg-field">Product
        <select class="sg-select sg-field__control" data-inc-line-product="${idx}">${updateStockProductOptions(slug)}</select>
      </label>
      <label class="sg-field">Size
        <select class="sg-select sg-field__control" data-inc-line-size="${idx}">${updateStockSizeOptions(slug, size)}</select>
      </label>
    </div>
    <div class="sg-form-grid">
      <label class="sg-field">Expected cases
        <input class="sg-input sg-field__control" type="number" min="0" step="1" inputmode="numeric" data-inc-line-cases="${idx}" value="${escapeHtml(
          cases,
        )}" />
      </label>
      <label class="sg-field">Expected boxes
        <input class="sg-input sg-field__control" type="number" min="0" step="1" inputmode="numeric" data-inc-line-boxes="${idx}" value="${escapeHtml(
          boxes,
        )}" />
      </label>
    </div>
  </div>`;
}

function renderIncLines() {
  const host = document.getElementById("inc-lines");
  if (!host || !incDraft) return;
  host.innerHTML = incDraft.lines.length
    ? incDraft.lines.map((l, i) => incLineCardHtml(l, i)).join("")
    : `<p class="sg-note" style="margin:0">No expected lines yet — add at least one.</p>`;
}

/** Snapshot the current DOM line rows back into plain objects (preserves ids). */
function readIncLinesFromDom() {
  const host = document.getElementById("inc-lines");
  if (!host || !incDraft) return incDraft ? incDraft.lines : [];
  const out = [];
  host.querySelectorAll(".sg-line").forEach((el) => {
    const idx = Number(el.getAttribute("data-idx"));
    const existing = incDraft.lines[idx] || {};
    out.push({
      id: existing.id || el.getAttribute("data-line-id") || null,
      product_slug: el.querySelector("[data-inc-line-product]")?.value || "",
      size: el.querySelector("[data-inc-line-size]")?.value || "",
      expected_cases: String(el.querySelector("[data-inc-line-cases]")?.value ?? "").trim(),
      expected_boxes: String(el.querySelector("[data-inc-line-boxes]")?.value ?? "").trim(),
    });
  });
  return out;
}

/**
 * @param {"create"|"edit"} mode
 * @param {string|null} batchId
 */
function openIncomingShipmentDrawer(mode, batchId) {
  const variants = editorVariantList();
  if (!variants.length) {
    toast("No catalog products available to build a shipment.", "danger");
    return;
  }

  let b = {};
  if (mode === "edit") {
    const row = incomingRows().find((r) => String(r.batch?.id) === String(batchId));
    if (!row) {
      toast("Could not find that shipment.", "danger");
      return;
    }
    b = row.batch || {};
    if (!isIncomingEditable(b.status)) {
      toast("This shipment can no longer be edited.", "danger");
      return;
    }
    const lines = Array.isArray(row.lines) ? row.lines : [];
    incDraft = {
      mode: "edit",
      batchId: String(b.id || ""),
      currentStatus: String(b.status || "").trim(),
      originalById: new Map(),
      lines: lines.map((ln) => ({
        id: String(ln.id),
        product_slug: String(ln.product_slug || ""),
        size: String(ln.size || ""),
        expected_cases: Math.max(0, Math.floor(Number(ln.expected_cases) || 0)),
        expected_boxes: Math.max(0, Math.floor(Number(ln.expected_boxes) || 0)),
      })),
    };
    for (const ln of lines) {
      incDraft.originalById.set(String(ln.id), {
        product_slug: String(ln.product_slug || ""),
        size: String(ln.size || ""),
        expected_cases: Math.max(0, Math.floor(Number(ln.expected_cases) || 0)),
        expected_boxes: Math.max(0, Math.floor(Number(ln.expected_boxes) || 0)),
      });
    }
  } else {
    incDraft = { mode: "create", batchId: "", currentStatus: "planned", originalById: new Map(), lines: [blankIncomingLine()] };
  }

  const val = (v) => escapeHtml(v == null ? "" : String(v));
  const etaValue = b.eta_date ? String(b.eta_date).slice(0, 10) : "";
  const title = mode === "edit" ? "Edit Incoming Shipment" : "Create Incoming Shipment";

  const body = `
    <div class="sg-info-banner" role="note">
      <span class="sg-info-banner__icon">${icon("info", 18)}</span>
      <span>This manages an <strong>incoming shipment record only</strong>. Saving does <strong>not</strong> add inventory to physical stock — quantities below are <strong>expected</strong>, not received.</span>
    </div>

    <div id="inc-form">
      <label class="sg-field">Batch name
        <input class="sg-input sg-field__control" id="inc-name" type="text" maxlength="160" value="${val(
          b.batch_name,
        )}" placeholder="e.g. March container — nitrile restock" />
      </label>
      <p class="sg-field__error" id="inc-err-name" hidden></p>

      <div class="sg-form-grid">
        <label class="sg-field">Container number <span class="sg-field__optional">(optional)</span>
          <input class="sg-input sg-field__control" id="inc-container" type="text" maxlength="120" value="${val(
            b.container_number,
          )}" />
        </label>
        <label class="sg-field">PO number <span class="sg-field__optional">(optional)</span>
          <input class="sg-input sg-field__control" id="inc-po" type="text" maxlength="120" value="${val(b.po_number)}" />
        </label>
      </div>

      <div class="sg-form-grid">
        <label class="sg-field">Supplier <span class="sg-field__optional">(optional)</span>
          <input class="sg-input sg-field__control" id="inc-supplier" type="text" maxlength="160" value="${val(
            b.supplier,
          )}" />
        </label>
        <label class="sg-field">ETA date <span class="sg-field__optional">(optional)</span>
          <input class="sg-input sg-field__control" id="inc-eta" type="date" value="${val(etaValue)}" />
        </label>
      </div>

      <label class="sg-field">Status
        <select class="sg-select sg-field__control" id="inc-status">${incStatusOptions(mode, b.status)}</select>
      </label>

      <label class="sg-field">Notes <span class="sg-field__optional">(optional)</span>
        <textarea class="sg-input sg-field__control sg-textarea" id="inc-notes" rows="2" maxlength="500" placeholder="Internal context for this shipment">${val(
          b.notes,
        )}</textarea>
      </label>

      <div class="sg-drawer-section">
        <div class="sg-line-head">
          <p class="sg-drawer-section__title" style="margin:0">Expected inventory</p>
          <button type="button" class="sg-btn sg-btn--ghost sg-btn--sm" id="inc-add-line">${icon(
            "plus",
            14,
          )}<span>Add line</span></button>
        </div>
        <div id="inc-lines"></div>
        <p class="sg-field__error" id="inc-err-lines" hidden></p>
      </div>

      <p class="sg-error" id="inc-error" role="alert" hidden></p>

      <div class="sg-drawer-actions">
        <button type="button" class="sg-btn sg-btn--ghost" id="inc-cancel">Cancel</button>
        <button type="button" class="sg-btn sg-btn--primary" id="inc-save">${
          mode === "edit" ? "Review changes" : "Review shipment"
        }</button>
      </div>
    </div>

    <div id="inc-confirm" class="sg-confirm" hidden>
      <h3 class="sg-confirm__title">${
        mode === "edit" ? "Update incoming shipment record?" : "Create incoming shipment record?"
      }</h3>
      <p class="sg-confirm__copy">This ${
        mode === "edit" ? "updates" : "creates"
      } an incoming shipment record only. It does <strong>not</strong> add inventory to physical stock.</p>
      <div class="sg-confirm__summary" id="inc-confirm-summary"></div>
      <p class="sg-error" id="inc-confirm-error" role="alert" hidden></p>
      <div class="sg-drawer-actions">
        <button type="button" class="sg-btn sg-btn--ghost" id="inc-confirm-back">Back</button>
        <button type="button" class="sg-btn sg-btn--primary" id="inc-confirm-btn">${
          mode === "edit" ? "Confirm update" : "Confirm create"
        }</button>
      </div>
    </div>`;

  openDrawer({ title, bodyHtml: body });
  renderIncLines();
  wireIncomingDrawer();
}

function incSetErr(id, msg) {
  if (id === "inc-err-name") {
    setAssociatedFieldError("inc-err-name", "inc-name", msg);
    return;
  }
  if (id === "inc-err-lines") {
    setAssociatedFieldError("inc-err-lines", null, msg);
    return;
  }
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = msg || "";
  el.hidden = !msg;
}

function wireIncomingDrawer() {
  const host = document.getElementById("inc-lines");

  document.getElementById("inc-add-line")?.addEventListener("click", () => {
    incDraft.lines = readIncLinesFromDom();
    incDraft.lines.push(blankIncomingLine());
    renderIncLines();
  });

  host?.addEventListener("click", (ev) => {
    const btn = ev.target.closest("[data-inc-line-remove]");
    if (!btn) return;
    const idx = Number(btn.getAttribute("data-inc-line-remove"));
    incDraft.lines = readIncLinesFromDom();
    incDraft.lines.splice(idx, 1);
    renderIncLines();
  });

  host?.addEventListener("change", (ev) => {
    const sel = ev.target.closest("[data-inc-line-product]");
    if (!sel) return;
    const idx = Number(sel.getAttribute("data-inc-line-product"));
    const sizeSel = host.querySelector(`[data-inc-line-size="${idx}"]`);
    if (sizeSel) sizeSel.innerHTML = updateStockSizeOptions(sel.value);
  });

  document.getElementById("inc-cancel")?.addEventListener("click", () => {
    incDraft = null;
    closeDrawer();
  });

  document.getElementById("inc-save")?.addEventListener("click", () => {
    const data = validateIncoming();
    if (!data) return;
    fillIncomingConfirmSummary(data);
    incSetErr("inc-confirm-error", "");
    const form = document.getElementById("inc-form");
    const confirmEl = document.getElementById("inc-confirm");
    if (form) form.hidden = true;
    if (confirmEl) confirmEl.hidden = false;
  });

  document.getElementById("inc-confirm-back")?.addEventListener("click", () => {
    const form = document.getElementById("inc-form");
    const confirmEl = document.getElementById("inc-confirm");
    if (confirmEl) confirmEl.hidden = true;
    if (form) form.hidden = false;
  });

  document.getElementById("inc-confirm-btn")?.addEventListener("click", () => submitIncomingShipment());
}

/** @returns {null | { batch: object, lines: {id: string|null, product_slug, size, expected_cases, expected_boxes}[] }} */
function validateIncoming() {
  incSetErr("inc-err-name", "");
  incSetErr("inc-err-lines", "");
  incSetErr("inc-error", "");

  const name = String(document.getElementById("inc-name")?.value || "").trim();
  if (!name) {
    incSetErr("inc-err-name", "Batch name is required.");
    return null;
  }

  const status = String(document.getElementById("inc-status")?.value || "planned").trim();

  const domLines = readIncLinesFromDom();
  incDraft.lines = domLines;
  if (!domLines.length) {
    incSetErr("inc-err-lines", "Add at least one expected inventory line.");
    return null;
  }

  const lines = [];
  const seen = new Set();
  for (let i = 0; i < domLines.length; i += 1) {
    const ln = domLines[i];
    const slug = String(ln.product_slug || "").trim();
    const size = String(ln.size || "").trim();
    if (!slug || !size) {
      incSetErr("inc-err-lines", `Line ${i + 1}: select a product and size.`);
      return null;
    }
    const key = `${slug}\t${size}`;
    if (seen.has(key)) {
      incSetErr("inc-err-lines", `Line ${i + 1}: duplicate product + size — combine the quantities instead.`);
      return null;
    }
    seen.add(key);
    const c = parseWholeQty(ln.expected_cases);
    const bx = parseWholeQty(ln.expected_boxes);
    if (!c.valid || !bx.valid) {
      incSetErr("inc-err-lines", `Line ${i + 1}: enter whole, non-negative quantities.`);
      return null;
    }
    if (c.value <= 0 && bx.value <= 0) {
      incSetErr("inc-err-lines", `Line ${i + 1}: at least one expected case or box must be greater than 0.`);
      return null;
    }
    lines.push({ id: ln.id || null, product_slug: slug, size, expected_cases: c.value, expected_boxes: bx.value });
  }

  const eta = String(document.getElementById("inc-eta")?.value || "").trim();
  return {
    batch: {
      batch_name: name,
      container_number: String(document.getElementById("inc-container")?.value || "").trim() || null,
      po_number: String(document.getElementById("inc-po")?.value || "").trim() || null,
      supplier: String(document.getElementById("inc-supplier")?.value || "").trim() || null,
      eta_date: eta || null,
      status,
      notes: String(document.getElementById("inc-notes")?.value || "").trim() || null,
    },
    lines,
  };
}

function fillIncomingConfirmSummary(data) {
  const el = document.getElementById("inc-confirm-summary");
  if (!el) return;
  const slugToName = buildSlugToCatalogName(stockData?.editor?.groups || []);
  let tc = 0;
  let tb = 0;
  for (const ln of data.lines) {
    tc += ln.expected_cases;
    tb += ln.expected_boxes;
  }
  const lineItems = data.lines
    .map(
      (ln) =>
        `<li>${escapeHtml(slugToName.get(ln.product_slug) || ln.product_slug)} · ${escapeHtml(
          ln.size,
        )} — ${escapeHtml(fmtCB(ln.expected_cases, ln.expected_boxes))}</li>`,
    )
    .join("");
  el.innerHTML = `
    <div class="sg-preview__row"><span>Batch</span><strong>${escapeHtml(data.batch.batch_name)}</strong></div>
    <div class="sg-preview__row"><span>Supplier</span><strong>${escapeHtml(data.batch.supplier || "—")}</strong></div>
    <div class="sg-preview__row"><span>Status</span><strong>${escapeHtml(incomingStatusLabel(data.batch.status))}</strong></div>
    <div class="sg-preview__row"><span>ETA</span><strong>${escapeHtml(data.batch.eta_date || "—")}</strong></div>
    <div class="sg-preview__row"><span>Total expected</span><strong>${escapeHtml(fmtCB(tc, tb))}</strong></div>
    <div class="sg-confirm__lines">
      <p class="sg-drawer-section__title" style="margin:0 0 6px">Lines (${data.lines.length})</p>
      <ul class="sg-note-list">${lineItems}</ul>
    </div>`;
}

async function submitIncomingShipment() {
  if (hasInventoryMutationInFlight()) return;
  const data = validateIncoming();
  const confirmBtn = document.getElementById("inc-confirm-btn");
  const backBtn = document.getElementById("inc-confirm-back");
  if (!data || !incDraft) {
    const form = document.getElementById("inc-form");
    const confirmEl = document.getElementById("inc-confirm");
    if (confirmEl) confirmEl.hidden = true;
    if (form) form.hidden = false;
    return;
  }

  const setConfirmErr = (msg) => incSetErr("inc-confirm-error", msg);

  incomingSaveInFlight = true;
  if (confirmBtn) confirmBtn.disabled = true;
  if (backBtn) backBtn.disabled = true;
  setConfirmErr("");

  /** @type {string} */
  let step = "header";
  try {
    const token = await getToken();

    // 1) Header — create once then flip the draft to edit so a retry never duplicates.
    // Multi-request save is not transactional; failed steps keep draft state for retry.
    if (incDraft.mode === "create" && !incDraft.batchId) {
      step = "create batch header";
      const created = await fetchReportPost("/api/admin-inventory", token, {
        action: "incoming_batch_create",
        batch: data.batch,
      });
      const newId = created?.batch?.id != null ? String(created.batch.id) : "";
      if (!newId) throw new Error("Server did not return a batch id.");
      incDraft.batchId = newId;
      incDraft.mode = "edit";
      incDraft.currentStatus = data.batch.status;
    } else {
      step = "update batch header";
      await fetchReportPost("/api/admin-inventory", token, {
        action: "incoming_batch_update",
        id: incDraft.batchId,
        batch: data.batch,
      });
      incDraft.currentStatus = data.batch.status;
    }

    const batchId = incDraft.batchId;

    // 2) Deletes — original lines no longer present in the form.
    const presentIds = new Set(data.lines.filter((l) => l.id).map((l) => String(l.id)));
    for (const origId of Array.from(incDraft.originalById.keys())) {
      if (!presentIds.has(origId)) {
        step = `delete line ${origId}`;
        await fetchReportPost("/api/admin-inventory", token, { action: "incoming_batch_line_delete", id: origId });
        incDraft.originalById.delete(origId);
      }
    }

    // 3) Creates + changed updates. Sync new ids back to draft + DOM for retry-safety.
    for (let i = 0; i < data.lines.length; i += 1) {
      const ln = data.lines[i];
      const linePayload = {
        product_slug: ln.product_slug,
        size: ln.size,
        expected_cases: ln.expected_cases,
        expected_boxes: ln.expected_boxes,
      };
      if (!ln.id) {
        step = `create line ${i + 1}`;
        const res = await fetchReportPost("/api/admin-inventory", token, {
          action: "incoming_batch_line_create",
          batch_id: batchId,
          line: linePayload,
        });
        const newLineId = res?.line?.id != null ? String(res.line.id) : null;
        if (newLineId) {
          ln.id = newLineId;
          incDraft.originalById.set(newLineId, { ...linePayload });
          if (incDraft.lines[i]) incDraft.lines[i].id = newLineId;
          const domRow = document.querySelector(`#inc-lines .sg-line[data-idx="${i}"]`);
          if (domRow) domRow.setAttribute("data-line-id", newLineId);
        }
      } else {
        const orig = incDraft.originalById.get(String(ln.id));
        const changed =
          !orig ||
          orig.product_slug !== ln.product_slug ||
          orig.size !== ln.size ||
          Number(orig.expected_cases) !== Number(ln.expected_cases) ||
          Number(orig.expected_boxes) !== Number(ln.expected_boxes);
        if (changed) {
          step = `update line ${i + 1}`;
          await fetchReportPost("/api/admin-inventory", token, {
            action: "incoming_batch_line_update",
            id: ln.id,
            line: linePayload,
          });
          incDraft.originalById.set(String(ln.id), { ...linePayload });
        }
      }
    }

    closeDrawer();
    incDraft = null;
    toast("Incoming shipment saved.", "success");
    await loadStock();
  } catch (error) {
    const base =
      error instanceof ReportPostError
        ? error.message || "The server rejected the shipment."
        : error?.message || "Could not save the shipment.";
    setConfirmErr(
      `Save incomplete (failed at: ${step}). ${base} Partial changes may already be stored — review and retry; this save is not transactional.`,
    );
    if (confirmBtn) confirmBtn.disabled = false;
    if (backBtn) backBtn.disabled = false;
    // Refresh so the UI reflects any partial server state while keeping the draft for retry.
    try {
      await loadStock();
    } catch {
      /* keep drawer open with draft */
    }
  } finally {
    incomingSaveInFlight = false;
  }
}

/* --------------------------------- Shipment status workflow (Phase 3B) */
/*
 * Arrival / hold / release / cancel — status-only updates via incoming_batch_update.
 * Never receives stock. Payload shape, appended audit notes, and arrival_date usage
 * are copied from the old /admin page so behaviour + attribution match.
 */

/** Local YYYY-MM-DD (mirrors old localIsoToday). */
function todayIso() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Append an audit note to existing notes (mirrors old appendIncomingBatchNote). */
function appendBatchNote(existing, addition) {
  const a = String(existing ?? "").trim();
  const b = String(addition ?? "").trim();
  if (!b) return a || null;
  if (!a) return b;
  return `${a}\n\n${b}`;
}

/**
 * Status-workflow action catalogue. `reason` is "required" | "optional".
 * Only transitions the backend permits (see lib VALID_STATUS_TRANSITIONS) are offered.
 * Mark-arrived requires an explicit operator physical-count acknowledgement (frontend only;
 * the backend does not verify expected vs actual quantities).
 */
const ARRIVAL_CONFIRM_PHRASE = "COUNTS REVIEWED";

const STATUS_ACTIONS = {
  mark_arrived: {
    label: "Mark as arrived",
    newStatus: "arrived",
    needsDate: true,
    reason: "optional",
    requiresPhysicalConfirm: true,
    variant: "primary",
    tag: (d) => `[Marked arrived ${d}]`,
    successMsg: "Shipment marked as arrived (status only — physical stock unchanged until Receive).",
  },
  place_hold: {
    label: "Place on hold",
    newStatus: "on_hold",
    needsDate: false,
    reason: "required",
    requiresPhysicalConfirm: false,
    variant: "warning",
    tag: () => `[On hold]`,
    successMsg: "Shipment placed on hold.",
  },
  release_hold: {
    label: "Release from hold",
    newStatus: "arrived",
    needsDate: false,
    reason: "optional",
    requiresPhysicalConfirm: false,
    variant: "primary",
    tag: (d) => `[Hold released ${d}]`,
    successMsg: "Hold released — shipment back to arrived.",
  },
  cancel: {
    label: "Cancel shipment",
    newStatus: "cancelled",
    needsDate: false,
    reason: "required",
    requiresPhysicalConfirm: false,
    variant: "danger",
    tag: (d) => `[Cancelled ${d}]`,
    successMsg: "Shipment cancelled.",
  },
};

/** Which status actions are valid from a given current status. */
function statusActionKeysFor(status) {
  switch (String(status || "").trim()) {
    case "planned":
    case "in_transit":
      return ["mark_arrived", "place_hold", "cancel"];
    case "arrived":
      return ["place_hold", "cancel"];
    case "on_hold":
      return ["release_hold", "cancel"];
    default:
      return [];
  }
}

function statusActionBtnClass(variant) {
  if (variant === "danger") return "sg-btn sg-btn--ghost sg-btn--block sg-btn--danger";
  return "sg-btn sg-btn--ghost sg-btn--block";
}

function openStatusDrawer(batchId) {
  const row = incomingRows().find((r) => String(r.batch?.id) === String(batchId));
  if (!row) {
    toast("Could not find that shipment.", "danger");
    return;
  }
  const b = row.batch || {};
  const st = String(b.status || "").trim();
  const keys = statusActionKeysFor(st);
  if (!keys.length) {
    toast("This shipment's status can no longer be changed.", "danger");
    return;
  }

  const lines = Array.isArray(row.lines) ? row.lines : [];
  const slugToName = buildSlugToCatalogName(stockData?.editor?.groups || []);
  let expCases = 0;
  let expBoxes = 0;
  for (const ln of lines) {
    expCases += Math.max(0, Math.floor(Number(ln.expected_cases) || 0));
    expBoxes += Math.max(0, Math.floor(Number(ln.expected_boxes) || 0));
  }

  const metaRow = (label, value) =>
    `<div class="sg-detail-row"><span class="sg-detail-row__label">${escapeHtml(
      label,
    )}</span><span class="sg-detail-row__value">${value}</span></div>`;

  const linesRows = lines.length
    ? lines
        .map((ln) => {
          const slug = String(ln.product_slug || "").trim();
          const pname = escapeHtml(slugToName.get(slug) || slug || "—");
          return `<tr>
            <td>${pname}</td>
            <td class="sg-muted">${escapeHtml(String(ln.size ?? ""))}</td>
            <td class="sg-table__num">${escapeHtml(fmtCB(ln.expected_cases, ln.expected_boxes))}</td>
          </tr>`;
        })
        .join("")
    : "";
  const linesTable = tableShell({
    columns: [{ label: "Product" }, { label: "Size" }, { label: "Expected", align: "right" }],
    rowsHtml: linesRows,
    emptyHtml: emptyState({ title: "No lines", text: "This shipment has no expected lines." }),
  });

  const actionButtons = keys
    .map((k) => {
      const a = STATUS_ACTIONS[k];
      return `<button type="button" class="${statusActionBtnClass(a.variant)}" data-ss-action="${k}">${escapeHtml(
        a.label,
      )}</button>`;
    })
    .join("");

  const body = `
    <div class="sg-info-banner" role="note">
      <span class="sg-info-banner__icon">${icon("info", 18)}</span>
      <span>This updates <strong>shipment status only</strong>. It does <strong>not</strong> receive inventory into physical stock.</span>
    </div>

    <div class="sg-detail-list">
      ${metaRow("Status", statusChip(incomingStatusLabel(st), incomingStatusVariant(st)))}
      ${metaRow("Supplier", escapeHtml(b.supplier ? String(b.supplier).trim() : "—"))}
      ${metaRow("Container", escapeHtml(b.container_number ? String(b.container_number).trim() : "—"))}
      ${metaRow("PO number", escapeHtml(b.po_number ? String(b.po_number).trim() : "—"))}
      ${metaRow("ETA date", escapeHtml(fmtDateShort(b.eta_date)))}
      ${metaRow("Total expected", escapeHtml(fmtCB(expCases, expBoxes)))}
    </div>

    <div class="sg-drawer-section">
      <p class="sg-drawer-section__title">Expected lines</p>
      ${linesTable}
    </div>

    <div id="ss-choose" class="sg-drawer-section">
      <p class="sg-drawer-section__title">Update status</p>
      <div class="sg-status-actions">${actionButtons}</div>
      <p class="sg-note sg-note--readonly" style="margin-top:var(--sg-space-3)">${icon(
        "info",
        14,
        "sg-note__icon",
      )} Status changes do not receive stock. Use <strong>Place on hold</strong> when actual quantities differ from expected. Receiving into physical inventory is a separate step and requires status <strong>arrived</strong>.</p>
    </div>

    <div id="ss-form" class="sg-drawer-section" hidden>
      <h3 class="sg-confirm__title" id="ss-form-title"></h3>
      <div class="sg-field" id="ss-date-wrap" hidden>Actual arrival date
        <input class="sg-input sg-field__control" id="ss-date" type="date" value="${escapeHtml(todayIso())}" />
      </div>
      <div id="ss-arrival-ack" class="sg-warn-banner" role="note" hidden style="margin-bottom:var(--sg-space-3)">
        <span class="sg-warn-banner__icon">${icon("alert-triangle", 18)}</span>
        <span>
          Confirm that the shipment was <strong>physically received</strong> and that actual quantities were reviewed against expected.
          If there is a discrepancy, go back and choose <strong>Place on hold</strong> instead.
          The server does <strong>not</strong> automatically verify expected versus actual counts.
        </span>
      </div>
      <label class="sg-field" id="ss-arrival-phrase-wrap" hidden>
        Type <strong>${escapeHtml(ARRIVAL_CONFIRM_PHRASE)}</strong> to confirm counts were reviewed
        <input class="sg-input sg-field__control" id="ss-arrival-phrase" type="text" autocomplete="off" spellcheck="false" placeholder="${escapeHtml(
          ARRIVAL_CONFIRM_PHRASE,
        )}" />
      </label>
      <label class="sg-field" id="ss-reason-wrap">
        <span id="ss-reason-label">Reason / note</span>
        <textarea class="sg-input sg-field__control sg-textarea" id="ss-reason" rows="3" maxlength="400" placeholder="Context for the audit log"></textarea>
      </label>
      <p class="sg-field__error" id="ss-err" hidden></p>
      <div class="sg-drawer-actions">
        <button type="button" class="sg-btn sg-btn--ghost" id="ss-form-back">Back</button>
        <button type="button" class="sg-btn sg-btn--primary" id="ss-review">Review</button>
      </div>
    </div>

    <div id="ss-confirm" class="sg-confirm" hidden>
      <h3 class="sg-confirm__title">Confirm status change?</h3>
      <p class="sg-confirm__copy" id="ss-confirm-copy">This changes the shipment record's status only. <strong>Physical stock will not change.</strong></p>
      <div class="sg-confirm__summary" id="ss-confirm-summary"></div>
      <p class="sg-error" id="ss-confirm-error" role="alert" hidden></p>
      <div class="sg-drawer-actions">
        <button type="button" class="sg-btn sg-btn--ghost" id="ss-confirm-back">Back</button>
        <button type="button" class="sg-btn sg-btn--primary" id="ss-confirm-btn">Confirm status change</button>
      </div>
    </div>`;

  openDrawer({ title: `Update Status — ${String(b.batch_name || "Shipment")}`, bodyHtml: body });
  wireStatusDrawer(b, st);
}

function wireStatusDrawer(batch, currentStatus) {
  const q = (id) => document.getElementById(id);
  let currentAction = null;

  const showStep = (step) => {
    q("ss-choose").hidden = step !== "choose";
    q("ss-form").hidden = step !== "form";
    q("ss-confirm").hidden = step !== "confirm";
  };

  const setErr = (id, msg) => {
    if (id === "ss-err") {
      const controls = [];
      if (!q("ss-date-wrap")?.hidden) controls.push("ss-date");
      if (!q("ss-arrival-phrase-wrap")?.hidden) controls.push("ss-arrival-phrase");
      if (!q("ss-reason-wrap")?.hidden) controls.push("ss-reason");
      setAssociatedFieldError("ss-err", controls.length ? controls : "ss-reason", msg);
      return;
    }
    const el = q(id);
    if (!el) return;
    el.textContent = msg || "";
    el.hidden = !msg;
  };

  // Step 1 → 2: pick an action, configure the form.
  q("ss-choose").querySelectorAll("[data-ss-action]").forEach((btn) => {
    btn.addEventListener("click", () => {
      currentAction = btn.getAttribute("data-ss-action");
      const a = STATUS_ACTIONS[currentAction];
      if (!a) return;
      q("ss-form-title").textContent = a.label;
      q("ss-date-wrap").hidden = !a.needsDate;
      const needsAck = Boolean(a.requiresPhysicalConfirm);
      if (q("ss-arrival-ack")) q("ss-arrival-ack").hidden = !needsAck;
      if (q("ss-arrival-phrase-wrap")) q("ss-arrival-phrase-wrap").hidden = !needsAck;
      if (q("ss-arrival-phrase")) q("ss-arrival-phrase").value = "";
      q("ss-reason-label").innerHTML =
        a.reason === "required"
          ? "Reason / note"
          : `Reason / note <span class="sg-field__optional">(optional)</span>`;
      q("ss-reason").value = "";
      setErr("ss-err", "");
      showStep("form");
    });
  });

  q("ss-form-back")?.addEventListener("click", () => {
    currentAction = null;
    showStep("choose");
  });

  q("ss-review")?.addEventListener("click", () => {
    const built = buildStatusChange(batch, currentStatus, currentAction);
    if (!built) return;
    const s = q("ss-confirm-summary");
    const copyEl = q("ss-confirm-copy");
    if (copyEl) {
      copyEl.innerHTML = built.requiresPhysicalConfirm
        ? `This marks the batch <strong>arrived</strong> (status only). Physical stock does <strong>not</strong> change until you use <strong>Receive stock</strong>. The server does not verify expected vs actual counts.`
        : `This changes the shipment record's status only. <strong>Physical stock will not change.</strong>`;
    }
    if (s) {
      const reasonText = built.reasonText ? escapeHtml(built.reasonText) : "—";
      const ackRow = built.requiresPhysicalConfirm
        ? `<div class="sg-preview__row"><span>Physical count review</span><strong>Operator confirmed (${escapeHtml(
            ARRIVAL_CONFIRM_PHRASE,
          )})</strong></div>
           <div class="sg-preview__row"><span>If quantities differ</span><strong>Use Place on hold instead</strong></div>`
        : "";
      s.innerHTML = `
        <div class="sg-preview__row"><span>Current status</span><strong>${escapeHtml(
          incomingStatusLabel(currentStatus),
        )}</strong></div>
        <div class="sg-preview__row"><span>New status</span><strong>${escapeHtml(
          incomingStatusLabel(built.newStatus),
        )}</strong></div>
        ${
          built.arrivalDate
            ? `<div class="sg-preview__row"><span>Arrival date</span><strong>${escapeHtml(built.arrivalDate)}</strong></div>`
            : ""
        }
        ${ackRow}
        <div class="sg-preview__row"><span>Reason / note</span><strong>${reasonText}</strong></div>
        <div class="sg-preview__row"><span>Physical stock</span><strong>No change</strong></div>`;
    }
    setErr("ss-confirm-error", "");
    showStep("confirm");
  });

  q("ss-confirm-back")?.addEventListener("click", () => showStep("form"));

  q("ss-confirm-btn")?.addEventListener("click", () => submitStatusChange(batch, currentStatus, currentAction));
}

/**
 * Validate + build the incoming_batch_update payload for a status action.
 * @returns {null | { payload: object, newStatus: string, arrivalDate: string|null, reasonText: string, successMsg: string, requiresPhysicalConfirm: boolean }}
 */
function buildStatusChange(batch, currentStatus, actionKey) {
  const a = STATUS_ACTIONS[actionKey];
  const setErr = (msg) => {
    const controls = [];
    const dateWrap = document.getElementById("ss-date-wrap");
    const phraseWrap = document.getElementById("ss-arrival-phrase-wrap");
    if (dateWrap && !dateWrap.hidden) controls.push("ss-date");
    if (phraseWrap && !phraseWrap.hidden) controls.push("ss-arrival-phrase");
    controls.push("ss-reason");
    setAssociatedFieldError("ss-err", controls, msg);
  };
  setErr("");
  if (!a) {
    setErr("Choose a status action.");
    return null;
  }

  const reasonText = String(document.getElementById("ss-reason")?.value ?? "").trim();
  if (a.reason === "required" && !reasonText) {
    setErr("A reason or note is required for this status change.");
    return null;
  }

  let arrivalDate = null;
  if (a.needsDate) {
    arrivalDate = String(document.getElementById("ss-date")?.value ?? "").trim();
    if (!arrivalDate) {
      setErr("Select the actual arrival date.");
      return null;
    }
  }

  const requiresPhysicalConfirm = Boolean(a.requiresPhysicalConfirm);
  if (requiresPhysicalConfirm) {
    const phrase = String(document.getElementById("ss-arrival-phrase")?.value ?? "").trim();
    if (phrase.toUpperCase() !== ARRIVAL_CONFIRM_PHRASE) {
      setErr(`Type ${ARRIVAL_CONFIRM_PHRASE} to confirm physical receipt and count review, or go back and Place on hold if quantities differ.`);
      return null;
    }
  }

  const dateForTag = arrivalDate || todayIso();
  const noteAddition = [a.tag(dateForTag), reasonText].filter(Boolean).join(" ");
  const notes = appendBatchNote(batch?.notes, noteAddition);

  const batchPayload = { status: a.newStatus, notes };
  if (arrivalDate) batchPayload.arrival_date = arrivalDate;

  return {
    payload: { action: "incoming_batch_update", id: String(batch?.id || ""), batch: batchPayload },
    newStatus: a.newStatus,
    arrivalDate,
    reasonText,
    successMsg: a.successMsg,
    requiresPhysicalConfirm,
  };
}

async function submitStatusChange(batch, currentStatus, actionKey) {
  if (hasInventoryMutationInFlight()) return;
  const built = buildStatusChange(batch, currentStatus, actionKey);
  const confirmBtn = document.getElementById("ss-confirm-btn");
  const backBtn = document.getElementById("ss-confirm-back");
  if (!built) {
    // Validation regressed — return to the form to surface the field error.
    document.getElementById("ss-confirm").hidden = true;
    document.getElementById("ss-form").hidden = false;
    return;
  }

  const setConfirmErr = (msg) => {
    const el = document.getElementById("ss-confirm-error");
    if (!el) return;
    el.textContent = msg || "";
    el.hidden = !msg;
  };

  incomingStatusInFlight = true;
  if (confirmBtn) confirmBtn.disabled = true;
  if (backBtn) backBtn.disabled = true;
  setConfirmErr("");

  try {
    const token = await getToken();
    await fetchReportPost("/api/admin-inventory", token, built.payload);
    closeDrawer();
    toast(built.successMsg, "success");
    await loadStock();
  } catch (error) {
    const msg =
      error instanceof ReportPostError
        ? error.message || "The server rejected the status change."
        : error?.message || "Could not update shipment status.";
    setConfirmErr(msg);
    if (confirmBtn) confirmBtn.disabled = false;
    if (backBtn) backBtn.disabled = false;
  } finally {
    incomingStatusInFlight = false;
  }
}

/* ----------------------------------- Receive into physical stock (Phase 3C) */
/*
 * The first incoming flow that INCREASES physical stock. Only arrived batches are
 * receivable. Staff review received vs expected quantities, then pass a strong
 * confirmation before a single incoming_batch_receive POST. Payload + prefill copied
 * from the old /admin page: lines carry EVERY batch line as { line_id, received_cases,
 * received_boxes }, plus an optional note. Double-submit is guarded.
 */

/** Only arrived shipments can be received (mirrors lib + old /admin eligibility). */
function isReceivable(status) {
  return String(status || "").trim() === "arrived";
}

/** Classify a per-line received-vs-expected delta for the difference review. */
function classifyReceiveDiff(dCases, dBoxes) {
  const c = Number(dCases) || 0;
  const b = Number(dBoxes) || 0;
  if (c === 0 && b === 0) return "match";
  const anyShort = c < 0 || b < 0;
  const anyOver = c > 0 || b > 0;
  if (anyShort && anyOver) return "mixed";
  return anyShort ? "short" : "over";
}

function receiveDiffChip(kind) {
  switch (kind) {
    case "match":
      return statusChip("Exact match", "success");
    case "short":
      return statusChip("Short", "warning");
    case "over":
      return statusChip("Over", "warning");
    default:
      return statusChip("Mismatch", "warning");
  }
}

function openReceiveDrawer(batchId) {
  const row = incomingRows().find((r) => String(r.batch?.id) === String(batchId));
  if (!row) {
    toast("Could not find that shipment.", "danger");
    return;
  }
  const b = row.batch || {};
  const st = String(b.status || "").trim();
  if (!isReceivable(st)) {
    toast("Only arrived shipments can be received.", "danger");
    return;
  }
  const lines = Array.isArray(row.lines) ? row.lines : [];
  if (!lines.length) {
    toast("This shipment has no lines to receive.", "danger");
    return;
  }

  const slugToName = buildSlugToCatalogName(stockData?.editor?.groups || []);
  const metaRow = (label, value) =>
    `<div class="sg-detail-row"><span class="sg-detail-row__label">${escapeHtml(
      label,
    )}</span><span class="sg-detail-row__value">${value}</span></div>`;

  const linesRows = lines
    .map((ln) => {
      const slug = String(ln.product_slug || "").trim();
      const pname = escapeHtml(slugToName.get(slug) || slug || "—");
      const ec = Math.max(0, Math.floor(Number(ln.expected_cases) || 0));
      const eb = Math.max(0, Math.floor(Number(ln.expected_boxes) || 0));
      const lid = escapeHtml(String(ln.id ?? ""));
      return `<tr data-rcv-line-id="${lid}" data-exp-cases="${ec}" data-exp-boxes="${eb}" data-slug="${escapeHtml(
        slug,
      )}" data-size="${escapeHtml(String(ln.size ?? ""))}">
        <td class="sg-cell-product">${pname}</td>
        <td class="sg-muted">${escapeHtml(String(ln.size ?? ""))}</td>
        <td class="sg-table__num sg-nowrap">${escapeHtml(fmtCB(ec, eb))}</td>
        <td class="sg-table__num"><input class="sg-input sg-input--num rcv-cases" type="number" min="0" step="1" inputmode="numeric" value="${ec}" aria-label="Received cases for ${pname}" /></td>
        <td class="sg-table__num"><input class="sg-input sg-input--num rcv-boxes" type="number" min="0" step="1" inputmode="numeric" value="${eb}" aria-label="Received boxes for ${pname}" /></td>
      </tr>`;
    })
    .join("");

  const linesTable = tableShell({
    columns: [
      { label: "Product" },
      { label: "Size" },
      { label: "Expected", align: "right" },
      { label: "Received cases", align: "right" },
      { label: "Received boxes", align: "right" },
    ],
    rowsHtml: linesRows,
    emptyHtml: emptyState({ title: "No lines", text: "This shipment has no expected lines." }),
  });

  const body = `
    <div class="sg-warn-banner" role="note">
      <span class="sg-warn-banner__icon">${icon("alert-triangle", 18)}</span>
      <span>Receiving adds these quantities to <strong>physical inventory immediately</strong>. This action <strong>cannot be repeated</strong> for the same shipment.</span>
    </div>

    <div id="rcv-form">
      <div class="sg-detail-list">
        ${metaRow("Status", statusChip(incomingStatusLabel(st), incomingStatusVariant(st)))}
        ${metaRow("Supplier", escapeHtml(b.supplier ? String(b.supplier).trim() : "—"))}
        ${metaRow("Container", escapeHtml(b.container_number ? String(b.container_number).trim() : "—"))}
        ${metaRow("PO number", escapeHtml(b.po_number ? String(b.po_number).trim() : "—"))}
        ${metaRow("ETA date", escapeHtml(fmtDateShort(b.eta_date)))}
        ${metaRow("Arrival date", escapeHtml(fmtDateShort(b.arrival_date)))}
      </div>

      <div class="sg-drawer-section">
        <p class="sg-drawer-section__title">Received quantities</p>
        ${linesTable}
        <p class="sg-field__error" id="rcv-err" hidden></p>
      </div>

      <label class="sg-field">Receiving note <span class="sg-field__optional">(optional)</span>
        <textarea class="sg-input sg-field__control sg-textarea" id="rcv-note" rows="2" maxlength="400" placeholder="e.g. Counted by warehouse team; 1 carton short"></textarea>
      </label>

      <div class="sg-drawer-actions">
        <button type="button" class="sg-btn sg-btn--ghost" id="rcv-cancel">Cancel</button>
        <button type="button" class="sg-btn sg-btn--primary" id="rcv-review">Review receive</button>
      </div>
    </div>

    <div id="rcv-confirm" class="sg-confirm" hidden>
      <h3 class="sg-confirm__title">Receive stock into inventory?</h3>
      <p class="sg-confirm__copy">This will add the received quantities to physical inventory <strong>immediately</strong>. This action <strong>cannot be repeated</strong> for the same batch.</p>
      <div id="rcv-diff"></div>
      <div class="sg-confirm__summary" id="rcv-confirm-summary"></div>
      <p class="sg-error" id="rcv-confirm-error" role="alert" hidden></p>
      <div class="sg-drawer-actions">
        <button type="button" class="sg-btn sg-btn--ghost" id="rcv-confirm-back">Back</button>
        <button type="button" class="sg-btn sg-btn--primary" id="rcv-confirm-btn">Confirm receive stock</button>
      </div>
    </div>`;

  openDrawer({ title: `Receive Stock — ${String(b.batch_name || "Shipment")}`, bodyHtml: body });
  wireReceiveDrawer(b);
}

function receiveSetErr(id, msg) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = msg || "";
  el.hidden = !msg;
}

/** Snapshot the received-quantity rows; validates whole non-negative numbers. */
function readReceiveRows() {
  const host = document.getElementById("rcv-form");
  const rows = [];
  if (!host) return rows;
  host.querySelectorAll("tr[data-rcv-line-id]").forEach((tr) => {
    const c = parseWholeQty(tr.querySelector(".rcv-cases")?.value);
    const bx = parseWholeQty(tr.querySelector(".rcv-boxes")?.value);
    rows.push({
      line_id: String(tr.getAttribute("data-rcv-line-id") || ""),
      product_slug: String(tr.getAttribute("data-slug") || ""),
      size: String(tr.getAttribute("data-size") || ""),
      expected_cases: Math.max(0, Math.floor(Number(tr.getAttribute("data-exp-cases")) || 0)),
      expected_boxes: Math.max(0, Math.floor(Number(tr.getAttribute("data-exp-boxes")) || 0)),
      received_cases: c,
      received_boxes: bx,
    });
  });
  return rows;
}

/**
 * @returns {null | { lines: {line_id,received_cases,received_boxes}[], rows: object[], note: string, total: number, mismatches: number }}
 */
function validateReceive(batch) {
  receiveSetErr("rcv-err", "");
  if (!isReceivable(batch?.status)) {
    receiveSetErr("rcv-err", "This shipment is no longer in arrived status and cannot be received.");
    return null;
  }
  const rows = readReceiveRows();
  if (!rows.length) {
    receiveSetErr("rcv-err", "This shipment has no lines to receive.");
    return null;
  }
  let total = 0;
  let mismatches = 0;
  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i];
    if (!r.received_cases.valid || !r.received_boxes.valid) {
      receiveSetErr("rcv-err", `Line ${i + 1}: enter whole, non-negative received quantities.`);
      return null;
    }
    total += r.received_cases.value + r.received_boxes.value;
    if (
      r.received_cases.value !== r.expected_cases ||
      r.received_boxes.value !== r.expected_boxes
    ) {
      mismatches += 1;
    }
  }
  if (total < 1) {
    receiveSetErr("rcv-err", "Enter at least one received case or box greater than 0.");
    return null;
  }
  const note = String(document.getElementById("rcv-note")?.value ?? "").trim();
  const lines = rows.map((r) => ({
    line_id: r.line_id,
    received_cases: r.received_cases.value,
    received_boxes: r.received_boxes.value,
  }));
  return { lines, rows, note, total, mismatches };
}

function renderReceiveDiff(built) {
  const slugToName = buildSlugToCatalogName(stockData?.editor?.groups || []);
  const rowsHtml = built.rows
    .map((r) => {
      const dCases = r.received_cases.value - r.expected_cases;
      const dBoxes = r.received_boxes.value - r.expected_boxes;
      const kind = classifyReceiveDiff(dCases, dBoxes);
      const pname = escapeHtml(slugToName.get(r.product_slug) || r.product_slug || "—");
      return `<tr${kind === "match" ? "" : ' class="sg-row--warn"'}>
        <td class="sg-cell-product">${pname}</td>
        <td class="sg-muted">${escapeHtml(r.size)}</td>
        <td class="sg-table__num sg-nowrap">${escapeHtml(fmtCB(r.expected_cases, r.expected_boxes))}</td>
        <td class="sg-table__num sg-nowrap">${escapeHtml(fmtCB(r.received_cases.value, r.received_boxes.value))}</td>
        <td class="sg-table__num sg-nowrap">${escapeHtml(fmtDelta(dCases, dBoxes))}</td>
        <td>${receiveDiffChip(kind)}</td>
      </tr>`;
    })
    .join("");
  const table = tableShell({
    columns: [
      { label: "Product" },
      { label: "Size" },
      { label: "Expected", align: "right" },
      { label: "Received", align: "right" },
      { label: "Difference", align: "right" },
      { label: "Result" },
    ],
    rowsHtml,
    emptyHtml: "",
  });
  const host = document.getElementById("rcv-diff");
  if (host) host.innerHTML = `<div class="sg-drawer-section"><p class="sg-drawer-section__title">Difference review</p>${table}</div>`;
}

function wireReceiveDrawer(batch) {
  const q = (id) => document.getElementById(id);

  q("rcv-cancel")?.addEventListener("click", () => closeDrawer());

  q("rcv-review")?.addEventListener("click", () => {
    const built = validateReceive(batch);
    if (!built) return;
    renderReceiveDiff(built);

    const slugToName = buildSlugToCatalogName(stockData?.editor?.groups || []);
    let tc = 0;
    let tb = 0;
    for (const r of built.rows) {
      tc += r.received_cases.value;
      tb += r.received_boxes.value;
    }
    const lineItems = built.rows
      .map(
        (r) =>
          `<li>${escapeHtml(slugToName.get(r.product_slug) || r.product_slug)} · ${escapeHtml(
            r.size,
          )} — ${escapeHtml(fmtCB(r.received_cases.value, r.received_boxes.value))}</li>`,
      )
      .join("");
    const summary = q("rcv-confirm-summary");
    if (summary) {
      summary.innerHTML = `
        <div class="sg-preview__row"><span>Batch</span><strong>${escapeHtml(String(batch.batch_name || "—"))}</strong></div>
        <div class="sg-preview__row"><span>Total received</span><strong>${escapeHtml(fmtCB(tc, tb))}</strong></div>
        <div class="sg-preview__row"><span>Mismatched lines</span><strong>${built.mismatches}</strong></div>
        <div class="sg-preview__row"><span>Note</span><strong>${built.note ? escapeHtml(built.note) : "—"}</strong></div>
        <div class="sg-preview__row"><span>Physical stock</span><strong>Increases on confirm</strong></div>
        <div class="sg-confirm__lines">
          <p class="sg-drawer-section__title" style="margin:0 0 6px">Lines received (${built.rows.length})</p>
          <ul class="sg-note-list">${lineItems}</ul>
        </div>`;
    }
    receiveSetErr("rcv-confirm-error", "");
    q("rcv-form").hidden = true;
    q("rcv-confirm").hidden = false;
  });

  q("rcv-confirm-back")?.addEventListener("click", () => {
    q("rcv-confirm").hidden = true;
    q("rcv-form").hidden = false;
  });

  q("rcv-confirm-btn")?.addEventListener("click", () => submitReceive(batch));
}

async function submitReceive(batch) {
  if (hasInventoryMutationInFlight()) return; // hard guard against double-submit / overlapping mutations
  const built = validateReceive(batch);
  const confirmBtn = document.getElementById("rcv-confirm-btn");
  const backBtn = document.getElementById("rcv-confirm-back");
  if (!built) {
    // Validation regressed — return to the form to surface the error.
    document.getElementById("rcv-confirm").hidden = true;
    document.getElementById("rcv-form").hidden = false;
    return;
  }

  const setConfirmErr = (msg) => receiveSetErr("rcv-confirm-error", msg);

  receiveInFlight = true;
  if (confirmBtn) confirmBtn.disabled = true;
  if (backBtn) backBtn.disabled = true;
  setConfirmErr("");

  const payload = {
    action: "incoming_batch_receive",
    id: String(batch?.id || ""),
    lines: built.lines,
    note: built.note || null,
  };

  try {
    const token = await getToken();
    await fetchReportPost("/api/admin-inventory", token, payload);
    closeDrawer();
    toast("Shipment received into physical stock.", "success");
    await loadStock();
  } catch (error) {
    const msg =
      error instanceof ReportPostError
        ? error.message || "The server rejected the receive."
        : error?.message || "Could not receive the shipment.";
    setConfirmErr(msg);
    if (confirmBtn) confirmBtn.disabled = false;
    if (backBtn) backBtn.disabled = false;
  } finally {
    receiveInFlight = false;
  }
}

/* --------------------------------------------------------------- page */

function oosBannerHtml() {
  const on = Boolean(stockData?.storefrontGlobalOutOfStock ?? stockData?.overview?.storefrontGlobalOutOfStock);
  if (!on) return "";
  return `<div class="sg-oos-banner" role="status">
    <span class="sg-oos-banner__icon">${icon("alert-triangle", 18)}</span>
    <span>Storefront global out-of-stock is <strong>ON</strong>. Customers currently see sellable stock as zero. The figures below still reflect physical on-hand for operations.</span>
  </div>`;
}

function renderPage() {
  const page = getEl("sg-page");
  if (!page) return;

  const health = buildHealthRows();

  page.innerHTML = `
    <div class="sg-page-header">
      <div>
        <h1 class="sg-page-header__title">Inventory</h1>
        <p class="sg-page-header__subtitle">Physical on hand, website order demand, incoming expected shipments, and estimated availability. External commitments do not alter physical stock.</p>
      </div>
    </div>
    ${oosBannerHtml()}
    ${renderKpis(health)}
    ${renderHealthCard(health.rows)}
    ${renderIncomingCard()}
    ${renderCommitmentsCard()}
    ${renderOverrideHistoryCard()}
  `;

  wireInteractions();
}

function wireInteractions() {
  getEl("sg-inc-filter")?.addEventListener("change", (ev) => {
    incomingFilter = ev.target.value || "all";
    const host = getEl("sg-inc-list");
    if (host) host.innerHTML = incomingListHtml();
    wireBatchButtons();
  });
  wireBatchButtons();

  // Phase 2: the only wired write flow — Update Stock (physical override).
  getEl("sg-update-stock")?.addEventListener("click", () => openUpdateStockDrawer(null));
  document.querySelectorAll("button[data-adjust-slug]").forEach((btn) => {
    btn.addEventListener("click", () =>
      openUpdateStockDrawer({
        slug: btn.getAttribute("data-adjust-slug"),
        size: btn.getAttribute("data-adjust-size"),
      }),
    );
  });

  // Phase 3A: incoming shipment record create.
  getEl("sg-inc-create")?.addEventListener("click", () => openIncomingShipmentDrawer("create", null));

  // Phase 4: sales channel commitments (create / edit / status / delete).
  document.querySelector("button[data-commit-add]")?.addEventListener("click", () => openAddCommitmentDrawer());
  document.querySelectorAll("button[data-commit-edit]").forEach((btn) => {
    btn.addEventListener("click", () => openEditCommitmentDrawer(btn.getAttribute("data-commit-edit")));
  });
  document.querySelectorAll("button[data-commit-ship]").forEach((btn) => {
    btn.addEventListener("click", () => openCommitmentActionDrawer("ship", btn.getAttribute("data-commit-ship")));
  });
  document.querySelectorAll("button[data-commit-cancel]").forEach((btn) => {
    btn.addEventListener("click", () => openCommitmentActionDrawer("cancel", btn.getAttribute("data-commit-cancel")));
  });
  document.querySelectorAll("button[data-commit-delete]").forEach((btn) => {
    btn.addEventListener("click", () => openCommitmentActionDrawer("delete", btn.getAttribute("data-commit-delete")));
  });
}

function wireBatchButtons() {
  document.querySelectorAll("button[data-batch-view]").forEach((btn) => {
    btn.addEventListener("click", () => openBatchDrawer(btn.getAttribute("data-batch-view")));
  });
  // Phase 3A: incoming shipment record edit (from batch cards).
  document.querySelectorAll("button[data-batch-edit]").forEach((btn) => {
    btn.addEventListener("click", () => openIncomingShipmentDrawer("edit", btn.getAttribute("data-batch-edit")));
  });
  // Phase 3B: shipment status workflow (from batch cards).
  document.querySelectorAll("button[data-batch-status]").forEach((btn) => {
    btn.addEventListener("click", () => openStatusDrawer(btn.getAttribute("data-batch-status")));
  });
  // Phase 3C: receive arrived shipment into physical stock (from batch cards).
  document.querySelectorAll("button[data-batch-receive]").forEach((btn) => {
    btn.addEventListener("click", () => openReceiveDrawer(btn.getAttribute("data-batch-receive")));
  });
}

/* --------------------------------------------------------------- data load */

async function loadStock() {
  const page = getEl("sg-page");
  const alreadyLoaded = Boolean(page?.dataset?.loadedOnce);
  const gen = ++stockLoadGen;
  if (page && !alreadyLoaded) {
    page.innerHTML = `<div class="sg-loading">Loading inventory…</div>`;
  }
  try {
    const token = await getToken();
    const next = await fetchReportJson("/api/admin-stock", token);
    if (gen !== stockLoadGen) return;
    stockData = next;
    renderPage();
    if (page) page.dataset.loadedOnce = "1";
    const metaEl = getEl("sg-topbar-meta");
    if (metaEl) metaEl.textContent = `Updated ${new Date().toLocaleString()}`;
  } catch (error) {
    if (gen !== stockLoadGen) return;
    if (page && !alreadyLoaded) {
      page.innerHTML = `<div class="sg-error">${escapeHtml(error?.message || "Could not load inventory.")}</div>`;
    }
    toast(error?.message || "Could not load inventory.", "danger");
  }
}

function refreshInventory() {
  if (hasInventoryMutationInFlight()) {
    toast("Finish the current inventory action before refreshing.", "danger");
    return;
  }
  void loadStock();
}

/* --------------------------------------------------------------- app boot */

bootAdminV2Page({
  activeNav: "inventory",
  onEnter: async (_session, ctx) => {
    getToken = ctx.getAccessToken;
    await loadStock();
  },
  onRefresh: () => refreshInventory(),
});
