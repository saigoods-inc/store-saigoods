/*
 * SAI Goods admin-v2 — Orders page controller.
 *
 * Phase 1: read-only index + filters.
 * Phase 2: read-only order detail drawer.
 * Phase 3A: planned shipment date set/clear.
 * Phase 3B / 3B.1: ship-to address edit (+ eligibility polish).
 * Phase 3C: ship-from override set/clear.
 * Phase 4A: shipping readiness + parcel/rate validation (dry-run; no label purchase).
 * Phase 4B: Shippo sync + status/rate refresh (no label purchase).
 * Phase 4C.1: single Shippo label purchase from a selected stored rate.
 * Phase 4D: external/manual label record (no Shippo purchase, no mark shipped).
 * Phase 5A: mark shipped / fulfillment handoff (may decrement inventory).
 * Phase 5B: buyer shipping notification email.
 *
 * Reads the SAME sources as the old /admin Orders page:
 *   - public.orders              (direct Supabase read via the shared admin-v2 client)
 *   - public.order_shippo_labels (direct Supabase read, batched by order id)
 *   - GET  /api/products         (best-effort, for product/bundle display labels)
 *   - POST /api/admin-order-ship-from-display      (READ-ONLY display helper)
 *   - POST /api/admin-order-fulfillment-doc-links  (READ-ONLY signed links to existing files)
 *   - POST /api/admin-order-shippo-preview         (READ-ONLY dry-run payloads; no Shippo API)
 *
 * Connected write / Shippo actions:
 *   - POST /api/admin-order-shippo-shipment-date       { orderId, shipmentDate }
 *   - POST /api/admin-order-update-shipping-address    { orderId, shippingAddress, shippingContact }
 *   - POST /api/admin-order-fulfillment-addresses      { orderId, shipFromOverride }
 *   - POST /api/admin-order-shippo-sync                { orderId }
 *   - POST /api/admin-order-shippo-refresh-status      { orderId }
 *   - POST /api/admin-order-shippo-purchase-label      { orderId, rateObjectId }
 *   - POST /api/admin-order-external-fulfillment-save  { orderId, carrier, service, trackingNumbers, shippedDate, labelCostCents, labelFiles?, packingSlipFiles? }
 *   - POST /api/admin-order-fulfillment-handoff        { orderId }
 *   - POST /api/admin-order-buyer-shipping-notify      { orderId }
 *   - POST /api/admin-manual-order-record-payment      { orderId, manualPaymentMethod, paymentNote? }
 *     (manual pay-later drafts only)
 *   - POST /api/admin-manual-order-send-link            { orderId }
 *     (manual Square payment-link drafts only)
 *
 * Display polish: payment-link-sent awaiting UI + copy/open link (no resend).
 *
 * Still NOT connected: Shippo buy-all / retry, payment-link resend,
 * walk-in mark paid / quick pay, packing-slip generation.
 */

import { fetchReportPost, ReportPostError } from "../admin-shared.js";
import {
  computeFulfillmentWorkflow,
  isManualOrder,
  isOrderCancelled,
  isOrderShipped,
  isPaymentAwaiting,
  isPaymentPaid,
  isWalkInOrder,
  manualFulfillmentRecordComplete,
  missingShippoAddressFields,
  normalizeSavedShippingAddress,
  orderLabelPurchased,
} from "../admin-fulfillment-workflow.js";

import { bootAdminV2Page } from "./page-boot.js";
import { card, closeDrawer, escapeHtml, icon, kpiCard, openDrawer, statusChip, toast } from "./ui.js";

/** @type {(() => object|null)} Shared admin-v2 Supabase client accessor from page-boot. */
let getSupabase = () => null;
/** @type {(() => Promise<string|undefined>)} Access-token accessor from page-boot. */
let getToken = async () => undefined;
/** @type {object[]} All orders rows (newest first). */
let ordersCache = [];
/** @type {Map<string, object[]>} order id string -> order_shippo_labels rows (all columns). */
let labelsCache = new Map();
/** slug:bundleId -> human label (from /api/products; best-effort). */
const bundleLabelBySlugId = new Map();
/** Ordered site sizes for size-row display (from /api/products; safe default). */
let siteSizes = ["S", "M", "L", "XL"];
/** Bumped each time a drawer opens; guards stale async helper responses. */
let drawerGen = 0;
/** Guard against double-submit of planned ship date set/clear. */
let shipDateInFlight = false;
/** Guard against double-submit of ship-to address save. */
let shipToInFlight = false;
/** Guard against double-submit of ship-from override set/clear. */
let shipFromInFlight = false;
/** Guard against double-submit of Shippo sync / refresh / purchase. */
let shippoInFlight = false;
/** Guard against double-submit of external label save. */
let externalLabelInFlight = false;
/** Guard against double-submit of mark-shipped handoff. */
let markShippedInFlight = false;
/** Guard against double-submit of buyer shipping notification. */
let buyerNotifyInFlight = false;
/** Guard against double-submit of manual record-payment. */
let recordPaymentInFlight = false;
/** @type {null | { orderId: string, manualPaymentMethod: "cash"|"check"|"other", paymentNote: string }} */
let recordPaymentDraft = null;
/** Guard against double-submit of send payment link. */
let sendPaymentLinkInFlight = false;
/**
 * Last send-link result for UI (esp. emailed:false with checkoutUrl).
 * @type {null | { orderId: string, checkoutUrl: string, emailed: boolean, warning: string }}
 */
let lastSendLinkResult = null;
/** Last formatted ship-from text from the display helper (for confirm summaries). */
let lastShipFromFormatted = "";
/** Selected Shippo rate object_id per order id (drawer selection; not persisted until purchase). */
const selectedRateByOrderId = new Map();
/** @type {null | { orderId: string, carrier: string, service: string, trackingNumbers: string, shippedDate: string, labelCostCents: number|null, labelFiles: {base64:string,name:string}[], packingSlipFiles: {base64:string,name:string}[] }} */
let externalLabelDraft = null;

/* --------------------------------------------------------------- helpers */

function getEl(id) {
  return document.getElementById(id);
}

function fmtMoneyCents(c) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format((Number(c) || 0) / 100);
}

function fmtDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/* time filters — same windows as the old page (local day / Monday week / month) */
function startOfLocalDayMs(ref = Date.now()) {
  const d = new Date(ref);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
function startOfLocalWeekMondayMs(ref = Date.now()) {
  const d = new Date(startOfLocalDayMs(ref));
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return d.getTime();
}
function startOfLocalMonthMs(ref = Date.now()) {
  const d = new Date(ref);
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
function passesTimeFilter(row, filter) {
  if (!filter || filter === "all") return true;
  const t = new Date(row.created_at).getTime();
  if (!Number.isFinite(t)) return true;
  if (filter === "today") return t >= startOfLocalDayMs();
  if (filter === "week") return t >= startOfLocalWeekMondayMs();
  if (filter === "month") return t >= startOfLocalMonthMs();
  return true;
}

/* status/stage filter — mirrors old getFilteredOrders() exactly */
function passesStatusFilter(r, filter) {
  if (!filter) return true;
  if (filter === "manual_draft") return String(r.order_source) === "manual" && r.order_status === "draft";
  if (filter === "walk_in_draft") return isWalkInOrder(r) && r.order_status === "draft";
  if (filter === "walk_in_paid") return isWalkInOrder(r) && r.order_status === "paid";
  if (filter === "payment_link_sent") return r.order_status === "payment_link_sent";
  if (filter === "awaiting_payment") return isPaymentAwaiting(r);
  if (filter === "need_label_records") return computeFulfillmentWorkflow(r).key === "need_label_records";
  if (filter === "ready_mark_shipped") return computeFulfillmentWorkflow(r).key === "ready_mark_shipped";
  if (filter === "shipping_active") {
    const paid = String(r.status || "").toLowerCase() === "paid";
    return paid && manualFulfillmentRecordComplete(r) && !r.admin_handoff_at && String(r.order_status || "") !== "shipped";
  }
  if (filter === "in_transit") return computeFulfillmentWorkflow(r).key === "in_transit";
  if (filter === "delivered") return computeFulfillmentWorkflow(r).key === "delivered";
  if (filter === "issues") return computeFulfillmentWorkflow(r).variant === "error";
  if (filter === "cancelled") return computeFulfillmentWorkflow(r).key === "cancelled";
  return false;
}

function filterState() {
  return {
    time: getEl("sg-orders-time")?.value || "all",
    status: getEl("sg-orders-status")?.value || "",
    search: (getEl("sg-orders-search")?.value || "").trim().toLowerCase(),
  };
}

function filtersActive() {
  const { time, status, search } = filterState();
  return time !== "all" || status !== "" || search !== "";
}

function getFilteredOrders() {
  const { time, status, search } = filterState();
  let out = ordersCache.filter((r) => passesTimeFilter(r, time) && passesStatusFilter(r, status));
  if (search) {
    out = out.filter((r) => {
      const hay = [r.order_ref, r.id, r.customer_name, r.customer_email]
        .map((v) => String(v ?? "").toLowerCase())
        .join(" ");
      return hay.includes(search);
    });
  }
  return out;
}

/* ----------------------------------------------- catalog + line items (read) */

/** Best-effort catalog load for bundle labels + size ordering. Never blocks the page. */
async function loadCatalog() {
  try {
    const res = await fetch("/api/products");
    if (!res.ok) return;
    const data = await res.json();
    if (Array.isArray(data?.site?.sizes)) siteSizes = data.site.sizes;
    bundleLabelBySlugId.clear();
    for (const p of data?.products || []) {
      const slug = p.slug;
      for (const b of p.bundles || []) {
        if (b?.id) bundleLabelBySlugId.set(`${slug}:${b.id}`, b.label || b.id);
      }
    }
  } catch {
    /* catalog is optional; bundle ids still render raw */
  }
}

function formatSizeRows(it) {
  const q = it.quantities && typeof it.quantities === "object" ? it.quantities : {};
  const bq = it.boxQuantities && typeof it.boxQuantities === "object" ? it.boxQuantities : {};
  const keys = new Set([...Object.keys(q), ...Object.keys(bq)]);
  const ordered = [...siteSizes.filter((s) => keys.has(s)), ...[...keys].filter((s) => !siteSizes.includes(s))];
  const rows = [];
  for (const sz of ordered) {
    const cases = Math.floor(Number(q[sz]) || 0);
    const boxes = Math.floor(Number(bq[sz]) || 0);
    if (cases < 1 && boxes < 1) continue;
    const parts = [];
    if (cases > 0) parts.push(`${cases} ${cases === 1 ? "case" : "cases"}`);
    if (boxes > 0) parts.push(`${boxes} ${boxes === 1 ? "box" : "boxes"}`);
    rows.push(`${sz}: ${parts.join(" ")}`);
  }
  return rows;
}

function formatFallbackInventory(it) {
  const q = it.quantities && typeof it.quantities === "object" ? it.quantities : {};
  const bq = it.boxQuantities && typeof it.boxQuantities === "object" ? it.boxQuantities : {};
  if (Object.keys(q).length || Object.keys(bq).length) return null;
  const pieces = [];
  const cases = Number(it.lineCases);
  const boxes = Number(it.lineBoxCount);
  if (Number.isFinite(cases) && cases > 0) pieces.push(`${cases} case(s) total`);
  if (Number.isFinite(boxes) && boxes > 0) pieces.push(`${boxes} box(es) total`);
  if (pieces.length) return pieces.join(" · ");
  const total = it.lineTotalFormatted || "";
  return total ? `Total: ${total}` : null;
}

/** Read-only "Items purchased" rows for one order. */
function itemRowsHtml(items) {
  if (!Array.isArray(items) || !items.length) {
    return `<tr><td colspan="3" class="sg-muted">No line items recorded.</td></tr>`;
  }
  return items
    .map((it) => {
      const name = it.name || it.slug || "Product";
      const slug = it.slug || "";
      const bundleRows = [];
      for (const bl of Array.isArray(it.bundleLines) ? it.bundleLines : []) {
        const id = String(bl?.id || "").trim();
        const qty = Math.floor(Number(bl?.qty) || 0);
        if (!id || qty < 1) continue;
        bundleRows.push(`${bundleLabelBySlugId.get(`${slug}:${id}`) || id} × ${qty}`);
      }
      const sizeRows = formatSizeRows(it);
      const detailBits = [];
      if (bundleRows.length) detailBits.push(`<div class="sg-cell-sub"><span class="sg-muted">Bundle:</span> ${escapeHtml(bundleRows.join(", "))}</div>`);
      if (sizeRows.length) detailBits.push(`<div class="sg-cell-sub"><span class="sg-muted">Size:</span> ${escapeHtml(sizeRows.join(", "))}</div>`);
      if (!bundleRows.length && !sizeRows.length) {
        const fb = formatFallbackInventory(it);
        if (fb) detailBits.push(`<div class="sg-cell-sub sg-muted">${escapeHtml(fb)}</div>`);
      }
      const lineTotal = it.lineTotalFormatted ? escapeHtml(String(it.lineTotalFormatted)) : "—";
      return `<tr>
        <td><div class="sg-cell-strong">${escapeHtml(name)}</div>${detailBits.join("")}</td>
        <td class="sg-nowrap sg-muted">${sizeRows.length ? escapeHtml(sizeRows.join(" · ")) : "—"}</td>
        <td class="sg-table__num sg-nowrap">${lineTotal}</td>
      </tr>`;
    })
    .join("");
}

/* --------------------------------------------------------------- chips */

function typeChip(row) {
  if (isWalkInOrder(row)) return statusChip("Walk-in", "brand");
  if (isManualOrder(row)) return statusChip("Manual", "info");
  return statusChip("Online", "neutral");
}

function paymentChip(row) {
  const paid = String(row.status || "").toLowerCase() === "paid";
  if (paid) {
    const m = String(row.payment_method || "").toLowerCase();
    if (m === "cash") return statusChip("Paid cash", "success");
    if (m === "check") return statusChip("Paid check", "success");
    return statusChip("Paid", "success");
  }
  const os = String(row.order_status || "");
  if (os === "payment_link_sent") return statusChip("Payment link sent", "info");
  if (os === "draft") return statusChip("Draft", "warning");
  return statusChip("Awaiting payment", "warning");
}

function fulfillmentChip(wf) {
  let variant = "neutral";
  if (wf.variant === "cancelled" || wf.variant === "error") variant = "danger";
  else if (wf.key === "delivered" || wf.key === "shipped") variant = "success";
  else if (wf.key === "in_transit") variant = "info";
  else if (wf.key === "ready_mark_shipped") variant = "info";
  else if (
    wf.key === "need_label_records" ||
    wf.key === "no_carrier_label" ||
    wf.key === "awaiting_payment" ||
    wf.key === "payment_link_sent" ||
    wf.key === "manual_draft" ||
    wf.key === "manual_pay_later" ||
    wf.key === "walk_in_draft"
  ) {
    variant = "warning";
  }
  return statusChip(wf.label, variant);
}

/** Concise Shipping-column summary from purchased Shippo labels (read-only). */
function shippingSummary(row) {
  const labels = labelsCache.get(String(row.id)) || [];
  const purchased = labels.filter((l) => String(l.status || "") === "purchased");
  if (purchased.length) {
    const carriers = [...new Set(purchased.map((l) => String(l.carrier || "").trim()).filter(Boolean))];
    const carrier = carriers.length === 0 ? "Carrier" : carriers.length === 1 ? carriers[0] : `${carriers[0]} +${carriers.length - 1}`;
    return `${escapeHtml(carrier)} · ${purchased.length} label${purchased.length === 1 ? "" : "s"}`;
  }
  if (row.shippo_label_required === false) return `<span class="sg-muted">Pickup / local</span>`;
  const track = String(row.shippo_tracking_status || "").trim();
  if (track) return `<span class="sg-muted">${escapeHtml(track)}</span>`;
  return `<span class="sg-muted">—</span>`;
}

/* --------------------------------------------------------------- sections */

function renderKpis() {
  const total = ordersCache.length;
  let awaiting = 0;
  let ready = 0;
  let shipped = 0;
  let attention = 0;
  for (const r of ordersCache) {
    const wf = computeFulfillmentWorkflow(r);
    if (isPaymentAwaiting(r) && String(r.order_status || "") !== "cancelled") awaiting += 1;
    if (isOrderShipped(r)) shipped += 1;
    if (wf.key === "need_label_records" || wf.key === "ready_mark_shipped" || wf.key === "no_carrier_label") ready += 1;
    if (wf.variant === "error") attention += 1;
  }

  const cards = [
    kpiCard({ label: "Total Orders", value: String(total), sub: "All time", iconName: "shopping-cart" }),
    kpiCard({ label: "Awaiting Payment", value: String(awaiting), sub: "Not yet paid", iconName: "clock" }),
    kpiCard({ label: "Ready to Ship", value: String(ready), sub: "Paid · not shipped", iconName: "package" }),
    kpiCard({ label: "Shipped", value: String(shipped), sub: "Handed off / in transit", iconName: "truck" }),
    kpiCard({ label: "Needs Attention", value: String(attention), sub: "Address / label issues", iconName: "alert-triangle", danger: attention > 0 }),
  ];
  return `<div class="sg-grid sg-grid--kpi-5">${cards.join("")}</div>`;
}

function toolbarHtml() {
  const timeOpts = [
    { value: "all", label: "All dates" },
    { value: "today", label: "Today" },
    { value: "week", label: "This week" },
    { value: "month", label: "This month" },
  ]
    .map((o) => `<option value="${o.value}">${escapeHtml(o.label)}</option>`)
    .join("");

  const statusOpts = [
    { value: "", label: "All orders" },
    { value: "awaiting_payment", label: "Awaiting payment" },
    { value: "manual_draft", label: "Manual · draft" },
    { value: "walk_in_draft", label: "Walk-in · draft" },
    { value: "walk_in_paid", label: "Walk-in · paid" },
    { value: "payment_link_sent", label: "Payment link sent" },
    { value: "need_label_records", label: "Need label records" },
    { value: "ready_mark_shipped", label: "Ready to mark shipped" },
    { value: "shipping_active", label: "Label recorded · not shipped" },
    { value: "in_transit", label: "In transit" },
    { value: "delivered", label: "Delivered" },
    { value: "issues", label: "Issues / errors" },
    { value: "cancelled", label: "Cancelled" },
  ]
    .map((o) => `<option value="${escapeHtml(o.value)}">${escapeHtml(o.label)}</option>`)
    .join("");

  return `<div class="sg-toolbar" style="margin-bottom:16px">
    <input class="sg-input" id="sg-orders-search" type="search" placeholder="Search order ID, customer, or email" aria-label="Search orders" />
    <select class="sg-select" id="sg-orders-time" aria-label="Filter by order date">${timeOpts}</select>
    <select class="sg-select" id="sg-orders-status" aria-label="Filter by fulfillment stage">${statusOpts}</select>
    <button type="button" class="sg-btn sg-btn--ghost sg-btn--sm" id="sg-orders-refresh">${icon("refresh-cw", 14)}<span>Refresh</span></button>
  </div>`;
}

function tableCard() {
  const table = `<div class="sg-table-wrap">
    <table class="sg-table">
      <thead>
        <tr>
          <th>Order</th>
          <th>Customer</th>
          <th>Type</th>
          <th>Payment</th>
          <th>Shipping</th>
          <th>Fulfillment</th>
          <th class="sg-table__num">Total</th>
          <th>Next Action</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody id="sg-orders-tbody"></tbody>
    </table>
  </div>`;
  return card({ title: "Orders", bodyHtml: toolbarHtml() + table });
}

function emptyRowHtml(message, showClear) {
  const clearBtn = showClear
    ? `<div style="margin-top:12px"><button type="button" class="sg-btn sg-btn--ghost sg-btn--sm" id="sg-orders-clear">Clear filters</button></div>`
    : "";
  return `<tr><td colspan="9"><div class="sg-empty">
      <div class="sg-empty__icon">${icon("shopping-cart", 22)}</div>
      <p class="sg-empty__title">${escapeHtml(message)}</p>
      ${clearBtn}
    </div></td></tr>`;
}

function renderTableBody() {
  const tbody = getEl("sg-orders-tbody");
  if (!tbody) return;

  if (!ordersCache.length) {
    tbody.innerHTML = emptyRowHtml("No orders found", false);
    return;
  }

  const rows = getFilteredOrders();
  if (!rows.length) {
    tbody.innerHTML = emptyRowHtml("No orders match your filters", filtersActive());
    getEl("sg-orders-clear")?.addEventListener("click", clearFilters);
    return;
  }

  tbody.innerHTML = rows
    .map((r) => {
      const wf = computeFulfillmentWorkflow(r);
      const ref = escapeHtml(String(r.order_ref || r.id || "—"));
      const created = escapeHtml(fmtDate(r.created_at));
      const name = escapeHtml(String(r.customer_name || "—"));
      const email = r.customer_email ? escapeHtml(String(r.customer_email)) : "";
      const next = wf.nextAction ? escapeHtml(wf.nextAction) : "—";
      const oid = escapeHtml(String(r.id ?? ""));
      return `<tr class="sg-orders-row" data-oid="${oid}">
        <td><div class="sg-cell-strong">${ref}</div><div class="sg-muted sg-cell-sub">${created}</div></td>
        <td><div>${name}</div>${email ? `<div class="sg-muted sg-cell-sub">${email}</div>` : ""}</td>
        <td>${typeChip(r)}</td>
        <td>${paymentChip(r)}</td>
        <td class="sg-nowrap">${shippingSummary(r)}</td>
        <td>${fulfillmentChip(wf)}</td>
        <td class="sg-table__num sg-nowrap">${escapeHtml(fmtMoneyCents(r.total_cents))}</td>
        <td class="sg-muted">${next}</td>
        <td><button type="button" class="sg-btn sg-btn--ghost sg-btn--sm" data-order-view="${oid}">${icon("eye", 14)}<span>View</span></button></td>
      </tr>`;
    })
    .join("");

  // Read-only: row / View click opens the read-only detail drawer. No writes.
  const openById = (id) => {
    const row = ordersCache.find((r) => String(r.id) === String(id));
    if (row) openOrderDrawer(row);
  };
  tbody.querySelectorAll("button[data-order-view]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      openById(btn.getAttribute("data-order-view"));
    });
  });
  tbody.querySelectorAll("tr.sg-orders-row").forEach((tr) => {
    tr.addEventListener("click", () => openById(tr.getAttribute("data-oid")));
  });
}

function clearFilters() {
  const s = getEl("sg-orders-search");
  const t = getEl("sg-orders-time");
  const st = getEl("sg-orders-status");
  if (s) s.value = "";
  if (t) t.value = "all";
  if (st) st.value = "";
  renderTableBody();
}

function renderPage() {
  const page = getEl("sg-page");
  if (!page) return;

  page.innerHTML = `
    <div class="sg-page-header">
      <div>
        <h1 class="sg-page-header__title">Orders</h1>
        <p class="sg-page-header__subtitle">Manage payment status, fulfillment status, and shipping progress.</p>
      </div>
    </div>
    ${renderKpis()}
    ${tableCard()}
  `;

  renderTableBody();

  getEl("sg-orders-search")?.addEventListener("input", renderTableBody);
  getEl("sg-orders-time")?.addEventListener("change", renderTableBody);
  getEl("sg-orders-status")?.addEventListener("change", renderTableBody);
  getEl("sg-orders-refresh")?.addEventListener("click", () => loadOrders());
}

/* --------------------------------------------------- detail drawer (read) */

function fmtDateTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** Resolve the shipping charge cents the same way the old page prefers fields. */
function shippingChargedCents(row) {
  for (const f of ["quoted_shipping_amount_cents", "paid_shipping_amount_cents", "shipping_cents"]) {
    if (row?.[f] != null && Number.isFinite(Number(row[f]))) return Math.max(0, Math.round(Number(row[f])));
  }
  return null;
}

/** True if a shipment record (external record or purchased Shippo label) exists. */
function hasLabelRecord(row) {
  if (manualFulfillmentRecordComplete(row) || orderLabelPurchased(row)) return true;
  const labels = labelsCache.get(String(row.id)) || [];
  return labels.some((l) => String(l.status || "") === "purchased");
}

/** Build a 4-step read-only fulfillment stepper. */
function stepperHtml(row) {
  const cancelled = isOrderCancelled(row);
  const paid = isPaymentPaid(row);
  const labelDone = hasLabelRecord(row);
  const shipped = isOrderShipped(row);

  const steps = [
    { label: "Order created", state: "done" },
    { label: "Payment received", state: paid ? "done" : cancelled ? "skip" : "active" },
    { label: "Label recorded", state: labelDone ? "done" : paid && !cancelled ? "active" : "pending" },
    { label: "Shipped", state: shipped ? "done" : "pending" },
  ];
  if (cancelled) {
    for (const s of steps) if (s.state !== "done") s.state = "skip";
  }

  const items = steps
    .map((s, i) => {
      const mark = s.state === "done" ? icon("check", 13) : String(i + 1);
      return `<li class="sg-step sg-step--${s.state}">
        <span class="sg-step__dot">${mark}</span>
        <span class="sg-step__label">${escapeHtml(s.label)}</span>
      </li>`;
    })
    .join("");
  const banner = cancelled ? `<div class="sg-step-cancel">${icon("alert-triangle", 13)}<span>Order cancelled</span></div>` : "";
  return `<div class="sg-stepper-wrap">${banner}<ol class="sg-stepper">${items}</ol></div>`;
}

function kvHtml(pairs) {
  const rows = pairs
    .filter((p) => p)
    .map(([k, v]) => `<div class="sg-kv__row"><dt>${escapeHtml(k)}</dt><dd>${v}</dd></div>`)
    .join("");
  return `<dl class="sg-kv">${rows}</dl>`;
}

function sectionHtml(title, bodyHtml) {
  return `<section class="sg-od-section">
    <h3 class="sg-drawer-section__title">${escapeHtml(title)}</h3>
    ${bodyHtml}
  </section>`;
}

function formatShipToLines(addr) {
  if (!addr) return [];
  return [
    addr.name,
    [addr.line1, addr.line2].filter(Boolean).join(", "),
    [addr.city, addr.state, addr.postalCode].filter(Boolean).join(", "),
    addr.country,
  ].filter(Boolean);
}

function formatShipToBlockHtml(addr) {
  const lines = formatShipToLines(addr);
  if (!lines.length) return `<span class="sg-muted">No address on file.</span>`;
  return `<address class="sg-address">${lines.map((l) => escapeHtml(l)).join("<br />")}</address>`;
}

/**
 * Phase 3B.1 eligibility: allow address edits before label/tracking/shipment,
 * regardless of payment status. Frontend-only lock (backend still does not enforce).
 * @returns {{ ok: boolean, reason: string|null }}
 */
function shipToEditEligibility(row) {
  if (!row) return { ok: false, reason: "Address editing is unavailable for this order." };
  if (isOrderCancelled(row)) {
    return { ok: false, reason: "Address locked because this order was cancelled." };
  }
  if (isOrderShipped(row)) {
    return { ok: false, reason: "Address locked because this order has already shipped." };
  }
  if (hasPurchasedOrExternalLabel(row) || hasAnyTrackingNumber(row)) {
    return {
      ok: false,
      reason: "Address locked because a shipping label or tracking record already exists.",
    };
  }
  return { ok: true, reason: null };
}

function canEditShipToAddress(row) {
  return shipToEditEligibility(row).ok;
}

/** Legacy Shippo success label, purchased per-parcel labels, or complete external label record. */
function hasPurchasedOrExternalLabel(row) {
  if (orderLabelPurchased(row)) return true;
  if (manualFulfillmentRecordComplete(row)) return true;
  const labels = labelsCache.get(String(row.id)) || [];
  return labels.some((l) => String(l.status || "") === "purchased");
}

/** Any tracking on the order row or purchased/pending label rows. */
function hasAnyTrackingNumber(row) {
  if (String(row?.shippo_tracking_number || "").trim()) return true;
  const ext = String(row?.admin_external_tracking_number || "").trim();
  if (ext && ext.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).length > 0) return true;
  const labels = labelsCache.get(String(row.id)) || [];
  return labels.some((l) => String(l.tracking_number || "").trim());
}

