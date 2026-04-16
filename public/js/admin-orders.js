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

/** Staff can only set these fulfillment statuses (payment column shows payment state). */
const FULFILLMENT_OPTIONS = [
  ["ready_to_ship", "Ready to ship"],
  ["shipped", "Shipped"],
  ["cancelled", "Cancelled"],
];

let supabase = null;
let ordersCache = [];
const statusLockByOrderId = new Map();

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

/**
 * Visual stepper: paid → label → handoff → shipped (UI only; uses existing row fields).
 */
function buildFulfillmentProgressHtml(row) {
  const fk = normalizeFulfillment(row);
  if (fk === "cancelled") {
    return `<div class="admin-fulfillment-progress admin-fulfillment-progress--cancelled" role="status">
      <p class="admin-fulfillment-progress__title">Fulfillment progress</p>
      <p class="admin-muted" style="margin:0;font-size:13px">This order is <strong>cancelled</strong>.</p>
    </div>`;
  }

  const paid = String(row.status || "").toLowerCase() === "paid";
  const labelPurchased =
    Boolean(String(row.shippo_label_url || "").trim()) &&
    String(row.shippo_transaction_status || "").toUpperCase() === "SUCCESS";
  const shipped = fk === "shipped";

  const steps = ["Order created & paid", "Buying label", "Waiting for pickup / drop-off", "Shipped"];

  let activeIndex = 0;
  if (paid && !labelPurchased) {
    activeIndex = 1;
  } else if (paid && labelPurchased && !shipped) {
    activeIndex = 2;
  } else if (paid && labelPurchased && shipped) {
    activeIndex = 3;
  } else if (!paid) {
    activeIndex = 0;
  }

  function stateFor(i) {
    if (shipped) {
      return "done";
    }
    if (i < activeIndex) {
      return "done";
    }
    if (i === activeIndex) {
      return "active";
    }
    return "pending";
  }

  const chunks = [
    `<div class="admin-fulfillment-progress" aria-label="Fulfillment progress">`,
    `<p class="admin-fulfillment-progress__title">Fulfillment progress</p>`,
    `<div class="admin-fulfillment-progress__track">`,
  ];
  for (let i = 0; i < steps.length; i++) {
    const st = stateFor(i);
    const dot = st === "done" ? "✓" : String(i + 1);
    chunks.push(
      `<div class="admin-fulfillment-progress__step admin-fulfillment-progress__step--${st}"><span class="admin-fulfillment-progress__dot" aria-hidden="true">${dot}</span><span class="admin-fulfillment-progress__label">${escapeHtml(steps[i])}</span></div>`,
    );
    if (i < steps.length - 1) {
      const connDone = stateFor(i) === "done";
      chunks.push(
        `<div class="admin-fulfillment-progress__connector admin-fulfillment-progress__connector--${connDone ? "done" : "pending"}" aria-hidden="true"></div>`,
      );
    }
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
    const payloadBlock = preview.payload
      ? escapeHtml(jsonPrettyOrNull(preview.payload))
      : escapeHtml(preview.payloadError || "Could not build payload.");
    panel.innerHTML = `
      <h4 class="admin-muted" style="margin:0 0 0.35rem;font-size:13px">Server preview (same merge + payload as Shippo sync)</h4>
      <details open>
        <summary class="admin-muted" style="cursor:pointer">Resolved shipping for sync</summary>
        <pre>${escapeHtml(jsonPrettyOrNull(preview.resolvedShippingForSync))}</pre>
      </details>
      <details style="margin-top:0.35rem">
        <summary class="admin-muted" style="cursor:pointer">Raw <code>shipping_address</code> from DB (parsed)</summary>
        <pre>${escapeHtml(jsonPrettyOrNull(preview.rawShippingAddressFromDb))}</pre>
      </details>
      <details style="margin-top:0.35rem">
        <summary class="admin-muted" style="cursor:pointer">Line items (weight / qty)</summary>
        <pre>${escapeHtml(jsonPrettyOrNull(preview.lineItems))}</pre>
      </details>
      <details style="margin-top:0.35rem">
        <summary class="admin-muted" style="cursor:pointer">Final Shippo API payload</summary>
        <pre>${payloadBlock}</pre>
      </details>
      <details style="margin-top:0.35rem">
        <summary class="admin-muted" style="cursor:pointer">Parcel plan (for Shipment / rates)</summary>
        <pre>${
          preview.parcelPlan
            ? escapeHtml(jsonPrettyOrNull(preview.parcelPlan))
            : escapeHtml(preview.parcelError || "—")
        }</pre>
      </details>
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

/**
 * Normalized fulfillment key for filters + dropdown (maps legacy `paid` → ready_to_ship).
 */
function normalizeFulfillment(row) {
  if (isWalkInOrder(row)) {
    const os = String(row.order_status || "");
    if (os === "draft") {
      return "walk_in_draft";
    }
    if (os === "paid") {
      return "walk_in_paid";
    }
    if (os === "cancelled") {
      return "cancelled";
    }
  }
  const os = row.order_status;
  if (os === "draft" || os === "payment_link_sent") {
    return os;
  }
  if (os === "paid") return "ready_to_ship";
  if (FULFILLMENT_OPTIONS.some(([v]) => v === os)) return os;
  if (os === "awaiting_payment") return "awaiting_payment";
  return "awaiting_payment";
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

function fulfillmentLabel(value) {
  const row = FULFILLMENT_OPTIONS.find(([v]) => v === value);
  return row ? row[1] : value;
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

function applyRowStatusTheme(tr, statusValue, locked) {
  if (!tr) return;
  tr.classList.toggle("admin-order-row--shipped", locked && statusValue === "shipped");
  tr.classList.toggle("admin-order-row--cancelled", locked && statusValue === "cancelled");
}

function setStatusRowLocked(tr, locked) {
  if (!tr) return;
  const sel = tr.querySelector("[data-order-status-select]");
  const btn = tr.querySelector("[data-order-status-confirm]");
  const popup = tr.querySelector("[data-order-edit-warning]");
  if (!sel || !btn) return;

  sel.disabled = locked;
  btn.textContent = locked ? "Edit" : "Update";
  btn.dataset.mode = locked ? "edit" : "update";
  if (popup) popup.hidden = true;
  applyRowStatusTheme(tr, sel.value, locked);
}

function bindModalShippoActions() {
  if (document.body.dataset.shippoModalBound === "1") {
    return;
  }
  document.body.dataset.shippoModalBound = "1";

  document.addEventListener("click", (e) => {
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
          const refreshed = ordersCache.find((r) => String(r.id) === String(orderId));
          if (refreshed) {
            openModal(refreshed);
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
          const refreshed = ordersCache.find((r) => String(r.id) === String(orderId));
          if (refreshed) {
            openModal(refreshed);
          }
        } catch (err) {
          if (err instanceof ReportPostError && err.body?.order) {
            const idx = ordersCache.findIndex((r) => String(r.id) === String(orderId));
            if (idx >= 0) {
              ordersCache[idx] = err.body.order;
            }
            renderTable();
            openModal(err.body.order);
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

    const confirmBtn = e.target.closest("[data-order-status-confirm]");
    if (confirmBtn) {
      e.preventDefault();
      const tr = confirmBtn.closest("tr");
      const orderId = tr?.dataset.orderId;
      if (!orderId || !supabase) return;

      const sel = tr.querySelector("[data-order-status-select]");
      if (!sel) return;
      const mode = confirmBtn.dataset.mode || "update";

      if (mode === "edit") {
        const popup = tr.querySelector("[data-order-edit-warning]");
        if (popup) popup.hidden = false;
        return;
      }

      void (async () => {
        const next = sel.value;
        const prev = sel.dataset.prevValue ?? sel.value;
        confirmBtn.disabled = true;
        const originalText = confirmBtn.textContent;
        confirmBtn.textContent = "Saving…";

        const { error } = await supabase.from("orders").update({ order_status: next }).eq("id", orderId);
        confirmBtn.disabled = false;
        confirmBtn.textContent = originalText;

        if (error) {
          alert(error.message);
          sel.value = prev;
          return;
        }

        const row = ordersCache.find((r) => String(r.id) === String(orderId));
        if (row) row.order_status = next;
        sel.dataset.prevValue = next;
        statusLockByOrderId.set(String(orderId), true);
        setStatusRowLocked(tr, true);
      })();
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
        } catch (err) {
          if (err instanceof ReportPostError && err.body?.order) {
            const idx = ordersCache.findIndex((r) => String(r.id) === String(orderId));
            if (idx >= 0) {
              ordersCache[idx] = err.body.order;
            }
            renderTable();
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
        } catch (err) {
          alert(err.message || "Could not refresh Shippo status.");
        } finally {
          shippoRefreshBtn.disabled = false;
          shippoRefreshBtn.textContent = beforeText || "Refresh";
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
            openModal(refreshed, { shippingSaved: true });
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

    const cancelEditBtn = e.target.closest("[data-order-edit-cancel]");
    if (cancelEditBtn) {
      e.preventDefault();
      const popup = cancelEditBtn.closest("[data-order-edit-warning]");
      if (popup) popup.hidden = true;
      return;
    }

    const continueEditBtn = e.target.closest("[data-order-edit-continue]");
    if (continueEditBtn) {
      e.preventDefault();
      const tr = continueEditBtn.closest("tr");
      const orderId = tr?.dataset.orderId;
      if (!tr || !orderId) return;
      statusLockByOrderId.set(String(orderId), false);
      setStatusRowLocked(tr, false);
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
          " Run sql/patch-orders-shippo-schema-complete.sql in the Supabase SQL editor, then execute NOTIFY pgrst, 'reload schema'; (included at end of that file) or use Dashboard → Settings → API → Reload schema.";
      }
      errEl.textContent = msg;
      errEl.hidden = false;
      return;
    }

    ordersCache = Array.isArray(data) ? data : [];
    statusLockByOrderId.clear();
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
    const fk = normalizeFulfillment(r);
    return fk === filter;
  });
}

function currentFulfillmentSelectValue(row) {
  const fk = normalizeFulfillment(row);
  if (fk === "walk_in_draft" || fk === "walk_in_paid") {
    return fk;
  }
  if (FULFILLMENT_OPTIONS.some(([v]) => v === fk)) return fk;
  return "ready_to_ship";
}

function renderTable() {
  const tbody = document.getElementById("orders-tbody");
  const rows = getFilteredOrders();

  tbody.innerHTML = rows
    .map((row) => {
      const id = row.id;
      const orderRef = row.order_ref || "—";
      const os = normalizeFulfillment(row);
      const awaiting = isPaymentAwaiting(row);
      const selectHtml = FULFILLMENT_OPTIONS.map(
        ([value, label]) =>
          `<option value="${escapeHtml(value)}" ${value === currentFulfillmentSelectValue(row) ? "selected" : ""}>${escapeHtml(label)}</option>`,
      ).join("");

      const osRaw = String(row.order_status || "");
      const walkInDraft = isWalkInOrder(row) && osRaw === "draft";
      const walkInPaid = isWalkInOrder(row) && osRaw === "paid";
      const manualDraft =
        String(row.order_source) === "manual" && osRaw === "draft";
      const manualLinkSent =
        String(row.order_source) === "manual" && osRaw === "payment_link_sent";

      const statusCell = walkInDraft
        ? `<div>
            <p class="admin-muted" style="margin:0">Walk-in draft</p>
            <p class="admin-muted" style="margin:0.35rem 0 0;font-size:12px;">Complete on <a href="/admin/walk-in-order.html">Walk-in order</a> page.</p>
          </div>`
        : walkInPaid
          ? `<span class="admin-muted">Paid in store (${escapeHtml(String(row.payment_method || "—"))})</span>`
        : manualDraft
        ? `<div>
            <p class="admin-muted" style="margin:0">Draft</p>
            <button type="button" class="admin-btn admin-btn--small" data-send-pay-link="${escapeHtml(String(id))}" style="margin-top:0.4rem">Email payment link</button>
          </div>`
        : manualLinkSent
          ? `<span class="admin-muted">Payment link sent</span><p class="admin-muted" style="margin:0.35rem 0 0;font-size:12px;">Payment must complete before fulfillment status can be set.</p>`
        : awaiting
          ? `<span class="admin-muted">Awaiting payment</span><p class="admin-muted" style="margin:0.35rem 0 0;font-size:12px;">Payment must complete before fulfillment status can be set.</p>`
          : `<div class="admin-status-actions"><select class="admin-status-select" data-order-status-select aria-label="Fulfillment status" data-prev-value="${escapeHtml(
              currentFulfillmentSelectValue(row),
            )}">${selectHtml}</select><button type="button" class="admin-btn admin-btn--small admin-status-confirm" data-order-status-confirm data-mode="update">Update</button><div class="admin-status-warning" data-order-edit-warning hidden><p class="admin-status-warning__text">Unlock this row to edit status?</p><div class="admin-status-warning__actions"><button type="button" class="admin-btn admin-btn--small" data-order-edit-cancel>Cancel</button><button type="button" class="admin-btn admin-btn--small admin-btn--primary admin-status-warning__continue" data-order-edit-continue>Continue</button></div></div></div>`;

      const locked = statusLockByOrderId.get(String(id)) === true;
      const rowClasses = [
        locked && os === "shipped" ? "admin-order-row--shipped" : "",
        locked && os === "cancelled" ? "admin-order-row--cancelled" : "",
      ]
        .filter(Boolean)
        .join(" ");

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
      const shippoId = String(row.shippo_order_id || "").trim();
      const shippoTracking = String(row.shippo_tracking_number || "").trim();
      const shippoAction = canShippoTableFirstSync(row)
        ? `<button type="button" class="admin-btn admin-btn--small" data-shippo-sync="${escapeHtml(String(id))}" style="margin-top:0.45rem">Sync to Shippo</button>`
        : canShippoTableRefreshRemote(row)
          ? `<button type="button" class="admin-btn admin-btn--small" data-shippo-refresh="${escapeHtml(String(id))}" style="margin-top:0.45rem">Refresh</button>`
          : "";
      const shippoCell = `
        <span class="${shippoSyncBadgeClass(row)}">${escapeHtml(shippoSyncLabel(row))}</span>
        <div class="admin-muted admin-shippo-agent__id">ID: ${escapeHtml(shippoId || "—")}</div>
        <div class="admin-muted">Order ship. status: ${escapeHtml(shippoShipmentLabel(row))}</div>
        <div class="admin-muted">Tracking: ${escapeHtml(shippoTracking || "—")}</div>
        ${shippoAction}
      `;

      return `
        <tr data-order-id="${escapeHtml(String(id))}" class="${rowClasses}">
          <td>
            <div class="admin-order-ref">${escapeHtml(orderRef)}</div>
            <div class="admin-order-id">${escapeHtml(String(id))}</div>
            ${manualTag}
            ${walkInTag}
            ${hardinTag}
          </td>
          <td>${escapeHtml(row.customer_name || "—")}<br /><span class="admin-muted">${escapeHtml(row.customer_email || "")}</span></td>
          <td><span class="${badgeClass(paymentBadgeKey(row))}">${escapeHtml(formatPaymentColumnLabel(row))}</span></td>
          <td>${statusCell}</td>
          <td class="admin-shippo-agent-cell">${shippoCell}</td>
          <td>${escapeHtml(formatDate(row.created_at))}</td>
          <td>
            <button type="button" class="admin-btn admin-btn--small" data-detail-id="${escapeHtml(String(id))}">Details</button>
          </td>
        </tr>
      `;
    })
    .join("");

  tbody.querySelectorAll("[data-order-status-select]").forEach((sel) => {
    sel.addEventListener("focus", () => {
      sel.dataset.prevValue = sel.value;
    });
  });

  tbody.querySelectorAll("tr[data-order-id]").forEach((tr) => {
    const id = tr.dataset.orderId;
    const locked = statusLockByOrderId.get(String(id)) === true;
    setStatusRowLocked(tr, locked);
  });
}

