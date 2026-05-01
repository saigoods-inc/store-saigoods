import {
  clearAdminSessionUser,
  createSupabaseAdminClient,
  fetchReportPost,
  fetchSupabasePublicConfig,
  primeAdminSessionUser,
  renderAdminNav,
  ReportPostError,
  shouldBootstrapAdminSignedIn,
} from "./admin-shared.js";
import {
  FULFILLMENT_STEP_LABELS,
  canNavigateToFulfillmentTab,
  deriveActiveFulfillmentStepIndex,
  fulfillmentBlockingIssue,
  fulfillmentTabDone,
  fulfillmentVariantForRow,
  isOrderShipped,
  manualFulfillmentRecordComplete,
  orderLabelPurchased,
} from "./admin-fulfillment-workflow.js";

let supabase = null;
let ordersCache = [];
/** @type {Map<string, object[]>} order id string -> order_shippo_labels rows (sorted by parcel_index) */
let orderShippoLabelsCache = new Map();
/** When set, background Shippo refresh may re-render the open modal for this order id. */
let modalOpenOrderId = null;
/** Incremented on each modal open so async hydration cannot overwrite a newer render. */
let openModalGeneration = 0;

/** slug:bundleId -> label (from /api/products). */
const bundleLabelBySlugId = new Map();
let siteSizes = ["S", "M", "L", "XL"];

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function getShippoLabelsForOrderFromCache(orderId) {
  return orderShippoLabelsCache.get(String(orderId)) || null;
}

/** Main table Shipping column: prefer purchased per-package Shippo labels. */
function tableShippingRollupFromShippoLabels(row) {
  const labels = getShippoLabelsForOrderFromCache(row.id);
  if (!labels?.length) {
    return null;
  }
  const purchased = labels.filter((r) => String(r.status || "") === "purchased");
  if (!purchased.length) {
    return null;
  }
  const carriers = [...new Set(purchased.map((r) => String(r.carrier || "").trim()).filter(Boolean))];
  const carrierLine =
    carriers.length === 0 ? "UPS" : carriers.length === 1 ? carriers[0] : `${carriers[0]} (+${carriers.length - 1})`;
  const tracks = purchased.map((r) => String(r.tracking_number || "").trim()).filter(Boolean);
  let trackingLine = "—";
  if (tracks.length === 1) {
    trackingLine = tracks[0];
  } else if (tracks.length > 1) {
    trackingLine = `${tracks.length} labels`;
  }
  const n =
    labels[0]?.parcel_count != null && Number.isFinite(Number(labels[0].parcel_count))
      ? Math.max(0, Math.round(Number(labels[0].parcel_count)))
      : labels.length;
  const failed = labels.some((r) => String(r.status || "") === "failed");
  const allPurchased = n > 0 && purchased.length >= n && !failed;
  const note = allPurchased ? "Label purchased" : purchased.length ? "Partial labels" : "—";
  return { carrier: carrierLine, trackingLine, note };
}

/** PostgREST: filter bigint `order_id` with a number; DOM/data often provides a digit string. */
function coerceOrderIdForSupabaseFilter(orderId) {
  if (orderId == null || orderId === "") {
    return orderId;
  }
  if (typeof orderId === "number" && Number.isFinite(orderId)) {
    return orderId;
  }
  const s = String(orderId).trim();
  if (/^\d+$/.test(s)) {
    return Number(s);
  }
  return orderId;
}

function formatExternalTrackingDisplay(row) {
  const raw = String(row?.admin_external_tracking_number || "").trim();
  if (!raw) {
    return "—";
  }
  const lines = raw
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  return lines.length ? lines.join(", ") : "—";
}

function externalLabelSourceSummary(row) {
  const raw = String(row?.admin_external_label_storage_path || "").trim();
  if (!raw) {
    return row?.shippo_label_url ? "Shippo" : "—";
  }
  const n = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean).length;
  return n > 1 ? `Uploaded (${n} files)` : "Uploaded";
}

function formatTrackingListHtml(row) {
  const ext = String(row?.admin_external_tracking_number || "").trim();
  if (ext) {
    const lines = ext
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (lines.length) {
      return `<ul style="margin:0.35rem 0 0;padding-left:1.1rem;font-size:13px;line-height:1.55">${lines
        .map((l) => `<li>${escapeHtml(l)}</li>`)
        .join("")}</ul>`;
    }
  }
  const leg = String(row?.shippo_tracking_number || "").trim();
  return leg
    ? `<p style="margin:0.35rem 0 0;font-size:13px">${escapeHtml(leg)}</p>`
    : `<p class="admin-muted" style="margin:0.35rem 0 0">—</p>`;
}

function formatPaymentStatus(status) {
  if (status === "paid") return "Paid";
  if (status === "pending") return "Awaiting payment";
  return status ? String(status) : "—";
}

function formatManualInPersonMethod(m) {
  const s = String(m || "").toLowerCase();
  if (s === "cash") {
    return "Cash";
  }
  if (s === "check") {
    return "Check";
  }
  if (s === "other") {
    return "Other";
  }
  return s ? s : "—";
}

function isManualPayLaterDraftUnpaid(row) {
  return (
    String(row?.order_source) === "manual" &&
    String(row?.order_status) === "draft" &&
    String(row?.payment_flow) === "pay_later" &&
    String(row?.status || "").toLowerCase() !== "paid"
  );
}

function shippoSyncLabel(row) {
  const sync = String(row.shippo_sync_status || "pending");
  if (sync === "synced") return "Synced";
  if (sync === "syncing") return "Syncing";
  if (sync === "error") return "Sync failed";
  return "Pending sync";
}

function shippoSyncBadgeClass(row) {
  const sync = String(row.shippo_sync_status || "pending");
  if (sync === "synced") return "admin-badge admin-badge--shippo-synced";
  if (sync === "syncing") return "admin-badge admin-badge--shippo-syncing";
  if (sync === "error") return "admin-badge admin-badge--shippo-error";
  return "admin-badge admin-badge--shippo-pending";
}

function shippoShipmentLabel(row) {
  const s = String(row.shippo_shipment_status || "").trim();
  if (!s) return "—";
  return s.replace(/_/g, " ");
}

/**
 * Safe read of parcel audit JSON (handles missing columns, string JSON, bad shapes).
 */
function safeShippoParcelAuditJson(row) {
  if (!row || typeof row !== "object") {
    return null;
  }
  const v = row.shippo_parcel_audit_json;
  if (v == null) {
    return null;
  }
  if (typeof v === "object" && !Array.isArray(v)) {
    return v;
  }
  if (typeof v === "string") {
    const t = v.trim();
    if (!t) {
      return null;
    }
    try {
      const p = JSON.parse(t);
      if (p && typeof p === "object" && !Array.isArray(p)) {
        return p;
      }
    } catch {
      return null;
    }
  }
  return null;
}

function safeJsonObjectColumn(row, key) {
  if (!row || typeof row !== "object") {
    return null;
  }
  const v = row[key];
  if (v == null) {
    return null;
  }
  if (typeof v === "object" && !Array.isArray(v)) {
    return v;
  }
  if (typeof v === "string") {
    const t = v.trim();
    if (!t) {
      return null;
    }
    try {
      const p = JSON.parse(t);
      if (p && typeof p === "object" && !Array.isArray(p)) {
        return p;
      }
    } catch {
      return null;
    }
  }
  return null;
}

function safeQuotedParcelSummaryJson(row) {
  return safeJsonObjectColumn(row, "quoted_parcel_summary_json");
}

function safeQuotedAddressSnapshotJson(row) {
  return safeJsonObjectColumn(row, "quoted_address_snapshot_json");
}

function shippoParcelPieceCount(row) {
  try {
    const a = safeShippoParcelAuditJson(row);
    if (!a) {
      return null;
    }
    if (typeof a.parcelCount === "number") {
      return a.parcelCount;
    }
    if (Array.isArray(a.parcels)) {
      return a.parcels.length;
    }
    return null;
  } catch {
    return null;
  }
}

function shippoRatesList(row) {
  try {
    const raw = row?.shippo_shipment_rates_json;
    if (!raw) {
      return [];
    }
    if (Array.isArray(raw)) {
      return raw;
    }
    if (typeof raw === "object" && Array.isArray(raw.rates)) {
      return raw.rates;
    }
    return [];
  } catch {
    return [];
  }
}

function formatShippoMoney(amount, currency) {
  const n = Number(amount);
  if (!Number.isFinite(n)) {
    return "—";
  }
  const cur = String(currency || "USD").toUpperCase();
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: cur }).format(n);
  } catch {
    return `${n} ${cur}`;
  }
}

function isUpsRate(r) {
  const p = String(r?.provider || "").toUpperCase();
  return p.includes("UPS") || p === "UPS";
}

function parcelAuditSummaryLines(row) {
  try {
    const a = safeShippoParcelAuditJson(row);
    if (!a) {
      return [];
    }
    const audit = Array.isArray(a.parcels) ? a.parcels : null;
    if (audit && audit.length) {
      return audit.map((p, i) => {
        const spec = p.spec;
        if (spec) {
          return `${i + 1}. ${spec.length}×${spec.width}×${spec.height} in · ${spec.weightLb} lb`;
        }
        return `${i + 1}. (see parcel audit JSON)`;
      });
    }
    const req = Array.isArray(a.requestParcels) ? a.requestParcels : [];
    return req.map((p, i) => `${i + 1}. ${p.length}×${p.width}×${p.height} in · ${p.weight} ${p.mass_unit || "lb"}`);
  } catch {
    return [];
  }
}

function quotedParcelSummaryLines(row) {
  try {
    const q = safeQuotedParcelSummaryJson(row);
    const parcels = Array.isArray(q?.parcels) ? q.parcels : [];
    if (!parcels.length) {
      return [];
    }
    return parcels.map((p, i) => {
      const length = Number(p?.length);
      const width = Number(p?.width);
      const height = Number(p?.height);
      const distanceUnit = String(p?.distanceUnit || p?.distance_unit || "in");
      const weight = Number(p?.weight);
      const massUnit = String(p?.massUnit || p?.mass_unit || "lb");
      if (Number.isFinite(length) && Number.isFinite(width) && Number.isFinite(height) && Number.isFinite(weight)) {
        return `${i + 1}. ${length}x${width}x${height} ${distanceUnit} · ${weight} ${massUnit}`;
      }
      return `${i + 1}. (see quoted parcel snapshot)`;
    });
  } catch {
    return [];
  }
}

function formatAddressForDisplay(address) {
  if (!address || typeof address !== "object") {
    return "";
  }
  const line1 = String(address.line1 || "").trim();
  const line2 = String(address.line2 || "").trim();
  const city = String(address.city || "").trim();
  const state = String(address.state || "").trim();
  const postalCode = String(address.postalCode || address.zip || "").trim();
  const country = String(address.country || "").trim();
  const name = String(address.name || "").trim();
  const email = String(address.email || "").trim();
  const phone = String(address.phone || "").trim();
  const cityLine = [city, state, postalCode].filter(Boolean).join(", ");
  return [name, line1, line2, cityLine, country, email ? `Email: ${email}` : "", phone ? `Phone: ${phone}` : ""]
    .filter(Boolean)
    .join("\n");
}

function quotedAddressSnapshotDisplay(row) {
  const snapshot = safeQuotedAddressSnapshotJson(row);
  if (!snapshot) {
    return "—";
  }
  const normalized = formatAddressForDisplay(snapshot.normalizedAddress);
  if (normalized) {
    return normalized;
  }
  const input = formatAddressForDisplay(snapshot.inputAddress);
  if (input) {
    return input;
  }
  return "—";
}

function selectedShippoRateAmountCents(row) {
  const selectedId = String(row?.shippo_selected_rate_object_id || "").trim();
  if (!selectedId) {
    return null;
  }
  const rates = shippoRatesList(row);
  const hit = rates.find((r) => r && String(r.object_id || "").trim() === selectedId);
  if (!hit) {
    return null;
  }
  const amount = Number.parseFloat(String(hit.amount ?? ""));
  if (!Number.isFinite(amount) || amount < 0) {
    return null;
  }
  return Math.round(amount * 100);
}

/** Checkout carrier line used for “shipping charged” vs label-cost delta (prefers quoted_shipping_amount_cents). */
function quotedCarrierLineAmountCents(row) {
  if (row?.quoted_shipping_amount_cents != null && Number.isFinite(Number(row.quoted_shipping_amount_cents))) {
    return Math.max(0, Math.round(Number(row.quoted_shipping_amount_cents)));
  }
  if (row?.paid_shipping_amount_cents != null && Number.isFinite(Number(row.paid_shipping_amount_cents))) {
    return Math.max(0, Math.round(Number(row.paid_shipping_amount_cents)));
  }
  if (row?.quoted_shipping_total_cents != null && Number.isFinite(Number(row.quoted_shipping_total_cents))) {
    return Math.max(0, Math.round(Number(row.quoted_shipping_total_cents)));
  }
  if (row?.shipping_cents != null && Number.isFinite(Number(row.shipping_cents))) {
    return Math.max(0, Math.round(Number(row.shipping_cents)));
  }
  return 0;
}

function paidShippingMirrorCents(row) {
  if (row?.paid_shipping_amount_cents != null && Number.isFinite(Number(row.paid_shipping_amount_cents))) {
    return Math.max(0, Math.round(Number(row.paid_shipping_amount_cents)));
  }
  return quotedCarrierLineAmountCents(row);
}

/**
 * @returns {{ cents: number | null, source: "shippo_packages" | "admin_external" | "legacy_rate" | null }}
 */
function actualLabelSpendCents(row, labelRows) {
  if (Array.isArray(labelRows) && labelRows.length) {
    let sum = 0;
    let n = 0;
    for (const r of labelRows) {
      if (String(r.status || "") !== "purchased") {
        continue;
      }
      if (r.amount_cents != null && Number.isFinite(Number(r.amount_cents))) {
        sum += Math.max(0, Math.round(Number(r.amount_cents)));
        n += 1;
      }
    }
    if (n > 0) {
      return { cents: sum, source: "shippo_packages" };
    }
  }
  if (row?.admin_external_label_cost_cents != null && Number.isFinite(Number(row.admin_external_label_cost_cents))) {
    return { cents: Math.max(0, Math.round(Number(row.admin_external_label_cost_cents))), source: "admin_external" };
  }
  const sr = selectedShippoRateAmountCents(row);
  if (sr != null) {
    return { cents: sr, source: "legacy_rate" };
  }
  return { cents: null, source: null };
}

function buildShippingEconomyHtml(row, labelRows, fmt) {
  const quotedLine = quotedCarrierLineAmountCents(row);
  const paidMirror = paidShippingMirrorCents(row);
  const svc = String(row?.quoted_shipping_service_label || row?.quoted_shipping_service_code || row?.shippo_label_service || "—").trim();
  const { cents: actual, source } = actualLabelSpendCents(row, labelRows);
  const delta = actual != null ? quotedLine - actual : null;
  const actualLabel =
    source === "shippo_packages"
      ? "Shippo labels (sum of packages)"
      : source === "admin_external"
        ? "Recorded manually"
        : source === "legacy_rate"
          ? "Legacy single-rate quote"
          : null;
  const lines = [
    `Quoted shipping charged (checkout carrier line): ${fmt(quotedLine)}`,
    `Paid shipping (payment mirror): ${fmt(paidMirror)}`,
    `Quoted service: ${svc}`,
    actual != null
      ? `Actual label cost (${actualLabel}): ${fmt(actual)}`
      : "Actual label cost: Pending (buy labels or record manual cost on Label records)",
    delta != null ? `Shipping delta (quoted carrier line − actual label cost): ${fmt(delta)}` : "Shipping delta: Pending",
  ];
  return lines.join("\n");
}

function ymdTodayLocal() {
  const t = new Date();
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
}

/**
 * Display-only queue hint for admin (does not affect pricing).
 */
function buildPlannedShipDateQueueStatusHtml(row) {
  const ymd = String(row?.shippo_shipment_date || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) {
    return `<p class="admin-muted" data-planned-ship-queue style="margin:0.35rem 0 0;font-size:12px">No date set — optional for label date and queue.</p>`;
  }
  if (isOrderShipped(row)) {
    return `<p class="admin-muted" style="margin:0.35rem 0 0;font-size:12px">Shipped — planned date was for operations only.</p>`;
  }
  const today = ymdTodayLocal();
  if (ymd === today) {
    return `<p class="admin-planned-ship-queue admin-planned-ship-queue--today" style="margin:0.35rem 0 0;font-size:12px;font-weight:600">Ready to ship today</p>`;
  }
  if (ymd > today) {
    return `<p class="admin-planned-ship-queue" style="margin:0.35rem 0 0;font-size:12px">Scheduled to ship on ${escapeHtml(ymd)}</p>`;
  }
  return `<p class="admin-planned-ship-queue admin-planned-ship-queue--past" style="margin:0.35rem 0 0;font-size:12px">Ship date passed</p>`;
}

function buildPlannedShipDateControlHtml(row) {
  const id = escapeHtml(String(row.id));
  const raw = String(row.shippo_shipment_date || "").trim();
  const safeForDateInput = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : "";
  const valueAttr = safeForDateInput ? ` value="${escapeHtml(safeForDateInput)}"` : "";
  return `<div class="admin-planned-ship-date" data-planned-ship-date-wrap="${id}">
    <label class="admin-muted" style="display:block;font-size:12px;margin-bottom:0.25rem">Planned ship date</label>
    <div style="display:flex;flex-wrap:wrap;gap:0.45rem;align-items:center">
      <input type="date" class="admin-input-date" aria-label="Planned ship date"${valueAttr} data-shippo-shipment-date-input="${id}" />
      <button type="button" class="admin-btn admin-btn--small" data-save-shippo-shipment-date="${id}">Save</button>
      <button type="button" class="admin-btn admin-btn--small" data-clear-shippo-shipment-date="${id}">Clear</button>
    </div>
    ${buildPlannedShipDateQueueStatusHtml(row)}
    <p class="admin-muted" style="margin:0.35rem 0 0;font-size:11px;line-height:1.45">Used for label <code>shipment_date</code> and shipping queue. This does not recalculate the customer’s shipping charge.</p>
  </div>`;
}