function shipToHtml(row) {
  const a = normalizeSavedShippingAddress(row);
  const hasCore = a.line1 && a.city && a.state && a.postalCode;
  const eligibility = shipToEditEligibility(row);

  let body;
  if (!hasCore) {
    body = `<div class="sg-inline-warn">${icon("alert-triangle", 14)}<span>No complete ship-to address saved yet.${eligibility.ok ? " Use Edit address to complete it." : ""}</span></div>`;
  } else {
    body = formatShipToBlockHtml(a);
  }

  let actions = "";
  if (eligibility.ok) {
    actions = `<div class="sg-ship-to-actions">
      <button type="button" class="sg-btn sg-btn--primary sg-btn--sm" data-od-edit-ship-to>${icon("map-pin", 14)}<span>Edit address</span></button>
    </div>`;
  } else {
    actions = `<p class="sg-meta-note" style="margin:8px 0 0">${escapeHtml(eligibility.reason || "Address editing is locked.")}</p>`;
  }

  return `${body}${actions}`;
}

/** Same lock rule as ship-to (Phase 3B.1 / 3C). */
function shipFromEditEligibility(row) {
  return shipToEditEligibility(row);
}

function canEditShipFromOverride(row) {
  return shipFromEditEligibility(row).ok;
}

function parseShipFromOverride(row) {
  const raw = row?.shippo_from_address_override_json;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw;
  if (typeof raw === "string" && raw.trim()) {
    try {
      const p = JSON.parse(raw);
      if (p && typeof p === "object" && !Array.isArray(p)) return p;
    } catch {
      /* ignore */
    }
  }
  return null;
}

function hasShipFromOverride(row) {
  const ov = parseShipFromOverride(row);
  if (!ov) return false;
  return Boolean(String(ov.line1 || "").trim() && String(ov.city || "").trim() && String(ov.state || "").trim());
}

function formatOverrideAddrHtml(ov) {
  if (!ov) return `<span class="sg-muted">Default warehouse address</span>`;
  const lines = [
    ov.name,
    ov.line1,
    ov.line2,
    [ov.city, ov.state, ov.postalCode || ov.zip].filter(Boolean).join(", "),
    ov.country,
    ov.email ? `Email: ${ov.email}` : "",
    ov.phone ? `Phone: ${ov.phone}` : "",
  ].filter(Boolean);
  return `<address class="sg-address">${lines.map((l) => escapeHtml(String(l))).join("<br />")}</address>`;
}

function shipFromSectionHtml(row) {
  const eligibility = shipFromEditEligibility(row);
  const hasOv = hasShipFromOverride(row);
  const sourceChip = hasOv
    ? statusChip("Custom override", "warning")
    : statusChip("Default warehouse", "neutral");

  let actions = "";
  if (eligibility.ok) {
    const clearBtn = hasOv
      ? `<button type="button" class="sg-btn sg-btn--ghost sg-btn--sm" data-od-clear-ship-from>Clear override</button>`
      : "";
    actions = `<div class="sg-ship-to-actions">
      <button type="button" class="sg-btn sg-btn--primary sg-btn--sm" data-od-edit-ship-from>${icon("map-pin", 14)}<span>Edit ship-from</span></button>
      ${clearBtn}
    </div>`;
  } else {
    actions = `<p class="sg-meta-note" style="margin:8px 0 0">${escapeHtml(eligibility.reason || "Ship-from editing is locked.")}</p>`;
  }

  return `<div class="sg-ship-from-meta" style="margin-bottom:8px">${sourceChip}</div>
    <div id="sg-od-shipfrom"><p class="sg-muted" style="margin:0">Loading warehouse address…</p></div>
    ${actions}
    <p class="sg-meta-note" style="margin:8px 0 0">Ship-from override is used for future label creation only. It does not purchase a label.</p>`;
}

function labelRecordsHtml(row) {
  const labels = (labelsCache.get(String(row.id)) || []).slice().sort((a, b) => (Number(a.parcel_index) || 0) - (Number(b.parcel_index) || 0));
  if (!labels.length) return `<p class="sg-muted" style="margin:0">No label record yet.</p>`;
  const n = labels[0]?.parcel_count != null ? Number(labels[0].parcel_count) : labels.length;
  const rows = labels
    .map((l) => {
      const idx = l.parcel_index != null ? Number(l.parcel_index) : 0;
      const st = String(l.status || "");
      const stVariant = st === "purchased" ? "success" : st === "failed" ? "danger" : "warning";
      const stText = st ? st.charAt(0).toUpperCase() + st.slice(1) : "—";
      const carrier = [l.carrier, l.servicelevel_name].map((v) => String(v || "").trim()).filter(Boolean).join(" · ") || "—";
      const trk = String(l.tracking_number || "").trim();
      const cost = l.amount_cents != null && Number.isFinite(Number(l.amount_cents)) ? fmtMoneyCents(l.amount_cents) : "—";
      const openLink =
        st === "purchased" && l.label_url
          ? `<a class="sg-btn sg-btn--ghost sg-btn--sm" href="${escapeHtml(String(l.label_url))}" target="_blank" rel="noopener">Open label</a>`
          : "";
      return `<tr>
        <td class="sg-nowrap">Package ${idx + 1} of ${n}</td>
        <td>${statusChip(stText, stVariant)}</td>
        <td>${escapeHtml(carrier)}${trk ? `<div class="sg-cell-sub sg-muted">Tracking: ${escapeHtml(trk)}</div>` : ""}</td>
        <td class="sg-table__num sg-nowrap">${cost}</td>
        <td class="sg-nowrap">${openLink}</td>
      </tr>`;
    })
    .join("");
  return `<div class="sg-table-wrap"><table class="sg-table sg-table--tight">
    <thead><tr><th>Package</th><th>Status</th><th>Carrier / tracking</th><th class="sg-table__num">Cost</th><th></th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;
}

/* ------------------------------------------- external label record (Phase 4D) */

function storagePathCount(col) {
  return String(col || "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean).length;
}

function externalTrackingLines(row) {
  return String(row?.admin_external_tracking_number || "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Purchased Shippo label only (not external). */
function hasPurchasedShippoLabel(row) {
  if (orderLabelPurchased(row)) return true;
  const labels = labelsCache.get(String(row.id)) || [];
  return labels.some((l) => String(l.status || "") === "purchased");
}

/**
 * @returns {{ ok: boolean, reason: string|null }}
 */
function externalLabelEligibility(row) {
  if (!row) return { ok: false, reason: "Order unavailable." };
  if (isOrderCancelled(row)) return { ok: false, reason: "Order is cancelled." };
  if (isOrderShipped(row)) return { ok: false, reason: "Order already shipped." };
  if (!isPaymentPaid(row)) return { ok: false, reason: "Only paid orders can record an external label." };
  if (hasPurchasedShippoLabel(row)) {
    return { ok: false, reason: "A Shippo label already exists — external record is locked." };
  }
  if (manualFulfillmentRecordComplete(row)) {
    return { ok: false, reason: "A complete external label record already exists." };
  }
  return { ok: true, reason: null };
}

function externalLabelStatusChip(row) {
  const carrier = String(row.admin_external_carrier || "").trim();
  const tracks = externalTrackingLines(row);
  const labelFiles = storagePathCount(row.admin_external_label_storage_path);
  const hasCarrier = Boolean(carrier);
  const hasTracking = tracks.length > 0;

  if (hasCarrier && hasTracking && labelFiles > 0) {
    return statusChip("Complete record", "success");
  }
  if (hasCarrier && hasTracking && labelFiles === 0) {
    return statusChip("Tracking recorded · label file missing", "warning");
  }
  return statusChip("Incomplete record", "warning");
}

function externalLabelRecordDisplayHtml(row) {
  const carrier = String(row.admin_external_carrier || "").trim();
  const service = String(row.admin_external_service || "").trim();
  const tracks = externalTrackingLines(row);
  const date = String(row.admin_external_shipped_date || "").trim();
  const cost =
    row.admin_external_label_cost_cents != null && Number.isFinite(Number(row.admin_external_label_cost_cents))
      ? fmtMoneyCents(row.admin_external_label_cost_cents)
      : null;
  const labelFiles = storagePathCount(row.admin_external_label_storage_path);
  const slipFiles = storagePathCount(row.admin_external_packing_slip_storage_path);

  if (!carrier && !tracks.length && !labelFiles && !slipFiles && !date && cost == null) {
    return `<p class="sg-muted" style="margin:0">No external/manual label record yet.</p>`;
  }

  const dateDisplay =
    date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? fmtPlannedShipDateDisplay(date) : date || "—";

  return `<div class="sg-ext-status" style="margin-bottom:10px">${externalLabelStatusChip(row)}</div>
    ${kvHtml([
      ["Carrier", escapeHtml(carrier || "—")],
      service ? ["Service", escapeHtml(service)] : null,
      ["Tracking", tracks.length ? escapeHtml(tracks.join(", ")) : "—"],
      date ? ["Shipment / label date", escapeHtml(dateDisplay)] : null,
      cost != null ? ["Label cost", escapeHtml(cost)] : null,
      ["Label files on record", String(labelFiles)],
      ["Packing slip files", String(slipFiles)],
    ])}`;
}

function externalLabelSectionHtml(row) {
  const elig = externalLabelEligibility(row);
  const btn = elig.ok
    ? `<button type="button" class="sg-btn sg-btn--primary sg-btn--sm" data-od-record-external-label>${icon("package", 14)}<span>Record external label</span></button>`
    : `<button type="button" class="sg-btn sg-btn--ghost sg-btn--sm" disabled title="${escapeHtml(elig.reason || "Unavailable.")}">${icon("package", 14)}<span>Record external label</span></button>`;

  const needsFileHint =
    String(row.admin_external_carrier || "").trim() &&
    externalTrackingLines(row).length > 0 &&
    storagePathCount(row.admin_external_label_storage_path) === 0;

  return sectionHtml(
    "External label record",
    `${externalLabelRecordDisplayHtml(row)}
    <div class="sg-ship-to-actions" style="margin-top:12px">${btn}</div>
    ${!elig.ok ? `<p class="sg-meta-note" style="margin:8px 0 0">${escapeHtml(elig.reason)}</p>` : ""}
    <p class="sg-meta-note" style="margin:8px 0 0">Use this for labels or tracking created outside Shippo. This does not purchase a label, notify the customer, or mark the order shipped.</p>
    ${needsFileHint || elig.ok ? `<p class="sg-meta-note" style="margin:6px 0 0">Upload the label file to make this record complete for fulfillment review.</p>` : ""}`,
  );
}

function setExternalLabelErr(id, msg) {
  const el = getEl(id);
  if (!el) return;
  if (msg) {
    el.textContent = msg;
    el.hidden = false;
  } else {
    el.textContent = "";
    el.hidden = true;
  }
}

function readFileAsBase64Part(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const s = String(r.result || "");
      const i = s.indexOf(",");
      resolve({ base64: i >= 0 ? s.slice(i + 1) : s, name: file.name || "upload" });
    };
    r.onerror = () => reject(new Error("Could not read file."));
    r.readAsDataURL(file);
  });
}

async function readAllFilesFromInput(input) {
  const files = input?.files?.length ? Array.from(input.files) : [];
  const out = [];
  for (const file of files) {
    const part = await readFileAsBase64Part(file);
    if (part.base64) out.push({ base64: part.base64, name: part.name });
  }
  return out;
}

function openExternalLabelFormDrawer(row) {
  const elig = externalLabelEligibility(row);
  if (!elig.ok) {
    toast(elig.reason || "External label recording unavailable.", "danger");
    return;
  }
  externalLabelDraft = null;

  const carrier = escapeHtml(String(row.admin_external_carrier || ""));
  const service = escapeHtml(String(row.admin_external_service || ""));
  const tracking = escapeHtml(String(row.admin_external_tracking_number || ""));
  const date = escapeHtml(String(row.admin_external_shipped_date || ""));
  const costDollars =
    row.admin_external_label_cost_cents != null && Number.isFinite(Number(row.admin_external_label_cost_cents))
      ? escapeHtml(String(Number(row.admin_external_label_cost_cents) / 100))
      : "";

  const bodyHtml = `
    <div id="ext-form-step">
      <p class="sg-meta-note" style="margin:0 0 12px">Use this for labels or tracking created outside Shippo. Carrier and at least one tracking number are required.</p>
      <form id="ext-label-form" onsubmit="return false;">
        <div class="sg-addr-grid sg-ext-form-grid">
          <label class="sg-field">
            <span class="sg-field__label">Carrier <span class="sg-field__optional">(required)</span></span>
            <input class="sg-input" id="ext-carrier" name="carrier" type="text" autocomplete="organization" value="${carrier}" placeholder="e.g. UPS, USPS, Pirate Ship" required />
            <p class="sg-field__error" id="ext-err-carrier" hidden></p>
          </label>
          <label class="sg-field">
            <span class="sg-field__label">Service <span class="sg-field__optional">(optional)</span></span>
            <input class="sg-input" id="ext-service" name="service" type="text" value="${service}" placeholder="e.g. UPS Ground" />
          </label>
          <label class="sg-field">
            <span class="sg-field__label">Label cost USD <span class="sg-field__optional">(optional)</span></span>
            <input class="sg-input" id="ext-cost" name="labelCost" type="number" min="0" step="0.01" value="${costDollars}" placeholder="0.00" />
            <p class="sg-field__error" id="ext-err-cost" hidden></p>
          </label>
          <label class="sg-field">
            <span class="sg-field__label">Shipment / label date <span class="sg-field__optional">(optional)</span></span>
            <input class="sg-input" id="ext-date" name="shippedDate" type="date" value="${date}" />
            <p class="sg-field__error" id="ext-err-date" hidden></p>
          </label>
        </div>
        <div class="sg-field sg-ext-tracking-field">
          <label class="sg-field__label" for="ext-tracking">Tracking #</label>
          <p class="sg-meta-note" style="margin:4px 0 6px">Enter one tracking number per line.</p>
          <textarea class="sg-input sg-textarea" id="ext-tracking" name="trackingNumbers" rows="5" required placeholder="1Z…&#10;9400…">${tracking}</textarea>
          <p class="sg-field__error" id="ext-err-tracking" hidden></p>
        </div>
        <div class="sg-field sg-ext-file-field">
          <label class="sg-field__label" for="ext-label-file">Shipping label files (PDF or image)</label>
          <input class="sg-input" id="ext-label-file" name="labelFile" type="file" multiple accept="application/pdf,image/*" />
          <p class="sg-meta-note" style="margin:6px 0 0">Upload the label file to make this record complete for fulfillment review. New uploads are added to any files already on record.</p>
          <p class="sg-field__error" id="ext-err-label-file" hidden></p>
        </div>
        <div class="sg-field sg-ext-file-field">
          <label class="sg-field__label" for="ext-slip-file">Packing slip files <span class="sg-field__optional">(optional)</span></label>
          <input class="sg-input" id="ext-slip-file" name="packingSlipFile" type="file" multiple accept="application/pdf,image/*" />
        </div>
      </form>
      <p class="sg-error" id="ext-form-err" role="alert" hidden></p>
      <div class="sg-drawer-actions">
        <button type="button" class="sg-btn sg-btn--ghost" id="ext-form-cancel">Cancel</button>
        <button type="button" class="sg-btn sg-btn--primary" id="ext-form-continue">Continue</button>
      </div>
    </div>
    <div id="ext-confirm-step" class="sg-confirm" hidden></div>`;

  openDrawer({ title: "Record external label", bodyHtml });
  document.getElementById("sg-drawer")?.classList.remove("sg-drawer--wide");

  getEl("ext-form-cancel")?.addEventListener("click", () => {
    externalLabelDraft = null;
    openOrderDrawer(row);
  });
  getEl("ext-form-continue")?.addEventListener("click", () => {
    void continueExternalLabelConfirm(row);
  });
}

async function continueExternalLabelConfirm(row) {
  ["ext-err-carrier", "ext-err-tracking", "ext-err-cost", "ext-err-date", "ext-err-label-file", "ext-form-err"].forEach((id) =>
    setExternalLabelErr(id, ""),
  );

  const carrier = String(getEl("ext-carrier")?.value || "").trim();
  const service = String(getEl("ext-service")?.value || "").trim();
  const trackingNumbers = String(getEl("ext-tracking")?.value || "").trim();
  const shippedDate = String(getEl("ext-date")?.value || "").trim();
  const costRaw = String(getEl("ext-cost")?.value || "").trim();

  let ok = true;
  if (!carrier) {
    setExternalLabelErr("ext-err-carrier", "Carrier is required.");
    ok = false;
  }
  const trackLines = trackingNumbers
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!trackLines.length) {
    setExternalLabelErr("ext-err-tracking", "Enter at least one tracking number.");
    ok = false;
  }

  let labelCostCents = null;
  if (costRaw) {
    const n = Math.round(Number.parseFloat(costRaw) * 100);
    if (!Number.isFinite(n) || n < 0) {
      setExternalLabelErr("ext-err-cost", "Enter a valid cost (0 or greater), or leave blank.");
      ok = false;
    } else {
      labelCostCents = n;
    }
  }

  if (shippedDate && !/^\d{4}-\d{2}-\d{2}$/.test(shippedDate)) {
    setExternalLabelErr("ext-err-date", "Use a valid date (YYYY-MM-DD).");
    ok = false;
  }

  if (!ok) return;

  const continueBtn = getEl("ext-form-continue");
  const cancelBtn = getEl("ext-form-cancel");
  if (continueBtn) {
    continueBtn.disabled = true;
    continueBtn.textContent = "Reading files…";
  }
  if (cancelBtn) cancelBtn.disabled = true;

  try {
    const labelFiles = await readAllFilesFromInput(getEl("ext-label-file"));
    const packingSlipFiles = await readAllFilesFromInput(getEl("ext-slip-file"));

    externalLabelDraft = {
      orderId: String(row.id),
      carrier,
      service,
      trackingNumbers: trackLines.join("\n"),
      shippedDate,
      labelCostCents,
      labelFiles,
      packingSlipFiles,
    };

    const formStep = getEl("ext-form-step");
    const confirmStep = getEl("ext-confirm-step");
    if (formStep) formStep.hidden = true;
    if (confirmStep) {
      confirmStep.hidden = false;
      confirmStep.innerHTML = `
        <h3 class="sg-confirm__title">Save external label record?</h3>
        <p class="sg-confirm__copy">This records label/tracking information for fulfillment review. It does not purchase a label, notify the customer, or mark the order shipped.</p>
        <div class="sg-confirm__summary">
          ${kvHtml([
            ["Order", `<span class="sg-mono">${escapeHtml(String(row.order_ref || row.id || "—"))}</span>`],
            ["Customer", escapeHtml(String(row.customer_name || "—"))],
            ["Carrier", escapeHtml(carrier)],
            ["Service", escapeHtml(service || "—")],
            ["Tracking", escapeHtml(trackLines.join(", "))],
            ["Label cost", labelCostCents != null ? escapeHtml(fmtMoneyCents(labelCostCents)) : "—"],
            ["Shipment / label date", shippedDate ? escapeHtml(fmtPlannedShipDateDisplay(shippedDate)) : "Not set"],
            ["Label files attached", String(labelFiles.length)],
            ["Packing slip files attached", String(packingSlipFiles.length)],
          ])}
        </div>
        <p class="sg-meta-note">No Shippo charge. After a complete label/tracking record, use Mark shipped in Action needed.</p>
        <p class="sg-error" id="ext-confirm-err" role="alert" hidden></p>
        <div class="sg-drawer-actions">
          <button type="button" class="sg-btn sg-btn--ghost" id="ext-confirm-back">Back</button>
          <button type="button" class="sg-btn sg-btn--primary" id="ext-confirm-save">Confirm save</button>
        </div>`;

      getEl("ext-confirm-back")?.addEventListener("click", () => {
        confirmStep.hidden = true;
        confirmStep.innerHTML = "";
        if (formStep) formStep.hidden = false;
        if (continueBtn) {
          continueBtn.disabled = false;
          continueBtn.textContent = "Continue";
        }
        if (cancelBtn) cancelBtn.disabled = false;
      });
      getEl("ext-confirm-save")?.addEventListener("click", () => {
        void submitExternalLabelRecord(row);
      });
    }
  } catch (error) {
    setExternalLabelErr("ext-form-err", error?.message || "Could not read uploaded files.");
    if (continueBtn) {
      continueBtn.disabled = false;
      continueBtn.textContent = "Continue";
    }
    if (cancelBtn) cancelBtn.disabled = false;
  }
}

/**
 * POST /api/admin-order-external-fulfillment-save — same payload as old admin.
 */
async function submitExternalLabelRecord(row) {
  if (externalLabelInFlight) return;
  const draft = externalLabelDraft;
  if (!draft || String(draft.orderId) !== String(row.id)) {
    setExternalLabelErr("ext-confirm-err", "Form data expired. Go back and continue again.");
    return;
  }

  externalLabelInFlight = true;
  const confirmBtn = getEl("ext-confirm-save");
  const backBtn = getEl("ext-confirm-back");
  setExternalLabelErr("ext-confirm-err", "");
  if (confirmBtn) {
    confirmBtn.disabled = true;
    confirmBtn.textContent = "Saving…";
  }
  if (backBtn) backBtn.disabled = true;

  try {
    const token = await getToken();
    if (!token) throw new Error("Sign in again to save the external label record.");

    const payload = {
      orderId: draft.orderId,
      carrier: draft.carrier,
      service: draft.service,
      trackingNumbers: draft.trackingNumbers,
      shippedDate: draft.shippedDate,
      labelCostCents: draft.labelCostCents,
    };
    if (draft.labelFiles.length) payload.labelFiles = draft.labelFiles;
    if (draft.packingSlipFiles.length) payload.packingSlipFiles = draft.packingSlipFiles;

    const data = await fetchReportPost("/api/admin-order-external-fulfillment-save", token, payload);

    let refreshed = row;
    if (data?.order) {
      patchOrderInCache(data.order);
      refreshed = data.order;
    }
    try {
      await loadOrders();
      refreshed = ordersCache.find((r) => String(r.id) === String(row.id)) || refreshed;
    } catch {
      /* best-effort */
    }

    externalLabelDraft = null;
    toast("External label record saved.", "success");
    openOrderDrawer(refreshed);
  } catch (error) {
    const msg =
      error instanceof ReportPostError
        ? error.message
        : error?.message || "Could not save external label record.";
    setExternalLabelErr("ext-confirm-err", msg);
    if (confirmBtn) {
      confirmBtn.disabled = false;
      confirmBtn.textContent = "Confirm save";
    }
    if (backBtn) backBtn.disabled = false;
  } finally {
    externalLabelInFlight = false;
  }
}

function paymentLinkUrl(row) {
  return String(row?.payment_link_url || "").trim();
}

/** Unpaid and past stored expiry — display-only; not enforced by backend. */
function isPaymentLinkExpired(row) {
  if (isPaymentPaid(row)) return false;
  const exp = row?.payment_link_expires_at;
  if (exp == null || exp === "") return false;
  const t = new Date(exp).getTime();
  if (!Number.isFinite(t)) return false;
  return t < Date.now();
}

/**
 * Show awaiting-payment-link Action Needed when status is payment_link_sent
 * or a checkout URL is stored (unpaid path only).
 */
function shouldShowAwaitingPaymentLinkPanel(row) {
  if (!row || isPaymentPaid(row) || isWalkInOrder(row) || isOrderCancelled(row)) return false;
  if (String(row.order_status || "") === "payment_link_sent") return true;
  return Boolean(paymentLinkUrl(row));
}

/** @returns {"sent"|"expired"|"missing"|null} */
function paymentLinkStatusKey(row) {
  const url = paymentLinkUrl(row);
  const statusSent = String(row?.order_status || "") === "payment_link_sent";
  const hasSentMeta = Boolean(row?.payment_link_sent_at) || statusSent;
  if (!url && (statusSent || hasSentMeta)) return "missing";
  if (!url) return null;
  if (isPaymentLinkExpired(row)) return "expired";
  if (hasSentMeta || statusSent) return "sent";
  return "sent";
}

function paymentLinkStatusChip(row) {
  const key = paymentLinkStatusKey(row);
  if (key === "expired") return statusChip("Expired", "danger");
  if (key === "missing") return statusChip("Missing URL", "warning");
  if (key === "sent") return statusChip("Sent", "info");
  return statusChip("—", "neutral");
}

function paymentLinkActionsHtml(url, { block = false } = {}) {
  const u = String(url || "").trim();
  if (!u) return "";
  const cls = block ? "sg-btn sg-btn--ghost sg-btn--sm sg-btn--block" : "sg-btn sg-btn--ghost sg-btn--sm";
  return `<div class="sg-pay-link-actions">
    <button type="button" class="${cls}" data-od-copy-payment-link data-payment-link-url="${escapeHtml(u)}">${icon("copy", 14)}<span>Copy payment link</span></button>
    <a class="${cls}" href="${escapeHtml(u)}" target="_blank" rel="noopener noreferrer">${icon("external-link", 14)}<span>Open payment link</span></a>
  </div>`;
}

async function copyPaymentLinkToClipboard(url) {
  const u = String(url || "").trim();
  if (!u) {
    toast("No payment link to copy.", "danger");
    return;
  }
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(u);
    } else {
      const ta = document.createElement("textarea");
      ta.value = u;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    toast("Payment link copied.", "success");
  } catch {
    toast("Could not copy payment link.", "danger");
  }
}

function paymentDetailsHtml(row) {
  const paid = isPaymentPaid(row);
  const method = String(row.payment_method || row.manual_payment_method || "").trim();
  const flowRaw = String(row.payment_flow || "").trim();
  const statusSent = String(row.order_status || "") === "payment_link_sent";
  const url = paymentLinkUrl(row);
  const showLinkBlock = statusSent || Boolean(url) || flowRaw === "square_payment_link";
  const linkKey = paymentLinkStatusKey(row);
  const ship = shippingChargedCents(row);

  const flowLabel =
    flowRaw === "square_payment_link" || (!flowRaw && (statusSent || url))
      ? "Square payment link"
      : flowRaw === "pay_later"
        ? "Pay later"
        : flowRaw
          ? flowRaw.replace(/_/g, " ")
          : null;

  const pairs = [
    ["Status", paid ? statusChip("Paid", "success") : statusChip("Unpaid", "warning")],
    method ? ["Method", escapeHtml(method)] : null,
    flowLabel ? ["Payment flow", escapeHtml(flowLabel)] : null,
    showLinkBlock ? ["Link status", paymentLinkStatusChip(row)] : null,
    showLinkBlock && row.payment_link_sent_at
      ? ["Link sent", escapeHtml(fmtDateTime(row.payment_link_sent_at))]
      : showLinkBlock && statusSent
        ? ["Link sent", '<span class="sg-muted">Time not recorded</span>']
        : null,
    showLinkBlock && row.payment_link_expires_at
      ? ["Link expires", escapeHtml(fmtDateTime(row.payment_link_expires_at))]
      : null,
    !paid && showLinkBlock
      ? ["Total due", `<strong>${escapeHtml(fmtMoneyCents(row.total_cents))}</strong>`]
      : ["Order total", `<strong>${escapeHtml(fmtMoneyCents(row.total_cents))}</strong>`],
    row.subtotal_cents != null ? ["Merchandise", escapeHtml(fmtMoneyCents(row.subtotal_cents))] : null,
    row.tax_cents != null ? ["Tax", escapeHtml(fmtMoneyCents(row.tax_cents))] : null,
    ship != null ? ["Shipping", escapeHtml(fmtMoneyCents(ship))] : null,
    row.is_hardin_discount
      ? ["Discount", `Applied${row.discount_code_used ? ` · ${escapeHtml(String(row.discount_code_used))}` : ""}`]
      : null,
  ];

  let linkNotes = "";
  if (showLinkBlock && linkKey === "expired") {
    linkNotes += `<div class="sg-inline-warn" style="margin-top:10px">${icon("alert-triangle", 14)}<span>This payment link appears expired. Resend is not available in v2 yet.</span></div>`;
  }
  if (showLinkBlock && linkKey === "missing") {
    linkNotes += `<div class="sg-inline-warn" style="margin-top:10px">${icon("alert-triangle", 14)}<span>Payment link status is sent, but no checkout URL is stored.</span></div>`;
  }
  if (url) {
    linkNotes += `<div style="margin-top:10px">${paymentLinkActionsHtml(url, { block: false })}</div>`;
  }

  return `${kvHtml(pairs)}${linkNotes}`;
}

/* ------------------------------------------- shipping readiness + rate preview (Phase 4A) */

/** @returns {object[]} Shippo rate objects from order.shippo_shipment_rates_json (if any). */
function shippoRatesList(row) {
  try {
    const raw = row?.shippo_shipment_rates_json;
    if (!raw) return [];
    if (Array.isArray(raw)) return raw;
    if (typeof raw === "string" && raw.trim()) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
      if (parsed && typeof parsed === "object" && Array.isArray(parsed.rates)) return parsed.rates;
      return [];
    }
    if (typeof raw === "object" && Array.isArray(raw.rates)) return raw.rates;
    return [];
  } catch {
    return [];
  }
}

function formatShippoMoney(amount, currency) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return "—";
  const cur = String(currency || "USD").toUpperCase();
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: cur }).format(n);
  } catch {
    return `${n} ${cur}`;
  }
}

function rateServiceLabel(r) {
  if (!r || typeof r !== "object") return "—";
  const sl = r.servicelevel;
  if (sl && typeof sl === "object") {
    return String(sl.name || sl.token || "").trim() || "—";
  }
  return String(r.servicelevel_name || r.service || "").trim() || "—";
}

function rateDeliveryEstimate(r) {
  if (!r || typeof r !== "object") return "—";
  const days = r.estimated_days != null ? Number(r.estimated_days) : NaN;
  if (Number.isFinite(days) && days > 0) {
    return `${days} day${days === 1 ? "" : "s"}`;
  }
  const arrives = String(r.arrives_by || r.duration_terms || "").trim();
  return arrives || "—";
}

function parcelAuditSummaryFromRow(row) {
  try {
    const raw = row?.shippo_parcel_audit_json;
    let a = raw;
    if (typeof raw === "string" && raw.trim()) a = JSON.parse(raw);
    if (!a || typeof a !== "object") return null;
    const audit = Array.isArray(a.parcels) ? a.parcels : null;
    if (audit && audit.length) {
      return audit.map((p, i) => {
        const spec = p.spec;
        if (spec) {
          return `${i + 1}. ${spec.length}×${spec.width}×${spec.height} in · ${spec.weightLb} lb`;
        }
        return `${i + 1}. (see parcel audit)`;
      });
    }
    const req = Array.isArray(a.requestParcels) ? a.requestParcels : [];
    if (req.length) {
      return req.map(
        (p, i) => `${i + 1}. ${p.length}×${p.width}×${p.height} in · ${p.weight} ${p.mass_unit || "lb"}`,
      );
    }
    if (typeof a.parcelCount === "number" && a.parcelCount > 0) {
      return [`${a.parcelCount} parcel${a.parcelCount === 1 ? "" : "s"} (see audit)`];
    }
    return null;
  } catch {
    return null;
  }
}

function parcelPlanSummaryLines(parcelPlan) {
  if (!parcelPlan) return [];
  const parcels = Array.isArray(parcelPlan.parcels)
    ? parcelPlan.parcels
    : Array.isArray(parcelPlan)
      ? parcelPlan
      : [];
  return parcels.map((p, i) => {
    if (!p || typeof p !== "object") return `${i + 1}. —`;
    const L = p.length ?? "—";
    const W = p.width ?? "—";
    const H = p.height ?? "—";
    const unit = p.distance_unit || "in";
    const wt = p.weight ?? "—";
    const mu = p.mass_unit || "lb";
    return `${i + 1}. ${L}×${W}×${H} ${unit} · ${wt} ${mu}`;
  });
}

/**
 * Local readiness checklist for label planning (does not purchase anything).
 * Status pills: ok | check | optional | not_started | missing | locked
 * @returns {{ ready: boolean, items: Array<{ key: string, label: string, status: string, detail: string }>, cancelled: boolean, shipped: boolean }}
 */
function buildShippingReadiness(row) {
  const paid = isPaymentPaid(row);
  const cancelled = isOrderCancelled(row);
  const shipped = isOrderShipped(row);
  const { missing } = missingShippoAddressFields(row);
  const addrOk = missing.length === 0;
  const ymd = plannedShipDateYmd(row);
  const hasOv = hasShipFromOverride(row);
  const parcelLines = parcelAuditSummaryFromRow(row);
  const labels = labelsCache.get(String(row.id)) || [];

  let shipDateStatus = "optional";
  let shipDateDetail = "N/A for this fulfillment type";
  if (canSetPlannedShipDate(row)) {
    if (ymd) {
      shipDateStatus = "ok";
      shipDateDetail = fmtPlannedShipDateDisplay(ymd);
    } else {
      shipDateStatus = "optional";
      shipDateDetail = "Not set — optional for queue";
    }
  }

  let parcelStatus = "check";
  let parcelDetail = "Run preview to validate parcel plan";
  if (parcelLines && parcelLines.length) {
    parcelStatus = "ok";
    parcelDetail = parcelLines.join("; ");
  }

  let labelStatus = "not_started";
  let labelDetail = "No label yet";
  if (shipped) {
    labelStatus = "ok";
    labelDetail = "Fulfillment complete";
  } else if (hasPurchasedOrExternalLabel(row)) {
    labelStatus = "ok";
    labelDetail = hasAnyTrackingNumber(row) ? "Label on file · tracking present" : "Label on file";
  } else if (hasAnyTrackingNumber(row)) {
    labelStatus = "check";
    labelDetail = "Tracking present (no purchased label row)";
  } else if (labels.some((l) => String(l.status || "") === "failed")) {
    labelStatus = "check";
    labelDetail = "Label attempt failed";
  } else if (labels.length) {
    labelStatus = "check";
    labelDetail = "Label record(s) pending";
  } else {
    labelStatus = "not_started";
    labelDetail = "No label yet";
  }

  const items = [
    {
      key: "paid",
      label: "Payment",
      status: cancelled ? "locked" : paid ? "ok" : "missing",
      detail: cancelled ? "Cancelled" : paid ? "Paid" : "Unpaid — label purchase will stay blocked until paid",
    },
    {
      key: "ship_to",
      label: "Ship-to address",
      status: addrOk ? "ok" : "missing",
      detail: addrOk ? "Complete" : `Incomplete: ${missing.join(", ")}`,
    },
    {
      key: "ship_from",
      label: "Ship-from address",
      status: "ok",
      detail: hasOv ? "Custom override on order" : "Default warehouse",
    },
    {
      key: "ship_date",
      label: "Planned shipment date",
      status: shipDateStatus,
      detail: shipDateDetail,
    },
    {
      key: "parcel",
      label: "Package / parcel",
      status: parcelStatus,
      detail: parcelDetail,
    },
    {
      key: "label",
      label: "Label / tracking",
      status: labelStatus,
      detail: labelDetail,
    },
  ];

  const blocking = cancelled || !addrOk || shipped;
  const ready = !blocking && paid && addrOk && !shipped;
  return { ready, items, cancelled, shipped };
}

const READINESS_PILL_LABELS = {
  ok: "OK",
  check: "Check",
  optional: "Optional",
  not_started: "Not started",
  missing: "Missing",
  locked: "Locked",
};

function readinessCheckRowHtml(item) {
  const status = READINESS_PILL_LABELS[item.status] ? item.status : "check";
  const pillLabel = READINESS_PILL_LABELS[status];
  return `<div class="sg-readiness-item sg-readiness-item--${status}" data-ready-key="${escapeHtml(item.key)}">
    <span class="sg-readiness-dot" aria-hidden="true"></span>
    <div class="sg-readiness-body">
      <div class="sg-readiness-label">${escapeHtml(item.label)}</div>
      <div class="sg-readiness-detail">${escapeHtml(item.detail)}</div>
    </div>
    <span class="sg-readiness-pill sg-readiness-pill--${status}">${escapeHtml(pillLabel)}</span>
  </div>`;
}

function shippingReadinessSectionHtml(row) {
  const { ready, items, cancelled, shipped } = buildShippingReadiness(row);
  let headline;
  let title;
  let note;
  if (cancelled) {
    title = "Shipping Readiness";
    headline = statusChip("Cancelled", "danger");
    note =
      "This order is cancelled. Review the checklist for historical context only — fulfillment actions stay locked.";
  } else if (shipped) {
    title = "Fulfillment Summary";
    headline = statusChip("Shipped", "success");
    note = "This order has been shipped. The checklist below summarizes fulfillment details.";
  } else if (ready) {
    title = "Shipping Readiness";
    headline = statusChip("Ready for label planning", "success");
    note =
      "Review shipping details before syncing to Shippo or purchasing a label. This preview does not buy labels or charge the Shippo account.";
  } else {
    title = "Shipping Readiness";
    headline = statusChip("Not ready for label planning", "warning");
    note =
      "Review shipping details before syncing to Shippo or purchasing a label. This preview does not buy labels or charge the Shippo account.";
  }
  return sectionHtml(
    title,
    `<div class="sg-readiness-card">
      <div class="sg-readiness-card__head">${headline}
        <p class="sg-readiness-card__note">${escapeHtml(note)}</p>
      </div>
      <div class="sg-readiness-list" id="sg-od-ready-list">${items.map(readinessCheckRowHtml).join("")}</div>
    </div>`,
  );
}

function getRateObjectId(r) {
  return String(r?.object_id || "").trim();
}

function rateCarrierLabel(r) {
  return String(r?.provider_name || r?.provider || r?.carrier || "").trim() || "—";
}

function rateParcelLabel(r) {
  if (r?.parcel != null && String(r.parcel).trim()) return String(r.parcel).trim();
  if (r?.parcel_index != null) return `Parcel ${Number(r.parcel_index) + 1}`;
  return "—";
}

function findStoredRate(row, rateId) {
  const id = String(rateId || "").trim();
  if (!id) return null;
  return shippoRatesList(row).find((r) => getRateObjectId(r) === id) || null;
}

function getSelectedRateObjectId(row) {
  const oid = String(row?.id || "");
  if (oid && selectedRateByOrderId.has(oid)) {
    const picked = String(selectedRateByOrderId.get(oid) || "").trim();
    if (picked && findStoredRate(row, picked)) return picked;
  }
  const stored = String(row?.shippo_selected_rate_object_id || "").trim();
  if (stored && findStoredRate(row, stored)) return stored;
  return "";
}

function setSelectedRateObjectId(orderId, rateId) {
  const oid = String(orderId || "");
  const rid = String(rateId || "").trim();
  if (!oid) return;
  if (rid) selectedRateByOrderId.set(oid, rid);
  else selectedRateByOrderId.delete(oid);
}

/**
 * Buy-label eligibility (Phase 4C.1). Rate selection is required separately.
 * @returns {{ ok: boolean, reason: string|null }}
 */
function buyLabelEligibility(row, selectedRateId) {
  if (!row) return { ok: false, reason: "Order unavailable." };
  if (isOrderCancelled(row)) return { ok: false, reason: "Order is cancelled." };
  if (isOrderShipped(row)) return { ok: false, reason: "Order already shipped." };
  if (!isPaymentPaid(row)) return { ok: false, reason: "Only paid orders can purchase labels." };
  if (!String(row.shippo_order_id || "").trim()) {
    return { ok: false, reason: "Sync the order to Shippo first." };
  }
  if (!String(row.shippo_shipment_object_id || "").trim()) {
    return { ok: false, reason: "Create or refresh the Shippo shipment first (use Sync to Shippo)." };
  }
  const rates = shippoRatesList(row);
  if (!rates.length) {
    return { ok: false, reason: "No stored rates yet. Sync or refresh Shippo rates first." };
  }
  const { missing } = missingShippoAddressFields(row);
  if (missing.length) {
    return { ok: false, reason: `Ship-to incomplete: ${missing.join(", ")}.` };
  }
  if (!isShipFromAvailable(row)) {
    return { ok: false, reason: "Ship-from override is incomplete." };
  }
  if (hasPurchasedOrExternalLabel(row)) {
    return { ok: false, reason: "A shipping label already exists." };
  }
  if (hasAnyTrackingNumber(row)) {
    return { ok: false, reason: "Tracking already exists — label purchase is locked." };
  }
  const rateId = String(selectedRateId || "").trim();
  if (!rateId) {
    return { ok: false, reason: "Select a rate in Available Shippo Rates." };
  }
  if (!findStoredRate(row, rateId)) {
    return { ok: false, reason: "Selected rate is no longer available. Refresh rates and select again." };
  }
  return { ok: true, reason: null };
}

function buyLabelButtonHtml(row, opts = {}) {
  const block = opts.block === true;
  const enabledCls = block ? "sg-btn sg-btn--ghost sg-btn--sm sg-btn--block" : "sg-btn sg-btn--primary sg-btn--sm";
  const disabledCls = block ? "sg-btn sg-btn--ghost sg-btn--sm sg-btn--block" : "sg-btn sg-btn--ghost sg-btn--sm";
  const selectedId = getSelectedRateObjectId(row);
  const elig = buyLabelEligibility(row, selectedId);
  if (elig.ok) {
    return `<button type="button" class="${enabledCls}" data-od-buy-label>${icon("package", 14)}<span>Buy label</span></button>`;
  }
  return `<button type="button" class="${disabledCls}" data-od-buy-label disabled title="${escapeHtml(elig.reason || "Buy label unavailable.")}">${icon("package", 14)}<span>Buy label</span></button>`;
}

function ratesTableHtml(row, rates) {
  if (!Array.isArray(rates) || !rates.length) {
    return `<p class="sg-muted" style="margin:0">No stored rates yet. Sync or refresh Shippo rates first.</p>`;
  }
  const selectedId = getSelectedRateObjectId(row);
  const selectionEnabled =
    !isOrderCancelled(row) &&
    !isOrderShipped(row) &&
    !hasPurchasedOrExternalLabel(row) &&
    !hasAnyTrackingNumber(row);

  const rows = rates
    .map((r, idx) => {
      const id = getRateObjectId(r);
      const carrier = rateCarrierLabel(r);
      const service = rateServiceLabel(r);
      const cost = formatShippoMoney(r?.amount, r?.currency);
      const eta = rateDeliveryEstimate(r);
      const parcel = rateParcelLabel(r);
      const checked = id && id === selectedId ? " checked" : "";
      const selectedClass = id && id === selectedId ? " sg-rate-row--selected" : "";
      const radio = id
        ? `<input type="radio" class="sg-rate-pick" name="sg-shippo-rate-pick" value="${escapeHtml(id)}" ${selectionEnabled ? "" : "disabled "}${checked} data-rate-idx="${idx}" aria-label="Select ${escapeHtml(carrier)} ${escapeHtml(service)}" />`
        : `<span class="sg-muted" title="Rate missing object_id">—</span>`;
      return `<tr class="sg-rate-row${selectedClass}" data-rate-object-id="${escapeHtml(id)}">
        <td class="sg-rate-row__pick">${radio}</td>
        <td>${escapeHtml(carrier)}</td>
        <td>${escapeHtml(service)}</td>
        <td class="sg-table__num sg-nowrap">${escapeHtml(cost)}</td>
        <td class="sg-nowrap">${escapeHtml(eta)}</td>
        <td>${escapeHtml(parcel)}</td>
      </tr>`;
    })
    .join("");
  return `<div class="sg-table-wrap sg-workflow-rates"><table class="sg-table sg-table--tight sg-rates-table">
    <thead><tr><th class="sg-rate-row__pick">Select</th><th>Carrier</th><th>Service</th><th class="sg-table__num">Cost</th><th>Estimated delivery</th><th>Package</th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;
}

