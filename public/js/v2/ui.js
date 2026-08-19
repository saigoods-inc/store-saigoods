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
  user: '<path d="M20 21a8 8 0 0 0-16 0"/><circle cx="12" cy="7" r="4"/>',
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

/* Admin-v2 navigation: dashboard + operations + one combined order-builder entry for remote and walk-in creation. */
export const ADMIN_V2_NAV = [
  { id: "summary", label: "Summary", href: "/admin-v2/summary", iconName: "layout-dashboard" },
  { id: "orders", label: "Orders", href: "/admin-v2/orders", iconName: "shopping-cart" },
  { id: "order-builder", label: "Order Builder", href: "/admin-v2/manual-order", iconName: "clipboard-list" },
  { id: "inventory", label: "Inventory", href: "/admin-v2/inventory", iconName: "package" },
  { id: "discounts", label: "Discount codes", href: "/admin-v2/discount-codes", iconName: "tag" },
  { id: "tax", label: "Sales tax (TN)", href: "/admin-v2/tax", iconName: "receipt" },
  { id: "nexus", label: "Nexus by state", href: "/admin-v2/nexus", iconName: "map-pin" },
];

/**
 * @param {string} activeId
 */
export function sidebar(activeId, email = "") {
  const items = ADMIN_V2_NAV.map((item) => {
    const isActive = item.id === activeId;
    const active = isActive ? " is-active" : "";
    const current = isActive ? ` aria-current="page"` : "";
    return `<li><a class="sg-nav__link${active}" href="${item.href}"${current}>${icon(item.iconName, 16)}<span>${escapeHtml(
      item.label,
    )}</span></a></li>`;
  }).join("");
  const emailHtml = email
    ? `<p class="sg-sidebar__account-email" id="sg-sidebar-email">${escapeHtml(email)}</p>`
    : `<p class="sg-sidebar__account-email sg-muted" id="sg-sidebar-email">No active session</p>`;

  return `<aside class="sg-sidebar" id="sg-sidebar">
    <div class="sg-sidebar__brand">
      <!-- Logo-ready: swap "SAI" for an <img>/<svg> logo later; CSS sizes it to the badge. -->
      <div class="sg-brand__mark">SAI</div>
      <div>
        <p class="sg-brand__name">SAI Goods, Inc.</p>
        <p class="sg-brand__sub">Operation Dashboard</p>
      </div>
    </div>
    <nav class="sg-nav" aria-label="Admin sections">
      <p class="sg-nav__label">Navigation</p>
      <ul class="sg-nav__list">${items}</ul>
    </nav>
    <div class="sg-sidebar__footer">
      <div class="sg-sidebar__account">
        ${emailHtml}
        <div class="sg-sidebar__footer-actions">
          <button type="button" class="sg-btn sg-btn--ghost sg-btn--sm sg-btn--block sg-sidebar__signout" id="sg-logout">${icon(
            "external-link",
            14,
          )}<span>Sign out</span></button>
          <a class="sg-btn sg-btn--ghost sg-btn--sm sg-btn--block sg-sidebar__legacy" href="/admin/summary.html">${icon(
            "arrow-up-right",
            14,
          )}<span>Legacy admin</span></a>
        </div>
      </div>
      <small>Version 2.1.45</small>
    </div>
  </aside>`;
}

/* ---------------------------------------------------------------- topbar */

/**
 * @param {{ email?: string, meta?: string, leftHtml?: string }} [opts]
 */
