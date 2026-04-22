import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.8";
import {
  clearAdminSessionUser,
  fetchReportJson,
  fetchSupabasePublicConfig,
  formatUsdCents,
  primeAdminSessionUser,
  renderAdminNav,
  shouldBootstrapAdminSignedIn,
} from "./admin-shared.js";

let supabase = null;

const rangeState = {
  preset: "last30",
  start: "",
  end: "",
};

function showLogin() {
  document.getElementById("admin-login").hidden = false;
  document.getElementById("admin-app").hidden = true;
}

function showApp() {
  document.getElementById("admin-login").hidden = true;
  document.getElementById("admin-app").hidden = false;
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtCents(cents) {
  return formatUsdCents(Number(cents) || 0);
}

function fmtDateTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString();
}

/** Recent purchases: Apr 21 26, 1:43 PM (local, 12h, no seconds). */
function fmtPaidAtSummary(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const mo = months[d.getMonth()];
  const day = d.getDate();
  const yr = String(d.getFullYear()).slice(-2);
  let h = d.getHours();
  const m = d.getMinutes();
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12;
  if (h === 0) h = 12;
  const mm = String(m).padStart(2, "0");
  return `${mo} ${day} ${yr}, ${h}:${mm} ${ampm}`;
}

function updateRangeControlsVisibility() {
  const isCustom = rangeState.preset === "custom";
  const a = document.getElementById("summary-custom-start-wrap");
  const b = document.getElementById("summary-custom-end-wrap");
  if (a) a.hidden = !isCustom;
  if (b) b.hidden = !isCustom;
}

function buildSummaryApiPath() {
  const p = new URLSearchParams();
  p.set("preset", rangeState.preset || "last30");
  if (rangeState.preset === "custom") {
    if (rangeState.start) p.set("start", rangeState.start);
    if (rangeState.end) p.set("end", rangeState.end);
  }
  return `/api/admin-summary?${p.toString()}`;
}

function setKpiText(id, text) {
  const el = document.getElementById(id);
  if (el) {
    el.textContent = text;
  }
}

function renderKpis(summary) {
  const k = summary?.kpis || {};
  const profitRows = Number(k.currentProfitSnapshotOrders) || 0;
  setKpiText("kpi-net-after-variable", profitRows > 0 ? fmtCents(k.currentProfitCents) : "—");
  setKpiText("kpi-shipping-expense", fmtCents(k.totalShippingExpenseCents));
  const shipVarOrders = Number(k.shippingVarianceOrders) || 0;
  setKpiText(
    "kpi-profit-from-shipping",
    shipVarOrders > 0 ? fmtCents(k.totalShippingVarianceCents) : "—",
  );
  setKpiText("kpi-total-orders", String(k.totalOrders || 0));
  setKpiText("kpi-total-revenue", fmtCents(k.totalRevenueCents));
  setKpiText("kpi-avg-shipping", fmtCents(k.averageShippingPerOrderCents));
  setKpiText("kpi-aov", fmtCents(k.averageOrderValueCents));
}

function renderShippingZoneRanking(summary) {
  const tbody = document.getElementById("summary-zone-ranking-tbody");
  if (!tbody) return;
  const shipping = summary?.breakdown?.shipping || {};
  const zones = Array.isArray(shipping.zones) ? [...shipping.zones] : [];
  if (!zones.length) {
    tbody.innerHTML = `<tr><td colspan="4" class="summary-empty">No US ZIP on file for orders in this range.</td></tr>`;
    return;
  }
  zones.sort((a, b) => (Number(b.orders) || 0) - (Number(a.orders) || 0));
  tbody.innerHTML = zones
    .slice(0, 12)
    .map((row, i) => {
      const z = Number(row.zone);
      const zoneLabel = Number.isFinite(z) ? String(z) : "—";
      const w = row.totalWeightLb;
      const weightCell =
        w != null && Number.isFinite(Number(w)) ? `${escapeHtml(String(row.totalWeightLb))} lb` : "—";
      return `<tr>
        <td class="summary-td-rank">${escapeHtml(String(i + 1))}</td>
        <td>${escapeHtml(zoneLabel)}</td>
        <td class="summary-td-num">${escapeHtml(String(row.orders || 0))}</td>
        <td class="summary-td-num">${weightCell}</td>
      </tr>`;
    })
    .join("");
}

