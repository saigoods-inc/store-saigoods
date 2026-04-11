import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.8";
import {
  clearAdminSessionUser,
  fetchReportPost,
  fetchSupabasePublicConfig,
  primeAdminSessionUser,
  renderAdminNav,
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

function formatDate(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  } catch {
    return "—";
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

/**
 * Normalized fulfillment key for filters + dropdown (maps legacy `paid` → ready_to_ship).
 */
function normalizeFulfillment(row) {
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
  if (row.order_status === "payment_link_sent" || (row.order_source === "manual" && row.order_status === "draft")) {
    return "awaiting_payment";
  }
  return "awaiting_payment";
}

function formatPaymentColumnLabel(row) {
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
      errEl.textContent =
        error.message ||
        "Could not load orders. Run sql/orders_admin_rls.sql in Supabase and confirm you are signed in.";
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
      const { lines } = describeLineItems(row.items);
      const itemsCell =
        lines.length === 0
          ? "—"
          : `<ul class="admin-order-items">${lines.map((l) => `<li>${l.html}</li>`).join("")}</ul>`;

      const awaiting = isPaymentAwaiting(row);
      const selectHtml = FULFILLMENT_OPTIONS.map(
        ([value, label]) =>
          `<option value="${escapeHtml(value)}" ${value === currentFulfillmentSelectValue(row) ? "selected" : ""}>${escapeHtml(label)}</option>`,
      ).join("");

      const osRaw = String(row.order_status || "");
      const manualDraft =
        String(row.order_source) === "manual" && osRaw === "draft";
      const manualLinkSent =
        String(row.order_source) === "manual" && osRaw === "payment_link_sent";

      const statusCell = manualDraft
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
          ? `<div class="admin-order-tag admin-order-tag--manual" title="Created from staff dashboard">Phone / manual</div>`
          : "";

      return `
        <tr data-order-id="${escapeHtml(String(id))}" class="${rowClasses}">
          <td>
            <div class="admin-order-ref">${escapeHtml(orderRef)}</div>
            <div class="admin-order-id">${escapeHtml(String(id))}</div>
            ${manualTag}
            ${hardinTag}
          </td>
          <td>${escapeHtml(row.customer_name || "—")}<br /><span class="admin-muted">${escapeHtml(row.customer_email || "")}</span></td>
          <td><span class="${badgeClass(paymentBadgeKey(row))}">${escapeHtml(formatPaymentColumnLabel(row))}</span></td>
          <td>${statusCell}</td>
          <td>${itemsCell}</td>
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

function openModal(row) {
  const { lines: itemLines } = describeLineItems(row.items);
  const fmt = (cents) =>
    new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
      (Number(cents) || 0) / 100,
    );

  const body = document.getElementById("order-modal-body");
  body.innerHTML = `
    <h2>${escapeHtml(row.order_ref || "Order")}</h2>
    <div class="admin-modal__section">
      <h3>Fulfillment / workflow</h3>
      <p><span class="${badgeClass(isPaymentAwaiting(row) ? "awaiting_payment" : currentFulfillmentSelectValue(row))}">${escapeHtml(
        row.order_status === "draft"
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
      <p>${escapeHtml(formatPaymentColumnLabel(row))} · ID: ${escapeHtml(row.payment_id || "—")}</p>
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
      <h3>Ship to</h3>
      <pre>${escapeHtml(row.customer_address || "—")}</pre>
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
  `;
  document.getElementById("order-modal").hidden = false;
}

function closeModal() {
  document.getElementById("order-modal").hidden = true;
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeModal();
});

init();