export function topbar(opts = {}) {
  const meta = opts.meta ? escapeHtml(opts.meta) : "";
  const leftHtml = typeof opts.leftHtml === "string" && opts.leftHtml
    ? `<div class="sg-topbar__context">${opts.leftHtml}</div>`
    : "";
  return `<header class="sg-topbar">
    <div class="sg-topbar__left">
      <button type="button" class="sg-menu-btn" id="sg-menu-btn" aria-label="Open menu" aria-controls="sg-sidebar" aria-expanded="false">${icon("menu", 20)}</button>
    </div>
    ${leftHtml}
    <div class="sg-topbar__right">
      <button type="button" class="sg-btn sg-btn--ghost sg-btn--sm sg-topbar__refresh" id="sg-refresh">${icon(
        "refresh-cw",
        14,
      )}<span>Refresh</span></button>
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

/**
 * Shared top-level order-builder mode switch.
 * Keeps Manual remote-order workflow distinct from Walk-in sale workflow.
 * @param {"manual"|"walk-in"} activeMode
 * @param {{ location?: "page"|"topbar", showLabel?: boolean }} [opts]
 */
export function orderBuilderModeSwitch(activeMode, opts = {}) {
  const isWalkIn = activeMode === "walk-in";
  const isTopbar = opts.location === "topbar";
  const showLabel = opts.showLabel ?? !isTopbar;
  const manualClass = isWalkIn ? "" : " is-active";
  const walkInClass = isWalkIn ? " is-active" : "";
  const manualCurrent = isWalkIn ? "" : ` aria-current="page"`;
  const walkInCurrent = isWalkIn ? ` aria-current="page"` : "";
  const modeClass = isTopbar ? " sg-order-mode--topbar" : "";
  const labelHtml = showLabel ? `<span class="sg-order-mode__label">Order type</span>` : "";
  return `<div class="sg-order-mode${modeClass}" aria-label="Order type">
    ${labelHtml}
    <div class="sg-order-mode__group" role="tablist" aria-label="Order type">
      <a class="sg-order-mode__option${manualClass}" href="/admin-v2/manual-order"${manualCurrent}>Remote order</a>
      <a class="sg-order-mode__option${walkInClass}" href="/admin-v2/walk-in-order"${walkInCurrent}>Walk-in sale</a>
    </div>
  </div>`;
}

/* --------------------------------------------------------------- shell */

/**
 * Full dashboard shell. Returns the sidebar + main column skeleton with an
 * empty `#sg-page` node the page controller fills in.
 * @param {{ active: string, email?: string, meta?: string, topbarLeftHtml?: string }} opts
 */
export function shell(opts) {
  return `<a class="sg-skip-link" href="#sg-page">Skip to main content</a>
  <div class="sg-overlay" id="sg-overlay"></div>
  <div class="sg-shell">
    ${sidebar(opts.active, opts.email)}
    <div class="sg-main">
      ${topbar({ meta: opts.meta, leftHtml: opts.topbarLeftHtml })}
      <main class="sg-content" id="sg-page" tabindex="-1"></main>
    </div>
  </div>
  <div class="sg-toast-region" id="sg-toast-region" role="status" aria-live="polite" aria-atomic="true"></div>`;
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
 * @param {{ label: string, value: string, sub?: string, iconName?: string, danger?: boolean }} opts
 */
export function miniCard(opts) {
  const valueClass = opts.danger ? " sg-minicard__value--danger" : "";
  return `<article class="sg-card sg-minicard">
    <div class="sg-minicard__icon">${icon(opts.iconName || "dollar-sign", 16)}</div>
    <div>
      <p class="sg-minicard__label">${escapeHtml(opts.label)}</p>
      <p class="sg-minicard__value${valueClass}">${escapeHtml(opts.value)}</p>
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
 * @param {{ title?: string, titleHtml?: string, subtitle?: string, actionHtml?: string, bodyHtml: string, className?: string }} opts
 */
export function card(opts) {
  const header =
    opts.title || opts.titleHtml || opts.actionHtml
      ? `<div class="sg-card__header">
          <div>
            ${opts.titleHtml ? `<h2 class="sg-card__title">${opts.titleHtml}</h2>` : opts.title ? `<h2 class="sg-card__title">${escapeHtml(opts.title)}</h2>` : ""}
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

export function customSelect(selectSpec) {
  const options = Array.isArray(selectSpec?.options) ? selectSpec.options : [];
  const fallback = options[0] || { value: "", label: "Select" };
  const selected = options.find((option) => option.value === selectSpec.selected) || fallback;
  const listId = `${selectSpec.id}-listbox`;
  const wrapperClass = selectSpec.className ? ` ${escapeHtml(selectSpec.className)}` : "";
  const triggerClass = selectSpec.triggerClass ? ` ${escapeHtml(selectSpec.triggerClass)}` : "";
  const ariaLabel = escapeHtml(selectSpec.ariaLabel || "Filter");
  const optionButtons = options
    .map((option) => {
      const isSelected = option.value === selected.value;
      return `<button type="button" class="sg-selectbox__option${isSelected ? " is-selected" : ""}" role="option" data-value="${escapeHtml(
        option.value,
      )}" aria-selected="${isSelected ? "true" : "false"}">${escapeHtml(option.label)}</button>`;
    })
    .join("");

  return `<div class="sg-selectbox${wrapperClass}" data-selectbox>
    <input type="hidden" id="${escapeHtml(selectSpec.id)}" value="${escapeHtml(selected.value)}">
    <button
      type="button"
      class="sg-selectbox__trigger${triggerClass}"
      aria-label="${ariaLabel}"
      aria-haspopup="listbox"
      aria-expanded="false"
      aria-controls="${escapeHtml(listId)}"
    >
      <span class="sg-selectbox__label">${escapeHtml(selected.label)}</span>
      ${icon("chevron-down", 16, "sg-selectbox__caret")}
    </button>
    <div class="sg-selectbox__menu" id="${escapeHtml(listId)}" role="listbox" hidden>
      ${optionButtons}
    </div>
  </div>`;
}

/**
 * @param {{ id: string, options: {value:string,label:string}[], selected?: string }} selectSpec
 * @param {string} [extraHtml] additional controls appended to the toolbar
 */
export function filterToolbar(selectSpec, extraHtml = "") {
  return `<div class="sg-toolbar">
    ${customSelect(selectSpec)}
    ${extraHtml}
  </div>`;
}

/* ------------------------------------------------------- custom selectboxes */

let _selectboxDocWired = false;

function selectboxEls(box) {
  return {
    input: box.querySelector("input[type='hidden']"),
    trigger: box.querySelector(".sg-selectbox__trigger"),
    label: box.querySelector(".sg-selectbox__label"),
    menu: box.querySelector(".sg-selectbox__menu"),
    options: [...box.querySelectorAll(".sg-selectbox__option")],
  };
}

function closeSelectbox(box, { restoreFocus = false } = {}) {
  const { trigger, menu } = selectboxEls(box);
  if (!trigger || !menu) return;
  box.classList.remove("is-open");
  trigger.setAttribute("aria-expanded", "false");
  menu.hidden = true;
  if (restoreFocus && typeof trigger.focus === "function") {
    trigger.focus();
  }
}

function closeAllSelectboxes(exceptBox = null) {
  document.querySelectorAll("[data-selectbox].is-open").forEach((box) => {
    if (box !== exceptBox) closeSelectbox(box);
  });
}

function focusSelectboxOption(box, index) {
  const { options } = selectboxEls(box);
  if (!options.length) return;
  const safeIndex = Math.max(0, Math.min(index, options.length - 1));
  const option = options[safeIndex];
  if (option && typeof option.focus === "function") {
    option.focus();
  }
}

function openSelectbox(box) {
  const { trigger, menu, options } = selectboxEls(box);
  if (!trigger || !menu) return;
  closeAllSelectboxes(box);
  box.classList.add("is-open");
  trigger.setAttribute("aria-expanded", "true");
  menu.hidden = false;
  const selectedIndex = options.findIndex((option) => option.classList.contains("is-selected"));
  focusSelectboxOption(box, selectedIndex >= 0 ? selectedIndex : 0);
}

function setSelectboxValue(box, value, { dispatch = true } = {}) {
  const { input, label, options } = selectboxEls(box);
  if (!input || !label || !options.length) return;
  const option = options.find((item) => item.dataset.value === value) || options[0];
  const nextValue = option?.dataset?.value || "";
  const previous = input.value;
  input.value = nextValue;
  label.textContent = option?.textContent?.trim() || "";
  options.forEach((item) => {
    const isSelected = item === option;
    item.classList.toggle("is-selected", isSelected);
    item.setAttribute("aria-selected", isSelected ? "true" : "false");
  });
  if (dispatch && previous !== nextValue) {
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }
}

export function setCustomSelectboxValue(target, value, opts = {}) {
  const input =
    typeof target === "string"
      ? document.getElementById(target)
      : target instanceof HTMLElement
        ? target
        : null;
  if (!input) return;
  const box = input.closest?.("[data-selectbox]");
  if (!box) {
    input.value = value;
    if (opts.dispatch) {
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }
    return;
  }
  setSelectboxValue(box, value, opts);
}

export function initCustomSelectboxes(root = document) {
  root.querySelectorAll("[data-selectbox]").forEach((box) => {
    if (box.dataset.selectboxBound === "1") return;
    box.dataset.selectboxBound = "1";

    const { trigger, options } = selectboxEls(box);
    if (!trigger) return;

    trigger.addEventListener("click", () => {
      if (box.classList.contains("is-open")) {
        closeSelectbox(box);
      } else {
        openSelectbox(box);
      }
    });

    trigger.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openSelectbox(box);
      }
    });

    box.addEventListener("click", (event) => {
      const option = event.target.closest(".sg-selectbox__option");
      if (!option) return;
      setSelectboxValue(box, option.dataset.value || "");
      closeSelectbox(box, { restoreFocus: true });
    });

    options.forEach((option, index) => {
      option.addEventListener("keydown", (event) => {
        if (event.key === "ArrowDown") {
          event.preventDefault();
          focusSelectboxOption(box, index + 1);
          return;
        }
        if (event.key === "ArrowUp") {
          event.preventDefault();
          focusSelectboxOption(box, index - 1);
          return;
        }
        if (event.key === "Home") {
          event.preventDefault();
          focusSelectboxOption(box, 0);
          return;
        }
        if (event.key === "End") {
          event.preventDefault();
          focusSelectboxOption(box, options.length - 1);
          return;
        }
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          setSelectboxValue(box, option.dataset.value || "");
          closeSelectbox(box, { restoreFocus: true });
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          closeSelectbox(box, { restoreFocus: true });
        }
      });
    });
  });

  if (_selectboxDocWired) return;
  _selectboxDocWired = true;

  document.addEventListener("click", (event) => {
    document.querySelectorAll("[data-selectbox].is-open").forEach((box) => {
      if (!box.contains(event.target)) {
        closeSelectbox(box);
      }
    });
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    document.querySelectorAll("[data-selectbox].is-open").forEach((box) => {
      closeSelectbox(box, { restoreFocus: true });
    });
  });
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