function buildCostSummaryPanelHtml(row, labelRows, fmt) {
  const dateRaw = String(row?.shippo_shipment_date || "").trim();
  const dateLine = /^\d{4}-\d{2}-\d{2}$/.test(dateRaw) ? dateRaw : "Not set";
  const quotedLine = quotedCarrierLineAmountCents(row);
  const { cents: actual } = actualLabelSpendCents(row, labelRows);
  const delta = actual != null ? quotedLine - actual : null;
  return `<dl class="admin-order-cost-dl">
    <dt>Planned ship date</dt><dd>${escapeHtml(dateLine)}</dd>
    <dt>Quoted shipping charged</dt><dd>${escapeHtml(fmt(quotedLine))}</dd>
    <dt>Actual label cost</dt><dd>${actual != null ? escapeHtml(fmt(actual)) : "Pending"}</dd>
    <dt>Shipping delta</dt><dd>${delta != null ? escapeHtml(fmt(delta)) : "Pending"}</dd>
  </dl>`;
}

function buildTrackingRollupHtml(row, labelRows) {
  if (!Array.isArray(labelRows) || labelRows.length === 0) {
    return `<p style="margin:0;font-size:13px;line-height:1.55"><strong>Carrier (recorded)</strong> ${escapeHtml(row.admin_external_carrier || row.shippo_label_carrier || "—")}</p>
<p style="margin:0.35rem 0 0;font-size:13px;line-height:1.55"><strong>Service</strong> ${escapeHtml(row.admin_external_service || row.shippo_label_service || "—")}</p>
<p style="margin:0.5rem 0 0;font-size:13px;font-weight:600">Tracking #</p>
<div style="margin:0.25rem 0 0;font-size:13px;line-height:1.55">${formatTrackingListHtml(row)}</div>
<p style="margin:0.5rem 0 0;font-size:13px"><strong>Label source</strong> ${escapeHtml(externalLabelSourceSummary(row))}</p>`;
  }
  const inScope = labelRows.filter((r) => r.parcel_index != null);
  const purch = inScope.filter((r) => String(r.status || "") === "purchased");
  const failed = inScope.filter((r) => String(r.status || "") === "failed");
  const n =
    labelRows[0]?.parcel_count != null && Number.isFinite(Number(labelRows[0].parcel_count))
      ? Math.max(0, Math.round(Number(labelRows[0].parcel_count)))
      : inScope.length;
  if (!purch.length) {
    return `<p class="admin-muted" style="margin:0;font-size:13px">No purchased Shippo labels yet. Use <strong>Buy all labels</strong> above, or see legacy tracking below.</p>
<p style="margin:0.5rem 0 0;font-size:13px;line-height:1.55"><strong>Carrier (recorded)</strong> ${escapeHtml(row.admin_external_carrier || row.shippo_label_carrier || "—")}</p>
<div style="margin:0.35rem 0 0;font-size:13px;line-height:1.55">${formatTrackingListHtml(row)}</div>`;
  }
  const carriers = [...new Set(purch.map((r) => String(r.carrier || "").trim()).filter(Boolean))];
  const carrierLine =
    carriers.length === 0 ? "—" : carriers.length === 1 ? carriers[0] : `${carriers[0]} (+${carriers.length - 1} more)`;
  const services = [...new Set(purch.map((r) => String(r.servicelevel_name || "").trim()).filter(Boolean))];
  const serviceLine =
    services.length === 0 ? "—" : services.length === 1 ? services[0] : `${services[0]} (+${services.length - 1} variants)`;
  const tracks = purch.map((r) => String(r.tracking_number || "").trim()).filter(Boolean);
  let labelStatusText = "—";
  if (n > 0) {
    if (purch.length >= n && failed.length === 0) {
      labelStatusText = "Label purchased";
    } else if (purch.length > 0 && purch.length < n) {
      labelStatusText = failed.length ? "Partial labels (some failed)" : "Partial labels";
    } else if (purch.length > 0 && failed.length > 0) {
      labelStatusText = "Partial labels (some failed)";
    }
  }
  const trackBlock =
    tracks.length === 0
      ? `<p class="admin-muted" style="margin:0.25rem 0 0">—</p>`
      : `<div class="admin-tracking-num-list">${tracks.map((t) => `<div>${escapeHtml(t)}</div>`).join("")}</div>`;
  return `<p style="margin:0;font-size:13px;line-height:1.55"><strong>Carrier</strong> ${escapeHtml(carrierLine)}</p>
<p style="margin:0.35rem 0 0;font-size:13px;line-height:1.55"><strong>Service</strong> ${escapeHtml(serviceLine)}</p>
<p style="margin:0.5rem 0 0;font-size:13px;font-weight:600">Tracking #</p>
${trackBlock}
<p style="margin:0.5rem 0 0;font-size:13px"><strong>Label source</strong> Shippo</p>
<p style="margin:0.35rem 0 0;font-size:13px"><strong>Label status</strong> ${escapeHtml(labelStatusText)}</p>`;
}

function patchShippoMultiLabelActionButtons(row, labelRows) {
  const id = String(row.id);
  const buyBtn = document.querySelector(`[data-shippo-buy-all-labels="${id}"]`);
  const openAllBtn = document.querySelector(`[data-shippo-open-all-labels="${id}"]`);
  const list = Array.isArray(labelRows) ? labelRows : [];
  const n =
    list[0]?.parcel_count != null && Number.isFinite(Number(list[0].parcel_count))
      ? Math.max(0, Math.round(Number(list[0].parcel_count)))
      : list.length;
  const purchased = list.filter((r) => String(r.status || "") === "purchased").length;
  const failed = list.filter((r) => String(r.status || "") === "failed").length;
  const allPurchased = n > 0 && purchased === n && failed === 0;
  const diag = missingShippoAddressFields(row);
  const canBuyBase =
    String(row?.status || "").toLowerCase() === "paid" && !isOrderShipped(row) && !diag.missing.length;

  if (buyBtn) {
    if (allPurchased) {
      buyBtn.disabled = true;
      buyBtn.textContent = "Labels already purchased";
    } else {
      buyBtn.disabled = !canBuyBase;
      buyBtn.textContent = "Buy all labels";
    }
  }
  if (openAllBtn) {
    openAllBtn.textContent = "Open all labels";
    const anyPdf = list.some((r) => String(r.status || "") === "purchased" && String(r.label_url || "").trim());
    openAllBtn.disabled = !anyPdf;
  }
}

function shipmentReadyForRates(row) {
  try {
    const sid = String(row?.shippo_shipment_object_id || "").trim();
    const st = String(row?.shippo_shipment_rate_status || "");
    return Boolean(sid && st === "rates_available");
  } catch {
    return false;
  }
}

function firstPreferredRateIndex(rates) {
  if (!rates.length) {
    return 0;
  }
  const ups = rates.findIndex((r) => isUpsRate(r));
  return ups >= 0 ? ups : 0;
}

function parseCustomerAddressText(text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!lines.length) {
    return null;
  }
  let line1 = lines[0] || "";
  let line2 = "";
  let cityLine = "";
  let country = "";
  if (lines.length >= 4) {
    line2 = lines[1] || "";
    cityLine = lines[2] || "";
    country = lines[3] || "";
  } else if (lines.length === 3) {
    cityLine = lines[1] || "";
    country = lines[2] || "";
  } else if (lines.length === 2) {
    cityLine = lines[1] || "";
  }
  const m1 = cityLine.match(/^(.*?),\s*([A-Za-z]{2})\s*,\s*(\d{5}(?:-\d{4})?)$/);
  const m2 = cityLine.match(/^(.*?),\s*([A-Za-z]{2})\s+(\d{5}(?:-\d{4})?)$/);
  const m = m1 || m2;
  return {
    line1,
    line2,
    city: m ? String(m[1] || "").trim() : "",
    state: m ? String(m[2] || "").trim().toUpperCase().slice(0, 2) : "",
    postalCode: m ? String(m[3] || "").trim() : "",
    country: String(country || "").trim().toUpperCase(),
  };
}

function parseShippingAddressColumn(row) {
  const v = row?.shipping_address;
  if (v && typeof v === "object" && !Array.isArray(v)) {
    return v;
  }
  if (typeof v === "string") {
    try {
      const p = JSON.parse(v);
      if (p && typeof p === "object" && !Array.isArray(p)) {
        return p;
      }
    } catch {
      /* ignore */
    }
  }
  return {};
}

function normalizeSavedShippingAddress(row) {
  const raw = parseShippingAddressColumn(row);
  const textFallback = parseCustomerAddressText(row?.customer_address);
  const name = String(raw.name || raw.full_name || "").trim() || String(row?.customer_name || "").trim();
  const email = String(raw.email || "").trim() || String(row?.customer_email || "").trim();
  const phone = String(raw.phone || "").trim() || String(row?.customer_phone || "").trim();
  const line1 = String(raw.line1 || raw.street1 || raw.address_line_1 || "").trim() || String(textFallback?.line1 || "").trim();
  const line2 = String(raw.line2 || raw.street2 || raw.address_line_2 || "").trim() || String(textFallback?.line2 || "").trim();
  const city = String(raw.city || raw.locality || "").trim() || String(textFallback?.city || "").trim();
  const state =
    String(raw.state || raw.province || raw.region || raw.administrative_district_level_1 || "")
      .trim()
      .toUpperCase()
      .slice(0, 2) || String(textFallback?.state || "").trim().toUpperCase().slice(0, 2);
  const postalCode =
    String(raw.postalCode || raw.zip || raw.zip_code || raw.postal_code || "").trim() || String(textFallback?.postalCode || "").trim();
  const country = String(raw.country || raw.country_code || "").trim().toUpperCase() || String(textFallback?.country || "").trim().toUpperCase();
  return { name, email, phone, line1, line2, city, state, postalCode, country };
}

function missingShippoAddressFields(row) {
  const addr = normalizeSavedShippingAddress(row);
  const missing = [];
  if (!addr.name) missing.push("shipping name");
  if (!addr.line1) missing.push("shipping street");
  if (!addr.city) missing.push("city");
  if (!addr.state) missing.push("state");
  if (!addr.postalCode) missing.push("ZIP");
  if (!addr.country) missing.push("country");
  return { addr, missing };
}

/** Read-only merged ship-to text (same merge as Shippo; for modal display). */
function formatMergedShipToDisplay(row) {
  const addr = normalizeSavedShippingAddress(row);
  const lines = [];
  if (addr.name) {
    lines.push(addr.name);
  }
  const street = [addr.line1, addr.line2].filter(Boolean).join(", ");
  if (street) {
    lines.push(street);
  }
  const cityLine = [addr.city, addr.state, addr.postalCode].filter(Boolean).join(", ");
  if (cityLine) {
    lines.push(cityLine);
  }
  if (addr.country) {
    lines.push(addr.country);
  }
  if (addr.email) {
    lines.push(`Email: ${addr.email}`);
  }
  if (addr.phone) {
    lines.push(`Phone: ${addr.phone}`);
  }
  const text = lines.join("\n").trim();
  if (text) {
    return text;
  }
  const ca = String(row.customer_address || "").trim();
  return ca || "—";
}

function labelPurchasedSuccessfully(row) {
  return orderLabelPurchased(row);
}

function isTrackingDelivered(row) {
  return String(row?.shippo_tracking_status || "").toUpperCase() === "DELIVERED";
}

function isTrackingInTransit(row) {
  const t = String(row?.shippo_tracking_status || "").toUpperCase();
  if (!t || t === "UNKNOWN" || t === "PRE_TRANSIT" || t === "DELIVERED") {
    return false;
  }
  if (["TRANSIT", "IN_TRANSIT", "OUT_FOR_DELIVERY"].includes(t)) {
    return true;
  }
  return t.includes("TRANSIT");
}

/**
 * Single derived workflow for table, modal, and filters (external fulfillment; legacy Shippo data ignored for stage labels).
 * @returns {{ key: string, label: string, nextAction: string, activeStepIndex: number, blockingIssue: string | null, variant: "default" | "error" | "cancelled" }}
 */
function computeFulfillmentWorkflow(row) {
  const base = (patch) => ({
    key: "unknown",
    label: "Unknown",
    nextAction: "View details",
    activeStepIndex: 0,
    blockingIssue: null,
    variant: "default",
    ...patch,
  });

  const os = String(row?.order_status || "");
  if (os === "cancelled") {
    return base({
      key: "cancelled",
      label: "Cancelled",
      nextAction: "—",
      activeStepIndex: -1,
      variant: "cancelled",
    });
  }

  if (isWalkInOrder(row) && os === "draft") {
    return base({
      key: "walk_in_draft",
      label: "Walk-in draft (unpaid)",
      nextAction: "Complete walk-in",
      activeStepIndex: 0,
    });
  }
  if (String(row?.order_source) === "manual" && os === "draft") {
    const isPayLater = String(row?.payment_flow || "") === "pay_later";
    return base({
      key: isPayLater ? "manual_pay_later" : "manual_draft",
      label: isPayLater ? "Pay later (unpaid)" : "Manual draft",
      nextAction: isPayLater ? "Record payment when received" : "Email payment link",
      activeStepIndex: 0,
    });
  }
  if (String(row?.order_source) === "manual" && os === "payment_link_sent") {
    return base({
      key: "payment_link_sent",
      label: "Payment link sent",
      nextAction: "Await payment",
      activeStepIndex: 0,
    });
  }

  const paymentPaid = String(row?.status || "").toLowerCase() === "paid";
  if (!paymentPaid) {
    return base({
      key: "awaiting_payment",
      label: "Awaiting payment",
      nextAction: "Await payment",
      activeStepIndex: 0,
    });
  }

  if (row.shippo_label_required === false) {
    return base({
      key: "no_carrier_label",
      label: "Paid · pickup or local",
      nextAction: "Hand off or deliver — no Shippo label",
      activeStepIndex: 0,
    });
  }

  const missing = missingShippoAddressFields(row).missing;
  if (missing.length > 0) {
    return base({
      key: "address_required",
      label: "Paid · ship-to incomplete",
      nextAction: "Complete ship-to in details",
      activeStepIndex: 0,
      blockingIssue: `Missing: ${missing.join(", ")}`,
      variant: "error",
    });
  }

  if (os === "partial_label_purchase") {
    return base({
      key: "partial_shippo_labels",
      label: "Paid · partial Shippo labels",
      nextAction: "Open order details and finish failed packages",
      activeStepIndex: 0,
      variant: "error",
      blockingIssue: "Not all per-package Shippo labels were purchased. Use Retry on failed rows or Buy all labels again (skips already purchased).",
    });
  }

  if (isOrderShipped(row)) {
    if (isTrackingDelivered(row)) {
      return base({
        key: "delivered",
        label: "Delivered",
        nextAction: "—",
        activeStepIndex: 1,
      });
    }
    if (isTrackingInTransit(row)) {
      return base({
        key: "in_transit",
        label: "In transit",
        nextAction: "Track package",
        activeStepIndex: 1,
      });
    }
    return base({
      key: "shipped",
      label: "Shipped",
      nextAction: "—",
      activeStepIndex: 1,
    });
  }

  if (!manualFulfillmentRecordComplete(row)) {
    return base({
      key: "need_label_records",
      label: "Paid · record shipment",
      nextAction: "",
      activeStepIndex: 0,
    });
  }

  return base({
    key: "ready_mark_shipped",
    label: "Ready to mark shipped",
    nextAction: "Confirm shipped",
    activeStepIndex: 1,
    blockingIssue: fulfillmentBlockingIssue(row),
    variant: fulfillmentVariantForRow(row),
  });
}

/**
 * Clickable 2-step fulfillment stepper.
 * @param {number} [selectedTab] 0–1
 */
function buildFulfillmentProgressHtml(row, selectedTab = 0) {
  const wf = computeFulfillmentWorkflow(row);
  if (wf.variant === "cancelled") {
    return `<div class="admin-fulfillment-progress admin-fulfillment-progress--cancelled" role="status">
      <p class="admin-fulfillment-progress__title">Fulfillment</p>
      <p class="admin-muted" style="margin:0;font-size:13px">This order is <strong>cancelled</strong>.</p>
    </div>`;
  }

  const paymentPaid = String(row?.status || "").toLowerCase() === "paid";
  if (!paymentPaid) {
    return `<div class="admin-fulfillment-progress admin-fulfillment-progress--ok" role="status">
      <p class="admin-fulfillment-progress__title">Fulfillment</p>
      <p class="admin-muted" style="margin:0;font-size:13px">Fulfillment steps unlock after payment.</p>
    </div>`;
  }

  const sel = Math.min(Math.max(Number.isFinite(selectedTab) ? selectedTab : 0, 0), 1);
  const err = wf.variant === "error";
  const activeIdx = deriveActiveFulfillmentStepIndex(row);

  const chunks = [
    `<div class="admin-fulfillment-progress admin-fulfillment-progress--${err ? "has-error" : "ok"}" aria-label="Fulfillment progress">`,
    `<p class="admin-fulfillment-progress__title">Fulfillment</p>`,
    `<div class="admin-fulfillment-progress__tabs" role="tablist" aria-label="Fulfillment steps">`,
  ];
  for (let i = 0; i < FULFILLMENT_STEP_LABELS.length; i++) {
    const canNav = canNavigateToFulfillmentTab(row, i);
    const done = fulfillmentTabDone(row, i);
    const isSel = i === sel;
    let st = "pending";
    if (!canNav) {
      st = "locked";
    } else if (isSel) {
      st = err && i === activeIdx ? "error" : "active";
    } else if (done) {
      st = "done";
    }
    const dot = st === "done" ? "✓" : st === "error" ? "!" : st === "locked" ? "·" : String(i + 1);
    const disabled = canNav ? "" : ` disabled aria-disabled="true"`;
    const cls = canNav ? "admin-fulfillment-tab" : "admin-fulfillment-tab admin-fulfillment-tab--locked";
    chunks.push(
      `<button type="button" role="tab" class="${cls} admin-fulfillment-tab--${st}" data-fulfillment-tab="${i}" aria-selected="${isSel ? "true" : "false"}"${disabled}>` +
        `<span class="admin-fulfillment-tab__dot" aria-hidden="true">${dot}</span>` +
        `<span class="admin-fulfillment-tab__label">${escapeHtml(FULFILLMENT_STEP_LABELS[i])}</span>` +
        `</button>`,
    );
  }
  chunks.push(`</div></div>`);
  return chunks.join("");
}

