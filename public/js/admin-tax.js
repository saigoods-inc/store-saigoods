import {
  clearAdminSessionUser,
  createSupabaseAdminClient,
  fetchSupabasePublicConfig,
  formatUsdCents,
  fetchReportJson,
  primeAdminSessionUser,
  renderAdminNav,
  shouldBootstrapAdminSignedIn,
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
    const {
      data: { session },
    } = await supabase.auth.getSession();

    if (session?.user) {
      primeAdminSessionUser(session);
      showApp();
      document.getElementById("admin-user-email").textContent = session.user.email || "";
      renderAdminNav("tax");
      await loadTax();
    } else {
      showLogin();
    }

    supabase.auth.onAuthStateChange(async (event, session) => {
      if (event === "SIGNED_IN" && session?.user) {
        if (!shouldBootstrapAdminSignedIn(session)) {
          return;
        }
        document.getElementById("admin-user-email").textContent = session.user.email || "";
        showApp();
        renderAdminNav("tax");
        await loadTax();
      }
      if (event === "SIGNED_OUT") {
        clearAdminSessionUser();
        document.getElementById("tax-tbody").innerHTML = "";
        document.getElementById("tax-meta").textContent = "";
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
    showApp();
    document.getElementById("admin-user-email").textContent = session?.user?.email || email;
    renderAdminNav("tax");
    await loadTax();
  });

  document.getElementById("admin-logout")?.addEventListener("click", async () => {
    if (supabase) {
      await supabase.auth.signOut();
    } else {
      showLogin();
    }
  });

  document.getElementById("admin-refresh")?.addEventListener("click", async () => {
    await loadTax();
  });
}

init();
