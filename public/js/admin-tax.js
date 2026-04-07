import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.8";
import {
  fetchSupabasePublicConfig,
  renderAdminNav,
  formatUsdCents,
  fetchReportJson,
} from "./admin-shared.js";

let supabase = null;

function showLogin() {
  document.getElementById("admin-login").hidden = false;
  document.getElementById("admin-app").hidden = true;
}

function showApp() {
  document.getElementById("admin-login").hidden = true;
  document.getElementById("admin-app").hidden = false;
}

async function loadTax() {
  const errEl = document.getElementById("admin-load-error");
  const loading = document.getElementById("admin-loading");
  const tbody = document.getElementById("tax-tbody");
  const metaEl = document.getElementById("tax-meta");
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
  tbody.innerHTML = "";

  try {
    const data = await fetchReportJson("/api/tax-summary", session.access_token);
    const rows = Array.isArray(data.summary) ? data.summary : [];
    metaEl.textContent = data.generated_at
      ? `Updated ${new Date(data.generated_at).toLocaleString()} · ${data.note || ""}`
      : data.note || "";

    if (!rows.length) {
      tbody.innerHTML = `<tr><td colspan="5" class="admin-muted">No paid TN orders yet.</td></tr>`;
    } else {
      tbody.innerHTML = rows
        .map(
          (r) =>
            `<tr>
              <td>${escapeHtml(r.month)}</td>
              <td>${escapeHtml(r.state)}</td>
              <td>${escapeHtml(formatUsdCents(r.taxable_revenue))}</td>
              <td>${escapeHtml(formatUsdCents(r.tax_collected))}</td>
              <td>${escapeHtml(String(r.total_orders ?? ""))}</td>
            </tr>`,
        )
        .join("");
    }
  } catch (e) {
    errEl.textContent = e.message || "Could not load tax summary.";
    errEl.hidden = false;
    metaEl.textContent = "";
  }

  loading.hidden = true;
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
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

  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (session?.user) {
    showApp();
    document.getElementById("admin-user-email").textContent = session.user.email || "";
    renderAdminNav("tax");
    await loadTax();
  } else {
    showLogin();
  }

  supabase.auth.onAuthStateChange(async (event, session) => {
    if (event === "SIGNED_IN" && session?.user) {
      document.getElementById("admin-user-email").textContent = session.user.email || "";
      showApp();
      renderAdminNav("tax");
      await loadTax();
    }
    if (event === "SIGNED_OUT") {
      document.getElementById("tax-tbody").innerHTML = "";
      document.getElementById("tax-meta").textContent = "";
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
    renderAdminNav("tax");
    await loadTax();
  });

  document.getElementById("admin-logout")?.addEventListener("click", async () => {
    await supabase.auth.signOut();
  });

  document.getElementById("admin-refresh")?.addEventListener("click", async () => {
    await loadTax();
  });
}

init();