/** First-time push to Shippo (creates order + shipment on server). */
function canShippoTableFirstSync(row) {
  const paid = String(row.status || "").toLowerCase() === "paid";
  const isSyncing = String(row.shippo_sync_status || "") === "syncing";
  const hasShippoOrder = Boolean(String(row.shippo_order_id || "").trim());
  const { missing } = missingShippoAddressFields(row);
  return paid && !isSyncing && !hasShippoOrder && missing.length === 0;
}

/** Read-only re-fetch of Shippo order/shipment/transaction (GET only; no new shipment). */
function canShippoTableRefreshRemote(row) {
  const paid = String(row.status || "").toLowerCase() === "paid";
  const isSyncing = String(row.shippo_sync_status || "") === "syncing";
  const hasShippoOrder = Boolean(String(row.shippo_order_id || "").trim());
  return paid && !isSyncing && hasShippoOrder;
}

function formatDate(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  } catch {
    return "—";
  }
}

function jsonPrettyOrNull(value) {
  if (value === undefined || value === null) {
    return "null";
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

async function loadShippoPreviewPanel(orderId) {
  const panel = document.getElementById("admin-shippo-preview-panel");
  if (!panel || !supabase) {
    return;
  }
  panel.innerHTML = `<p class="admin-muted">Loading server preview…</p>`;
  try {
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session?.access_token) {
      panel.innerHTML = `<p class="admin-error">Not signed in.</p>`;
      return;
    }
    const data = await fetchReportPost("/api/admin-order-shippo-preview", session.access_token, { orderId });
    const preview = data.preview;
    if (!preview) {
      panel.innerHTML = `<p class="admin-muted">No preview.</p>`;
      return;
    }
    const audit = safeShippoParcelAuditJson(data.order);
    const lastStoredReq = audit?.lastShipmentCreateRequest;
    const lastStoredAt = audit?.lastShipmentCreateRequestAt;
    const lastStoredBlock = lastStoredReq
      ? `<details class="admin-modal-details">
        <summary class="admin-muted">Last stored Shipment POST body (DB, last create attempt)</summary>
        <p class="admin-muted" style="margin:0 0 0.35rem;font-size:12px;line-height:1.45">Saved at <code>${escapeHtml(
          lastStoredAt || "—",
        )}</code>. Compare to <strong>Shippo Shipment API payload</strong> above (live preview from current order row).</p>
        <pre>${escapeHtml(jsonPrettyOrNull(lastStoredReq))}</pre>
      </details>`
      : `<p class="admin-muted" style="margin:0.35rem 0 0;font-size:12px;line-height:1.45">No <code>lastShipmentCreateRequest</code> in DB yet — it is written when the server POSTs <code>/shipments/</code> (success or HTTP error).</p>`;
    const orderPayload = preview.orderPayload ?? preview.payload;
    const orderPayloadBlock = orderPayload
      ? escapeHtml(jsonPrettyOrNull(orderPayload))
      : escapeHtml(preview.payloadError || "Could not build order payload.");
    const shipmentPayloadBlock = preview.shipmentCreatePayload
      ? escapeHtml(jsonPrettyOrNull(preview.shipmentCreatePayload))
      : escapeHtml(preview.shipmentCreatePayloadError || "—");
    panel.innerHTML = `
      <h4 class="admin-muted" style="margin:0 0 0.35rem;font-size:13px">Server preview (same merge as Shippo sync — no live API calls)</h4>
      <details class="admin-modal-details" open>
        <summary class="admin-muted">Resolved shipping for sync</summary>
        <pre>${escapeHtml(jsonPrettyOrNull(preview.resolvedShippingForSync))}</pre>
      </details>
      <details class="admin-modal-details">
        <summary class="admin-muted">Raw <code>shipping_address</code> from DB (parsed)</summary>
        <pre>${escapeHtml(jsonPrettyOrNull(preview.rawShippingAddressFromDb))}</pre>
      </details>
      <details class="admin-modal-details">
        <summary class="admin-muted">Line items (weight / qty)</summary>
        <pre>${escapeHtml(jsonPrettyOrNull(preview.lineItems))}</pre>
      </details>
      <details class="admin-modal-details">
        <summary class="admin-muted">Shippo Order API payload (POST /orders/)</summary>
        <p class="admin-muted" style="margin:0 0 0.35rem;font-size:12px;line-height:1.45">Order object: line items, totals, aggregate <code>weight</code>. Does not include per-parcel dimensions.</p>
        <pre>${orderPayloadBlock}</pre>
      </details>
      <details class="admin-modal-details">
        <summary class="admin-muted">Shippo Shipment API payload (POST /shipments/)</summary>
        <p class="admin-muted" style="margin:0 0 0.35rem;font-size:12px;line-height:1.45">Shipment object: <code>address_from</code>, <code>address_to</code>, and <code>parcels</code> (length, width, height, <code>distance_unit</code>, weight, <code>mass_unit</code>) used for rates and labels.</p>
        <pre>${shipmentPayloadBlock}</pre>
      </details>
      <details class="admin-modal-details">
        <summary class="admin-muted">Parcel plan (for Shipment / rates)</summary>
        <pre>${
          preview.parcelPlan
            ? escapeHtml(jsonPrettyOrNull(preview.parcelPlan))
            : escapeHtml(preview.parcelError || "—")
        }</pre>
      </details>
      ${lastStoredBlock}
    `;
  } catch (e) {
    panel.innerHTML = `<p class="admin-error">${escapeHtml(e.message || "Preview failed.")}</p>`;
  }
}

function startOfLocalDayMs(ref = Date.now()) {
  const d = new Date(ref);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Monday-start week containing `ref`. */
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
  if (!filter || filter === "all") {
    return true;
  }
  const t = new Date(row.created_at).getTime();
  if (!Number.isFinite(t)) {
    return true;
  }
  if (filter === "today") {
    return t >= startOfLocalDayMs();
  }
  if (filter === "week") {
    return t >= startOfLocalWeekMondayMs();
  }
  if (filter === "month") {
    return t >= startOfLocalMonthMs();
  }
  return true;
}

function updateTimeFilterLabels() {
  const sel = document.getElementById("filter-time");
  if (!sel) {
    return;
  }
  const total = ordersCache.length;
  const nToday = ordersCache.filter((r) => passesTimeFilter(r, "today")).length;
  const nWeek = ordersCache.filter((r) => passesTimeFilter(r, "week")).length;
  const nMonth = ordersCache.filter((r) => passesTimeFilter(r, "month")).length;
  for (const opt of sel.options) {
    const v = opt.value;
    if (v === "all") {
      opt.textContent = `All dates (${total})`;
    } else if (v === "today") {
      opt.textContent = `Today (${nToday})`;
    } else if (v === "week") {
      opt.textContent = `This week (${nWeek})`;
    } else if (v === "month") {
      opt.textContent = `This month (${nMonth})`;
    }
  }
}

/** True if payment is not complete — staff cannot set fulfillment yet. */
function isPaymentAwaiting(row) {
  return String(row.status || "").toLowerCase() !== "paid";
}

function isWalkInOrder(row) {
  return String(row.order_type || "") === "walk_in" || String(row.order_source || "") === "walk_in";
}

function isManualOrder(row) {
  return String(row?.order_source || "") === "manual" || String(row?.order_type || "") === "manual";
}

function isOnlineOrder(row) {
  return !isWalkInOrder(row) && !isManualOrder(row);
}

function isOrderPaid(row) {
  return String(row?.status || "").toLowerCase() === "paid";
}

function isPickupOrLocal(row) {
  if (!isManualOrder(row)) {
    return false;
  }
  const m = effectiveFulfillmentMethodForDisplay(row);
  return m === "pickup" || m === "local_delivery";
}

function isCarrierFulfillment(row) {
  return isManualOrder(row) && effectiveFulfillmentMethodForDisplay(row) === "carrier";
}

/** Online always shows Shippo; manual carrier only after paid; walk-in/pickup/local never. */
function shouldShowShippoSections(row) {
  if (isOnlineOrder(row)) {
    return true;
  }
  return isCarrierFulfillment(row) && isOrderPaid(row);
}

/** Existing modal record-payment flow is only for manual pay-later draft unpaid orders. */
function shouldShowRecordPayment(row) {
  return isManualPayLaterDraftUnpaid(row);
}

/** Walk-in + manual non-Shippo experience (or unpaid manual carrier gate). */
function shouldUseNonShippoDetailsModal(row) {
  return isWalkInOrder(row) || isPickupOrLocal(row) || (isCarrierFulfillment(row) && !isOrderPaid(row));
}

function renderNonShippoDetailsModalHtml(row, itemLines, fmt) {
  const orderRef = escapeHtml(row.order_ref || "Order");
  const orderId = escapeHtml(String(row.id || "—"));
  const customerName = escapeHtml(row.customer_name || "—");
  const customerEmail = escapeHtml(row.customer_email || "—");
  const customerPhone = escapeHtml(row.customer_phone || "—");
  const paymentLabel = escapeHtml(formatPaymentColumnLabel(row));
  const paymentMethodRaw = formatManualInPersonMethod(row.payment_method || row.manual_payment_method || "");
  const paymentMethod = escapeHtml(paymentMethodRaw === "—" ? "Not recorded" : paymentMethodRaw);
  const lifecycle = buildManualOrderLifecycleModalHtml(row);
  const paymentLinkMeta = buildManualPaymentLinkMetaModalHtml(row);
  const itemHtml = itemLines.length ? itemLines.map((l) => l.html).join("") : `<p class="admin-muted">—</p>`;
  const isWalkIn = isWalkInOrder(row);
  const paid = isOrderPaid(row);
  const showRecord = shouldShowRecordPayment(row);
  const fulfillmentLabel = isWalkIn ? "Walk-in POS" : escapeHtml(formatFulfillmentMethodLabelForManual(row));
  const statusLine = escapeHtml(String(row.order_status || "—"));
  const shipToSnapshot = escapeHtml(formatMergedShipToDisplay(row));
  const showShipTo = isCarrierFulfillment(row) && !paid;
  const sourceLabel = isWalkIn ? "Walk-in" : "Manual";
  const paymentStatePill = paid
    ? `<span class="admin-badge admin-badge--paid">Paid</span>`
    : `<span class="admin-badge admin-badge--awaiting_payment">Unpaid</span>`;
  const fulfillmentStateLabel = paid
    ? isWalkIn
      ? "Paid at POS"
      : "Ready for fulfillment"
    : "Awaiting payment";
  const inventoryLine = row.inventoryWarning
    ? `<dt>Inventory</dt><dd>${escapeHtml(String(row.inventoryWarning))}</dd>`
    : "";
  const receiptLine = row.admin_buyer_notify_sent_at
    ? `<dt>Receipt</dt><dd>Sent ${escapeHtml(formatDate(row.admin_buyer_notify_sent_at))}</dd>`
    : "";

  return `
    <h2>${orderRef}</h2>
    <div class="admin-modal__section admin-modal__section--non-shippo">
      <section class="admin-order-mini-card">
        <h3 class="admin-order-detail-section__title">Order</h3>
        <div class="admin-order-mini-card__head">
          <div class="admin-order-mini-card__id-block">
            <div class="admin-order-mini-card__ref">${orderRef}</div>
            <div class="admin-order-mini-card__id">ID: ${orderId}</div>
          </div>
          <div class="admin-order-mini-card__pills">
            <span class="admin-order-tag admin-order-tag--inline">${sourceLabel}</span>
            ${paymentStatePill}
          </div>
        </div>
        <dl class="admin-order-dl">
          <dt>Status</dt><dd>${statusLine}</dd>
          <dt>Fulfillment</dt><dd>${fulfillmentLabel}</dd>
        </dl>
      </section>

      ${
        isCarrierFulfillment(row) && !isWalkIn
          ? `<section class="admin-order-mini-card">
        <h3 class="admin-order-detail-section__title">Planned shipment</h3>
        ${buildPlannedShipDateControlHtml(row)}
        <p class="admin-muted" style="margin:0.5rem 0 0;font-size:12px;line-height:1.45">After payment, use <strong>Sync to Shippo</strong> in the full shipping view to apply this date to new shipments.</p>
      </section>`
          : ""
      }

      <section class="admin-order-mini-card">
        <h3 class="admin-order-detail-section__title">Customer</h3>
        <dl class="admin-order-dl">
          <dt>Name</dt><dd>${customerName}</dd>
          <dt>Email</dt><dd>${customerEmail}</dd>
          <dt>Phone</dt><dd>${customerPhone}</dd>
        </dl>
      </section>

      <section class="admin-order-mini-card">
        <h3 class="admin-order-detail-section__title">Items Purchased</h3>
        <div class="admin-modal__line-items admin-modal__line-items--cards">${itemHtml}</div>
      </section>

      <section class="admin-order-mini-card">
        <h3 class="admin-order-detail-section__title">Payment</h3>
        <dl class="admin-order-dl">
          <dt>Summary</dt><dd>${paymentLabel}</dd>
          <dt>Method</dt><dd>${paymentMethod}</dd>
          <dt>Merchandise</dt><dd>${escapeHtml(fmt(row.subtotal_cents))}</dd>
          <dt>Tax</dt><dd>${escapeHtml(fmt(row.tax_cents))}</dd>
          <dt>Total</dt><dd>${escapeHtml(fmt(row.total_cents))}</dd>
          <dt>${paid ? "Total paid" : "Balance due"}</dt><dd>${escapeHtml(fmt(row.total_cents))}</dd>
        </dl>
        ${lifecycle}
        ${paymentLinkMeta}
        ${
          showRecord
            ? `<div class="admin-order-mini-card__actions">
          <button type="button" class="admin-btn admin-btn--primary" data-record-payment-modal="${escapeHtml(String(row.id))}">Record payment</button>
        </div>`
            : ""
        }
      </section>

      ${
        showShipTo
          ? `<section class="admin-order-mini-card">
        <h3 class="admin-order-detail-section__title">Shipping address snapshot</h3>
        <pre class="admin-address-card admin-address-card--plain">${shipToSnapshot}</pre>
      </section>`
          : ""
      }

      <section class="admin-order-mini-card">
        <h3 class="admin-order-detail-section__title">${isWalkIn ? "POS notes / status" : "Fulfillment status"}</h3>
        <dl class="admin-order-dl">
          <dt>Current state</dt><dd>${fulfillmentStateLabel}</dd>
          ${inventoryLine}
          ${receiptLine}
          ${
            row.manual_payment_note
              ? `<dt>Notes</dt><dd>${escapeHtml(String(row.manual_payment_note))}</dd>`
              : `<dt>Notes</dt><dd>—</dd>`
          }
        </dl>
      </section>
    </div>
  `;
}

function applyWorkflowRowTheme(tr, row) {
  if (!tr || !row) {
    return;
  }
  const wf = computeFulfillmentWorkflow(row);
  tr.classList.toggle("admin-order-row--delivered", wf.key === "delivered");
  tr.classList.toggle("admin-order-row--in-transit", wf.key === "in_transit");
  tr.classList.toggle("admin-order-row--cancelled", wf.key === "cancelled");
  tr.classList.toggle("admin-order-row--issue", wf.variant === "error");
  tr.classList.toggle("admin-order-row--handoff", Boolean(row?.admin_handoff_at) || String(row?.order_status || "") === "shipped");
}

function paymentBadgeKey(row) {
  if (String(row.status || "").toLowerCase() === "paid") {
    return "paid";
  }
  if (
    row.order_status === "payment_link_sent" ||
    (row.order_source === "manual" && row.order_status === "draft") ||
    (isWalkInOrder(row) && row.order_status === "draft")
  ) {
    return "awaiting_payment";
  }
  return "awaiting_payment";
}

function formatPaymentColumnLabel(row) {
  if (isWalkInOrder(row)) {
    if (row.order_status === "draft") {
      return "Draft (unpaid)";
    }
    if (String(row.status || "").toLowerCase() === "paid" && row.payment_method) {
      return `Paid (${formatManualInPersonMethod(row.payment_method)})`;
    }
  }
  if (String(row.order_source) === "manual") {
    if (String(row.status || "").toLowerCase() === "paid" && row.payment_method) {
      return `Paid (${formatManualInPersonMethod(row.payment_method)})`;
    }
    if (row.order_status === "draft" && String(row.payment_flow) === "pay_later") {
      return "Pay later (unpaid)";
    }
    if (row.order_status === "draft") {
      return "Draft";
    }
    if (row.order_status === "payment_link_sent") {
      return "Payment link sent";
    }
  }
  return formatPaymentStatus(row.status);
}

function shouldShowManualPaymentLinkMeta(row) {
  if (String(row?.order_source) !== "manual") {
    return false;
  }
  const os = String(row?.order_status || "");
  return os === "draft" || os === "payment_link_sent";
}

/** Unpaid and past stored expiry — display-only badge, no enforcement. */
function isUnpaidPaymentLinkPastExpiry(row) {
  if (String(row?.status || "").toLowerCase() === "paid") {
    return false;
  }
  const exp = row?.payment_link_expires_at;
  if (exp == null || exp === "") {
    return false;
  }
  const t = new Date(exp).getTime();
  if (!Number.isFinite(t)) {
    return false;
  }
  return t < Date.now();
}

/**
 * For manual rows: `payment_flow` from DB, or legacy inference when a link was stored before the column existed.
 */
function effectivePaymentFlowForDisplay(row) {
  if (String(row?.order_source) !== "manual") {
    return null;
  }
  const raw = row?.payment_flow;
  if (raw != null && String(raw).trim() !== "") {
    return String(raw).trim();
  }
  const link = row?.payment_link_url;
  if (link != null && String(link).trim() !== "") {
    return "square_payment_link";
  }
  return null;
}

function formatPaymentFlowLabelForManual(row) {
  const flow = effectivePaymentFlowForDisplay(row);
  if (flow == null) {
    return "—";
  }
  if (flow === "square_payment_link") {
    return "Square payment link";
  }
  if (flow === "pay_later") {
    return "Pay later";
  }
  return flow;
}

/** @returns {string} carrier | pickup | local_delivery when manual; null never after infer. */
function effectiveFulfillmentMethodForDisplay(row) {
  if (String(row?.order_source) !== "manual") {
    return null;
  }
  const raw = row?.fulfillment_method;
  if (raw != null && String(raw).trim() !== "") {
    return String(raw).trim();
  }
  return "carrier";
}

function formatFulfillmentMethodLabelForManual(row) {
  const m = effectiveFulfillmentMethodForDisplay(row);
  if (m === "carrier") {
    return "Ship with carrier";
  }
  if (m === "pickup") {
    return "Pickup";
  }
  if (m === "local_delivery") {
    return "Local delivery";
  }
  if (m == null) {
    return "—";
  }
  return m;
}

/**
 * Pre–UI rows: shippo_label_required null → treat as Yes (legacy carrier send).
 * @returns {"Yes"|"No"}
 */
function formatShippoLabelRequiredForManual(row) {
  if (String(row?.order_source) !== "manual") {
    return "—";
  }
  const v = row?.shippo_label_required;
  if (v == null) {
    return "Yes";
  }
  return v ? "Yes" : "No";
}

function buildManualOrderLifecycleTableHtml(row) {
  if (String(row?.order_source) !== "manual") {
    return "";
  }
  const recordedAt =
    row?.manual_payment_recorded_at && String(row.status || "").toLowerCase() === "paid"
      ? formatDate(row.manual_payment_recorded_at)
      : null;
  const recordedBy = row?.manual_payment_recorded_by
    ? `<div class="admin-muted">Recorded by: ${escapeHtml(String(row.manual_payment_recorded_by))}</div>`
    : "";
  const recLine =
    recordedAt && row.manual_payment_method
      ? `<div class="admin-muted">In-person: ${escapeHtml(
          formatManualInPersonMethod(row.manual_payment_method),
        )} · ${escapeHtml(recordedAt)}</div>${recordedBy}${
          row.manual_payment_note
            ? `<div class="admin-muted" style="margin-top:0.2rem">Note: ${escapeHtml(
                String(row.manual_payment_note).slice(0, 120),
              )}${String(row.manual_payment_note).length > 120 ? "…" : ""}</div>`
            : ""
        }`
      : "";
  return `<div class="admin-manual-lifecycle-meta" style="margin-top:0.3rem;font-size:11px;line-height:1.5">
    <div class="admin-muted">Payment flow: ${escapeHtml(formatPaymentFlowLabelForManual(row))}</div>
    <div class="admin-muted">Fulfillment: ${escapeHtml(formatFulfillmentMethodLabelForManual(row))}</div>
    <div class="admin-muted">Shippo required: ${escapeHtml(formatShippoLabelRequiredForManual(row))}</div>
    ${recLine}
  </div>`;
}

function buildManualPaymentLinkMetaTableHtml(row) {
  if (!shouldShowManualPaymentLinkMeta(row)) {
    return "";
  }
  const sent = formatDate(row.payment_link_sent_at);
  const exp = formatDate(row.payment_link_expires_at);
  const expired = isUnpaidPaymentLinkPastExpiry(row);
  const badge = expired
    ? `<div style="margin-top:0.25rem"><span class="admin-badge admin-badge--payment-link-expired" title="Display only — not enforced yet">Payment link expired</span></div>`
    : "";
  return `<div class="admin-payment-link-meta" style="margin-top:0.35rem;font-size:11px;line-height:1.45">
    <div class="admin-muted">Payment link sent at: ${escapeHtml(sent)}</div>
    <div class="admin-muted">Payment link expires at: ${escapeHtml(exp)}</div>
    ${badge}
  </div>`;
}

function buildManualOrderLifecycleModalHtml(row) {
  if (String(row?.order_source) !== "manual") {
    return "";
  }
  const paidManual =
    String(row?.status || "").toLowerCase() === "paid" && row?.manual_payment_method
      ? `<dt>Recorded payment</dt><dd>${escapeHtml(formatManualInPersonMethod(row.manual_payment_method))} · ${escapeHtml(
          formatDate(row.manual_payment_recorded_at) || "—",
        )}${
          row.manual_payment_recorded_by
            ? ` (${escapeHtml(String(row.manual_payment_recorded_by))})`
            : ""
        }${
          row.manual_payment_note
            ? `<br /><span class="admin-muted" style="font-size:12px">Note: ${escapeHtml(
                String(row.manual_payment_note),
              )}</span>`
            : ""
        }</dd>`
      : "";
  return `<div class="admin-order-detail-sub" style="margin:0 0 0.5rem">
    <dl class="admin-order-dl" style="margin:0">
      <dt>Payment flow</dt><dd>${escapeHtml(formatPaymentFlowLabelForManual(row))}</dd>
      <dt>Fulfillment</dt><dd>${escapeHtml(formatFulfillmentMethodLabelForManual(row))}</dd>
      <dt>Shippo required</dt><dd>${escapeHtml(formatShippoLabelRequiredForManual(row))}</dd>
      ${paidManual}
    </dl>
  </div>`;
}

function buildManualPaymentLinkMetaModalHtml(row) {
  if (!shouldShowManualPaymentLinkMeta(row)) {
    return "";
  }
  const sent = formatDate(row.payment_link_sent_at);
  const exp = formatDate(row.payment_link_expires_at);
  const expired = isUnpaidPaymentLinkPastExpiry(row);
  const badge = expired
    ? ` <span class="admin-badge admin-badge--payment-link-expired" title="Display only — not enforced yet">Payment link expired</span>`
    : "";
  return `<div class="admin-order-detail-sub" style="margin:0 0 0.5rem">
    <h4 class="admin-muted" style="margin:0 0 0.35rem;font-size:12px;text-transform:uppercase">Payment link</h4>
    <dl class="admin-order-dl" style="margin:0">
      <dt>Payment link sent at</dt><dd>${escapeHtml(sent)}</dd>
      <dt>Payment link expires at</dt><dd>${escapeHtml(exp)}${badge}</dd>
    </dl>
  </div>`;
}

/**
 * Per-size case/box counts for packing (from `quantities` / `boxQuantities`).
 * @returns {string[]} e.g. ["Small: 2 cases 2 boxes", "Medium: 3 cases"]
 */
function formatSizeRows(it) {
  const q = it.quantities && typeof it.quantities === "object" ? it.quantities : {};
  const bq = it.boxQuantities && typeof it.boxQuantities === "object" ? it.boxQuantities : {};
  const keys = new Set([...Object.keys(q), ...Object.keys(bq)]);
  const ordered = [
    ...siteSizes.filter((s) => keys.has(s)),
    ...[...keys].filter((s) => !siteSizes.includes(s)),
  ];

  const rows = [];
  for (const sz of ordered) {
    const cases = Math.floor(Number(q[sz]) || 0);
    const boxes = Math.floor(Number(bq[sz]) || 0);
    if (cases < 1 && boxes < 1) {
      continue;
    }
    const parts = [];
    if (cases > 0) {
      parts.push(`${cases} ${cases === 1 ? "case" : "cases"}`);
    }
    if (boxes > 0) {
      parts.push(`${boxes} ${boxes === 1 ? "box" : "boxes"}`);
    }
    rows.push(`${sz}: ${parts.join(" ")}`);
  }
  return rows;
}

/** When there is no bundle breakdown and no per-size maps — line totals or price. */
function formatFallbackInventory(it) {
  const q = it.quantities && typeof it.quantities === "object" ? it.quantities : {};
  const bq = it.boxQuantities && typeof it.boxQuantities === "object" ? it.boxQuantities : {};
  if (Object.keys(q).length || Object.keys(bq).length) {
    return null;
  }

  const pieces = [];
  const cases = Number(it.lineCases);
  const boxes = Number(it.lineBoxCount);
  if (Number.isFinite(cases) && cases > 0) {
    pieces.push(`${cases} case(s) total`);
  }
  if (Number.isFinite(boxes) && boxes > 0) {
    pieces.push(`${boxes} box(es) total`);
  }
  if (pieces.length) {
    return pieces.join("\n");
  }
  const total = it.lineTotalFormatted || "";
  return total ? `Total: ${total}` : null;
}

/**
 * Staff-facing pack list: Product / Bundle / Size blocks.
 * @returns {{ text: string, html: string }}
 */
function buildLineItemPack(it) {
  const name = it.name || it.slug || "Product";
  const slug = it.slug || "";

  const bundleLines = Array.isArray(it.bundleLines) ? it.bundleLines : [];
  const bundleRows = [];
  for (const bl of bundleLines) {
    const id = String(bl?.id || "").trim();
    const qty = Math.floor(Number(bl?.qty) || 0);
    if (!id || qty < 1) {
      continue;
    }
    const label = bundleLabelBySlugId.get(`${slug}:${id}`) || id;
    bundleRows.push(`${label} x ${qty}`);
  }

  const sizeRows = formatSizeRows(it);

  const textLines = [`Product: ${name}`];
  if (bundleRows.length) {
    textLines.push(`Bundle: ${bundleRows.join(", ")}`);
  }
  if (sizeRows.length) {
    textLines.push(`Size: ${sizeRows.join(", ")}`);
  }
  if (!bundleRows.length && !sizeRows.length) {
    const fb = formatFallbackInventory(it);
    if (fb) {
      textLines.push(fb);
    }
  }

  const text = textLines.join("\n");

  const htmlParts = [
    `<div class="admin-pack-line"><div><strong>Product:</strong> ${escapeHtml(name)}</div>`,
  ];
  if (bundleRows.length) {
    htmlParts.push(
      `<div><strong>Bundle:</strong> <span class="admin-pack-line__sizes-inline">${escapeHtml(bundleRows.join(", "))}</span></div>`,
    );
  }
  if (sizeRows.length) {
    htmlParts.push(
      `<div><strong>Size:</strong> <span class="admin-pack-line__sizes-inline">${escapeHtml(sizeRows.join(", "))}</span></div>`,
    );
  }
  if (!bundleRows.length && !sizeRows.length) {
    const fb = formatFallbackInventory(it);
    if (fb) {
      htmlParts.push(`<div class="admin-pack-line__sub">${escapeHtml(fb)}</div>`);
    }
  }
  htmlParts.push(`</div>`);
  const html = htmlParts.join("");

  return { text, html };
}

function describeLineItems(items) {
  if (!Array.isArray(items) || !items.length) {
    return { lines: [], text: "—" };
  }

  const lines = items.map((it) => buildLineItemPack(it));
  const text = lines.map((l) => l.text).join("\n\n");
  return { lines, text };
}

function fmtMoneyCents(c) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    (Number(c) || 0) / 100,
  );
}