/** Single primary rate table — selection source for Phase 4C.1 label purchase. */
function availableShippoRatesSectionHtml(row) {
  const rates = shippoRatesList(row);
  const body = rates.length
    ? ratesTableHtml(row, rates)
    : `<p class="sg-muted" style="margin:0">No stored rates yet. Sync or refresh Shippo rates first.</p>`;
  const selectedId = getSelectedRateObjectId(row);
  const elig = buyLabelEligibility(row, selectedId);
  const hint = rates.length
    ? `<p class="sg-meta-note" id="sg-od-rate-hint" style="margin:10px 0 0">${escapeHtml(
        elig.ok ? "Rate selected. Confirm Buy label to purchase." : elig.reason || "Select a rate to enable Buy label.",
      )}</p>`
    : "";
  return sectionHtml(
    "Available Shippo Rates",
    `<p class="sg-meta-note" style="margin:0 0 10px">These rates are stored from Shippo sync/refresh. Select one rate, then use Buy label to purchase a single shipping label.</p>
    ${body}
    ${hint}`,
  );
}

function parcelValidationSectionHtml(_row) {
  return sectionHtml(
    "Parcel / Rate Validation",
    `<p class="sg-meta-note" style="margin:0 0 10px">Validation checks the shipment payload and parcel plan. It does not purchase a label or charge the Shippo account.</p>
    <div class="sg-ship-to-actions" style="margin-top:0">
      <button type="button" class="sg-btn sg-btn--primary sg-btn--sm" data-od-validate-parcel>${icon("package", 14)}<span>Validate parcel</span></button>
    </div>
    <div id="sg-od-preview-status" class="sg-preview-status" hidden></div>
    <div id="sg-od-preview-warn" class="sg-inline-warn" hidden style="margin-top:10px"></div>
    <div id="sg-od-preview-parcel" style="margin-top:12px"></div>
    <div id="sg-od-preview-note" style="margin-top:10px">
      <p class="sg-muted" style="margin:0">Click Validate parcel to check the shipment payload and parcel plan.</p>
    </div>`,
  );
}

function setPreviewWarn(html) {
  const el = document.getElementById("sg-od-preview-warn");
  if (!el) return;
  if (html) {
    el.innerHTML = `${icon("alert-triangle", 14)}<span>${html}</span>`;
    el.hidden = false;
  } else {
    el.innerHTML = "";
    el.hidden = true;
  }
}

function setPreviewStatus(text, loading) {
  const el = document.getElementById("sg-od-preview-status");
  if (!el) return;
  if (!text) {
    el.textContent = "";
    el.hidden = true;
    el.classList.remove("sg-preview-status--loading");
    return;
  }
  el.textContent = text;
  el.hidden = false;
  el.classList.toggle("sg-preview-status--loading", Boolean(loading));
}

/**
 * POST /api/admin-order-shippo-preview — dry-run only (no Shippo API, no DB write).
 * Payload: { orderId }
 * Does not render a rate table — stored rates live in Available Shippo Rates.
 */
async function runShippoParcelValidation(row) {
  const btn = document.querySelector("[data-od-validate-parcel]");
  const noteEl = document.getElementById("sg-od-preview-note");
  const parcelEl = document.getElementById("sg-od-preview-parcel");
  if (btn) btn.disabled = true;
  setPreviewWarn("");
  setPreviewStatus("Validating parcel plan…", true);
  if (noteEl) noteEl.innerHTML = `<p class="sg-muted" style="margin:0">Validating…</p>`;
  if (parcelEl) parcelEl.innerHTML = "";

  try {
    const token = await getToken();
    if (!token) throw new Error("Sign in again to validate the parcel plan.");

    const data = await fetchReportPost("/api/admin-order-shippo-preview", token, {
      orderId: String(row.id),
    });

    const preview = data?.preview || {};

    const warnings = [];
    const missing = Array.isArray(preview.missingAddressFields) ? preview.missingAddressFields : [];
    if (missing.length) {
      warnings.push(`Ship-to incomplete for Shippo: ${missing.join(", ")}.`);
    }
    if (preview.payloadError) {
      warnings.push(`Order payload: ${String(preview.payloadError)}`);
    }
    if (preview.parcelError) {
      warnings.push(`Package / parcel: ${String(preview.parcelError)}`);
    }
    if (preview.shipmentCreatePayloadError) {
      warnings.push(`Shipment preview: ${String(preview.shipmentCreatePayloadError)}`);
    }
    if (warnings.length) {
      setPreviewWarn(escapeHtml(warnings.join(" ")));
    }

    // Refresh readiness parcel line from preview parcel plan when available.
    const readyList = document.getElementById("sg-od-ready-list");
    if (readyList && preview.parcelPlan) {
      const lines = parcelPlanSummaryLines(preview.parcelPlan);
      if (lines.length) {
        const parcelRow = readyList.querySelector('[data-ready-key="parcel"]');
        const parcelDetail = parcelRow?.querySelector(".sg-readiness-detail");
        const parcelPill = parcelRow?.querySelector(".sg-readiness-pill");
        if (parcelDetail) parcelDetail.textContent = lines.join("; ");
        if (parcelPill) {
          parcelPill.textContent = "OK";
          parcelPill.className = "sg-readiness-pill sg-readiness-pill--ok";
        }
        if (parcelRow) {
          parcelRow.classList.remove(
            "sg-readiness-item--warning",
            "sg-readiness-item--check",
            "sg-readiness-item--missing",
            "sg-readiness-item--optional",
            "sg-readiness-item--not_started",
            "sg-readiness-item--locked",
          );
          parcelRow.classList.add("sg-readiness-item--ok");
        }
      }
    }

    const planLines = parcelPlanSummaryLines(preview.parcelPlan);
    if (parcelEl) {
      if (planLines.length) {
        parcelEl.innerHTML = `<h4 class="sg-drawer-section__title" style="font-size:13px;margin:0 0 6px">Parcel plan</h4>
          <ul class="sg-parcel-plan">${planLines.map((l) => `<li>${escapeHtml(l)}</li>`).join("")}</ul>`;
      } else if (preview.parcelError) {
        parcelEl.innerHTML = `<div class="sg-inline-warn">${icon("alert-triangle", 14)}<span>${escapeHtml(String(preview.parcelError))}</span></div>`;
      } else {
        parcelEl.innerHTML = `<p class="sg-muted" style="margin:0">No parcel plan returned.</p>`;
      }
    }

    // Never render a second rate table here — point staff to Available Shippo Rates.
    const hasPreviewRates =
      (Array.isArray(preview.rates) && preview.rates.length > 0) ||
      (Array.isArray(preview.shipmentRates) && preview.shipmentRates.length > 0) ||
      shippoRatesList(data?.order && typeof data.order === "object" ? data.order : row).length > 0;

    if (noteEl) {
      noteEl.innerHTML = hasPreviewRates
        ? `<p class="sg-meta-note" style="margin:0">Preview completed. Stored rates appear in Available Shippo Rates.</p>`
        : `<p class="sg-meta-note" style="margin:0">Validation completed. No stored rates yet — sync or refresh Shippo rates first.</p>`;
    }

    setPreviewStatus(warnings.length ? "Validation completed with warnings." : "Validation completed.", false);
  } catch (error) {
    const msg =
      error instanceof ReportPostError
        ? error.message
        : error?.message || "Could not validate parcel plan.";
    setPreviewWarn(escapeHtml(msg));
    setPreviewStatus("", false);
    if (noteEl) {
      noteEl.innerHTML = `<p class="sg-muted" style="margin:0">Validation failed. Fix the issue above and try again — the drawer stays open.</p>`;
    }
  } finally {
    if (btn) btn.disabled = false;
  }
}

/* ------------------------------------------- Shippo sync + refresh (Phase 4B) */

function isShipFromAvailable(row) {
  if (!hasShipFromOverride(row)) return true;
  const ov = parseShipFromOverride(row);
  return Boolean(ov && String(ov.line1 || "").trim() && String(ov.city || "").trim() && String(ov.state || "").trim());
}

function hasShippoRemoteObject(row) {
  return Boolean(
    String(row?.shippo_order_id || "").trim() ||
      String(row?.shippo_shipment_object_id || "").trim() ||
      String(row?.shippo_transaction_id || "").trim(),
  );
}

/**
 * Sync eligibility (Phase 4B + API paid requirement).
 * @returns {{ ok: boolean, reason: string|null }}
 */
function shippoSyncEligibility(row) {
  if (!row) return { ok: false, reason: "Order unavailable." };
  if (isOrderCancelled(row)) return { ok: false, reason: "Order is cancelled." };
  if (isOrderShipped(row)) return { ok: false, reason: "Order already shipped." };
  if (!isPaymentPaid(row)) return { ok: false, reason: "Only paid orders can sync to Shippo." };
  if (String(row.shippo_sync_status || "") === "syncing") {
    return { ok: false, reason: "A Shippo sync is already in progress." };
  }
  const { missing } = missingShippoAddressFields(row);
  if (missing.length) {
    return { ok: false, reason: `Ship-to incomplete: ${missing.join(", ")}.` };
  }
  if (!isShipFromAvailable(row)) {
    return { ok: false, reason: "Ship-from override is incomplete." };
  }
  if (hasPurchasedOrExternalLabel(row)) {
    return { ok: false, reason: "A shipping label already exists — sync is locked." };
  }
  return { ok: true, reason: null };
}

function canSyncToShippo(row) {
  return shippoSyncEligibility(row).ok;
}

/**
 * Refresh when a Shippo order/shipment/transaction already exists (same idea as old admin).
 * @returns {{ ok: boolean, reason: string|null }}
 */
function shippoRefreshEligibility(row) {
  if (!row) return { ok: false, reason: "Order unavailable." };
  if (String(row.shippo_sync_status || "") === "syncing") {
    return { ok: false, reason: "A Shippo sync is already in progress." };
  }
  if (!hasShippoRemoteObject(row)) {
    return { ok: false, reason: "Sync to Shippo first — nothing to refresh yet." };
  }
  return { ok: true, reason: null };
}

function canRefreshShippoStatus(row) {
  return shippoRefreshEligibility(row).ok;
}

function shippoSyncStatusDisplay(row) {
  const sync = String(row?.shippo_sync_status || "").trim();
  const orderId = String(row?.shippo_order_id || "").trim();
  if (sync === "syncing") return { label: "Syncing…", variant: "warning" };
  if (sync === "error" || sync === "failed") return { label: "Sync error", variant: "danger" };
  if (sync === "synced" || orderId) return { label: orderId ? "Synced" : "Synced", variant: "success" };
  if (sync) return { label: sync, variant: "neutral" };
  return { label: "Not synced", variant: "neutral" };
}

function shippoTrackingDisplay(row) {
  const status = String(row?.shippo_tracking_status || "").trim();
  const num = String(row?.shippo_tracking_number || "").trim();
  if (isOrderShipped(row) && !status && !num) return "Marked shipped";
  if (status && num) return `${status} · ${num}`;
  if (status) return status;
  if (num) return num;
  if (hasAnyTrackingNumber(row)) return "Tracking on file";
  return "No tracking yet";
}

function parcelSummaryForConfirm(row) {
  const lines = parcelAuditSummaryFromRow(row);
  if (lines && lines.length) return lines.join("; ");
  const rates = shippoRatesList(row);
  if (rates.length) return `${rates.length} rate${rates.length === 1 ? "" : "s"} stored`;
  return "Not validated yet — run preview or sync to build parcels";
}

function shipFromSummaryForConfirm(row) {
  if (lastShipFromFormatted) return lastShipFromFormatted;
  if (hasShipFromOverride(row)) {
    const ov = parseShipFromOverride(row);
    if (ov) {
      return [ov.name, ov.line1, [ov.city, ov.state, ov.postalCode || ov.zip].filter(Boolean).join(", ")]
        .filter(Boolean)
        .join(", ");
    }
    return "Custom override";
  }
  return "Default warehouse";
}

function patchOrderInCache(order) {
  if (!order?.id) return;
  const idx = ordersCache.findIndex((r) => String(r.id) === String(order.id));
  if (idx >= 0) ordersCache[idx] = order;
}

async function reloadOrderAfterShippo(orderId, fallbackRow) {
  let refreshed = fallbackRow;
  try {
    await loadOrders();
    refreshed = ordersCache.find((r) => String(r.id) === String(orderId)) || refreshed;
  } catch {
    /* POST succeeded; list refresh is best-effort */
  }
  return refreshed;
}

