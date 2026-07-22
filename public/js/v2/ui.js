/*
 * SAI Goods admin-v2 — reusable vanilla UI primitives.
 * No framework, no build step. Functions return HTML strings (matching the
 * existing codebase style) plus a few small DOM helpers for interactivity.
 */

/* ------------------------------------------------------------------ utils */

export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/* ---------------------------------------------------------------- icons */
/*
 * Minimal inline-SVG icon set (Lucide-style paths, MIT). Avoids adding an
 * icon dependency. Add new icons by dropping their path markup here.
 */
const ICON_PATHS = {
  "layout-dashboard":
    '<rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/>',
  "shopping-cart":
    '<circle cx="8" cy="21" r="1"/><circle cx="19" cy="21" r="1"/><path d="M2.05 2.05h2l2.66 12.42a2 2 0 0 0 2 1.58h9.78a2 2 0 0 0 1.95-1.57l1.65-7.43H5.12"/>',
  package:
    '<path d="M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z"/><path d="M3.3 7 12 12l8.7-5"/><path d="M12 22V12"/>',
  "clipboard-list":
    '<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M12 11h4"/><path d="M12 16h4"/><path d="M8 11h.01"/><path d="M8 16h.01"/>',
  store:
    '<path d="M2 7l1.5-4h17L22 7"/><path d="M4 7v13a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V7"/><path d="M2 7a3 3 0 0 0 6 0 3 3 0 0 0 6 0 3 3 0 0 0 6 0"/>',
  tag:
    '<path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z"/><circle cx="7.5" cy="7.5" r="1.1"/>',
  receipt:
    '<path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1z"/><path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8"/><path d="M12 17.5v-11"/>',
  "map-pin":
    '<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/>',
  "refresh-cw":
    '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  "alert-triangle":
    '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  "trending-up": '<path d="M22 7 13.5 15.5 8.5 10.5 2 17"/><path d="M16 7h6v6"/>',
  "trending-down": '<path d="M22 17 13.5 8.5 8.5 13.5 2 7"/><path d="M16 17h6v-6"/>',
  "dollar-sign":
    '<line x1="12" y1="2" x2="12" y2="22"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>',
  "bar-chart-3":
    '<path d="M3 3v18h18"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/>',
  truck:
    '<path d="M10 17h4V5H2v12h3"/><path d="M20 17h2v-3.34a4 4 0 0 0-1.17-2.83L19 9h-5"/><path d="M14 17h1"/><circle cx="7.5" cy="17.5" r="2.5"/><circle cx="17.5" cy="17.5" r="2.5"/>',
  menu: '<line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="18" x2="20" y2="18"/>',
  x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  "arrow-up-right": '<path d="M7 7h10v10"/><path d="M7 17 17 7"/>',
  "chevron-down": '<path d="m6 9 6 6 6-6"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  inbox:
    '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
  "sliders-horizontal":
    '<line x1="21" y1="4" x2="14" y2="4"/><line x1="10" y1="4" x2="3" y2="4"/><line x1="21" y1="12" x2="12" y2="12"/><line x1="8" y1="12" x2="3" y2="12"/><line x1="21" y1="20" x2="16" y2="20"/><line x1="12" y1="20" x2="3" y2="20"/><line x1="14" y1="2" x2="14" y2="6"/><line x1="8" y1="10" x2="8" y2="14"/><line x1="16" y1="18" x2="16" y2="22"/>',
  "trash-2":
    '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/>',
  clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
  check: '<polyline points="20 6 9 17 4 12"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  "external-link":
    '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>',
};

/**
 * Inline SVG icon.
 * @param {string} name key from ICON_PATHS
 * @param {number} [size=16]
 * @param {string} [cls] extra class
 */