function openRecordPaymentModal(row) {
  const m = document.getElementById("admin-record-payment-modal");
  const sum = document.getElementById("admin-record-payment-summary");
  const err = document.getElementById("admin-record-payment-error");
  const form = document.getElementById("admin-record-payment-form");
  const oid = document.getElementById("admin-record-payment-order-id");
  if (!m || !sum || !form || !oid) {
    return;
  }
  if (err) {
    err.hidden = true;
    err.textContent = "";
  }
  const itemText = describeLineItems(row.items).text;
  const tot = fmtMoneyCents(row.total_cents);
  sum.innerHTML = `<strong>${escapeHtml(row.order_ref || String(row.id))}</strong><br />
<span class="admin-muted">Customer:</span> ${escapeHtml(row.customer_name || "—")} &lt;${escapeHtml(
    row.customer_email || "",
  )}&gt;<br />
<span class="admin-muted">Total due:</span> ${escapeHtml(tot)}<br />
<span class="admin-muted">Fulfillment:</span> ${escapeHtml(
    formatFulfillmentMethodLabelForManual(row),
  )} · <span class="admin-muted">Payment flow:</span> ${escapeHtml(formatPaymentFlowLabelForManual(row))}<br />
<span class="admin-muted">Items</span>
<pre style="margin:0.3rem 0 0;font-size:12px;line-height:1.4;white-space:pre-wrap;max-height:10rem;overflow:auto;border:0;background:transparent;font-family:inherit;padding:0">${escapeHtml(
    itemText,
  )}</pre>`;
  oid.value = String(row.id);
  const cash = form.querySelector('input[name="rec_pay_method"][value="cash"]');
  if (cash) {
    cash.checked = true;
  }
  const note = document.getElementById("admin-record-payment-note");
  if (note) {
    note.value = "";
  }
  m.hidden = false;
}

function closeRecordPaymentModal() {
  const el = document.getElementById("admin-record-payment-modal");
  if (el) {
    el.hidden = true;
  }
}

function bindRecordPaymentModal() {
  if (document.body.dataset.recordPaymentBound === "1") {
    return;
  }
  document.body.dataset.recordPaymentBound = "1";
  document.querySelectorAll("[data-close-record-payment]").forEach((el) => {
    el.addEventListener("click", () => closeRecordPaymentModal());
  });
  document.getElementById("admin-record-payment-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const errEl = document.getElementById("admin-record-payment-error");
    const confirmBtn = document.getElementById("admin-record-payment-confirm");
    if (errEl) {
      errEl.hidden = true;
      errEl.textContent = "";
    }
    const form = e.target;
    const orderId = String(document.getElementById("admin-record-payment-order-id")?.value || "").trim();
    const method = String(form.querySelector('input[name="rec_pay_method"]:checked')?.value || "").trim();
    const note = String(document.getElementById("admin-record-payment-note")?.value || "").trim();
    if (!orderId || !method) {
      if (errEl) {
        errEl.textContent = "Missing order or payment method.";
        errEl.hidden = false;
      }
      return;
    }
    if (!supabase) {
      if (errEl) {
        errEl.textContent = "Not signed in.";
        errEl.hidden = false;
      }
      return;
    }
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session?.access_token) {
      if (errEl) {
        errEl.textContent = "Sign in again.";
        errEl.hidden = false;
      }
      return;
    }
    if (confirmBtn) {
      confirmBtn.disabled = true;
    }
    try {
      await fetchReportPost("/api/admin-manual-order-record-payment", session.access_token, {
        orderId,
        manualPaymentMethod: method,
        paymentNote: note || undefined,
      });
      closeRecordPaymentModal();
      await loadOrders();
    } catch (e2) {
      if (errEl) {
        errEl.textContent = e2.message || "Could not record payment.";
        errEl.hidden = false;
      }
    } finally {
      if (confirmBtn) {
        confirmBtn.disabled = false;
      }
    }
  });
}

function badgeClass(orderStatus) {
  const k = String(orderStatus || "awaiting_payment").replace(/[^a-z_]/gi, "_");
  return `admin-badge admin-badge--${k}`;
}

async function loadCatalog() {
  try {
    const res = await fetch("/api/products");
    if (!res.ok) return;
    const data = await res.json();
    if (Array.isArray(data.site?.sizes)) {
      siteSizes = data.site.sizes;
    }
    bundleLabelBySlugId.clear();
    for (const p of data.products || []) {
      const slug = p.slug;
      for (const b of p.bundles || []) {
        if (b?.id) {
          bundleLabelBySlugId.set(`${slug}:${b.id}`, b.label || b.id);
        }
      }
    }
  } catch {
    // Catalog is optional; bundle ids still show raw.
  }
}

function showLogin() {
  document.getElementById("admin-login").hidden = false;
  document.getElementById("admin-app").hidden = true;
}

function showApp() {
  document.getElementById("admin-login").hidden = true;
  document.getElementById("admin-app").hidden = false;
}

