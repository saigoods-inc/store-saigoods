import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.8";

const STATUS_OPTIONS = [
  ["awaiting_payment", "Awaiting payment"],
  ["paid", "Paid"],
  ["ready_to_ship", "Ready to ship"],
  ["shipped", "Shipped"],
  ["cancelled", "Cancelled"],
];

let supabase = null;
let ordersCache = [];

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

function normalizeOrderStatus(row) {
  const s = row.order_status;
  if (s && STATUS_OPTIONS.some(([v]) => v === s)) return s;
  if (row.status === "paid") return "paid";
  return "awaiting_payment";
}

function describeLineItems(items) {
  if (!Array.isArray(items) || !items.length) {
    return { lines: [], text: "—" };
  }
  const lines = items.map((it) => {
    const name = it.name || it.slug || "Product";
    const cases = Number(it.lineCases);
    const qty = Number.isFinite(cases) ? cases : 0;
    const bundle = Array.isArray(it.bundleLines) && it.bundleLines.length ? " (bundle)" : "";
    return { html: `<strong>${escapeHtml(name)}</strong> — ${qty} case(s)${escapeHtml(bundle)}` };
  });
  const text = items
    .map((it) => {
      const name = it.name || it.slug || "Product";
      const cases = Number(it.lineCases);
      const qty = Number.isFinite(cases) ? cases : 0;
      const bundle = Array.isArray(it.bundleLines) && it.bundleLines.length ? " (bundle)" : "";
      return `${name} — ${qty} case(s)${bundle}`;
    })
    .join("\n");
  return { lines, text };
}

function badgeClass(orderStatus) {
  const k = String(orderStatus || "awaiting_payment").replace(/[^a-z_]/gi, "_");
  return `admin-badge admin-badge--${k}`;
}

function statusLabel(value) {
  const row = STATUS_OPTIONS.find(([v]) => v === value);
  return row ? row[1] : value;
}

async function loadPublicConfig() {
  const res = await fetch("/api/supabase-public-config");
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || "Could not load configuration.");
  }
  return data;
}

function showLogin() {
  document.getElementById("admin-login").hidden = false;
  document.getElementById("admin-app").hidden = true;
}

function showApp() {
  document.getElementById("admin-login").hidden = true;
  document.getElementById("admin-app").hidden = false;
}

async function init() {
  let config;
  try {
    config = await loadPublicConfig();
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
    await loadOrders();
  } else {
    showLogin();
  }

  supabase.auth.onAuthStateChange(async (event, session) => {
    if (event === "SIGNED_IN" && session?.user) {
      document.getElementById("admin-user-email").textContent = session.user.email || "";
      showApp();
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
    }
  });

  document.getElementById("admin-logout")?.addEventListener("click", async () => {
    await supabase.auth.signOut();
  });

  document.getElementById("admin-refresh")?.addEventListener("click", () => loadOrders());

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
    .select(
      "id, order_ref, status, order_status, customer_name, customer_email, customer_phone, customer_address, items, created_at, payment_id, subtotal_cents, shipping_cents, tax_cents, total_cents",
    )
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
  return ordersCache.filter((r) => normalizeOrderStatus(r) === filter);
}

function renderTable() {
  const tbody = document.getElementById("orders-tbody");
  const rows = getFilteredOrders();

  tbody.innerHTML = rows
    .map((row) => {
      const id = row.id;
      const orderRef = row.order_ref || "—";
      const os = normalizeOrderStatus(row);
      const { lines } = describeLineItems(row.items);
      const itemsCell =
        lines.length === 0
          ? "—"
          : `<ul class="admin-order-items">${lines.map((l) => `<li>${l.html}</li>`).join("")}</ul>`;

      const selectHtml = STATUS_OPTIONS.map(
        ([value, label]) =>
          `<option value="${escapeHtml(value)}" ${value === os ? "selected" : ""}>${escapeHtml(label)}</option>`,
      ).join("");

      return `
        <tr data-order-id="${escapeHtml(id)}">
          <td>
            <div class="admin-order-ref">${escapeHtml(orderRef)}</div>
            <div class="admin-order-id">${escapeHtml(id)}</div>
          </td>
          <td>${escapeHtml(row.customer_name || "—")}<br /><span class="admin-muted">${escapeHtml(row.customer_email || "")}</span></td>
          <td><span class="${badgeClass(row.status === "paid" ? "paid" : "awaiting_payment")}">${escapeHtml(formatPaymentStatus(row.status))}</span></td>
          <td>
            <select class="admin-status-select" data-order-status-select aria-label="Order status">
              ${selectHtml}
            </select>
          </td>
          <td>${itemsCell}</td>
          <td>${escapeHtml(formatDate(row.created_at))}</td>
          <td>
            <button type="button" class="admin-btn admin-btn--small" data-detail-id="${escapeHtml(id)}">Details</button>
          </td>
        </tr>
      `;
    })
    .join("");

  tbody.querySelectorAll("[data-order-status-select]").forEach((sel) => {
    const tr = sel.closest("tr");
    const orderId = tr?.dataset.orderId;
    sel.addEventListener("focus", () => {
      sel.dataset.prevValue = sel.value;
    });
    sel.addEventListener("change", async () => {
      const prev = sel.dataset.prevValue ?? sel.value;
      const next = sel.value;
      const { error } = await supabase.from("orders").update({ order_status: next }).eq("id", orderId);
      if (error) {
        alert(error.message);
        sel.value = prev;
        return;
      }
      const row = ordersCache.find((r) => r.id === orderId);
      if (row) row.order_status = next;
      sel.dataset.prevValue = next;
    });
  });

  tbody.querySelectorAll("[data-detail-id]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-detail-id");
      const row = ordersCache.find((r) => r.id === id);
      if (row) openModal(row);
    });
  });
}

function openModal(row) {
  const os = normalizeOrderStatus(row);
  const { text: itemsText } = describeLineItems(row.items);
  const fmt = (cents) =>
    new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
      (Number(cents) || 0) / 100,
    );

  const body = document.getElementById("order-modal-body");
  body.innerHTML = `
    <h2>${escapeHtml(row.order_ref || "Order")}</h2>
    <div class="admin-modal__section">
      <h3>Order status</h3>
      <p><span class="${badgeClass(os)}">${escapeHtml(statusLabel(os))}</span></p>
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
      <pre>${escapeHtml(itemsText)}</pre>
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