function openModal(row, options = {}) {
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

  let ratesRowsHtml = "";
  let parcelSummaryHtml = "";
  let multiNoteHtml = "";
  let labelBlock = "";
  let buyBlock = "";
  let shippoPanelErrorHtml = "";
  let ratesRefreshBtnHtml = "";

  try {
    const rates = shippoRatesList(row);
    const pickIdx = firstPreferredRateIndex(rates);
    const parcelLines = parcelAuditSummaryLines(row);
    const audit = safeShippoParcelAuditJson(row);
    const multiNote = audit?.multiPieceCarrierNote;
    if (String(row.shippo_shipment_object_id || "").trim()) {
      ratesRefreshBtnHtml = `<button type="button" class="admin-btn admin-btn--small" data-shippo-modal-refresh-rates="${escapeHtml(String(row.id))}">Refresh rates</button>`;
    }
    ratesRowsHtml =
      rates.length === 0
        ? `<p class="admin-muted">No rates loaded yet. Use <strong>Sync to Shippo</strong> on the orders table (or <strong>Refresh</strong> if already linked), then open this section again.</p>`
        : `<div style="overflow:auto;max-width:100%"><table class="admin-table" style="font-size:12px;margin-top:0.25rem;width:100%"><thead><tr><th></th><th>Carrier</th><th>Service</th><th>Est. cost</th><th>Transit</th><th>Rate ID</th></tr></thead><tbody>${rates
            .map((r, idx) => {
              const oid = String(r.object_id || "").trim();
              const ups = isUpsRate(r);
              const transit =
                r.estimated_days != null ? `${r.estimated_days} days` : String(r.duration_terms || "—");
              return `<tr class="${ups ? "admin-shippo-rate--ups" : ""}">
  <td><input type="radio" name="admin-shippo-rate-pick" value="${escapeHtml(oid)}" ${idx === pickIdx ? "checked" : ""} ${!oid ? "disabled" : ""} /></td>
  <td>${escapeHtml(String(r.provider || "—"))}${ups ? ' <span class="admin-muted">(UPS)</span>' : ""}</td>
  <td>${escapeHtml(String(r.servicelevel_name || r.servicelevel_token || "—"))}</td>
  <td>${escapeHtml(formatShippoMoney(r.amount, r.currency))}</td>
  <td>${escapeHtml(transit)}</td>
  <td class="admin-muted" style="word-break:break-all;font-size:11px">${escapeHtml(oid)}</td>
</tr>`;
            })
            .join("")}</tbody></table></div>`;
    parcelSummaryHtml =
      parcelLines.length > 0
        ? `<ul style="margin:0.35rem 0 0;padding-left:1.1rem;font-size:12px;line-height:1.45">${parcelLines
            .map((line) => `<li>${escapeHtml(line)}</li>`)
            .join("")}</ul>`
        : `<p class="admin-muted" style="margin:0.35rem 0 0;font-size:12px">No parcel audit yet — sync or refresh shipment after packing rules apply.</p>`;
    multiNoteHtml =
      multiNote && String(multiNote).trim()
        ? `<p class="admin-muted" style="margin:0.35rem 0 0;font-size:12px;line-height:1.45">${escapeHtml(String(multiNote))}</p>`
        : "";
    const labelPurchased =
      Boolean(String(row.shippo_label_url || "").trim()) &&
      String(row.shippo_transaction_status || "").toUpperCase() === "SUCCESS";
    labelBlock = labelPurchased
      ? `<div style="margin-top:0.65rem;padding:0.6rem;border:1px solid rgba(0,0,0,0.12);border-radius:6px">
  <p style="margin:0 0 0.35rem;font-weight:600">Label purchased</p>
  <p class="admin-muted" style="margin:0.35rem 0">Carrier: ${escapeHtml(row.shippo_label_carrier || "—")} · Service: ${escapeHtml(row.shippo_label_service || "—")}</p>
  <p class="admin-muted" style="margin:0.35rem 0">Tracking: ${escapeHtml(row.shippo_tracking_number || "—")} (${escapeHtml(row.shippo_tracking_status || "—")})</p>
  <p style="margin:0.35rem 0;display:flex;flex-wrap:wrap;gap:0.4rem;align-items:center">
    <a class="admin-btn admin-btn--small admin-btn--primary" href="${escapeHtml(String(row.shippo_label_url))}" target="_blank" rel="noopener">Open / print label</a>
    ${
      row.shippo_tracking_url_provider
        ? `<a class="admin-btn admin-btn--small" href="${escapeHtml(String(row.shippo_tracking_url_provider))}" target="_blank" rel="noopener">Carrier tracking page</a>`
        : ""
    }
  </p>
  <p class="admin-muted" style="margin:0.35rem 0;font-size:11px">Transaction: ${escapeHtml(row.shippo_transaction_id || "—")} · Purchased: ${escapeHtml(formatDate(row.shippo_label_purchased_at))}</p>
</div>`
      : "";
    const canBuy = rates.length > 0 && !labelPurchased;
    buyBlock = canBuy
      ? `<div style="margin-top:0.65rem">
    <button type="button" class="admin-btn admin-btn--small admin-btn--primary" data-shippo-buy-label="${escapeHtml(String(row.id))}">Buy label (selected rate)</button>
    <p class="admin-muted" style="margin:0.35rem 0 0;font-size:11px">Purchases via Shippo Transaction API. Prefer UPS rates for your workflow when available.</p>
  </div>`
      : !labelPurchased
        ? `<p class="admin-muted" style="margin:0.35rem 0 0;font-size:12px">Load rates from Shippo first, then select a rate and buy.</p>`
        : `<p class="admin-muted" style="margin:0.35rem 0 0;font-size:12px">A label is already on file. Void in Shippo if you must repurchase.</p>`;
  } catch (e) {
    console.error("[admin] Shippo modal panel", e);
    shippoPanelErrorHtml = `<div class="admin-error" style="margin:0.35rem 0 0.5rem;padding:0.5rem;border-radius:6px;border:1px solid rgba(180,40,40,0.35);background:rgba(180,40,40,0.06)">
      <strong>Shippo section could not render.</strong>
      <p style="margin:0.35rem 0 0;font-size:13px">${escapeHtml(String(e?.message || e || "Unknown error"))}</p>
      <p class="admin-muted" style="margin:0.35rem 0 0;font-size:12px;line-height:1.45">If the database is missing Shippo columns, run <code>sql/patch-orders-shippo-schema-complete.sql</code> in Supabase SQL Editor, then <code>NOTIFY pgrst, 'reload schema';</code>. Other sections of this dialog still work.</p>
    </div>`;
    ratesRowsHtml = `<p class="admin-muted">—</p>`;
    parcelSummaryHtml = `<p class="admin-muted">—</p>`;
  }

  const body = document.getElementById("order-modal-body");
  try {
    body.innerHTML = `
    <h2>${escapeHtml(row.order_ref || "Order")}</h2>
    <div class="admin-modal__section">${buildFulfillmentProgressHtml(row)}</div>
    <div class="admin-modal__section">
      <h3>Fulfillment / workflow</h3>
      <p><span class="${badgeClass(isPaymentAwaiting(row) ? "awaiting_payment" : currentFulfillmentSelectValue(row))}">${escapeHtml(
        isWalkInOrder(row) && row.order_status === "draft"
          ? "Walk-in draft"
          : isWalkInOrder(row) && row.order_status === "paid"
            ? `Walk-in paid (${String(row.payment_method || "")})`
            : row.order_status === "draft"
              ? "Draft"
              : row.order_status === "payment_link_sent"
                ? "Payment link sent"
                : isPaymentAwaiting(row)
                  ? "Awaiting payment"
                  : fulfillmentLabel(currentFulfillmentSelectValue(row)),
      )}</span></p>
      ${
        String(row.order_source) === "manual" && row.order_status === "payment_link_sent"
          ? `<p class="admin-muted" style="margin:0.35rem 0 0;font-size:12px;">Payment must complete before fulfillment status can be set.</p>`
          : ""
      }
    </div>
    <div class="admin-modal__section">
      <h3>Payment</h3>
      <p>${escapeHtml(formatPaymentColumnLabel(row))} · ID: ${escapeHtml(row.payment_id || "—")}${
        row.paid_at ? ` · Paid at: ${escapeHtml(formatDate(row.paid_at))}` : ""
      }</p>
      ${
        row.payment_link_url
          ? `<p class="admin-muted" style="margin-top:0.5rem;word-break:break-all">Payment link: ${escapeHtml(String(row.payment_link_url))}</p>`
          : ""
      }
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
    <div class="admin-modal__section">
      <h3>Customer</h3>
      <pre>${escapeHtml(row.customer_name || "—")}\n${escapeHtml(row.customer_email || "—")}\n${escapeHtml(row.customer_phone || "—")}</pre>
    </div>
    <div class="admin-modal__section">
      <div class="admin-modal__section-head">
        <h3 style="margin:0">Ship to</h3>
        <button type="button" class="admin-icon-btn" data-toggle-shipping-edit aria-expanded="false" aria-label="Edit shipping address" title="Edit shipping address">
          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        </button>
      </div>
      ${
        diag.missing.length
          ? `<p class="admin-error" style="margin:0.35rem 0 0">Missing for Shippo: ${escapeHtml(diag.missing.join(", "))}</p>`
          : ""
      }
      <pre class="admin-ship-to-readonly">${shipToReadonlyEscaped}</pre>
      <div id="admin-shipping-edit-wrap" class="admin-shipping-edit-wrap" hidden>
        <form id="admin-shipping-edit-form" class="admin-shipping-edit-grid">
        <label>Full name
          <input name="name" value="${escapeHtml(addr.name || "")}" required />
        </label>
        <label>Email
          <input name="email" type="email" value="${escapeHtml(addr.email || "")}" />
        </label>
        <label>Phone
          <input name="phone" value="${escapeHtml(addr.phone || "")}" />
        </label>
        <label>Street
          <input name="line1" value="${escapeHtml(addr.line1 || "")}" required />
        </label>
        <label>Line 2
          <input name="line2" value="${escapeHtml(addr.line2 || "")}" />
        </label>
        <label>City
          <input name="city" value="${escapeHtml(addr.city || "")}" required />
        </label>
        <label>State
          <input name="state" value="${escapeHtml(addr.state || "")}" maxlength="2" required />
        </label>
        <label>ZIP
          <input name="postalCode" value="${escapeHtml(addr.postalCode || "")}" required />
        </label>
        <label>Country
          <input name="country" value="${escapeHtml(addr.country || "")}" maxlength="2" required />
        </label>
      </form>
        <div style="margin-top:0.55rem">
          <button type="button" class="admin-btn admin-btn--small" data-save-shipping-address="${escapeHtml(String(row.id))}">
            Save shipping address
          </button>
        </div>
      </div>
      <p id="admin-shipping-save-toast" class="admin-inline-toast admin-inline-toast--success" role="status" hidden></p>
      <div id="admin-shippo-preview-panel" class="admin-shippo-preview-attach" style="margin-top:0.75rem"></div>
    </div>
    <div class="admin-modal__section">
      <h3>Line items (pack these)</h3>
      <div class="admin-modal__line-items">${
        itemLines.length ? itemLines.map((l) => l.html).join("") : `<p class="admin-muted">—</p>`
      }</div>
    </div>
    <div class="admin-modal__section">
      <h3>Totals</h3>
      <pre>Subtotal: ${escapeHtml(fmt(row.subtotal_cents))}
Shipping: ${escapeHtml(fmt(row.shipping_cents))}
Tax: ${escapeHtml(fmt(row.tax_cents))}
Total: ${escapeHtml(fmt(row.total_cents))}</pre>
    </div>
    <div class="admin-modal__section">
      <details class="admin-modal-shippo-details">
        <summary class="admin-modal-shippo-details__summary"><strong>Shippo</strong> <span class="admin-muted">(order → shipment → rates → label)</span></summary>
        <div class="admin-modal-shippo-details__body">
      ${shippoPanelErrorHtml}
      <pre class="admin-modal-shippo-details__meta">Shippo synced: ${escapeHtml(shippoSyncLabel(row))}
Shippo order ID: ${escapeHtml(row.shippo_order_id || "—")}
Shippo shipment status: ${escapeHtml(shippoShipmentLabel(row))}
Shipment ready (rates): ${shipmentReadyForRates(row) ? "yes" : "no"}
Parcel count: ${escapeHtml(String(pieceCount))}
Shipment object ID: ${escapeHtml(row.shippo_shipment_object_id || "—")}
Rate status: ${escapeHtml(row.shippo_shipment_rate_status || "—")}
Tracking (label): ${escapeHtml(row.shippo_tracking_number || "—")}
Tracking status: ${escapeHtml(row.shippo_tracking_status || "—")}
Last Shippo sync: ${escapeHtml(formatDate(row.shippo_last_sync_at))}
Last Shippo event: ${escapeHtml(formatDate(row.shippo_last_event_at))}
Order sync error: ${escapeHtml(row.shippo_sync_error || "—")}
Shipment sync error: ${escapeHtml(row.shippo_shipment_sync_error || "—")}
Label purchase error: ${escapeHtml(row.shippo_label_sync_error || "—")}</pre>
      <h4 class="admin-muted" style="margin:0.75rem 0 0.35rem;font-size:13px">Parcel summary (audit)</h4>
      ${parcelSummaryHtml}
      ${multiNoteHtml}
      <div class="admin-modal__rates-head">
        <h4 class="admin-muted" style="margin:0;font-size:13px">Available rates</h4>
        ${ratesRefreshBtnHtml}
      </div>
      ${ratesRowsHtml}
      ${labelBlock}
      ${buyBlock}
        </div>
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
        <p class="admin-muted" style="margin-top:0.5rem;font-size:12px;line-height:1.45">If this involves missing Shippo columns, run <code>sql/patch-orders-shippo-schema-complete.sql</code> in Supabase, then reload the API schema.</p>
      </div>`;
  }
  document.getElementById("order-modal").hidden = false;
  void loadShippoPreviewPanel(String(row.id));
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
  document.getElementById("order-modal").hidden = true;
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeModal();
});

init();