function bindModalShippoActions() {
  if (document.body.dataset.shippoModalBound === "1") {
    return;
  }
  document.body.dataset.shippoModalBound = "1";

  document.addEventListener("click", (e) => {
    const modalRecBtn = e.target.closest("[data-record-payment-modal]");
    if (modalRecBtn) {
      e.preventDefault();
      const id = modalRecBtn.getAttribute("data-record-payment-modal");
      const row = ordersCache.find((r) => String(r.id) === String(id));
      if (row) {
        openRecordPaymentModal(row);
      }
      return;
    }

    const fulfillTab = e.target.closest(".admin-fulfillment-progress__tabs button[data-fulfillment-tab]");
    if (fulfillTab && !fulfillTab.disabled) {
      e.preventDefault();
      const modal = document.getElementById("order-modal");
      const orderId = modal?.dataset?.fulfillmentOrderId;
      const idx = Number(fulfillTab.dataset.fulfillmentTab);
      const fresh = ordersCache.find((r) => String(r.id) === String(orderId));
      if (!fresh || !canNavigateToFulfillmentTab(fresh, idx)) {
        return;
      }
      openModal(fresh, { skipShippoAutoRefresh: true, fulfillmentTab: idx });
      return;
    }

    const tFrom = e.target.closest("[data-toggle-from-override]");
    if (tFrom) {
      e.preventDefault();
      const w = document.getElementById("admin-from-override-wrap");
      if (w) {
        w.hidden = !w.hidden;
      }
      return;
    }
    const saveFromOv = e.target.closest("[data-save-from-override]");
    if (saveFromOv) {
      e.preventDefault();
      const orderId = saveFromOv.getAttribute("data-save-from-override");
      const form = document.getElementById("admin-from-override-form");
      if (!orderId || !form || !supabase) {
        return;
      }
      void (async () => {
        const {
          data: { session },
        } = await supabase.auth.getSession();
        if (!session?.access_token) {
          alert("Sign in again.");
          return;
        }
        const fd = new FormData(form);
        const shipFromOverride = {
          name: String(fd.get("name") || "").trim(),
          line1: String(fd.get("line1") || "").trim(),
          line2: String(fd.get("line2") || "").trim(),
          city: String(fd.get("city") || "").trim(),
          state: String(fd.get("state") || "").trim(),
          postalCode: String(fd.get("postalCode") || "").trim(),
          country: String(fd.get("country") || "").trim(),
          email: String(fd.get("email") || "").trim(),
          phone: String(fd.get("phone") || "").trim(),
        };
        try {
          const data = await fetchReportPost("/api/admin-order-fulfillment-addresses", session.access_token, {
            orderId,
            shipFromOverride,
          });
          await loadOrders();
          renderTable();
          if (data.order) {
            const idx = ordersCache.findIndex((r) => String(r.id) === String(orderId));
            if (idx >= 0) {
              ordersCache[idx] = data.order;
            }
          }
          const refreshed = ordersCache.find((r) => String(r.id) === String(orderId));
          if (refreshed && String(modalOpenOrderId) === String(orderId)) {
            openModal(refreshed, { skipShippoAutoRefresh: true, fulfillmentTab: 0 });
          }
        } catch (err) {
          alert(err.message || "Could not save sender.");
        }
      })();
      return;
    }

    const saveExt = e.target.closest("[data-save-external-fulfillment]");
    if (saveExt && !saveExt.disabled) {
      e.preventDefault();
      const orderId = saveExt.getAttribute("data-save-external-fulfillment");
      const form = document.getElementById("admin-external-fulfillment-form");
      if (!orderId || !form || !supabase) {
        return;
      }
      void (async () => {
        const {
          data: { session },
        } = await supabase.auth.getSession();
        if (!session?.access_token) {
          alert("Sign in again.");
          return;
        }
        const fd = new FormData(form);
        const carrier = String(fd.get("carrier") || "").trim();
        const service = String(fd.get("service") || "").trim();
        const trackingNumbers = String(fd.get("trackingNumbers") || "").trim();
        const shippedDate = String(fd.get("shippedDate") || "").trim();
        const costRaw = String(fd.get("labelCost") || "").trim();
        let labelCostCents = null;
        if (costRaw) {
          const n = Math.round(Number.parseFloat(costRaw) * 100);
          if (Number.isFinite(n) && n >= 0) {
            labelCostCents = n;
          }
        }
        const labelInput = document.getElementById("admin-ext-label-file");
        const slipInput = document.getElementById("admin-ext-slip-file");
        const readOneFileB64 = (file) =>
          new Promise((resolve, reject) => {
            const r = new FileReader();
            r.onload = () => {
              const s = String(r.result || "");
              const i = s.indexOf(",");
              resolve({ base64: i >= 0 ? s.slice(i + 1) : s, name: file.name || "upload" });
            };
            r.onerror = () => reject(new Error("Could not read file."));
            r.readAsDataURL(file);
          });
        const readAllFilesFromInput = async (input) => {
          const files = input?.files?.length ? Array.from(input.files) : [];
          const out = [];
          for (const file of files) {
            const part = await readOneFileB64(file);
            if (part.base64) {
              out.push({ base64: part.base64, name: part.name });
            }
          }
          return out;
        };
        try {
          const labelFiles = await readAllFilesFromInput(labelInput);
          const packingSlipFiles = await readAllFilesFromInput(slipInput);
          const payload = {
            orderId,
            carrier,
            service,
            trackingNumbers,
            shippedDate,
            labelCostCents,
          };
          if (labelFiles.length) {
            payload.labelFiles = labelFiles;
          }
          if (packingSlipFiles.length) {
            payload.packingSlipFiles = packingSlipFiles;
          }
          const data = await fetchReportPost("/api/admin-order-external-fulfillment-save", session.access_token, payload);
          await loadOrders();
          renderTable();
          if (data.order) {
            const idx = ordersCache.findIndex((r) => String(r.id) === String(orderId));
            if (idx >= 0) {
              ordersCache[idx] = data.order;
            }
          }
          const refreshed = ordersCache.find((r) => String(r.id) === String(orderId));
          const toast = document.getElementById("admin-external-fulfillment-toast");
          if (toast) {
            toast.textContent = "Label records saved.";
            toast.hidden = false;
            window.clearTimeout(window.__adminExtFulToastTm);
            window.__adminExtFulToastTm = window.setTimeout(() => {
              toast.hidden = true;
            }, 4000);
          }
          if (refreshed && String(modalOpenOrderId) === String(orderId)) {
            openModal(refreshed, { skipShippoAutoRefresh: true, fulfillmentTab: 0 });
          }
        } catch (err) {
          alert(err.message || "Could not save label records.");
        }
      })();
      return;
    }

    const handoffBtn = e.target.closest("[data-fulfillment-handoff]");
    if (handoffBtn && !handoffBtn.disabled) {
      e.preventDefault();
      const orderId = handoffBtn.getAttribute("data-fulfillment-handoff");
      if (!orderId || !supabase) {
        return;
      }
      if (
        !confirm(
          "Mark this order as shipped in your store records? This does not purchase a label — it only updates status for your team and the customer-facing summary.",
        )
      ) {
        return;
      }
      void (async () => {
        const {
          data: { session },
        } = await supabase.auth.getSession();
        if (!session?.access_token) {
          alert("Sign in again.");
          return;
        }
        try {
          const data = await fetchReportPost("/api/admin-order-fulfillment-handoff", session.access_token, { orderId });
          await loadOrders();
          renderTable();
          if (data.order) {
            const idx = ordersCache.findIndex((r) => String(r.id) === String(orderId));
            if (idx >= 0) {
              ordersCache[idx] = data.order;
            }
          }
          const refreshed = ordersCache.find((r) => String(r.id) === String(orderId));
          if (refreshed && String(modalOpenOrderId) === String(orderId)) {
            openModal(refreshed, { skipShippoAutoRefresh: true, fulfillmentTab: 1 });
          }
        } catch (err) {
          alert(err.message || "Could not confirm handoff.");
        }
      })();
      return;
    }

    const packSlip = e.target.closest("[data-open-packing-slip]");
    if (packSlip) {
      e.preventDefault();
      const orderId = packSlip.getAttribute("data-open-packing-slip");
      if (!orderId || !supabase) {
        return;
      }
      void (async () => {
        const {
          data: { session },
        } = await supabase.auth.getSession();
        if (!session?.access_token) {
          alert("Sign in again.");
          return;
        }
        try {
          const data = await fetchReportPost("/api/admin-order-packing-slip-html", session.access_token, { orderId });
          const html = data.html;
          if (!html) {
            alert("No packing slip content returned.");
            return;
          }
          const w = window.open("", "_blank");
          if (w) {
            w.document.open();
            w.document.write(html);
            w.document.close();
          }
        } catch (err) {
          alert(err.message || "Could not open packing slip.");
        }
      })();
      return;
    }

    const notifyBtn = e.target.closest("[data-buyer-shipping-notify]");
    if (notifyBtn) {
      e.preventDefault();
      const orderId = notifyBtn.getAttribute("data-buyer-shipping-notify");
      if (!orderId || !supabase) {
        return;
      }
      void (async () => {
        const {
          data: { session },
        } = await supabase.auth.getSession();
        if (!session?.access_token) {
          alert("Sign in again.");
          return;
        }
        try {
          const data = await fetchReportPost("/api/admin-order-buyer-shipping-notify", session.access_token, { orderId });
          await loadOrders();
          renderTable();
          if (data.order) {
            const idx = ordersCache.findIndex((r) => String(r.id) === String(orderId));
            if (idx >= 0) {
              ordersCache[idx] = data.order;
            }
          }
          const refreshed = ordersCache.find((r) => String(r.id) === String(orderId));
          if (refreshed && String(modalOpenOrderId) === String(orderId)) {
            openModal(refreshed, { skipShippoAutoRefresh: true, fulfillmentTab: 0 });
          }
        } catch (err) {
          alert(err.message || "Could not send email.");
        }
      })();
      return;
    }

    const shippoSyncBtn = e.target.closest("[data-shippo-sync]");
    if (shippoSyncBtn) {
      e.preventDefault();
      const orderId = shippoSyncBtn.getAttribute("data-shippo-sync");
      if (!orderId || !supabase) {
        return;
      }
      void (async () => {
        const {
          data: { session },
        } = await supabase.auth.getSession();
        if (!session?.access_token) {
          alert("Sign in again.");
          return;
        }
        shippoSyncBtn.disabled = true;
        const beforeText = shippoSyncBtn.textContent;
        shippoSyncBtn.textContent = "Syncing…";
        try {
          await fetchReportPost("/api/admin-order-shippo-sync", session.access_token, {
            orderId,
          });
          await loadOrders();
          renderTable();
          const refreshed = ordersCache.find((r) => String(r.id) === String(orderId));
          if (refreshed && String(modalOpenOrderId) === String(orderId)) {
            openModal(refreshed, { skipShippoAutoRefresh: true });
          }
        } catch (err) {
          if (err instanceof ReportPostError && err.body?.order) {
            const idx = ordersCache.findIndex((r) => String(r.id) === String(orderId));
            if (idx >= 0) {
              ordersCache[idx] = err.body.order;
            }
            renderTable();
            if (String(modalOpenOrderId) === String(orderId)) {
              openModal(err.body.order, { skipShippoAutoRefresh: true });
            }
          }
          const parts = [err.message || "Shippo sync failed."];
          if (err instanceof ReportPostError && err.body?.shippo_last_error_response != null) {
            parts.push(`Shippo response:\n${JSON.stringify(err.body.shippo_last_error_response, null, 2)}`);
          }
          alert(parts.join("\n\n"));
        } finally {
          shippoSyncBtn.disabled = false;
          shippoSyncBtn.textContent = beforeText || "Sync to Shippo";
        }
      })();
      return;
    }

    const shippoRefreshBtn = e.target.closest("[data-shippo-refresh]");
    if (shippoRefreshBtn) {
      e.preventDefault();
      const orderId = shippoRefreshBtn.getAttribute("data-shippo-refresh");
      if (!orderId || !supabase) {
        return;
      }
      void (async () => {
        const {
          data: { session },
        } = await supabase.auth.getSession();
        if (!session?.access_token) {
          alert("Sign in again.");
          return;
        }
        shippoRefreshBtn.disabled = true;
        const beforeText = shippoRefreshBtn.textContent;
        shippoRefreshBtn.textContent = "Refreshing…";
        try {
          await fetchReportPost("/api/admin-order-shippo-refresh-status", session.access_token, {
            orderId,
          });
          await loadOrders();
          renderTable();
          const refreshed = ordersCache.find((r) => String(r.id) === String(orderId));
          if (refreshed && String(modalOpenOrderId) === String(orderId)) {
            openModal(refreshed, { skipShippoAutoRefresh: true });
          }
        } catch (err) {
          alert(err.message || "Could not refresh Shippo status.");
        } finally {
          shippoRefreshBtn.disabled = false;
          shippoRefreshBtn.textContent = beforeText || "Refresh Shippo";
        }
      })();
      return;
    }

    const toggleShipEdit = e.target.closest("[data-toggle-shipping-edit]");
    if (toggleShipEdit) {
      e.preventDefault();
      const wrap = document.getElementById("admin-shipping-edit-wrap");
      if (wrap) {
        wrap.hidden = !wrap.hidden;
        toggleShipEdit.setAttribute("aria-expanded", wrap.hidden ? "false" : "true");
      }
      return;
    }

    const modalRatesRefresh = e.target.closest("[data-shippo-modal-refresh-rates]");
    if (modalRatesRefresh) {
      e.preventDefault();
      const orderId = modalRatesRefresh.getAttribute("data-shippo-modal-refresh-rates");
      if (!orderId || !supabase) {
        return;
      }
      void (async () => {
        const {
          data: { session },
        } = await supabase.auth.getSession();
        if (!session?.access_token) {
          alert("Sign in again.");
          return;
        }
        modalRatesRefresh.disabled = true;
        const prev = modalRatesRefresh.textContent;
        modalRatesRefresh.textContent = "Refreshing…";
        try {
          await fetchReportPost("/api/admin-order-shippo-refresh-status", session.access_token, {
            orderId,
          });
          await loadOrders();
          renderTable();
          const refreshed = ordersCache.find((r) => String(r.id) === String(orderId));
          if (refreshed) {
            openModal(refreshed, { skipShippoAutoRefresh: true });
          }
        } catch (err) {
          alert(err.message || "Could not refresh rates.");
        } finally {
          modalRatesRefresh.disabled = false;
          modalRatesRefresh.textContent = prev || "Refresh rates";
        }
      })();
      return;
    }

    const modalShippoRefresh = e.target.closest("[data-shippo-modal-refresh-status]");
    if (modalShippoRefresh) {
      e.preventDefault();
      const orderId = modalShippoRefresh.getAttribute("data-shippo-modal-refresh-status");
      if (!orderId || !supabase) {
        return;
      }
      void (async () => {
        const {
          data: { session },
        } = await supabase.auth.getSession();
        if (!session?.access_token) {
          alert("Sign in again.");
          return;
        }
        modalShippoRefresh.disabled = true;
        const prev = modalShippoRefresh.textContent;
        modalShippoRefresh.textContent = "Refreshing…";
        try {
          await fetchReportPost("/api/admin-order-shippo-refresh-status", session.access_token, {
            orderId,
          });
          await loadOrders();
          renderTable();
          const refreshed = ordersCache.find((r) => String(r.id) === String(orderId));
          if (refreshed && String(modalOpenOrderId) === String(orderId)) {
            openModal(refreshed, { skipShippoAutoRefresh: true });
          }
        } catch (err) {
          alert(err.message || "Could not refresh Shippo status.");
        } finally {
          modalShippoRefresh.disabled = false;
          modalShippoRefresh.textContent = prev || "Refresh Shippo status";
        }
      })();
      return;
    }

    const buyLabelBtn = e.target.closest("[data-shippo-buy-label]");
    if (buyLabelBtn) {
      e.preventDefault();
      const orderId = buyLabelBtn.getAttribute("data-shippo-buy-label");
      const picked = document.querySelector('input[name="admin-shippo-rate-pick"]:checked');
      const rateObjectId = picked?.value?.trim();
      if (!orderId || !supabase) {
        return;
      }
      if (!rateObjectId) {
        alert("Select a Shippo rate first.");
        return;
      }
      void (async () => {
        const {
          data: { session },
        } = await supabase.auth.getSession();
        if (!session?.access_token) {
          alert("Sign in again.");
          return;
        }
        buyLabelBtn.disabled = true;
        const prev = buyLabelBtn.textContent;
        buyLabelBtn.textContent = "Purchasing…";
        try {
          await fetchReportPost("/api/admin-order-shippo-purchase-label", session.access_token, {
            orderId,
            rateObjectId,
          });
          await loadOrders();
          renderTable();
          const refreshed = ordersCache.find((r) => String(r.id) === String(orderId));
          if (refreshed) {
            openModal(refreshed, { skipShippoAutoRefresh: true });
          }
        } catch (err) {
          if (err instanceof ReportPostError && err.body?.order) {
            const idx = ordersCache.findIndex((r) => String(r.id) === String(orderId));
            if (idx >= 0) {
              ordersCache[idx] = err.body.order;
            }
            void openModal(err.body.order, { skipShippoAutoRefresh: true }).then(() => {
              renderTable();
            });
          }
          alert(err.message || "Could not purchase label.");
        } finally {
          buyLabelBtn.disabled = false;
          buyLabelBtn.textContent = prev || "Buy label (selected rate)";
        }
      })();
      return;
    }

    const buyAllBtn = e.target.closest("[data-shippo-buy-all-labels]");
    if (buyAllBtn) {
      e.preventDefault();
      const orderId = buyAllBtn.getAttribute("data-shippo-buy-all-labels");
      if (!orderId || !supabase) {
        return;
      }
      void (async () => {
        const {
          data: { session },
        } = await supabase.auth.getSession();
        if (!session?.access_token) {
          alert("Sign in again.");
          return;
        }
        buyAllBtn.disabled = true;
        const prev = buyAllBtn.textContent;
        buyAllBtn.textContent = "Purchasing…";
        try {
          const data = await fetchReportPost("/api/admin-order-shippo-buy-all-labels", session.access_token, {
            orderId,
          });
          if (data?.order) {
            const idx = ordersCache.findIndex((r) => String(r.id) === String(orderId));
            if (idx >= 0) {
              ordersCache[idx] = data.order;
            }
            await openModal(data.order, { skipShippoAutoRefresh: true });
            renderTable();
          }
          if (data?.failedCount > 0) {
            const m = [
              data?.purchasedCount != null ? `Purchased: ${data.purchasedCount}` : "",
              `Failed: ${data.failedCount}`,
              data?.skippedCount ? `Skipped: ${data.skippedCount}` : "",
            ]
              .filter(Boolean)
              .join(" · ");
            window.alert(m);
          }
        } catch (err) {
          alert(err.message || "Could not buy all labels.");
        } finally {
          buyAllBtn.disabled = false;
          const rowAfter = ordersCache.find((r) => String(r.id) === String(orderId));
          const labsAfter = rowAfter ? getShippoLabelsForOrderFromCache(orderId) ?? [] : [];
          if (rowAfter) {
            patchShippoMultiLabelActionButtons(rowAfter, labsAfter);
          } else {
            buyAllBtn.textContent = prev || "Buy all labels";
          }
        }
      })();
      return;
    }

    const openAllBtn = e.target.closest("[data-shippo-open-all-labels]");
    if (openAllBtn) {
      e.preventDefault();
      const orderId = openAllBtn.getAttribute("data-shippo-open-all-labels");
      if (!orderId || !supabase) {
        return;
      }
      void (async () => {
        const { data, error } = await supabase
          .from("order_shippo_labels")
          .select("label_url, status")
          .eq("order_id", coerceOrderIdForSupabaseFilter(orderId))
          .order("parcel_index", { ascending: true });
        if (error) {
          alert(error.message || "Could not list labels.");
          return;
        }
        const urls = (Array.isArray(data) ? data : []).filter((r) => r && String(r.status) === "purchased" && r.label_url).map((r) => String(r.label_url));
        if (!urls.length) {
          alert("No purchased labels on file yet.");
          return;
        }
        for (const u of urls) {
          window.open(u, "_blank", "noopener,noreferrer");
        }
      })();
      return;
    }

    const retryLabel = e.target.closest("[data-shippo-retry-label]");
    if (retryLabel) {
      e.preventDefault();
      const orderId = retryLabel.getAttribute("data-shippo-retry-label");
      const parcelIndex = retryLabel.getAttribute("data-parcel-index");
      if (orderId == null || !supabase) {
        return;
      }
      void (async () => {
        const {
          data: { session },
        } = await supabase.auth.getSession();
        if (!session?.access_token) {
          alert("Sign in again.");
          return;
        }
        retryLabel.disabled = true;
        try {
          const data = await fetchReportPost("/api/admin-order-shippo-buy-all-labels", session.access_token, {
            orderId,
            parcelIndex: parcelIndex != null ? Number(parcelIndex) : undefined,
          });
          if (data?.order) {
            const idx = ordersCache.findIndex((r) => String(r.id) === String(orderId));
            if (idx >= 0) {
              ordersCache[idx] = data.order;
            }
            await openModal(data.order, { skipShippoAutoRefresh: true });
            renderTable();
          }
        } catch (err) {
          alert(err.message || "Could not retry label.");
        } finally {
          retryLabel.disabled = false;
        }
      })();
      return;
    }
  });
}

