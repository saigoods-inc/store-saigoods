/*
 * SAI Goods admin-v2 — Orders page controller (Phase 10B-2A).
 *
 * Strictly READ-ONLY: list + detail viewing only.
 * Fulfillment, shipping, payment, and notification mutations stay on Legacy admin.
 *
 * Allowed network:
 *   - Supabase SELECT on public.orders and public.order_shippo_labels
 *   - GET /api/products (best-effort catalog labels)
 *   - POST /api/admin-order-ship-from-display
 *   - POST /api/admin-order-fulfillment-doc-links
 *
 * All POSTs go through fetchReadOnlyOrderPost (allowlist). Mutation endpoints are rejected.
 */

import { fetchReportPost } from "../admin-shared.js";
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
import { card, escapeHtml, icon, kpiCard, openDrawer, statusChip, toast } from "./ui.js";

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

const LEGACY_ORDERS_HREF = "/admin/orders.html";
const READ_ONLY_NOTICE =
  "Orders v2 is currently read-only. Use Legacy admin for fulfillment, shipping, payment, and notification actions.";

/* -------------------------------------------------- runtime request boundary */

export const ORDERS_V2_READ_ONLY = true;

export const READ_ONLY_ORDER_POST_ENDPOINTS = new Set([
  "/api/admin-order-ship-from-display",
  "/api/admin-order-fulfillment-doc-links",
]);

/**
 * Allowlisted POST helper for Orders v2. Rejects every other endpoint before network.
 * @param {string} endpoint
 * @param {string} token
 * @param {object} [body]
 */
export async function fetchReadOnlyOrderPost(endpoint, token, body) {
  if (!READ_ONLY_ORDER_POST_ENDPOINTS.has(endpoint)) {
    throw new Error("Orders mutations are disabled in admin v2.");
  }
  return fetchReportPost(endpoint, token, body);
}

/**
 * Atomic read of orders + package labels. Does not touch module caches.
 * Throws if the orders query or any labels batch fails.
 * @param {{ from: (table: string) => any }} supabase
 * @returns {Promise<{ orders: object[], labels: Map<string, object[]> }>}
 */
export async function fetchOrdersAndLabelsReadOnly(supabase) {
  const { data, error } = await supabase.from("orders").select("*").order("created_at", { ascending: false });
  if (error) throw new Error(error.message || "Could not load orders.");
  const nextOrders = Array.isArray(data) ? data : [];

  const nextLabels = new Map();
  const ids = nextOrders.map((r) => r.id).filter((id) => id != null && id !== "");
  for (let i = 0; i < ids.length; i += 100) {
    const slice = ids.slice(i, i + 100);
    const { data: lbls, error: lblErr } = await supabase
      .from("order_shippo_labels")
      .select("*")
      .in("order_id", slice);
    if (lblErr) throw new Error(lblErr.message || "Could not load shipping labels.");
    for (const lab of Array.isArray(lbls) ? lbls : []) {
      const oid = String(lab.order_id);
      if (!nextLabels.has(oid)) nextLabels.set(oid, []);
      nextLabels.get(oid).push(lab);
    }
  }
  for (const arr of nextLabels.values()) {
    arr.sort((a, b) => (Number(a.parcel_index) || 0) - (Number(b.parcel_index) || 0));
  }
  return { orders: nextOrders, labels: nextLabels };
}

/**
 * Paid · not shipped KPI — factual payment/fulfillment count only (no label readiness).
 * @param {object[]} orders
 */
export function countPaidNotShippedOrders(orders) {
  let n = 0;
  for (const r of orders || []) {
    if (isOrderCancelled(r)) continue;
    if (!isPaymentPaid(r)) continue;
    if (isOrderShipped(r)) continue;
    n += 1;
  }
  return n;
}

/**
 * Stepper step descriptors for list/detail (read-only display).
 * Walk-in: Order created → Payment received → Completed (no Label recorded).
 * @param {object} row
 * @returns {Array<{ label: string, state: string }>}
 */