function renderRecentPurchasesTable(summary) {
  const tbody = document.getElementById("summary-recent-purchases-tbody");
  if (!tbody) return;
  const recent = Array.isArray(summary?.breakdown?.recentFinancialActivity)
    ? summary.breakdown.recentFinancialActivity
    : [];
  if (!recent.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="summary-empty">No paid orders in this range.</td></tr>`;
    return;
  }
  tbody.innerHTML = recent
    .slice(0, 20)
    .map(
      (row) => `<tr>
        <td>${escapeHtml(fmtPaidAtSummary(row.paidAt))}</td>
        <td>${escapeHtml(row.orderRef || "—")}</td>
        <td>${escapeHtml(row.productPreview || "—")}</td>
        <td>${escapeHtml(row.quantityPreview || "—")}</td>
        <td class="summary-td-num">${escapeHtml(row.shippingCostCents != null ? fmtCents(row.shippingCostCents) : "—")}</td>
        <td>${escapeHtml(row.customer || "—")}</td>
        <td class="summary-td-num">${escapeHtml(fmtCents(row.revenueCents || 0))}</td>
      </tr>`,
    )
    .join("");
}

function renderProductRankingTable(summary) {
  const tbody = document.getElementById("summary-product-ranking-tbody");
  if (!tbody) return;
  const rows = Array.isArray(summary?.breakdown?.productRanking) ? summary.breakdown.productRanking : [];
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="4" class="summary-empty">No line items in this range.</td></tr>`;
    return;
  }
  tbody.innerHTML = rows
    .slice(0, 25)
    .map(
      (r) => `<tr>
        <td>${escapeHtml(String(r.name || "—"))}</td>
        <td class="summary-td-mono">${escapeHtml(String(r.slug || "—"))}</td>
        <td class="summary-td-num">${escapeHtml(String(r.quantityUnits ?? 0))}</td>
        <td class="summary-td-num">${escapeHtml(fmtCents(r.revenueCents || 0))}</td>
      </tr>`,
    )
    .join("");
}

function renderAlerts(summary) {
  const alerts = summary?.alerts || {};
  const listEl = document.getElementById("alerts-list");
  if (!listEl) return;

  const cards = [
    {
      title: "Orders missing shipping cost",
      data: alerts.missingShippingCost,
      rowText: (r) => `${r.orderRef || "—"} · ${fmtDateTime(r.paidAt)}`,
      warn: true,
    },
    {
      title: "Paid orders not yet fulfilled",
      data: alerts.paidNotFulfilled,
      rowText: (r) => `${r.orderRef || "—"} · status ${r.orderStatus || "paid"}`,
      warn: true,
    },
    {
      title: "Orders with unusually high shipping expense",
      data: alerts.unusuallyHighShipping,
      rowText: (r) =>
        `${r.orderRef || "—"} · shipping ${fmtCents(r.shippingExpenseCents || 0)} on revenue ${fmtCents(r.revenueCents || 0)}`,
      warn: true,
    },
    {
      title: "Fee calculation issues",
      data: alerts.feeCalculationIssues,
      rowText: (r) => `${r.orderRef || "—"} · ${r.reason || "Invalid fee data"}`,
      warn: false,
    },
  ];

  listEl.innerHTML = cards
    .map((c) => {
      const count = Number(c?.data?.count) || 0;
      const rows = Array.isArray(c?.data?.rows) ? c.data.rows : [];
      return `<article class="summary-alert-card ${c.warn ? "summary-alert-card--warn" : ""}">
        <div class="summary-alert-card__head">
          <p class="summary-alert-card__title">${escapeHtml(c.title)}</p>
          <p class="summary-alert-card__count">${escapeHtml(String(count))}</p>
        </div>
        ${
          rows.length
            ? `<ul>${rows
                .slice(0, 4)
                .map((r) => `<li>${escapeHtml(c.rowText(r))}</li>`)
                .join("")}</ul>`
            : `<p class="summary-empty">No alerts in this range.</p>`
        }
      </article>`;
    })
    .join("");
}

