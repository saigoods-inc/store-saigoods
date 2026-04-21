import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.8";
import {
  clearAdminSessionUser,
  fetchReportJson,
  fetchReportPost,
  fetchSupabasePublicConfig,
  primeAdminSessionUser,
  renderAdminNav,
  shouldBootstrapAdminSignedIn,
} from "./admin-shared.js";

/** @type {import("@supabase/supabase-js").SupabaseClient | null} */
let supabase = null;
/** @type {{ site?: { sizes?: string[] }, products?: { slug: string, name?: string }[] }} */
let storeCache = null;
/** @type {object | null} */
let dashboardCache = null;

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

function productLabel(slug) {
  const p = storeCache?.products?.find((x) => x.slug === slug);
  return p?.name ? `${p.name} (${slug})` : slug;
}

function fillSelect(sel, products) {
  if (!sel) return;
  sel.innerHTML = (products || [])
    .map((p) => `<option value="${escapeHtml(p.slug)}">${escapeHtml(productLabel(p.slug))}</option>`)
    .join("");
}

function fillSizeSelect(sel, sizes) {
  if (!sel) return;
  sel.innerHTML = (sizes || []).map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join("");
}

function renderSummary(d) {
  const el = document.getElementById("inv-summary");
  const s = d?.summary || {};
  const cards = [
    ["Total on hand", s.onHandTotal ?? 0],
    ["Total available", s.availableTotal ?? 0],
    ["Total reserved", s.reservedTotal ?? 0],
    ["Total incoming", s.incomingTotal ?? 0],
    ["Low stock rows", s.lowStockCount ?? 0],
    ["Out of stock rows", s.outOfStockCount ?? 0],
  ];
  el.innerHTML = `<div class="inv-summary__grid">${cards
    .map(
      ([label, val]) => `
      <div class="inv-summary__card">
        <div class="inv-summary__label">${escapeHtml(label)}</div>
        <div class="inv-summary__value">${escapeHtml(String(val))}</div>
      </div>`,
    )
    .join("")}</div>`;
}

function renderVariants(rows) {
  const tbody = document.getElementById("inv-variant-tbody");
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) {
    tbody.innerHTML = `<tr><td colspan="12" class="admin-muted">No variant lines yet. Use “Add or update a line” or create a shipment.</td></tr>`;
    return;
  }
  tbody.innerHTML = list
    .map((row) => {
      const slug = row.productSlug || "";
      const size = row.size || "";
      const ch = row.channel || "";
      const avail = row.available != null ? row.available : "—";
      const updated = row.updatedAt ? escapeHtml(String(row.updatedAt).slice(0, 19)) : "—";
      return `<tr data-slug="${escapeHtml(slug)}" data-size="${escapeHtml(size)}" data-channel="${escapeHtml(ch)}">
        <td>${escapeHtml(productLabel(slug))}</td>
        <td>${escapeHtml(size)}</td>
        <td>${escapeHtml(ch)}</td>
        <td>${escapeHtml(row.sku || "—")}</td>
        <td>${escapeHtml(String(row.onHand ?? 0))}</td>
        <td>${escapeHtml(String(row.reserved ?? 0))}</td>
        <td>${escapeHtml(String(avail))}</td>
        <td>${escapeHtml(String(row.incoming ?? 0))}</td>
        <td>${row.track === true ? "Yes" : "—"}</td>
        <td>${escapeHtml(row.status || "—")}</td>
        <td>${updated}</td>
        <td>
          <button type="button" class="admin-btn inv-row-prefill" style="font-size:12px;padding:0.25rem 0.5rem">Use in forms</button>
        </td>
      </tr>`;
    })
    .join("");
}

