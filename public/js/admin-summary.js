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
  setKpiText("kpi-total-revenue", fmtCents(k.totalRevenueCents));
  setKpiText("kpi-total-orders", String(k.totalOrders || 0));
  setKpiText("kpi-shipping-expense", fmtCents(k.totalShippingExpenseCents));
  setKpiText("kpi-platform-fees", fmtCents(k.totalPlatformFeesCents));
  setKpiText("kpi-net-after-variable", fmtCents(k.netAfterVariableCostsCents));
  setKpiText("kpi-aov", fmtCents(k.averageOrderValueCents));
  setKpiText("kpi-avg-shipping", fmtCents(k.averageShippingPerOrderCents));
  setKpiText("kpi-avg-platform-fee", fmtCents(k.averagePlatformFeePerOrderCents));
}

function renderShippingTables(summary) {
  const shipping = summary?.breakdown?.shipping || {};
  setKpiText("shipping-total", fmtCents(shipping.totalShippingExpenseCents));
  setKpiText("shipping-avg", fmtCents(shipping.averageShippingPerOrderCents));

  const carrierBody = document.getElementById("shipping-carrier-tbody");
  const carriers = Array.isArray(shipping.carriers) ? shipping.carriers : [];
  if (carrierBody) {
    if (!carriers.length) {
      carrierBody.innerHTML = `<tr><td colspan="4" class="summary-empty">No carrier shipping records in this range.</td></tr>`;
    } else {
      carrierBody.innerHTML = carriers
        .slice(0, 10)
        .map(
          (row) => `<tr>
            <td>${escapeHtml(row.carrier || "Unknown")}</td>
            <td>${escapeHtml(String(row.orders || 0))}</td>
            <td>${escapeHtml(String(row.knownShippingOrders || 0))}</td>
            <td>${escapeHtml(fmtCents(row.shippingExpenseCents || 0))}</td>
          </tr>`,
        )
        .join("");
    }
  }

  const latestBody = document.getElementById("shipping-latest-tbody");
  const latest = Array.isArray(shipping.latestEntries) ? shipping.latestEntries : [];
  if (latestBody) {
    if (!latest.length) {
      latestBody.innerHTML = `<tr><td colspan="4" class="summary-empty">No shipping expense entries found.</td></tr>`;
    } else {
      latestBody.innerHTML = latest
        .map(
          (row) => `<tr>
            <td>${escapeHtml(row.orderRef || "—")}</td>
            <td>${escapeHtml(fmtDateTime(row.paidAt))}</td>
            <td>${escapeHtml(row.carrier || "Unknown")}</td>
            <td>${escapeHtml(fmtCents(row.shippingExpenseCents || 0))}</td>
          </tr>`,
        )
        .join("");
    }
  }
}