export function buildStepperSteps(row) {
  const cancelled = isOrderCancelled(row);
  const paid = isPaymentPaid(row);
  const shipped = isOrderShipped(row);

  /** @type {Array<{ label: string, state: string }>} */
  let steps;
  if (isWalkInOrder(row)) {
    steps = [
      { label: "Order created", state: "done" },
      { label: "Payment received", state: paid ? "done" : cancelled ? "skip" : "active" },
      { label: "Completed", state: shipped ? "done" : paid && !cancelled ? "active" : "pending" },
    ];
  } else {
    const labelDone = hasLabelRecord(row);
    steps = [
      { label: "Order created", state: "done" },
      { label: "Payment received", state: paid ? "done" : cancelled ? "skip" : "active" },
      { label: "Label recorded", state: labelDone ? "done" : paid && !cancelled ? "active" : "pending" },
      { label: "Shipped", state: shipped ? "done" : "pending" },
    ];
  }

  if (cancelled) {
    for (const s of steps) if (s.state !== "done") s.state = "skip";
  }
  return steps;
}

/**
 * Main-column section keys for the order drawer (read-only layout contract).
 * Non-walk-in shipped and unshipped both include externalLabel.
 * @param {object} row
 * @returns {string[]}
 */
export function orderDrawerMainSectionKeys(row) {
  if (isWalkInOrder(row)) {
    return ["overview", "items", "customer", "docs", "payment"];
  }
  if (isOrderShipped(row)) {
    return [
      "overview",
      "items",
      "customer",
      "shipTo",
      "shipping",
      "externalLabel",
      "docs",
      "workflow",
      "readiness",
      "payment",
    ];
  }
  return [
    "overview",
    "items",
    "customer",
    "shipTo",
    "shipFrom",
    "plannedDate",
    "readiness",
    "workflow",
    "availableRates",
    "shipping",
    "externalLabel",
    "docs",
    "payment",
  ];
}

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

function fmtDateTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

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

function readOnlyBannerHtml({ compact = false } = {}) {
  const cls = compact ? "sg-info-banner sg-info-banner--compact" : "sg-info-banner";
  return `<div class="${cls}" role="status">
    ${icon("info", 16)}
    <span>${escapeHtml(READ_ONLY_NOTICE)}
      <a href="${LEGACY_ORDERS_HREF}">Open Legacy admin Orders</a>
    </span>
  </div>`;
}

/* ----------------------------------------------- catalog + line items (read) */

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

/* --------------------------------------------------------------- list UI */