function bindOrdersTableEvents() {
  const table = document.getElementById("orders-table");
  if (!table || table.dataset.delegationBound === "1") {
    return;
  }
  table.dataset.delegationBound = "1";

  table.addEventListener("click", (e) => {
    const detailBtn = e.target.closest("[data-detail-id]");
    if (detailBtn) {
      e.preventDefault();
      const id = detailBtn.getAttribute("data-detail-id");
      const row = ordersCache.find((r) => String(r.id) === String(id));
      if (row) openModal(row);
      return;
    }

    const recBtn = e.target.closest("[data-record-payment]");
    if (recBtn) {
      e.preventDefault();
      const id = recBtn.getAttribute("data-record-payment");
      const row = ordersCache.find((r) => String(r.id) === String(id));
      if (row) {
        openRecordPaymentModal(row);
      }
      return;
    }

    const sendLinkBtn = e.target.closest("[data-send-pay-link]");
    if (sendLinkBtn) {
      e.preventDefault();
      const orderId = sendLinkBtn.getAttribute("data-send-pay-link");
      if (!orderId || !supabase) {
        return;
      }
      void (async () => {
        const {
          data: { session },
        } = await supabase.auth.getSession();
        if (!session?.access_token) {
          alert("Sign in again.");
          return;
        }
        sendLinkBtn.disabled = true;
        try {
          const result = await fetchReportPost("/api/admin-manual-order-send-link", session.access_token, {
            orderId,
          });
          if (result.emailed === true) {
            alert(result.warning || "Payment link emailed to the customer.");
          } else {
            alert(
              result.warning ||
                "The payment link was created but the email was not sent. Share the link manually or fix email settings, then try again.",
            );
          }
          await loadOrders();
        } catch (err) {
          alert(err.message || "Failed to send payment link.");
          sendLinkBtn.disabled = false;
        }
      })();
      return;
    }

    const saveShipDateBtn = e.target.closest("[data-save-shippo-shipment-date]");
    if (saveShipDateBtn) {
      e.preventDefault();
      const orderId = saveShipDateBtn.getAttribute("data-save-shippo-shipment-date");
      if (!orderId || !supabase) {
        return;
      }
      const input = saveShipDateBtn.parentElement?.querySelector("[data-shippo-shipment-date-input]");
      const shipmentDate = input && "value" in input ? String(input.value || "").trim() : "";
      void (async () => {
        const {
          data: { session },
        } = await supabase.auth.getSession();
        if (!session?.access_token) {
          alert("Sign in again.");
          return;
        }
        saveShipDateBtn.disabled = true;
        const prev = saveShipDateBtn.textContent;
        saveShipDateBtn.textContent = "Saving…";
        try {
          const data = await fetchReportPost("/api/admin-order-shippo-shipment-date", session.access_token, {
            orderId,
            shipmentDate: shipmentDate || null,
          });
          {
            const errLine = document.getElementById("admin-load-error");
            if (errLine) {
              errLine.hidden = true;
              errLine.textContent = "";
            }
          }
          await loadOrders();
          renderTable();
          if (data.order) {
            const idx = ordersCache.findIndex((r) => String(r.id) === String(orderId));
            if (idx >= 0) {
              ordersCache[idx] = data.order;
            }
          }
          const refreshed = ordersCache.find((r) => String(r.id) === String(orderId));
          if (refreshed && String(modalOpenOrderId) === String(orderId)) {
            openModal(refreshed, { skipShippoAutoRefresh: true });
          }
          const fb = document.getElementById("admin-orders-feedback");
          if (fb) {
            fb.textContent = "Planned ship date saved.";
            fb.className = "admin-inline-toast admin-inline-toast--success";
            fb.hidden = false;
          }
        } catch (err) {
          const el = document.getElementById("admin-load-error");
          if (el) {
            el.textContent = err?.message || "Could not save planned ship date.";
            el.hidden = false;
          } else {
            alert(err?.message || "Could not save ship date.");
          }
        } finally {
          saveShipDateBtn.disabled = false;
          saveShipDateBtn.textContent = prev || "Save date";
        }
      })();
      return;
    }

    const clearShipDateBtn = e.target.closest("[data-clear-shippo-shipment-date]");
    if (clearShipDateBtn) {
      e.preventDefault();
      const orderId = clearShipDateBtn.getAttribute("data-clear-shippo-shipment-date");
      if (!orderId || !supabase) {
        return;
      }
      const input = clearShipDateBtn.parentElement?.querySelector("[data-shippo-shipment-date-input]");
      if (input && "value" in input) {
        input.value = "";
      }
      void (async () => {
        const {
          data: { session },
        } = await supabase.auth.getSession();
        if (!session?.access_token) {
          alert("Sign in again.");
          return;
        }
        clearShipDateBtn.disabled = true;
        const prev = clearShipDateBtn.textContent;
        clearShipDateBtn.textContent = "…";
        try {
          const data = await fetchReportPost("/api/admin-order-shippo-shipment-date", session.access_token, {
            orderId,
            shipmentDate: null,
          });
          {
            const errLine = document.getElementById("admin-load-error");
            if (errLine) {
              errLine.hidden = true;
              errLine.textContent = "";
            }
          }
          await loadOrders();
          renderTable();
          if (data.order) {
            const idx = ordersCache.findIndex((r) => String(r.id) === String(orderId));
            if (idx >= 0) {
              ordersCache[idx] = data.order;
            }
          }
          const refreshed = ordersCache.find((r) => String(r.id) === String(orderId));
          if (refreshed && String(modalOpenOrderId) === String(orderId)) {
            openModal(refreshed, { skipShippoAutoRefresh: true });
          }
          const fb = document.getElementById("admin-orders-feedback");
          if (fb) {
            fb.textContent = "Planned ship date cleared.";
            fb.className = "admin-inline-toast admin-inline-toast--success";
            fb.hidden = false;
          }
        } catch (err) {
          const el = document.getElementById("admin-load-error");
          if (el) {
            el.textContent = err?.message || "Could not clear planned ship date.";
            el.hidden = false;
          } else {
            alert(err?.message || "Could not clear ship date.");
          }
        } finally {
          clearShipDateBtn.disabled = false;
          clearShipDateBtn.textContent = prev || "Clear";
        }
      })();
      return;
    }

    const saveShippingBtn = e.target.closest("[data-save-shipping-address]");
    if (saveShippingBtn) {
      e.preventDefault();
      const orderId = saveShippingBtn.getAttribute("data-save-shipping-address");
      if (!orderId || !supabase) {
        return;
      }
      const form = document.getElementById("admin-shipping-edit-form");
      if (!form) {
        return;
      }
      const fd = new FormData(form);
      const shippingAddress = {
        line1: String(fd.get("line1") || "").trim(),
        line2: String(fd.get("line2") || "").trim(),
        city: String(fd.get("city") || "").trim(),
        state: String(fd.get("state") || "").trim().toUpperCase(),
        postalCode: String(fd.get("postalCode") || "").trim(),
        country: String(fd.get("country") || "").trim().toUpperCase(),
      };
      const shippingContact = {
        name: String(fd.get("name") || "").trim(),
        email: String(fd.get("email") || "").trim(),
        phone: String(fd.get("phone") || "").trim(),
      };
      void (async () => {
        const {
          data: { session },
        } = await supabase.auth.getSession();
        if (!session?.access_token) {
          alert("Sign in again.");
          return;
        }
        saveShippingBtn.disabled = true;
        const beforeText = saveShippingBtn.textContent;
        saveShippingBtn.textContent = "Saving…";
        try {
          const data = await fetchReportPost("/api/admin-order-update-shipping-address", session.access_token, {
            orderId,
            shippingAddress,
            shippingContact,
          });
          await loadOrders();
          if (data.order) {
            const idx = ordersCache.findIndex((r) => String(r.id) === String(orderId));
            if (idx >= 0) {
              ordersCache[idx] = data.order;
            }
          }
          const refreshed = ordersCache.find((r) => String(r.id) === String(orderId));
          if (refreshed) {
            openModal(refreshed, { shippingSaved: true, skipShippoAutoRefresh: true });
          }
        } catch (err) {
          alert(err.message || "Could not update shipping address.");
        } finally {
          saveShippingBtn.disabled = false;
          saveShippingBtn.textContent = beforeText || "Save shipping address";
        }
      })();
      return;
    }
  });
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
      document.getElementById("admin-user-email").textContent = session.user.email || "";
      renderAdminNav("orders");
      await loadCatalog();
      bindOrdersTableEvents();
      bindModalShippoActions();
      bindRecordPaymentModal();
      await loadOrders();
    } else {
      showLogin();
    }

    supabase.auth.onAuthStateChange(async (event, session) => {
      if (event === "SIGNED_IN" && session?.user) {
        if (!shouldBootstrapAdminSignedIn(session)) {
          return;
        }
        document.getElementById("admin-user-email").textContent = session.user.email || "";
        showApp();
        renderAdminNav("orders");
        await loadCatalog();
        bindOrdersTableEvents();
        bindModalShippoActions();
        bindRecordPaymentModal();
        await loadOrders();
      }
      if (event === "SIGNED_OUT") {
        clearAdminSessionUser();
        ordersCache = [];
        document.getElementById("orders-tbody").innerHTML = "";
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
        "Server did not return Supabase configuration. Set SUPABASE_URL and SUPABASE_ANON_KEY in the app environment, restart the server, and refresh this page.";
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
    document.getElementById("admin-user-email").textContent = session?.user?.email || email;
    renderAdminNav("orders");
    await loadCatalog();
    bindOrdersTableEvents();
    bindModalShippoActions();
    bindRecordPaymentModal();
    await loadOrders();
  });

  document.getElementById("admin-logout")?.addEventListener("click", async () => {
    if (supabase) {
      await supabase.auth.signOut();
    } else {
      showLogin();
    }
  });

  document.getElementById("admin-refresh")?.addEventListener("click", async () => {
    await loadCatalog();
    await loadOrders();
  });

  document.getElementById("filter-status")?.addEventListener("change", () => renderTable());
  document.getElementById("filter-time")?.addEventListener("change", () => renderTable());

  document.querySelectorAll("[data-close-modal]").forEach((el) => {
    el.addEventListener("click", closeModal);
  });

  /** Modal forms have no server action; Enter in inputs would otherwise submit and reload the page. */
  document.addEventListener(
    "submit",
    (e) => {
      const form = e.target;
      if (form && form.tagName === "FORM" && document.getElementById("order-modal")?.contains(form)) {
        e.preventDefault();
      }
    },
    true,
  );
}

async function loadOrders() {
  const loading = document.getElementById("admin-loading");
  const errEl = document.getElementById("admin-load-error");
  errEl.hidden = true;
  loading.hidden = false;

  try {
    const { data, error } = await supabase
      .from("orders")
      .select("*")
      .order("created_at", { ascending: false });

    if (error) {
      let msg =
        error.message ||
        "Could not load orders. Run sql/orders_admin_rls.sql in Supabase and confirm you are signed in.";
      if (/schema cache|could not find.*column/i.test(String(msg))) {
        msg +=
          " Run sql/patch-orders-shippo-schema-complete.sql (and sql/patch-orders-shippo-shipment-date.sql if the error names shippo_shipment_date) in the Supabase SQL editor, then execute NOTIFY pgrst, 'reload schema'; (included at end of those files) or use Dashboard → Settings → API → Reload schema.";
      }
      errEl.textContent = msg;
      errEl.hidden = false;
      return;
    }

    ordersCache = Array.isArray(data) ? data : [];
    orderShippoLabelsCache = new Map();
    if (supabase && ordersCache.length) {
      const ids = ordersCache.map((r) => coerceOrderIdForSupabaseFilter(r.id)).filter((id) => id != null && id !== "");
      const chunkSize = 100;
      for (let i = 0; i < ids.length; i += chunkSize) {
        const slice = ids.slice(i, i + chunkSize);
        try {
          const { data: lbls, error: lblErr } = await supabase
            .from("order_shippo_labels")
            .select("*")
            .in("order_id", slice);
          if (lblErr) {
            break;
          }
          for (const lab of Array.isArray(lbls) ? lbls : []) {
            const oid = String(lab.order_id);
            if (!orderShippoLabelsCache.has(oid)) {
              orderShippoLabelsCache.set(oid, []);
            }
            orderShippoLabelsCache.get(oid).push(lab);
          }
        } catch {
          break;
        }
      }
      for (const arr of orderShippoLabelsCache.values()) {
        arr.sort((a, b) => (Number(a.parcel_index) || 0) - (Number(b.parcel_index) || 0));
      }
    }
    updateTimeFilterLabels();
    renderTable();
  } finally {
    loading.hidden = true;
  }
}

function getFilteredOrders() {
  const timeFilter = document.getElementById("filter-time")?.value || "all";
  let pool = ordersCache.filter((r) => passesTimeFilter(r, timeFilter));
  const filter = document.getElementById("filter-status")?.value || "";
  if (!filter) {
    return pool;
  }
  return pool.filter((r) => {
    if (filter === "manual_draft") {
      return String(r.order_source) === "manual" && r.order_status === "draft";
    }
    if (filter === "walk_in_draft") {
      return isWalkInOrder(r) && r.order_status === "draft";
    }
    if (filter === "walk_in_paid") {
      return isWalkInOrder(r) && r.order_status === "paid";
    }
    if (filter === "payment_link_sent") {
      return r.order_status === "payment_link_sent";
    }
    if (filter === "awaiting_payment") {
      return isPaymentAwaiting(r);
    }
    if (filter === "need_label_records") {
      const wf = computeFulfillmentWorkflow(r);
      return wf.key === "need_label_records";
    }
    if (filter === "ready_mark_shipped") {
      const wf = computeFulfillmentWorkflow(r);
      return wf.key === "ready_mark_shipped";
    }
    if (filter === "shipping_active") {
      const paid = String(r.status || "").toLowerCase() === "paid";
      return (
        paid &&
        manualFulfillmentRecordComplete(r) &&
        !r.admin_handoff_at &&
        String(r.order_status || "") !== "shipped"
      );
    }
    if (filter === "in_transit") {
      return computeFulfillmentWorkflow(r).key === "in_transit";
    }
    if (filter === "delivered") {
      return computeFulfillmentWorkflow(r).key === "delivered";
    }
    if (filter === "issues") {
      return computeFulfillmentWorkflow(r).variant === "error";
    }
    if (filter === "cancelled") {
      return computeFulfillmentWorkflow(r).key === "cancelled";
    }
    return false;
  });
}