export function icon(name, size = 16, cls = "") {
  const paths = ICON_PATHS[name];
  if (!paths) return "";
  return `<svg class="sg-icon ${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
}

/* ---------------------------------------------------------------- sidebar */

/* Phase 10A + 10B-1: approved admin-v2 routes only (Orders / Manual / Walk-in remain unreleased). */
export const ADMIN_V2_NAV = [
  { id: "summary", label: "Summary", href: "/admin-v2/summary", iconName: "layout-dashboard" },
  { id: "inventory", label: "Inventory", href: "/admin-v2/inventory", iconName: "package" },
  { id: "discounts", label: "Discount codes", href: "/admin-v2/discount-codes", iconName: "tag" },
  { id: "tax", label: "Sales tax (TN)", href: "/admin-v2/tax", iconName: "receipt" },
  { id: "nexus", label: "Nexus by state", href: "/admin-v2/nexus", iconName: "map-pin" },
];

/**
 * @param {string} activeId
 */
export function sidebar(activeId) {
  const items = ADMIN_V2_NAV.map((item) => {
    const active = item.id === activeId ? " is-active" : "";
    return `<li><a class="sg-nav__link${active}" href="${item.href}">${icon(item.iconName, 16)}<span>${escapeHtml(
      item.label,
    )}</span></a></li>`;
  }).join("");

  return `<aside class="sg-sidebar" id="sg-sidebar">
    <div class="sg-sidebar__brand">
      <!-- Logo-ready: swap "SAI" for an <img>/<svg> logo later; CSS sizes it to the badge. -->
      <div class="sg-brand__mark">SAI</div>
      <div>
        <p class="sg-brand__name">SAI Goods Inc.</p>
        <p class="sg-brand__sub">Back office</p>
      </div>
    </div>
    <nav class="sg-nav" aria-label="Admin sections">
      <p class="sg-nav__label">Navigation</p>
      <ul class="sg-nav__list">${items}</ul>
    </nav>
    <div class="sg-sidebar__footer">
      <a class="sg-nav__link" href="/admin/summary.html">Legacy admin</a>
      <small>admin-v2 read-only preview</small>
    </div>
  </aside>`;
}

/* ---------------------------------------------------------------- topbar */

/**
 * @param {{ email?: string, meta?: string }} [opts]
 */
export function topbar(opts = {}) {
  const email = opts.email ? escapeHtml(opts.email) : "";
  const meta = opts.meta ? escapeHtml(opts.meta) : "";
  return `<header class="sg-topbar">
    <div class="sg-topbar__left">
      <button type="button" class="sg-menu-btn" id="sg-menu-btn" aria-label="Open menu">${icon("menu", 20)}</button>
      <span class="sg-topbar__email" id="sg-topbar-email">${email}</span>
      <span class="sg-topbar__dot" aria-hidden="true">&middot;</span>
      <button type="button" class="sg-linkbtn" id="sg-logout">Sign out</button>
    </div>
    <div class="sg-topbar__right">
      <button type="button" class="sg-linkbtn" id="sg-refresh">${icon("refresh-cw", 14)}<span>Refresh</span></button>
      <span class="sg-topbar__dot" aria-hidden="true">&middot;</span>
      <span class="sg-topbar__meta" id="sg-topbar-meta">${meta}</span>
    </div>
  </header>`;
}

/* ------------------------------------------------------------ page header */

/**
 * @param {{ title: string, subtitle?: string, actionsHtml?: string }} opts
 */
export function pageHeader(opts) {
  const subtitle = opts.subtitle
    ? `<p class="sg-page-header__subtitle">${escapeHtml(opts.subtitle)}</p>`
    : "";
  const actions = opts.actionsHtml
    ? `<div class="sg-page-header__actions">${opts.actionsHtml}</div>`
    : "";
  return `<div class="sg-page-header">
    <div>
      <h1 class="sg-page-header__title">${escapeHtml(opts.title)}</h1>
      ${subtitle}
    </div>
    ${actions}
  </div>`;
}

/* --------------------------------------------------------------- shell */

/**
 * Full dashboard shell. Returns the sidebar + main column skeleton with an
 * empty `#sg-page` node the page controller fills in.
 * @param {{ active: string, email?: string, meta?: string }} opts
 */
export function shell(opts) {
  return `<div class="sg-overlay" id="sg-overlay"></div>
  <div class="sg-shell">
    ${sidebar(opts.active)}
    <div class="sg-main">
      ${topbar({ email: opts.email, meta: opts.meta })}
      <div class="sg-content" id="sg-page"></div>
    </div>
  </div>
  <div class="sg-toast-region" id="sg-toast-region"></div>`;
}

/* --------------------------------------------------------------- KPI card */

/**
 * @param {{ label: string, value: string, sub?: string, iconName?: string, danger?: boolean }} opts
 */
export function kpiCard(opts) {
  const valueClass = opts.danger ? " sg-kpi__value--danger" : "";
  const iconHtml = opts.iconName
    ? `<div class="sg-kpi__icon">${icon(opts.iconName, 18)}</div>`
    : "";
  return `<article class="sg-card sg-kpi">
    <div class="sg-kpi__top">
      <div>
        <p class="sg-kpi__label">${escapeHtml(opts.label)}</p>
        <p class="sg-kpi__value${valueClass}">${escapeHtml(opts.value)}</p>
        ${opts.sub ? `<p class="sg-kpi__sub">${escapeHtml(opts.sub)}</p>` : ""}
      </div>
      ${iconHtml}
    </div>
  </article>`;
}

/**
 * Horizontal mini stat card.
 * @param {{ label: string, value: string, sub?: string, iconName?: string }} opts
 */
export function miniCard(opts) {
  return `<article class="sg-card sg-minicard">
    <div class="sg-minicard__icon">${icon(opts.iconName || "dollar-sign", 16)}</div>
    <div>
      <p class="sg-minicard__label">${escapeHtml(opts.label)}</p>
      <p class="sg-minicard__value">${escapeHtml(opts.value)}</p>
      ${opts.sub ? `<p class="sg-minicard__sub">${escapeHtml(opts.sub)}</p>` : ""}
    </div>
  </article>`;
}

/* ----------------------------------------------------------------- chip */

const CHIP_VARIANTS = new Set(["neutral", "success", "warning", "danger", "info", "brand"]);

/**
 * @param {string} label
 * @param {"neutral"|"success"|"warning"|"danger"|"info"|"brand"} [variant]
 */
export function statusChip(label, variant = "neutral") {
  const v = CHIP_VARIANTS.has(variant) ? variant : "neutral";
  return `<span class="sg-chip sg-chip--${v}">${escapeHtml(label)}</span>`;
}

/* --------------------------------------------------------------- card shell */

/**
 * @param {{ title?: string, subtitle?: string, actionHtml?: string, bodyHtml: string, className?: string }} opts
 */
export function card(opts) {
  const header =
    opts.title || opts.actionHtml
      ? `<div class="sg-card__header">
          <div>
            ${opts.title ? `<h2 class="sg-card__title">${escapeHtml(opts.title)}</h2>` : ""}
            ${opts.subtitle ? `<p class="sg-card__subtitle">${escapeHtml(opts.subtitle)}</p>` : ""}
          </div>
          ${opts.actionHtml || ""}
        </div>`
      : "";
  return `<section class="sg-card ${opts.className || ""}"><div class="sg-card__body">${header}${opts.bodyHtml}</div></section>`;
}

/* --------------------------------------------------------------- table shell */

/**
 * @param {{ columns: {label:string, align?:"right"}[], rowsHtml: string, emptyHtml?: string }} opts
 */
export function tableShell(opts) {
  if (!opts.rowsHtml || !opts.rowsHtml.trim()) {
    return opts.emptyHtml || emptyState({ title: "Nothing to show", text: "No records for this range." });
  }
  const head = opts.columns
    .map((c) => `<th class="${c.align === "right" ? "sg-table__num" : ""}">${escapeHtml(c.label)}</th>`)
    .join("");
  return `<div class="sg-table-wrap">
    <table class="sg-table">
      <thead><tr>${head}</tr></thead>
      <tbody>${opts.rowsHtml}</tbody>
    </table>
  </div>`;
}

/* ------------------------------------------------------------ filter toolbar */

/**
 * @param {{ id: string, options: {value:string,label:string}[], selected?: string }} selectSpec
 * @param {string} [extraHtml] additional controls appended to the toolbar
 */
export function filterToolbar(selectSpec, extraHtml = "") {
  const opts = selectSpec.options
    .map(
      (o) =>
        `<option value="${escapeHtml(o.value)}"${o.value === selectSpec.selected ? " selected" : ""}>${escapeHtml(
          o.label,
        )}</option>`,
    )
    .join("");
  return `<div class="sg-toolbar">
    <select class="sg-select" id="${escapeHtml(selectSpec.id)}" aria-label="Filter">${opts}</select>
    ${extraHtml}
  </div>`;
}

/* --------------------------------------------------------------- button */

/**
 * @param {{ label: string, variant?: "primary"|"ghost", iconName?: string, id?: string, size?: "sm", block?: boolean }} opts
 */
export function button(opts) {
  const variant = opts.variant === "primary" ? "sg-btn--primary" : "sg-btn--ghost";
  const size = opts.size === "sm" ? " sg-btn--sm" : "";
  const block = opts.block ? " sg-btn--block" : "";
  const id = opts.id ? ` id="${escapeHtml(opts.id)}"` : "";
  const ic = opts.iconName ? icon(opts.iconName, 14) : "";
  return `<button type="button" class="sg-btn ${variant}${size}${block}"${id}>${ic}<span>${escapeHtml(
    opts.label,
  )}</span></button>`;
}

/* --------------------------------------------------------------- empty state */

/**
 * @param {{ title: string, text?: string, iconName?: string }} opts
 */
export function emptyState(opts) {
  return `<div class="sg-empty">
    <div class="sg-empty__icon">${icon(opts.iconName || "inbox", 22)}</div>
    <p class="sg-empty__title">${escapeHtml(opts.title)}</p>
    ${opts.text ? `<p class="sg-empty__text">${escapeHtml(opts.text)}</p>` : ""}
  </div>`;
}

/** Small "placeholder" pill for widgets without live backend data yet. */
export function placeholderTag(label = "Placeholder") {
  return `<span class="sg-placeholder-tag">${escapeHtml(label)}</span>`;
}

/* ------------------------------------------------------------ interactivity */

/** Wires the mobile sidebar toggle + overlay. Call once after mounting the shell. */
export function initShellInteractions() {
  const sidebarEl = document.getElementById("sg-sidebar");
  const overlay = document.getElementById("sg-overlay");
  const menuBtn = document.getElementById("sg-menu-btn");
  if (!sidebarEl || !overlay || !menuBtn) return;

  const open = () => {
    sidebarEl.classList.add("is-open");
    overlay.classList.add("is-open");
  };
  const close = () => {
    sidebarEl.classList.remove("is-open");
    overlay.classList.remove("is-open");
  };
  menuBtn.addEventListener("click", open);
  overlay.addEventListener("click", close);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
  });
}

