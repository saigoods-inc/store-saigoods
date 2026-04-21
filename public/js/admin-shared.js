/**
 * Supabase GoTrue calls `_recoverAndRefresh()` when the tab becomes visible again and may emit
 * `SIGNED_IN` with the same user — not only on a real login. Track the last user we already
 * bootstrapped so `onAuthStateChange` does not re-fetch and strand the UI in "Loading…".
 */
let _adminLastSignedInUserId = null;

/** After `getSession()` or successful login, before loading staff data. */
export function primeAdminSessionUser(session) {
  _adminLastSignedInUserId = session?.user?.id ?? null;
}

export function clearAdminSessionUser() {
  _adminLastSignedInUserId = null;
}

/**
 * @returns {boolean} True if the handler should run load/bootstrap for this `SIGNED_IN`.
 */
export function shouldBootstrapAdminSignedIn(session) {
  const uid = session?.user?.id ?? null;
  if (!uid) {
    return false;
  }
  if (_adminLastSignedInUserId === uid) {
    return false;
  }
  _adminLastSignedInUserId = uid;
  return true;
}

export async function fetchSupabasePublicConfig() {
  const res = await fetch("/api/supabase-public-config");
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || "Could not load configuration.");
  }
  return data;
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * @param {"summary" | "orders" | "tax" | "nexus" | "discounts" | "manual-order" | "walk-in-order" | "inventory"} activeId
 */
export function renderAdminNav(activeId) {
  const el = document.getElementById("admin-nav");
  if (!el) return;
  const links = [
    ["summary", "/admin/summary.html", "Summary"],
    ["orders", "/admin/orders.html", "Orders"],
    ["inventory", "/admin/inventory.html", "Inventory"],
    ["manual-order", "/admin/manual-order.html", "Manual order"],
    ["walk-in-order", "/admin/walk-in-order.html", "Walk-in order"],
    ["discounts", "/admin/discount-codes.html", "Discount codes"],
    ["tax", "/admin/tax.html", "Sales tax (TN)"],
    ["nexus", "/admin/nexus.html", "Nexus by state"],
  ];
  el.innerHTML = `<nav class="admin-nav" aria-label="Staff section">${links
    .map(
      ([id, href, label]) =>
        `<a class="admin-nav__link ${id === activeId ? "is-active" : ""}" href="${href}">${escapeHtml(
          label,
        )}</a>`,
    )
    .join("")}</nav>`;
}

export function formatUsdCents(cents) {
  const n = Number(cents) || 0;
  return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" }).format(n / 100);
}

/**
 * @param {string} path e.g. "/api/tax-summary"
 * @param {string} [accessToken] Supabase session access token (required when INTERNAL_REPORTS_SECRET is set on the server)
 */
export async function fetchReportJson(path, accessToken) {
  const headers = {};
  if (accessToken) {
    headers.Authorization = `Bearer ${accessToken}`;
  }
  const res = await fetch(path, { headers });
  const raw = await res.text();
  let data = {};
  try {
    data = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    data = {};
  }
  if (!res.ok) {
    const fromBody =
      (typeof data.error === "string" && data.error.trim()) ||
      (typeof data.message === "string" && data.message.trim()) ||
      null;
    const statusText = typeof res.statusText === "string" ? res.statusText.trim() : "";
    const statusPart = res.status ? `HTTP ${res.status}` : "";
    const msg =
      fromBody ||
      (statusText ? `${statusText}${statusPart ? ` (${statusPart})` : ""}` : null) ||
      statusPart ||
      (raw.trim().slice(0, 120) || null) ||
      "Request failed.";
    throw new Error(msg);
  }
  return data;
}

/**
 * Thrown by {@link fetchReportPost} on non-OK responses; includes parsed JSON `body` when available.
 */
export class ReportPostError extends Error {
  /**
   * @param {string} message
   * @param {{ status?: number, body?: object }} [meta]
   */
  constructor(message, meta = {}) {
    super(message);
    this.name = "ReportPostError";
    this.status = meta.status;
    this.body = meta.body;
  }
}

/**
 * Authenticated POST for staff APIs (manual order, etc.).
 * @param {string} path
 * @param {string} [accessToken] Supabase session access JWT
 * @param {object} body JSON body
 */
export async function fetchReportPost(path, accessToken, body) {
  const headers = { "Content-Type": "application/json" };
  if (accessToken) {
    headers.Authorization = `Bearer ${accessToken}`;
  }
  const res = await fetch(path, {
    method: "POST",
    headers,
    body: JSON.stringify(body ?? {}),
  });
  const raw = await res.text();
  let data = {};
  try {
    data = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    data = {};
  }
  if (!res.ok) {
    const fromBody =
      (typeof data.error === "string" && data.error.trim()) ||
      (typeof data.message === "string" && data.message.trim()) ||
      null;
    const statusText = typeof res.statusText === "string" ? res.statusText.trim() : "";
    const statusPart = res.status ? `HTTP ${res.status}` : "";
    const msg =
      fromBody ||
      (statusText ? `${statusText}${statusPart ? ` (${statusPart})` : ""}` : null) ||
      statusPart ||
      (raw.trim().slice(0, 120) || null) ||
      "Request failed.";
    throw new ReportPostError(msg, {
      status: res.status,
      body: data,
    });
  }
  return data;
}