/** Document Escape handler for mobile sidebar — wired once across remounts. */
let _shellDocEscapeWired = false;
/** @type {null | ((opts?: { restoreFocus?: boolean }) => void)} */
let _shellCloseSidebar = null;

/**
 * Wires the mobile sidebar toggle + overlay after mounting the shell.
 * Document-level Escape is attached once; remounts rebind element handlers only.
 */
export function initShellInteractions() {
  const sidebarEl = document.getElementById("sg-sidebar");
  const overlay = document.getElementById("sg-overlay");
  const menuBtn = document.getElementById("sg-menu-btn");
  if (!sidebarEl || !overlay || !menuBtn) return;

  const setExpanded = (open) => {
    menuBtn.setAttribute("aria-expanded", open ? "true" : "false");
  };

  const open = () => {
    sidebarEl.classList.add("is-open");
    overlay.classList.add("is-open");
    setExpanded(true);
  };

  const close = (opts = {}) => {
    const wasOpen = sidebarEl.classList.contains("is-open");
    sidebarEl.classList.remove("is-open");
    overlay.classList.remove("is-open");
    setExpanded(false);
    if (wasOpen && opts.restoreFocus && typeof menuBtn.focus === "function") {
      try {
        menuBtn.focus();
      } catch {
        /* menu button may not be focusable */
      }
    }
  };

  _shellCloseSidebar = close;
  setExpanded(false);

  if (menuBtn.getAttribute("data-shell-bound") === "1") {
    return;
  }
  menuBtn.setAttribute("data-shell-bound", "1");

  menuBtn.addEventListener("click", () => {
    if (sidebarEl.classList.contains("is-open")) {
      close({ restoreFocus: true });
      return;
    }
    open();
  });
  overlay.addEventListener("click", () => close());
  sidebarEl.addEventListener("click", (e) => {
    const navTarget = e.target.closest("a[href], button");
    if (!navTarget) return;
    if (typeof window !== "undefined" && window.innerWidth > 768) return;
    close();
  });

  if (!_shellDocEscapeWired) {
    _shellDocEscapeWired = true;
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      const sidebar = document.getElementById("sg-sidebar");
      if (!sidebar || !sidebar.classList.contains("is-open")) return;
      if (typeof _shellCloseSidebar === "function") {
        _shellCloseSidebar({ restoreFocus: true });
      }
    });
  }
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
 *
 * Closed state uses hidden + aria-hidden + inert so the dialog leaves the
 * accessibility/focus tree. Open moves focus to Close; close restores the
 * opener when it is still connected. Tab is trapped while open.
 *
 * Pages may register setDrawerCloseGuard(() => boolean) to block close during
 * irreversible in-flight operations (return false to prevent close).
 */