function renderMovements(entries) {
  const tbody = document.getElementById("inv-movement-tbody");
  const list = Array.isArray(entries) ? entries : [];
  if (!list.length) {
    tbody.innerHTML = `<tr><td colspan="9" class="admin-muted">No movements recorded yet.</td></tr>`;
    return;
  }
  tbody.innerHTML = list
    .map((m) => {
      const when = m.createdAt ? escapeHtml(String(m.createdAt).slice(0, 19)) : "—";
      const v = `${m.productSlug || ""} / ${m.size || ""} / ${m.channel || ""}`;
      const b = m.before || {};
      const ref = m.referenceType && m.referenceId ? `${m.referenceType}:${m.referenceId}` : "—";
      return `<tr>
        <td>${when}</td>
        <td>${escapeHtml(m.actionType || "")}</td>
        <td>${escapeHtml(v)}</td>
        <td>${escapeHtml(String(m.quantityDelta ?? ""))}</td>
        <td>${escapeHtml(String(b.onHand ?? ""))}→${escapeHtml(String((m.after || {}).onHand ?? ""))}</td>
        <td>${escapeHtml(String(b.reserved ?? ""))}→${escapeHtml(String((m.after || {}).reserved ?? ""))}</td>
        <td>${escapeHtml(String(b.incoming ?? ""))}→${escapeHtml(String((m.after || {}).incoming ?? ""))}</td>
        <td>${escapeHtml(ref)}</td>
        <td>${escapeHtml(m.adminUser || "—")}</td>
      </tr>`;
    })
    .join("");
}

function renderShipments(shipments) {
  const el = document.getElementById("inv-shipments");
  const list = Array.isArray(shipments) ? shipments : [];
  if (!list.length) {
    el.innerHTML = `<p class="admin-muted" style="margin:0">No shipments.</p>`;
    return;
  }
  el.innerHTML = list
    .map((sh) => {
      const lines = Array.isArray(sh.lines) ? sh.lines : [];
      const rows = lines
        .map((ln) => {
          const exp = Math.max(0, Math.floor(Number(ln.expectedQty) || 0));
          const rec = Math.max(0, Math.floor(Number(ln.receivedQty) || 0));
          const rem = Math.max(0, exp - rec);
          return `<tr>
            <td>${escapeHtml(ln.productSlug)}</td>
            <td>${escapeHtml(ln.size)}</td>
            <td>${escapeHtml(ln.unit || ln.channel || "")}</td>
            <td>${exp}</td>
            <td>${rec}</td>
            <td>${rem}</td>
            <td><code style="font-size:11px">${escapeHtml(ln.id)}</code></td>
          </tr>`;
        })
        .join("");
      return `<div style="margin-bottom:1.25rem">
        <p style="margin:0 0 0.35rem"><strong>${escapeHtml(sh.id)}</strong> — ${escapeHtml(
        sh.status || "",
      )}${sh.eta ? ` — ETA ${escapeHtml(sh.eta)}` : ""}</p>
        <div class="admin-table-wrap">
          <table class="admin-table">
            <thead><tr><th>Slug</th><th>Size</th><th>Unit</th><th>Expected</th><th>Received</th><th>Remaining</th><th>Line ID</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>`;
    })
    .join("");
}

function prefillForms(slug, size, channel) {
  for (const id of ["manual-slug", "dmg-slug", "track-slug"]) {
    const s = document.getElementById(id);
    if (s) s.value = slug;
  }
  for (const id of ["manual-size", "dmg-size", "track-size"]) {
    const s = document.getElementById(id);
    if (s) s.value = size;
  }
  document.querySelectorAll('#form-manual select[name="channel"]').forEach((x) => {
    x.value = channel;
  });
  document.querySelectorAll('#form-damaged select[name="channel"]').forEach((x) => {
    x.value = channel;
  });
  document.querySelectorAll('#form-track select[name="channel"]').forEach((x) => {
    x.value = channel;
  });
}

function wireRowPrefill() {
  document.getElementById("inv-variant-tbody")?.addEventListener("click", (ev) => {
    const btn = ev.target.closest(".inv-row-prefill");
    if (!btn) return;
    const tr = btn.closest("tr");
    if (!tr) return;
    prefillForms(tr.dataset.slug || "", tr.dataset.size || "", tr.dataset.channel || "");
    const toast = document.getElementById("admin-save-toast");
    toast.textContent = "Prefilled action forms with this variant.";
    toast.hidden = false;
    setTimeout(() => {
      toast.hidden = true;
    }, 2400);
  });
}

