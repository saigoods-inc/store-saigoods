import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.8";
import { fetchSupabasePublicConfig, renderAdminNav } from "./admin-shared.js";

/** Staff can only set these fulfillment statuses (payment column shows payment state). */
const FULFILLMENT_OPTIONS = [
  ["ready_to_ship", "Ready to ship"],
  ["shipped", "Shipped"],
  ["cancelled", "Cancelled"],
];

let supabase = null;
let ordersCache = [];

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

/** True if payment is not complete — staff cannot set fulfillment yet. */
function isPaymentAwaiting(row) {
  return String(row.status || "").toLowerCase() !== "paid";
}

/**
 * Normalized fulfillment key for filters + dropdown (maps legacy `paid` → ready_to_ship).
 */
function normalizeFulfillment(row) {
  const os = row.order_status;
  if (os === "paid") return "ready_to_ship";
  if (FULFILLMENT_OPTIONS.some(([v]) => v === os)) return os;
  if (os === "awaiting_payment") return "awaiting_payment";
  return "awaiting_payment";
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
    textLines.push("Bundle:");
    bundleRows.forEach((r) => textLines.push(`  ${r}`));
  }
  if (sizeRows.length) {
    textLines.push("Size:");
    sizeRows.forEach((r) => textLines.push(`  ${r}`));
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
    htmlParts.push(`<div><strong>Bundle:</strong></div>`);
    bundleRows.forEach((r) => htmlParts.push(`<div class="admin-pack-line__sub">${escapeHtml(r)}</div>`));
  }
  if (sizeRows.length) {
    htmlParts.push(`<div><strong>Size:</strong></div>`);
    sizeRows.forEach((r) => htmlParts.push(`<div class="admin-pack-line__sub">${escapeHtml(r)}</div>`));
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

function bindOrdersTableEvents() {
  const table = document.getElementById("orders-table");
  if (!table || table.dataset.delegationBound === "1") {
    return;
  }
  table.dataset.delegationBound = "1";

  table.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-detail-id]");
    if (!btn) return;
    e.preventDefault();
    const id = btn.getAttribute("data-detail-id");
    const row = ordersCache.find((r) => String(r.id) === String(id));
    if (row) openModal(row);
  });

  table.addEventListener("change", (e) => {
    const sel = e.target.closest("[data-order-status-select]");
    if (!sel) return;
    const tr = sel.closest("tr");
    const orderId = tr?.dataset.orderId;
    if (!orderId || !supabase) return;

    const next = sel.value;
    void (async () => {
      const prev = sel.dataset.prevValue ?? sel.value;
      const { error } = await supabase.from("orders").update({ order_status: next }).eq("id", orderId);
      if (error) {
        alert(error.message);
        sel.value = prev;
        return;
      }
      const row = ordersCache.find((r) => String(r.id) === String(orderId));
      if (row) row.order_status = next;
      sel.dataset.prevValue = next;
    })();
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
      document.getElementById("admin-user-email").textContent = session.user.email || "";
      showApp();
      renderAdminNav("orders");
      await loadCatalog();
      bindOrdersTableEvents();
      await loadOrders();
    }
    if (event === "SIGNED_OUT") {
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

  document.querySelectorAll("[data-close-modal]").forEach((el) => {
    el.addEventListener("click", closeModal);
  });
}

async function loadOrders() {
  const loading = document.getElementById("admin-loading");
  const errEl = document.getElementById("admin-load-error");
  errEl.hidden = true;
  loading.hidden = false;

  const { data, error } = await supabase
    .from("orders")
    .select("*")
    .order("created_at", { ascending: false });

  loading.hidden = true;

  if (error) {
    errEl.textContent =
      error.message ||
      "Could not load orders. Run sql/orders_admin_rls.sql in Supabase and confirm you are signed in.";
    errEl.hidden = false;
    return;
  }

  ordersCache = Array.isArray(data) ? data : [];
  renderTable();
}

function getFilteredOrders() {
  const filter = document.getElementById("filter-status")?.value || "";
  if (!filter) return ordersCache;
  return ordersCache.filter((r) => {
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

      const statusCell = awaiting
        ? `<span class="admin-muted">Awaiting payment</span><p class="admin-muted" style="margin:0.35rem 0 0;font-size:12px;">Payment must complete before fulfillment status can be set.</p>`
        : `<select class="admin-status-select" data-order-status-select aria-label="Fulfillment status" data-prev-value="${escapeHtml(currentFulfillmentSelectValue(row))}">${selectHtml}</select>`;

      return `
        <tr data-order-id="${escapeHtml(String(id))}">
          <td>
            <div class="admin-order-ref">${escapeHtml(orderRef)}</div>
            <div class="admin-order-id">${escapeHtml(String(id))}</div>
          </td>
          <td>${escapeHtml(row.customer_name || "—")}<br /><span class="admin-muted">${escapeHtml(row.customer_email || "")}</span></td>
          <td><span class="${badgeClass(row.status === "paid" ? "paid" : "awaiting_payment")}">${escapeHtml(formatPaymentStatus(row.status))}</span></td>
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
      <h3>Fulfillment</h3>
      <p><span class="${badgeClass(isPaymentAwaiting(row) ? "awaiting_payment" : currentFulfillmentSelectValue(row))}">${escapeHtml(isPaymentAwaiting(row) ? "Awaiting payment" : fulfillmentLabel(currentFulfillmentSelectValue(row)))}</span></p>
    </div>
    <div class="admin-modal__section">
      <h3>Payment</h3>
      <p>${escapeHtml(formatPaymentStatus(row.status))} · ID: ${escapeHtml(row.payment_id || "—")}</p>
    </div>
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
