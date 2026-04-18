import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.8";
import {
  clearAdminSessionUser,
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
/** When set, background Shippo refresh may re-render the open modal for this order id. */
let modalOpenOrderId = null;

/** slug:bundleId -> label (from /api/products). */
const bundleLabelBySlugId = new Map();
let siteSizes = ["Small", "Medium", "Large", "X Large"];

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatPaymentStatus(status) {
  if (status === "paid") return "Paid";
  if (status === "pending") return "Awaiting payment";
  return status ? String(status) : "—";
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
      label: "Walk-in draft",
      nextAction: "Complete walk-in",
      activeStepIndex: 0,
    });
  }
  if (String(row?.order_source) === "manual" && os === "draft") {
    return base({
      key: "manual_draft",
      label: "Manual draft",
      nextAction: "Email payment link",
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

  if (isOrderShipped(row)) {
    if (isTrackingDelivered(row)) {
      return base({
        key: "delivered",
        label: "Delivered",
        nextAction: "—",
        activeStepIndex: 2,
      });
    }
    if (isTrackingInTransit(row)) {
      return base({
        key: "in_transit",
        label: "In transit",
        nextAction: "Track package",
        activeStepIndex: 2,
      });
    }
    return base({
      key: "shipped",
      label: "Shipped",
      nextAction: "—",
      activeStepIndex: 2,
    });
  }

  if (!manualFulfillmentRecordComplete(row)) {
    return base({
      key: "need_label_records",
      label: "Paid · record shipment",
      nextAction: "Open details · Label records",
      activeStepIndex: 1,
    });
  }

  return base({
    key: "ready_mark_shipped",
    label: "Ready to mark shipped",
    nextAction: "Confirm shipped",
    activeStepIndex: 2,
    blockingIssue: fulfillmentBlockingIssue(row),
    variant: fulfillmentVariantForRow(row),
  });
}

/**
 * Clickable 3-step fulfillment stepper (external label platforms).
 * @param {number} [selectedTab] 0–2
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

  const sel = Math.min(Math.max(Number.isFinite(selectedTab) ? selectedTab : 0, 0), 2);
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
      return "Draft (walk-in)";
    }
    if (String(row.status || "").toLowerCase() === "paid" && row.payment_method) {
      return `Paid (${String(row.payment_method)})`;
    }
  }
  if (String(row.order_source) === "manual") {
    if (row.order_status === "draft") {
      return "Draft";
    }
    if (row.order_status === "payment_link_sent") {
      return "Payment link sent";
    }
  }
  return formatPaymentStatus(row.status);
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
    const fulfillTab = e.target.closest("[data-fulfillment-tab]");
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
    const tRet = e.target.closest("[data-toggle-return-override]");
    if (tRet) {
      e.preventDefault();
      const w = document.getElementById("admin-return-override-wrap");
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

    const saveRetOv = e.target.closest("[data-save-return-override]");
    if (saveRetOv) {
      e.preventDefault();
      const orderId = saveRetOv.getAttribute("data-save-return-override");
      const form = document.getElementById("admin-return-override-form");
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
        const returnOverride = {
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
            returnOverride,
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
          alert(err.message || "Could not save return address.");
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
        const trackingNumber = String(fd.get("trackingNumber") || "").trim();
        const shippedDate = String(fd.get("shippedDate") || "").trim();
        const costRaw = String(fd.get("labelCost") || "").trim();
        let labelCostCents = null;
        if (costRaw) {
          const n = Math.round(Number.parseFloat(costRaw) * 100);
          if (Number.isFinite(n) && n >= 0) {
            labelCostCents = n;
          }
        }
        const labelInput = form.querySelector('input[name="labelFile"]');
        const slipInput = form.querySelector('input[name="packingSlipFile"]');
        const readB64 = (input) =>
          new Promise((resolve, reject) => {
            const file = input?.files?.[0];
            if (!file) {
              resolve({ base64: "", name: "" });
              return;
            }
            const r = new FileReader();
            r.onload = () => {
              const s = String(r.result || "");
              const i = s.indexOf(",");
              resolve({ base64: i >= 0 ? s.slice(i + 1) : s, name: file.name || "upload" });
            };
            r.onerror = () => reject(new Error("Could not read file."));
            r.readAsDataURL(file);
          });
        try {
          const labelPart = await readB64(labelInput);
          const slipPart = await readB64(slipInput);
          const payload = {
            orderId,
            carrier,
            service,
            trackingNumber,
            shippedDate,
            labelCostCents,
          };
          if (labelPart.base64) {
            payload.labelFileBase64 = labelPart.base64;
            payload.labelFileName = labelPart.name;
          }
          if (slipPart.base64) {
            payload.packingSlipFileBase64 = slipPart.base64;
            payload.packingSlipFileName = slipPart.name;
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
            openModal(refreshed, { skipShippoAutoRefresh: true, fulfillmentTab: 1 });
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
            openModal(refreshed, { skipShippoAutoRefresh: true, fulfillmentTab: 2 });
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
            openModal(refreshed, { skipShippoAutoRefresh: true, fulfillmentTab: 1 });
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
            renderTable();
            openModal(err.body.order, { skipShippoAutoRefresh: true });
          }
          alert(err.message || "Could not purchase label.");
        } finally {
          buyLabelBtn.disabled = false;
          buyLabelBtn.textContent = prev || "Buy label (selected rate)";
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
        } catch (err) {
          alert(err.message || "Could not save ship date.");
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
        } catch (err) {
          alert(err.message || "Could not clear ship date.");
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
    auth: {
      persistSession: true,
      autoRefreshToken: true,
    },
  });

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
      await loadOrders();
    }
    if (event === "SIGNED_OUT") {
      clearAdminSessionUser();
      ordersCache = [];
      document.getElementById("orders-tbody").innerHTML = "";
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
    renderAdminNav("orders");
    await loadCatalog();
    bindOrdersTableEvents();
    bindModalShippoActions();
    await loadOrders();
  });

  document.getElementById("admin-logout")?.addEventListener("click", async () => {
    await supabase.auth.signOut();
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
        nextActionHtml = `<div class="admin-next-action"><strong class="admin-next-action__primary">Email payment link</strong><p class="admin-muted admin-next-action__hint">Draft — not paid yet</p></div>`;
      } else {
        const issueLine = wf.blockingIssue
          ? `<p class="admin-next-action__issue">${escapeHtml(wf.blockingIssue)}</p>`
          : `<p class="admin-muted admin-next-action__hint">${escapeHtml(wf.label)}</p>`;
        nextActionHtml = `<div class="admin-next-action"><strong class="admin-next-action__primary">${escapeHtml(wf.nextAction)}</strong>${issueLine}</div>`;
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

      const trackShort =
        String(row.admin_external_tracking_number || row.shippo_tracking_number || "").trim() || "—";
      const carrierShort =
        String(row.admin_external_carrier || row.shippo_label_carrier || "").trim() || "—";
      const shipNote = isOrderShipped(row)
        ? "Shipped"
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
          <td><span class="${badgeClass(paymentBadgeKey(row))}">${escapeHtml(formatPaymentColumnLabel(row))}</span></td>
          <td class="admin-shippo-agent-cell">${shippoCell}</td>
          <td class="admin-next-action-cell">${nextActionHtml}</td>
          <td>${escapeHtml(formatDate(row.created_at))}</td>
          <td>
            <button type="button" class="admin-btn admin-btn--small" data-detail-id="${escapeHtml(String(id))}">Details</button>
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
        openModal(refreshed, { skipShippoAutoRefresh: true });
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

function buildShipDateControlHtml(row) {
  const id = escapeHtml(String(row.id));
  const raw = String(row.shippo_shipment_date || "").trim();
  const safeForDateInput = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : "";
  const valueAttr = safeForDateInput ? ` value="${escapeHtml(safeForDateInput)}"` : "";
  return `<div style="margin:0 0 0.65rem">
    <label class="admin-muted" style="display:block;font-size:12px;margin-bottom:0.25rem">Carrier ship / pickup date</label>
    <div style="display:flex;flex-wrap:wrap;gap:0.45rem;align-items:center">
      <input type="date" class="admin-input-date" aria-label="Carrier ship or pickup date"${valueAttr} data-shippo-shipment-date-input="${id}" />
      <button type="button" class="admin-btn admin-btn--small" data-save-shippo-shipment-date="${id}">Save date</button>
      <button type="button" class="admin-btn admin-btn--small" data-clear-shippo-shipment-date="${id}">Clear</button>
    </div>
    <p class="admin-muted" style="margin:0.35rem 0 0;font-size:11px;line-height:1.45">Stored on this order and sent to Shippo as <code>shipment_date</code> when the shipment is created. Leave empty for Shippo’s default (request time). After changing it, use <strong>Sync to Shippo</strong> on the Label step so the shipment is recreated with the new date.</p>
  </div>`;
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
    const t = Number(options.fulfillmentTab);
    if (Number.isFinite(t) && t >= 0 && t <= 2 && canNavigateToFulfillmentTab(row, t)) {
      return t;
    }
  }
  const ai = deriveActiveFulfillmentStepIndex(row);
  if (ai < 0) {
    return 0;
  }
  return Math.min(ai, 2);
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

async function openModal(row, options = {}) {
  const selectedTab = pickFulfillmentTab(row, options);
  const modalEl = document.getElementById("order-modal");
  if (modalEl) {
    modalEl.dataset.fulfillmentOrderId = String(row.id);
    modalEl.dataset.fulfillmentTab = String(selectedTab);
  }
  const wf = computeFulfillmentWorkflow(row);
  let itemLines = [];
  try {
    itemLines = describeLineItems(row.items).lines;
  } catch (e) {
    console.error(e);
    itemLines = [{ html: '<p class="admin-error">Could not render line items.</p>' }];
  }
  const diag = missingShippoAddressFields(row);
  const addr = diag.addr;
  const pieceCount = shippoParcelPieceCount(row) ?? "—";
  const shipToReadonlyEscaped = escapeHtml(formatMergedShipToDisplay(row));
  const fmt = (cents) =>
    new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
      (Number(cents) || 0) / 100,
    );

  let parcelSummaryHtml = "";
  let multiNoteHtml = "";
  let shippoPanelErrorHtml = "";
  try {
    const parcelLines = parcelAuditSummaryLines(row);
    const audit = safeShippoParcelAuditJson(row);
    const multiNote = audit?.multiPieceCarrierNote;
    parcelSummaryHtml =
      parcelLines.length > 0
        ? `<ul style="margin:0.35rem 0 0;padding-left:1.1rem;font-size:12px;line-height:1.45">${parcelLines
            .map((line) => `<li>${escapeHtml(line)}</li>`)
            .join("")}</ul>`
        : `<p class="admin-muted" style="margin:0.35rem 0 0;font-size:12px">No parcel dimensions on file yet. Weights come from catalog defaults when applicable.</p>`;
    multiNoteHtml =
      multiNote && String(multiNote).trim()
        ? `<p class="admin-muted" style="margin:0.35rem 0 0;font-size:12px;line-height:1.45">${escapeHtml(String(multiNote))}</p>`
        : "";
  } catch (e) {
    console.error("[admin] parcel summary", e);
    shippoPanelErrorHtml = `<div class="admin-error" style="margin:0.35rem 0 0.5rem;padding:0.5rem;border-radius:6px;border:1px solid rgba(180,40,40,0.35);background:rgba(180,40,40,0.06)">
      <strong>Parcel summary could not render.</strong>
      <p style="margin:0.35rem 0 0;font-size:13px">${escapeHtml(String(e?.message || e || "Unknown error"))}</p>
    </div>`;
    parcelSummaryHtml = `<p class="admin-muted">—</p>`;
  }

  const body = document.getElementById("order-modal-body");

  let shipFromHtml = `<p class="admin-muted">—</p>`;
  let docLinkLabel = "";
  let docLinkPacking = "";
  const paymentPaid = String(row?.status || "").toLowerCase() === "paid";
  if (paymentPaid && supabase) {
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (session?.access_token) {
        const sf = await fetchReportPost("/api/admin-order-ship-from-display", session.access_token, { orderId: row.id });
        shipFromHtml = `<pre class="admin-address-card" style="margin:0;padding:0.5rem;background:#fafafa;border-radius:6px;white-space:pre-wrap;font-family:inherit">${escapeHtml(sf.formatted)}</pre>`;
        try {
          const dl = await fetchReportPost("/api/admin-order-fulfillment-doc-links", session.access_token, { orderId: row.id });
          if (dl.labelUrl) {
            docLinkLabel = dl.labelUrl;
          }
          if (dl.packingSlipUrl) {
            docLinkPacking = dl.packingSlipUrl;
          }
        } catch {
          /* no files yet */
        }
      }
    } catch {
      shipFromHtml = `<p class="admin-error">Could not load warehouse ship-from address.</p>`;
    }
  } else if (paymentPaid) {
    shipFromHtml = `<p class="admin-muted">Sign in to load warehouse address.</p>`;
  }

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
  const ovRet = (() => {
    const raw = row?.shippo_return_address_override_json;
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
  const returnBlock =
    formatAddressFromOverrideJson(row, "shippo_return_address_override_json") ||
    `<p class="admin-muted" style="margin:0">Same as ship-from unless you save a return override below.</p>`;

  const canEditAddresses = paymentPaid && !isOrderShipped(row);
  const tabVis = (n) => (selectedTab === n ? "block" : "none");

  const extCarrier = escapeHtml(row.admin_external_carrier || "");
  const extService = escapeHtml(row.admin_external_service || "");
  const extTrack = escapeHtml(row.admin_external_tracking_number || "");
  const extDate = escapeHtml(row.admin_external_shipped_date || "");
  const extCostDollars =
    row.admin_external_label_cost_cents != null && Number.isFinite(Number(row.admin_external_label_cost_cents))
      ? escapeHtml(String(Number(row.admin_external_label_cost_cents) / 100))
      : "";

  const labelLinkHtml = docLinkLabel
    ? `<p style="margin:0.5rem 0 0"><a class="admin-btn admin-btn--small" href="${escapeHtml(docLinkLabel)}" target="_blank" rel="noopener">Download shipping label</a></p>`
    : `<p class="admin-muted" style="margin:0.35rem 0 0;font-size:12px">No shipping label file on file yet.</p>`;
  const slipLinkHtml = docLinkPacking
    ? `<p style="margin:0.35rem 0 0"><a class="admin-btn admin-btn--small" href="${escapeHtml(docLinkPacking)}" target="_blank" rel="noopener">Download packing slip</a></p>`
    : `<p class="admin-muted" style="margin:0.35rem 0 0;font-size:12px">No packing slip file on file yet.</p>`;

  const canMarkShipped = paymentPaid && !isOrderShipped(row) && manualFulfillmentRecordComplete(row);

  try {
    body.innerHTML = `
    <h2>${escapeHtml(row.order_ref || "Order")}</h2>
    <div class="admin-modal__section">${buildFulfillmentProgressHtml(row, selectedTab)}</div>
    <div class="admin-modal__section admin-modal__section--fulfillment-summary">
      <h3>Status</h3>
      <p style="margin:0;font-size:1.05rem;font-weight:600">${escapeHtml(wf.label)}</p>
      <p class="admin-muted" style="margin:0.4rem 0 0;font-size:14px"><strong>Next:</strong> ${escapeHtml(wf.nextAction)}</p>
      ${
        wf.blockingIssue
          ? `<p class="admin-error" style="margin:0.5rem 0 0;font-size:13px;line-height:1.45">${escapeHtml(wf.blockingIssue)}</p>`
          : ""
      }
    </div>

    <div class="admin-fulfillment-panel" data-fulfillment-panel="0" style="display:${tabVis(0)}">
      <div class="admin-modal__section">
        <h3>Order created &amp; paid</h3>
        <p class="admin-muted" style="margin:0 0 0.75rem;font-size:12px;line-height:1.45">Use this summary while you buy the label in UPS, USPS, Pirate Ship, Shippo, or any other platform. Then use <strong>Label records</strong> to save tracking and uploads.</p>
        <h4 class="admin-muted" style="margin:0 0 0.35rem;font-size:12px;text-transform:uppercase">Customer</h4>
        <pre style="margin:0 0 1rem;font-family:inherit;font-size:13px">${escapeHtml(row.customer_name || "—")}\n${escapeHtml(row.customer_email || "—")}\n${escapeHtml(row.customer_phone || "—")}</pre>
        <h4 class="admin-muted" style="margin:0 0 0.35rem;font-size:12px;text-transform:uppercase">Ship from</h4>
        ${shipFromHtml}
        <h4 class="admin-muted" style="margin:0.85rem 0 0.35rem;font-size:12px;text-transform:uppercase">Ship to</h4>
        <pre class="admin-address-card" style="margin:0;padding:0.5rem;background:#fafafa;border-radius:6px;font-family:inherit;font-size:13px">${shipToReadonlyEscaped}</pre>
        <h4 class="admin-muted" style="margin:1rem 0 0.35rem;font-size:12px;text-transform:uppercase">Items</h4>
        <div class="admin-modal__line-items">${
          itemLines.length ? itemLines.map((l) => l.html).join("") : `<p class="admin-muted">—</p>`
        }</div>
        <h4 class="admin-muted" style="margin:1rem 0 0.35rem;font-size:12px;text-transform:uppercase">Package</h4>
        ${parcelSummaryHtml}
        ${multiNoteHtml}
        <h4 class="admin-muted" style="margin:1rem 0 0.35rem;font-size:12px;text-transform:uppercase">Payment</h4>
        <pre style="margin:0;font-size:13px;font-family:inherit">${escapeHtml(formatPaymentColumnLabel(row))} · ${escapeHtml(row.payment_id || "—")}
Subtotal ${escapeHtml(fmt(row.subtotal_cents))} · Shipping ${escapeHtml(fmt(row.shipping_cents))} · Tax ${escapeHtml(fmt(row.tax_cents))} · Total ${escapeHtml(
      fmt(row.total_cents),
    )}</pre>

        <details style="margin-top:1rem" class="admin-modal-details">
          <summary class="admin-muted">Edit addresses (optional)</summary>
          <p class="admin-muted" style="margin:0.5rem 0;font-size:12px;line-height:1.45">Adjust sender, return, or recipient before buying a label elsewhere. Not required if addresses are already correct.</p>
          <div class="admin-address-grid">
            <div class="admin-address-card">
              <div class="admin-address-card__head">
                <strong>Sender override</strong>
                ${
                  canEditAddresses
                    ? `<button type="button" class="admin-icon-btn" data-toggle-from-override aria-label="Edit sender" title="Edit"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>`
                    : `<span class="admin-muted" style="font-size:11px">Locked</span>`
                }
              </div>
              <div class="admin-address-card__body" style="font-size:13px">${formatAddressFromOverrideJson(row, "shippo_from_address_override_json") || `<span class="admin-muted">Using server warehouse defaults</span>`}</div>
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
            <div class="admin-address-card">
              <div class="admin-address-card__head">
                <strong>Return override</strong>
                ${
                  canEditAddresses
                    ? `<button type="button" class="admin-icon-btn" data-toggle-return-override aria-label="Edit return" title="Edit"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>`
                    : `<span class="admin-muted" style="font-size:11px">Locked</span>`
                }
              </div>
              <div class="admin-address-card__body" style="font-size:13px">${returnBlock}</div>
              <div id="admin-return-override-wrap" class="admin-shipping-edit-wrap" hidden>
                <form id="admin-return-override-form" class="admin-shipping-edit-grid">
                  <label>Name<input name="name" value="${escapeHtml(ovRet.name || "")}" required /></label>
                  <label>Street<input name="line1" value="${escapeHtml(ovRet.line1 || "")}" required /></label>
                  <label>Line 2<input name="line2" value="${escapeHtml(ovRet.line2 || "")}" /></label>
                  <label>City<input name="city" value="${escapeHtml(ovRet.city || "")}" required /></label>
                  <label>State<input name="state" maxlength="2" value="${escapeHtml(ovRet.state || "")}" required /></label>
                  <label>ZIP<input name="postalCode" value="${escapeHtml(ovRet.postalCode || "")}" required /></label>
                  <label>Country<input name="country" maxlength="2" value="${escapeHtml(ovRet.country || "US")}" required /></label>
                  <label>Email<input name="email" type="email" value="${escapeHtml(ovRet.email || "")}" /></label>
                  <label>Phone<input name="phone" value="${escapeHtml(ovRet.phone || "")}" /></label>
                </form>
                <button type="button" class="admin-btn admin-btn--small" data-save-return-override="${escapeHtml(String(row.id))}">Save return</button>
              </div>
            </div>
            <div class="admin-address-card">
              <div class="admin-address-card__head">
                <strong>Recipient</strong>
                ${
                  canEditAddresses
                    ? `<button type="button" class="admin-icon-btn" data-toggle-shipping-edit aria-expanded="false" aria-label="Edit recipient" title="Edit"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>`
                    : `<span class="admin-muted" style="font-size:11px">Locked</span>`
                }
              </div>
              <pre class="admin-address-card__body" style="margin:0;white-space:pre-wrap;font-family:inherit;font-size:13px">${shipToReadonlyEscaped}</pre>
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
          </div>
          ${
            diag.missing.length
              ? `<p class="admin-error" style="margin:0.5rem 0 0">Ship-to incomplete: ${escapeHtml(diag.missing.join(", "))}</p>`
              : ""
          }
          <p id="admin-shipping-save-toast" class="admin-inline-toast admin-inline-toast--success" role="status" hidden></p>
        </details>
      </div>
    </div>

    <div class="admin-fulfillment-panel" data-fulfillment-panel="1" style="display:${tabVis(1)}">
      <div class="admin-modal__section">
        <h3>Label records</h3>
        <p class="admin-muted" style="margin:0 0 0.75rem;font-size:12px;line-height:1.45">After you buy the label outside this dashboard, save carrier, tracking, optional cost and date, and upload the label PDF (and packing slip if you like).</p>
        ${labelLinkHtml}
        ${slipLinkHtml}
        <form id="admin-external-fulfillment-form" class="admin-shipping-edit-grid" style="margin-top:0.85rem">
          <label>Carrier / agent<input name="carrier" type="text" autocomplete="organization" value="${extCarrier}" required placeholder="e.g. UPS, USPS, Pirate Ship" /></label>
          <label>Service (optional)<input name="service" type="text" value="${extService}" placeholder="e.g. UPS Ground" /></label>
          <label>Label cost USD (optional)<input name="labelCost" type="number" min="0" step="0.01" value="${extCostDollars}" placeholder="0.00" /></label>
          <label>Tracking #<input name="trackingNumber" type="text" value="${extTrack}" required /></label>
          <label>Shipment date<input name="shippedDate" type="date" value="${extDate}" /></label>
          <label style="grid-column:1/-1">Shipping label file (PDF or image)<input name="labelFile" type="file" accept="application/pdf,image/*" /></label>
          <label style="grid-column:1/-1">Packing slip file (optional)<input name="packingSlipFile" type="file" accept="application/pdf,image/*" /></label>
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
    </div>

    <div class="admin-fulfillment-panel" data-fulfillment-panel="2" style="display:${tabVis(2)}">
      <div class="admin-modal__section">
        <h3>Shipped</h3>
        ${
          isOrderShipped(row)
            ? `<p style="margin:0">Marked <strong>shipped</strong>${row.admin_handoff_at ? ` on ${escapeHtml(formatDate(row.admin_handoff_at))}` : ""}.</p>
        <ul style="margin:0.75rem 0 0;padding-left:1.1rem;font-size:13px;line-height:1.55">
          <li><strong>Carrier</strong> ${escapeHtml(row.admin_external_carrier || row.shippo_label_carrier || "—")}</li>
          <li><strong>Tracking</strong> ${escapeHtml(row.admin_external_tracking_number || row.shippo_tracking_number || "—")}</li>
        </ul>`
            : `<p class="admin-muted" style="margin:0 0 0.75rem">Confirm after the package has left your hands. You must have saved <strong>carrier</strong>, <strong>tracking</strong>, and an uploaded <strong>shipping label</strong> on the Label records tab (or a legacy Shippo label on file).</p>
        <button type="button" class="admin-btn admin-btn--primary" data-fulfillment-handoff="${escapeHtml(String(row.id))}" ${
            canMarkShipped ? "" : "disabled"
          }>Mark as shipped</button>`
        }
      </div>
    </div>

    <div class="admin-modal__section">
      <h3>Tracking &amp; shipment</h3>
      <ul class="admin-tracking-list" style="margin:0;padding-left:1.1rem;font-size:13px;line-height:1.55">
        <li><strong>Carrier (recorded)</strong> ${escapeHtml(row.admin_external_carrier || row.shippo_label_carrier || "—")}</li>
        <li><strong>Service</strong> ${escapeHtml(row.admin_external_service || row.shippo_label_service || "—")}</li>
        <li><strong>Tracking #</strong> ${escapeHtml(row.admin_external_tracking_number || row.shippo_tracking_number || "—")}</li>
        <li><strong>Label source</strong> ${escapeHtml(row.admin_external_label_storage_path ? "Uploaded" : row.shippo_label_url ? "Shippo" : "—")}</li>
        <li><strong>Shippo tracking status</strong> ${escapeHtml(row.shippo_tracking_status || "—")}</li>
      </ul>
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
    <div class="admin-modal__section admin-modal__section--technical-footer">
      <h3 class="admin-muted" style="margin:0 0 0.5rem;font-size:13px;font-weight:600">Troubleshooting &amp; legacy Shippo</h3>
      <details class="admin-modal-details">
        <summary class="admin-muted">Technical details (legacy Shippo IDs &amp; errors)</summary>
        ${shippoPanelErrorHtml}
        <pre>Shippo synced: ${escapeHtml(shippoSyncLabel(row))}
Shippo order ID: ${escapeHtml(row.shippo_order_id || "—")}
Shippo shipment status: ${escapeHtml(shippoShipmentLabel(row))}
Shipment ready (rates): ${shipmentReadyForRates(row) ? "yes" : "no"}
Parcel count: ${escapeHtml(String(pieceCount))}
Shipment object ID: ${escapeHtml(row.shippo_shipment_object_id || "—")}
Ship / pickup date (order): ${escapeHtml(row.shippo_shipment_date || "—")}
Rate status: ${escapeHtml(row.shippo_shipment_rate_status || "—")}
Tracking (Shippo label): ${escapeHtml(row.shippo_tracking_number || "—")}
Last Shippo sync: ${escapeHtml(formatDate(row.shippo_last_sync_at))}
Order sync error: ${escapeHtml(row.shippo_sync_error || "—")}
Shipment sync error: ${escapeHtml(row.shippo_shipment_sync_error || "—")}
Label purchase error: ${escapeHtml(row.shippo_label_sync_error || "—")}</pre>
      </details>
      <details class="admin-modal-details">
        <summary class="admin-muted">Parcel plan (audit)</summary>
        ${parcelSummaryHtml}
        ${multiNoteHtml}
      </details>
    </div>
  `;
  } catch (e) {
    console.error("[admin] openModal render", e);
    body.innerHTML = `
      <h2>${escapeHtml(row.order_ref || "Order")}</h2>
      <div class="admin-modal__section admin-error">
        <p><strong>Could not render order details</strong></p>
        <p style="margin-top:0.35rem">${escapeHtml(String(e?.message || e || "Error"))}</p>
      </div>`;
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
}

function closeModal() {
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
