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
 * @param {"orders" | "tax" | "nexus" | "discounts"} activeId
 */
export function renderAdminNav(activeId) {
  const el = document.getElementById("admin-nav");
  if (!el) return;
  const links = [
    ["orders", "/admin/orders.html", "Orders"],
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
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || res.statusText || "Request failed.");
  }
  return data;
}
