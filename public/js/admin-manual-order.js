import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.8";
import {
  clearAdminSessionUser,
  fetchReportPost,
  fetchSupabasePublicConfig,
  primeAdminSessionUser,
  renderAdminNav,
  shouldBootstrapAdminSignedIn,
} from "./admin-shared.js";

const US_STATES = [
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA", "HI", "ID", "IL", "IN", "IA", "KS", "KY",
  "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND",
  "OH", "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY", "DC",
];

let supabase = null;
let siteSizes = ["Small", "Medium", "Large", "X Large"];
let products = [];
/** @type {string | null} */
let lastCreatedOrderId = null;
/** @type {object | null} */
let lastQuote = null;

function showLogin() {
  document.getElementById("admin-login").hidden = false;
  document.getElementById("admin-app").hidden = true;
}

function showApp() {
  document.getElementById("admin-login").hidden = true;
  document.getElementById("admin-app").hidden = false;
}

function readAddressFromForm(form) {
  return {
    line1: String(form.addr_line1?.value || "").trim(),
    line2: String(form.addr_line2?.value || "").trim(),
    city: String(form.addr_city?.value || "").trim(),
    state: String(form.addr_state?.value || "").trim().toUpperCase(),
    postalCode: String(form.addr_zip?.value || "").trim(),
    country: "US",
  };
}