function renderMeta(summary) {
  const meta = document.getElementById("summary-meta");
  if (!meta) return;
  const r = summary?.dateRange;
  meta.textContent = r
    ? `Updated ${new Date(summary.generatedAt).toLocaleString()} · Range ${r.start} to ${r.end} · Bucket ${r.bucketMode}`
    : "—";
}

function renderSummary(summary) {
  renderMeta(summary);
  renderKpis(summary);
  renderAlerts(summary);
  renderShippingZoneRanking(summary);
  renderRecentPurchasesTable(summary);
  renderProductRankingTable(summary);
}

async function loadSummary() {
  const errEl = document.getElementById("admin-load-error");
  const loading = document.getElementById("admin-loading");
  errEl.hidden = true;

  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session?.access_token) {
    errEl.textContent = "No session — sign in again.";
    errEl.hidden = false;
    return;
  }

  loading.hidden = false;
  try {
    const data = await fetchReportJson(buildSummaryApiPath(), session.access_token);
    renderSummary(data);
  } catch (e) {
    errEl.textContent = e.message || "Could not load summary.";
    errEl.hidden = false;
  } finally {
    loading.hidden = true;
  }
}

function bindSummaryControls() {
  const preset = document.getElementById("summary-range-preset");
  const start = document.getElementById("summary-custom-start");
  const end = document.getElementById("summary-custom-end");

  preset?.addEventListener("change", () => {
    rangeState.preset = String(preset.value || "last30");
    updateRangeControlsVisibility();
  });

  start?.addEventListener("change", () => {
    rangeState.start = String(start.value || "").trim();
  });
  end?.addEventListener("change", () => {
    rangeState.end = String(end.value || "").trim();
  });

  document.getElementById("summary-apply-range")?.addEventListener("click", async () => {
    if (rangeState.preset === "custom" && (!rangeState.start || !rangeState.end)) {
      const errEl = document.getElementById("admin-load-error");
      errEl.textContent = "Custom range requires start and end dates.";
      errEl.hidden = false;
      return;
    }
    await loadSummary();
  });

  document.getElementById("admin-refresh")?.addEventListener("click", async () => {
    await loadSummary();
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

  const presetEl = document.getElementById("summary-range-preset");
  if (presetEl) {
    presetEl.value = rangeState.preset;
  }
  updateRangeControlsVisibility();
  bindSummaryControls();

  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (session?.user) {
    primeAdminSessionUser(session);
    showApp();
    document.getElementById("admin-user-email").textContent = session.user.email || "";
    renderAdminNav("summary");
    await loadSummary();
  } else {
    showLogin();
  }

  supabase.auth.onAuthStateChange(async (event, sessionAfter) => {
    if (event === "SIGNED_IN" && sessionAfter?.user) {
      if (!shouldBootstrapAdminSignedIn(sessionAfter)) {
        return;
      }
      document.getElementById("admin-user-email").textContent = sessionAfter.user.email || "";
      showApp();
      renderAdminNav("summary");
      await loadSummary();
    }
    if (event === "SIGNED_OUT") {
      clearAdminSessionUser();
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
    renderAdminNav("summary");
    await loadSummary();
  });

  document.getElementById("admin-logout")?.addEventListener("click", async () => {
    await supabase.auth.signOut();
  });

}

init();