function renderKpis() {
  const total = ordersCache.length;
  let awaiting = 0;
  let paidNotShipped = 0;
  let shipped = 0;
  let attention = 0;
  for (const r of ordersCache) {
    const wf = computeFulfillmentWorkflow(r);
    if (isPaymentAwaiting(r) && String(r.order_status || "") !== "cancelled") awaiting += 1;
    if (isOrderShipped(r)) shipped += 1;
    if (wf.variant === "error") attention += 1;
  }
  paidNotShipped = countPaidNotShippedOrders(ordersCache);

  const cards = [
    kpiCard({ label: "Total Orders", value: String(total), sub: "All time", iconName: "shopping-cart" }),
    kpiCard({ label: "Awaiting Payment", value: String(awaiting), sub: "Not yet paid", iconName: "clock" }),
    kpiCard({
      label: "Paid · Not Shipped",
      value: String(paidNotShipped),
      sub: "Paid orders still open",
      iconName: "package",
    }),
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
        <p class="sg-page-header__subtitle">View payment status, fulfillment stage, and shipping progress (read-only).</p>
      </div>
    </div>
    ${readOnlyBannerHtml()}
    ${renderKpis()}
    ${tableCard()}
  `;

  renderTableBody();

  getEl("sg-orders-search")?.addEventListener("input", renderTableBody);
  getEl("sg-orders-time")?.addEventListener("change", renderTableBody);
  getEl("sg-orders-status")?.addEventListener("change", renderTableBody);
  getEl("sg-orders-refresh")?.addEventListener("click", () => loadOrders());
}

/* --------------------------------------------------- detail drawer helpers */

function shippingChargedCents(row) {
  for (const f of ["quoted_shipping_amount_cents", "paid_shipping_amount_cents", "shipping_cents"]) {
    if (row?.[f] != null && Number.isFinite(Number(row[f]))) return Math.max(0, Math.round(Number(row[f])));
  }
  return null;
}

function hasLabelRecord(row) {
  if (manualFulfillmentRecordComplete(row) || orderLabelPurchased(row)) return true;
  const labels = labelsCache.get(String(row.id)) || [];
  return labels.some((l) => String(l.status || "") === "purchased");
}

function stepperHtml(row) {
  const steps = buildStepperSteps(row);
  const cancelled = isOrderCancelled(row);

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

function hasPurchasedOrExternalLabel(row) {
  if (orderLabelPurchased(row)) return true;
  if (manualFulfillmentRecordComplete(row)) return true;
  const labels = labelsCache.get(String(row.id)) || [];
  return labels.some((l) => String(l.status || "") === "purchased");
}

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
  if (!hasCore) {
    return `<div class="sg-inline-warn">${icon("alert-triangle", 14)}<span>No complete ship-to address saved yet. Edit address in Legacy admin.</span></div>
      <p class="sg-meta-note" style="margin:8px 0 0">Address editing is unavailable in this read-only release.</p>`;
  }
  return `${formatShipToBlockHtml(a)}
    <p class="sg-meta-note" style="margin:8px 0 0">Address editing is unavailable in this read-only release. Use <a href="${LEGACY_ORDERS_HREF}">Legacy admin</a> to change the ship-to address.</p>`;
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

function shipFromSectionHtml(_row) {
  const hasOv = hasShipFromOverride(_row);
  const sourceChip = hasOv
    ? statusChip("Custom override", "warning")
    : statusChip("Default warehouse", "neutral");

  return `<div class="sg-ship-from-meta" style="margin-bottom:8px">${sourceChip}</div>
    <div id="sg-od-shipfrom"><p class="sg-muted" style="margin:0">Loading warehouse address…</p></div>
    <p class="sg-meta-note" style="margin:8px 0 0">Ship-from override editing is unavailable in this read-only release. Display only — use <a href="${LEGACY_ORDERS_HREF}">Legacy admin</a> to change it.</p>`;
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
    <tbody>${rows}</tbody></table></div>
    <p class="sg-meta-note" style="margin:8px 0 0">Package-label status is display-only. Completeness here does not by itself mean the order is eligible for handoff or buyer notification.</p>`;
}

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
  return sectionHtml(
    "External label record",
    `${externalLabelRecordDisplayHtml(row)}
    <p class="sg-meta-note" style="margin:8px 0 0">Display only. Recording or uploading an external label is unavailable here. External/package labels do not unlock buyer notification from this page — use <a href="${LEGACY_ORDERS_HREF}">Legacy admin</a>.</p>`,
  );
}

function paymentLinkUrl(row) {
  return String(row?.payment_link_url || "").trim();
}

function isPaymentLinkExpired(row) {
  if (isPaymentPaid(row)) return false;
  const exp = row?.payment_link_expires_at;
  if (exp == null || exp === "") return false;
  const t = new Date(exp).getTime();
  if (!Number.isFinite(t)) return false;
  return t < Date.now();
}

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

function paymentLinkDisplayHtml(url) {
  const u = String(url || "").trim();
  if (!u) return "";
  return `<div class="sg-pay-link-display" style="margin-top:10px">
    <p class="sg-meta-note" style="margin:0 0 6px">Payment link URL (display only — sending a link is unavailable here):</p>
    <p class="sg-mono" style="margin:0 0 8px;word-break:break-all">${escapeHtml(u)}</p>
    <a class="sg-btn sg-btn--ghost sg-btn--sm" href="${escapeHtml(u)}" target="_blank" rel="noopener noreferrer">${icon("external-link", 14)}<span>Open payment link</span></a>
  </div>`;
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
    linkNotes += `<div class="sg-inline-warn" style="margin-top:10px">${icon("alert-triangle", 14)}<span>This payment link appears expired. Resend / send payment link is unavailable in this read-only release.</span></div>`;
  }
  if (showLinkBlock && linkKey === "missing") {
    linkNotes += `<div class="sg-inline-warn" style="margin-top:10px">${icon("alert-triangle", 14)}<span>Payment link status is sent, but no checkout URL is stored.</span></div>`;
  }
  if (url) linkNotes += paymentLinkDisplayHtml(url);
  linkNotes += `<p class="sg-meta-note" style="margin:10px 0 0">Record payment and send payment link are unavailable here. Use <a href="${LEGACY_ORDERS_HREF}">Legacy admin</a>.</p>`;

  return `${kvHtml(pairs)}${linkNotes}`;
}