/**
 * Lightweight toast (placeholder — replaces the reference's sonner).
 * @param {string} message
 * @param {"default"|"success"|"danger"} [variant]
 */
export function toast(message, variant = "default") {
  const region = document.getElementById("sg-toast-region");
  if (!region) return;
  const el = document.createElement("div");
  el.className = `sg-toast${variant !== "default" ? ` sg-toast--${variant}` : ""}`;
  el.textContent = message;
  region.appendChild(el);
  setTimeout(() => {
    el.style.opacity = "0";
    setTimeout(() => el.remove(), 250);
  }, 3200);
}

/* ------------------------------------------------------- drawer (reusable) */
/*
 * Shared right-side drawer. Lazily creates its own overlay + panel on <body>
 * (separate from the mobile-sidebar overlay). Pages call openDrawer()/closeDrawer().
 */
let _drawerEls = null;

function ensureDrawer() {
  if (_drawerEls) return _drawerEls;
  const overlay = document.createElement("div");
  overlay.className = "sg-overlay";
  overlay.id = "sg-drawer-overlay";

  const aside = document.createElement("aside");
  aside.className = "sg-drawer";
  aside.id = "sg-drawer";
  aside.setAttribute("role", "dialog");
  aside.setAttribute("aria-modal", "true");

  document.body.appendChild(overlay);
  document.body.appendChild(aside);

  overlay.addEventListener("click", closeDrawer);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeDrawer();
  });

  _drawerEls = { overlay, aside };
  return _drawerEls;
}

/**
 * @param {{ title?: string, bodyHtml?: string }} opts
 */
export function openDrawer(opts = {}) {
  const { overlay, aside } = ensureDrawer();
  aside.setAttribute("aria-label", opts.title || "Details");
  aside.innerHTML = `<div class="sg-drawer__header">
      <h2 class="sg-card__title">${escapeHtml(opts.title || "")}</h2>
      <button type="button" class="sg-btn sg-btn--icon sg-btn--ghost" id="sg-drawer-close" aria-label="Close">${icon(
        "x",
        16,
      )}</button>
    </div>
    <div class="sg-drawer__body">${opts.bodyHtml || ""}</div>`;
  const closeBtn = aside.querySelector("#sg-drawer-close");
  if (closeBtn) closeBtn.addEventListener("click", closeDrawer);
  overlay.classList.add("is-open");
  aside.classList.add("is-open");
}

export function closeDrawer() {
  if (!_drawerEls) return;
  _drawerEls.overlay.classList.remove("is-open");
  _drawerEls.aside.classList.remove("is-open");
}