let _drawerEls = null;
let _drawerOpener = null;
/** @type {null | (() => boolean)} Return false to block close. */
let _drawerCloseGuard = null;
let _drawerDocKeyWired = false;
const DRAWER_TITLE_ID = "sg-drawer-title";

/**
 * Optional close guard for irreversible in-flight operations.
 * @param {null | (() => boolean)} fn Return false to prevent close; null clears.
 */
export function setDrawerCloseGuard(fn) {
  _drawerCloseGuard = typeof fn === "function" ? fn : null;
}

function setDrawerClosed(aside, overlay) {
  aside.hidden = true;
  aside.setAttribute("aria-hidden", "true");
  aside.inert = true;
  overlay.hidden = true;
  overlay.setAttribute("aria-hidden", "true");
}

function setDrawerOpen(aside, overlay) {
  aside.hidden = false;
  aside.removeAttribute("aria-hidden");
  aside.inert = false;
  overlay.hidden = false;
  overlay.removeAttribute("aria-hidden");
}

function restoreDrawerOpener(opener) {
  if (!opener || typeof opener.focus !== "function") return;
  if (opener.isConnected === false) return;
  if (opener.disabled) return;
  try {
    opener.focus();
  } catch {
    /* opener may not be focusable anymore */
  }
}

/**
 * True when `element` or any ancestor up through `drawerRoot` is hidden from
 * AT/interaction. Stops at `drawerRoot`. Uses DOM flags always; uses
 * getComputedStyle only when `window.getComputedStyle` is available (browsers).
 * @param {Element|null|undefined} element
 * @param {Element} drawerRoot
 */
