import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.8";
import { fetchSupabasePublicConfig, renderAdminNav, fetchReportJson } from "./admin-shared.js";

let supabase = null;

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

async function loadCodes() {
  const errEl = document.getElementById("admin-load-error");
  const loading = document.getElementById("admin-loading");
  const tbody = document.getElementById("codes-tbody");
  errEl.hidden = true;
  loading.hidden = false;
  tbody.innerHTML = "";

  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session?.access_token) {
    loading.hidden = true;
    errEl.textContent = "No session — sign in again.";
    errEl.hidden = false;
    return;
  }

  try {
    const data = await fetchReportJson("/api/admin-discount-codes", session.access_token);
    const rows = Array.isArray(data.codes) ? data.codes : [];

    if (!rows.length) {
      tbody.innerHTML = `<tr><td colspan="4" class="admin-muted">No codes found. Run sql/discount_codes.sql in Supabase.</td></tr>`;
    } else {
      tbody.innerHTML = rows
        .map((r) => {
          const used = Boolean(r.is_used);
          const status = used
            ? `<span class="admin-badge admin-badge--paid">Used</span>`
            : `<span class="admin-badge admin-badge--awaiting_payment">Unused</span>`;
          const at = r.used_at ? escapeHtml(new Date(r.used_at).toLocaleString()) : "—";
          const oid = r.used_by_order_id ? escapeHtml(String(r.used_by_order_id)) : "—";
          return `<tr>
            <td><code>${escapeHtml(r.code)}</code></td>
            <td>${status}</td>
            <td>${at}</td>
            <td>${oid}</td>
          </tr>`;
        })
        .join("");
    }

    window.__discountCodesCache = rows;
  } catch (e) {
    errEl.textContent = e.message || "Could not load discount codes.";
    errEl.hidden = false;
  }

  loading.hidden = true;
}

function copyText(text) {
  void navigator.clipboard?.writeText(text).catch(() => {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
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
    auth: { persistSession: true, autoRefreshToken: true },
  });

  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (session?.user) {
    showApp();
    document.getElementById("admin-user-email").textContent = session.user.email || "";
    renderAdminNav("discounts");
    await loadCodes();
  } else {
    showLogin();
  }

  supabase.auth.onAuthStateChange(async (event, sess) => {
    if (event === "SIGNED_IN" && sess?.user) {
      document.getElementById("admin-user-email").textContent = sess.user.email || "";
      showApp();
      renderAdminNav("discounts");
      await loadCodes();
    }
    if (event === "SIGNED_OUT") {
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
    renderAdminNav("discounts");
    await loadCodes();
  });

  document.getElementById("admin-logout")?.addEventListener("click", async () => {
    await supabase.auth.signOut();
  });

  document.getElementById("admin-refresh")?.addEventListener("click", () => loadCodes());

  document.getElementById("admin-copy-unused")?.addEventListener("click", () => {
    const rows = window.__discountCodesCache || [];
    const lines = rows.filter((r) => !r.is_used).map((r) => r.code);
    if (!lines.length) {
      alert("No unused codes.");
      return;
    }
    copyText(lines.join("\n"));
  });

  document.getElementById("admin-copy-all")?.addEventListener("click", () => {
    const rows = window.__discountCodesCache || [];
    if (!rows.length) {
      alert("No codes loaded.");
      return;
    }
    const header = "code,is_used,used_at,used_by_order_id";
    const body = rows
      .map((r) =>
        [
          r.code,
          r.is_used ? "1" : "0",
          r.used_at || "",
          r.used_by_order_id || "",
        ].join(","),
      )
      .join("\n");
    copyText(`${header}\n${body}`);
  });
}

init();
