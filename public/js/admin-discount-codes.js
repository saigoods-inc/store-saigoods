import {
  clearAdminSessionUser,
  createSupabaseAdminClient,
  fetchReportJson,
  fetchSupabasePublicConfig,
  primeAdminSessionUser,
  renderAdminNav,
  shouldBootstrapAdminSignedIn,
} from "./admin-shared.js";

let supabase = null;
/** @type {Array<{code:string,is_used:boolean,used_at?:string,used_by_order_id?:string,created_at?:string}>} */
let codesCache = [];

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

function getFilterState() {
  return {
    status: document.getElementById("filter-code-status")?.value || "all",
    search: (document.getElementById("filter-code-search")?.value || "").trim().toUpperCase(),
    sort: document.getElementById("filter-code-sort")?.value || "newest",
  };
}

function applyFiltersAndSort(rows) {
  const { status, search, sort } = getFilterState();
  let out = [...rows];

  if (status === "unused") {
    out = out.filter((r) => !r.is_used);
  } else if (status === "used") {
    out = out.filter((r) => r.is_used);
  }

  if (search) {
    out = out.filter((r) => String(r.code || "").toUpperCase().includes(search));
  }

  out.sort((a, b) => {
    const ca = String(a.code || "");
    const cb = String(b.code || "");
    const ta = a.created_at ? new Date(a.created_at).getTime() : 0;
    const tb = b.created_at ? new Date(b.created_at).getTime() : 0;
    switch (sort) {
      case "oldest":
        return ta - tb;
      case "code_az":
        return ca.localeCompare(cb);
      case "code_za":
        return cb.localeCompare(ca);
      case "newest":
      default:
        return tb - ta;
    }
  });

  return out;
}

function renderCodesTable() {
  const tbody = document.getElementById("codes-tbody");
  const rows = applyFiltersAndSort(codesCache);

  if (!codesCache.length) {
    tbody.innerHTML = `<tr><td colspan="4" class="admin-muted">No codes found. Run sql/discount_codes.sql in Supabase.</td></tr>`;
    return;
  }

  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="4" class="admin-muted">No codes match your filters.</td></tr>`;
    return;
  }

  tbody.innerHTML = rows
    .map((r) => {
      const used = Boolean(r.is_used);
      const statusBadge = used
        ? `<span class="admin-badge admin-badge--paid">Used</span>`
        : `<span class="admin-badge admin-badge--awaiting_payment">Unused</span>`;
      const at = r.used_at ? escapeHtml(new Date(r.used_at).toLocaleString()) : "—";
      const oid = r.used_by_order_id ? escapeHtml(String(r.used_by_order_id)) : "—";
      return `<tr>
            <td><code>${escapeHtml(r.code)}</code></td>
            <td>${statusBadge}</td>
            <td>${at}</td>
            <td>${oid}</td>
          </tr>`;
    })
    .join("");
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
    codesCache = Array.isArray(data.codes) ? data.codes : [];
    renderCodesTable();
  } catch (e) {
    errEl.textContent = e.message || "Could not load discount codes.";
    errEl.hidden = false;
  }

  loading.hidden = true;
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
      renderAdminNav("discounts");
      await loadCodes();
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
        renderAdminNav("discounts");
        await loadCodes();
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
    showApp();
    document.getElementById("admin-user-email").textContent = session?.user?.email || email;
    renderAdminNav("discounts");
    await loadCodes();
  });

  document.getElementById("admin-logout")?.addEventListener("click", async () => {
    if (supabase) {
      await supabase.auth.signOut();
    } else {
      showLogin();
    }
  });

  document.getElementById("admin-refresh")?.addEventListener("click", () => loadCodes());

  document.getElementById("filter-code-status")?.addEventListener("change", () => renderCodesTable());
  document.getElementById("filter-code-search")?.addEventListener("input", () => renderCodesTable());
  document.getElementById("filter-code-sort")?.addEventListener("change", () => renderCodesTable());
}

init();