function isHiddenWithinDrawer(element, drawerRoot) {
  if (!element || !drawerRoot) return true;

  const cssHidden = (node) => {
    try {
      const win = typeof window !== "undefined" ? window : undefined;
      if (!win || typeof win.getComputedStyle !== "function") return false;
      const style = win.getComputedStyle(node);
      if (!style) return false;
      const display = String(style.display || "");
      const visibility = String(style.visibility || "");
      if (display === "none") return true;
      if (visibility === "hidden" || visibility === "collapse") return true;
    } catch {
      /* Node harness / restricted environments — ignore */
    }
    return false;
  };

  let node = element;
  while (node) {
    if (node.hidden === true) return true;
    if (typeof node.hasAttribute === "function" && node.hasAttribute("hidden")) return true;
    if (typeof node.getAttribute === "function" && node.getAttribute("aria-hidden") === "true") {
      return true;
    }
    if (node.inert === true) return true;
    if (typeof node.hasAttribute === "function" && node.hasAttribute("inert")) return true;
    if (cssHidden(node)) return true;
    if (node === drawerRoot) break;
    node = node.parentElement || node.parentNode;
  }
  return false;
}

function drawerFocusableElements(root) {
  if (!root || typeof root.querySelectorAll !== "function") return [];
  const nodes = root.querySelectorAll(
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  );
  const list = Array.from(nodes || []);
  return list.filter((el) => {
    if (!el || el.disabled) return false;
    if (isHiddenWithinDrawer(el, root)) return false;
    return true;
  });
}