function casesFieldName(slug, size) {
  const safe = `${slug}_${size}`.replace(/[^a-z0-9_-]/gi, "_");
  return `cases_${safe}`;
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildItemsFromForm(form) {
  const items = [];
  for (const p of products) {
    const quantities = {};
    for (const sz of siteSizes) {
      const el = form.querySelector(`[name="${casesFieldName(p.slug, sz)}"]`);
      const n = Math.floor(Number(el?.value) || 0);
      if (n > 0) {
        quantities[sz] = n;
      }
    }
    if (Object.keys(quantities).length) {
      items.push({ slug: p.slug, quantities, boxQuantities: {} });
    }
  }
  return items;
}

function renderProductInputs() {
  const wrap = document.getElementById("manual-products");
  if (!wrap) {
    return;
  }
  wrap.innerHTML = products
    .map((p) => {
      const sizeFields = siteSizes
        .map((sz) => {
          const nm = casesFieldName(p.slug, sz);
          return `<label>${escapeHtml(sz)} cases <input type="number" min="0" step="1" name="${escapeHtml(nm)}" value="" /></label>`;
        })
        .join("");
      return `<div class="manual-product-block">
        <h3>${escapeHtml(p.name || p.slug)}</h3>
        <div class="manual-product-sizes">${sizeFields}</div>
      </div>`;
    })
    .join("");
}

function fillStateSelect() {
  const sel = document.getElementById("addr_state");
  if (!sel) {
    return;
  }
  sel.innerHTML = `<option value="">Select</option>${US_STATES.map((c) => `<option value="${c}">${c}</option>`).join("")}`;
}

async function getSessionToken() {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  return session?.access_token || null;
}

async function runEstimate() {
  const form = document.getElementById("manual-order-form");
  const errEl = document.getElementById("admin-load-error");
  errEl.hidden = true;

  const items = buildItemsFromForm(form);
  if (!items.length) {
    errEl.textContent = "Add at least one case quantity.";
    errEl.hidden = false;
    return null;
  }

  const address = readAddressFromForm(form);
  const discountCode = String(form.discount_code?.value || "").trim();

  const token = await getSessionToken();
  if (!token) {
    errEl.textContent = "Sign in again.";
    errEl.hidden = false;
    return null;
  }

  const body = { items, address, discountCode };
  const data = await fetchReportPost("/api/admin-manual-order-estimate", token, body);
  lastQuote = data;

  const preview = document.getElementById("manual-preview");
  const pre = document.getElementById("manual-preview-body");
  const lines = [
    `Merchandise: ${data.originalMerchandiseSubtotalFormatted || data.subtotalFormatted}`,
  ];
  if (data.merchandiseDiscountFormatted && Number(data.merchandiseDiscountCents) > 0) {
    lines.push(`Discount: −${data.merchandiseDiscountFormatted}`);
  }
  lines.push(
    `Shipping: ${data.shippingCents === 0 ? "Free" : data.shippingFormatted}`,
    `Tax: ${data.taxFormatted}`,
    `Total: ${data.totalFormatted}`,
  );
  if (Array.isArray(data.warnings) && data.warnings.length) {
    lines.push("", ...data.warnings.map((w) => `Note: ${w}`));
  }
  pre.textContent = lines.join("\n");
  preview.hidden = false;

  return data;
}

async function saveDraft() {
  const form = document.getElementById("manual-order-form");
  const errEl = document.getElementById("admin-load-error");
  errEl.hidden = true;

  const items = buildItemsFromForm(form);
  const address = readAddressFromForm(form);
  const token = await getSessionToken();
  if (!token) {
    errEl.textContent = "Sign in again.";
    errEl.hidden = false;
    return;
  }

  const body = {
    name: String(form.cust_name?.value || "").trim(),
    email: String(form.cust_email?.value || "").trim(),
    phone: String(form.cust_phone?.value || "").trim(),
    address,
    items,
    discountCode: String(form.discount_code?.value || "").trim(),
  };

  const data = await fetchReportPost("/api/admin-manual-order-create", token, body);
  lastCreatedOrderId = data.orderId;
  document.getElementById("btn-send-link").disabled = false;

  const resEl = document.getElementById("manual-result");
  const textEl = document.getElementById("manual-result-text");
  textEl.textContent = `Reference ${data.orderRef} · Total ${data.totalFormatted}\nYou can now send the payment link email to the customer.`;
  resEl.hidden = false;
}

async function sendPaymentLink() {
  const errEl = document.getElementById("admin-load-error");
  errEl.hidden = true;
  if (!lastCreatedOrderId) {
    errEl.textContent = "Save a draft order first.";
    errEl.hidden = false;
    return;
  }
  const token = await getSessionToken();
  if (!token) {
    errEl.textContent = "Sign in again.";
    errEl.hidden = false;
    return;
  }

  const btn = document.getElementById("btn-send-link");
  btn.disabled = true;
  try {
    const data = await fetchReportPost("/api/admin-manual-order-send-link", token, {
      orderId: lastCreatedOrderId,
    });
    const msg = data.warning || (data.emailed ? "Payment link emailed to the customer." : "Done.");
    document.getElementById("manual-result-text").textContent += `\n\n${msg}`;
    if (data.checkoutUrl && data.warning) {
      document.getElementById("manual-result-text").textContent += `\n\nLink: ${data.checkoutUrl}`;
    }
  } catch (e) {
    errEl.textContent = e.message || "Failed to send link.";
    errEl.hidden = false;
  } finally {
    btn.disabled = false;
  }
}

async function loadProducts() {
  const res = await fetch("/api/products");
  const data = await res.json().catch(() => ({}));
  if (Array.isArray(data.site?.sizes)) {
    siteSizes = data.site.sizes;
  }
  products = Array.isArray(data.products) ? data.products : [];
  renderProductInputs();
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

  fillStateSelect();

  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (session?.user) {
    primeAdminSessionUser(session);
    showApp();
    document.getElementById("admin-user-email").textContent = session.user.email || "";
    renderAdminNav("manual-order");
    await loadProducts();
  } else {
    showLogin();
  }

  supabase.auth.onAuthStateChange(async (event, sess) => {
    if (event === "SIGNED_IN" && sess?.user) {
      if (!shouldBootstrapAdminSignedIn(sess)) {
        return;
      }
      document.getElementById("admin-user-email").textContent = sess.user.email || "";
      showApp();
      renderAdminNav("manual-order");
      await loadProducts();
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
    renderAdminNav("manual-order");
    await loadProducts();
  });

  document.getElementById("admin-logout")?.addEventListener("click", async () => {
    await supabase.auth.signOut();
  });

  document.getElementById("btn-estimate")?.addEventListener("click", async () => {
    const btn = document.getElementById("btn-estimate");
    btn.disabled = true;
    try {
      await runEstimate();
    } catch (e) {
      const errEl = document.getElementById("admin-load-error");
      errEl.textContent = e.message || "Estimate failed.";
      errEl.hidden = false;
    } finally {
      btn.disabled = false;
    }
  });

  document.getElementById("btn-save-draft")?.addEventListener("click", async () => {
    const btn = document.getElementById("btn-save-draft");
    btn.disabled = true;
    try {
      await saveDraft();
    } catch (e) {
      const errEl = document.getElementById("admin-load-error");
      errEl.textContent = e.message || "Could not save.";
      errEl.hidden = false;
    } finally {
      btn.disabled = false;
    }
  });

  document.getElementById("btn-send-link")?.addEventListener("click", () => void sendPaymentLink());
}

init();
