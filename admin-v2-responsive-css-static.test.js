import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function read(rel) {
  return readFileSync(path.join(__dirname, rel), "utf8");
}

test("admin-v2.css includes skip-link, focus-visible, reduced-motion, touch targets", () => {
  const css = read("public/css/v2/admin-v2.css");
  assert.match(css, /\.sg-skip-link/);
  assert.match(css, /\.sg-btn:focus-visible/);
  assert.match(css, /\.sg-nav__link:focus-visible/);
  assert.match(css, /\.sg-menu-btn:focus-visible/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
  assert.match(css, /\.sg-btn--icon-sm\s*\{[^}]*min-width:\s*44px/s);
  assert.match(css, /\.mo-qty__btn\s*\{[^}]*min-width:\s*44px/s);
  assert.match(css, /\.sg-table-wrap\s*\{[^}]*overflow-x:\s*auto/s);
  // Orphan Walk-in CSS intentionally retained this PR.
  assert.match(css, /\.wi-/);
  assert.match(css, /\.sg-cell-product\s*\{[^}]*min-width:\s*120px/s);
});

test("Summary page overrides keep requested radii and remove box shadows", () => {
  const css = read("public/css/v2/admin-v2.css");
  const summaryHtml = read("public/admin-v2/summary.html");

  assert.match(summaryHtml, /class="sg-body sg-body--summary"/);
  assert.match(css, /\.sg-page-header\s*\{[^}]*align-items:\s*flex-end/s);
  assert.match(css, /\.sg-body--summary \.sg-nav__link,[^}]*border-radius:\s*5px/s);
  assert.match(css, /\.sg-select\s*\{[\s\S]*appearance:\s*none[\s\S]*background-position:\s*right 8px center[\s\S]*border-radius:\s*10px/s);
  assert.match(css, /\.sg-selectbox__trigger\s*\{[^}]*border-radius:\s*10px[^}]*padding:\s*8px 32px 8px 12px/s);
  assert.match(css, /\.sg-body--summary \.sg-selectbox__trigger\s*\{[^}]*border-radius:\s*50px/s);
  assert.match(css, /\.sg-selectbox__caret\s*\{[^}]*right:\s*8px/s);
  assert.match(css, /\.sg-selectbox__menu\s*\{[^}]*border-radius:\s*10px/s);
  assert.match(css, /\.sg-body--summary \.sg-input\s*\{[^}]*border-radius:\s*5px/s);
  assert.match(css, /\.sg-body--summary \.sg-select\s*\{[^}]*border-radius:\s*10px/s);
  assert.match(css, /\.sg-body--summary \.sg-card\s*\{[^}]*border-radius:\s*10px/s);
  assert.match(css, /\.sg-body--summary \.sg-kpi__icon\s*\{[^}]*border-radius:\s*999px/s);
  assert.match(css, /\.sg-chart__tooltip\s*\{[^}]*border-radius:\s*7px/s);
  assert.match(css, /\.sg-zone-state__rank\s*\{[^}]*width:\s*30px[^}]*height:\s*30px/s);
  assert.match(css, /\.sg-nexus-preview\s*\{[^}]*grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(180px,\s*1fr\)\)/s);
  assert.match(css, /\.sg-sales-overview-card \.sg-card__header\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+minmax\(0,\s*320px\)/s);
  assert.match(css, /\.sg-product-performance-card \.sg-card__header\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+minmax\(0,\s*168px\)/s);
  assert.match(css, /@media \(max-width:\s*1360px\)\s*\{[\s\S]*?\.sg-sales-overview-card \.sg-card__header\s*\{[^}]*grid-template-columns:\s*1fr/s);
  assert.match(css, /@media \(max-width:\s*1360px\)\s*\{[\s\S]*?\.sg-sales-overview-card \.sg-toolbar\s*\{[^}]*justify-content:\s*flex-start/s);
  assert.match(css, /\.sg-sales-overview-card \.sg-selectbox,[^}]*flex:\s*1 1 0[^}]*min-width:\s*0/s);
  assert.match(css, /\.sg-nexus-preview__state\s*\{[^}]*gap:\s*10px/s);
  assert.match(css, /\.sg-sidebar__footer-actions\s*\{[^}]*flex-direction:\s*column/s);
  assert.match(css, /\.sg-sidebar__legacy\s*\{[^}]*width:\s*100%/s);
  assert.match(css, /\.sg-sales-overview__stats\s*\{[^}]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/s);
  assert.match(css, /\.sg-sales-overview__stat-label\s*\{[^}]*letter-spacing:\s*0/s);
  assert.doesNotMatch(css, /\.sg-sales-overview__stat-label\s*\{[^}]*text-transform:\s*uppercase/s);
  assert.match(css, /\.sg-summary-orders-card \.sg-table-wrap\s*\{[^}]*overflow-x:\s*auto/s);
  assert.match(css, /\.sg-summary-orders-card \.sg-table\s*\{[^}]*min-width:\s*760px/s);
  assert.match(
    css,
    /\.sg-body--summary \.sg-brand__mark,[\s\S]*?\.sg-body--summary \.sg-toast\s*\{[^}]*box-shadow:\s*none/s,
  );
});