function onDrawerDocumentKeydown(e) {
  if (!_drawerEls) return;
  const { aside } = _drawerEls;
  if (!aside.classList.contains("is-open")) return;

  if (e.key === "Escape") {
    closeDrawer();
    return;
  }

  if (e.key !== "Tab") return;

  const focusables = drawerFocusableElements(aside);
  if (focusables.length === 0) {
    e.preventDefault();
    if (typeof aside.focus === "function") aside.focus();
    return;
  }
  if (focusables.length === 1) {
    e.preventDefault();
    focusables[0].focus();
    return;
  }

  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  const active = typeof document !== "undefined" ? document.activeElement : null;
  if (e.shiftKey) {
    if (active === first || !aside.contains?.(active)) {
      e.preventDefault();
      last.focus();
    }
  } else if (active === last || !aside.contains?.(active)) {
    e.preventDefault();
    first.focus();
  }
}

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
  aside.setAttribute("tabindex", "-1");
  setDrawerClosed(aside, overlay);

  document.body.appendChild(overlay);
  document.body.appendChild(aside);

  overlay.addEventListener("click", closeDrawer);

  if (!_drawerDocKeyWired) {
    _drawerDocKeyWired = true;
    document.addEventListener("keydown", onDrawerDocumentKeydown);
  }

  _drawerEls = { overlay, aside };
  return _drawerEls;
}

/**
 * @param {{ title?: string, bodyHtml?: string }} opts
 */
export function openDrawer(opts = {}) {
  const { overlay, aside } = ensureDrawer();
  const wasOpen = aside.classList.contains("is-open");
  if (!wasOpen) {
    _drawerOpener = typeof document !== "undefined" ? document.activeElement : null;
  }
  const titleText = opts.title || "Details";
  aside.removeAttribute("aria-label");
  aside.setAttribute("aria-labelledby", DRAWER_TITLE_ID);
  aside.innerHTML = `<div class="sg-drawer__header">
      <h2 class="sg-card__title" id="${DRAWER_TITLE_ID}">${escapeHtml(titleText)}</h2>
      <button type="button" class="sg-btn sg-btn--icon sg-btn--ghost" id="sg-drawer-close" aria-label="Close">${icon(
        "x",
        16,
      )}</button>
    </div>
    <div class="sg-drawer__body">${opts.bodyHtml || ""}</div>`;
  const closeBtn = aside.querySelector("#sg-drawer-close");
  if (closeBtn) closeBtn.addEventListener("click", closeDrawer);
  setDrawerOpen(aside, overlay);
  overlay.classList.add("is-open");
  aside.classList.add("is-open");
  if (closeBtn && typeof closeBtn.focus === "function") closeBtn.focus();
}

export function closeDrawer(opts = {}) {
  if (!opts.force && _drawerCloseGuard && _drawerCloseGuard() === false) return;
  if (!_drawerEls) return;
  const { overlay, aside } = _drawerEls;
  const wasOpen = aside.classList.contains("is-open");
  overlay.classList.remove("is-open");
  aside.classList.remove("is-open");
  setDrawerClosed(aside, overlay);
  if (!wasOpen) return;
  const opener = _drawerOpener;
  _drawerOpener = null;
  restoreDrawerOpener(opener);
}