function renderTable() {
  const tbody = document.getElementById("orders-tbody");
  const rows = getFilteredOrders();

  tbody.innerHTML = rows
    .map((row) => {
      const id = row.id;
      const orderRef = row.order_ref || "—";
      const wf = computeFulfillmentWorkflow(row);
      const osRaw = String(row.order_status || "");
      const walkInDraft = isWalkInOrder(row) && osRaw === "draft";
      const manualDraft = String(row.order_source) === "manual" && osRaw === "draft";

      let nextActionHtml;
      if (walkInDraft) {
        nextActionHtml = `<div class="admin-next-action"><strong class="admin-next-action__primary">Complete walk-in</strong><p class="admin-muted admin-next-action__hint"><a href="/admin/walk-in-order.html">Open walk-in order</a></p></div>`;
      } else if (manualDraft) {
        const isPayLater = isManualPayLaterDraftUnpaid(row);
        nextActionHtml = isPayLater
          ? `<div class="admin-next-action"><strong class="admin-next-action__primary">Pay later</strong><p class="admin-muted admin-next-action__hint">Record when customer pays</p></div>`
          : `<div class="admin-next-action"><strong class="admin-next-action__primary">Email payment link</strong><p class="admin-muted admin-next-action__hint">Draft — not paid yet</p></div>`;
      } else {
        const issueLine = wf.blockingIssue
          ? `<p class="admin-next-action__issue">${escapeHtml(wf.blockingIssue)}</p>`
          : `<p class="admin-muted admin-next-action__hint">${escapeHtml(wf.label)}</p>`;
        const primary =
          String(wf.nextAction || "").trim() === ""
            ? ""
            : `<strong class="admin-next-action__primary">${escapeHtml(wf.nextAction)}</strong>`;
        nextActionHtml = `<div class="admin-next-action">${primary}${issueLine}</div>`;
      }

      const hardinTag =
        row.is_hardin_discount === true
          ? `<div class="admin-order-tag" title="Admin discount applied">Admin discount applied${
              row.discount_code_used
                ? `<span class="admin-order-tag__code">${escapeHtml(String(row.discount_code_used))}</span>`
                : ""
            }</div>`
          : "";

      const manualTag =
        String(row.order_source) === "manual"
          ? `<div class="admin-order-tag admin-order-tag--manual" title="Created from staff dashboard">Manual</div>`
          : "";
      const walkInTag = isWalkInOrder(row)
        ? `<div class="admin-order-tag admin-order-tag--walk-in" title="In-store walk-in sale">Walk-in</div>`
        : "";

      const shippoRoll = tableShippingRollupFromShippoLabels(row);
      const trackShort = shippoRoll
        ? shippoRoll.trackingLine
        : String(row.admin_external_tracking_number || row.shippo_tracking_number || "").trim() || "—";
      const carrierShort = shippoRoll
        ? shippoRoll.carrier
        : String(row.admin_external_carrier || row.shippo_label_carrier || "").trim() || "—";
      const noShippoLabel = row.shippo_label_required === false;
      const shipNote = shippoRoll
        ? shippoRoll.note
        : isOrderShipped(row)
          ? "Shipped"
          : noShippoLabel && String(row.status || "").toLowerCase() === "paid"
            ? "Pickup / local (no Shippo label)"
            : manualFulfillmentRecordComplete(row)
              ? "Ready to confirm"
              : String(row.status || "").toLowerCase() === "paid"
                ? "Record label"
                : "—";
      const shippoCell = `<div style="font-size:13px;line-height:1.45"><strong>${escapeHtml(carrierShort)}</strong></div>
        <div class="admin-muted" style="margin-top:0.2rem;font-size:12px">Tracking: ${escapeHtml(trackShort)}</div>
        <div class="admin-muted" style="margin-top:0.15rem;font-size:11px">${escapeHtml(shipNote)}</div>`;

      return `
        <tr data-order-id="${escapeHtml(String(id))}">
          <td>
            <div class="admin-order-ref">${escapeHtml(orderRef)}</div>
            <div class="admin-order-id">${escapeHtml(String(id))}</div>
            ${manualTag}
            ${walkInTag}
            ${hardinTag}
          </td>
          <td>${escapeHtml(row.customer_name || "—")}<br /><span class="admin-muted">${escapeHtml(row.customer_email || "")}</span></td>
          <td><span class="${badgeClass(paymentBadgeKey(row))}">${escapeHtml(
            formatPaymentColumnLabel(row),
          )}</span>${buildManualOrderLifecycleTableHtml(row)}${buildManualPaymentLinkMetaTableHtml(row)}</td>
          <td class="admin-shippo-agent-cell">${shippoCell}</td>
          <td class="admin-next-action-cell">${nextActionHtml}</td>
          <td>${escapeHtml(formatDate(row.created_at))}</td>
          <td class="admin-row-actions-btns">
            ${
              isManualPayLaterDraftUnpaid(row)
                ? `<button type="button" class="admin-btn admin-btn--small admin-btn--primary" data-record-payment="${escapeHtml(
                    String(id),
                  )}">Record payment</button> `
                : ""
            }<button type="button" class="admin-btn admin-btn--small" data-detail-id="${escapeHtml(
              String(id),
            )}">Details</button>
          </td>
        </tr>
      `;
    })
    .join("");

  tbody.querySelectorAll("tr[data-order-id]").forEach((tr) => {
    const id = tr.dataset.orderId;
    const row = ordersCache.find((r) => String(r.id) === String(id));
    if (row) {
      applyWorkflowRowTheme(tr, row);
    }
  });
}

function shouldAutoRefreshShippoOnOpen(row) {
  if (String(row?.status || "").toLowerCase() !== "paid") {
    return false;
  }
  return Boolean(
    String(row?.shippo_order_id || "").trim() ||
      String(row?.shippo_shipment_object_id || "").trim() ||
      String(row?.shippo_transaction_id || "").trim(),
  );
}

function tryShippoBackgroundRefresh(orderId) {
  if (!supabase) {
    return;
  }
  void (async () => {
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session?.access_token) {
        return;
      }
      await fetchReportPost("/api/admin-order-shippo-refresh-status", session.access_token, { orderId });
      await loadOrders();
      renderTable();
      const refreshed = ordersCache.find((r) => String(r.id) === String(orderId));
      if (refreshed && String(modalOpenOrderId) === String(orderId)) {
        void openModal(refreshed, { skipShippoAutoRefresh: true });
      }
    } catch {
      /* optional; stale row is fine */
    }
  })();
}

function buildPickupScheduleLinks(row) {
  if (!labelPurchasedSuccessfully(row)) {
    return "";
  }
  const c = String(row.shippo_label_carrier || "").toUpperCase();
  const links = [];
  if (c.includes("UPS")) {
    links.push(
      `<a class="admin-btn admin-btn--small" href="https://www.ups.com/ship/pickup?loc=en_US" target="_blank" rel="noopener">Schedule UPS pickup</a>`,
    );
  }
  if (c.includes("USPS") || c.includes("POST")) {
    links.push(
      `<a class="admin-btn admin-btn--small" href="https://tools.usps.com/schedule-pickup-steps.htm" target="_blank" rel="noopener">Schedule USPS pickup</a>`,
    );
  }
  if (!links.length) {
    return `<p class="admin-muted" style="margin:0.35rem 0 0;font-size:12px">If your carrier offers scheduled pickup, book it on their website.</p>`;
  }
  return `<div style="display:flex;flex-wrap:wrap;gap:0.4rem;margin-top:0.45rem">${links.join("")}</div>`;
}

/** Primary buttons for the current fulfillment step (modal). */
function buildModalShippingActionsHtml(row) {
  const id = escapeHtml(String(row.id));
  const parts = [];
  if (canShippoTableFirstSync(row)) {
    parts.push(
      `<button type="button" class="admin-btn admin-btn--small admin-btn--primary" data-shippo-sync="${id}">Sync to Shippo</button>`,
    );
  }
  if (!isPaymentAwaiting(row) && shouldAutoRefreshShippoOnOpen(row)) {
    parts.push(
      `<button type="button" class="admin-btn admin-btn--small" data-shippo-modal-refresh-status="${id}">Refresh Shippo status</button>`,
    );
  }
  if (labelPurchasedSuccessfully(row) && row.shippo_label_url) {
    parts.push(
      `<a class="admin-btn admin-btn--small admin-btn--primary" href="${escapeHtml(String(row.shippo_label_url))}" target="_blank" rel="noopener">Open label PDF</a>`,
    );
    if (row.shippo_tracking_url_provider) {
      parts.push(
        `<a class="admin-btn admin-btn--small" href="${escapeHtml(String(row.shippo_tracking_url_provider))}" target="_blank" rel="noopener">Track package</a>`,
      );
    }
  }
  if (!parts.length) {
    return `<p class="admin-muted" style="margin:0">No shipping actions for this step.</p>`;
  }
  return `<div class="admin-modal-actions-row" style="display:flex;flex-wrap:wrap;gap:0.5rem;align-items:center">${parts.join("")}</div>${buildPickupScheduleLinks(row)}`;
}

function pickFulfillmentTab(row, options) {
  if (options.fulfillmentTab != null) {
    let t = Number(options.fulfillmentTab);
    if (Number.isFinite(t) && t >= 0 && t <= 2) {
      if (t === 2) {
        t = 1;
      }
      if (Number.isFinite(t) && t >= 0 && t <= 1 && canNavigateToFulfillmentTab(row, t)) {
        return t;
      }
    }
  }
  const ai = deriveActiveFulfillmentStepIndex(row);
  if (ai < 0) {
    return 0;
  }
  return Math.min(ai, 1);
}

function formatAddressFromOverrideJson(row, colName) {
  const raw = row?.[colName];
  let o = raw;
  if (typeof raw === "string") {
    try {
      o = JSON.parse(raw);
    } catch {
      o = null;
    }
  }
  if (o && typeof o === "object" && String(o.line1 || "").trim()) {
    const fake = {
      shipping_address: o,
      customer_name: o.name,
      customer_email: o.email,
      customer_phone: o.phone,
    };
    return escapeHtml(formatMergedShipToDisplay(fake));
  }
  return "";
}

/**
 * Ship-from + signed doc links (async). Must not replace the whole modal — only patch nodes by id.
 */
async function hydrateOrderModalAuxiliary(row, gen) {
  const orderId = row.id;
  if (gen !== openModalGeneration) {
    return;
  }
  if (String(modalOpenOrderId) !== String(orderId)) {
    return;
  }

  const paymentPaid = String(row?.status || "").toLowerCase() === "paid";
  if (!paymentPaid || !supabase) {
    return;
  }

  try {
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (gen !== openModalGeneration || String(modalOpenOrderId) !== String(orderId)) {
      return;
    }
    if (!session?.access_token) {
      const shipEl = document.getElementById("admin-modal-ship-from-body");
      if (shipEl && String(modalOpenOrderId) === String(orderId)) {
        shipEl.innerHTML = `<p class="admin-muted">Sign in to load warehouse address.</p>`;
      }
      return;
    }

    const [sf, dl] = await Promise.all([
      fetchReportPost("/api/admin-order-ship-from-display", session.access_token, { orderId }),
      fetchReportPost("/api/admin-order-fulfillment-doc-links", session.access_token, { orderId }).catch(() => ({})),
    ]);

    if (gen !== openModalGeneration || String(modalOpenOrderId) !== String(orderId)) {
      return;
    }

    const shipEl = document.getElementById("admin-modal-ship-from-body");
    if (shipEl) {
      shipEl.innerHTML = `<pre class="admin-address-card" style="margin:0;padding:0.5rem;background:#fafafa;border-radius:6px;white-space:pre-wrap;font-family:inherit">${escapeHtml(sf.formatted)}</pre>`;
    }

    const labelEl = document.getElementById("admin-ext-label-doc-status");
    const slipEl = document.getElementById("admin-ext-slip-doc-status");
    const labelUrls = Array.isArray(dl?.labelUrls)
      ? dl.labelUrls.filter(Boolean)
      : dl?.labelUrl
        ? [String(dl.labelUrl)]
        : [];
    const slipUrls = Array.isArray(dl?.packingSlipUrls)
      ? dl.packingSlipUrls.filter(Boolean)
      : dl?.packingSlipUrl
        ? [String(dl.packingSlipUrl)]
        : [];

    if (labelEl) {
      if (labelUrls.length) {
        labelEl.innerHTML = `<div class="admin-doc-download-row" style="display:flex;flex-wrap:wrap;gap:0.4rem;margin:0.35rem 0 0">${labelUrls
          .map((url, i) => {
            const t = labelUrls.length > 1 ? `Shipping label ${i + 1}` : "Download shipping label";
            return `<a class="admin-btn admin-btn--small" href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(t)}</a>`;
          })
          .join("")}</div>`;
        labelEl.removeAttribute("class");
      } else {
        labelEl.textContent = "No shipping label file on file yet.";
        labelEl.className = "admin-muted";
        labelEl.style.margin = "0.35rem 0 0";
        labelEl.style.fontSize = "12px";
      }
    }
    if (slipEl) {
      if (slipUrls.length) {
        slipEl.innerHTML = `<div class="admin-doc-download-row" style="display:flex;flex-wrap:wrap;gap:0.4rem;margin:0.35rem 0 0">${slipUrls
          .map((url, i) => {
            const t = slipUrls.length > 1 ? `Packing slip ${i + 1}` : "Download packing slip";
            return `<a class="admin-btn admin-btn--small" href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(t)}</a>`;
          })
          .join("")}</div>`;
        slipEl.removeAttribute("class");
      } else {
        slipEl.textContent = "No packing slip file on file yet.";
        slipEl.className = "admin-muted";
        slipEl.style.margin = "0.35rem 0 0";
        slipEl.style.fontSize = "12px";
      }
    }
  } catch {
    if (gen !== openModalGeneration || String(modalOpenOrderId) !== String(orderId)) {
      return;
    }
    const shipEl = document.getElementById("admin-modal-ship-from-body");
    if (shipEl) {
      shipEl.innerHTML = `<p class="admin-error">Could not load warehouse ship-from address.</p>`;
    }
    const labelEl = document.getElementById("admin-ext-label-doc-status");
    const slipEl = document.getElementById("admin-ext-slip-doc-status");
    if (labelEl) {
      labelEl.textContent = "Could not load document status.";
      labelEl.className = "admin-muted";
      labelEl.style.margin = "0.35rem 0 0";
      labelEl.style.fontSize = "12px";
    }
    if (slipEl) {
      slipEl.textContent = "Could not load document status.";
      slipEl.className = "admin-muted";
      slipEl.style.margin = "0.35rem 0 0";
      slipEl.style.fontSize = "12px";
    }
  }
}

function syncOrderModalShippoEconomyAndRollup(row, labelRows, gen, fmt) {
  if (gen !== openModalGeneration || String(modalOpenOrderId) !== String(row.id)) {
    return;
  }
  const cost = document.getElementById("admin-modal-cost-summary-body");
  if (cost) {
    cost.innerHTML = buildCostSummaryPanelHtml(row, labelRows, fmt);
  }
  const roll = document.getElementById("admin-modal-tracking-rollout");
  if (roll) {
    roll.innerHTML = buildTrackingRollupHtml(row, labelRows);
  }
  patchShippoMultiLabelActionButtons(row, labelRows);
}

/**
 * Load public.order_shippo_labels for the open modal (RLS: authenticated read).
 * @param {object} row
 * @param {number} gen
 */
async function hydrateOrderModalShippoLabels(row, gen) {
  const orderId = row.id;
  const fmt = (cents) =>
    new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format((Number(cents) || 0) / 100);
  if (gen !== openModalGeneration) {
    return;
  }
  if (String(modalOpenOrderId) !== String(orderId)) {
    return;
  }
  const idSel = String(orderId).replace(/"/g, '\\"');
  const host = document.querySelector(`[data-shippo-labels-for="${idSel}"]`);
  const summary = document.querySelector(`[data-shippo-summary-for="${idSel}"]`);
  if (!host) {
    return;
  }
  if (!supabase) {
    host.innerHTML = `<p class="admin-muted" style="margin:0;font-size:12px">Sign in to load per-package labels.</p>`;
    syncOrderModalShippoEconomyAndRollup(row, [], gen, fmt);
    return;
  }
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (gen !== openModalGeneration || String(modalOpenOrderId) !== String(orderId)) {
    return;
  }
  if (!session) {
    host.innerHTML = `<p class="admin-muted" style="margin:0;font-size:12px">Sign in to load per-package labels.</p>`;
    syncOrderModalShippoEconomyAndRollup(row, [], gen, fmt);
    return;
  }
  const { data, error } = await supabase
    .from("order_shippo_labels")
    .select("*")
    .eq("order_id", coerceOrderIdForSupabaseFilter(orderId))
    .order("parcel_index", { ascending: true });
  if (gen !== openModalGeneration || String(modalOpenOrderId) !== String(orderId)) {
    return;
  }
  if (error) {
    host.innerHTML = `<p class="admin-error" style="margin:0;font-size:12px">Could not load per-package labels: ${escapeHtml(error.message || "error")}</p>`;
    syncOrderModalShippoEconomyAndRollup(row, [], gen, fmt);
    return;
  }
  const list = Array.isArray(data) ? data : [];
  orderShippoLabelsCache.set(String(orderId), list);
  if (!list.length) {
    host.innerHTML = `<p class="admin-muted" style="margin:0;font-size:12px">No per-package Shippo labels on file yet. Use <strong>Buy all labels</strong> after ship-to is complete.</p>`;
    if (summary) {
      summary.textContent = "";
    }
    syncOrderModalShippoEconomyAndRollup(row, [], gen, fmt);
    return;
  }
  const n = list[0]?.parcel_count != null ? Number(list[0].parcel_count) : list.length;
  const purchased = list.filter((r) => String(r.status || "") === "purchased").length;
  if (summary) {
    summary.textContent = `Per-package labels: ${purchased} of ${n} purchased.`;
  }
  const rows = list
    .map((r) => {
      const idx = r.parcel_index != null ? Number(r.parcel_index) : 0;
      const label = `Package ${idx + 1} of ${n}`;
      const st = String(r.status || "");
      let statusText = st;
      if (st === "purchased") {
        statusText = "Purchased";
      } else if (st === "failed") {
        statusText = "Failed";
      } else if (st === "processing") {
        statusText = "Processing";
      } else if (st === "pending") {
        statusText = "Pending";
      }
      const trk = String(r.tracking_number || "").trim();
      const trkLine = trk
        ? `<div class="admin-muted" style="font-size:11px;margin:0.2rem 0 0">Tracking: ${escapeHtml(trk)}</div>`
        : "";
      const err = String(r.error_message || "").trim()
        ? `<div class="admin-error" style="font-size:11px;margin:0.2rem 0 0">${escapeHtml(String(r.error_message).slice(0, 500))}</div>`
        : "";
      const open =
        st === "purchased" && r.label_url
          ? `<a class="admin-btn admin-btn--small admin-btn--primary" href="${escapeHtml(String(r.label_url))}" target="_blank" rel="noopener">Open label</a>`
          : "";
      const retry =
        st === "failed" && !isOrderShipped(row)
          ? `<button type="button" class="admin-btn admin-btn--small" data-shippo-retry-label="${escapeHtml(String(row.id))}" data-parcel-index="${idx}">Retry</button>`
          : "";
      return `<tr>
        <td>${escapeHtml(label)}</td>
        <td><span class="admin-badge admin-badge--${st === "purchased" ? "paid" : st === "failed" ? "error" : "awaiting_payment"}">${escapeHtml(statusText)}</span></td>
        <td style="max-width:14rem">${trkLine}${err}</td>
        <td style="white-space:nowrap">${open} ${retry}</td>
      </tr>`;
    })
    .join("");
  host.innerHTML = `<table class="admin-shippo-multi-table"><thead><tr><th>Package</th><th>Status</th><th>Details</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
  syncOrderModalShippoEconomyAndRollup(row, list, gen, fmt);
}