async function loadStore() {
  const data = await fetch("/api/products").then((r) => r.json());
  storeCache = data;
  fillSelect(document.getElementById("edit-slug"), data.products);
  fillSizeSelect(document.getElementById("edit-size"), data.site?.sizes);
  fillSelect(document.getElementById("manual-slug"), data.products);
  fillSizeSelect(document.getElementById("manual-size"), data.site?.sizes);
  fillSelect(document.getElementById("dmg-slug"), data.products);
  fillSizeSelect(document.getElementById("dmg-size"), data.site?.sizes);
  fillSelect(document.getElementById("track-slug"), data.products);
  fillSizeSelect(document.getElementById("track-size"), data.site?.sizes);
}

async function loadDashboard(session) {
  const errEl = document.getElementById("admin-load-error");
  const loading = document.getElementById("admin-loading");
  errEl.hidden = true;
  loading.hidden = false;
  try {
    dashboardCache = await fetchReportJson("/api/admin/inventory", session.access_token);
    renderSummary(dashboardCache);
    renderVariants(dashboardCache.variants);
    renderMovements(dashboardCache.movements);
    renderShipments(dashboardCache.shipments);
  } catch (e) {
    errEl.textContent = e.message || "Could not load inventory.";
    errEl.hidden = false;
  }
  loading.hidden = true;
}

async function postInventory(session, body) {
  const data = await fetchReportPost("/api/admin/inventory", session.access_token, body);
  if (data.dashboard) {
    dashboardCache = data.dashboard;
    renderSummary(dashboardCache);
    renderVariants(dashboardCache.variants);
    renderMovements(dashboardCache.movements);
    renderShipments(dashboardCache.shipments);
  }
  return data;
}