function renderPlatformAndRecent(summary) {
  const fees = summary?.breakdown?.platformFees || {};
  const recent = summary?.breakdown?.recentFinancialActivity || [];
  setKpiText("fees-total", fmtCents(fees.totalPlatformFeesCents));
  setKpiText("fees-avg", fmtCents(fees.averagePlatformFeePerOrderCents));

  const tbody = document.getElementById("recent-financial-tbody");
  if (!tbody) {
    return;
  }
  if (!recent.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="summary-empty">No paid orders in this range.</td></tr>`;
    return;
  }
  tbody.innerHTML = recent
    .map(
      (row) => `<tr>
        <td>${escapeHtml(row.orderRef || "—")}</td>
        <td>${escapeHtml(row.customer || "—")}</td>
        <td>${escapeHtml(fmtDateTime(row.paidAt))}</td>
        <td>${escapeHtml(fmtCents(row.revenueCents || 0))}</td>
        <td>${escapeHtml(row.shippingExpenseCents == null ? "—" : fmtCents(row.shippingExpenseCents))}</td>
        <td>${escapeHtml(fmtCents(row.platformFeeCents || 0))}</td>
        <td>${escapeHtml(fmtCents(row.netCents || 0))}</td>
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
            : `<p class="summary-empty" style="margin:0.45rem 0 0">No alerts in this range.</p>`
        }
      </article>`;
    })
    .join("");
}

function setupCanvasForContainer(canvas) {
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const width = Math.max(240, Math.floor(canvas.clientWidth || 240));
  const height = Math.max(220, Math.floor(canvas.clientHeight || 280));
  canvas.width = Math.floor(width * dpr);
  canvas.height = Math.floor(height * dpr);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, width, height };
}

function drawLineChart(canvas, labels, series) {
  if (!canvas) return;
  const { ctx, width, height } = setupCanvasForContainer(canvas);
  ctx.clearRect(0, 0, width, height);

  const plot = { left: 50, top: 18, right: width - 12, bottom: height - 28 };
  const maxValue = Math.max(1, ...series.flatMap((s) => s.values.map((v) => Number(v) || 0)));
  const count = Math.max(1, labels.length);

  ctx.strokeStyle = "#e5e7eb";
  ctx.lineWidth = 1;
  for (let i = 0; i < 4; i++) {
    const y = plot.top + ((plot.bottom - plot.top) * i) / 3;
    ctx.beginPath();
    ctx.moveTo(plot.left, y);
    ctx.lineTo(plot.right, y);
    ctx.stroke();
  }

  ctx.fillStyle = "#6b7280";
  ctx.font = "11px system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
  ctx.textAlign = "right";
  for (let i = 0; i < 4; i++) {
    const value = Math.round((maxValue * (3 - i)) / 3);
    const y = plot.top + ((plot.bottom - plot.top) * i) / 3;
    ctx.fillText(value >= 1000 ? `${Math.round(value / 1000)}k` : String(value), plot.left - 6, y + 4);
  }

  const xForIndex = (idx) =>
    count === 1 ? (plot.left + plot.right) / 2 : plot.left + ((plot.right - plot.left) * idx) / (count - 1);
  const yForValue = (v) => plot.bottom - ((plot.bottom - plot.top) * (Number(v) || 0)) / maxValue;

  series.forEach((s) => {
    ctx.strokeStyle = s.color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    s.values.forEach((v, i) => {
      const x = xForIndex(i);
      const y = yForValue(v);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  });

  const tickIdx = [0, Math.floor((count - 1) / 2), count - 1].filter((v, i, arr) => arr.indexOf(v) === i);
  ctx.fillStyle = "#6b7280";
  ctx.textAlign = "center";
  tickIdx.forEach((i) => {
    const x = xForIndex(i);
    ctx.fillText(String(labels[i] || "").slice(5), x, height - 10);
  });
}

function drawBarChart(canvas, labels, values, color) {
  if (!canvas) return;
  const { ctx, width, height } = setupCanvasForContainer(canvas);
  ctx.clearRect(0, 0, width, height);
  const plot = { left: 48, top: 18, right: width - 12, bottom: height - 28 };
  const maxValue = Math.max(1, ...values.map((v) => Number(v) || 0));
  const n = Math.max(1, values.length);

  ctx.strokeStyle = "#e5e7eb";
  ctx.lineWidth = 1;
  for (let i = 0; i < 4; i++) {
    const y = plot.top + ((plot.bottom - plot.top) * i) / 3;
    ctx.beginPath();
    ctx.moveTo(plot.left, y);
    ctx.lineTo(plot.right, y);
    ctx.stroke();
  }

  const fullWidth = plot.right - plot.left;
  const barArea = fullWidth / n;
  const barWidth = Math.max(4, Math.min(22, barArea * 0.65));
  values.forEach((raw, i) => {
    const v = Number(raw) || 0;
    const h = ((plot.bottom - plot.top) * v) / maxValue;
    const x = plot.left + i * barArea + (barArea - barWidth) / 2;
    const y = plot.bottom - h;
    ctx.fillStyle = color;
    ctx.fillRect(x, y, barWidth, h);
  });

  const tickIdx = [0, Math.floor((n - 1) / 2), n - 1].filter((v, i, arr) => arr.indexOf(v) === i);
  ctx.fillStyle = "#6b7280";
  ctx.font = "11px system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
  ctx.textAlign = "center";
  tickIdx.forEach((i) => {
    const x = plot.left + i * barArea + barArea / 2;
    ctx.fillText(String(labels[i] || "").slice(5), x, height - 10);
  });
}

function renderCharts(summary) {
  const charts = summary?.charts || {};
  const revenueTrend = Array.isArray(charts.revenueTrend) ? charts.revenueTrend : [];
  const variableCostTrend = Array.isArray(charts.variableCostTrend) ? charts.variableCostTrend : [];
  const netTrend = Array.isArray(charts.netTrend) ? charts.netTrend : [];
  const ordersTrend = Array.isArray(charts.ordersTrend) ? charts.ordersTrend : [];

  drawLineChart(
    document.getElementById("chart-revenue"),
    revenueTrend.map((p) => p.bucketStart),
    [{ color: "#2563eb", values: revenueTrend.map((p) => p.revenueCents) }],
  );

  drawLineChart(
    document.getElementById("chart-variable-costs"),
    variableCostTrend.map((p) => p.bucketStart),
    [
      { color: "#d97706", values: variableCostTrend.map((p) => p.shippingExpenseCents) },
      { color: "#7c3aed", values: variableCostTrend.map((p) => p.platformFeesCents) },
    ],
  );

  drawLineChart(
    document.getElementById("chart-net"),
    netTrend.map((p) => p.bucketStart),
    [{ color: "#059669", values: netTrend.map((p) => p.netCents) }],
  );

  drawBarChart(
    document.getElementById("chart-orders"),
    ordersTrend.map((p) => p.bucketStart),
    ordersTrend.map((p) => p.orders),
    "#0ea5e9",
  );
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
  renderShippingTables(summary);
  renderPlatformAndRecent(summary);
  renderAlerts(summary);
  renderCharts(summary);
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
        renderCharts(lastSummary);
      }
    }, 120);
  });
}

init();