function shippingWorkflowSectionHtml(row) {
  const syncEl = shippoSyncStatusDisplay(row);
  const rates = shippoRatesList(row);
  const hasLabel = hasPurchasedOrExternalLabel(row);
  const syncElig = shippoSyncEligibility(row);
  const refreshElig = shippoRefreshEligibility(row);

  const syncBtn = syncElig.ok
    ? `<button type="button" class="sg-btn sg-btn--primary sg-btn--sm" data-od-shippo-sync>${icon("refresh-cw", 14)}<span>Sync to Shippo</span></button>`
    : `<button type="button" class="sg-btn sg-btn--ghost sg-btn--sm" disabled title="${escapeHtml(syncElig.reason || "Sync unavailable.")}">${icon("refresh-cw", 14)}<span>Sync to Shippo</span></button>`;

  const refreshBtn = refreshElig.ok
    ? `<button type="button" class="sg-btn sg-btn--ghost sg-btn--sm" data-od-shippo-refresh>${icon("refresh-cw", 14)}<span>Refresh rates/status</span></button>`
    : `<button type="button" class="sg-btn sg-btn--ghost sg-btn--sm" disabled title="${escapeHtml(refreshElig.reason || "Refresh unavailable.")}">${icon("refresh-cw", 14)}<span>Refresh rates/status</span></button>`;

  const buyBtn = buyLabelButtonHtml(row);

  const lastErr = String(row?.shippo_last_error || row?.shippo_sync_error || "").trim();
  const buyElig = buyLabelEligibility(row, getSelectedRateObjectId(row));

  return sectionHtml(
    "Shipping workflow",
    `<div class="sg-workflow-card">
      ${kvHtml([
        ["Shippo sync", `${statusChip(syncEl.label, syncEl.variant)}${String(row.shippo_order_id || "").trim() ? ` <span class="sg-mono sg-muted" style="font-size:11px">${escapeHtml(String(row.shippo_order_id))}</span>` : ""}`],
        ["Rates", rates.length ? `${rates.length} available` : "None stored"],
        ["Label", hasLabel ? statusChip("Purchased / on file", "success") : statusChip("Not purchased", "neutral")],
        ["Tracking", escapeHtml(shippoTrackingDisplay(row))],
      ])}
      ${!syncElig.ok ? `<p class="sg-meta-note" style="margin:8px 0 0">${escapeHtml(syncElig.reason)}</p>` : ""}
      ${!buyElig.ok ? `<p class="sg-meta-note" style="margin:8px 0 0" id="sg-od-buy-reason">${escapeHtml(buyElig.reason)}</p>` : `<p class="sg-meta-note" style="margin:8px 0 0" id="sg-od-buy-reason" hidden></p>`}
      ${lastErr ? `<div class="sg-inline-warn" style="margin-top:8px">${icon("alert-triangle", 14)}<span>${escapeHtml(lastErr)}</span></div>` : ""}
      <div class="sg-ship-to-actions" style="margin-top:12px">
        ${syncBtn}
        ${refreshBtn}
        ${buyBtn}
      </div>
      <div id="sg-od-shippo-err" class="sg-error" role="alert" hidden style="margin-top:8px"></div>
      <div id="sg-od-shippo-status" class="sg-preview-status" hidden></div>
      <p class="sg-meta-note" style="margin:10px 0 0">Select a rate below, then Buy label. Purchasing a label charges the connected Shippo account. After a complete label record, use Mark shipped in Action needed.</p>
    </div>`,
  );
}

function setShippoDrawerErr(msg) {
  const el = document.getElementById("sg-od-shippo-err");
  if (!el) return;
  if (msg) {
    el.textContent = msg;
    el.hidden = false;
  } else {
    el.textContent = "";
    el.hidden = true;
  }
}

function setShippoDrawerStatus(text, loading) {
  const el = document.getElementById("sg-od-shippo-status");
  if (!el) return;
  if (!text) {
    el.textContent = "";
    el.hidden = true;
    el.classList.remove("sg-preview-status--loading");
    return;
  }
  el.textContent = text;
  el.hidden = false;
  el.classList.toggle("sg-preview-status--loading", Boolean(loading));
}

function openSyncToShippoConfirmDrawer(row) {
  const elig = shippoSyncEligibility(row);
  if (!elig.ok) {
    toast(elig.reason || "Sync unavailable.", "danger");
    return;
  }

  const ref = escapeHtml(String(row.order_ref || row.id || "—"));
  const addr = normalizeSavedShippingAddress(row);
  const shipToLines = formatShipToLines(addr).join(", ") || "—";
  const ymd = plannedShipDateYmd(row);

  const bodyHtml = `
    <div class="sg-confirm">
      <h3 class="sg-confirm__title">Sync order to Shippo?</h3>
      <p class="sg-confirm__copy">This prepares or updates the shipment information in Shippo. It does not purchase a label or charge the Shippo account.</p>
      <div class="sg-confirm__summary">
        ${kvHtml([
          ["Order", `<span class="sg-mono">${ref}</span>`],
          ["Customer", escapeHtml(String(row.customer_name || "—"))],
          ["Ship-to", escapeHtml(shipToLines)],
          ["Ship-from", escapeHtml(shipFromSummaryForConfirm(row))],
          ["Planned shipment date", ymd ? escapeHtml(fmtPlannedShipDateDisplay(ymd)) : "Not set"],
          ["Package / parcel", escapeHtml(parcelSummaryForConfirm(row))],
        ])}
      </div>
      <p class="sg-meta-note">No label will be purchased by sync alone. Use Buy label after selecting a rate.</p>
      <p class="sg-error" id="shippo-sync-err" role="alert" hidden></p>
      <div class="sg-drawer-actions">
        <button type="button" class="sg-btn sg-btn--ghost" id="shippo-sync-cancel">Cancel</button>
        <button type="button" class="sg-btn sg-btn--primary" id="shippo-sync-confirm">Confirm sync</button>
      </div>
    </div>`;

  openDrawer({ title: "Sync to Shippo", bodyHtml });
  document.getElementById("sg-drawer")?.classList.remove("sg-drawer--wide");

  getEl("shippo-sync-cancel")?.addEventListener("click", () => openOrderDrawer(row));
  getEl("shippo-sync-confirm")?.addEventListener("click", () => {
    void submitShippoSync(row);
  });
}

function setShippoSyncConfirmErr(msg) {
  const el = getEl("shippo-sync-err");
  if (!el) return;
  if (msg) {
    el.textContent = msg;
    el.hidden = false;
  } else {
    el.textContent = "";
    el.hidden = true;
  }
}

/**
 * POST /api/admin-order-shippo-sync — same payload as old admin: { orderId }
 */
async function submitShippoSync(row) {
  if (shippoInFlight) return;
  shippoInFlight = true;

  const confirmBtn = getEl("shippo-sync-confirm");
  const cancelBtn = getEl("shippo-sync-cancel");
  setShippoSyncConfirmErr("");
  if (confirmBtn) {
    confirmBtn.disabled = true;
    confirmBtn.textContent = "Syncing…";
  }
  if (cancelBtn) cancelBtn.disabled = true;

  const orderId = String(row.id);
  try {
    const token = await getToken();
    if (!token) throw new Error("Sign in again to sync to Shippo.");

    const data = await fetchReportPost("/api/admin-order-shippo-sync", token, { orderId });

    let refreshed = row;
    if (data?.order) {
      patchOrderInCache(data.order);
      refreshed = data.order;
    }
    refreshed = await reloadOrderAfterShippo(orderId, refreshed);

    toast("Synced to Shippo.", "success");
    openOrderDrawer(refreshed);
  } catch (error) {
    if (error instanceof ReportPostError && error.body?.order) {
      patchOrderInCache(error.body.order);
    }
    let msg =
      error instanceof ReportPostError
        ? error.message
        : error?.message || "Shippo sync failed.";
    if (error instanceof ReportPostError && error.body?.shippo_last_error_response != null) {
      try {
        msg += ` Shippo response: ${JSON.stringify(error.body.shippo_last_error_response).slice(0, 400)}`;
      } catch {
        /* ignore */
      }
    }
    setShippoSyncConfirmErr(msg);
    if (confirmBtn) {
      confirmBtn.disabled = false;
      confirmBtn.textContent = "Confirm sync";
    }
    if (cancelBtn) cancelBtn.disabled = false;
  } finally {
    shippoInFlight = false;
  }
}

/**
 * POST /api/admin-order-shippo-refresh-status — same payload as old admin: { orderId }
 */
async function runShippoRefreshStatus(row) {
  if (shippoInFlight) return;
  const elig = shippoRefreshEligibility(row);
  if (!elig.ok) {
    setShippoDrawerErr(elig.reason || "Refresh unavailable.");
    return;
  }

  shippoInFlight = true;
  const btn = document.querySelector("[data-od-shippo-refresh]");
  const syncBtn = document.querySelector("[data-od-shippo-sync]");
  setShippoDrawerErr("");
  setShippoDrawerStatus("Refreshing Shippo status and rates…", true);
  if (btn) {
    btn.disabled = true;
    btn.dataset.prevLabel = btn.textContent || "";
    const span = btn.querySelector("span");
    if (span) span.textContent = "Refreshing…";
  }
  if (syncBtn) syncBtn.disabled = true;

  const orderId = String(row.id);
  try {
    const token = await getToken();
    if (!token) throw new Error("Sign in again to refresh Shippo status.");

    const data = await fetchReportPost("/api/admin-order-shippo-refresh-status", token, { orderId });

    let refreshed = row;
    if (data?.order) {
      patchOrderInCache(data.order);
      refreshed = data.order;
    }
    refreshed = await reloadOrderAfterShippo(orderId, refreshed);

    toast("Shippo status refreshed.", "success");
    openOrderDrawer(refreshed);
  } catch (error) {
    const msg =
      error instanceof ReportPostError
        ? error.message
        : error?.message || "Could not refresh Shippo status.";
    setShippoDrawerErr(msg);
    setShippoDrawerStatus("", false);
    if (btn) {
      btn.disabled = false;
      const span = btn.querySelector("span");
      if (span) span.textContent = "Refresh rates/status";
    }
    if (syncBtn) {
      const syncElig = shippoSyncEligibility(row);
      syncBtn.disabled = !syncElig.ok;
    }
  } finally {
    shippoInFlight = false;
  }
}

function refreshBuyLabelUi(row) {
  const selectedId = getSelectedRateObjectId(row);
  const elig = buyLabelEligibility(row, selectedId);
  const hint = document.getElementById("sg-od-rate-hint");
  if (hint) {
    hint.textContent = elig.ok
      ? "Rate selected. Confirm Buy label to purchase."
      : elig.reason || "Select a rate to enable Buy label.";
  }
  const reason = document.getElementById("sg-od-buy-reason");
  if (reason) {
    if (elig.ok) {
      reason.textContent = "";
      reason.hidden = true;
    } else {
      reason.textContent = elig.reason || "";
      reason.hidden = !elig.reason;
    }
  }
  document.querySelectorAll("[data-od-buy-label]").forEach((btn) => {
    const isBlock = btn.classList.contains("sg-btn--block");
    const parent = btn.parentElement;
    if (!parent) return;
    const tmp = document.createElement("div");
    tmp.innerHTML = buyLabelButtonHtml(row, { block: isBlock });
    const next = tmp.firstElementChild;
    if (next) {
      btn.replaceWith(next);
      next.addEventListener("click", (e) => {
        e.stopPropagation();
        openBuyLabelConfirmDrawer(row);
      });
    }
  });
}

function wireRateSelection(row) {
  document.querySelectorAll('input[name="sg-shippo-rate-pick"]').forEach((input) => {
    input.addEventListener("change", () => {
      if (!input.checked) return;
      const rateId = String(input.value || "").trim();
      setSelectedRateObjectId(row.id, rateId);
      document.querySelectorAll(".sg-rate-row").forEach((tr) => {
        tr.classList.toggle("sg-rate-row--selected", tr.getAttribute("data-rate-object-id") === rateId);
      });
      refreshBuyLabelUi(row);
    });
  });
  // Clicking the row selects the radio when enabled.
  document.querySelectorAll(".sg-rate-row").forEach((tr) => {
    tr.addEventListener("click", (e) => {
      if (e.target.closest("input, a, button")) return;
      const radio = tr.querySelector('input[name="sg-shippo-rate-pick"]');
      if (!radio || radio.disabled) return;
      radio.checked = true;
      radio.dispatchEvent(new Event("change", { bubbles: true }));
    });
  });
}