async function bootstrap(session) {
  document.getElementById("admin-user-email").textContent = session.user.email || "";
  renderAdminNav("inventory");
  await loadStore();
  await loadDashboard(session);
  wireRowPrefill();
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
    auth: { persistSession: true, autoRefreshToken: true },
  });

  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (session?.user) {
    primeAdminSessionUser(session);
    showApp();
    await bootstrap(session);
  } else {
    showLogin();
  }

  supabase.auth.onAuthStateChange(async (event, sess) => {
    if (event === "SIGNED_IN" && sess?.user) {
      if (!shouldBootstrapAdminSignedIn(sess)) {
        return;
      }
      showApp();
      await bootstrap(sess);
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
    await bootstrap(afterLogin.session);
  });

  document.getElementById("admin-logout")?.addEventListener("click", async () => {
    await supabase.auth.signOut();
  });

  document.getElementById("admin-refresh")?.addEventListener("click", async () => {
    const { data: s } = await supabase.auth.getSession();
    if (s?.session) await bootstrap(s.session);
  });

  async function sessionOrBail() {
    const { data: sess } = await supabase.auth.getSession();
    if (!sess?.session) {
      throw new Error("Sign in again.");
    }
    return sess.session;
  }

  document.getElementById("form-receive")?.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const toast = document.getElementById("admin-save-toast");
    const errEl = document.getElementById("admin-load-error");
    toast.hidden = true;
    errEl.hidden = true;
    try {
      const session = await sessionOrBail();
      const fd = new FormData(ev.target);
      await postInventory(session, {
        action: "receive_shipment",
        shipmentId: String(fd.get("shipmentId") || "").trim(),
        lineId: String(fd.get("lineId") || "").trim(),
        qty: Math.floor(Number(fd.get("qty")) || 0),
        reason: String(fd.get("reason") || "").trim() || undefined,
      });
      toast.textContent = "Received stock.";
      toast.hidden = false;
    } catch (e) {
      errEl.textContent = e.message || "Request failed.";
      errEl.hidden = false;
    }
  });

  document.getElementById("form-create-shipment")?.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const toast = document.getElementById("admin-save-toast");
    const errEl = document.getElementById("admin-load-error");
    toast.hidden = true;
    errEl.hidden = true;
    try {
      const session = await sessionOrBail();
      const fd = new FormData(ev.target);
      const raw = String(fd.get("linesJson") || "").trim();
      const lines = JSON.parse(raw);
      if (!Array.isArray(lines)) throw new Error("Lines JSON must be an array.");
      await postInventory(session, {
        action: "create_shipment",
        eta: fd.get("eta") || null,
        notes: String(fd.get("notes") || "").trim() || null,
        lines,
      });
      toast.textContent = "Shipment created.";
      toast.hidden = false;
    } catch (e) {
      errEl.textContent = e.message || "Request failed.";
      errEl.hidden = false;
    }
  });

  document.getElementById("form-manual")?.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const toast = document.getElementById("admin-save-toast");
    const errEl = document.getElementById("admin-load-error");
    toast.hidden = true;
    errEl.hidden = true;
    try {
      const session = await sessionOrBail();
      const fd = new FormData(ev.target);
      await postInventory(session, {
        action: "manual_adjust",
        productSlug: String(fd.get("productSlug") || "").trim(),
        size: String(fd.get("size") || "").trim(),
        channel: String(fd.get("channel") || "").trim(),
        deltaOnHand: Math.floor(Number(fd.get("deltaOnHand")) || 0),
        reason: String(fd.get("reason") || "").trim(),
      });
      toast.textContent = "Adjustment saved.";
      toast.hidden = false;
    } catch (e) {
      errEl.textContent = e.message || "Request failed.";
      errEl.hidden = false;
    }
  });

  document.getElementById("form-damaged")?.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const toast = document.getElementById("admin-save-toast");
    const errEl = document.getElementById("admin-load-error");
    toast.hidden = true;
    errEl.hidden = true;
    try {
      const session = await sessionOrBail();
      const fd = new FormData(ev.target);
      await postInventory(session, {
        action: "mark_damaged",
        productSlug: String(fd.get("productSlug") || "").trim(),
        size: String(fd.get("size") || "").trim(),
        channel: String(fd.get("channel") || "").trim(),
        quantity: Math.floor(Number(fd.get("quantity")) || 0),
        reason: String(fd.get("reason") || "").trim(),
      });
      toast.textContent = "Damage recorded.";
      toast.hidden = false;
    } catch (e) {
      errEl.textContent = e.message || "Request failed.";
      errEl.hidden = false;
    }
  });

  document.getElementById("form-track")?.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const toast = document.getElementById("admin-save-toast");
    const errEl = document.getElementById("admin-load-error");
    toast.hidden = true;
    errEl.hidden = true;
    try {
      const session = await sessionOrBail();
      const fd = new FormData(ev.target);
      const slug = String(fd.get("productSlug") || "").trim();
      const size = String(fd.get("size") || "").trim();
      const channel = String(fd.get("channel") || "").trim();
      const track = document.querySelector("#form-track input[name='track']")?.checked === true;
      const thRaw = String(fd.get("reorderThreshold") ?? "").trim();
      await postInventory(session, {
        action: "toggle_track",
        productSlug: slug,
        size,
        channel,
        track,
      });
      await postInventory(session, {
        action: "set_threshold",
        productSlug: slug,
        size,
        channel,
        reorderThreshold: thRaw === "" ? null : Math.max(0, Math.floor(Number(thRaw))),
      });
      toast.textContent = "Tracking / threshold saved.";
      toast.hidden = false;
    } catch (e) {
      errEl.textContent = e.message || "Request failed.";
      errEl.hidden = false;
    }
  });

  document.getElementById("stock-edit-form")?.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const toast = document.getElementById("admin-save-toast");
    const errEl = document.getElementById("admin-load-error");
    toast.hidden = true;
    errEl.hidden = true;
    try {
      const session = await sessionOrBail();
      const slug = String(document.getElementById("edit-slug").value || "").trim();
      const size = String(document.getElementById("edit-size").value || "").trim();
      const channel = String(document.getElementById("edit-channel").value || "").trim();
      const onHand = Math.max(0, Math.floor(Number(document.getElementById("edit-on-hand").value) || 0));
      const track = document.getElementById("edit-track").checked === true;
      const skuRaw = String(document.getElementById("edit-sku").value || "").trim();
      const patch = {
        productSlug: slug,
        size,
        channel,
        setOnHand: onHand,
        track,
      };
      if (skuRaw) patch.sku = skuRaw;
      await postInventory(session, { action: "stock_patch", patches: [patch] });
      toast.textContent = "Line saved.";
      toast.hidden = false;
    } catch (e) {
      errEl.textContent = e.message || "Request failed.";
      errEl.hidden = false;
    }
  });
}

document.addEventListener("DOMContentLoaded", () => void init());