test("Manual order bundle and size workflow stays compact and guided", () => {
  const css = read("public/css/v2/admin-v2.css");
  const manualJs = read("public/js/v2/admin-manual-order.js");
  const walkInJs = read("public/js/v2/admin-walk-in-order.js");
  const ordersJs = read("public/js/v2/admin-orders.js");
  const summaryJs = read("public/js/v2/admin-summary.js");
  const inventoryJs = read("public/js/v2/admin-inventory.js");
  const uiJs = read("public/js/v2/ui.js");

  assert.match(css, /\.mo-bundle-list\s*\{[^}]*display:\s*grid[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/s);
  assert.match(css, /\.mo-bundle-row__name\s*\{[^}]*font-size:\s*17px[^}]*font-weight:\s*700/s);
  assert.match(css, /\.mo-bundle-row__price\s*\{[^}]*font-size:\s*13px[^}]*color:\s*var\(--sg-text-muted\)/s);
  assert.match(css, /\.mo-size-rows\s*\{[^}]*display:\s*grid[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/s);
  assert.match(css, /\.mo-size-grid:not\(\.mo-size-grid--single\)\s+\.mo-size-rows\s*\{[^}]*grid-template-columns:\s*1fr/s);
  assert.match(css, /#sg-overlay\s*\{[^}]*z-index:\s*39/s);
  assert.match(css, /\.mo-step__toggle\s*\{[^}]*display:\s*flex/s);
  assert.match(css, /\.mo-quote-items\s*\{[^}]*border-top:\s*1px solid var\(--sg-border\)/s);
  assert.match(css, /\.sg-card__title\s*\{[^}]*display:\s*inline-flex/s);
  assert.match(css, /\.mo-radio__label\s*\{[^}]*display:\s*inline-flex/s);
  assert.doesNotMatch(css, /\.mo-bundle-row__adds\b/);
  assert.match(uiJs, /user:/);
  assert.match(uiJs, /titleHtml\?: string/);

  for (const script of [manualJs, walkInJs]) {
    assert.match(script, /Select the bundle first, then select size in Step 2\./);
    assert.doesNotMatch(script, /Select the package mix first\./);
    assert.doesNotMatch(script, /For each product: choose a package quantity, then assign sizes until the totals match\./);
    assert.doesNotMatch(script, /Select at least one package in Step 1 to unlock the size assignment\./);
    assert.doesNotMatch(script, /Selected: .*Assigned: .*Remaining:/);
    assert.doesNotMatch(script, /Adds \$\{units\}/);
    assert.doesNotMatch(script, /Step 3/);
  }

  assert.match(manualJs, /titleHtml: sectionTitleHtml\("user", "Customer"\)/);
  assert.match(manualJs, /<div class="mo-grid mo-grid--compact-y">/);
  assert.match(manualJs, /Current selection/);
  assert.match(manualJs, /Items in this order/);
  assert.match(manualJs, /data-mo-step-toggle/);
  assert.match(manualJs, /titleHtml: sectionTitleHtml\("tag", "Discount"\)/);
  assert.doesNotMatch(manualJs, /Payment link workflow/);
  assert.doesNotMatch(manualJs, /mo-fulfillment-helper/);
  assert.match(manualJs, /titleHtml: sectionTitleHtml\("receipt", "Estimate \/ quote preview"\)/);
  assert.match(manualJs, /mo-radio__label/);
  assert.match(walkInJs, /titleHtml: sectionTitleHtml\("user", "Customer"\)/);
  assert.match(walkInJs, /Items in this order/);
  assert.match(walkInJs, /data-wi-step-toggle/);
  assert.match(walkInJs, /titleHtml: sectionTitleHtml\("tag", "Discount"\)/);
  assert.match(walkInJs, /titleHtml: sectionTitleHtml\("receipt", "Estimate \/ quote preview"\)/);
  assert.match(walkInJs, /titleHtml: sectionTitleHtml\("dollar-sign", "Collect payment"\)/);
  assert.match(ordersJs, /titleHtml: sectionTitleHtml\("shopping-cart", "Orders"\)/);
  assert.match(summaryJs, /titleHtml: sectionTitleHtml\("shopping-cart", "Recent Orders"\)/);
  assert.match(summaryJs, /titleHtml: sectionTitleHtml\("package", "Inventory Health"\)/);
  assert.match(inventoryJs, /titleHtml: sectionTitleHtml\("package", "Inventory Health"\)/);
  assert.match(inventoryJs, /titleHtml: sectionTitleHtml\("inbox", "Incoming Inventory"\)/);
});