function openBuyLabelConfirmDrawer(row) {
  const rateId = getSelectedRateObjectId(row);
  const elig = buyLabelEligibility(row, rateId);
  if (!elig.ok) {
    toast(elig.reason || "Buy label unavailable.", "danger");
    return;
  }
  const rate = findStoredRate(row, rateId);
  if (!rate) {
    toast("Selected rate is no longer available.", "danger");
    return;
  }

  const PURCHASE_CONFIRM_PHRASE = "PURCHASE LABEL";
  const ref = escapeHtml(String(row.order_ref || row.id || "—"));
  const addr = normalizeSavedShippingAddress(row);
  const shipToLines = formatShipToLines(addr).join(", ") || "—";
  const ymd = plannedShipDateYmd(row);
  const carrier = rateCarrierLabel(rate);
  const service = rateServiceLabel(rate);
  const cost = formatShippoMoney(rate?.amount, rate?.currency);
  const parcel = rateParcelLabel(rate);
  const parcelExtra = parcelSummaryForConfirm(row);
  const parcelLine =
    parcel === "—"
      ? parcelExtra
      : `${parcel}${parcelExtra && parcelExtra !== parcel ? ` · ${parcelExtra}` : ""}`;

  const bodyHtml = `
    <div class="sg-confirm">
      <div class="sg-warn-banner sg-warn-banner--danger" role="alert">
        ${icon("alert-triangle", 16)}
        <span><strong>Live Shippo account detected.</strong> Confirming will purchase real postage and charge the connected Shippo account.</span>
      </div>
      <h3 class="sg-confirm__title">Purchase shipping label?</h3>
      <p class="sg-confirm__copy">This will purchase a shipping label and charge the connected Shippo account. Confirm the rate, carrier, service, ship-to address, and package details before continuing.</p>
      <div class="sg-confirm__summary">
        ${kvHtml([
          ["Order", `<span class="sg-mono">${ref}</span>`],
          ["Customer", escapeHtml(String(row.customer_name || "—"))],
          ["Ship-to", escapeHtml(shipToLines)],
          ["Ship-from", escapeHtml(shipFromSummaryForConfirm(row))],
          ["Carrier", escapeHtml(carrier)],
          ["Service", escapeHtml(service)],
          ["Label cost", `<strong>${escapeHtml(cost)}</strong>`],
          ["Package / parcel", escapeHtml(parcelLine)],
          ["Planned shipment date", ymd ? escapeHtml(fmtPlannedShipDateDisplay(ymd)) : "Not set"],
        ])}
      </div>
      <p class="sg-meta-note">This charges Shippo for postage. It does not mark the order shipped, notify the customer, or change payment status.</p>
      <label class="sg-field" style="margin-top:14px">
        <span class="sg-field__label">Type <span class="sg-mono">${escapeHtml(PURCHASE_CONFIRM_PHRASE)}</span> to enable purchase</span>
        <input type="text" class="sg-input" id="buy-label-type-confirm" autocomplete="off" spellcheck="false" placeholder="${escapeHtml(PURCHASE_CONFIRM_PHRASE)}" />
      </label>
      <p class="sg-error" id="buy-label-err" role="alert" hidden></p>
      <div class="sg-drawer-actions">
        <button type="button" class="sg-btn sg-btn--ghost" id="buy-label-cancel">Cancel</button>
        <button type="button" class="sg-btn sg-btn--primary" id="buy-label-confirm" data-rate-object-id="${escapeHtml(rateId)}" disabled>Purchase label and charge Shippo</button>
      </div>
    </div>`;

  openDrawer({ title: "Purchase shipping label", bodyHtml });
  document.getElementById("sg-drawer")?.classList.remove("sg-drawer--wide");

  const typeInput = getEl("buy-label-type-confirm");
  const confirmBtn = getEl("buy-label-confirm");
  const syncConfirmEnabled = () => {
    if (!confirmBtn) return;
    const typed = String(typeInput?.value || "");
    confirmBtn.disabled = typed !== PURCHASE_CONFIRM_PHRASE;
  };
  typeInput?.addEventListener("input", () => {
    setBuyLabelConfirmErr("");
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

  getEl("buy-label-cancel")?.addEventListener("click", () => openOrderDrawer(row));
  confirmBtn?.addEventListener("click", () => {
    if (String(typeInput?.value || "") !== PURCHASE_CONFIRM_PHRASE) {
      setBuyLabelConfirmErr(`Type ${PURCHASE_CONFIRM_PHRASE} exactly to continue.`);
      syncConfirmEnabled();
      return;
    }
    const lockedRateId = confirmBtn.getAttribute("data-rate-object-id") || rateId;
    void submitBuyLabel(row, lockedRateId);
  });
}

function setBuyLabelConfirmErr(msg) {
  const el = getEl("buy-label-err");
  if (!el) return;
  if (msg) {
    el.textContent = msg;
    el.hidden = false;
  } else {
    el.textContent = "";
    el.hidden = true;
  }
}

/**
 * POST /api/admin-order-shippo-purchase-label — same payload as old admin:
 * { orderId, rateObjectId }
 */
async function submitBuyLabel(row, rateObjectId) {
  if (shippoInFlight) return;
  const rateId = String(rateObjectId || "").trim();
  const elig = buyLabelEligibility(row, rateId);
  if (!elig.ok) {
    setBuyLabelConfirmErr(elig.reason || "Buy label unavailable.");
    return;
  }

  shippoInFlight = true;
  const confirmBtn = getEl("buy-label-confirm");
  const cancelBtn = getEl("buy-label-cancel");
  setBuyLabelConfirmErr("");
  if (confirmBtn) {
    confirmBtn.disabled = true;
    confirmBtn.textContent = "Purchasing…";
  }
  if (cancelBtn) cancelBtn.disabled = true;

  const orderId = String(row.id);
  try {
    const token = await getToken();
    if (!token) throw new Error("Sign in again to purchase a label.");

    const data = await fetchReportPost("/api/admin-order-shippo-purchase-label", token, {
      orderId,
      rateObjectId: rateId,
    });

    let refreshed = row;
    if (data?.order) {
      patchOrderInCache(data.order);
      refreshed = data.order;
    }
    refreshed = await reloadOrderAfterShippo(orderId, refreshed);
    selectedRateByOrderId.delete(orderId);

    toast("Shipping label purchased.", "success");
    openOrderDrawer(refreshed);
  } catch (error) {
    if (error instanceof ReportPostError && error.body?.order) {
      patchOrderInCache(error.body.order);
    }
    const msg =
      error instanceof ReportPostError
        ? error.message
        : error?.message || "Could not purchase label.";
    setBuyLabelConfirmErr(msg);
    if (confirmBtn) {
      confirmBtn.textContent = "Purchase label and charge Shippo";
      const typed = String(getEl("buy-label-type-confirm")?.value || "");
      confirmBtn.disabled = typed !== "PURCHASE LABEL";
    }
    if (cancelBtn) cancelBtn.disabled = false;
  } finally {
    shippoInFlight = false;
  }
}

/** Action Needed / status panel (UI-only; state-driven). */
function openLabelUrlForOrder(row) {
  const legacy = String(row?.shippo_label_url || "").trim();
  if (legacy) return legacy;
  for (const l of purchasedShippoLabelRows(row)) {
    const u = String(l?.label_url || "").trim();
    if (u) return u;
  }
  return "";
}

function actionPanelBtn({ label, iconName, attrs = "", primary = false, disabled = false, title = "" }) {
  const cls = primary
    ? "sg-btn sg-btn--primary sg-btn--sm sg-btn--block"
    : "sg-btn sg-btn--ghost sg-btn--sm sg-btn--block";
  if (disabled) {
    return `<button type="button" class="${cls}" disabled title="${escapeHtml(title || "Unavailable.")}">${icon(iconName, 14)}<span>${escapeHtml(label)}</span></button>`;
  }
  return `<button type="button" class="${cls}" ${attrs}>${icon(iconName, 14)}<span>${escapeHtml(label)}</span></button>`;
}

function actionPanelLink({ label, iconName, href, primary = false }) {
  const cls = primary
    ? "sg-btn sg-btn--primary sg-btn--sm sg-btn--block"
    : "sg-btn sg-btn--ghost sg-btn--sm sg-btn--block";
  return `<a class="${cls}" href="${escapeHtml(href)}" target="_blank" rel="noopener">${icon(iconName, 14)}<span>${escapeHtml(label)}</span></a>`;
}

function actionPanelGroup(label, html) {
  if (!html) return "";
  return `<div class="sg-action-needed__group">
    <p class="sg-action-needed__group-label">${escapeHtml(label)}</p>
    <div class="sg-action-needed__btns">${html}</div>
  </div>`;
}

/**
 * @returns {{ title: string, body: string }}
 */
function buildActionNeededPanel(row, wf) {
  const cancelled = isOrderCancelled(row);
  const paid = isPaymentPaid(row);
  const shipped = isOrderShipped(row);
  const walkIn = isWalkInOrder(row);

  /* ---------- cancelled ---------- */
  if (cancelled) {
    return {
      title: "Order Cancelled",
      body: `<div class="sg-action-needed">
        <div class="sg-action-needed__head">${statusChip("Cancelled", "danger")}</div>
        <p class="sg-action-needed__copy">This order is cancelled and locked. Fulfillment actions are unavailable.</p>
      </div>`,
    };
  }

  /* ---------- walk-in (no shipping / Shippo / label / notify) ---------- */
  if (walkIn) {
    const payMethod = String(row.payment_method || row.manual_payment_method || "").trim();
    const payLabel = payMethod ? payMethod.charAt(0).toUpperCase() + payMethod.slice(1) : "—";

    if (!paid) {
      return {
        title: "Walk-in Order",
        body: `<div class="sg-action-needed">
          <div class="sg-action-needed__head">${statusChip("Payment needed", "warning")}</div>
          <p class="sg-action-needed__copy">Collect cash or check in person, then record payment on the walk-in order page. Shipping and Shippo actions do not apply.</p>
          ${actionPanelGroup(
            "Primary action",
            `<a class="sg-btn sg-btn--primary sg-btn--sm sg-btn--block" href="/admin-v2/walk-in-order">${icon("store", 14)}<span>Open walk-in order</span></a>`,
          )}
          <p class="sg-meta-note" style="margin:10px 0 0">Complete payment before marking this walk-in order fulfilled.</p>
        </div>`,
      };
    }

    if (shipped) {
      const facts = kvHtml([
        ["Status", "Walk-in completed"],
        payMethod ? ["Payment method", escapeHtml(payLabel)] : null,
        row.admin_handoff_at
          ? ["Completed", escapeHtml(fmtDateTime(row.admin_handoff_at))]
          : row.paid_at
            ? ["Paid", escapeHtml(fmtDateTime(row.paid_at))]
            : null,
      ]);
      return {
        title: "Order Completed",
        body: `<div class="sg-action-needed">
          <div class="sg-action-needed__head">${statusChip("Completed", "success")} ${statusChip("Fulfilled in person", "success")}</div>
          <p class="sg-action-needed__copy">This walk-in order has been completed. Physical handoff was confirmed; inventory was handled at payment.</p>
          <div class="sg-action-needed__facts">${facts}</div>
          <p class="sg-meta-note" style="margin:10px 0 0">No shipping label or tracking is required for walk-in orders.</p>
        </div>`,
      };
    }

    return {
      title: "Walk-in Order",
      body: `<div class="sg-action-needed">
        <div class="sg-action-needed__head">${statusChip("Ready to complete", "success")}</div>
        <p class="sg-action-needed__copy">Verify the customer has received the products, then confirm physical handoff. Inventory was already handled when payment was recorded.</p>
        ${actionPanelGroup(
          "Primary action",
          actionPanelBtn({
            label: "Complete walk-in handoff",
            iconName: "check",
            attrs: "data-od-complete-walk-in",
            primary: true,
          }),
        )}
        <p class="sg-meta-note" style="margin:10px 0 0">Walk-in orders do not use Shippo, shipping labels, or buyer shipping notifications.</p>
      </div>`,
    };
  }

  const shipElig = markShippedEligibility(row);
  const notifyElig = buyerNotifyEligibility(row);
  const isResendNotify = Boolean(row.admin_buyer_notify_sent_at);
  const extElig = externalLabelEligibility(row);
  const buyElig = buyLabelEligibility(row, getSelectedRateObjectId(row));
  const syncElig = shippoSyncEligibility(row);
  const refreshElig = shippoRefreshEligibility(row);
  const dateEligible = canSetPlannedShipDate(row);
  const addrEligible = canEditShipToAddress(row);
  const labelUrl = openLabelUrlForOrder(row);
  const { carrier, tracking } = markShippedCarrierTracking(row);
  const hasLabelRecord =
    orderLabelPurchased(row) || orderShippoPackageLabelsComplete(row) || manualFulfillmentRecordComplete(row);

  /* ---------- unpaid ---------- */
  if (!paid) {
    const secondary = [
      addrEligible
        ? actionPanelBtn({ label: "Edit address", iconName: "map-pin", attrs: "data-od-edit-ship-to" })
        : "",
      dateEligible
        ? actionPanelBtn({ label: "Set planned ship date", iconName: "clock", attrs: "data-od-set-ship-date" })
        : "",
    ]
      .filter(Boolean)
      .join("");

    /* Manual pay-later draft — Record payment only (Phase P1) */
    if (recordPaymentEligibility(row).ok) {
      return {
        title: "Payment Needed",
        body: `<div class="sg-action-needed">
          <div class="sg-action-needed__head">${statusChip("Pay later", "warning")}</div>
          <p class="sg-action-needed__copy">Record payment after cash, check, or other manual payment is received.</p>
          ${actionPanelGroup(
            "Primary action",
            actionPanelBtn({
              label: "Record payment",
              iconName: "dollar-sign",
              attrs: "data-od-record-payment",
              primary: true,
            }),
          )}
          ${actionPanelGroup("Secondary actions", secondary)}
          <p class="sg-meta-note" style="margin:10px 0 0">Fulfillment actions unlock after payment is recorded. This does not send a Square payment link.</p>
        </div>`,
      };
    }

    /* Payment link sent / URL on file — await payment (P3 display; no resend) */
    if (shouldShowAwaitingPaymentLinkPanel(row)) {
      const linkUrl = paymentLinkUrl(row);
      const linkKey = paymentLinkStatusKey(row);
      const sentAt = row.payment_link_sent_at ? fmtDateTime(row.payment_link_sent_at) : "—";
      const expiresAt = row.payment_link_expires_at ? fmtDateTime(row.payment_link_expires_at) : null;
      const headChips =
        statusChip("Payment link sent", "info") +
        (linkKey === "expired" ? ` ${statusChip("Expired", "danger")}` : "");

      const facts = kvHtml([
        ["Link sent", escapeHtml(sentAt)],
        expiresAt ? ["Link expires", escapeHtml(expiresAt)] : null,
        ["Customer email", escapeHtml(String(row.customer_email || "—"))],
        [
          "Payment status",
          isPaymentPaid(row) ? statusChip("Paid", "success") : statusChip("Unpaid", "warning"),
        ],
      ]);

      let notes = "";
      if (linkKey === "expired") {
        notes += `<div class="sg-inline-warn" style="margin-top:10px">${icon("alert-triangle", 14)}<span>This payment link appears expired. Resend is not available in v2 yet.</span></div>`;
      }
      if (linkKey === "missing") {
        notes += `<div class="sg-inline-warn" style="margin-top:10px">${icon("alert-triangle", 14)}<span>Payment link status is sent, but no checkout URL is stored.</span></div>`;
      }

      const linkSecondary = linkUrl
        ? actionPanelBtn({
            label: "Copy payment link",
            iconName: "copy",
            attrs: `data-od-copy-payment-link data-payment-link-url="${escapeHtml(linkUrl)}"`,
          }) +
          actionPanelLink({
            label: "Open payment link",
            iconName: "external-link",
            href: linkUrl,
          })
        : "";

      return {
        title: "Awaiting Payment",
        body: `<div class="sg-action-needed">
          <div class="sg-action-needed__head">${headChips}</div>
          <p class="sg-action-needed__copy">Payment link has been sent to the customer. The order will move forward after payment is completed.</p>
          <div class="sg-action-needed__facts">${facts}</div>
          ${notes}
          ${actionPanelGroup("Secondary actions", linkSecondary + secondary)}
          <p class="sg-meta-note" style="margin:10px 0 0">Fulfillment actions unlock after payment is received. Resend is not available in v2 yet.</p>
        </div>`,
      };
    }

    /* Manual Square-link draft — Send payment link (Phase P2) */
    if (sendPaymentLinkEligibility(row).ok) {
      const sendNote =
        lastSendLinkResult &&
        String(lastSendLinkResult.orderId) === String(row.id) &&
        lastSendLinkResult.emailed === false &&
        lastSendLinkResult.checkoutUrl
          ? `<div class="sg-inline-warn" style="margin-top:10px">${icon("alert-triangle", 14)}<span>${escapeHtml(
              lastSendLinkResult.warning || "Payment link was created but the email was not sent.",
            )} Share manually: <a class="sg-mono" href="${escapeHtml(
              lastSendLinkResult.checkoutUrl,
            )}" target="_blank" rel="noopener noreferrer">${escapeHtml(lastSendLinkResult.checkoutUrl)}</a></span></div>`
          : "";
      return {
        title: "Payment Needed",
        body: `<div class="sg-action-needed">
          <div class="sg-action-needed__head">${statusChip("Ready to email link", "warning")}</div>
          <p class="sg-action-needed__copy">Create a Square payment link and email it to the customer. Totals may be recalculated when the link is sent.</p>
          ${actionPanelGroup(
            "Primary action",
            actionPanelBtn({
              label: "Send payment link",
              iconName: "receipt",
              attrs: "data-od-send-payment-link",
              primary: true,
            }),
          )}
          ${actionPanelGroup("Secondary actions", secondary)}
          ${sendNote}
          <p class="sg-meta-note" style="margin:10px 0 0">Fulfillment actions unlock after the customer pays.</p>
        </div>`,
      };
    }

    return {
      title: "Payment Needed",
      body: `<div class="sg-action-needed">
        <div class="sg-action-needed__head">${statusChip("Payment needed", "warning")}</div>
        <p class="sg-action-needed__copy">Collect payment before fulfillment. Label purchase, mark shipped, and buyer notification stay locked until the order is paid.</p>
        ${actionPanelGroup("Secondary actions", secondary)}
        <p class="sg-meta-note" style="margin:10px 0 0">Fulfillment actions unlock after payment is recorded.</p>
      </div>`,
    };
  }

  /* ---------- shipped / completed ---------- */
  if (shipped) {
    let primaryHtml = "";
    let secondaryHtml = "";
    if (labelUrl && notifyElig.ok) {
      primaryHtml = actionPanelLink({ label: "Open label", iconName: "eye", href: labelUrl, primary: true });
      secondaryHtml = actionPanelBtn({
        label: isResendNotify ? "Resend notification" : "Send buyer notification",
        iconName: "inbox",
        attrs: "data-od-buyer-notify",
      });
    } else if (labelUrl) {
      primaryHtml = actionPanelLink({ label: "Open label", iconName: "eye", href: labelUrl, primary: true });
    } else if (notifyElig.ok) {
      primaryHtml = actionPanelBtn({
        label: isResendNotify ? "Resend notification" : "Send buyer notification",
        iconName: "inbox",
        attrs: "data-od-buyer-notify",
        primary: true,
      });
    }

    const facts = kvHtml([
      ["Shipped status", escapeHtml(row.admin_handoff_at ? `Shipped · ${fmtDateTime(row.admin_handoff_at)}` : "Shipped")],
      carrier && carrier !== "—" ? ["Carrier", escapeHtml(carrier)] : null,
      tracking && tracking !== "—" ? ["Tracking", `<span class="sg-mono">${escapeHtml(tracking)}</span>`] : null,
      [
        "Buyer notification",
        isResendNotify
          ? `Sent ${escapeHtml(fmtDateTime(row.admin_buyer_notify_sent_at))}`
          : '<span class="sg-muted">Not sent</span>',
      ],
    ]);

    return {
      title: "Order Completed",
      body: `<div class="sg-action-needed">
        <div class="sg-action-needed__head">${statusChip("Completed", "success")} ${statusChip("Shipped", "success")}</div>
        <p class="sg-action-needed__copy">This order has been marked shipped. You can open the label or send/resend the buyer shipping notification if needed.</p>
        <div class="sg-action-needed__facts">${facts}</div>
        ${actionPanelGroup("Primary action", primaryHtml)}
        ${actionPanelGroup("Secondary actions", secondaryHtml)}
        <p class="sg-meta-note" style="margin:10px 0 0">Order has already been marked shipped.</p>
      </div>`,
    };
  }

  /* ---------- paid, not shipped ---------- */
  let chipLabel = "Needs action";
  let chipVariant = "warning";
  if (shipElig.ok) {
    chipLabel = "Ready to ship";
    chipVariant = "success";
  } else if (hasLabelRecord) {
    chipLabel = "Label recorded";
    chipVariant = "info";
  } else if (wf?.key === "address_required") {
    chipLabel = "Needs action";
    chipVariant = "warning";
  } else {
    chipLabel = "Awaiting shipment";
    chipVariant = "warning";
  }

  const copy =
    shipElig.ok
      ? "Label and tracking are on file. Mark the order shipped when the package has left your hands."
      : hasLabelRecord
        ? "Complete the next fulfillment step for this order."
        : "Complete the next fulfillment step for this order.";

  /** @type {string[]} */
  const primaryCandidates = [];
  if (shipElig.ok) {
    primaryCandidates.push(
      actionPanelBtn({ label: "Mark shipped", iconName: "truck", attrs: "data-od-mark-shipped", primary: true }),
    );
  } else if (buyElig.ok) {
    primaryCandidates.push(
      actionPanelBtn({ label: "Buy label", iconName: "package", attrs: "data-od-buy-label", primary: true }),
    );
  } else if (extElig.ok) {
    primaryCandidates.push(
      actionPanelBtn({
        label: "Record external label",
        iconName: "package",
        attrs: "data-od-record-external-label",
        primary: true,
      }),
    );
  } else if (notifyElig.ok && !isResendNotify) {
    primaryCandidates.push(
      actionPanelBtn({
        label: "Send buyer notification",
        iconName: "inbox",
        attrs: "data-od-buyer-notify",
        primary: true,
      }),
    );
  } else if (syncElig.ok) {
    primaryCandidates.push(
      actionPanelBtn({ label: "Sync to Shippo", iconName: "refresh-cw", attrs: "data-od-shippo-sync", primary: true }),
    );
  } else if (addrEligible) {
    primaryCandidates.push(
      actionPanelBtn({ label: "Edit address", iconName: "map-pin", attrs: "data-od-edit-ship-to", primary: true }),
    );
  }

  const primaryUsed = primaryCandidates[0] || "";
  const secondaryParts = [];
  if (dateEligible) {
    secondaryParts.push(
      actionPanelBtn({ label: "Set planned ship date", iconName: "clock", attrs: "data-od-set-ship-date" }),
    );
  }
  if (syncElig.ok && !/data-od-shippo-sync/.test(primaryUsed)) {
    secondaryParts.push(
      actionPanelBtn({ label: "Sync to Shippo", iconName: "refresh-cw", attrs: "data-od-shippo-sync" }),
    );
  }
  if (refreshElig.ok) {
    secondaryParts.push(
      actionPanelBtn({ label: "Refresh rates/status", iconName: "refresh-cw", attrs: "data-od-shippo-refresh" }),
    );
  }
  if (addrEligible && !/data-od-edit-ship-to/.test(primaryUsed)) {
    secondaryParts.push(
      actionPanelBtn({ label: "Edit address", iconName: "map-pin", attrs: "data-od-edit-ship-to" }),
    );
  }
  if (extElig.ok && !/data-od-record-external-label/.test(primaryUsed)) {
    secondaryParts.push(
      actionPanelBtn({
        label: "Record external label",
        iconName: "package",
        attrs: "data-od-record-external-label",
      }),
    );
  }
  if (buyElig.ok && !/data-od-buy-label/.test(primaryUsed)) {
    secondaryParts.push(
      actionPanelBtn({ label: "Buy label", iconName: "package", attrs: "data-od-buy-label" }),
    );
  }
  if (notifyElig.ok && !/data-od-buyer-notify/.test(primaryUsed)) {
    secondaryParts.push(
      actionPanelBtn({
        label: isResendNotify ? "Resend notification" : "Send buyer notification",
        iconName: "inbox",
        attrs: "data-od-buyer-notify",
      }),
    );
  }
  if (labelUrl) {
    secondaryParts.push(actionPanelLink({ label: "Open label", iconName: "eye", href: labelUrl }));
  }

  const nextLine =
    wf?.nextAction && String(wf.nextAction).trim()
      ? `<p class="sg-action-needed__status"><span class="sg-muted">Status</span><br /><strong>${escapeHtml(wf.label || "In progress")}</strong>${wf.nextAction ? ` · ${escapeHtml(wf.nextAction)}` : ""}</p>`
      : wf?.label
        ? `<p class="sg-action-needed__status"><span class="sg-muted">Status</span><br /><strong>${escapeHtml(wf.label)}</strong></p>`
        : "";

  const note = shipElig.ok
    ? "Mark shipped updates fulfillment status and may decrement inventory."
    : notifyElig.ok && !isResendNotify
      ? "Buyer notification emails tracking details to the customer."
      : wf?.blockingIssue
        ? String(wf.blockingIssue)
        : "";

  return {
    title: "Action Needed",
    body: `<div class="sg-action-needed">
      <div class="sg-action-needed__head">${statusChip(chipLabel, chipVariant)}</div>
      <p class="sg-action-needed__copy">${escapeHtml(copy)}</p>
      ${nextLine}
      ${wf?.blockingIssue && note !== String(wf.blockingIssue) ? `<div class="sg-inline-warn">${icon("alert-triangle", 14)}<span>${escapeHtml(wf.blockingIssue)}</span></div>` : ""}
      ${actionPanelGroup("Primary action", primaryUsed || `<p class="sg-meta-note" style="margin:0">No primary action available yet — use secondary steps or complete label/tracking first.</p>`)}
      ${actionPanelGroup("Secondary actions", secondaryParts.join(""))}
      ${note ? `<p class="sg-meta-note" style="margin:10px 0 0">${escapeHtml(note)}</p>` : ""}
    </div>`,
  };
}

function actionNeededSectionHtml(row, wf) {
  const panel = buildActionNeededPanel(row, wf);
  return sectionHtml(panel.title, panel.body);
}

/* ------------------------------------------- mark shipped / handoff (Phase 5A) */

/** Purchased / success statuses used on order_shippo_labels (case-insensitive). */
function isPurchasedLabelStatus(status) {
  const s = String(status || "").trim().toLowerCase();
  return s === "purchased" || s === "success" || s === "successful";
}

/** order_shippo_labels rows for this order (from labelsCache). */
function shippoLabelRowsForOrder(row) {
  return labelsCache.get(String(row?.id)) || [];
}

function purchasedShippoLabelRows(row) {
  return shippoLabelRowsForOrder(row).filter((l) => isPurchasedLabelStatus(l?.status));
}

/**
 * One package row is complete when purchased + label URL + tracking
 * (matches lib/order-shippo-labels.js isCompletePurchasedShippoLabelRow).
 */
function isCompletePurchasedShippoLabelRow(l) {
  if (!isPurchasedLabelStatus(l?.status)) return false;
  const tracking = String(l?.tracking_number || "").trim();
  const labelUrl = String(l?.label_url || "").trim();
  return Boolean(tracking && labelUrl);
}

/** Expected package count — same rules as backend expectedShippoPackageCount. */
function expectedShippoPackageCount(rows) {
  const list = Array.isArray(rows) ? rows : [];
  let expected = 0;
  for (const r of list) {
    const pc = Math.floor(Number(r?.parcel_count) || 0);
    if (pc > expected) expected = pc;
  }
  if (expected < 1) {
    let maxIdx = -1;
    for (const r of list) {
      if (r?.parcel_index == null) continue;
      const i = Number(r.parcel_index);
      if (Number.isFinite(i) && i > maxIdx) maxIdx = i;
    }
    expected = maxIdx >= 0 ? maxIdx + 1 : list.length;
  }
  return Math.max(0, Math.floor(expected) || 0);
}

/**
 * All required package labels complete — matches backend orderShippoPackageLabelsComplete.
 * @returns {boolean}
 */
function orderShippoPackageLabelsComplete(row) {
  if (String(row?.order_status || "") === "partial_label_purchase") return false;
  const list = shippoLabelRowsForOrder(row);
  if (!list.length) return false;
  const expected = expectedShippoPackageCount(list);
  if (expected < 1) return false;
  const byIndex = new Map();
  for (const r of list) {
    if (r?.parcel_index == null) continue;
    const i = Number(r.parcel_index);
    if (!Number.isFinite(i) || i < 0 || i >= expected) continue;
    byIndex.set(i, r);
  }
  if (byIndex.size !== expected) return false;
  for (let i = 0; i < expected; i++) {
    const lab = byIndex.get(i);
    if (!lab || !isCompletePurchasedShippoLabelRow(lab)) return false;
  }
  return true;
}

/**
 * Describe gaps when package label rows exist but are not complete for handoff.
 * @returns {string|null}
 */
function purchasedShippoLabelRowGapReason(row) {
  if (String(row?.order_status || "") === "partial_label_purchase") {
    return "Complete purchased label records are required before marking this order shipped.";
  }
  const list = shippoLabelRowsForOrder(row);
  if (!list.length) return null;
  if (orderShippoPackageLabelsComplete(row)) return null;

  const expected = expectedShippoPackageCount(list);
  const byIndex = new Map();
  for (const r of list) {
    if (r?.parcel_index == null) continue;
    const i = Number(r.parcel_index);
    if (!Number.isFinite(i) || i < 0 || i >= expected) continue;
    byIndex.set(i, r);
  }
  if (byIndex.size !== expected) {
    return "Complete purchased label records are required before marking this order shipped.";
  }
  const incomplete = [];
  for (let i = 0; i < expected; i++) {
    const lab = byIndex.get(i);
    if (!lab || !isCompletePurchasedShippoLabelRow(lab)) incomplete.push(lab || { parcel_index: i });
  }
  const missingTracking = incomplete.filter((l) => l && !String(l?.tracking_number || "").trim());
  const missingUrl = incomplete.filter((l) => l && !String(l?.label_url || "").trim());
  const notPurchased = incomplete.filter((l) => l && !isPurchasedLabelStatus(l?.status));
  if (notPurchased.length || (missingTracking.length && missingUrl.length) || byIndex.size !== expected) {
    return "Complete purchased label records are required before marking this order shipped.";
  }
  if (missingTracking.length) {
    return "Purchased Shippo package label(s) are missing a tracking number.";
  }
  if (missingUrl.length) {
    return "Purchased Shippo package label(s) are missing a label URL.";
  }
  return "Complete purchased label records are required before marking this order shipped.";
}

/**
 * Mark shipped eligibility (v2 UI) — matches markAdminOrderHandoffShipped:
 *   - legacy Shippo success (order.shippo_label_url + SUCCESS)
 *   - OR complete external record
 *   - OR complete purchased order_shippo_labels for all packages
 * @returns {{ ok: boolean, reason: string|null }}
 */
function markShippedEligibility(row) {
  if (!row) return { ok: false, reason: "Order unavailable." };
  if (isOrderCancelled(row)) return { ok: false, reason: "Order is cancelled." };
  if (isOrderShipped(row)) return { ok: false, reason: "Order has already been marked shipped." };
  if (isWalkInOrder(row)) return { ok: false, reason: "Use Complete walk-in handoff for walk-in sales." };
  if (!isPaymentPaid(row)) return { ok: false, reason: "Order must be paid first." };

  const legacyOk = orderLabelPurchased(row);
  const externalOk = manualFulfillmentRecordComplete(row);
  const packageOk = orderShippoPackageLabelsComplete(row);
  if (legacyOk || externalOk || packageOk) return { ok: true, reason: null };

  const list = shippoLabelRowsForOrder(row);
  if (list.length || String(row.order_status || "") === "partial_label_purchase") {
    return {
      ok: false,
      reason: purchasedShippoLabelRowGapReason(row) || "Complete purchased label records are required before marking this order shipped.",
    };
  }

  // Partial external record (carrier/tracking/files incomplete)
  const hasAnyExternal =
    Boolean(String(row.admin_external_carrier || "").trim()) ||
    externalTrackingLines(row).length > 0 ||
    storagePathCount(row.admin_external_label_storage_path) > 0;
  if (hasAnyExternal) {
    const bits = [];
    if (!String(row.admin_external_carrier || "").trim()) bits.push("carrier");
    if (!externalTrackingLines(row).length) bits.push("tracking number");
    if (!storagePathCount(row.admin_external_label_storage_path)) bits.push("uploaded label file");
    return {
      ok: false,
      reason: bits.length
        ? `External label record is incomplete (missing ${bits.join(", ")}).`
        : "A complete label or tracking record is required.",
    };
  }

  return { ok: false, reason: "A complete label or tracking record is required." };
}

function markShippedLabelSource(row) {
  if (manualFulfillmentRecordComplete(row)) return "External";
  if (orderLabelPurchased(row) || orderShippoPackageLabelsComplete(row) || purchasedShippoLabelRows(row).length) {
    return "Shippo";
  }
  return "—";
}

function markShippedCarrierTracking(row) {
  if (manualFulfillmentRecordComplete(row)) {
    const carrier = String(row.admin_external_carrier || "").trim() || "—";
    const tracks = externalTrackingLines(row);
    return { carrier, tracking: tracks.length ? tracks.join(", ") : "—", source: "External" };
  }
  const labels = purchasedShippoLabelRows(row);
  const carriers = [
    ...new Set(
      labels
        .map((l) => [l.carrier, l.servicelevel_name].map((v) => String(v || "").trim()).filter(Boolean).join(" · "))
        .filter(Boolean),
    ),
  ];
  const tracks = labels.map((l) => String(l.tracking_number || "").trim()).filter(Boolean);
  const carrier =
    carriers.length > 0
      ? carriers.join(", ")
      : String(row.shippo_label_carrier || "").trim() || "—";
  const tracking =
    tracks.length > 0
      ? tracks.join(", ")
      : String(row.shippo_tracking_number || "").trim() || "—";
  return { carrier, tracking, source: "Shippo" };
}

function markShippedItemsSummaryHtml(row) {
  const items = Array.isArray(row?.items) ? row.items : [];
  if (!items.length) return `<p class="sg-muted" style="margin:0">No line items recorded.</p>`;
  const rows = items
    .map((it) => {
      const name = escapeHtml(String(it.name || it.slug || "Product"));
      const sizeRows = formatSizeRows(it);
      const qtyBits = [];
      for (const bl of Array.isArray(it.bundleLines) ? it.bundleLines : []) {
        const id = String(bl?.id || "").trim();
        const qty = Math.floor(Number(bl?.qty) || 0);
        if (!id || qty < 1) continue;
        qtyBits.push(`${bundleLabelBySlugId.get(`${it.slug || ""}:${id}`) || id} × ${qty}`);
      }
      if (sizeRows.length) qtyBits.push(sizeRows.join(", "));
      if (!qtyBits.length) {
        const fb = formatFallbackInventory(it);
        if (fb) qtyBits.push(fb);
        else if (it.quantity != null) qtyBits.push(`Qty ${it.quantity}`);
      }
      return `<tr>
        <td>${name}</td>
        <td>${escapeHtml(qtyBits.join(" · ") || "—")}</td>
      </tr>`;
    })
    .join("");
  return `<div class="sg-table-wrap"><table class="sg-table sg-table--tight">
    <thead><tr><th>Product</th><th>Quantity / sizes</th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;
}

function setMarkShippedErr(msg) {
  const el = getEl("mark-shipped-err");
  if (!el) return;
  if (msg) {
    el.textContent = msg;
    el.hidden = false;
  } else {
    el.textContent = "";
    el.hidden = true;
  }
}

function openMarkShippedConfirmDrawer(row) {
  if (isOrderShipped(row)) {
    toast("Order has already been marked shipped.", "danger");
    return;
  }
  const elig = markShippedEligibility(row);
  if (!elig.ok) {
    toast(elig.reason || "Mark shipped unavailable.", "danger");
    return;
  }

  const MARK_SHIPPED_PHRASE = "MARK SHIPPED";
  const wf = computeFulfillmentWorkflow(row);
  const ref = escapeHtml(String(row.order_ref || row.id || "—"));
  const addr = normalizeSavedShippingAddress(row);
  const shipToLines = formatShipToLines(addr).join(", ") || "—";
  const { carrier, tracking, source } = markShippedCarrierTracking(row);

  const bodyHtml = `
    <div class="sg-confirm">
      <div class="sg-warn-banner sg-warn-banner--danger" role="alert">
        ${icon("alert-triangle", 16)}
        <span>This will mark the order as shipped and may decrement physical inventory.</span>
      </div>
      <h3 class="sg-confirm__title">Mark order as shipped?</h3>
      <p class="sg-confirm__copy">Confirm that the package has left your hands and the label/tracking record is correct.</p>
      <div class="sg-confirm__summary">
        ${kvHtml([
          ["Order", `<span class="sg-mono">${ref}</span>`],
          ["Customer", escapeHtml(String(row.customer_name || "—"))],
          ["Ship-to", escapeHtml(shipToLines)],
          ["Current fulfillment", escapeHtml(wf.label || "—")],
          ["Label source", escapeHtml(source)],
          ["Carrier", escapeHtml(carrier)],
          ["Tracking", escapeHtml(tracking)],
        ])}
        <h4 class="sg-drawer-section__title" style="font-size:13px;margin:14px 0 6px">Products / quantities</h4>
        ${markShippedItemsSummaryHtml(row)}
      </div>
      <p class="sg-meta-note">This does not purchase a label, send a buyer email, or change payment status.</p>
      <label class="sg-field" style="margin-top:14px">
        <span class="sg-field__label">Type <span class="sg-mono">${escapeHtml(MARK_SHIPPED_PHRASE)}</span> to enable</span>
        <input type="text" class="sg-input" id="mark-shipped-type-confirm" autocomplete="off" spellcheck="false" placeholder="${escapeHtml(MARK_SHIPPED_PHRASE)}" />
      </label>
      <p class="sg-error" id="mark-shipped-err" role="alert" hidden></p>
      <div class="sg-drawer-actions">
        <button type="button" class="sg-btn sg-btn--ghost" id="mark-shipped-cancel">Cancel</button>
        <button type="button" class="sg-btn sg-btn--primary" id="mark-shipped-confirm" disabled>Mark shipped and update inventory</button>
      </div>
    </div>`;

  openDrawer({ title: "Mark order as shipped", bodyHtml });
  document.getElementById("sg-drawer")?.classList.remove("sg-drawer--wide");

  const typeInput = getEl("mark-shipped-type-confirm");
  const confirmBtn = getEl("mark-shipped-confirm");
  const syncConfirmEnabled = () => {
    if (!confirmBtn) return;
    confirmBtn.disabled = String(typeInput?.value || "") !== MARK_SHIPPED_PHRASE;
  };
  typeInput?.addEventListener("input", () => {
    setMarkShippedErr("");
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

  getEl("mark-shipped-cancel")?.addEventListener("click", () => openOrderDrawer(row));
  confirmBtn?.addEventListener("click", () => {
    if (String(typeInput?.value || "") !== MARK_SHIPPED_PHRASE) {
      setMarkShippedErr(`Type ${MARK_SHIPPED_PHRASE} exactly to continue.`);
      syncConfirmEnabled();
      return;
    }
    void submitMarkShipped(row);
  });
}

function normalizeMarkShippedError(msg) {
  const s = String(msg || "");
  if (/label records tab|upload a shipping label|carrier, tracking/i.test(s)) {
    return "A complete label or tracking record is required before marking this order shipped.";
  }
  return s || "Could not mark order as shipped.";
}

/**
 * POST /api/admin-order-fulfillment-handoff — same payload as old admin: { orderId }
 */
async function submitMarkShipped(row) {
  if (markShippedInFlight) return;
  const elig = markShippedEligibility(row);
  if (!elig.ok) {
    setMarkShippedErr(elig.reason || "Mark shipped unavailable.");
    return;
  }
  if (String(getEl("mark-shipped-type-confirm")?.value || "") !== "MARK SHIPPED") {
    setMarkShippedErr("Type MARK SHIPPED exactly to continue.");
    return;
  }

  markShippedInFlight = true;
  const confirmBtn = getEl("mark-shipped-confirm");
  const cancelBtn = getEl("mark-shipped-cancel");
  setMarkShippedErr("");
  if (confirmBtn) {
    confirmBtn.disabled = true;
    confirmBtn.textContent = "Marking shipped…";
  }
  if (cancelBtn) cancelBtn.disabled = true;

  const orderId = String(row.id);
  try {
    const token = await getToken();
    if (!token) throw new Error("Sign in again to mark the order shipped.");

    const data = await fetchReportPost("/api/admin-order-fulfillment-handoff", token, { orderId });

    let refreshed = row;
    if (data?.order) {
      patchOrderInCache(data.order);
      refreshed = data.order;
    }
    try {
      await loadOrders();
      refreshed = ordersCache.find((r) => String(r.id) === String(orderId)) || refreshed;
    } catch {
      /* best-effort */
    }

    toast("Order marked as shipped.", "success");
    openOrderDrawer(refreshed);
  } catch (error) {
    const raw =
      error instanceof ReportPostError
        ? error.message
        : error?.message || "Could not mark order as shipped.";
    setMarkShippedErr(normalizeMarkShippedError(raw));
    if (confirmBtn) {
      confirmBtn.textContent = "Mark shipped and update inventory";
      const typed = String(getEl("mark-shipped-type-confirm")?.value || "");
      confirmBtn.disabled = typed !== "MARK SHIPPED";
    }
    if (cancelBtn) cancelBtn.disabled = false;
  } finally {
    markShippedInFlight = false;
  }
}

/* ------------------------------------------- record payment (manual pay-later P1) */

/**
 * Enable Record payment only for manual pay-later unpaid drafts (same gate as old admin).
 * @returns {{ ok: boolean, reason: string|null }}
 */
function recordPaymentEligibility(row) {
  if (!row) return { ok: false, reason: "Order unavailable." };
  if (String(row.order_source || "") !== "manual") {
    return { ok: false, reason: "Only manual pay-later orders can record payment here." };
  }
  if (isWalkInOrder(row)) {
    return { ok: false, reason: "Walk-in payment is recorded on the walk-in order page." };
  }
  if (isOrderCancelled(row)) return { ok: false, reason: "Order is cancelled." };
  if (isPaymentPaid(row) || String(row.status || "").toLowerCase() === "paid") {
    return { ok: false, reason: "This order is already paid." };
  }
  if (String(row.order_status || "") === "cancelled") {
    return { ok: false, reason: "Order is cancelled." };
  }
  if (String(row.payment_flow || "") !== "pay_later") {
    return { ok: false, reason: "Only pay-later manual drafts can record payment here." };
  }
  if (String(row.order_status || "") !== "draft") {
    return { ok: false, reason: "Only draft pay-later orders can record payment." };
  }
  return { ok: true, reason: null };
}

function formatManualPaymentMethodLabel(method) {
  const m = String(method || "").toLowerCase();
  if (m === "cash") return "Cash";
  if (m === "check") return "Check";
  if (m === "other") return "Other";
  return m || "—";
}

function setRecordPaymentFormErr(msg) {
  const wrap = getEl("record-pay-method");
  const el = getEl("record-pay-method-err");
  if (wrap) wrap.classList.toggle("is-invalid", Boolean(msg));
  if (!el) return;
  if (msg) {
    el.textContent = msg;
    el.hidden = false;
  } else {
    el.textContent = "";
    el.hidden = true;
  }
}

function setRecordPaymentConfirmErr(msg) {
  const el = getEl("record-pay-confirm-err");
  if (!el) return;
  if (msg) {
    el.textContent = msg;
    el.hidden = false;
  } else {
    el.textContent = "";
    el.hidden = true;
  }
}

function openRecordPaymentFormDrawer(row) {
  const elig = recordPaymentEligibility(row);
  if (!elig.ok) {
    toast(elig.reason || "Record payment unavailable.", "danger");
    return;
  }

  const prior =
    recordPaymentDraft && String(recordPaymentDraft.orderId) === String(row.id)
      ? recordPaymentDraft
      : null;
  const selectedMethod = prior?.manualPaymentMethod || "cash";
  const priorNote = prior?.paymentNote || "";

  const ref = escapeHtml(String(row.order_ref || row.id || "—"));
  const total = escapeHtml(fmtMoneyCents(row.total_cents));

  const methodOption = (value, label) => {
    const checked = selectedMethod === value ? " checked" : "";
    return `<label class="sg-pay-method__option">
      <input type="radio" name="rec_pay_method" value="${escapeHtml(value)}"${checked} />
      <span class="sg-pay-method__text">${escapeHtml(label)}</span>
    </label>`;
  };

  const bodyHtml = `
    <div class="sg-confirm">
      <h3 class="sg-confirm__title">Record payment</h3>
      <p class="sg-confirm__copy">Enter how the customer paid. You will confirm before the order is marked paid.</p>
      <div class="sg-confirm__summary">
        ${kvHtml([
          ["Order", `<span class="sg-mono">${ref}</span>`],
          ["Customer", escapeHtml(String(row.customer_name || "—"))],
          ["Total due", total],
        ])}
      </div>
      <div class="sg-pay-method" id="record-pay-method">
        <span class="sg-pay-method__label" id="record-pay-method-label">Payment method</span>
        <div class="sg-pay-method__options" role="radiogroup" aria-labelledby="record-pay-method-label">
          ${methodOption("cash", "Cash")}
          ${methodOption("check", "Check")}
          ${methodOption("other", "Other")}
        </div>
        <p class="sg-pay-method__error" id="record-pay-method-err" role="alert" hidden></p>
      </div>
      <label class="sg-field sg-record-pay-note">
        <span class="sg-field__label">Payment note <span class="sg-field__optional">(optional)</span></span>
        <textarea class="sg-input sg-textarea" id="record-pay-note" rows="3" maxlength="2000" placeholder="Check number, reference, internal note, etc.">${escapeHtml(priorNote)}</textarea>
      </label>
      <div class="sg-drawer-actions">
        <button type="button" class="sg-btn sg-btn--ghost" id="record-pay-form-cancel">Cancel</button>
        <button type="button" class="sg-btn sg-btn--primary" id="record-pay-form-continue">Continue to confirmation</button>
      </div>
    </div>`;

  openDrawer({ title: "Record payment", bodyHtml });
  document.getElementById("sg-drawer")?.classList.remove("sg-drawer--wide");

  document.querySelectorAll('input[name="rec_pay_method"]').forEach((input) => {
    input.addEventListener("change", () => setRecordPaymentFormErr(""));
  });

  getEl("record-pay-form-cancel")?.addEventListener("click", () => {
    recordPaymentDraft = null;
    openOrderDrawer(row);
  });
  getEl("record-pay-form-continue")?.addEventListener("click", () => {
    setRecordPaymentFormErr("");
    const method = String(
      document.querySelector('input[name="rec_pay_method"]:checked')?.value || "",
    )
      .trim()
      .toLowerCase();
    if (method !== "cash" && method !== "check" && method !== "other") {
      setRecordPaymentFormErr("Select a payment method.");
      return;
    }
    const note = String(getEl("record-pay-note")?.value || "").trim();
    recordPaymentDraft = {
      orderId: String(row.id),
      manualPaymentMethod: /** @type {"cash"|"check"|"other"} */ (method),
      paymentNote: note,
    };
    openRecordPaymentConfirmDrawer(row);
  });
}

function openRecordPaymentConfirmDrawer(row) {
  const elig = recordPaymentEligibility(row);
  if (!elig.ok) {
    toast(elig.reason || "Record payment unavailable.", "danger");
    return;
  }
  const draft = recordPaymentDraft;
  if (!draft || String(draft.orderId) !== String(row.id)) {
    openRecordPaymentFormDrawer(row);
    return;
  }

  const PHRASE = "RECORD PAYMENT";
  const ref = escapeHtml(String(row.order_ref || row.id || "—"));
  const methodLabel = formatManualPaymentMethodLabel(draft.manualPaymentMethod);
  const noteDisplay = draft.paymentNote ? escapeHtml(draft.paymentNote) : '<span class="sg-muted">None</span>';
  const statusLine = escapeHtml(
    `${String(row.order_status || "draft")} · ${String(row.status || "unpaid")}`,
  );

  const bodyHtml = `
    <div class="sg-confirm">
      <div class="sg-warn-banner sg-warn-banner--danger" role="alert">
        ${icon("alert-triangle", 16)}
        <span>This will mark the order as paid and may decrement physical inventory. Confirm that payment has been received before continuing.</span>
      </div>
      <h3 class="sg-confirm__title">Record manual payment?</h3>
      <div class="sg-confirm__summary">
        ${kvHtml([
          ["Order", `<span class="sg-mono">${ref}</span>`],
          ["Order ID", `<span class="sg-mono">${escapeHtml(String(row.id || "—"))}</span>`],
          ["Customer", escapeHtml(String(row.customer_name || "—"))],
          ["Payment method", escapeHtml(methodLabel)],
          ["Payment note", noteDisplay],
          ["Order total", escapeHtml(fmtMoneyCents(row.total_cents))],
          ["Current status", statusLine],
        ])}
        <h4 class="sg-drawer-section__title" style="font-size:13px;margin:14px 0 6px">Products / quantities</h4>
        ${markShippedItemsSummaryHtml(row)}
      </div>
      <p class="sg-meta-note">This does not send a payment link, Square checkout, buyer email, or shipping notification.</p>
      <label class="sg-field" style="margin-top:14px">
        <span class="sg-field__label">Type <span class="sg-mono">${escapeHtml(PHRASE)}</span> to enable</span>
        <input type="text" class="sg-input" id="record-pay-type-confirm" autocomplete="off" spellcheck="false" placeholder="${escapeHtml(PHRASE)}" />
      </label>
      <p class="sg-error" id="record-pay-confirm-err" role="alert" hidden></p>
      <div class="sg-drawer-actions">
        <button type="button" class="sg-btn sg-btn--ghost" id="record-pay-confirm-back">Back</button>
        <button type="button" class="sg-btn sg-btn--primary" id="record-pay-confirm" disabled>Record payment and update inventory</button>
      </div>
    </div>`;

  openDrawer({ title: "Record manual payment?", bodyHtml });
  document.getElementById("sg-drawer")?.classList.remove("sg-drawer--wide");

  const typeInput = getEl("record-pay-type-confirm");
  const confirmBtn = getEl("record-pay-confirm");
  const syncConfirmEnabled = () => {
    if (!confirmBtn) return;
    confirmBtn.disabled = String(typeInput?.value || "") !== PHRASE;
  };
  typeInput?.addEventListener("input", () => {
    setRecordPaymentConfirmErr("");
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

  getEl("record-pay-confirm-back")?.addEventListener("click", () => openRecordPaymentFormDrawer(row));
  confirmBtn?.addEventListener("click", () => {
    if (String(typeInput?.value || "") !== PHRASE) {
      setRecordPaymentConfirmErr(`Type ${PHRASE} exactly to continue.`);
      syncConfirmEnabled();
      return;
    }
    void submitRecordPayment(row);
  });
}

/**
 * POST /api/admin-manual-order-record-payment — same payload as old admin.
 */
async function submitRecordPayment(row) {
  if (recordPaymentInFlight) return;
  const PHRASE = "RECORD PAYMENT";
  const elig = recordPaymentEligibility(row);
  if (!elig.ok) {
    setRecordPaymentConfirmErr(elig.reason || "Record payment unavailable.");
    return;
  }
  const draft = recordPaymentDraft;
  if (!draft || String(draft.orderId) !== String(row.id)) {
    setRecordPaymentConfirmErr("Payment details missing. Go back and select a method.");
    return;
  }
  if (String(getEl("record-pay-type-confirm")?.value || "") !== PHRASE) {
    setRecordPaymentConfirmErr(`Type ${PHRASE} exactly to continue.`);
    return;
  }

  recordPaymentInFlight = true;
  const confirmBtn = getEl("record-pay-confirm");
  const backBtn = getEl("record-pay-confirm-back");
  setRecordPaymentConfirmErr("");
  if (confirmBtn) {
    confirmBtn.disabled = true;
    confirmBtn.textContent = "Recording payment…";
  }
  if (backBtn) backBtn.disabled = true;

  const orderId = String(row.id);
  const payload = {
    orderId,
    manualPaymentMethod: draft.manualPaymentMethod,
    paymentNote: draft.paymentNote || undefined,
  };

  try {
    const token = await getToken();
    if (!token) throw new Error("Sign in again to record payment.");

    await fetchReportPost("/api/admin-manual-order-record-payment", token, payload);

    recordPaymentDraft = null;
    let refreshed = row;
    try {
      await loadOrders();
      refreshed = ordersCache.find((r) => String(r.id) === String(orderId)) || refreshed;
    } catch {
      /* best-effort; POST already succeeded */
    }

    toast("Payment recorded.", "success");
    openOrderDrawer(refreshed);
  } catch (error) {
    const raw =
      error instanceof ReportPostError
        ? error.message
        : error?.message || "Could not record payment.";
    setRecordPaymentConfirmErr(raw || "Could not record payment.");
    if (confirmBtn) {
      confirmBtn.textContent = "Record payment and update inventory";
      const typed = String(getEl("record-pay-type-confirm")?.value || "");
      confirmBtn.disabled = typed !== PHRASE;
    }
    if (backBtn) backBtn.disabled = false;
  } finally {
    recordPaymentInFlight = false;
  }
}

/* ------------------------------------------- send payment link (manual Square-link P2) */

function hasOrderShippingAddressObject(row) {
  const v = row?.shipping_address;
  if (v && typeof v === "object" && !Array.isArray(v)) return true;
  if (typeof v === "string" && v.trim()) {
    try {
      const p = JSON.parse(v);
      return Boolean(p && typeof p === "object" && !Array.isArray(p));
    } catch {
      return false;
    }
  }
  return false;
}

function formatManualFulfillmentLabelForSend(row) {
  const fm = effectiveFulfillmentMethod(row);
  if (fm === "pickup") return "Pickup";
  if (fm === "local_delivery") return "Local delivery";
  if (fm === "carrier") return "Carrier shipping";
  return fm || "—";
}

/**
 * Enable Send payment link only for manual Square-link unpaid drafts.
 * Mirrors backend gates on POST /api/admin-manual-order-send-link (orderId-only payload).
 * @returns {{ ok: boolean, reason: string|null }}
 */
function sendPaymentLinkEligibility(row) {
  if (!row) return { ok: false, reason: "Order unavailable." };
  if (String(row.order_source || "") !== "manual") {
    return { ok: false, reason: "Only manual orders can receive a payment link from this action." };
  }
  if (isWalkInOrder(row)) {
    return { ok: false, reason: "Walk-in orders do not use Square payment links." };
  }
  if (isOrderCancelled(row) || String(row.order_status || "") === "cancelled") {
    return { ok: false, reason: "Order is cancelled." };
  }
  if (isPaymentPaid(row) || String(row.status || "").toLowerCase() === "paid") {
    return { ok: false, reason: "This order is already paid." };
  }
  if (String(row.order_status || "") === "payment_link_sent") {
    return { ok: false, reason: "A payment link was already sent for this order." };
  }
  if (String(row.order_status || "") !== "draft") {
    return { ok: false, reason: "Order must be a draft to send a payment link." };
  }
  if (String(row.payment_flow || "square_payment_link") === "pay_later") {
    return { ok: false, reason: "Pay-later orders use Record payment instead of a Square link." };
  }
  const email = String(row.customer_email || "").trim();
  if (!email || !email.includes("@")) {
    return { ok: false, reason: "A valid customer email is required to send a payment link." };
  }
  if (!hasOrderShippingAddressObject(row)) {
    return { ok: false, reason: "Order is missing shipping address; update the draft before sending." };
  }
  const fm = effectiveFulfillmentMethod(row) || "carrier";
  if (fm === "carrier") {
    const a = normalizeSavedShippingAddress(row);
    if (!a.line1 || !a.city || !a.state || !a.postalCode) {
      return {
        ok: false,
        reason: "Complete ship-to address is required before sending a payment link.",
      };
    }
  }
  return { ok: true, reason: null };
}

function setSendPaymentLinkErr(msg) {
  const el = getEl("send-pay-link-err");
  if (!el) return;
  if (msg) {
    el.textContent = msg;
    el.hidden = false;
  } else {
    el.textContent = "";
    el.hidden = true;
  }
}

function openSendPaymentLinkConfirmDrawer(row) {
  const elig = sendPaymentLinkEligibility(row);
  if (!elig.ok) {
    toast(elig.reason || "Send payment link unavailable.", "danger");
    return;
  }

  const PHRASE = "SEND LINK";
  const ref = escapeHtml(String(row.order_ref || row.id || "—"));
  const addr = normalizeSavedShippingAddress(row);
  const shipToLines = formatShipToLines(addr).join(", ") || "—";
  const fmLabel = formatManualFulfillmentLabelForSend(row);
  const statusLine = escapeHtml(
    `${String(row.order_status || "draft")} · ${String(row.status || "unpaid")}`,
  );

  const bodyHtml = `
    <div class="sg-confirm">
      <div class="sg-warn-banner sg-warn-banner--danger" role="alert">
        ${icon("alert-triangle", 16)}
        <span>This will create a Square payment link and email it to the customer. Totals, tax, shipping, and discounts may be recalculated before the link is sent.</span>
      </div>
      <h3 class="sg-confirm__title">Send payment link?</h3>
      <div class="sg-confirm__summary">
        ${kvHtml([
          ["Order", `<span class="sg-mono">${ref}</span>`],
          ["Order ID", `<span class="sg-mono">${escapeHtml(String(row.id || "—"))}</span>`],
          ["Customer", escapeHtml(String(row.customer_name || "—"))],
          ["Customer email", escapeHtml(String(row.customer_email || "—"))],
          ["Current total", escapeHtml(fmtMoneyCents(row.total_cents))],
          ["Shipping method", escapeHtml(fmLabel)],
          ["Ship-to / address", escapeHtml(shipToLines)],
          ["Current status", statusLine],
        ])}
        <h4 class="sg-drawer-section__title" style="font-size:13px;margin:14px 0 6px">Products / quantities</h4>
        ${markShippedItemsSummaryHtml(row)}
      </div>
      <p class="sg-meta-note">This does not mark the order paid, record cash payment, purchase a label, or notify about shipping.</p>
      <label class="sg-field" style="margin-top:14px">
        <span class="sg-field__label">Type <span class="sg-mono">${escapeHtml(PHRASE)}</span> to enable</span>
        <input type="text" class="sg-input" id="send-pay-link-type-confirm" autocomplete="off" spellcheck="false" placeholder="${escapeHtml(PHRASE)}" />
      </label>
      <p class="sg-error" id="send-pay-link-err" role="alert" hidden></p>
      <div class="sg-drawer-actions">
        <button type="button" class="sg-btn sg-btn--ghost" id="send-pay-link-cancel">Cancel</button>
        <button type="button" class="sg-btn sg-btn--primary" id="send-pay-link-confirm" disabled>Create and email payment link</button>
      </div>
    </div>`;

  openDrawer({ title: "Send payment link?", bodyHtml });
  document.getElementById("sg-drawer")?.classList.remove("sg-drawer--wide");

  const typeInput = getEl("send-pay-link-type-confirm");
  const confirmBtn = getEl("send-pay-link-confirm");
  const syncConfirmEnabled = () => {
    if (!confirmBtn) return;
    confirmBtn.disabled = String(typeInput?.value || "") !== PHRASE;
  };
  typeInput?.addEventListener("input", () => {
    setSendPaymentLinkErr("");
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

  getEl("send-pay-link-cancel")?.addEventListener("click", () => openOrderDrawer(row));
  confirmBtn?.addEventListener("click", () => {
    if (String(typeInput?.value || "") !== PHRASE) {
      setSendPaymentLinkErr(`Type ${PHRASE} exactly to continue.`);
      syncConfirmEnabled();
      return;
    }
    void submitSendPaymentLink(row);
  });
}

/**
 * POST /api/admin-manual-order-send-link — safest payload: { orderId }
 */
async function submitSendPaymentLink(row) {
  if (sendPaymentLinkInFlight) return;
  const PHRASE = "SEND LINK";
  const elig = sendPaymentLinkEligibility(row);
  if (!elig.ok) {
    setSendPaymentLinkErr(elig.reason || "Send payment link unavailable.");
    return;
  }
  if (String(getEl("send-pay-link-type-confirm")?.value || "") !== PHRASE) {
    setSendPaymentLinkErr(`Type ${PHRASE} exactly to continue.`);
    return;
  }

  sendPaymentLinkInFlight = true;
  const confirmBtn = getEl("send-pay-link-confirm");
  const cancelBtn = getEl("send-pay-link-cancel");
  setSendPaymentLinkErr("");
  if (confirmBtn) {
    confirmBtn.disabled = true;
    confirmBtn.textContent = "Sending payment link…";
  }
  if (cancelBtn) cancelBtn.disabled = true;

  const orderId = String(row.id);
  try {
    const token = await getToken();
    if (!token) throw new Error("Sign in again to send a payment link.");

    const data = await fetchReportPost("/api/admin-manual-order-send-link", token, { orderId });
    const checkoutUrl = String(data?.checkoutUrl || "").trim();
    const emailed = data?.emailed === true;
    const warning = String(data?.warning || "").trim();

    lastSendLinkResult = {
      orderId,
      checkoutUrl,
      emailed,
      warning,
    };

    let refreshed = row;
    try {
      await loadOrders();
      refreshed = ordersCache.find((r) => String(r.id) === String(orderId)) || refreshed;
    } catch {
      /* best-effort */
    }

    if (emailed) {
      toast("Payment link emailed to the customer.", "success");
    } else {
      toast(
        warning || "Payment link was created but the email was not sent. Share the link manually.",
        "danger",
      );
    }
    openOrderDrawer(refreshed);
  } catch (error) {
    const raw =
      error instanceof ReportPostError
        ? error.message
        : error?.message || "Could not send payment link.";
    setSendPaymentLinkErr(raw || "Could not send payment link.");
    if (confirmBtn) {
      confirmBtn.textContent = "Create and email payment link";
      const typed = String(getEl("send-pay-link-type-confirm")?.value || "");
      confirmBtn.disabled = typed !== PHRASE;
    }
    if (cancelBtn) cancelBtn.disabled = false;
  } finally {
    sendPaymentLinkInFlight = false;
  }
}

/* ------------------------------------------- walk-in complete (handoff, no label) */

function walkInCompleteEligibility(row) {
  if (!row) return { ok: false, reason: "Order unavailable." };
  if (!isWalkInOrder(row)) return { ok: false, reason: "Not a walk-in order." };
  if (isOrderCancelled(row)) return { ok: false, reason: "Order is cancelled." };
  if (isOrderShipped(row)) return { ok: false, reason: "This walk-in order has already been completed." };
  if (!isPaymentPaid(row)) return { ok: false, reason: "Order must be paid first." };
  return { ok: true, reason: null };
}

function setWalkInCompleteErr(msg) {
  const el = getEl("walk-in-complete-err");
  if (!el) return;
  if (msg) {
    el.textContent = msg;
    el.hidden = false;
  } else {
    el.textContent = "";
    el.hidden = true;
  }
}

function openCompleteWalkInConfirmDrawer(row) {
  const elig = walkInCompleteEligibility(row);
  if (!elig.ok) {
    toast(elig.reason || "Walk-in completion unavailable.", "danger");
    return;
  }

  const PHRASE = "COMPLETE WALK-IN";
  const wf = computeFulfillmentWorkflow(row);
  const ref = escapeHtml(String(row.order_ref || row.id || "—"));
  const payMethod = String(row.payment_method || row.manual_payment_method || "").trim();
  const payLabel = payMethod ? payMethod.charAt(0).toUpperCase() + payMethod.slice(1) : "—";

  const bodyHtml = `
    <div class="sg-confirm">
      <div class="sg-warn-banner sg-warn-banner--danger" role="alert">
        ${icon("alert-triangle", 16)}
        <span>This confirms the customer has received the products. Inventory was already handled when payment was recorded.</span>
      </div>
      <h3 class="sg-confirm__title">Complete walk-in handoff?</h3>
      <div class="sg-confirm__summary">
        ${kvHtml([
          ["Order", `<span class="sg-mono">${ref}</span>`],
          ["Customer", escapeHtml(String(row.customer_name || "—"))],
          ["Payment method", escapeHtml(payLabel)],
          ["Current fulfillment", escapeHtml(wf.label || "—")],
        ])}
        <h4 class="sg-drawer-section__title" style="font-size:13px;margin:14px 0 6px">Products / quantities</h4>
        ${markShippedItemsSummaryHtml(row)}
      </div>
      <p class="sg-meta-note">This confirms physical handoff only. It does not purchase a label, sync to Shippo, send a shipping notification, or change inventory.</p>
      <label class="sg-field" style="margin-top:14px">
        <span class="sg-field__label">Type <span class="sg-mono">${escapeHtml(PHRASE)}</span> to enable</span>
        <input type="text" class="sg-input" id="walk-in-complete-type-confirm" autocomplete="off" spellcheck="false" placeholder="${escapeHtml(PHRASE)}" />
      </label>
      <p class="sg-error" id="walk-in-complete-err" role="alert" hidden></p>
      <div class="sg-drawer-actions">
        <button type="button" class="sg-btn sg-btn--ghost" id="walk-in-complete-cancel">Cancel</button>
        <button type="button" class="sg-btn sg-btn--primary" id="walk-in-complete-confirm" disabled>Complete walk-in handoff</button>
      </div>
    </div>`;

  openDrawer({ title: "Complete walk-in handoff?", bodyHtml });
  document.getElementById("sg-drawer")?.classList.remove("sg-drawer--wide");

  const typeInput = getEl("walk-in-complete-type-confirm");
  const confirmBtn = getEl("walk-in-complete-confirm");
  const syncConfirmEnabled = () => {
    if (!confirmBtn) return;
    confirmBtn.disabled = String(typeInput?.value || "") !== PHRASE;
  };
  typeInput?.addEventListener("input", () => {
    setWalkInCompleteErr("");
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

  getEl("walk-in-complete-cancel")?.addEventListener("click", () => openOrderDrawer(row));
  confirmBtn?.addEventListener("click", () => {
    if (String(typeInput?.value || "") !== PHRASE) {
      setWalkInCompleteErr(`Type ${PHRASE} exactly to continue.`);
      syncConfirmEnabled();
      return;
    }
    void submitCompleteWalkIn(row);
  });
}

/**
 * POST /api/admin-order-fulfillment-handoff — same payload: { orderId }
 * Walk-in path: no label proof; stock not decremented again (already at payment).
 */
async function submitCompleteWalkIn(row) {
  if (markShippedInFlight) return;
  const PHRASE = "COMPLETE WALK-IN";
  const elig = walkInCompleteEligibility(row);
  if (!elig.ok) {
    setWalkInCompleteErr(elig.reason || "Walk-in completion unavailable.");
    return;
  }
  if (String(getEl("walk-in-complete-type-confirm")?.value || "") !== PHRASE) {
    setWalkInCompleteErr(`Type ${PHRASE} exactly to continue.`);
    return;
  }

  markShippedInFlight = true;
  const confirmBtn = getEl("walk-in-complete-confirm");
  const cancelBtn = getEl("walk-in-complete-cancel");
  setWalkInCompleteErr("");
  if (confirmBtn) {
    confirmBtn.disabled = true;
    confirmBtn.textContent = "Completing…";
  }
  if (cancelBtn) cancelBtn.disabled = true;

  const orderId = String(row.id);
  try {
    const token = await getToken();
    if (!token) throw new Error("Sign in again to complete the walk-in order.");

    const data = await fetchReportPost("/api/admin-order-fulfillment-handoff", token, { orderId });

    let refreshed = row;
    if (data?.order) {
      patchOrderInCache(data.order);
      refreshed = data.order;
    }
    try {
      await loadOrders();
      refreshed = ordersCache.find((r) => String(r.id) === String(orderId)) || refreshed;
    } catch {
      /* best-effort */
    }

    toast("Walk-in handoff completed.", "success");
    openOrderDrawer(refreshed);
  } catch (error) {
    const raw =
      error instanceof ReportPostError
        ? error.message
        : error?.message || "Could not complete walk-in handoff.";
    setWalkInCompleteErr(raw || "Could not complete walk-in handoff.");
    if (confirmBtn) {
      confirmBtn.textContent = "Complete walk-in handoff";
      const typed = String(getEl("walk-in-complete-type-confirm")?.value || "");
      confirmBtn.disabled = typed !== PHRASE;
    }
    if (cancelBtn) cancelBtn.disabled = false;
  } finally {
    markShippedInFlight = false;
  }
}

/* ------------------------------------------- buyer shipping notify (Phase 5B) */

/**
 * Resolve notify fulfillment for UI (mirrors lib/admin-shipping-notify-resolve.js).
 * Prefers complete package labels, then legacy Shippo, then external.
 * @returns {{ ok: boolean, reason: string|null, sourceLabel: string, carrier: string, service: string, trackings: string[], shippedStatus: string }}
 */
function resolveBuyerNotifyFulfillmentUi(row) {
  const empty = {
    ok: false,
    reason: "A complete label or tracking record is required.",
    sourceLabel: "—",
    carrier: "—",
    service: "",
    trackings: [],
    shippedStatus: buyerNotifyShippedStatus(row),
  };
  if (!row) return empty;

  if (orderShippoPackageLabelsComplete(row)) {
    const list = shippoLabelRowsForOrder(row);
    const expected = expectedShippoPackageCount(list);
    const byIndex = new Map();
    for (const r of list) {
      if (r?.parcel_index == null) continue;
      const i = Number(r.parcel_index);
      if (!Number.isFinite(i) || i < 0 || i >= expected) continue;
      byIndex.set(i, r);
    }
    const trackings = [];
    const carriers = new Set();
    const services = new Set();
    for (let i = 0; i < expected; i++) {
      const lab = byIndex.get(i);
      if (!lab || !isCompletePurchasedShippoLabelRow(lab)) continue;
      const num = String(lab.tracking_number || "").trim();
      if (num) trackings.push(expected > 1 ? `Package ${i + 1}: ${num}` : num);
      const c = String(lab.carrier || "").trim();
      const s = String(lab.servicelevel_name || "").trim();
      if (c) carriers.add(c);
      if (s) services.add(s);
    }
    if (!trackings.length) {
      return { ...empty, reason: "Tracking number is required.", sourceLabel: "Package labels" };
    }
    return {
      ok: true,
      reason: null,
      sourceLabel: "Package labels",
      carrier: [...carriers].join(", ") || "—",
      service: [...services].join(", "),
      trackings,
      shippedStatus: buyerNotifyShippedStatus(row),
    };
  }

  const legacyOk =
    orderLabelPurchased(row) && Boolean(String(row.shippo_tracking_number || "").trim());
  if (legacyOk) {
    return {
      ok: true,
      reason: null,
      sourceLabel: "Shippo",
      carrier: String(row.shippo_label_carrier || "").trim() || "—",
      service: String(row.shippo_label_service || "").trim(),
      trackings: [String(row.shippo_tracking_number || "").trim()],
      shippedStatus: buyerNotifyShippedStatus(row),
    };
  }

  if (manualFulfillmentRecordComplete(row)) {
    const tracks = externalTrackingLines(row);
    if (!tracks.length) {
      return { ...empty, reason: "Tracking number is required.", sourceLabel: "External" };
    }
    return {
      ok: true,
      reason: null,
      sourceLabel: "External",
      carrier: String(row.admin_external_carrier || "").trim() || "—",
      service: String(row.admin_external_service || "").trim(),
      trackings: tracks,
      shippedStatus: buyerNotifyShippedStatus(row),
    };
  }

  if (!buyerNotifyTracking(row)) {
    const hasPartial =
      shippoLabelRowsForOrder(row).length > 0 ||
      Boolean(String(row.shippo_label_url || "").trim()) ||
      Boolean(String(row.admin_external_carrier || "").trim()) ||
      externalTrackingLines(row).length > 0;
    if (hasPartial) {
      return { ...empty, reason: "Tracking number is required." };
    }
  }

  return empty;
}

function buyerNotifyTracking(row) {
  const shippo = String(row?.shippo_tracking_number || "").trim();
  if (shippo) return shippo;
  const fromLabels = purchasedShippoLabelRows(row)
    .map((l) => String(l.tracking_number || "").trim())
    .filter(Boolean);
  if (fromLabels.length) return fromLabels.join(", ");
  const ext = externalTrackingLines(row);
  if (ext.length) return ext.join(", ");
  return "";
}

function buyerNotifyShippedStatus(row) {
  if (isOrderShipped(row)) {
    const when = row.admin_handoff_at ? fmtDateTime(row.admin_handoff_at) : "";
    return when ? `Shipped · ${when}` : "Shipped";
  }
  if (orderLabelPurchased(row) || orderShippoPackageLabelsComplete(row)) {
    const when = row.shippo_label_purchased_at ? fmtDateTime(row.shippo_label_purchased_at) : "";
    return when ? `Label on file · ${when}` : "Label on file (not marked shipped)";
  }
  const extDate = String(row.admin_external_shipped_date || "").trim();
  if (extDate) return `External ship date · ${extDate}`;
  return "Not marked shipped";
}

/**
 * Matches POST /api/admin-order-buyer-shipping-notify Option D.
 * @returns {{ ok: boolean, reason: string|null }}
 */
function buyerNotifyEligibility(row) {
  if (!row) return { ok: false, reason: "Order unavailable." };
  if (isOrderCancelled(row)) return { ok: false, reason: "Order is cancelled." };
  if (!String(row.customer_email || "").trim()) return { ok: false, reason: "Buyer email is missing." };

  const resolved = resolveBuyerNotifyFulfillmentUi(row);
  if (!resolved.ok) {
    return {
      ok: false,
      reason: resolved.reason || "A complete label or tracking record is required.",
    };
  }
  if (!resolved.trackings.length) {
    return { ok: false, reason: "Tracking number is required." };
  }
  return { ok: true, reason: null };
}

function setBuyerNotifyErr(msg) {
  const el = getEl("buyer-notify-err");
  if (!el) return;
  if (msg) {
    el.textContent = msg;
    el.hidden = false;
  } else {
    el.textContent = "";
    el.hidden = true;
  }
}

function openBuyerNotifyConfirmDrawer(row) {
  const elig = buyerNotifyEligibility(row);
  if (!elig.ok) {
    toast(elig.reason || "Notification unavailable.", "danger");
    return;
  }

  const isResend = Boolean(row.admin_buyer_notify_sent_at);
  const RESEND_PHRASE = "RESEND EMAIL";
  const resolved = resolveBuyerNotifyFulfillmentUi(row);
  const ref = escapeHtml(String(row.order_ref || row.id || "—"));
  const carrierService = [resolved.carrier, resolved.service].filter((v) => v && v !== "—").join(" · ") || "—";
  const trackingDisplay = resolved.trackings.length ? resolved.trackings.join(", ") : "—";
  const title = isResend ? "Resend shipping notification?" : "Send shipping notification?";
  const warnCopy = isResend
    ? "A buyer notification was already sent. Sending again will email the buyer one more time."
    : "This will email the customer with shipping/tracking information. Confirm the email address and tracking details before continuing.";
  const confirmLabel = isResend ? "Resend email to buyer" : "Send notification";
  const typeGate = isResend
    ? `<label class="sg-field" style="margin-top:14px">
        <span class="sg-field__label">Type <span class="sg-mono">${escapeHtml(RESEND_PHRASE)}</span> to enable</span>
        <input type="text" class="sg-input" id="buyer-notify-type-confirm" autocomplete="off" spellcheck="false" placeholder="${escapeHtml(RESEND_PHRASE)}" />
      </label>`
    : "";
  const priorSent = isResend
    ? `<p class="sg-meta-note">Previously sent ${escapeHtml(fmtDateTime(row.admin_buyer_notify_sent_at))}.</p>`
    : "";

  const bodyHtml = `
    <div class="sg-confirm">
      <div class="sg-warn-banner sg-warn-banner--danger" role="alert">
        ${icon("alert-triangle", 16)}
        <span>${escapeHtml(warnCopy)}</span>
      </div>
      <h3 class="sg-confirm__title">${escapeHtml(title)}</h3>
      <div class="sg-confirm__summary">
        ${kvHtml([
          ["Order", `<span class="sg-mono">${ref}</span>`],
          ["Customer", escapeHtml(String(row.customer_name || "—"))],
          ["Customer email", escapeHtml(String(row.customer_email || "—"))],
          ["Fulfillment source", escapeHtml(resolved.sourceLabel || "—")],
          ["Carrier / service", escapeHtml(carrierService)],
          ["Tracking", escapeHtml(trackingDisplay)],
          ["Shipped status", escapeHtml(resolved.shippedStatus || "—")],
        ])}
      </div>
      ${priorSent}
      <p class="sg-meta-note">This does not mark the order shipped, purchase a label, or change payment status.</p>
      ${typeGate}
      <p class="sg-error" id="buyer-notify-err" role="alert" hidden></p>
      <div class="sg-drawer-actions">
        <button type="button" class="sg-btn sg-btn--ghost" id="buyer-notify-cancel">Cancel</button>
        <button type="button" class="sg-btn sg-btn--primary" id="buyer-notify-confirm" ${isResend ? "disabled" : ""}>${escapeHtml(confirmLabel)}</button>
      </div>
    </div>`;

  openDrawer({ title, bodyHtml });
  document.getElementById("sg-drawer")?.classList.remove("sg-drawer--wide");

  const typeInput = getEl("buyer-notify-type-confirm");
  const confirmBtn = getEl("buyer-notify-confirm");
  const syncConfirmEnabled = () => {
    if (!isResend || !confirmBtn) return;
    confirmBtn.disabled = String(typeInput?.value || "") !== RESEND_PHRASE;
  };
  typeInput?.addEventListener("input", () => {
    setBuyerNotifyErr("");
    syncConfirmEnabled();
  });
  typeInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (confirmBtn && !confirmBtn.disabled) confirmBtn.click();
    }
  });
  syncConfirmEnabled();
  if (isResend) typeInput?.focus();

  getEl("buyer-notify-cancel")?.addEventListener("click", () => openOrderDrawer(row));
  confirmBtn?.addEventListener("click", () => {
    if (isResend && String(typeInput?.value || "") !== RESEND_PHRASE) {
      setBuyerNotifyErr(`Type ${RESEND_PHRASE} exactly to continue.`);
      syncConfirmEnabled();
      return;
    }
    void submitBuyerNotify(row, { isResend });
  });
}

/**
 * POST /api/admin-order-buyer-shipping-notify — same payload as old admin: { orderId }
 * @param {object} row
 * @param {{ isResend?: boolean }} [opts]
 */
async function submitBuyerNotify(row, opts = {}) {
  if (buyerNotifyInFlight) return;
  const isResend = Boolean(opts.isResend ?? row.admin_buyer_notify_sent_at);
  const RESEND_PHRASE = "RESEND EMAIL";
  const elig = buyerNotifyEligibility(row);
  if (!elig.ok) {
    setBuyerNotifyErr(elig.reason || "Notification unavailable.");
    return;
  }
  if (isResend && String(getEl("buyer-notify-type-confirm")?.value || "") !== RESEND_PHRASE) {
    setBuyerNotifyErr(`Type ${RESEND_PHRASE} exactly to continue.`);
    return;
  }

  buyerNotifyInFlight = true;
  const confirmBtn = getEl("buyer-notify-confirm");
  const cancelBtn = getEl("buyer-notify-cancel");
  const idleLabel = isResend ? "Resend email to buyer" : "Send notification";
  setBuyerNotifyErr("");
  if (confirmBtn) {
    confirmBtn.disabled = true;
    confirmBtn.textContent = isResend ? "Resending…" : "Sending…";
  }
  if (cancelBtn) cancelBtn.disabled = true;

  const orderId = String(row.id);
  try {
    const token = await getToken();
    if (!token) throw new Error("Sign in again to send the notification.");

    const data = await fetchReportPost("/api/admin-order-buyer-shipping-notify", token, { orderId });

    let refreshed = row;
    if (data?.order) {
      patchOrderInCache(data.order);
      refreshed = data.order;
    }
    try {
      await loadOrders();
      refreshed = ordersCache.find((r) => String(r.id) === String(orderId)) || refreshed;
    } catch {
      /* best-effort */
    }

    const sentAt = refreshed?.admin_buyer_notify_sent_at
      ? ` Sent ${fmtDateTime(refreshed.admin_buyer_notify_sent_at)}.`
      : "";
    toast(
      isResend ? `Buyer shipping notification resent.${sentAt}` : `Buyer shipping notification sent.${sentAt}`,
      "success",
    );
    openOrderDrawer(refreshed);
  } catch (error) {
    const raw =
      error instanceof ReportPostError
        ? error.message
        : error?.message || "Could not send notification.";
    setBuyerNotifyErr(raw || "Could not send notification.");
    if (confirmBtn) {
      confirmBtn.textContent = idleLabel;
      if (isResend) {
        const typed = String(getEl("buyer-notify-type-confirm")?.value || "");
        confirmBtn.disabled = typed !== RESEND_PHRASE;
      } else {
        confirmBtn.disabled = false;
      }
    }
    if (cancelBtn) cancelBtn.disabled = false;
  } finally {
    buyerNotifyInFlight = false;
  }
}

/* ------------------------------------------- planned ship date (Phase 3A) */

/** Manual carrier default matches old /admin + backend normalizeFulfillmentMethod. */
function effectiveFulfillmentMethod(row) {
  if (String(row?.order_source) !== "manual") return null;
  const raw = row?.fulfillment_method;
  if (raw != null && String(raw).trim() !== "") return String(raw).trim();
  return "carrier";
}

/**
 * Same eligibility rules as api/admin-order-shippo-shipment-date.js:
 * not walk-in; manual pickup/local_delivery excluded.
 */
function canSetPlannedShipDate(row) {
  if (!row) return false;
  if (isWalkInOrder(row)) return false;
  if (isManualOrder(row)) {
    const fm = effectiveFulfillmentMethod(row);
    if (fm === "pickup" || fm === "local_delivery") return false;
  }
  return true;
}

/** @returns {string|null} YYYY-MM-DD or null */
function plannedShipDateYmd(row) {
  const raw = String(row?.shippo_shipment_date || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;
}

function fmtPlannedShipDateDisplay(ymd) {
  if (!ymd) return "No planned ship date set.";
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  if (Number.isNaN(dt.getTime())) return ymd;
  return dt.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function plannedShipQueueHint(row) {
  const ymd = plannedShipDateYmd(row);
  if (!ymd) return `<p class="sg-muted" style="margin:6px 0 0;font-size:12px">Optional for label date and shipping queue.</p>`;
  if (isOrderShipped(row)) {
    return `<p class="sg-muted" style="margin:6px 0 0;font-size:12px">Shipped — planned date was for operations only.</p>`;
  }
  const today = new Date();
  const todayYmd = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  if (ymd === todayYmd) {
    return `<p class="sg-ship-date-hint sg-ship-date-hint--today" style="margin:6px 0 0">Ready to ship today</p>`;
  }
  if (ymd > todayYmd) {
    return `<p class="sg-muted" style="margin:6px 0 0;font-size:12px">Scheduled to ship on ${escapeHtml(ymd)}</p>`;
  }
  return `<p class="sg-ship-date-hint sg-ship-date-hint--past" style="margin:6px 0 0">Ship date passed</p>`;
}

function plannedShipDateSectionHtml(row) {
  if (!canSetPlannedShipDate(row)) {
    const reason = isWalkInOrder(row)
      ? "Planned ship date does not apply to walk-in orders."
      : "Planned ship date applies to carrier (ship) orders, not pickup or local delivery.";
    return sectionHtml(
      "Planned shipment date",
      `<p class="sg-muted" style="margin:0">${escapeHtml(reason)}</p>`,
    );
  }

  const ymd = plannedShipDateYmd(row);
  const current = ymd
    ? `<p class="sg-ship-date-current"><strong>${escapeHtml(fmtPlannedShipDateDisplay(ymd))}</strong> <span class="sg-mono sg-muted">(${escapeHtml(ymd)})</span></p>`
    : `<p class="sg-muted" style="margin:0">No planned ship date set.</p>`;

  const clearBtn = ymd
    ? `<button type="button" class="sg-btn sg-btn--ghost sg-btn--sm" data-od-clear-ship-date>Clear date</button>`
    : "";

  return sectionHtml(
    "Planned shipment date",
    `${current}
    ${plannedShipQueueHint(row)}
    <div class="sg-ship-date-actions">
      <button type="button" class="sg-btn sg-btn--primary sg-btn--sm" data-od-set-ship-date>${icon("clock", 14)}<span>${ymd ? "Change date" : "Set planned ship date"}</span></button>
      ${clearBtn}
    </div>
    <p class="sg-meta-note" style="margin:8px 0 0">Used for the shipping queue and label planning. Does not purchase a label or change fulfillment status.</p>`,
  );
}

function wirePlannedShipDateButtons(row) {
  document.querySelectorAll("[data-od-set-ship-date]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      openSetPlannedShipDateDrawer(row);
    });
  });
  document.querySelectorAll("[data-od-clear-ship-date]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      openClearPlannedShipDateDrawer(row);
    });
  });
  document.querySelectorAll("[data-od-edit-ship-to]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      openEditShipToDrawer(row);
    });
  });
  document.querySelectorAll("[data-od-edit-ship-from]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      openEditShipFromDrawer(row);
    });
  });
  document.querySelectorAll("[data-od-clear-ship-from]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      openClearShipFromDrawer(row);
    });
  });
  document.querySelectorAll("[data-od-validate-parcel]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      void runShippoParcelValidation(row);
    });
  });
  document.querySelectorAll("[data-od-shippo-sync]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      openSyncToShippoConfirmDrawer(row);
    });
  });
  document.querySelectorAll("[data-od-shippo-refresh]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      void runShippoRefreshStatus(row);
    });
  });
  document.querySelectorAll("[data-od-buy-label]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (btn.disabled) return;
      openBuyLabelConfirmDrawer(row);
    });
  });
  document.querySelectorAll("[data-od-record-external-label]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      openExternalLabelFormDrawer(row);
    });
  });
  document.querySelectorAll("[data-od-mark-shipped]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (btn.disabled) return;
      if (isOrderShipped(row)) {
        toast("Order has already been marked shipped.", "danger");
        return;
      }
      openMarkShippedConfirmDrawer(row);
    });
  });
  document.querySelectorAll("[data-od-complete-walk-in]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (btn.disabled) return;
      openCompleteWalkInConfirmDrawer(row);
    });
  });
  document.querySelectorAll("[data-od-record-payment]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (btn.disabled) return;
      openRecordPaymentFormDrawer(row);
    });
  });
  document.querySelectorAll("[data-od-send-payment-link]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (btn.disabled) return;
      openSendPaymentLinkConfirmDrawer(row);
    });
  });
  document.querySelectorAll("[data-od-copy-payment-link]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (btn.disabled) return;
      const url = btn.getAttribute("data-payment-link-url") || "";
      void copyPaymentLinkToClipboard(url);
    });
  });
  document.querySelectorAll("[data-od-buyer-notify]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (btn.disabled) return;
      openBuyerNotifyConfirmDrawer(row);
    });
  });
  wireRateSelection(row);
}

function setShipDateErr(id, msg) {
  const el = getEl(id);
  if (!el) return;
  if (msg) {
    el.textContent = msg;
    el.hidden = false;
  } else {
    el.textContent = "";
    el.hidden = true;
  }
}

/** Validate YYYY-MM-DD the same way the API does (calendar-valid). */
function parseShipmentDateInput(value) {
  const s = String(value || "").trim();
  if (!s) return { ok: false, error: "Planned ship date is required." };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return { ok: false, error: "Use a valid date (YYYY-MM-DD)." };
  const [y, mo, d] = s.split("-").map((x) => Number(x));
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) {
    return { ok: false, error: "Invalid calendar date." };
  }
  return { ok: true, value: s };
}

function openSetPlannedShipDateDrawer(row) {
  if (!canSetPlannedShipDate(row)) {
    toast("Planned ship date does not apply to this order.", "danger");
    return;
  }
  const current = plannedShipDateYmd(row);
  const ref = escapeHtml(String(row.order_ref || row.id || "—"));
  const cust = escapeHtml(String(row.customer_name || "—"));
  const prefill = current || "";

  const bodyHtml = `
    <div class="sg-info-banner">
      ${icon("info", 16)}
      <span>This ship date is used for the shipping queue and label planning. It does not purchase a label.</span>
    </div>
    <div id="psd-form">
      <div class="sg-field">
        <label for="psd-date">Planned ship date</label>
        <input class="sg-input" type="date" id="psd-date" value="${escapeHtml(prefill)}" required />
        <p class="sg-error" id="psd-date-err" hidden></p>
      </div>
      <p class="sg-meta-note" style="margin:0">Order <span class="sg-mono">${ref}</span> · ${cust}</p>
      <p class="sg-error" id="psd-server-err" role="alert" hidden></p>
      <div class="sg-drawer-actions">
        <button type="button" class="sg-btn sg-btn--ghost" id="psd-cancel">Cancel</button>
        <button type="button" class="sg-btn sg-btn--primary" id="psd-continue">Continue</button>
      </div>
    </div>
    <div id="psd-confirm" class="sg-confirm" hidden>
      <h3 class="sg-confirm__title">Save planned ship date?</h3>
      <p class="sg-confirm__copy">This updates the planned shipment date only. It does <strong>not</strong> purchase a label, notify the customer, or mark the order shipped.</p>
      <div class="sg-confirm__summary" id="psd-confirm-summary"></div>
      <p class="sg-error" id="psd-confirm-err" role="alert" hidden></p>
      <div class="sg-drawer-actions">
        <button type="button" class="sg-btn sg-btn--ghost" id="psd-back">Back</button>
        <button type="button" class="sg-btn sg-btn--primary" id="psd-confirm-btn">Confirm save date</button>
      </div>
    </div>`;

  openDrawer({ title: "Set planned ship date", bodyHtml });
  document.getElementById("sg-drawer")?.classList.remove("sg-drawer--wide");

  const formEl = getEl("psd-form");
  const confirmEl = getEl("psd-confirm");
  let pendingYmd = null;

  getEl("psd-cancel")?.addEventListener("click", () => openOrderDrawer(row));
  getEl("psd-back")?.addEventListener("click", () => {
    if (confirmEl) confirmEl.hidden = true;
    if (formEl) formEl.hidden = false;
    setShipDateErr("psd-confirm-err", "");
  });
  getEl("psd-continue")?.addEventListener("click", () => {
    setShipDateErr("psd-date-err", "");
    setShipDateErr("psd-server-err", "");
    const parsed = parseShipmentDateInput(getEl("psd-date")?.value);
    if (!parsed.ok) {
      setShipDateErr("psd-date-err", parsed.error);
      return;
    }
    if (current && parsed.value === current) {
      setShipDateErr("psd-date-err", "That date is already set. Choose a different date or cancel.");
      return;
    }
    pendingYmd = parsed.value;
    const summary = getEl("psd-confirm-summary");
    if (summary) {
      summary.innerHTML = kvHtml([
        ["Order", `<span class="sg-mono">${ref}</span>`],
        ["Customer", cust],
        ["Current planned ship date", escapeHtml(current ? fmtPlannedShipDateDisplay(current) : "Not set")],
        ["New planned ship date", `<strong>${escapeHtml(fmtPlannedShipDateDisplay(pendingYmd))}</strong> <span class="sg-mono sg-muted">(${escapeHtml(pendingYmd)})</span>`],
      ]);
    }
    if (formEl) formEl.hidden = true;
    if (confirmEl) confirmEl.hidden = false;
  });
  getEl("psd-confirm-btn")?.addEventListener("click", () => {
    if (!pendingYmd) return;
    void submitPlannedShipDate(row, pendingYmd, "set");
  });
}

function openClearPlannedShipDateDrawer(row) {
  if (!canSetPlannedShipDate(row)) {
    toast("Planned ship date does not apply to this order.", "danger");
    return;
  }
  const current = plannedShipDateYmd(row);
  if (!current) {
    toast("No planned ship date to clear.", "default");
    return;
  }
  const ref = escapeHtml(String(row.order_ref || row.id || "—"));
  const cust = escapeHtml(String(row.customer_name || "—"));

  const bodyHtml = `
    <div class="sg-confirm">
      <h3 class="sg-confirm__title">Clear planned ship date?</h3>
      <p class="sg-confirm__copy">This removes the planned shipment date from the order. It does not cancel a label or change fulfillment status.</p>
      <div class="sg-confirm__summary">
        ${kvHtml([
          ["Order", `<span class="sg-mono">${ref}</span>`],
          ["Customer", cust],
          ["Current planned ship date", `<strong>${escapeHtml(fmtPlannedShipDateDisplay(current))}</strong>`],
          ["New planned ship date", "Not set"],
        ])}
      </div>
      <p class="sg-meta-note">This does not purchase a label, notify the customer, or mark the order shipped.</p>
      <p class="sg-error" id="psd-clear-err" role="alert" hidden></p>
      <div class="sg-drawer-actions">
        <button type="button" class="sg-btn sg-btn--ghost" id="psd-clear-cancel">Cancel</button>
        <button type="button" class="sg-btn sg-btn--primary" id="psd-clear-confirm">Confirm clear date</button>
      </div>
    </div>`;

  openDrawer({ title: "Clear planned ship date", bodyHtml });
  document.getElementById("sg-drawer")?.classList.remove("sg-drawer--wide");

  getEl("psd-clear-cancel")?.addEventListener("click", () => openOrderDrawer(row));
  getEl("psd-clear-confirm")?.addEventListener("click", () => {
    void submitPlannedShipDate(row, null, "clear");
  });
}

/**
 * POST /api/admin-order-shippo-shipment-date with the exact old payload shape.
 * @param {object} row
 * @param {string|null} shipmentDate YYYY-MM-DD or null to clear
 * @param {"set"|"clear"} mode
 */
async function submitPlannedShipDate(row, shipmentDate, mode) {
  if (shipDateInFlight) return;
  shipDateInFlight = true;

  const confirmBtn = getEl(mode === "clear" ? "psd-clear-confirm" : "psd-confirm-btn");
  const cancelBtn = getEl(mode === "clear" ? "psd-clear-cancel" : "psd-back");
  const errId = mode === "clear" ? "psd-clear-err" : "psd-confirm-err";
  setShipDateErr(errId, "");
  if (confirmBtn) confirmBtn.disabled = true;
  if (cancelBtn) cancelBtn.disabled = true;

  try {
    const token = await getToken();
    if (!token) throw new Error("Sign in again to save the planned ship date.");

    const data = await fetchReportPost("/api/admin-order-shippo-shipment-date", token, {
      orderId: String(row.id),
      shipmentDate: shipmentDate || null,
    });

    // Patch local cache from the response (no optimistic update before this).
    let refreshed = row;
    if (data?.order) {
      const idx = ordersCache.findIndex((r) => String(r.id) === String(row.id));
      if (idx >= 0) ordersCache[idx] = data.order;
      refreshed = data.order;
    }

    try {
      await loadOrders();
      refreshed = ordersCache.find((r) => String(r.id) === String(row.id)) || refreshed;
    } catch {
      /* POST succeeded; list refresh is best-effort */
    }

    toast(mode === "clear" ? "Planned ship date cleared." : "Planned ship date saved.", "success");
    openOrderDrawer(refreshed);
  } catch (error) {
    const msg =
      error instanceof ReportPostError
        ? error.message
        : error?.message || (mode === "clear" ? "Could not clear planned ship date." : "Could not save planned ship date.");
    setShipDateErr(errId, msg);
    if (confirmBtn) confirmBtn.disabled = false;
    if (cancelBtn) cancelBtn.disabled = false;
  } finally {
    shipDateInFlight = false;
  }
}

/* ------------------------------------------- ship-to address edit (Phase 3B) */

function setShipToErr(id, msg) {
  const el = getEl(id);
  if (!el) return;
  if (msg) {
    el.textContent = msg;
    el.hidden = false;
  } else {
    el.textContent = "";
    el.hidden = true;
  }
}

function clearShipToFieldErrors() {
  ["sta-err-name", "sta-err-line1", "sta-err-city", "sta-err-state", "sta-err-postalCode", "sta-err-country", "sta-err-email", "sta-server-err"].forEach(
    (id) => setShipToErr(id, ""),
  );
}

/** Read form values into the exact old payload shape. */
function readShipToForm() {
  const val = (id) => String(getEl(id)?.value || "").trim();
  return {
    shippingAddress: {
      line1: val("sta-line1"),
      line2: val("sta-line2"),
      city: val("sta-city"),
      state: val("sta-state").toUpperCase(),
      postalCode: val("sta-postalCode"),
      country: val("sta-country").toUpperCase(),
    },
    shippingContact: {
      name: val("sta-name"),
      email: val("sta-email"),
      phone: val("sta-phone"),
    },
  };
}

/**
 * Client validation matching lib/orders.js updateOrderShippingAddressForAdmin.
 * @returns {{ ok: true, shippingAddress: object, shippingContact: object } | { ok: false }}
 */
function validateShipToForm() {
  clearShipToFieldErrors();
  const { shippingAddress, shippingContact } = readShipToForm();
  let ok = true;

  if (!shippingContact.name) {
    setShipToErr("sta-err-name", "Name is required.");
    ok = false;
  }
  if (!shippingAddress.line1) {
    setShipToErr("sta-err-line1", "Street address is required.");
    ok = false;
  }
  if (!shippingAddress.city) {
    setShipToErr("sta-err-city", "City is required.");
    ok = false;
  }
  if (!shippingAddress.state) {
    setShipToErr("sta-err-state", "State is required.");
    ok = false;
  } else if (!/^[A-Z]{2}$/.test(shippingAddress.state)) {
    setShipToErr("sta-err-state", "State must be a 2-letter code.");
    ok = false;
  }
  if (!shippingAddress.postalCode) {
    setShipToErr("sta-err-postalCode", "ZIP is required.");
    ok = false;
  } else if (!/^\d{5}$/.test(shippingAddress.postalCode) && !/^\d{5}-\d{4}$/.test(shippingAddress.postalCode)) {
    setShipToErr("sta-err-postalCode", "ZIP must be 5 digits or ZIP+4.");
    ok = false;
  }
  if (!shippingAddress.country) {
    setShipToErr("sta-err-country", "Country is required.");
    ok = false;
  }
  if (shippingContact.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(shippingContact.email)) {
    setShipToErr("sta-err-email", "Enter a valid email or leave blank.");
    ok = false;
  }

  if (!ok) return { ok: false };
  return { ok: true, shippingAddress, shippingContact };
}

function openEditShipToDrawer(row) {
  const eligibility = shipToEditEligibility(row);
  if (!eligibility.ok) {
    toast(eligibility.reason || "Ship-to address cannot be edited for this order.", "danger");
    return;
  }

  const addr = normalizeSavedShippingAddress(row);
  const ref = escapeHtml(String(row.order_ref || row.id || "—"));
  const cust = escapeHtml(String(row.customer_name || "—"));
  const unpaidMoneyWarn = !isPaymentPaid(row)
    ? `<div class="sg-inline-warn" style="margin-bottom:12px">${icon("alert-triangle", 14)}<span>Changing this address does not recalculate shipping, tax, or payment link amount.</span></div>`
    : "";

  const bodyHtml = `
    <div class="sg-info-banner">
      ${icon("info", 16)}
      <span>Changing the ship-to address affects future shipping label creation. This does not purchase a label, sync to Shippo, notify the customer, or mark the order shipped.</span>
    </div>
    ${unpaidMoneyWarn}
    <div id="sta-form">
      <div class="sg-addr-grid">
        <div class="sg-field sg-addr-grid__full">
          <label for="sta-name">Full name</label>
          <input class="sg-input" type="text" id="sta-name" value="${escapeHtml(addr.name || "")}" required autocomplete="name" />
          <p class="sg-error" id="sta-err-name" hidden></p>
        </div>
        <div class="sg-field">
          <label for="sta-email">Email <span class="sg-muted">(optional)</span></label>
          <input class="sg-input" type="email" id="sta-email" value="${escapeHtml(addr.email || "")}" autocomplete="email" />
          <p class="sg-error" id="sta-err-email" hidden></p>
        </div>
        <div class="sg-field">
          <label for="sta-phone">Phone <span class="sg-muted">(optional)</span></label>
          <input class="sg-input" type="tel" id="sta-phone" value="${escapeHtml(addr.phone || "")}" autocomplete="tel" />
        </div>
        <div class="sg-field sg-addr-grid__full">
          <label for="sta-line1">Street address</label>
          <input class="sg-input" type="text" id="sta-line1" value="${escapeHtml(addr.line1 || "")}" required autocomplete="address-line1" />
          <p class="sg-error" id="sta-err-line1" hidden></p>
        </div>
        <div class="sg-field sg-addr-grid__full">
          <label for="sta-line2">Apt / Suite / Line 2 <span class="sg-muted">(optional)</span></label>
          <input class="sg-input" type="text" id="sta-line2" value="${escapeHtml(addr.line2 || "")}" autocomplete="address-line2" />
        </div>
        <div class="sg-field">
          <label for="sta-city">City</label>
          <input class="sg-input" type="text" id="sta-city" value="${escapeHtml(addr.city || "")}" required autocomplete="address-level2" />
          <p class="sg-error" id="sta-err-city" hidden></p>
        </div>
        <div class="sg-field">
          <label for="sta-state">State</label>
          <input class="sg-input" type="text" id="sta-state" value="${escapeHtml(addr.state || "")}" maxlength="2" required autocomplete="address-level1" />
          <p class="sg-error" id="sta-err-state" hidden></p>
        </div>
        <div class="sg-field">
          <label for="sta-postalCode">ZIP</label>
          <input class="sg-input" type="text" id="sta-postalCode" value="${escapeHtml(addr.postalCode || "")}" required autocomplete="postal-code" />
          <p class="sg-error" id="sta-err-postalCode" hidden></p>
        </div>
        <div class="sg-field">
          <label for="sta-country">Country</label>
          <input class="sg-input" type="text" id="sta-country" value="${escapeHtml(addr.country || "")}" maxlength="2" required autocomplete="country" />
          <p class="sg-error" id="sta-err-country" hidden></p>
        </div>
      </div>
      <p class="sg-meta-note" style="margin:12px 0 0">Order <span class="sg-mono">${ref}</span> · ${cust}</p>
      <p class="sg-error" id="sta-server-err" role="alert" hidden></p>
      <div class="sg-drawer-actions">
        <button type="button" class="sg-btn sg-btn--ghost" id="sta-cancel">Cancel</button>
        <button type="button" class="sg-btn sg-btn--primary" id="sta-continue">Continue</button>
      </div>
    </div>
    <div id="sta-confirm" class="sg-confirm" hidden>
      <h3 class="sg-confirm__title">Save ship-to address?</h3>
      <p class="sg-confirm__copy">Changing the ship-to address affects future shipping label creation. This does <strong>not</strong> purchase a label, sync to Shippo, notify the customer, or mark the order shipped.</p>
      <div class="sg-confirm__summary" id="sta-confirm-summary"></div>
      <p class="sg-error" id="sta-confirm-err" role="alert" hidden></p>
      <div class="sg-drawer-actions">
        <button type="button" class="sg-btn sg-btn--ghost" id="sta-back">Back</button>
        <button type="button" class="sg-btn sg-btn--primary" id="sta-confirm-btn">Confirm save address</button>
      </div>
    </div>`;

  openDrawer({ title: "Edit ship-to address", bodyHtml });
  document.getElementById("sg-drawer")?.classList.remove("sg-drawer--wide");

  const formEl = getEl("sta-form");
  const confirmEl = getEl("sta-confirm");
  /** @type {{ shippingAddress: object, shippingContact: object } | null} */
  let pending = null;

  getEl("sta-cancel")?.addEventListener("click", () => openOrderDrawer(row));
  getEl("sta-back")?.addEventListener("click", () => {
    if (confirmEl) confirmEl.hidden = true;
    if (formEl) formEl.hidden = false;
    setShipToErr("sta-confirm-err", "");
  });
  getEl("sta-continue")?.addEventListener("click", () => {
    setShipToErr("sta-server-err", "");
    const result = validateShipToForm();
    if (!result.ok) return;
    pending = { shippingAddress: result.shippingAddress, shippingContact: result.shippingContact };
    const newAddr = {
      name: pending.shippingContact.name,
      email: pending.shippingContact.email,
      phone: pending.shippingContact.phone,
      ...pending.shippingAddress,
    };
    const summary = getEl("sta-confirm-summary");
    if (summary) {
      summary.innerHTML = kvHtml([
        ["Order", `<span class="sg-mono">${ref}</span>`],
        ["Customer", cust],
        ["Current ship-to", formatShipToBlockHtml(addr)],
        ["New ship-to", formatShipToBlockHtml(newAddr)],
      ]);
    }
    if (formEl) formEl.hidden = true;
    if (confirmEl) confirmEl.hidden = false;
  });
  getEl("sta-confirm-btn")?.addEventListener("click", () => {
    if (!pending) return;
    void submitShipToAddress(row, pending);
  });
}

async function submitShipToAddress(row, pending) {
  if (shipToInFlight || !pending) return;
  shipToInFlight = true;

  const confirmBtn = getEl("sta-confirm-btn");
  const backBtn = getEl("sta-back");
  setShipToErr("sta-confirm-err", "");
  if (confirmBtn) confirmBtn.disabled = true;
  if (backBtn) backBtn.disabled = true;

  try {
    const token = await getToken();
    if (!token) throw new Error("Sign in again to save the ship-to address.");

    const data = await fetchReportPost("/api/admin-order-update-shipping-address", token, {
      orderId: String(row.id),
      shippingAddress: pending.shippingAddress,
      shippingContact: pending.shippingContact,
    });

    let refreshed = row;
    if (data?.order) {
      const idx = ordersCache.findIndex((r) => String(r.id) === String(row.id));
      if (idx >= 0) ordersCache[idx] = data.order;
      refreshed = data.order;
    }

    try {
      await loadOrders();
      refreshed = ordersCache.find((r) => String(r.id) === String(row.id)) || refreshed;
    } catch {
      /* POST succeeded; list refresh is best-effort */
    }

    toast("Ship-to address saved.", "success");
    openOrderDrawer(refreshed);
  } catch (error) {
    let msg = error?.message || "Could not update shipping address.";
    if (error instanceof ReportPostError) {
      msg = error.message;
      const fieldErrors = error.body?.fieldErrors;
      if (fieldErrors && typeof fieldErrors === "object") {
        // Surface first field error inline on the confirm step; form fields stay on Back.
        const first = Object.values(fieldErrors).find(Boolean);
        if (first) msg = String(first);
      }
    }
    setShipToErr("sta-confirm-err", msg);
    if (confirmBtn) confirmBtn.disabled = false;
    if (backBtn) backBtn.disabled = false;
  } finally {
    shipToInFlight = false;
  }
}

/* ------------------------------------------- ship-from override (Phase 3C) */

function setShipFromErr(id, msg) {
  const el = getEl(id);
  if (!el) return;
  if (msg) {
    el.textContent = msg;
    el.hidden = false;
  } else {
    el.textContent = "";
    el.hidden = true;
  }
}

function clearShipFromFieldErrors() {
  ["sf-err-name", "sf-err-line1", "sf-err-city", "sf-err-state", "sf-err-postalCode", "sf-err-country", "sf-err-email", "sf-server-err"].forEach(
    (id) => setShipFromErr(id, ""),
  );
}

function readShipFromForm() {
  const val = (id) => String(getEl(id)?.value || "").trim();
  return {
    name: val("sf-name"),
    line1: val("sf-line1"),
    line2: val("sf-line2"),
    city: val("sf-city"),
    state: val("sf-state").toUpperCase(),
    postalCode: val("sf-postalCode"),
    country: val("sf-country").toUpperCase(),
    email: val("sf-email"),
    phone: val("sf-phone"),
  };
}

/** Client validation matching api/admin-order-fulfillment-addresses validateOverrideBlock. */
function validateShipFromForm() {
  clearShipFromFieldErrors();
  const ov = readShipFromForm();
  let ok = true;
  if (!ov.name) {
    setShipFromErr("sf-err-name", "Name is required.");
    ok = false;
  }
  if (!ov.line1) {
    setShipFromErr("sf-err-line1", "Street address is required.");
    ok = false;
  }
  if (!ov.city) {
    setShipFromErr("sf-err-city", "City is required.");
    ok = false;
  }
  if (!ov.state) {
    setShipFromErr("sf-err-state", "State is required.");
    ok = false;
  } else if (!/^[A-Z]{2}$/.test(ov.state)) {
    setShipFromErr("sf-err-state", "State must be a 2-letter code.");
    ok = false;
  }
  if (!ov.postalCode) {
    setShipFromErr("sf-err-postalCode", "ZIP is required.");
    ok = false;
  } else if (!/^\d{5}$/.test(ov.postalCode) && !/^\d{5}-\d{4}$/.test(ov.postalCode)) {
    setShipFromErr("sf-err-postalCode", "ZIP must be 5 digits or ZIP+4.");
    ok = false;
  }
  if (!ov.country) {
    setShipFromErr("sf-err-country", "Country is required.");
    ok = false;
  }
  if (ov.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ov.email)) {
    setShipFromErr("sf-err-email", "Enter a valid email or leave blank.");
    ok = false;
  }
  if (!ok) return { ok: false };
  return { ok: true, shipFromOverride: ov };
}

function currentShipFromSummaryHtml(row) {
  if (lastShipFromFormatted) {
    return `<address class="sg-address">${escapeHtml(lastShipFromFormatted).replace(/\n/g, "<br />")}</address>`;
  }
  if (hasShipFromOverride(row)) return formatOverrideAddrHtml(parseShipFromOverride(row));
  return `<span class="sg-muted">Default warehouse address</span>`;
}

function openEditShipFromDrawer(row) {
  const eligibility = shipFromEditEligibility(row);
  if (!eligibility.ok) {
    toast(eligibility.reason || "Ship-from cannot be edited for this order.", "danger");
    return;
  }

  const ov = parseShipFromOverride(row) || {};
  const ref = escapeHtml(String(row.order_ref || row.id || "—"));
  const cust = escapeHtml(String(row.customer_name || "—"));
  const hasOv = hasShipFromOverride(row);

  const bodyHtml = `
    <div class="sg-info-banner">
      ${icon("info", 16)}
      <span>Changing the ship-from address affects future shipping label creation. This does not purchase a label, sync to Shippo, notify the customer, or mark the order shipped.</span>
    </div>
    <div id="sf-form">
      <div class="sg-ship-to-actions" style="margin-bottom:12px">
        <button type="button" class="sg-btn sg-btn--ghost sg-btn--sm" id="sf-use-default">${icon("refresh-cw", 14)}<span>Use default warehouse address</span></button>
      </div>
      <div class="sg-addr-grid">
        <div class="sg-field sg-addr-grid__full">
          <label for="sf-name">Name / company</label>
          <input class="sg-input" type="text" id="sf-name" value="${escapeHtml(ov.name || "")}" required />
          <p class="sg-error" id="sf-err-name" hidden></p>
        </div>
        <div class="sg-field sg-addr-grid__full">
          <label for="sf-line1">Street address</label>
          <input class="sg-input" type="text" id="sf-line1" value="${escapeHtml(ov.line1 || "")}" required />
          <p class="sg-error" id="sf-err-line1" hidden></p>
        </div>
        <div class="sg-field sg-addr-grid__full">
          <label for="sf-line2">Apt / Suite / Line 2 <span class="sg-muted">(optional)</span></label>
          <input class="sg-input" type="text" id="sf-line2" value="${escapeHtml(ov.line2 || "")}" />
        </div>
        <div class="sg-field">
          <label for="sf-city">City</label>
          <input class="sg-input" type="text" id="sf-city" value="${escapeHtml(ov.city || "")}" required />
          <p class="sg-error" id="sf-err-city" hidden></p>
        </div>
        <div class="sg-field">
          <label for="sf-state">State</label>
          <input class="sg-input" type="text" id="sf-state" value="${escapeHtml(ov.state || "")}" maxlength="2" required />
          <p class="sg-error" id="sf-err-state" hidden></p>
        </div>
        <div class="sg-field">
          <label for="sf-postalCode">ZIP</label>
          <input class="sg-input" type="text" id="sf-postalCode" value="${escapeHtml(ov.postalCode || ov.zip || "")}" required />
          <p class="sg-error" id="sf-err-postalCode" hidden></p>
        </div>
        <div class="sg-field">
          <label for="sf-country">Country</label>
          <input class="sg-input" type="text" id="sf-country" value="${escapeHtml(ov.country || "US")}" maxlength="2" required />
          <p class="sg-error" id="sf-err-country" hidden></p>
        </div>
        <div class="sg-field">
          <label for="sf-email">Email <span class="sg-muted">(optional)</span></label>
          <input class="sg-input" type="email" id="sf-email" value="${escapeHtml(ov.email || "")}" />
          <p class="sg-error" id="sf-err-email" hidden></p>
        </div>
        <div class="sg-field">
          <label for="sf-phone">Phone <span class="sg-muted">(optional)</span></label>
          <input class="sg-input" type="tel" id="sf-phone" value="${escapeHtml(ov.phone || "")}" />
        </div>
      </div>
      <p class="sg-meta-note" style="margin:12px 0 0">Order <span class="sg-mono">${ref}</span> · ${cust}</p>
      <p class="sg-error" id="sf-server-err" role="alert" hidden></p>
      <div class="sg-drawer-actions">
        <button type="button" class="sg-btn sg-btn--ghost" id="sf-cancel">Cancel</button>
        <button type="button" class="sg-btn sg-btn--primary" id="sf-continue">Continue</button>
      </div>
    </div>
    <div id="sf-confirm" class="sg-confirm" hidden>
      <h3 class="sg-confirm__title">Save ship-from override?</h3>
      <p class="sg-confirm__copy">Changing the ship-from address affects future shipping label creation. This does <strong>not</strong> purchase a label, sync to Shippo, notify the customer, or mark the order shipped.</p>
      <div class="sg-confirm__summary" id="sf-confirm-summary"></div>
      <p class="sg-error" id="sf-confirm-err" role="alert" hidden></p>
      <div class="sg-drawer-actions">
        <button type="button" class="sg-btn sg-btn--ghost" id="sf-back">Back</button>
        <button type="button" class="sg-btn sg-btn--primary" id="sf-confirm-btn">Confirm save ship-from</button>
      </div>
    </div>`;

  openDrawer({ title: "Edit ship-from", bodyHtml });
  document.getElementById("sg-drawer")?.classList.remove("sg-drawer--wide");

  const formEl = getEl("sf-form");
  const confirmEl = getEl("sf-confirm");
  /** @type {object|null} */
  let pending = null;

  getEl("sf-cancel")?.addEventListener("click", () => openOrderDrawer(row));
  getEl("sf-use-default")?.addEventListener("click", () => {
    if (!hasOv) {
      toast("This order already uses the default warehouse address.", "default");
      return;
    }
    openClearShipFromDrawer(row);
  });
  getEl("sf-back")?.addEventListener("click", () => {
    if (confirmEl) confirmEl.hidden = true;
    if (formEl) formEl.hidden = false;
    setShipFromErr("sf-confirm-err", "");
  });
  getEl("sf-continue")?.addEventListener("click", () => {
    setShipFromErr("sf-server-err", "");
    const result = validateShipFromForm();
    if (!result.ok) return;
    pending = result.shipFromOverride;
    const summary = getEl("sf-confirm-summary");
    if (summary) {
      summary.innerHTML = kvHtml([
        ["Order", `<span class="sg-mono">${ref}</span>`],
        ["Customer", cust],
        ["Current ship-from", currentShipFromSummaryHtml(row)],
        ["New ship-from", formatOverrideAddrHtml(pending)],
      ]);
    }
    if (formEl) formEl.hidden = true;
    if (confirmEl) confirmEl.hidden = false;
  });
  getEl("sf-confirm-btn")?.addEventListener("click", () => {
    if (!pending) return;
    void submitShipFromOverride(row, pending);
  });
}

function openClearShipFromDrawer(row) {
  const eligibility = shipFromEditEligibility(row);
  if (!eligibility.ok) {
    toast(eligibility.reason || "Ship-from cannot be edited for this order.", "danger");
    return;
  }
  if (!hasShipFromOverride(row)) {
    toast("No ship-from override to clear.", "default");
    return;
  }

  const ref = escapeHtml(String(row.order_ref || row.id || "—"));
  const cust = escapeHtml(String(row.customer_name || "—"));

  const bodyHtml = `
    <div class="sg-confirm">
      <h3 class="sg-confirm__title">Clear ship-from override?</h3>
      <p class="sg-confirm__copy">This will return the order to the default warehouse ship-from address. It does not purchase or update any label.</p>
      <div class="sg-confirm__summary">
        ${kvHtml([
          ["Order", `<span class="sg-mono">${ref}</span>`],
          ["Customer", cust],
          ["Current ship-from", currentShipFromSummaryHtml(row)],
          ["New ship-from", `<span class="sg-muted">Default warehouse address</span>`],
        ])}
      </div>
      <p class="sg-error" id="sf-clear-err" role="alert" hidden></p>
      <div class="sg-drawer-actions">
        <button type="button" class="sg-btn sg-btn--ghost" id="sf-clear-cancel">Cancel</button>
        <button type="button" class="sg-btn sg-btn--primary" id="sf-clear-confirm">Confirm clear override</button>
      </div>
    </div>`;

  openDrawer({ title: "Clear ship-from override", bodyHtml });
  document.getElementById("sg-drawer")?.classList.remove("sg-drawer--wide");

  getEl("sf-clear-cancel")?.addEventListener("click", () => openOrderDrawer(row));
  getEl("sf-clear-confirm")?.addEventListener("click", () => {
    void submitShipFromOverride(row, null);
  });
}

/**
 * POST /api/admin-order-fulfillment-addresses
 * @param {object} row
 * @param {object|null} shipFromOverride object to set, or null to clear
 */
async function submitShipFromOverride(row, shipFromOverride) {
  if (shipFromInFlight) return;
  shipFromInFlight = true;

  const isClear = shipFromOverride === null;
  const confirmBtn = getEl(isClear ? "sf-clear-confirm" : "sf-confirm-btn");
  const cancelBtn = getEl(isClear ? "sf-clear-cancel" : "sf-back");
  const errId = isClear ? "sf-clear-err" : "sf-confirm-err";
  setShipFromErr(errId, "");
  if (confirmBtn) confirmBtn.disabled = true;
  if (cancelBtn) cancelBtn.disabled = true;

  try {
    const token = await getToken();
    if (!token) throw new Error("Sign in again to save the ship-from address.");

    const data = await fetchReportPost("/api/admin-order-fulfillment-addresses", token, {
      orderId: String(row.id),
      shipFromOverride,
    });

    let refreshed = row;
    if (data?.order) {
      const idx = ordersCache.findIndex((r) => String(r.id) === String(row.id));
      if (idx >= 0) ordersCache[idx] = data.order;
      refreshed = data.order;
    }

    try {
      await loadOrders();
      refreshed = ordersCache.find((r) => String(r.id) === String(row.id)) || refreshed;
    } catch {
      /* POST succeeded; list refresh is best-effort */
    }

    lastShipFromFormatted = "";
    toast(isClear ? "Ship-from override cleared." : "Ship-from override saved.", "success");
    openOrderDrawer(refreshed);
  } catch (error) {
    const msg =
      error instanceof ReportPostError
        ? error.message
        : error?.message || (isClear ? "Could not clear ship-from override." : "Could not save ship-from override.");
    setShipFromErr(errId, msg);
    if (confirmBtn) confirmBtn.disabled = false;
    if (cancelBtn) cancelBtn.disabled = false;
  } finally {
    shipFromInFlight = false;
  }
}

function openOrderDrawer(row) {
  drawerGen += 1;
  const gen = drawerGen;
  lastShipFromFormatted = "";
  const wf = computeFulfillmentWorkflow(row);
  const ref = escapeHtml(String(row.order_ref || row.id || "—"));

  const headerMeta = `<div class="sg-od-head">
    <div class="sg-od-chips">${typeChip(row)} ${paymentChip(row)} ${fulfillmentChip(wf)}</div>
    <div class="sg-od-cust">${escapeHtml(String(row.customer_name || "—"))}${row.customer_email ? ` · <span class="sg-muted">${escapeHtml(String(row.customer_email))}</span>` : ""}</div>
    <div class="sg-muted sg-cell-sub">Created ${escapeHtml(fmtDateTime(row.created_at))}</div>
  </div>`;

  const overview = sectionHtml(
    "Order overview",
    kvHtml([
      ["Order", `<span class="sg-mono">${ref}</span>`],
      ["Created", escapeHtml(fmtDateTime(row.created_at))],
      ["Type", isWalkInOrder(row) ? "Walk-in" : isManualOrder(row) ? "Manual" : "Online"],
      ["Fulfillment", escapeHtml(wf.label)],
      ["Next action", wf.nextAction ? escapeHtml(wf.nextAction) : "—"],
      ["Planned ship date", escapeHtml(plannedShipDateYmd(row) ? fmtPlannedShipDateDisplay(plannedShipDateYmd(row)) : "Not set")],
    ]),
  );

  const items = sectionHtml(
    "Items purchased",
    `<div class="sg-table-wrap"><table class="sg-table sg-table--tight">
      <thead><tr><th>Product</th><th>Size</th><th class="sg-table__num">Line total</th></tr></thead>
      <tbody>${itemRowsHtml(row.items)}</tbody></table></div>`,
  );

  const customer = sectionHtml(
    "Customer",
    kvHtml([
      ["Name", escapeHtml(String(row.customer_name || "—"))],
      ["Email", row.customer_email ? escapeHtml(String(row.customer_email)) : "—"],
      row.customer_phone ? ["Phone", escapeHtml(String(row.customer_phone))] : null,
    ]),
  );

  const shipTo = sectionHtml("Ship-to address", shipToHtml(row));
  const shipFrom = sectionHtml("Ship-from (warehouse)", shipFromSectionHtml(row));
  const plannedDate = plannedShipDateSectionHtml(row);
  const readiness = shippingReadinessSectionHtml(row);
  const workflow = shippingWorkflowSectionHtml(row);
  const availableRates = availableShippoRatesSectionHtml(row);
  const parcelValidation = parcelValidationSectionHtml(row);
  const shipping = sectionHtml("Shipping / label records", labelRecordsHtml(row));
  const externalLabel = externalLabelSectionHtml(row);
  const docs = sectionHtml("Documents", `<div id="sg-od-docs"><p class="sg-muted" style="margin:0">Loading document links…</p></div>`);
  const payment = sectionHtml("Payment details", paymentDetailsHtml(row));

  const shipped = isOrderShipped(row);
  const walkIn = isWalkInOrder(row);
  // Walk-in: no Shippo / shipping prep sections.
  // Shipped: prioritize label/tracking + docs; readiness becomes a post-ship summary.
  // Unshipped shipping orders: readiness stays before Shippo workflow.
  const mainCol = walkIn
    ? `<div class="sg-od-col sg-od-col--main">${overview}${items}${customer}${docs}${payment}</div>`
    : shipped
      ? `<div class="sg-od-col sg-od-col--main">${overview}${items}${customer}${shipTo}${shipping}${docs}${workflow}${readiness}${payment}</div>`
      : `<div class="sg-od-col sg-od-col--main">${overview}${items}${customer}${shipTo}${shipFrom}${plannedDate}${readiness}${workflow}${availableRates}${parcelValidation}${shipping}${externalLabel}${docs}${payment}</div>`;
  const sideCol = `<div class="sg-od-col sg-od-col--side">
    ${actionNeededSectionHtml(row, wf)}
    ${sectionHtml("Order total", `<p class="sg-od-total">${escapeHtml(fmtMoneyCents(row.total_cents))}</p>`)}
    ${
      walkIn
        ? ""
        : sectionHtml("Shipping summary", `<div>${shippingSummary(row)}</div>`)
    }
  </div>`;

  const bodyHtml = `${headerMeta}${stepperHtml(row)}<div class="sg-od-grid">${mainCol}${sideCol}</div>`;

  openDrawer({ title: `Order ${row.order_ref || row.id || ""}`.trim(), bodyHtml });
  const aside = document.getElementById("sg-drawer");
  if (aside) aside.classList.add("sg-drawer--wide");

  wirePlannedShipDateButtons(row);
  // Read-only helper hydration (soft-fail; never blocks the drawer).
  hydrateDrawerHelpers(row, gen);
}

async function hydrateDrawerHelpers(row, gen) {
  const orderId = String(row.id);
  let token;
  try {
    token = await getToken();
  } catch {
    token = undefined;
  }
  if (gen !== drawerGen) return;

  const sfEl = document.getElementById("sg-od-shipfrom");
  const docsEl = document.getElementById("sg-od-docs");

  if (!token) {
    if (sfEl) sfEl.innerHTML = `<p class="sg-muted" style="margin:0">Sign in to load the warehouse address.</p>`;
    if (docsEl) docsEl.innerHTML = `<p class="sg-muted" style="margin:0">Sign in to load document links.</p>`;
    return;
  }

  // Ship-from display (read-only formatter; respects override when present).
  fetchReportPost("/api/admin-order-ship-from-display", token, { orderId })
    .then((sf) => {
      if (gen !== drawerGen) return;
      const el = document.getElementById("sg-od-shipfrom");
      const formatted = String(sf?.formatted || "");
      lastShipFromFormatted = formatted;
      if (el) el.innerHTML = `<address class="sg-address">${escapeHtml(formatted).replace(/\n/g, "<br />") || "—"}</address>`;
    })
    .catch(() => {
      if (gen !== drawerGen) return;
      const el = document.getElementById("sg-od-shipfrom");
      if (el) el.innerHTML = `<div class="sg-inline-warn">${icon("alert-triangle", 14)}<span>Could not load warehouse address.</span></div>`;
    });

  // Existing fulfillment document links (read-only signed URLs; no generation).
  fetchReportPost("/api/admin-order-fulfillment-doc-links", token, { orderId })
    .then((dl) => {
      if (gen !== drawerGen) return;
      const el = document.getElementById("sg-od-docs");
      if (!el) return;
      const labelUrls = Array.isArray(dl?.labelUrls) ? dl.labelUrls.filter(Boolean) : dl?.labelUrl ? [String(dl.labelUrl)] : [];
      const slipUrls = Array.isArray(dl?.packingSlipUrls) ? dl.packingSlipUrls.filter(Boolean) : dl?.packingSlipUrl ? [String(dl.packingSlipUrl)] : [];
      const links = [];
      labelUrls.forEach((u, i) =>
        links.push(`<a class="sg-btn sg-btn--ghost sg-btn--sm" href="${escapeHtml(u)}" target="_blank" rel="noopener">${icon("package", 13)}<span>${labelUrls.length > 1 ? `Label ${i + 1}` : "Shipping label"}</span></a>`),
      );
      slipUrls.forEach((u, i) =>
        links.push(`<a class="sg-btn sg-btn--ghost sg-btn--sm" href="${escapeHtml(u)}" target="_blank" rel="noopener">${icon("receipt", 13)}<span>${slipUrls.length > 1 ? `Packing slip ${i + 1}` : "Packing slip"}</span></a>`),
      );
      el.innerHTML = links.length ? `<div class="sg-doc-links">${links.join("")}</div>` : `<p class="sg-muted" style="margin:0">No label or packing-slip files on file yet.</p>`;
    })
    .catch(() => {
      if (gen !== drawerGen) return;
      const el = document.getElementById("sg-od-docs");
      if (el) el.innerHTML = `<div class="sg-inline-warn">${icon("alert-triangle", 14)}<span>Could not load document links.</span></div>`;
    });
}

/* --------------------------------------------------------------- data load */

/** Direct Supabase reads — identical sources to the old /admin Orders page. */
async function loadOrders() {
  const page = getEl("sg-page");
  if (page && !page.dataset.loadedOnce) {
    page.innerHTML = `<div class="sg-loading">Loading orders…</div>`;
  }
  const supabase = getSupabase();
  if (!supabase) {
    if (page) page.innerHTML = `<div class="sg-error">Not signed in.</div>`;
    return;
  }

  try {
    const { data, error } = await supabase.from("orders").select("*").order("created_at", { ascending: false });
    if (error) throw new Error(error.message || "Could not load orders.");
    ordersCache = Array.isArray(data) ? data : [];

    // Batch-load per-parcel Shippo labels (read-only), same as the old page.
    labelsCache = new Map();
    const ids = ordersCache.map((r) => r.id).filter((id) => id != null && id !== "");
    for (let i = 0; i < ids.length; i += 100) {
      const slice = ids.slice(i, i + 100);
      const { data: lbls, error: lblErr } = await supabase.from("order_shippo_labels").select("*").in("order_id", slice);
      if (lblErr) break;
      for (const lab of Array.isArray(lbls) ? lbls : []) {
        const oid = String(lab.order_id);
        if (!labelsCache.has(oid)) labelsCache.set(oid, []);
        labelsCache.get(oid).push(lab);
      }
    }
    for (const arr of labelsCache.values()) {
      arr.sort((a, b) => (Number(a.parcel_index) || 0) - (Number(b.parcel_index) || 0));
    }

    renderPage();
    if (page) page.dataset.loadedOnce = "1";
    const metaEl = getEl("sg-topbar-meta");
    if (metaEl) metaEl.textContent = `Updated ${new Date().toLocaleString()}`;
  } catch (error) {
    if (page) page.innerHTML = `<div class="sg-error">${escapeHtml(error?.message || "Could not load orders.")}</div>`;
    toast(error?.message || "Could not load orders.", "danger");
  }
}

/* --------------------------------------------------------------- app boot */

bootAdminV2Page({
  activeNav: "orders",
  onEnter: async (_session, ctx) => {
    getSupabase = ctx.getSupabaseClient;
    getToken = ctx.getAccessToken;
    loadCatalog(); // best-effort, non-blocking (bundle/size display labels)
    await loadOrders();
  },
  onRefresh: () => loadOrders(),
});