/* ------------------------------------------- shipping readiness + Shippo display */

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

function rateCarrierLabel(r) {
  return String(r?.provider_name || r?.provider || r?.carrier || "").trim() || "—";
}

function rateParcelLabel(r) {
  if (r?.parcel != null && String(r.parcel).trim()) return String(r.parcel).trim();
  if (r?.parcel_index != null) return `Parcel ${Number(r.parcel_index) + 1}`;
  return "—";
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

function effectiveFulfillmentMethod(row) {
  if (String(row?.order_source) !== "manual") return null;
  const raw = row?.fulfillment_method;
  if (raw != null && String(raw).trim() !== "") return String(raw).trim();
  return "carrier";
}

function canShowPlannedShipDate(row) {
  if (!row) return false;
  if (isWalkInOrder(row)) return false;
  if (isManualOrder(row)) {
    const fm = effectiveFulfillmentMethod(row);
    if (fm === "pickup" || fm === "local_delivery") return false;
  }
  return true;
}

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
  if (!canShowPlannedShipDate(row)) {
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

  return sectionHtml(
    "Planned shipment date",
    `${current}
    ${plannedShipQueueHint(row)}
    <p class="sg-meta-note" style="margin:8px 0 0">Display only. Setting or clearing the planned ship date is unavailable in this read-only release. Use <a href="${LEGACY_ORDERS_HREF}">Legacy admin</a>.</p>`,
  );
}

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
  if (canShowPlannedShipDate(row)) {
    if (ymd) {
      shipDateStatus = "ok";
      shipDateDetail = fmtPlannedShipDateDisplay(ymd);
    } else {
      shipDateStatus = "optional";
      shipDateDetail = "Not set — optional for queue";
    }
  }

  let parcelStatus = "check";
  let parcelDetail = "No stored parcel plan yet";
  if (parcelLines && parcelLines.length) {
    parcelStatus = "ok";
    parcelDetail = parcelLines.join("; ");
  }

  let labelStatus = "not_started";
  let labelDetail = "No label yet";
  if (shipped) {
    labelStatus = "ok";
    labelDetail = "Order marked shipped";
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
      detail: cancelled ? "Cancelled" : paid ? "Paid" : "Unpaid — payment is separate from fulfillment status",
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
    note = "This order is cancelled. Checklist is historical context only.";
  } else if (shipped) {
    title = "Fulfillment Summary";
    headline = statusChip("Shipped", "success");
    note = "This order has been marked shipped. Label purchased and shipped are separate statuses — shipped means handoff completed.";
  } else if (ready) {
    title = "Shipping Readiness";
    headline = statusChip("Ready for label planning", "success");
    note =
      "Readiness checklist only. Shippo sync, rate refresh, preview, and label purchase are unavailable in this read-only release — use Legacy admin.";
  } else {
    title = "Shipping Readiness";
    headline = statusChip("Not ready for label planning", "warning");
    note =
      "Readiness checklist only. Shippo sync, rate refresh, preview, and label purchase are unavailable in this read-only release — use Legacy admin.";
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

function shippoSyncStatusDisplay(row) {
  const sync = String(row?.shippo_sync_status || "").trim();
  const orderId = String(row?.shippo_order_id || "").trim();
  if (sync === "syncing") return { label: "Syncing…", variant: "warning" };
  if (sync === "error" || sync === "failed") return { label: "Sync error", variant: "danger" };
  if (sync === "synced" || orderId) return { label: "Synced", variant: "success" };
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

function shippingWorkflowSectionHtml(row) {
  const syncEl = shippoSyncStatusDisplay(row);
  const rates = shippoRatesList(row);
  const hasLabel = hasPurchasedOrExternalLabel(row);
  const lastErr = String(row?.shippo_last_error || row?.shippo_sync_error || "").trim();
  const selected = String(row?.shippo_selected_rate_object_id || "").trim();

  return sectionHtml(
    "Shipping workflow (Shippo status)",
    `<div class="sg-workflow-card">
      ${kvHtml([
        ["Shippo sync", `${statusChip(syncEl.label, syncEl.variant)}${String(row.shippo_order_id || "").trim() ? ` <span class="sg-mono sg-muted" style="font-size:11px">${escapeHtml(String(row.shippo_order_id))}</span>` : ""}`],
        ["Rates stored", rates.length ? `${rates.length} available` : "None stored"],
        ["Selected rate", selected ? `<span class="sg-mono">${escapeHtml(selected)}</span>` : "—"],
        ["Label", hasLabel ? statusChip("Purchased / on file", "success") : statusChip("Not purchased", "neutral")],
        ["Tracking", escapeHtml(shippoTrackingDisplay(row))],
        ["Order shipped", isOrderShipped(row) ? statusChip("Shipped", "success") : statusChip("Not shipped", "neutral")],
      ])}
      ${lastErr ? `<div class="sg-inline-warn" style="margin-top:8px">${icon("alert-triangle", 14)}<span>${escapeHtml(lastErr)}</span></div>` : ""}
      <p class="sg-meta-note" style="margin:10px 0 0">Display only. Sync to Shippo, refresh rates/status, and validate parcel are unavailable in this read-only release. Label purchase can charge the connected Shippo account and is also unavailable here. Use <a href="${LEGACY_ORDERS_HREF}">Legacy admin</a>.</p>
    </div>`,
  );
}

function ratesTableDisplayHtml(rates) {
  if (!Array.isArray(rates) || !rates.length) {
    return `<p class="sg-muted" style="margin:0">No stored rates yet.</p>`;
  }
  const rows = rates
    .map((r) => {
      const carrier = rateCarrierLabel(r);
      const service = rateServiceLabel(r);
      const cost = formatShippoMoney(r?.amount, r?.currency);
      const eta = rateDeliveryEstimate(r);
      const parcel = rateParcelLabel(r);
      return `<tr>
        <td>${escapeHtml(carrier)}</td>
        <td>${escapeHtml(service)}</td>
        <td class="sg-table__num sg-nowrap">${escapeHtml(cost)}</td>
        <td class="sg-nowrap">${escapeHtml(eta)}</td>
        <td>${escapeHtml(parcel)}</td>
      </tr>`;
    })
    .join("");
  return `<div class="sg-table-wrap sg-workflow-rates"><table class="sg-table sg-table--tight sg-rates-table">
    <thead><tr><th>Carrier</th><th>Service</th><th class="sg-table__num">Cost</th><th>Estimated delivery</th><th>Package</th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;
}

function availableShippoRatesSectionHtml(row) {
  const rates = shippoRatesList(row);
  const body = rates.length
    ? ratesTableDisplayHtml(rates)
    : `<p class="sg-muted" style="margin:0">No stored rates yet.</p>`;
  return sectionHtml(
    "Available Shippo Rates",
    `<p class="sg-meta-note" style="margin:0 0 10px">Stored rates from prior Shippo sync/refresh — display only. Selecting a rate or buying a label is unavailable here.</p>
    ${body}`,
  );
}

/* ------------------------------------------- Action Needed (informational) */

function buildActionNeededPanel(row, wf) {
  const cancelled = isOrderCancelled(row);
  const paid = isPaymentPaid(row);
  const shipped = isOrderShipped(row);
  const walkIn = isWalkInOrder(row);
  const legacyLink = `<p style="margin:12px 0 0"><a class="sg-btn sg-btn--primary sg-btn--sm" href="${LEGACY_ORDERS_HREF}">${icon("external-link", 14)}<span>Open in Legacy admin</span></a></p>`;
  const unavailableNote = `<p class="sg-meta-note" style="margin:10px 0 0">Shippo sync/refresh/buy, mark shipped, record payment, send payment link, and buyer notification are unavailable in this read-only release.</p>`;

  if (cancelled) {
    return {
      title: "Order Cancelled",
      body: `<div class="sg-action-needed">
        <div class="sg-action-needed__head">${statusChip("Cancelled", "danger")}</div>
        <p class="sg-action-needed__copy">This order is cancelled and locked. No fulfillment actions apply.</p>
        ${legacyLink}
      </div>`,
    };
  }

  if (walkIn) {
    if (!paid) {
      return {
        title: "Walk-in Order",
        body: `<div class="sg-action-needed">
          <div class="sg-action-needed__head">${statusChip("Payment needed", "warning")}</div>
          <p class="sg-action-needed__copy">Operational next step: collect payment in person, then record it in Legacy admin. Shipping and Shippo do not apply to walk-in orders.</p>
          ${unavailableNote}
          ${legacyLink}
        </div>`,
      };
    }
    if (shipped) {
      return {
        title: "Order Completed",
        body: `<div class="sg-action-needed">
          <div class="sg-action-needed__head">${statusChip("Completed", "success")}</div>
          <p class="sg-action-needed__copy">This walk-in order has been completed (fulfilled in person). No shipping label is required.</p>
          ${legacyLink}
        </div>`,
      };
    }
    return {
      title: "Walk-in Order",
      body: `<div class="sg-action-needed">
        <div class="sg-action-needed__head">${statusChip("Paid · not completed", "info")}</div>
        <p class="sg-action-needed__copy">Operational next step: confirm physical handoff in Legacy admin. Walk-in completion is not available here.</p>
        ${unavailableNote}
        ${legacyLink}
      </div>`,
    };
  }

  const next = wf?.nextAction ? String(wf.nextAction) : "";
  const stage = wf?.label ? String(wf.label) : "—";
  let copy;
  if (!paid) {
    copy = next
      ? `Payment is still outstanding. Suggested next operational step: ${next}.`
      : "Payment is still outstanding. Complete payment before fulfillment actions.";
  } else if (shipped) {
    copy = "This order is marked shipped. Tracking and documents below are for review.";
  } else {
    copy = next
      ? `Fulfillment stage: ${stage}. Suggested next operational step: ${next}.`
      : `Fulfillment stage: ${stage}. Review shipping details, then complete actions in Legacy admin.`;
  }

  const facts = kvHtml([
    ["Payment", paid ? statusChip("Paid", "success") : statusChip("Unpaid", "warning")],
    ["Fulfillment", escapeHtml(stage)],
    ["Label purchased / on file", hasPurchasedOrExternalLabel(row) ? statusChip("Yes", "success") : statusChip("No", "neutral")],
    ["Order shipped", shipped ? statusChip("Yes", "success") : statusChip("No", "neutral")],
    next ? ["Suggested next step", escapeHtml(next)] : null,
    wf?.blockingIssue ? ["Blocking issue", escapeHtml(String(wf.blockingIssue))] : null,
  ]);

  return {
    title: "Action Needed",
    body: `<div class="sg-action-needed">
      <div class="sg-action-needed__head">${statusChip("Read-only", "info")} ${fulfillmentChip(wf)}</div>
      <p class="sg-action-needed__copy">${escapeHtml(copy)}</p>
      <div class="sg-action-needed__facts">${facts}</div>
      ${unavailableNote}
      ${legacyLink}
    </div>`,
  };
}

function actionNeededSectionHtml(row, wf) {
  const panel = buildActionNeededPanel(row, wf);
  return sectionHtml(panel.title, panel.body);
}

/* --------------------------------------------------- detail drawer */

function openOrderDrawer(row) {
  drawerGen += 1;
  const gen = drawerGen;
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
      ["Payment status", isPaymentPaid(row) ? "Paid" : "Unpaid"],
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
  const shipping = sectionHtml("Shipping / label records", labelRecordsHtml(row));
  const externalLabel = externalLabelSectionHtml(row);
  const docs = sectionHtml("Documents", `<div id="sg-od-docs"><p class="sg-muted" style="margin:0">Loading document links…</p></div>`);
  const payment = sectionHtml("Payment details", paymentDetailsHtml(row));

  const walkIn = isWalkInOrder(row);
  const sectionMap = {
    overview,
    items,
    customer,
    shipTo,
    shipFrom,
    plannedDate,
    readiness,
    workflow,
    availableRates,
    shipping,
    externalLabel,
    docs,
    payment,
  };
  const mainKeys = orderDrawerMainSectionKeys(row);
  const mainCol = `<div class="sg-od-col sg-od-col--main">${mainKeys.map((k) => sectionMap[k]).join("")}</div>`;
  const sideCol = `<div class="sg-od-col sg-od-col--side">
    ${actionNeededSectionHtml(row, wf)}
    ${sectionHtml("Order total", `<p class="sg-od-total">${escapeHtml(fmtMoneyCents(row.total_cents))}</p>`)}
    ${
      walkIn
        ? ""
        : sectionHtml("Shipping summary", `<div>${shippingSummary(row)}</div>`)
    }
  </div>`;

  const bodyHtml = `${readOnlyBannerHtml({ compact: true })}${headerMeta}${stepperHtml(row)}<div class="sg-od-grid">${mainCol}${sideCol}</div>`;

  openDrawer({ title: `Order ${row.order_ref || row.id || ""}`.trim(), bodyHtml });
  const aside = document.getElementById("sg-drawer");
  if (aside) aside.classList.add("sg-drawer--wide");

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

  fetchReadOnlyOrderPost("/api/admin-order-ship-from-display", token, { orderId })
    .then((sf) => {
      if (gen !== drawerGen) return;
      const el = document.getElementById("sg-od-shipfrom");
      const formatted = String(sf?.formatted || "");
      if (el) el.innerHTML = `<address class="sg-address">${escapeHtml(formatted).replace(/\n/g, "<br />") || "—"}</address>`;
    })
    .catch(() => {
      if (gen !== drawerGen) return;
      const el = document.getElementById("sg-od-shipfrom");
      if (el) el.innerHTML = `<div class="sg-inline-warn">${icon("alert-triangle", 14)}<span>Could not load warehouse address.</span></div>`;
    });

  fetchReadOnlyOrderPost("/api/admin-order-fulfillment-doc-links", token, { orderId })
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

async function loadOrders() {
  const page = getEl("sg-page");
  const alreadyLoaded = Boolean(page?.dataset?.loadedOnce);
  if (page && !alreadyLoaded) {
    page.innerHTML = `<div class="sg-loading">Loading orders…</div>`;
  }
  const supabase = getSupabase();
  if (!supabase) {
    if (page && !alreadyLoaded) page.innerHTML = `<div class="sg-error">Not signed in.</div>`;
    else toast("Not signed in.", "danger");
    return;
  }

  try {
    const { orders: nextOrders, labels: nextLabels } = await fetchOrdersAndLabelsReadOnly(supabase);
    // Commit only after both reads succeed — never publish a partial labels map.
    ordersCache = nextOrders;
    labelsCache = nextLabels;

    renderPage();
    if (page) page.dataset.loadedOnce = "1";
    const metaEl = getEl("sg-topbar-meta");
    if (metaEl) metaEl.textContent = `Updated ${new Date().toLocaleString()}`;
    const warn = getEl("sg-orders-refresh-warn");
    if (warn) warn.remove();
  } catch (error) {
    const message = error?.message || "Could not load orders.";
    if (!alreadyLoaded) {
      if (page) page.innerHTML = `<div class="sg-error">${escapeHtml(message)}</div>`;
      toast(message, "danger");
      return;
    }
    // Refresh failure: preserve current orders/labels/table/drawer; warn only.
    toast(message, "danger");
    if (page && !getEl("sg-orders-refresh-warn")) {
      const banner = document.createElement("div");
      banner.id = "sg-orders-refresh-warn";
      banner.className = "sg-inline-warn";
      banner.setAttribute("role", "status");
      banner.style.margin = "0 0 12px";
      banner.innerHTML = `${icon("alert-triangle", 14)}<span>${escapeHtml(message)} Showing previously loaded orders.</span>`;
      page.prepend(banner);
    }
  }
}

/* --------------------------------------------------------------- app boot */

/** Browser-only boot. Skipped under Node harness imports (read-only boundary tests). */
if (typeof document !== "undefined") {
  bootAdminV2Page({
    activeNav: "orders",
    onEnter: async (_session, ctx) => {
      getSupabase = ctx.getSupabaseClient;
      getToken = ctx.getAccessToken;
      loadCatalog();
      await loadOrders();
    },
    onRefresh: () => loadOrders(),
  });
}
