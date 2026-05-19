import {
  clearAdminSessionUser,
  createSupabaseAdminClient,
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
  const applyWrap = document.getElementById("summary-apply-wrap");
  if (a) a.hidden = !isCustom;
  if (b) b.hidden = !isCustom;
  if (applyWrap) applyWrap.hidden = !isCustom;
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

function isDisplayedNegativeValue(text) {
  const t = String(text ?? "").trim();
  if (!t || t === "—") return false;
  return t.startsWith("-");
}

function setKpiText(id, text, options = {}) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text;
  const styleMoney = options.styleMoney === true;
  if (styleMoney && isDisplayedNegativeValue(text)) {
    el.classList.add("summary-value--negative");
  } else {
    el.classList.remove("summary-value--negative");
  }
}

function renderKpis(summary) {
  const k = summary?.kpis || {};
  const profitRows = Number(k.currentProfitSnapshotOrders) || 0;
  setKpiText("kpi-net-after-variable", profitRows > 0 ? fmtCents(k.currentProfitCents) : "—", {
    styleMoney: profitRows > 0,
  });
  setKpiText("kpi-shipping-expense", fmtCents(k.totalShippingExpenseCents), { styleMoney: true });
  const shipVarOrders = Number(k.shippingVarianceOrders) || 0;
  setKpiText(
    "kpi-profit-from-shipping",
    shipVarOrders > 0 ? fmtCents(k.totalShippingVarianceCents) : "—",
    { styleMoney: shipVarOrders > 0 },
  );
  setKpiText("kpi-total-orders", String(k.totalOrders || 0));
  setKpiText("kpi-total-revenue", fmtCents(k.totalRevenueCents), { styleMoney: true });
  setKpiText("kpi-avg-shipping", fmtCents(k.averageShippingPerOrderCents), { styleMoney: true });
  setKpiText("kpi-aov", fmtCents(k.averageOrderValueCents), { styleMoney: true });
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
    tbody.innerHTML = `<tr><td colspan="8" class="summary-empty">No paid orders in this range.</td></tr>`;
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
        <td class="summary-td-num">${escapeHtml(row.shippingChargedToCustomerCents != null ? fmtCents(row.shippingChargedToCustomerCents) : "—")}</td>
        <td class="summary-td-num">${escapeHtml(row.actualLabelCostCents != null ? fmtCents(row.actualLabelCostCents) : "—")}</td>
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

const PRODUCT_RANKING_CHART_COLORS = ["#6366f1", "#8b5cf6", "#0ea5e9", "#14b8a6", "#94a3b8"];

function renderProductRankingChart(summary) {
  const chartRoot = document.getElementById("summary-product-ranking-chart");
  const legendEl = document.getElementById("summary-product-ranking-chart-legend");
  if (!chartRoot || !legendEl) return;

  const rows = Array.isArray(summary?.breakdown?.productRanking) ? summary.breakdown.productRanking : [];
  const sorted = [...rows].sort((a, b) => (Number(b.revenueCents) || 0) - (Number(a.revenueCents) || 0));
  const top4 = sorted.slice(0, 4);
  const rest = sorted.slice(4);
  const restSum = rest.reduce((s, r) => s + Math.max(0, Math.round(Number(r.revenueCents) || 0)), 0);

  /** @type {{ name: string, revenueCents: number }[]} */
  const segments = top4.map((r) => ({
    name: String(r.name || r.slug || "—").trim() || "—",
    revenueCents: Math.max(0, Math.round(Number(r.revenueCents) || 0)),
  }));
  if (restSum > 0) {
    segments.push({ name: "Other", revenueCents: restSum });
  }

  const total = segments.reduce((s, x) => s + x.revenueCents, 0);
  if (!segments.length || total <= 0) {
    chartRoot.classList.add("is-empty");
    chartRoot.innerHTML = `<p class="summary-chart-empty">No product data for this range.</p>`;
    legendEl.innerHTML = "";
    return;
  }

  chartRoot.classList.remove("is-empty");

  let angle = 0;
  const stops = [];
  for (let i = 0; i < segments.length; i++) {
    const start = angle;
    const isLast = i === segments.length - 1;
    const span = isLast ? 360 - angle : (segments[i].revenueCents / total) * 360;
    angle = start + span;
    const c = PRODUCT_RANKING_CHART_COLORS[i % PRODUCT_RANKING_CHART_COLORS.length];
    stops.push(`${c} ${start}deg ${angle}deg`);
  }
  const gradient = stops.join(", ");

  chartRoot.innerHTML = `<div class="summary-donut" style="background: conic-gradient(${gradient});" role="img" aria-label="Revenue share by product"><span class="summary-donut__hole"></span></div>`;

  legendEl.innerHTML = segments
    .map((seg, i) => {
      const pct = ((seg.revenueCents / total) * 100).toFixed(1);
      const c = PRODUCT_RANKING_CHART_COLORS[i % PRODUCT_RANKING_CHART_COLORS.length];
      return `<div class="summary-chart-legend-item">
  <span class="summary-chart-legend-item__swatch" style="background-color: ${escapeHtml(c)}"></span>
  <span class="summary-chart-legend-item__name">${escapeHtml(seg.name)}</span>
  <span class="summary-chart-legend-item__meta">${escapeHtml(fmtCents(seg.revenueCents))} · ${escapeHtml(pct)}%</span>
</div>`;
    })
    .join("");
}

function renderAlerts(summary) {
  const alerts = summary?.alerts || {};
  const listEl = document.getElementById("alerts-list");
  if (!listEl) return;

  const cards = [
    {
      title: "Orders missing quoted shipping (revenue)",
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
    {
      title: "Inventory out of stock",
      data: alerts.inventoryOutOfStock,
      rowText: (r) => r.displayText || `${r.productName || "—"} / ${r.size || "—"}`,
      warn: true,
    },
    {
      title: "Low inventory",
      data: alerts.lowInventory,
      rowText: (r) => r.displayText || `${r.productName || "—"} / ${r.size || "—"}`,
      warn: true,
    },
  ];

  const fragments = [];

  for (const c of cards) {
    const count = Number(c.data?.count) || 0;
    const rows = Array.isArray(c.data?.rows) ? c.data.rows : [];
    if (count <= 0) {
      continue;
    }
    const lis = rows
      .slice(0, 4)
      .map((r) => `<li>${escapeHtml(c.rowText(r))}</li>`)
      .join("");
    fragments.push(`<article class="summary-alert-card ${c.warn ? "summary-alert-card--warn" : ""}">
        <div class="summary-alert-card__head">
          <p class="summary-alert-card__title">${escapeHtml(c.title)}</p>
          <p class="summary-alert-card__count">${escapeHtml(String(count))}</p>
        </div>
        <ul>${lis}</ul>
      </article>`);
  }

  const onHold = alerts.incomingBatchesOnHold;
  const onHoldCount = Number(onHold?.count) || 0;
  const onHoldRows = Array.isArray(onHold?.rows) ? onHold.rows : [];
  if (onHoldCount > 0 && onHoldRows.length > 0) {
    const shown = onHoldRows.slice(0, 3);
    const more = Math.max(0, onHoldCount - shown.length);
    const lis = shown
      .map((r) => `<li>${escapeHtml(`${String(r.batchName || "—").trim() || "—"} · On hold`)}</li>`)
      .join("");
    const moreLi = more > 0 ? `<li class="summary-alert-card__more">+ ${more} more</li>` : "";
    fragments.push(`<article class="summary-alert-card summary-alert-card--warn">
        <div class="summary-alert-card__head">
          <p class="summary-alert-card__title">Incoming batches on hold</p>
          <p class="summary-alert-card__count">${escapeHtml(String(onHoldCount))}</p>
        </div>
        <ul>${lis}${moreLi}</ul>
      </article>`);
  }

  listEl.innerHTML =
    fragments.length > 0
      ? fragments.join("")
      : `<p class="summary-empty summary-alerts-empty" role="status">No alerts or watchouts right now.</p>`;
}

function renderMeta(summary) {
  const meta = document.getElementById("summary-meta");
  if (!meta) return;
  const gen = summary?.generatedAt;
  meta.textContent = gen ? `Updated ${new Date(gen).toLocaleString()}` : "—";
}

function renderSummary(summary) {
  renderMeta(summary);
  renderKpis(summary);
  renderAlerts(summary);
  renderShippingZoneRanking(summary);
  renderRecentPurchasesTable(summary);
  renderProductRankingChart(summary);
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
    if (rangeState.preset !== "custom") {
      loadSummary();
    }
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
  let config = null;
  try {
    config = await fetchSupabasePublicConfig();
  } catch (e) {
    const le = document.getElementById("admin-load-error");
    if (le) {
      le.textContent = e?.message || "Add SUPABASE_URL and SUPABASE_ANON_KEY to the server environment.";
      le.hidden = false;
    }
    showLogin();
  }

  if (config?.supabaseUrl && config?.supabaseAnonKey) {
    supabase = createSupabaseAdminClient(config.supabaseUrl, config.supabaseAnonKey);
  } else {
    supabase = null;
  }

  if (supabase) {
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
  } else {
    showLogin();
  }

  document.getElementById("login-form")?.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const errEl = document.getElementById("login-error");
    errEl.hidden = true;
    if (!supabase) {
      errEl.textContent =
        "Server did not return Supabase configuration. Set SUPABASE_URL and SUPABASE_ANON_KEY, restart the server, and refresh.";
      errEl.hidden = false;
      return;
    }
    const fd = new FormData(ev.target);
    const email = String(fd.get("email") || "").trim();
    const password = String(fd.get("password") || "");
    const { data: signInData, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      errEl.textContent = error.message;
      errEl.hidden = false;
      return;
    }
    const session = signInData?.session
      ? signInData.session
      : (await supabase.auth.getSession()).data?.session ?? null;
    if (session) {
      primeAdminSessionUser(session);
    }
    const presetEl = document.getElementById("summary-range-preset");
    if (presetEl) {
      presetEl.value = rangeState.preset;
    }
    updateRangeControlsVisibility();
    bindSummaryControls();
    showApp();
    document.getElementById("admin-user-email").textContent = session?.user?.email || email;
    renderAdminNav("summary");
    await loadSummary();
  });

  document.getElementById("admin-logout")?.addEventListener("click", async () => {
    if (supabase) {
      await supabase.auth.signOut();
    } else {
      showLogin();
    }
  });
}

init();