async function openModal(row, options = {}) {
  const opts = options && typeof options === "object" ? options : {};
  const isBareOptions = Object.keys(opts).length === 0;
  if (isBareOptions) {
    const modalEl = document.getElementById("order-modal");
    const bodyEl = document.getElementById("order-modal-body");
    if (
      modalEl &&
      !modalEl.hidden &&
      String(modalOpenOrderId) === String(row.id) &&
      bodyEl &&
      document.activeElement &&
      bodyEl.contains(document.activeElement)
    ) {
      return;
    }
  }

  const gen = ++openModalGeneration;
  const adminOrdersFeedback = document.getElementById("admin-orders-feedback");
  if (adminOrdersFeedback) {
    adminOrdersFeedback.textContent = "";
    adminOrdersFeedback.hidden = true;
  }
  const topErr = document.getElementById("admin-load-error");
  if (topErr) {
    topErr.textContent = "";
    topErr.hidden = true;
  }
  const selectedTab = pickFulfillmentTab(row, options);
  const modalEl = document.getElementById("order-modal");
  if (modalEl) {
    modalEl.dataset.fulfillmentOrderId = String(row.id);
    modalEl.dataset.fulfillmentTab = String(selectedTab);
  }
  let itemLines = [];
  try {
    itemLines = describeLineItems(row.items).lines;
  } catch (e) {
    console.error(e);
    itemLines = [{ html: '<p class="admin-error">Could not render line items.</p>' }];
  }
  const diag = missingShippoAddressFields(row);
  const addr = diag.addr;
  const shipToReadonlyEscaped = escapeHtml(formatMergedShipToDisplay(row));
  const fmt = (cents) =>
    new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
      (Number(cents) || 0) / 100,
    );
  const body = document.getElementById("order-modal-body");

  if (shouldUseNonShippoDetailsModal(row) && body) {
    body.innerHTML = renderNonShippoDetailsModalHtml(row, itemLines, fmt);
    modalOpenOrderId = String(row.id);
    document.getElementById("order-modal").hidden = false;
    return;
  }

  let parcelSummaryHtml = "";
  let quotedAddressSnapshotHtml = `<p class="admin-muted" style="margin:0.35rem 0 0;font-size:12px">—</p>`;
  let multiNoteHtml = "";
  try {
    const parcelLines = quotedParcelSummaryLines(row);
    const fallbackParcelLines = parcelLines.length ? parcelLines : parcelAuditSummaryLines(row);
    const quotedParcelSummary = safeQuotedParcelSummaryJson(row);
    const audit = safeShippoParcelAuditJson(row);
    const multiNote = quotedParcelSummary?.multiPieceNote || audit?.multiPieceCarrierNote;
    parcelSummaryHtml =
      fallbackParcelLines.length > 0
        ? `<ul style="margin:0.35rem 0 0;padding-left:1.1rem;font-size:12px;line-height:1.45">${fallbackParcelLines
            .map((line) => `<li>${escapeHtml(line)}</li>`)
            .join("")}</ul>`
        : `<p class="admin-muted" style="margin:0.35rem 0 0;font-size:12px">No parcel dimensions on file yet. Weights come from catalog defaults when applicable.</p>`;
    quotedAddressSnapshotHtml = `<pre class="admin-address-card" style="margin:0.35rem 0 0;padding:0.5rem;background:#fafafa;border-radius:6px;font-family:inherit;font-size:12px;white-space:pre-wrap">${escapeHtml(quotedAddressSnapshotDisplay(row))}</pre>`;
    multiNoteHtml =
      multiNote && String(multiNote).trim()
        ? `<p class="admin-muted" style="margin:0.35rem 0 0;font-size:12px;line-height:1.45">${escapeHtml(String(multiNote))}</p>`
        : "";
  } catch (e) {
    console.error("[admin] parcel summary", e);
    parcelSummaryHtml = `<p class="admin-muted">—</p>`;
  }

  const paymentPaid = String(row?.status || "").toLowerCase() === "paid";
  let shipFromHtml = `<p class="admin-muted">—</p>`;
  if (paymentPaid && !supabase) {
    shipFromHtml = `<p class="admin-muted">Sign in to load warehouse address.</p>`;
  } else if (paymentPaid && supabase) {
    shipFromHtml = `<p class="admin-muted">Loading warehouse address…</p>`;
  }

  const labelBelowFile = `<p id="admin-ext-label-doc-status" class="admin-muted" style="margin:0.35rem 0 0;font-size:12px">No shipping label file on file yet.</p>`;
  const slipBelowFile = `<p id="admin-ext-slip-doc-status" class="admin-muted" style="margin:0.35rem 0 0;font-size:12px">No packing slip file on file yet.</p>`;

  const ovFrom = (() => {
    const raw = row?.shippo_from_address_override_json;
    if (raw && typeof raw === "object") {
      return raw;
    }
    if (typeof raw === "string") {
      try {
        const p = JSON.parse(raw);
        return p && typeof p === "object" ? p : {};
      } catch {
        return {};
      }
    }
    return {};
  })();
  const canEditAddresses = paymentPaid && !isOrderShipped(row);
  const tabVis = (n) => (selectedTab === n ? "block" : "none");

  const extCarrier = escapeHtml(row.admin_external_carrier || "");
  const extService = escapeHtml(row.admin_external_service || "");
  const extTrackingTextarea = String(row.admin_external_tracking_number || "");
  const extDate = escapeHtml(row.admin_external_shipped_date || "");
  const extCostDollars =
    row.admin_external_label_cost_cents != null && Number.isFinite(Number(row.admin_external_label_cost_cents))
      ? escapeHtml(String(Number(row.admin_external_label_cost_cents) / 100))
      : "";

  const canMarkShipped = paymentPaid && !isOrderShipped(row) && manualFulfillmentRecordComplete(row);

  let modalMainRenderOk = false;
  try {
    body.innerHTML = `
    <h2>${escapeHtml(row.order_ref || "Order")}</h2>
    <div class="admin-modal__section">${buildFulfillmentProgressHtml(row, selectedTab)}</div>

    <div class="admin-fulfillment-panel" data-fulfillment-panel="0" style="display:${tabVis(0)}">
      <div class="admin-modal__section">
        <h3 class="admin-order-tab-title">Order created &amp; paid</h3>

        <div class="admin-order-detail-section">
          <h3 class="admin-order-detail-section__title">Customer Information</h3>
          <div class="admin-order-detail-sub">
            <h4 class="admin-order-detail-sub__title">Customer detail</h4>
            <dl class="admin-order-dl">
              <dt>Name</dt><dd>${escapeHtml(row.customer_name || "—")}</dd>
              <dt>Email</dt><dd>${escapeHtml(row.customer_email || "—")}</dd>
              <dt>Phone</dt><dd>${escapeHtml(row.customer_phone || "—")}</dd>
            </dl>
          </div>
          <div class="admin-order-detail-sub">
            <h4 class="admin-order-detail-sub__title">Ship to address (editable)</h4>
        <div class="admin-address-row">
          <pre class="admin-address-card admin-address-row__body" style="margin:0;padding:0.5rem;background:#fafafa;border-radius:6px;font-family:inherit;font-size:13px;white-space:pre-wrap;min-width:0">${shipToReadonlyEscaped}</pre>
          ${
            canEditAddresses
              ? `<button type="button" class="admin-icon-btn" data-toggle-shipping-edit aria-expanded="false" aria-label="Edit ship-to" title="Edit ship-to"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>`
              : `<span class="admin-muted" style="font-size:11px;align-self:flex-start">Locked</span>`
          }
        </div>
        <div id="admin-shipping-edit-wrap" class="admin-shipping-edit-wrap" hidden>
          <form id="admin-shipping-edit-form" class="admin-shipping-edit-grid">
            <label>Full name<input name="name" value="${escapeHtml(addr.name || "")}" required /></label>
            <label>Email<input name="email" type="email" value="${escapeHtml(addr.email || "")}" /></label>
            <label>Phone<input name="phone" value="${escapeHtml(addr.phone || "")}" /></label>
            <label>Street<input name="line1" value="${escapeHtml(addr.line1 || "")}" required /></label>
            <label>Line 2<input name="line2" value="${escapeHtml(addr.line2 || "")}" /></label>
            <label>City<input name="city" value="${escapeHtml(addr.city || "")}" required /></label>
            <label>State<input name="state" value="${escapeHtml(addr.state || "")}" maxlength="2" required /></label>
            <label>ZIP<input name="postalCode" value="${escapeHtml(addr.postalCode || "")}" required /></label>
            <label>Country<input name="country" value="${escapeHtml(addr.country || "")}" maxlength="2" required /></label>
          </form>
          <div style="margin-top:0.55rem">
            <button type="button" class="admin-btn admin-btn--small" data-save-shipping-address="${escapeHtml(String(row.id))}">Save recipient</button>
          </div>
        </div>
          </div>
          <div class="admin-order-detail-sub">
            <h4 class="admin-order-detail-sub__title">Ship from address (editable)</h4>
        <div class="admin-address-row">
          <div class="admin-address-row__body" id="admin-modal-ship-from-body">${shipFromHtml}</div>
          ${
            canEditAddresses
              ? `<button type="button" class="admin-icon-btn" data-toggle-from-override aria-label="Edit ship-from" title="Edit ship-from"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>`
              : `<span class="admin-muted" style="font-size:11px;align-self:flex-start">Locked</span>`
          }
        </div>
        <div id="admin-from-override-wrap" class="admin-shipping-edit-wrap" hidden>
          <form id="admin-from-override-form" class="admin-shipping-edit-grid">
            <label>Name<input name="name" value="${escapeHtml(ovFrom.name || "")}" required /></label>
            <label>Street<input name="line1" value="${escapeHtml(ovFrom.line1 || "")}" required /></label>
            <label>Line 2<input name="line2" value="${escapeHtml(ovFrom.line2 || "")}" /></label>
            <label>City<input name="city" value="${escapeHtml(ovFrom.city || "")}" required /></label>
            <label>State<input name="state" maxlength="2" value="${escapeHtml(ovFrom.state || "")}" required /></label>
            <label>ZIP<input name="postalCode" value="${escapeHtml(ovFrom.postalCode || "")}" required /></label>
            <label>Country<input name="country" maxlength="2" value="${escapeHtml(ovFrom.country || "US")}" required /></label>
            <label>Email<input name="email" type="email" value="${escapeHtml(ovFrom.email || "")}" /></label>
            <label>Phone<input name="phone" value="${escapeHtml(ovFrom.phone || "")}" /></label>
          </form>
          <button type="button" class="admin-btn admin-btn--small" data-save-from-override="${escapeHtml(String(row.id))}">Save sender</button>
        </div>
          </div>
        </div>

        <p id="admin-shipping-save-toast" class="admin-inline-toast admin-inline-toast--success" role="status" hidden></p>
        ${
          diag.missing.length
            ? `<p class="admin-error" style="margin:0.5rem 0 0">Ship-to incomplete: ${escapeHtml(diag.missing.join(", "))}</p>`
            : ""
        }

        <div class="admin-order-detail-section">
          <h3 class="admin-order-detail-section__title">Planned shipment</h3>
        ${buildPlannedShipDateControlHtml(row)}
        <div style="margin:0.35rem 0 0">${buildModalShippingActionsHtml(row)}</div>
        <p class="admin-muted admin-order-detail-hint" style="margin:0.5rem 0 0;font-size:12px;line-height:1.45">Each physical package gets its own Shippo shipment and label. Use <strong>Sync to Shippo</strong> after changing the planned date if a shipment already exists.</p>
        </div>

        <div class="admin-order-detail-section">
          <h3 class="admin-order-detail-section__title">Package Information</h3>
          <div class="admin-order-detail-sub">
            <h4 class="admin-order-detail-sub__title">Items</h4>
        <div class="admin-modal__line-items">${
          itemLines.length ? itemLines.map((l) => l.html).join("") : `<p class="admin-muted">—</p>`
        }</div>
          </div>
          <div class="admin-order-detail-sub">
            <h4 class="admin-order-detail-sub__title">Package dimensions</h4>
        ${parcelSummaryHtml}
        ${multiNoteHtml}
          </div>
        </div>

        <div class="admin-order-detail-section">
          <h3 class="admin-order-detail-section__title">Cost Summary</h3>
        <div id="admin-modal-cost-summary-body">${buildCostSummaryPanelHtml(row, null, fmt)}</div>
        <div style="margin:0.75rem 0 0;display:flex;flex-wrap:wrap;gap:0.5rem;align-items:center">
          <button type="button" class="admin-btn admin-btn--small admin-btn--primary" data-shippo-buy-all-labels="${escapeHtml(String(row.id))}" ${
      paymentPaid && !isOrderShipped(row) && !diag.missing.length ? "" : "disabled"
    }>Buy all labels</button>
        </div>
        </div>

        <div class="admin-order-detail-section">
          <h3 class="admin-order-detail-section__title">Order Summary</h3>
        <h4 class="admin-muted" style="margin:0 0 0.35rem;font-size:12px;text-transform:uppercase">Per-package Shippo labels</h4>
        <p id="admin-shippo-multi-summary" class="admin-muted" style="margin:0.35rem 0 0;font-size:12px" data-shippo-summary-for="${escapeHtml(String(row.id))}"></p>
        <div id="admin-shippo-multi-labels-host" class="admin-shippo-multi-labels-host" data-shippo-labels-for="${escapeHtml(String(row.id))}">Loading…</div>
        <h4 class="admin-muted" style="margin:1rem 0 0.35rem;font-size:12px;text-transform:uppercase">Quoted address snapshot</h4>
        ${quotedAddressSnapshotHtml}
        ${buildManualOrderLifecycleModalHtml(row)}
        ${buildManualPaymentLinkMetaModalHtml(row)}
        <h4 class="admin-muted" style="margin:1rem 0 0.35rem;font-size:12px;text-transform:uppercase">Payment</h4>
        <pre id="admin-modal-payment-core" style="margin:0;font-size:13px;font-family:inherit">${escapeHtml(formatPaymentColumnLabel(row))} · ${escapeHtml(row.payment_id || "—")}
Merchandise subtotal ${escapeHtml(fmt(row.subtotal_cents))} · Tax ${escapeHtml(fmt(row.tax_cents))} · Total paid ${escapeHtml(fmt(row.total_cents))}</pre>
        </div>

        <div class="admin-order-detail-section">
          <h3 class="admin-order-detail-section__title">Tracking &amp; shipment</h3>
          <div id="admin-modal-tracking-rollout"><p class="admin-muted" style="margin:0;font-size:13px">Loading…</p></div>
        </div>

        <div class="admin-order-detail-section">
          <h3 class="admin-order-detail-section__title">Next Action</h3>
        <p class="admin-muted" style="margin:0 0 0.65rem;font-size:13px;line-height:1.55">Print label • Apply to packages • Drop off / Pickup</p>
        <button type="button" class="admin-btn admin-btn--small" data-shippo-open-all-labels="${escapeHtml(String(row.id))}">Open all labels</button>
        </div>

        <details class="admin-modal-details admin-order-external-details">
          <summary>External label records (optional)</summary>
          <div class="admin-modal__section" style="margin-top:0.65rem;padding-top:0.65rem;border-top:1px solid var(--admin-border)">
        <form id="admin-external-fulfillment-form" style="margin-top:0">
          <div class="admin-shipping-edit-grid">
          <label>Carrier / agent<input name="carrier" type="text" autocomplete="organization" value="${extCarrier}" required placeholder="e.g. UPS, USPS, Pirate Ship" /></label>
          <label>Service (optional)<input name="service" type="text" value="${extService}" placeholder="e.g. UPS Ground" /></label>
          <label>Label cost USD (optional)<input name="labelCost" type="number" min="0" step="0.01" value="${extCostDollars}" placeholder="0.00" /></label>
          <label style="grid-column:1/-1">Tracking # (one per line if multiple packages)<textarea name="trackingNumbers" rows="5" required placeholder="Enter one tracking number per line">${escapeHtml(extTrackingTextarea)}</textarea></label>
          <label>Shipment date<input name="shippedDate" type="date" value="${extDate}" /></label>
          </div>
        <div class="admin-file-field">
          <label for="admin-ext-label-file">Shipping label files (PDF or image)</label>
          <input id="admin-ext-label-file" name="labelFile" type="file" multiple accept="application/pdf,image/*" />
          <p class="admin-muted" style="margin:0.3rem 0 0;font-size:11px;line-height:1.4">You can select multiple files. Each save uploads new files and keeps previous uploads on record.</p>
        </div>
        ${labelBelowFile}
        <div class="admin-file-field">
          <label for="admin-ext-slip-file">Packing slip files (optional)</label>
          <input id="admin-ext-slip-file" name="packingSlipFile" type="file" multiple accept="application/pdf,image/*" />
          <p class="admin-muted" style="margin:0.3rem 0 0;font-size:11px;line-height:1.4">Multiple packing slips supported — same as labels.</p>
        </div>
        ${slipBelowFile}
        </form>
        <p id="admin-external-fulfillment-toast" class="admin-inline-toast admin-inline-toast--success" role="status" hidden></p>
        <div style="margin-top:0.75rem;display:flex;flex-wrap:wrap;gap:0.5rem;align-items:center">
          <button type="button" class="admin-btn admin-btn--primary" data-save-external-fulfillment="${escapeHtml(String(row.id))}" ${
      paymentPaid && !isOrderShipped(row) ? "" : "disabled"
    }>Save label records</button>
          <button type="button" class="admin-btn admin-btn--small" data-open-packing-slip="${escapeHtml(String(row.id))}">Generate packing slip (HTML)</button>
          <button type="button" class="admin-btn admin-btn--small" data-buyer-shipping-notify="${escapeHtml(String(row.id))}">Email buyer</button>
        </div>
        ${
          row.admin_buyer_notify_sent_at
            ? `<p class="admin-muted" style="margin:0.5rem 0 0;font-size:12px">Notification sent ${escapeHtml(formatDate(row.admin_buyer_notify_sent_at))}</p>`
            : ""
        }
          </div>
        </details>
      </div>
    </div>

    <div class="admin-fulfillment-panel" data-fulfillment-panel="1" style="display:${tabVis(1)}">
      <div class="admin-modal__section">
        <h3>Shipped</h3>
        ${
          isOrderShipped(row)
            ? `<p style="margin:0">Marked <strong>shipped</strong>${row.admin_handoff_at ? ` on ${escapeHtml(formatDate(row.admin_handoff_at))}` : ""}.</p>
        <p style="margin:0.75rem 0 0;font-weight:600;font-size:13px">Carrier</p>
        <p style="margin:0.25rem 0 0;font-size:13px">${escapeHtml(row.admin_external_carrier || row.shippo_label_carrier || "—")}</p>
        <p style="margin:0.65rem 0 0;font-weight:600;font-size:13px">Tracking</p>
        ${formatTrackingListHtml(row)}`
            : `<p class="admin-muted" style="margin:0 0 0.75rem">Confirm after the package has left your hands. Use <strong>Mark as shipped</strong> when shipment is complete. If you need uploaded carrier proof outside Shippo, use <strong>External label records</strong> on the first tab.</p>
        <button type="button" class="admin-btn admin-btn--primary" data-fulfillment-handoff="${escapeHtml(String(row.id))}" ${
            canMarkShipped ? "" : "disabled"
          }>Mark as shipped</button>`
        }
      </div>
    </div>

    ${
      row.is_hardin_discount === true
        ? `<div class="admin-modal__section">
      <h3>Promotion</h3>
      <p><span class="admin-order-tag admin-order-tag--inline">Admin discount applied</span></p>
      <p class="admin-muted">Code: ${escapeHtml(row.discount_code_used || "—")}</p>
    </div>`
        : ""
    }
  `;
    modalMainRenderOk = true;
  } catch (e) {
    console.error("[admin] openModal render", e);
    body.innerHTML = `
      <h2>${escapeHtml(row.order_ref || "Order")}</h2>
      <div class="admin-modal__section admin-error">
        <p><strong>Could not render order details</strong></p>
        <p style="margin-top:0.35rem">${escapeHtml(String(e?.message || e || "Error"))}</p>
      </div>`;
    modalMainRenderOk = false;
  }
  modalOpenOrderId = String(row.id);
  document.getElementById("order-modal").hidden = false;
  if (options.shippingSaved) {
    const toast = document.getElementById("admin-shipping-save-toast");
    if (toast) {
      toast.textContent = "Shipping address saved.";
      toast.hidden = false;
      window.clearTimeout(window.__adminShipToastTm);
      window.__adminShipToastTm = window.setTimeout(() => {
        toast.hidden = true;
      }, 4500);
    }
  }
  if (modalMainRenderOk) {
    void hydrateOrderModalAuxiliary(row, gen);
    await hydrateOrderModalShippoLabels(row, gen);
  }
}

function closeModal() {
  openModalGeneration++;
  modalOpenOrderId = null;
  const m = document.getElementById("order-modal");
  if (m) {
    m.hidden = true;
    delete m.dataset.fulfillmentOrderId;
    delete m.dataset.fulfillmentTab;
  }
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeModal();
});

init();
