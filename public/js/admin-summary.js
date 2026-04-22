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
let lastSummary = null;

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
  setKpiText("kpi-net-after-variable", fmtCents(k.netAfterVariableCostsCents));
  setKpiText("kpi-shipping-expense", fmtCents(k.totalShippingExpenseCents));
  setKpiText("kpi-total-orders", String(k.totalOrders || 0));
  setKpiText("kpi-total-revenue", fmtCents(k.totalRevenueCents));
  setKpiText("kpi-avg-shipping", fmtCents(k.averageShippingPerOrderCents));
  setKpiText("kpi-aov", fmtCents(k.averageOrderValueCents));
}

function renderShippingZoneRanking(summary) {
  const tbody = document.getElementById("summary-zone-ranking-tbody");
  if (!tbody) return;
  const shipping = summary?.breakdown?.shipping || {};
  const carriers = Array.isArray(shipping.carriers) ? [...shipping.carriers] : [];
  if (!carriers.length) {
    tbody.innerHTML = `<tr><td colspan="4" class="summary-empty">No shipping records in this range.</td></tr>`;
    return;
  }
  carriers.sort((a, b) => (Number(b.orders) || 0) - (Number(a.orders) || 0));
  tbody.innerHTML = carriers
    .slice(0, 12)
    .map((row, i) => {
      const zone = String(row.carrier || "Unknown").trim() || "Unknown";
      return `<tr>
        <td class="summary-td-rank">${escapeHtml(String(i + 1))}</td>
        <td>${escapeHtml(zone)}</td>
        <td class="summary-td-num">${escapeHtml(String(row.orders || 0))}</td>
        <td class="summary-na summary-td-muted">—</td>
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
    tbody.innerHTML = `<tr><td colspan="6" class="summary-empty">No paid orders in this range.</td></tr>`;
    return;
  }
  tbody.innerHTML = recent
    .slice(0, 20)
    .map(
      (row) => `<tr>
        <td>${escapeHtml(fmtDateTime(row.paidAt))}</td>
        <td>${escapeHtml(row.orderRef || "—")}</td>
        <td>${escapeHtml(row.productPreview || "—")}</td>
        <td>${escapeHtml(row.quantityPreview || "—")}</td>
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

function truncateDonutLegendLabel(s, maxLen) {
  const t = String(s || "").trim();
  if (t.length <= maxLen) return t;
  return `${t.slice(0, Math.max(1, maxLen - 1))}…`;
}

function setupCanvasForContainer(canvas) {
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const width = Math.max(200, Math.floor(canvas.clientWidth || 220));
  const height = Math.max(200, Math.floor(canvas.clientHeight || 240));
  canvas.width = Math.floor(width * dpr);
  canvas.height = Math.floor(height * dpr);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, width, height };
}

function drawDonutChart(canvas, segments) {
  if (!canvas) return;
  const { ctx, width, height } = setupCanvasForContainer(canvas);
  ctx.clearRect(0, 0, width, height);

  const cx = width * 0.36;
  const cy = height / 2;
  const rOuter = Math.min(width, height) * 0.34;
  const rInner = rOuter * 0.58;
  const total = segments.reduce((s, x) => s + Math.max(0, Number(x.value) || 0), 0);

  if (total <= 0) {
    ctx.fillStyle = "#9ca3af";
    ctx.font = "13px system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("No product line revenue in this range", cx, cy);
    return;
  }

  let angle = -Math.PI / 2;
  segments.forEach((seg) => {
    const v = Math.max(0, Number(seg.value) || 0);
    const slice = (v / total) * Math.PI * 2;
    ctx.beginPath();
    ctx.fillStyle = seg.color;
    ctx.arc(cx, cy, rOuter, angle, angle + slice, false);
    ctx.arc(cx, cy, rInner, angle + slice, angle, true);
    ctx.closePath();
    ctx.fill();
    angle += slice;
  });

  ctx.font = "600 11px system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
  ctx.textAlign = "left";
  const legendX = width * 0.56;
  let ly = Math.max(16, cy - rOuter * 0.52);
  const maxLabelChars = Math.max(18, Math.floor((width - legendX - 12) / 6.2));
  segments.forEach((seg) => {
    const pct = Math.round(((Number(seg.value) || 0) / total) * 1000) / 10;
    const label = truncateDonutLegendLabel(seg.label, maxLabelChars);
    ctx.fillStyle = seg.color;
    ctx.fillRect(legendX, ly, 9, 9);
    ctx.fillStyle = "#4b5563";
    ctx.fillText(`${label} (${pct}%)`, legendX + 14, ly + 8);
    ly += 17;
  });
}

function renderProductDonut(summary) {
  const canvas = document.getElementById("chart-product-donut");
  const rows = Array.isArray(summary?.breakdown?.productRanking) ? summary.breakdown.productRanking : [];
  const total = rows.reduce((s, r) => s + Math.max(0, Number(r.revenueCents) || 0), 0);
  const palette = ["#2563eb", "#0d9488", "#6366f1", "#d97706", "#db2777", "#94a3b8"];
  if (!rows.length || total <= 0) {
    drawDonutChart(canvas, []);
    return;
  }
  const top = rows.slice(0, 5);
  const topSum = top.reduce((s, r) => s + Math.max(0, Number(r.revenueCents) || 0), 0);
  const other = Math.max(0, total - topSum);
  const segs = top.map((r, i) => ({
    label: String(r.name || r.slug || "Product").trim() || "Product",
    value: Math.max(0, Number(r.revenueCents) || 0),
    color: palette[i % 5],
  }));
  if (other > 0) {
    segs.push({ label: "Other products", value: other, color: palette[5] });
  }
  drawDonutChart(canvas, segs);
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
  lastSummary = summary;
  renderMeta(summary);
  renderKpis(summary);
  renderAlerts(summary);
  renderProductDonut(summary);
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
      lastSummary = null;
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

  let resizeTimer = null;
  window.addEventListener("resize", () => {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
      if (lastSummary) {
        renderProductDonut(lastSummary);
      }
    }, 120);
  });
}

init();
